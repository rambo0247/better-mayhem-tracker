//! `src/main/db/migrations.ts`. Every step from V1 is here, so a backup
//! from any earlier version still upgrades. The `ALTER TABLE` text is
//! Electron's exactly, because SQLite appends it to the table's stored DDL.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use serde_json::Value;

use super::filters::QUEUE_ID_MAYHEM_CLASSIC;
use super::js::{self, Cell};
use super::payloads::{
    PAYLOAD_PAGE_SIZE, detect_remake, gzip, parse_patch, participant_rows_from_raw,
    rebuild_participants_from_payloads,
};
use super::settings::{get_setting, set_setting};

/// Stamped in `PRAGMA user_version`. Version 0 means the database predates
/// versioning, so it could be missing any subset of the columns v1 adds,
/// which is why each step checks for its column rather than assuming. A
/// database `CREATE_TABLES` just built is also version 0, and lands on the
/// same no-op path.
pub const SCHEMA_VERSION: i64 = 4;

/// `migrateHiddenQueues`: the old hide-Mayhem-Classic switch became a
/// per-queue list. Writing the key even when nothing was hidden is what keeps
/// this from firing again after the user switches every queue back on.
pub fn migrate_hidden_queues(conn: &Connection) -> rusqlite::Result<()> {
    if get_setting(conn, "hidden_queues")?.is_some() {
        return Ok(());
    }
    let hid_classic = get_setting(conn, "hide_classic_games")?.as_deref() == Some("true");
    let value = if hid_classic {
        QUEUE_ID_MAYHEM_CLASSIC.to_string()
    } else {
        String::new()
    };
    set_setting(conn, "hidden_queues", &value)
}

pub fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    stmt.query_map([], |row| row.get("name"))?.collect()
}

/// `runMigrations`. `now_ms` stamps the summoner rows a V1 upgrade
/// recovers.
pub fn run_migrations(conn: &Connection, now_ms: i64) -> rusqlite::Result<()> {
    let current = user_version(conn)?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    if current < 1 {
        migrate_to_v1(conn, now_ms)?;
    }
    if current < 2 {
        migrate_to_v2(conn)?;
    }
    if current < 3 {
        migrate_to_v3(conn)?;
    }
    if current < 4 {
        migrate_to_v4(conn)?;
    }

    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
}

/// Brings pre-versioning databases up to the schema `CREATE_TABLES` now
/// declares. Each column is added only if absent.
fn migrate_to_v1(conn: &Connection, now_ms: i64) -> rusqlite::Result<()> {
    let games = table_columns(conn, "games")?;

    if !games.contains("is_remake") {
        conn.execute_batch("ALTER TABLE games ADD COLUMN is_remake INTEGER NOT NULL DEFAULT 0")?;
        backfill_remakes(conn)?;
    }

    if !games.contains("puuid") {
        conn.execute_batch("ALTER TABLE games ADD COLUMN puuid TEXT NOT NULL DEFAULT ''")?;
        backfill_game_puuids(conn, now_ms)?;
    }

    if !games.contains("game_version") {
        conn.execute_batch("ALTER TABLE games ADD COLUMN game_version TEXT")?;
        backfill_game_versions(conn)?;
    }

    // Pins games to the top of match history; nothing to backfill.
    if !games.contains("favorite") {
        conn.execute_batch("ALTER TABLE games ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")?;
    }

    // Scores are filled in by the score backfill once champion data has
    // loaded, so the columns only need to exist here.
    let player_stats = table_columns(conn, "player_stats")?;
    if !player_stats.contains("score") {
        conn.execute_batch("ALTER TABLE player_stats ADD COLUMN score REAL")?;
    }
    if !player_stats.contains("score_badge") {
        conn.execute_batch("ALTER TABLE player_stats ADD COLUMN score_badge TEXT")?;
    }

    // Remember our own profile icon so the home page can show it
    if !table_columns(conn, "summoner")?.contains("profile_icon") {
        conn.execute_batch("ALTER TABLE summoner ADD COLUMN profile_icon INTEGER")?;
    }
    Ok(())
}

/// A `raw_json` cell as the text `JSON.parse` would read: a string, or a
/// buffer's UTF-8.
fn json_text(cell: &Cell) -> Option<String> {
    match cell {
        Cell::Text(s) => Some(s.clone()),
        Cell::Blob(b) => Some(String::from_utf8_lossy(b).into_owned()),
        _ => None,
    }
}

fn parse_json(cell: &Cell) -> Option<Value> {
    js::parse(&json_text(cell)?)
}

/// Compresses the raw payloads, normalizes them into `match_participants`,
/// and then drops the `raw_json` column. This is the only chance to extract
/// from the text column, so the rows are written and checked before it goes.
fn migrate_to_v2(conn: &Connection) -> rusqlite::Result<()> {
    let games = table_columns(conn, "games")?;
    // Nothing to carry over: either a database this version created, or one
    // already migrated whose user_version didn't stick.
    if !games.contains("raw_json") {
        return Ok(());
    }

    if !games.contains("raw_gz") {
        conn.execute_batch("ALTER TABLE games ADD COLUMN raw_gz BLOB")?;
    }

    // Pass one moves the payloads across as-is. The stored text is compressed
    // rather than reserialized, so a backup taken after this migration is byte
    // for byte the backup that would have been taken before it.
    let mut page = conn.prepare(
        "
    SELECT game_id, raw_json
    FROM games
    WHERE raw_json IS NOT NULL AND raw_gz IS NULL AND game_id > ?
    ORDER BY game_id
    LIMIT ?
  ",
    )?;
    let mut compress = conn.prepare("UPDATE games SET raw_gz = ? WHERE game_id = ?")?;

    let mut last_id = 0i64;
    loop {
        let rows = page
            .query_map(params![last_id, PAYLOAD_PAGE_SIZE], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Cell>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let Some((last, _)) = rows.last() else {
            break;
        };
        last_id = *last;

        let tx = conn.unchecked_transaction()?;
        for (game_id, raw_json) in &rows {
            let bytes = match raw_json {
                Cell::Text(s) => s.as_bytes(),
                Cell::Blob(b) => b,
                // zlib.gzipSync throws on anything but a string or a buffer
                _ => {
                    return Err(rusqlite::Error::InvalidColumnType(
                        1,
                        "raw_json".into(),
                        rusqlite::types::Type::Real,
                    ));
                }
            };
            compress.execute(params![gzip(bytes), game_id])?;
        }
        tx.commit()?;
    }

    // Pass two derives the rows every query now reads.
    let result = rebuild_participants_from_payloads(conn)?;

    // Nothing below this line is reversible, so confirm the rows are actually
    // on disk first: every game holding a payload should have participants,
    // bar the ones this pass already reported it couldn't read.
    let stranded: i64 = conn.query_row(
        "
      SELECT COUNT(*) AS count
      FROM games g
      WHERE g.raw_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM match_participants mp WHERE mp.game_id = g.game_id)
    ",
        [],
        |row| row.get(0),
    )?;

    if stranded > result.unusable as i64 {
        eprintln!(
            "Skipping raw_json drop: {stranded} games have no participant rows (expected at most {})",
            result.unusable
        );
        return Ok(());
    }

    conn.execute_batch("ALTER TABLE games DROP COLUMN raw_json")?;
    // The dropped column's pages are free but still in the file, which for a
    // typical library is most of it, so reclaim them now.
    conn.execute_batch("VACUUM")?;
    let unreadable = if result.unusable > 0 {
        format!(" ({} payloads unreadable)", result.unusable)
    } else {
        String::new()
    };
    println!(
        "Normalized {} games into match_participants{unreadable}",
        result.normalized
    );
    Ok(())
}

/// Adds the summoner spell columns and fills them from the stored payloads.
fn migrate_to_v3(conn: &Connection) -> rusqlite::Result<()> {
    for table in ["match_participants", "player_stats"] {
        let cols = table_columns(conn, table)?;
        if !cols.contains("spell1") {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN spell1 INTEGER"))?;
        }
        if !cols.contains("spell2") {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN spell2 INTEGER"))?;
        }
    }
    // Re-deriving the participant rows wholesale is how spells reach
    // match_participants; the copy below then narrows them to the game's owner.
    rebuild_participants_from_payloads(conn)?;
    backfill_player_stats_spells(conn)
}

/// Adds the unclamped score column. Bumping the score formula version
/// alongside it makes the score backfill rescore every game, which fills it.
fn migrate_to_v4(conn: &Connection) -> rusqlite::Result<()> {
    if !table_columns(conn, "player_stats")?.contains("score_raw") {
        conn.execute_batch("ALTER TABLE player_stats ADD COLUMN score_raw REAL")?;
    }
    Ok(())
}

/// Copies each game owner's spells from their participant row onto
/// `player_stats`. The owner is the game's puuid first, then the stored stats
/// line for old imports whose owner puuid was never recovered.
fn backfill_player_stats_spells(conn: &Connection) -> rusqlite::Result<()> {
    type Line = [Cell; 4];
    let line = |row: &rusqlite::Row<'_>, from: usize| -> rusqlite::Result<Line> {
        Ok([
            row.get(from)?,
            row.get(from + 1)?,
            row.get(from + 2)?,
            row.get(from + 3)?,
        ])
    };
    let games = conn
        .prepare(
            "
      SELECT g.game_id, g.puuid, ps.champion_id, ps.kills, ps.deaths, ps.assists
      FROM games g
      JOIN player_stats ps ON g.game_id = ps.game_id
    ",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Cell>(1)?, line(row, 2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut participants: HashMap<i64, Vec<(Cell, Line, Cell, Cell)>> = HashMap::new();
    let mut stmt = conn.prepare(
        "
        SELECT game_id, puuid, champion_id, kills, deaths, assists, spell1, spell2
        FROM match_participants
      ",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        participants.entry(row.get(0)?).or_default().push((
            row.get(1)?,
            line(row, 2)?,
            row.get(6)?,
            row.get(7)?,
        ));
    }

    let mut update =
        conn.prepare("UPDATE player_stats SET spell1 = ?, spell2 = ? WHERE game_id = ?")?;
    let tx = conn.unchecked_transaction()?;
    for (game_id, puuid, stats) in &games {
        let rows = participants
            .get(game_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let by_puuid = truthy(puuid)
            .then(|| rows.iter().find(|p| js::cells_eq(&p.0, puuid)))
            .flatten();
        let owner = by_puuid.or_else(|| {
            rows.iter()
                .find(|p| p.1.iter().zip(stats).all(|(a, b)| js::cells_eq(a, b)))
        });
        if let Some((_, _, spell1, spell2)) = owner {
            update.execute(params![spell1.to_sql(), spell2.to_sql(), game_id])?;
        }
    }
    tx.commit()
}

fn truthy(cell: &Cell) -> bool {
    match cell {
        Cell::Null => false,
        Cell::Number(n) => *n != 0.0 && !n.is_nan(),
        Cell::Text(s) => !s.is_empty(),
        Cell::Blob(_) => true,
    }
}

/// Retroactively detects remakes for games stored before the flag existed.
fn backfill_remakes(conn: &Connection) -> rusqlite::Result<()> {
    let games = conn
        .prepare("SELECT game_id, game_duration, raw_json FROM games")?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Cell>(1)?,
                row.get::<_, Cell>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut update = conn.prepare("UPDATE games SET is_remake = 1 WHERE game_id = ?")?;
    let tx = conn.unchecked_transaction()?;
    for (game_id, duration, raw_json) in &games {
        // Runs inside migrateToV1, before the blobs have been normalized, so
        // the participant rows have to come from the payload itself.
        let rows = if truthy(raw_json) {
            parse_json(raw_json)
                .and_then(|raw| participant_rows_from_raw(Some(&raw)).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let duration = match duration {
            Cell::Number(n) => *n,
            _ => f64::NAN,
        };
        if detect_remake(duration, rows.iter().map(|r| r.early_surrender)) {
            update.execute([game_id])?;
        }
    }
    tx.commit()
}

/// Recovers each game's owner by matching stored `player_stats` against the
/// `raw_json` participants, for databases from before multi-account support.
fn backfill_game_puuids(conn: &Connection, now_ms: i64) -> rusqlite::Result<()> {
    let games = conn
        .prepare(
            "
      SELECT g.game_id, g.raw_json,
             ps.champion_id, ps.kills, ps.deaths, ps.assists
      FROM games g
      JOIN player_stats ps ON g.game_id = ps.game_id
      WHERE g.puuid = '' AND g.raw_json IS NOT NULL
    ",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Cell>(1)?,
                [
                    row.get::<_, Cell>(2)?,
                    row.get::<_, Cell>(3)?,
                    row.get::<_, Cell>(4)?,
                    row.get::<_, Cell>(5)?,
                ],
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut update = conn.prepare("UPDATE games SET puuid = ? WHERE game_id = ?")?;
    let mut upsert = conn.prepare(
        "
    INSERT OR IGNORE INTO summoner (puuid, game_name, tag_line, summoner_id, account_id, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?)
  ",
    )?;

    let tx = conn.unchecked_transaction()?;
    for (game_id, raw_json, [champion_id, kills, deaths, assists]) in &games {
        // Each game sits in its own try in the JavaScript, so a game that
        // throws partway keeps what it wrote and the loop moves on
        let _ = (|| -> Result<(), Box<dyn std::error::Error>> {
            let raw = parse_json(raw_json).ok_or("unparseable")?;
            let raw = Some(&raw);
            let empty = Value::Array(Vec::new());
            let participants = js::or(&[js::prop(raw, "participants")?, Some(&empty)]);
            let identities = js::or(&[js::prop(raw, "participantIdentities")?, Some(&empty)]);
            let Some(Value::Array(participants)) = participants else {
                return Ok(());
            };
            for (i, p) in participants.iter().enumerate() {
                let p = Some(p);
                let identity = js::index(identities, i);
                let s = js::or(&[js::prop(p, "stats")?, p]);
                let zero = Value::from(0);
                let champion = js::nullish(&[
                    js::prop(p, "championId")?,
                    js::prop(s, "championId")?,
                    Some(&zero),
                ]);
                let stat = |key: &str| -> Result<Option<&Value>, js::TypeError> {
                    Ok(js::nullish(&[js::prop(s, key)?, Some(&zero)]))
                };
                if champion_id.strict_eq(champion)
                    && kills.strict_eq(stat("kills")?)
                    && deaths.strict_eq(stat("deaths")?)
                    && assists.strict_eq(stat("assists")?)
                {
                    let player = js::opt_prop(identity, "player");
                    let puuid = js::or(&[js::prop(p, "puuid")?, js::opt_prop(player, "puuid")]);
                    if js::truthy(puuid) {
                        update.execute(params![js::bind(puuid)?, game_id])?;
                        let game_name = js::or(&[
                            js::opt_prop(player, "gameName"),
                            js::opt_prop(player, "summonerName"),
                            js::prop(p, "summonerName")?,
                            js::prop(p, "riotIdGameName")?,
                            None,
                        ]);
                        let tag_line = js::or(&[
                            js::opt_prop(player, "tagLine"),
                            js::prop(p, "riotIdTagline")?,
                            None,
                        ]);
                        upsert.execute(params![
                            js::bind(puuid)?,
                            js::bind(game_name)?,
                            js::bind(tag_line)?,
                            now_ms
                        ])?;
                    }
                    break;
                }
            }
            Ok(())
        })();
    }
    tx.commit()
}

fn backfill_game_versions(conn: &Connection) -> rusqlite::Result<()> {
    let games = conn
        .prepare("SELECT game_id, raw_json FROM games WHERE raw_json IS NOT NULL")?
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Cell>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut update = conn.prepare("UPDATE games SET game_version = ? WHERE game_id = ?")?;
    let tx = conn.unchecked_transaction()?;
    for (game_id, raw_json) in &games {
        let Some(raw) = parse_json(raw_json) else {
            continue;
        };
        // raw.gameVersion throws on a payload that parsed to null
        let Ok(version) = js::prop(Some(&raw), "gameVersion") else {
            continue;
        };
        if let Some(patch) = parse_patch(version) {
            update.execute(params![patch, game_id])?;
        }
    }
    tx.commit()
}

/// `backfillAugmentSlots`: `game_augments` holds our own picks and
/// `match_participant_augments` everyone's. Once a game is normalized the
/// former is the latter narrowed to the game's owner, so widening our stored
/// slots is a copy, not a re-parse.
pub fn backfill_augment_slots(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
    INSERT OR IGNORE INTO game_augments (game_id, slot, augment_id)
    SELECT a.game_id, a.slot, a.augment_id
    FROM match_participant_augments a
    JOIN games g ON g.game_id = a.game_id
    JOIN match_participants p
      ON p.game_id = a.game_id AND p.participant_id = a.participant_id
    WHERE g.puuid != '' AND p.puuid = g.puuid
  ",
    )
}
