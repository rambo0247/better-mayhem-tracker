//! The shell script that finishes a macOS update once the app has quit:
//! `src/main/mac-update-script.ts`, byte for byte. It waits for the process to
//! exit, moves the old bundle aside, moves the new one in, and relaunches
//! whichever is in place, putting the old one back if the swap fails. An app
//! that never exits is left alone.
//!
//! Paths are macOS paths held as text and joined with `/`, as Node's
//! `path.join` does there, so the script is the same on every host that
//! builds or tests it.

pub struct MacSwap {
    /// The process to wait out before touching its bundle.
    pub pid: u32,
    /// The installed `.app` being replaced.
    pub bundle: String,
    /// The new `.app`, unpacked in a folder beside `bundle`.
    pub staged_bundle: String,
    /// That folder, removed once the swap is done.
    pub staging_dir: String,
    /// Where the old bundle waits until the new one is in place.
    pub backup: String,
    /// The download's temp folder, removed last.
    pub tmp_dir: String,
    pub relaunch_args: Vec<String>,
}

/// `path.posix.join(dir, name)` for a `name` with no `/` in it.
pub fn mac_join(dir: &str, name: &str) -> String {
    format!("{}/{name}", dir.trim_end_matches('/'))
}

/// `path.posix.dirname(path)` for an absolute path.
pub fn mac_parent(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(at) => &path[..at],
    }
}

/// Single-quoted for sh, which takes everything literally inside but a quote.
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

pub fn mac_swap_script(swap: &MacSwap) -> String {
    let q = |path: &String| sh_quote(path);
    let args = if swap.relaunch_args.is_empty() {
        String::new()
    } else {
        let quoted: Vec<String> = swap.relaunch_args.iter().map(|a| sh_quote(a)).collect();
        format!(" --args {}", quoted.join(" "))
    };
    [
        "#!/bin/sh".to_owned(),
        format!("pid={}", swap.pid),
        "tries=0".to_owned(),
        r#"while kill -0 "$pid" 2>/dev/null; do"#.to_owned(),
        "  tries=$((tries + 1))".to_owned(),
        r#"  if [ "$tries" -gt 120 ]; then"#.to_owned(),
        format!("    rm -rf {} {}", q(&swap.staging_dir), q(&swap.tmp_dir)),
        "    exit 1".to_owned(),
        "  fi".to_owned(),
        "  sleep 1".to_owned(),
        "done".to_owned(),
        format!("rm -rf {}", q(&swap.backup)),
        format!("if mv {} {}; then", q(&swap.bundle), q(&swap.backup)),
        format!(
            "  if mv {} {}; then",
            q(&swap.staged_bundle),
            q(&swap.bundle)
        ),
        format!("    rm -rf {}", q(&swap.backup)),
        "  else".to_owned(),
        format!("    mv {} {}", q(&swap.backup), q(&swap.bundle)),
        "  fi".to_owned(),
        "fi".to_owned(),
        format!("rm -rf {}", q(&swap.staging_dir)),
        format!("open {}{args}", q(&swap.bundle)),
        format!("rm -rf {}", q(&swap.tmp_dir)),
        String::new(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `macSwapScript`'s output for these inputs, written by
    /// `src/main/mac-update-script.ts` under bun.
    fn electron(name: &str) -> String {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/electron-update-scripts.json"
        ))
        .expect("the fixture is JSON");
        fixtures[name].as_str().expect("a script").to_owned()
    }

    #[test]
    fn matches_electron_with_a_quote_in_the_path_and_hidden() {
        let apps = "/Users/me/It's Apps";
        let staging = mac_join(apps, ".Better Mayhem Tracker.app.update");
        let swap = MacSwap {
            pid: 4242,
            bundle: mac_join(apps, "Better Mayhem Tracker.app"),
            staged_bundle: mac_join(&staging, "Better Mayhem Tracker.app"),
            backup: mac_join(apps, ".Better Mayhem Tracker.app.update.old"),
            staging_dir: staging,
            tmp_dir: "/var/folders/xy/T/better-mayhem-update-AbC123".into(),
            relaunch_args: vec!["--hidden".into()],
        };
        assert_eq!(mac_swap_script(&swap), electron("mac"));
    }

    #[test]
    fn matches_electron_without_relaunch_args() {
        let swap = MacSwap {
            pid: 7,
            bundle: "/Applications/B.app".into(),
            staged_bundle: "/Applications/.B.app.update/B.app".into(),
            staging_dir: "/Applications/.B.app.update".into(),
            backup: "/Applications/.B.app.update.old".into(),
            tmp_dir: "/tmp/t".into(),
            relaunch_args: Vec::new(),
        };
        assert_eq!(mac_swap_script(&swap), electron("plain"));
    }

    #[test]
    fn joins_and_parents_as_node_posix_path_does() {
        assert_eq!(mac_join("/Applications", "B.app"), "/Applications/B.app");
        assert_eq!(mac_join("/", ".B.app.update"), "/.B.app.update");
        assert_eq!(mac_parent("/Applications/B.app"), "/Applications");
        assert_eq!(mac_parent("/Applications/B.app/"), "/Applications");
        assert_eq!(mac_parent("/B.app"), "/");
    }
}
