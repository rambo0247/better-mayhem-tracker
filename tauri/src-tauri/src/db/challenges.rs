//! The writers and the baseline from `src/main/db/challenges.ts`. The recap's
//! reader of `challenge_game_progress` is T16's, in `db/recap.rs`.

use std::collections::HashMap;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};

use super::js;

/// One history row: a challenge's value and level on a day. The id is the
/// JavaScript number the payload carried.
#[derive(Debug, Clone, PartialEq)]
pub struct DayValue {
    pub id: f64,
    pub value: f64,
    pub level: &'static str,
}

/// One challenge a game moved, as `saveGameChallenges` binds it.
#[derive(Debug, Clone, PartialEq)]
pub struct GameProgress {
    pub id: f64,
    pub name: String,
    pub description: String,
    pub previous_value: f64,
    pub current_value: f64,
    pub previous_level: &'static str,
    pub current_level: &'static str,
    pub next_level: Option<&'static str>,
    pub next_threshold: Option<f64>,
    pub icon_path: String,
}

/// `saveChallenges`: the payload and one history row per challenge, in one
/// transaction. The last read of a day wins.
pub fn save_challenges(
    conn: &Connection,
    day: &str,
    payload: &str,
    values: &[DayValue],
    now_ms: i64,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let mut write_state = tx.prepare_cached(
        "INSERT OR REPLACE INTO challenge_state (id, payload, fetched_at) VALUES (1, ?, ?)",
    )?;
    let mut write_history = tx.prepare_cached(
        "INSERT OR REPLACE INTO challenge_history (day, challenge_id, value, level) VALUES (?, ?, ?, ?)",
    )?;
    write_state.execute([Sql::Text(payload.to_owned()), Sql::Real(now_ms as f64)])?;
    for entry in values {
        write_history.execute([
            Sql::Text(day.to_owned()),
            Sql::Real(entry.id),
            Sql::Real(entry.value),
            Sql::Text(entry.level.to_owned()),
        ])?;
    }
    drop((write_state, write_history));
    tx.commit()
}

/// `getStoredChallenges`.
pub fn get_stored_challenges(conn: &Connection) -> rusqlite::Result<Option<(String, f64)>> {
    conn.prepare_cached("SELECT payload, fetched_at FROM challenge_state WHERE id = 1")?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
}

/// The day a baseline was read from, and each challenge's value that day,
/// keyed as a JavaScript object keys a number.
#[derive(Debug, Clone, PartialEq)]
pub struct Baseline {
    pub day: String,
    pub values: HashMap<String, f64>,
}

/// `getChallengeBaseline`: the newest day on or before `cutoff`, else the
/// oldest day before `today`.
pub fn get_challenge_baseline(
    conn: &Connection,
    cutoff: &str,
    today: &str,
) -> rusqlite::Result<Option<Baseline>> {
    let newest: Option<Option<String>> = conn
        .prepare_cached(
            "SELECT day FROM challenge_history WHERE day <= ? ORDER BY day DESC LIMIT 1",
        )?
        .query_row([cutoff], |row| row.get(0))
        .optional()?;
    let day = match newest {
        Some(day) => day,
        None => conn
            .prepare_cached("SELECT MIN(day) as day FROM challenge_history WHERE day < ?")?
            .query_row([today], |row| row.get(0))
            .optional()?
            .flatten(),
    };
    let Some(day) = day.filter(|day: &String| !day.is_empty()) else {
        return Ok(None);
    };
    let mut values = HashMap::new();
    let mut statement =
        conn.prepare_cached("SELECT challenge_id, value FROM challenge_history WHERE day = ?")?;
    let mut rows = statement.query([&day])?;
    while let Some(row) = rows.next()? {
        let id: f64 = row.get(0)?;
        values.insert(js::number_to_string(id), row.get(1)?);
    }
    Ok(Some(Baseline { day, values }))
}

/// `saveGameChallenges`, in one transaction.
pub fn save_game_challenges(
    conn: &Connection,
    game_id: f64,
    rows: &[GameProgress],
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let mut insert = tx.prepare_cached(
        "
    INSERT OR REPLACE INTO challenge_game_progress
      (game_id, challenge_id, name, description, previous_value, current_value,
       previous_level, current_level, next_level, next_threshold, icon_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ",
    )?;
    let text = |s: &str| Sql::Text(s.to_owned());
    for row in rows {
        insert.execute([
            Sql::Real(game_id),
            Sql::Real(row.id),
            text(&row.name),
            text(&row.description),
            Sql::Real(row.previous_value),
            Sql::Real(row.current_value),
            text(row.previous_level),
            text(row.current_level),
            row.next_level.map_or(Sql::Null, text),
            row.next_threshold.map_or(Sql::Null, Sql::Real),
            text(&row.icon_path),
        ])?;
    }
    drop(insert);
    tx.commit()
}

/// `hasGameChallenges`.
pub fn has_game_challenges(conn: &Connection, game_id: f64) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT 1 FROM challenge_game_progress WHERE game_id = ? LIMIT 1")?
        .query_row([Sql::Real(game_id)], |_| Ok(()))
        .optional()
        .map(|row| row.is_some())
}
