//! The fallback for a client no lockfile can settle: read the port and password
//! off the `LeagueClientUx` command line, as league-connect's `authenticate()`
//! does. `ps` on macOS, PowerShell on Windows, never through a shell.

use super::LcuError;
use super::lockfile::Credentials;

const PROCESS_NAME: &str = "LeagueClientUx";

/// Where the command lines come from.
#[derive(Debug)]
pub enum ProcessSource {
    System,
    /// A file standing in for the process list, so a lane can exercise the
    /// lookup without reading any real process. `None` finds nothing.
    #[cfg(any(test, feature = "parity-ca"))]
    File {
        path: Option<std::path::PathBuf>,
        runs: std::sync::atomic::AtomicUsize,
    },
}

#[cfg(any(test, feature = "parity-ca"))]
impl ProcessSource {
    pub fn file(path: Option<std::path::PathBuf>) -> Self {
        Self::File {
            path,
            runs: Default::default(),
        }
    }
}

pub async fn lookup(source: &ProcessSource) -> Result<Credentials, LcuError> {
    match source {
        ProcessSource::System => system::lookup().await,
        #[cfg(any(test, feature = "parity-ca"))]
        ProcessSource::File { path, runs } => {
            let run = runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            super::log(format!("parity: process lookup {run}"));
            let text = match path {
                Some(path) => std::fs::read_to_string(path).unwrap_or_default(),
                None => String::new(),
            };
            parse_command_lines(&text).ok_or(LcuError::NotFound)
        }
    }
}

/// `(?= *"| --)`, the lookahead that ends each of league-connect's captures:
/// spaces then a closing quote, or a space then the next flag.
fn ends_value(rest: &str) -> bool {
    rest.trim_start_matches(' ').starts_with('"') || rest.starts_with(" --")
}

/// `--flag=([0-9]+)` followed by the lookahead.
fn number_arg<'a>(text: &'a str, flag: &str) -> Option<&'a str> {
    text.match_indices(flag).find_map(|(at, _)| {
        let value = &text[at + flag.len()..];
        let digits = value.bytes().take_while(u8::is_ascii_digit).count();
        (digits > 0 && ends_value(&value[digits..])).then(|| &value[..digits])
    })
}

/// `--flag=(.+?)` followed by the lookahead: the shortest value that works.
fn lazy_arg<'a>(text: &'a str, flag: &str) -> Option<&'a str> {
    text.match_indices(flag).find_map(|(at, _)| {
        let value = &text[at + flag.len()..];
        value
            .char_indices()
            .skip(1)
            .find(|&(end, _)| ends_value(&value[end..]))
            .map(|(end, _)| &value[..end])
    })
}

/// league-connect strips every line break from the output before it matches,
/// so the command lines of every matching process run together.
pub fn parse_command_lines(output: &str) -> Option<Credentials> {
    let text: String = output
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .collect();
    let port = number_arg(&text, "--app-port=")?.parse().ok()?;
    let password = lazy_arg(&text, "--remoting-auth-token=")?.to_string();
    let pid = number_arg(&text, "--app-pid=")?.parse().ok()?;
    Some(Credentials {
        pid,
        port,
        password,
    })
}

#[cfg(not(windows))]
mod system {
    use super::*;

    pub async fn lookup() -> Result<Credentials, LcuError> {
        let output = tokio::process::Command::new("ps")
            .args(["x", "-o", "args"])
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|_| LcuError::NotFound)?;
        // `ps x -o args | grep 'LeagueClientUx'`, without the shell
        let matching: String = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.contains(PROCESS_NAME))
            .collect();
        parse_command_lines(&matching).ok_or(LcuError::NotFound)
    }
}

#[cfg(windows)]
mod system {
    use super::*;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    async fn powershell(command: &str) -> Option<String> {
        let output = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", command])
            .creation_flags(CREATE_NO_WINDOW)
            .kill_on_drop(true)
            .output()
            .await
            .ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    pub async fn lookup() -> Result<Credentials, LcuError> {
        let query = format!(
            "Get-CimInstance -Query \"SELECT * from Win32_Process WHERE name LIKE '{PROCESS_NAME}.exe'\" | Select-Object -ExpandProperty CommandLine"
        );
        if let Some(credentials) = powershell(&query)
            .await
            .as_deref()
            .and_then(parse_command_lines)
        {
            return Ok(credentials);
        }
        // An elevated client hides its command line, and its handle and path
        let elevated = format!(
            "if ((Get-Process -Name {PROCESS_NAME} -ErrorAction SilentlyContinue | Where-Object {{!$_.Handle -and !$_.Path}})) {{Write-Output \"True\"}} else {{Write-Output \"False\"}}"
        );
        if powershell(&elevated)
            .await
            .is_some_and(|out| out.contains("True"))
        {
            return Err(LcuError::Elevated);
        }
        Err(LcuError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials(pid: u32, port: u16, password: &str) -> Credentials {
        Credentials {
            pid,
            port,
            password: password.into(),
        }
    }

    #[test]
    fn reads_a_macos_ps_line() {
        let ps = "/Applications/League of Legends.app/Contents/LoL/LeagueClient.app/Contents/LoL/LeagueClientUx.app/Contents/MacOS/LeagueClientUx --riotclient-auth-token=x --riotclient-app-port=1 --remoting-auth-token=Tok_en-123 --app-port=54321 --install-directory=/Applications/League of Legends.app/Contents/LoL --app-pid=4242 --region=NA\n";
        assert_eq!(
            parse_command_lines(ps),
            Some(credentials(4242, 54321, "Tok_en-123"))
        );
    }

    #[test]
    fn reads_a_quoted_windows_command_line() {
        let cim = "\"C:/Riot Games/League of Legends/LeagueClientUx.exe\" \"--riotclient-auth-token=x\" \"--remoting-auth-token=abc def\" \"--app-port=6000\" \"--app-pid=77\"\r\n";
        assert_eq!(
            parse_command_lines(cim),
            Some(credentials(77, 6000, "abc def"))
        );
    }

    #[test]
    fn the_last_flag_needs_something_after_it() {
        // The regexes need a quote or another flag after each value
        assert_eq!(
            parse_command_lines("LeagueClientUx --remoting-auth-token=t --app-port=1 --app-pid=2"),
            None
        );
        assert_eq!(
            parse_command_lines(
                "LeagueClientUx --remoting-auth-token=t --app-port=1 --app-pid=2 --x"
            ),
            Some(credentials(2, 1, "t"))
        );
    }

    #[test]
    fn lines_run_together_once_breaks_are_stripped() {
        // The pid ends one line and the next line starts with a flag
        let two = "LeagueClientUx --remoting-auth-token=t --app-port=1 --app-pid=2\n --next\n";
        assert_eq!(parse_command_lines(two), Some(credentials(2, 1, "t")));
    }

    #[test]
    fn the_token_is_the_shortest_match() {
        assert_eq!(
            lazy_arg("--remoting-auth-token=a --b --c", "--remoting-auth-token="),
            Some("a")
        );
        assert_eq!(
            lazy_arg("--remoting-auth-token=  --b", "--remoting-auth-token="),
            Some(" ")
        );
        assert_eq!(
            lazy_arg("--remoting-auth-token= --b", "--remoting-auth-token="),
            None
        );
    }

    #[test]
    fn finds_nothing_without_the_flags() {
        assert_eq!(parse_command_lines(""), None);
        assert_eq!(parse_command_lines("LeagueClientUx --app-port=x --"), None);
    }

    #[tokio::test]
    async fn a_file_source_counts_its_runs() {
        let source = ProcessSource::file(None);
        assert!(matches!(lookup(&source).await, Err(LcuError::NotFound)));
        assert!(matches!(lookup(&source).await, Err(LcuError::NotFound)));
        let ProcessSource::File { runs, .. } = &source else {
            unreachable!()
        };
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
}
