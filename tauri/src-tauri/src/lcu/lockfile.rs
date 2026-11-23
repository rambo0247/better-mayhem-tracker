//! Port of `src/main/lockfile.ts`. The League client advertises itself, for as
//! long as it runs, in a `lockfile` in its install folder:
//! `LeagueClient:<pid>:<port>:<password>:<protocol>`. Finding it is a file read.
//! The process lookup is only the fallback for an install nothing records.

use std::collections::HashSet;
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use tokio::net::TcpStream;

#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub pid: u32,
    pub port: u16,
    pub password: String,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("pid", &self.pid)
            .field("port", &self.port)
            .field("password", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClientLookup {
    /// A lockfile whose client is answering on the port it names
    Running(Credentials),
    /// An install is there and no client in it is running
    Closed,
    /// No install found, or a lockfile that couldn't be read: only the process
    /// itself can say whether the client is up
    Unknown,
}

/// Where the Riot Client keeps its per-product records, and where League goes
/// unless told otherwise.
#[derive(Clone, Debug)]
pub struct InstallRoots {
    pub metadata_root: PathBuf,
    pub default_dir: PathBuf,
}

impl InstallRoots {
    #[cfg(target_os = "macos")]
    pub fn system() -> Self {
        Self {
            metadata_root: "/Users/Shared/Riot Games/Metadata".into(),
            default_dir: "/Applications/League of Legends.app/Contents/LoL".into(),
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn system() -> Self {
        let program_data =
            std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into());
        Self {
            metadata_root: Path::new(&program_data).join("Riot Games").join("Metadata"),
            default_dir: "C:\\Riot Games\\League of Legends".into(),
        }
    }
}

/// What sits beside the lockfile in a real install, telling a closed client
/// apart from a folder that never held one.
const CLIENT_BINARY: &str = if cfg!(target_os = "macos") {
    "LeagueClient.app"
} else {
    "LeagueClient.exe"
};

/// The Riot Client records a macOS install as the .app bundle itself, while the
/// client runs, and writes its lockfile, from Contents/LoL inside it.
pub fn client_dir(install_path: &str) -> PathBuf {
    if cfg!(target_os = "macos") && install_path.ends_with(".app") {
        Path::new(install_path).join("Contents").join("LoL")
    } else {
        PathBuf::from(install_path)
    }
}

static PRODUCT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^league_of_legends\.[a-z]+$").expect("valid regex"));
static INSTALL_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^product_install_full_path:\s*"?([^"\r\n]+?)"?\s*$"#).expect("valid regex")
});
// lockfile.ts's /^[^:]+:(\d+):(\d+):(.+):https?$/, with JavaScript's `\d` and `.`
static LOCKFILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[^:]+:([0-9]+):([0-9]+):([^\n\r\x{2028}\x{2029}]+):https?$").expect("valid regex")
});

/// The folders the Riot Client's records name, read on every lookup so a
/// reinstall elsewhere is picked up without a restart.
fn recorded_install_dirs(metadata_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(metadata_root) else {
        return vec![];
    };
    let mut products: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        // The ".game_patch" entries beside each patchline are not installs
        .filter(|name| PRODUCT.is_match(name))
        .collect();
    // readdirSync returns names sorted; read_dir has no order
    products.sort();
    products
        .iter()
        .filter_map(|product| {
            let settings = metadata_root
                .join(product)
                .join(format!("{product}.product_settings.yaml"));
            let text = std::fs::read(settings).ok()?;
            let text = String::from_utf8_lossy(&text);
            let found = INSTALL_PATH.captures(&text)?;
            Some(client_dir(&found[1]))
        })
        .collect()
}

/// `path.resolve(dir).toLowerCase()`: absolute, with `.`, `..` and trailing
/// separators folded away.
fn dedupe_key(dir: &Path) -> String {
    let absolute = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut folded = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                folded.pop();
            }
            other => folded.push(other),
        }
    }
    folded.to_string_lossy().to_lowercase()
}

/// Every folder the client could be running from, most specific first: where it
/// last said it was, then the Riot Client's records, then the default.
pub fn install_dir_candidates(reported: Option<&str>, roots: &InstallRoots) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    reported
        .filter(|dir| !dir.is_empty())
        .map(client_dir)
        .into_iter()
        .chain(recorded_install_dirs(&roots.metadata_root))
        .chain([roots.default_dir.clone()])
        .filter(|dir| seen.insert(dedupe_key(dir)))
        .collect()
}

pub fn parse_lockfile(text: &str) -> Option<Credentials> {
    let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let found = LOCKFILE.captures(text)?;
    Some(Credentials {
        pid: found[1].parse().ok()?,
        port: found[2].parse().ok()?,
        password: found[3].to_string(),
    })
}

/// A lockfile can outlive a client that didn't shut down cleanly, so its port
/// has to answer before it counts. A local port refuses or accepts at once; the
/// timeout only covers a probe that does neither.
async fn is_listening(port: u16, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, TcpStream::connect(("127.0.0.1", port))).await,
        Ok(Ok(_))
    )
}

/// Whether the client is running, and its credentials when it is, from the
/// lockfile in whichever of `dirs` holds one. Launches nothing.
pub async fn find_client(dirs: &[PathBuf], probe_timeout: Duration) -> ClientLookup {
    let mut installed = false;
    let mut unreadable = false;

    for dir in dirs {
        let bytes = match std::fs::read(dir.join("lockfile")) {
            Ok(bytes) => bytes,
            // A missing lockfile in a real install is a closed client. Any other
            // failure means we couldn't look, which says nothing either way.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if dir.join(CLIENT_BINARY).exists() {
                    installed = true;
                }
                continue;
            }
            Err(_) => {
                unreadable = true;
                continue;
            }
        };

        let Some(credentials) = parse_lockfile(&String::from_utf8_lossy(&bytes)) else {
            unreadable = true;
            continue;
        };
        installed = true;
        if is_listening(credentials.port, probe_timeout).await {
            return ClientLookup::Running(credentials);
        }
    }

    if installed && !unreadable {
        ClientLookup::Closed
    } else {
        ClientLookup::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lcu::test_support::TempDir;

    const PROBE: Duration = Duration::from_millis(500);

    fn credentials(pid: u32, port: u16, password: &str) -> Credentials {
        Credentials {
            pid,
            port,
            password: password.into(),
        }
    }

    #[test]
    fn parses_the_lockfile_format() {
        assert_eq!(
            parse_lockfile("LeagueClient:12345:54321:Abc-_9xyz:https"),
            Some(credentials(12345, 54321, "Abc-_9xyz"))
        );
        assert_eq!(
            parse_lockfile("LeagueClient:1:2:pw:http\r\n"),
            Some(credentials(1, 2, "pw"))
        );
        assert_eq!(
            parse_lockfile("\u{feff} LeagueClient:1:2:pw:https \n"),
            Some(credentials(1, 2, "pw"))
        );
    }

    #[test]
    fn a_password_may_hold_colons() {
        assert_eq!(
            parse_lockfile("LeagueClient:7:8:a:b:https:c:https"),
            Some(credentials(7, 8, "a:b:https:c"))
        );
    }

    #[test]
    fn rejects_what_lockfile_ts_rejects() {
        for text in [
            "",
            "garbage",
            "LeagueClient:1:2:pw:wss",
            "LeagueClient:1:2:pw:httpsx",
            "LeagueClient:1:2::https",
            ":1:2:pw:https",
            "LeagueClient:x:2:pw:https",
            "LeagueClient:1:2:pw\nmore:https",
            "LeagueClient:1:70000:pw:https",
        ] {
            assert_eq!(parse_lockfile(text), None, "{text:?}");
        }
    }

    #[test]
    fn credentials_never_print_the_password() {
        let shown = format!("{:?}", credentials(1, 2, "hunter2"));
        assert!(!shown.contains("hunter2"), "{shown}");
    }

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::write(dir.join(name), text).expect("write");
    }

    fn dead_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    }

    #[tokio::test]
    async fn a_live_port_is_running() {
        let dir = TempDir::new();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        write(
            dir.path(),
            "lockfile",
            &format!("LeagueClient:9:{port}:pw:https"),
        );
        assert_eq!(
            find_client(&[dir.path().into()], PROBE).await,
            ClientLookup::Running(credentials(9, port, "pw"))
        );
    }

    #[tokio::test]
    async fn a_stale_lockfile_reads_as_closed() {
        let dir = TempDir::new();
        write(
            dir.path(),
            "lockfile",
            &format!("LeagueClient:9:{}:pw:https", dead_port()),
        );
        assert_eq!(
            find_client(&[dir.path().into()], PROBE).await,
            ClientLookup::Closed
        );
    }

    #[tokio::test]
    async fn closed_and_unknown_follow_lockfile_ts() {
        let empty = TempDir::new();
        assert_eq!(
            find_client(&[empty.path().into()], PROBE).await,
            ClientLookup::Unknown,
            "a folder that never held a client"
        );

        let installed = TempDir::new();
        std::fs::create_dir(installed.path().join(CLIENT_BINARY)).expect("mkdir");
        assert_eq!(
            find_client(&[installed.path().into()], PROBE).await,
            ClientLookup::Closed,
            "an install with no lockfile"
        );

        let garbage = TempDir::new();
        write(garbage.path(), "lockfile", "not a lockfile");
        assert_eq!(
            find_client(&[installed.path().into(), garbage.path().into()], PROBE).await,
            ClientLookup::Unknown,
            "an install beside a lockfile that does not parse"
        );

        let unreadable = TempDir::new();
        std::fs::create_dir(unreadable.path().join("lockfile")).expect("mkdir");
        assert_eq!(
            find_client(&[installed.path().into(), unreadable.path().into()], PROBE).await,
            ClientLookup::Unknown,
            "an install beside a lockfile that cannot be read"
        );
    }

    #[tokio::test]
    async fn the_first_live_lockfile_wins() {
        let stale = TempDir::new();
        write(
            stale.path(),
            "lockfile",
            &format!("LeagueClient:1:{}:old:https", dead_port()),
        );
        let live = TempDir::new();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        write(
            live.path(),
            "lockfile",
            &format!("LeagueClient:2:{port}:new:https"),
        );
        assert_eq!(
            find_client(&[stale.path().into(), live.path().into()], PROBE).await,
            ClientLookup::Running(credentials(2, port, "new"))
        );
    }

    fn roots(dir: &TempDir) -> InstallRoots {
        InstallRoots {
            metadata_root: dir.path().join("Metadata"),
            default_dir: dir.path().join("Default"),
        }
    }

    fn record(roots: &InstallRoots, product: &str, line: &str) {
        let folder = roots.metadata_root.join(product);
        std::fs::create_dir_all(&folder).expect("mkdir");
        std::fs::write(
            folder.join(format!("{product}.product_settings.yaml")),
            format!("---\nauto_patching_enabled_by_player: true\n{line}\nshould_repair: false\n"),
        )
        .expect("write");
    }

    #[test]
    fn candidates_run_reported_then_records_then_default() {
        let dir = TempDir::new();
        let roots = roots(&dir);
        let pbe = dir.path().join("PBE");
        let live = dir.path().join("Live");
        record(
            &roots,
            "league_of_legends.pbe",
            &format!("product_install_full_path: \"{}\"\r", pbe.display()),
        );
        record(
            &roots,
            "league_of_legends.live",
            &format!("product_install_full_path: {}", live.display()),
        );
        record(
            &roots,
            "league_of_legends.live.game_patch",
            "product_install_full_path: /nowhere",
        );
        let reported = dir.path().join("Reported");
        assert_eq!(
            install_dir_candidates(reported.to_str(), &roots),
            vec![reported, live, pbe, roots.default_dir.clone()]
        );
        assert_eq!(
            install_dir_candidates(None, &roots).last(),
            Some(&roots.default_dir)
        );
    }

    #[test]
    fn candidates_drop_duplicates_ignoring_case_and_dots() {
        let dir = TempDir::new();
        let roots = roots(&dir);
        record(
            &roots,
            "league_of_legends.live",
            &format!(
                "product_install_full_path: {}",
                dir.path().join("DEFAULT").display()
            ),
        );
        let reported = format!("{}/x/../Default/", dir.path().display());
        assert_eq!(
            install_dir_candidates(Some(&reported), &roots),
            vec![PathBuf::from(&reported)]
        );
    }

    #[test]
    fn a_missing_metadata_root_leaves_the_default() {
        let dir = TempDir::new();
        let roots = roots(&dir);
        assert_eq!(
            install_dir_candidates(None, &roots),
            vec![roots.default_dir.clone()]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_mac_app_bundle_means_its_lol_folder() {
        assert_eq!(
            client_dir("/Games/League of Legends.app"),
            PathBuf::from("/Games/League of Legends.app/Contents/LoL")
        );
        assert_eq!(client_dir("/Games/LoL"), PathBuf::from("/Games/LoL"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn only_macos_rewrites_app_paths() {
        assert_eq!(
            client_dir("D:\\League.app"),
            PathBuf::from("D:\\League.app")
        );
    }
}
