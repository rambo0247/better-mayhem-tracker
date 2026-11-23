//! HTTPS to the client, the way league-connect's `createHttp1Request` makes it:
//! `https://127.0.0.1:<port>/<path>` with Basic auth, HTTP/1.1, no redirects
//! followed, no proxy, and no timeout of its own.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use rustls::ClientConfig;
use rustls::pki_types::CertificateDer;
use serde_json::Value;

use super::LcuError;
use super::lockfile::Credentials;
use super::tls::{self, Alpn};

/// One set of credentials and the clients that talk to it. Built again whenever
/// the credentials change, which is also when the parity CA is read again.
pub struct Session {
    pub credentials: Credentials,
    pub(super) authorization: HeaderValue,
    pub(super) socket_tls: Arc<ClientConfig>,
    http: reqwest::Client,
}

impl Session {
    pub fn new(
        credentials: Credentials,
        anchors: &[CertificateDer<'static>],
    ) -> Result<Self, LcuError> {
        let tls_error = |err: rustls::Error| LcuError::Other(err.to_string());
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(
                tls::config_with_anchors(anchors, Alpn::Http1).map_err(tls_error)?,
            )
            .http1_only()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|err| LcuError::Other(err.to_string()))?;
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("riot:{}", credentials.password));
        let mut authorization = HeaderValue::from_str(&format!("Basic {token}"))
            .map_err(|err| LcuError::Other(err.to_string()))?;
        authorization.set_sensitive(true);
        Ok(Self {
            socket_tls: Arc::new(tls::config_with_anchors(anchors, Alpn::None).map_err(tls_error)?),
            credentials,
            authorization,
            http,
        })
    }

    fn url(&self, path: &str) -> String {
        format!(
            "https://127.0.0.1:{}/{}",
            self.credentials.port,
            path.trim_start_matches('/')
        )
    }

    async fn get(&self, path: &str) -> Result<(u16, Vec<u8>), reqwest::Error> {
        let response = self
            .http
            .get(self.url(path))
            .header(ACCEPT, "*/*")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, self.authorization.clone())
            .send()
            .await?;
        let status = response.status().as_u16();
        Ok((status, response.bytes().await?.to_vec()))
    }

    /// `lcuRequest`: a non-2xx answer is an error, and so is a body that is not
    /// JSON, an empty one included.
    pub async fn json(&self, path: &str) -> Result<Value, LcuError> {
        let (status, body) = self.get(path).await.map_err(LcuError::transport)?;
        if !(200..300).contains(&status) {
            return Err(LcuError::Status {
                status,
                url: path.to_string(),
            });
        }
        serde_json::from_slice(&body).map_err(|err| LcuError::Other(err.to_string()))
    }

    /// `lcuBytes`' request: the raw body of a 2xx answer within `timeout`.
    pub async fn bytes(&self, path: &str, timeout: Duration) -> Option<Vec<u8>> {
        match tokio::time::timeout(timeout, self.get(path)).await {
            Ok(Ok((status, body))) if (200..300).contains(&status) => Some(body),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lcu::test_support::{FakeClient, Reply, TestCa, self_signed};

    fn session(client: &FakeClient, anchors: &[CertificateDer<'static>]) -> Session {
        Session::new(
            Credentials {
                pid: 1,
                port: client.port(),
                password: "pa:ss".into(),
            },
            anchors,
        )
        .expect("session")
    }

    #[tokio::test]
    async fn sends_league_connects_request() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1", "localhost"])).await;
        client.route("/x/y", Reply::Json(200, serde_json::json!({"ok": true})));
        let answer = session(&client, &[ca.cert()]).json("//x/y?a=1").await;
        assert_eq!(answer.expect("answer"), serde_json::json!({"ok": true}));

        let seen = client.requests().pop().expect("a request");
        assert_eq!(
            (seen.method.as_str(), seen.path.as_str()),
            ("GET", "/x/y?a=1")
        );
        assert_eq!(seen.headers["accept"], "*/*");
        assert_eq!(seen.headers["content-type"], "application/json");
        assert_eq!(
            seen.headers["authorization"],
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode("riot:pa:ss")
            )
        );
    }

    #[tokio::test]
    async fn a_non_2xx_answer_names_status_and_url() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        client.route("/moved", Reply::Raw(302, vec![]));
        let session = session(&client, &[ca.cert()]);
        let missing = session.json("/missing").await.expect_err("404");
        assert_eq!(missing.to_string(), "LCU request failed: 404 /missing");
        let moved = session.json("/moved").await.expect_err("not followed");
        assert_eq!(moved.to_string(), "LCU request failed: 302 /moved");
    }

    #[tokio::test]
    async fn an_empty_body_is_an_error() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        client.route("/empty", Reply::Raw(200, vec![]));
        assert!(matches!(
            session(&client, &[ca.cert()]).json("/empty").await,
            Err(LcuError::Other(_))
        ));
    }

    #[tokio::test]
    async fn bytes_returns_the_body_or_none() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        client.route("/art.png", Reply::Raw(200, vec![1, 2, 3]));
        let session = session(&client, &[ca.cert()]);
        let wait = Duration::from_secs(5);
        assert_eq!(session.bytes("/art.png", wait).await, Some(vec![1, 2, 3]));
        assert_eq!(session.bytes("/none.png", wait).await, None);
    }

    #[tokio::test]
    async fn bytes_gives_up_at_its_timeout() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        client.route(
            "/slow",
            Reply::Hold(Arc::new(tokio::sync::Semaphore::new(0))),
        );
        let started = std::time::Instant::now();
        let got = session(&client, &[ca.cert()])
            .bytes("/slow", Duration::from_millis(300))
            .await;
        assert_eq!(got, None);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn the_pinned_root_refuses_an_impostor_before_any_request() {
        let ca = TestCa::named("test root");
        for chain in [
            self_signed(&["127.0.0.1", "localhost"], true),
            self_signed(&["127.0.0.1", "localhost"], false),
            TestCa::named("impostor").leaf(&["127.0.0.1"]),
            ca.leaf(&["127.0.0.2", "example.com"]),
        ] {
            let client = FakeClient::start(&chain).await;
            let err = session(&client, &[ca.cert()])
                .json("/lol-summoner/v1/current-summoner")
                .await
                .expect_err("refused");
            assert!(
                matches!(&err, LcuError::Other(text) if text.contains("certificate")),
                "{err:?}"
            );
            assert!(client.requests().is_empty(), "no request got through");
        }
    }
}
