//! The client's event socket, as league-connect's `LeagueWebSocket` opens it:
//! `wss://127.0.0.1:<port>` with the same Basic auth and pinned root, then
//! `[5,"OnJsonApiEvent"]` to subscribe to every event.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

use super::LcuError;
use super::http::Session;

pub const SUBSCRIBE: &str = r#"[5,"OnJsonApiEvent"]"#;

pub struct EventSocket {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

/// One attempt, with no retry of its own. A handshake that never finishes is
/// given up at `timeout`, so the attach guard can't stay set for the session.
pub async fn connect(session: &Session, timeout: Duration) -> Result<EventSocket, LcuError> {
    let other = |err: &dyn std::fmt::Display| LcuError::Other(err.to_string());
    let mut request = format!("wss://127.0.0.1:{}", session.credentials.port)
        .into_client_request()
        .map_err(|err| other(&err))?;
    request
        .headers_mut()
        .insert("Authorization", session.authorization.clone());
    let connector = Connector::Rustls(session.socket_tls.clone());
    let handshake =
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector));
    let (mut ws, _) = tokio::time::timeout(timeout, handshake)
        .await
        .map_err(|_| {
            LcuError::Other("Timed out connecting to the League client event socket".into())
        })?
        .map_err(|err| other(&err))?;
    ws.send(Message::text(SUBSCRIBE))
        .await
        .map_err(|err| other(&err))?;
    Ok(EventSocket { ws })
}

/// The event out of a `[8,"OnJsonApiEvent",{uri,eventType,data}]` frame. The
/// opcode goes unchecked, as in `lcu.ts`, and anything that is not a JSON array
/// is skipped, the empty frame that acknowledges the subscribe included.
fn payload(text: &str) -> Option<Value> {
    match serde_json::from_str(text) {
        Ok(Value::Array(frame)) => frame.into_iter().nth(2),
        _ => None,
    }
}

impl EventSocket {
    /// The next event, or `None` once the socket has closed or failed. Reading
    /// is also what answers the client's pings.
    pub async fn next(&mut self) -> Option<Value> {
        loop {
            let event = match self.ws.next().await? {
                Ok(Message::Text(text)) => payload(&text),
                Ok(Message::Binary(bytes)) => payload(&String::from_utf8_lossy(&bytes)),
                Ok(_) => continue,
                Err(_) => return None,
            };
            if let Some(event) = event {
                return Some(event);
            }
        }
    }

    pub async fn close(mut self) {
        // Closing a socket the client already dropped has nothing to report
        let _ = self.ws.close(None).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lcu::lockfile::Credentials;
    use crate::lcu::test_support::{FakeClient, TestCa, eventually, self_signed};
    use rustls::pki_types::CertificateDer;

    fn session(client: &FakeClient, anchors: &[CertificateDer<'static>]) -> Session {
        Session::new(
            Credentials {
                pid: 1,
                port: client.port(),
                password: "pw".into(),
            },
            anchors,
        )
        .expect("session")
    }

    const WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn frames_carry_their_third_element() {
        assert_eq!(
            payload(r#"[8,"OnJsonApiEvent",{"uri":"/a","data":1}]"#),
            Some(serde_json::json!({"uri": "/a", "data": 1}))
        );
        assert_eq!(payload(""), None);
        assert_eq!(payload(r#"{"uri":"/a"}"#), None);
        assert_eq!(payload("[8]"), None);
    }

    #[tokio::test]
    async fn subscribes_first_and_reads_events() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        let mut socket = connect(&session(&client, &[ca.cert()]), WAIT)
            .await
            .expect("socket");
        eventually("the subscribe", WAIT, || !client.first_frames().is_empty()).await;
        assert_eq!(client.first_frames(), [SUBSCRIBE]);
        let upgrade = client.upgrades().pop().expect("an upgrade");
        assert!(upgrade.headers["authorization"].starts_with("Basic "));

        client.publish_raw("not json");
        client.publish(serde_json::json!({"uri": "/one", "eventType": "Update", "data": 1}));
        client.publish(serde_json::json!({"uri": "/two", "eventType": "Update", "data": 2}));
        let first = socket.next().await.expect("first event");
        let second = socket.next().await.expect("second event");
        assert_eq!(
            (first["uri"].clone(), second["uri"].clone()),
            ("/one".into(), "/two".into())
        );

        client.stop();
        assert_eq!(
            socket.next().await,
            None,
            "a dropped client ends the stream"
        );
    }

    #[tokio::test]
    async fn the_pinned_root_refuses_an_impostor_socket() {
        let ca = TestCa::named("test root");
        for chain in [
            self_signed(&["127.0.0.1"], true),
            TestCa::named("impostor").leaf(&["127.0.0.1"]),
            ca.leaf(&["127.0.0.2"]),
        ] {
            let client = FakeClient::start(&chain).await;
            let refused = connect(&session(&client, &[ca.cert()]), WAIT).await;
            assert!(matches!(refused, Err(LcuError::Other(_))));
            assert!(client.upgrades().is_empty(), "no upgrade got through");
        }
    }

    #[tokio::test]
    async fn a_handshake_that_hangs_times_out() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let held = tokio::spawn(async move {
            let _open = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let session = Session::new(
            Credentials {
                pid: 1,
                port,
                password: "pw".into(),
            },
            &[TestCa::named("test root").cert()],
        )
        .expect("session");
        let err = connect(&session, Duration::from_millis(200))
            .await
            .err()
            .expect("timed out");
        assert_eq!(
            err.to_string(),
            "Timed out connecting to the League client event socket"
        );
        held.abort();
    }
}
