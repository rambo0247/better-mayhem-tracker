//! Test material made at run time: temp folders, certificates from rcgen, and a
//! loopback stand-in for the League client that answers HTTPS and the event
//! socket on one port. Nothing here reads a real install or reaches a real client.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DistinguishedName, DnType, DnValue,
    ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose,
};
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "bmt-lcu-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("make temp dir");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A certificate chain a server presents, with the leaf's key.
pub struct Chain {
    pub certs: Vec<CertificateDer<'static>>,
    pub key: PrivateKeyDer<'static>,
}

impl Clone for Chain {
    fn clone(&self) -> Self {
        Self {
            certs: self.certs.clone(),
            key: self.key.clone_key(),
        }
    }
}

pub struct TestCa {
    issuer: CertifiedIssuer<'static, KeyPair>,
}

fn key_der(key: &KeyPair) -> PrivateKeyDer<'static> {
    PrivatePkcs8KeyDer::from(key.serialize_der()).into()
}

fn named(common_name: &str) -> DistinguishedName {
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, common_name);
    name
}

/// The Riot root's subject, attribute for attribute and string type for string
/// type, so an impostor's issuer name is byte-identical to Riot's.
pub fn riot_subject() -> DistinguishedName {
    let printable = |s: &str| DnValue::PrintableString(s.try_into().expect("printable"));
    let mut name = DistinguishedName::new();
    name.push(DnType::CountryName, printable("US"));
    name.push(DnType::StateOrProvinceName, printable("California"));
    name.push(DnType::LocalityName, printable("Santa Monica"));
    name.push(DnType::OrganizationName, printable("Riot Games"));
    name.push(
        DnType::OrganizationalUnitName,
        printable("LoL Game Engineering"),
    );
    name.push(
        DnType::CommonName,
        printable("LoL Game Engineering Certificate Authority"),
    );
    name.push(
        DnType::CustomDnType(vec![1, 2, 840, 113_549, 1, 9, 1]),
        DnValue::Ia5String(
            "gametechnologies@riotgames.com"
                .try_into()
                .expect("ia5"),
        ),
    );
    name
}

impl TestCa {
    pub fn new(subject: DistinguishedName) -> Self {
        let mut params = CertificateParams::default();
        params.distinguished_name = subject;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let key = KeyPair::generate().expect("ca key");
        Self {
            issuer: CertifiedIssuer::self_signed(params, key).expect("ca cert"),
        }
    }

    pub fn named(common_name: &str) -> Self {
        Self::new(named(common_name))
    }

    pub fn cert(&self) -> CertificateDer<'static> {
        self.issuer.der().clone()
    }

    pub fn pem(&self) -> String {
        self.issuer.pem()
    }

    /// A server leaf for the given names, as the client's own `rclient` leaf is.
    pub fn leaf(&self, names: &[&str]) -> Chain {
        let mut params = CertificateParams::new(
            names.iter().map(|n| n.to_string()).collect::<Vec<_>>(),
        )
        .expect("leaf params");
        params.distinguished_name = named("rclient");
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let key = KeyPair::generate().expect("leaf key");
        let cert = params.signed_by(&key, &self.issuer).expect("leaf cert");
        Chain {
            certs: vec![cert.der().clone()],
            key: key_der(&key),
        }
    }
}

/// A certificate that signs itself, as an impostor on localhost would serve.
pub fn self_signed(names: &[&str], is_ca: bool) -> Chain {
    let mut params = CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
        .expect("params");
    params.distinguished_name = named("localhost");
    if is_ca {
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    }
    let key = KeyPair::generate().expect("key");
    let cert = params.self_signed(&key).expect("cert");
    Chain {
        certs: vec![cert.der().clone()],
        key: key_der(&key),
    }
}

/// One DER element: its tag, its contents, the whole element, and what follows.
fn tlv(der: &[u8]) -> (u8, &[u8], &[u8], &[u8]) {
    let (len, header) = match der[1] {
        n if n < 0x80 => (n as usize, 2),
        n => {
            let bytes = (n & 0x7f) as usize;
            let len = der[2..2 + bytes]
                .iter()
                .fold(0usize, |acc, b| (acc << 8) | *b as usize);
            (len, 2 + bytes)
        }
    };
    let end = header + len;
    (der[0], &der[header..end], &der[..end], &der[end..])
}

/// The raw subject Name of a certificate: tbsCertificate's sixth field, or its
/// fifth when there is no explicit version, as in Riot's v1 root.
pub fn subject_der(cert: &[u8]) -> Vec<u8> {
    let (_, certificate, _, _) = tlv(cert);
    let (_, mut rest, _, _) = tlv(certificate);
    let mut fields = vec![];
    while !rest.is_empty() {
        let (tag, _, whole, next) = tlv(rest);
        fields.push((tag, whole));
        rest = next;
    }
    let skip = usize::from(fields[0].0 == 0xa0);
    fields[skip + 4].1.to_vec()
}

pub fn server_config(chain: &Chain) -> Arc<ServerConfig> {
    let mut config = ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("versions")
    .with_no_client_auth()
    .with_single_cert(chain.certs.clone(), chain.key.clone_key())
    .expect("server cert");
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

/// Replays the bytes already read from a stream before reading more of it, so
/// a request head read to route a connection can still go to tungstenite.
struct Replay<S> {
    head: Vec<u8>,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for Replay<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if !self.head.is_empty() {
            let n = self.head.len().min(buf.remaining());
            buf.put_slice(&self.head[..n]);
            self.head.drain(..n);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Replay<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
}

/// What a route answers.
#[derive(Clone)]
pub enum Reply {
    Json(u16, Value),
    Raw(u16, Vec<u8>),
    /// Holds the request until the test sends on the channel
    Hold(Arc<tokio::sync::Semaphore>),
}

#[derive(Default)]
struct State {
    routes: HashMap<String, Reply>,
    requests: Vec<Seen>,
    /// The first text frame of each socket, which should be the subscribe
    first_frames: Vec<String>,
    upgrades: Vec<Seen>,
    in_flight: usize,
    most_in_flight: usize,
}

/// A loopback stand-in for the League client.
pub struct FakeClient {
    pub addr: SocketAddr,
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<String>,
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    accept: JoinHandle<()>,
}

pub const PHASE: &str = "/lol-gameflow/v1/gameflow-phase";
pub const SUMMONER: &str = "/lol-summoner/v1/current-summoner";

impl FakeClient {
    pub async fn start(chain: &Chain) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let acceptor = tokio_rustls::TlsAcceptor::from(server_config(chain));
        let state = Arc::new(Mutex::new(State::default()));
        state.lock().unwrap().routes.extend([
            (PHASE.to_string(), Reply::Json(200, Value::from("Lobby"))),
            (
                SUMMONER.to_string(),
                Reply::Json(200, serde_json::json!({"puuid": "p"})),
            ),
        ]);
        let events = broadcast::channel(64).0;
        let tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let accept = {
            let (state, events, tasks) = (state.clone(), events.clone(), tasks.clone());
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    let (acceptor, state, events) =
                        (acceptor.clone(), state.clone(), events.clone());
                    let task = tokio::spawn(async move {
                        if let Ok(tls) = acceptor.accept(tcp).await {
                            serve(tls, state, events).await;
                        }
                    });
                    tasks.lock().unwrap().push(task);
                }
            })
        };
        Self {
            addr,
            state,
            events,
            tasks,
            accept,
        }
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn route(&self, path: &str, reply: Reply) {
        self.state
            .lock()
            .unwrap()
            .routes
            .insert(path.to_string(), reply);
    }

    pub fn requests(&self) -> Vec<Seen> {
        self.state.lock().unwrap().requests.clone()
    }

    pub fn first_frames(&self) -> Vec<String> {
        self.state.lock().unwrap().first_frames.clone()
    }

    pub fn upgrades(&self) -> Vec<Seen> {
        self.state.lock().unwrap().upgrades.clone()
    }

    pub fn most_in_flight(&self) -> usize {
        self.state.lock().unwrap().most_in_flight
    }

    /// Publishes `[8,"OnJsonApiEvent",payload]` to every subscribed socket.
    pub fn publish(&self, payload: Value) {
        let frame = serde_json::json!([8, "OnJsonApiEvent", payload]).to_string();
        let _ = self.events.send(frame);
    }

    pub fn publish_raw(&self, text: &str) {
        let _ = self.events.send(text.to_string());
    }

    /// The client exits: the port closes and every open connection drops.
    pub fn stop(&self) {
        self.accept.abort();
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }

    pub fn write_lockfile(&self, dir: &Path, password: &str) {
        std::fs::write(
            dir.join("lockfile"),
            format!("LeagueClient:4242:{}:{password}:https", self.port()),
        )
        .expect("write lockfile");
    }
}

impl Drop for FakeClient {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Option<Vec<u8>> {
    let mut head = vec![];
    let mut byte = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut byte).await.ok()?;
        if n == 0 || head.len() > 64 * 1024 {
            return None;
        }
        head.extend_from_slice(&byte[..n]);
    }
    Some(head)
}

fn parse_head(head: &[u8]) -> Seen {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let path = first.next().unwrap_or_default().to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Seen {
        method,
        path,
        headers,
    }
}

async fn serve<S>(mut stream: S, state: Arc<Mutex<State>>, events: broadcast::Sender<String>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(head) = read_head(&mut stream).await else {
        return;
    };
    let seen = parse_head(&head);
    if seen
        .headers
        .get("upgrade")
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
    {
        state.lock().unwrap().upgrades.push(seen);
        let replay = Replay {
            head,
            inner: stream,
        };
        let callback = |_: &Request, response: Response| Ok(response);
        let Ok(ws) = tokio_tungstenite::accept_hdr_async(replay, callback).await else {
            return;
        };
        socket(ws, state, events.subscribe()).await;
        return;
    }

    let reply = {
        let mut state = state.lock().unwrap();
        state.requests.push(seen.clone());
        let path = seen.path.split('?').next().unwrap_or_default();
        state.routes.get(path).cloned()
    };
    let (status, body) = match reply {
        Some(Reply::Json(status, value)) => (status, value.to_string().into_bytes()),
        Some(Reply::Raw(status, bytes)) => (status, bytes),
        Some(Reply::Hold(gate)) => {
            {
                let mut state = state.lock().unwrap();
                state.in_flight += 1;
                state.most_in_flight = state.most_in_flight.max(state.in_flight);
            }
            let permit = gate.acquire().await;
            state.lock().unwrap().in_flight -= 1;
            drop(permit);
            (200, b"held".to_vec())
        }
        None => (404, br#"{"httpStatus":404}"#.to_vec()),
    };
    let head = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(&body).await;
    let _ = stream.shutdown().await;
}

async fn socket<S>(
    ws: tokio_tungstenite::WebSocketStream<S>,
    state: Arc<Mutex<State>>,
    mut events: broadcast::Receiver<String>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            if sink.send(message).await.is_err() {
                return;
            }
        }
    });
    let mut first = true;
    let mut subscribed = false;
    loop {
        tokio::select! {
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if first {
                        state.lock().unwrap().first_frames.push(text.to_string());
                        first = false;
                    }
                    if text.as_str() == r#"[5,"OnJsonApiEvent"]"# {
                        subscribed = true;
                        // The client acknowledges with an empty frame
                        let _ = out.send(Message::text(""));
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            },
            event = events.recv() => match event {
                Ok(text) if subscribed => {
                    let _ = out.send(Message::text(text));
                }
                Ok(_) => {}
                Err(_) => break,
            },
        }
    }
    writer.abort();
}

/// Waits for a condition the code under test brings about on its own time.
pub async fn eventually(what: &str, timeout: Duration, mut check: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + timeout;
    while !check() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
