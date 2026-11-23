//! The TLS configuration every connection to the League client uses: rustls with
//! the ring provider and the stock webpki verifier over a root store that holds
//! Riot's root and nothing else. Hostname checks stay on: the client's leaf
//! carries `IP:127.0.0.1`, which is what every request connects to.

use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{CryptoProvider, ring};
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use rustls::{ClientConfig, RootCertStore};

#[cfg(all(feature = "parity-ca", not(debug_assertions)))]
compile_error!("the parity-ca feature is for debug builds only");

/// Riot's root for the certificates the client serves on localhost, valid until
/// 2043. Byte for byte the one `src/main/lockfile.ts` pins.
pub const RIOT_ROOT_CA: &str = "-----BEGIN CERTIFICATE-----
MIIEIDCCAwgCCQDJC+QAdVx4UDANBgkqhkiG9w0BAQUFADCB0TELMAkGA1UEBhMC
VVMxEzARBgNVBAgTCkNhbGlmb3JuaWExFTATBgNVBAcTDFNhbnRhIE1vbmljYTET
MBEGA1UEChMKUmlvdCBHYW1lczEdMBsGA1UECxMUTG9MIEdhbWUgRW5naW5lZXJp
bmcxMzAxBgNVBAMTKkxvTCBHYW1lIEVuZ2luZWVyaW5nIENlcnRpZmljYXRlIEF1
dGhvcml0eTEtMCsGCSqGSIb3DQEJARYeZ2FtZXRlY2hub2xvZ2llc0ByaW90Z2Ft
ZXMuY29tMB4XDTEzMTIwNDAwNDgzOVoXDTQzMTEyNzAwNDgzOVowgdExCzAJBgNV
BAYTAlVTMRMwEQYDVQQIEwpDYWxpZm9ybmlhMRUwEwYDVQQHEwxTYW50YSBNb25p
Y2ExEzARBgNVBAoTClJpb3QgR2FtZXMxHTAbBgNVBAsTFExvTCBHYW1lIEVuZ2lu
ZWVyaW5nMTMwMQYDVQQDEypMb0wgR2FtZSBFbmdpbmVlcmluZyBDZXJ0aWZpY2F0
ZSBBdXRob3JpdHkxLTArBgkqhkiG9w0BCQEWHmdhbWV0ZWNobm9sb2dpZXNAcmlv
dGdhbWVzLmNvbTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKoJemF/
6PNG3GRJGbjzImTdOo1OJRDI7noRwJgDqkaJFkwv0X8aPUGbZSUzUO23cQcCgpYj
21ygzKu5dtCN2EcQVVpNtyPuM2V4eEGr1woodzALtufL3Nlyh6g5jKKuDIfeUBHv
JNyQf2h3Uha16lnrXmz9o9wsX/jf+jUAljBJqsMeACOpXfuZy+YKUCxSPOZaYTLC
y+0GQfiT431pJHBQlrXAUwzOmaJPQ7M6mLfsnpHibSkxUfMfHROaYCZ/sbWKl3lr
ZA9DbwaKKfS1Iw0ucAeDudyuqb4JntGU/W0aboKA0c3YB02mxAM4oDnqseuKV/CX
8SQAiaXnYotuNXMCAwEAATANBgkqhkiG9w0BAQUFAAOCAQEAf3KPmddqEqqC8iLs
lcd0euC4F5+USp9YsrZ3WuOzHqVxTtX3hR1scdlDXNvrsebQZUqwGdZGMS16ln3k
WObw7BbhU89tDNCN7Lt/IjT4MGRYRE+TmRc5EeIXxHkQ78bQqbmAI3GsW+7kJsoO
q3DdeE+M+BUJrhWorsAQCgUyZO166SAtKXKLIcxa+ddC49NvMQPJyzm3V+2b1roP
SvD2WV8gRYUnGmy/N0+u6ANq5EsbhZ548zZc+BI4upsWChTLyxt2RxR7+uGlS1+5
EcGfKZ+g024k/J32XP4hdho7WYAS2xMiV83CfLR/MNi8oSMaVQTdKD8cpgiWJk3L
XWehWA==
-----END CERTIFICATE-----";

/// HTTP offers only HTTP/1.1, as Node's `https` does. The socket offers nothing,
/// so the client can never pick `h2` for it.
#[derive(Clone, Copy, Debug)]
pub enum Alpn {
    Http1,
    None,
}

pub fn riot_root() -> CertificateDer<'static> {
    CertificateDer::from_pem_slice(RIOT_ROOT_CA.as_bytes())
        .expect("RIOT_ROOT_CA is one PEM certificate")
}

/// Passed explicitly everywhere, and never installed as the process default, so
/// a stray `ClientConfig::builder()` panics instead of quietly trusting other roots.
fn provider() -> Arc<CryptoProvider> {
    Arc::new(ring::default_provider())
}

pub fn verifier(anchors: &[CertificateDer<'_>]) -> Result<Arc<WebPkiServerVerifier>, rustls::Error> {
    let mut roots = RootCertStore::empty();
    for anchor in anchors {
        roots.add(anchor.clone().into_owned())?;
    }
    WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
        .build()
        .map_err(|err| rustls::Error::General(err.to_string()))
}

pub fn config_with_anchors(
    anchors: &[CertificateDer<'_>],
    alpn: Alpn,
) -> Result<ClientConfig, rustls::Error> {
    let mut config = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_webpki_verifier(verifier(anchors)?)
        .with_no_client_auth();
    config.alpn_protocols = match alpn {
        Alpn::Http1 => vec![b"http/1.1".to_vec()],
        Alpn::None => vec![],
    };
    Ok(config)
}

/// What a League client connection trusts: Riot's root, and in parity builds
/// the fake client's CA as well. Read again for every new set of credentials,
/// because each run of the fake client makes a new CA.
pub fn lcu_anchors() -> Vec<CertificateDer<'static>> {
    #[cfg_attr(not(feature = "parity-ca"), allow(unused_mut))]
    let mut anchors = vec![riot_root()];
    #[cfg(feature = "parity-ca")]
    anchors.extend(parity::fake_ca());
    anchors
}

#[cfg(feature = "parity-ca")]
mod parity {
    use rustls::pki_types::CertificateDer;
    use rustls::pki_types::pem::PemObject;

    /// A PEM file holding the CA of the fake client the parity tools run
    /// (`parity/fake-lcu.ts` writes it as `<dir>/ca.pem`).
    pub const CA_ENV: &str = "BMT_PARITY_CA";

    pub fn fake_ca() -> Vec<CertificateDer<'static>> {
        let Some(path) = std::env::var_os(CA_ENV) else {
            return vec![];
        };
        let certs = std::fs::read(&path)
            .map_err(|err| err.to_string())
            .and_then(|pem| {
                CertificateDer::pem_slice_iter(&pem)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|err| err.to_string())
            });
        match certs {
            Ok(certs) => certs,
            Err(err) => {
                super::super::log(format!("parity: {CA_ENV} {path:?} unreadable: {err}"));
                vec![]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lcu::test_support::{TestCa, riot_subject, self_signed, subject_der};
    use rustls::CertificateError;
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{ServerName, UnixTime};
    use std::net::{IpAddr, Ipv4Addr};

    fn verify(anchors: &[CertificateDer<'_>], leaf: &CertificateDer<'_>) -> Result<(), rustls::Error> {
        let localhost = ServerName::from(IpAddr::V4(Ipv4Addr::LOCALHOST));
        verifier(anchors)?
            .verify_server_cert(leaf, &[], &localhost, &[], UnixTime::now())
            .map(|_| ())
    }

    fn certificate_error(result: Result<(), rustls::Error>) -> CertificateError {
        match result {
            Err(rustls::Error::InvalidCertificate(err)) => err,
            other => panic!("expected a certificate error, got {other:?}"),
        }
    }

    #[test]
    fn the_pin_is_riots_v1_root_and_nothing_else() {
        let root = riot_root();
        assert_eq!(root.len(), 1060);
        assert_eq!(subject_der(&root), {
            let impostor = TestCa::new(riot_subject());
            subject_der(&impostor.cert())
        });
        assert_eq!(lcu_anchors().len(), 1, "only Riot's root without a parity CA");
    }

    #[test]
    fn a_leaf_from_a_trusted_root_passes() {
        let ca = TestCa::named("test root");
        let leaf = ca.leaf(&["127.0.0.1", "localhost"]);
        verify(&[ca.cert()], &leaf.certs[0]).expect("verified");
    }

    #[test]
    fn a_self_signed_localhost_ca_is_refused() {
        let chain = self_signed(&["127.0.0.1", "localhost"], true);
        let err = certificate_error(verify(&[riot_root()], &chain.certs[0]));
        assert!(format!("{err:?}").contains("CaUsedAsEndEntity"), "{err:?}");
    }

    #[test]
    fn a_self_signed_leaf_is_refused() {
        let chain = self_signed(&["127.0.0.1", "localhost"], false);
        assert_eq!(
            certificate_error(verify(&[riot_root()], &chain.certs[0])),
            CertificateError::UnknownIssuer
        );
    }

    #[test]
    fn an_impostor_ca_with_riots_exact_name_is_refused() {
        let impostor = TestCa::new(riot_subject());
        let leaf = impostor.leaf(&["127.0.0.1", "localhost"]);
        verify(&[impostor.cert()], &leaf.certs[0]).expect("the leaf is otherwise valid");
        assert_eq!(
            certificate_error(verify(&[riot_root()], &leaf.certs[0])),
            CertificateError::UnknownIssuer
        );
    }

    #[test]
    fn a_leaf_for_another_host_is_refused() {
        let ca = TestCa::named("test root");
        let leaf = ca.leaf(&["127.0.0.2", "example.com"]);
        assert!(matches!(
            certificate_error(verify(&[ca.cert()], &leaf.certs[0])),
            CertificateError::NotValidForNameContext { .. }
        ));
    }

    #[test]
    fn alpn_differs_between_http_and_the_socket() {
        let http = config_with_anchors(&[riot_root()], Alpn::Http1).expect("http");
        let socket = config_with_anchors(&[riot_root()], Alpn::None).expect("socket");
        assert_eq!(http.alpn_protocols, [b"http/1.1".to_vec()]);
        assert!(socket.alpn_protocols.is_empty());
    }

    #[test]
    fn no_anchors_is_an_error_not_an_open_door() {
        assert!(config_with_anchors(&[], Alpn::Http1).is_err());
    }
}
