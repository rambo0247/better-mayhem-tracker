//! `src/main/db/settings.ts`, and the allow list `ipc-handlers.ts` puts in
//! front of it.

use rusqlite::{Connection, OptionalExtension};

/// `SESSION_GROUPING_SETTING` in `src/shared/session.ts`.
pub const SESSION_GROUPING_SETTING: &str = "session_grouping";

/// The settings table doubles as internal bookkeeping (`sgp_host`, the
/// per-account `backfill_complete_*` flags, `score_formula_version`), none of
/// which the page may read or rewrite. Only the keys behind the Settings page
/// are exposed.
pub const RENDERER_SETTINGS: [&str; 10] = [
    "auto_start",
    "auto_update",
    "show_release_notes",
    "minimize_to_tray",
    "hidden_queues",
    "hide_remakes",
    "auto_backup",
    "remember_filters",
    "hidden_nav_links",
    SESSION_GROUPING_SETTING,
];

pub fn is_renderer_setting(key: &str) -> bool {
    RENDERER_SETTINGS.contains(&key)
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT value FROM settings WHERE key = ?")?
        .query_row([key], |row| row.get(0))
        .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.prepare_cached("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")?
        .execute([key, value])?;
    Ok(())
}
