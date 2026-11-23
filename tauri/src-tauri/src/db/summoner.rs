//! `src/main/db/summoner.ts`: the tracked accounts and whose name the
//! header shows.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::js;
use crate::commands::matches::Profile;

/// "Name#TAG" where we have both halves, the bare name where we don't.
pub fn display_name(game_name: Option<&str>, tag_line: Option<&str>) -> Option<String> {
    let game_name = game_name.filter(|s| !s.is_empty())?;
    Some(match tag_line.filter(|s| !s.is_empty()) {
        Some(tag) => format!("{game_name}#{tag}"),
        None => game_name.to_owned(),
    })
}

/// `upsertSummoner`, from the client's summoner object or an imported row.
/// REPLACE wipes the row, so the stored icon survives an update that doesn't
/// carry one (imported summoner rows predate the column).
pub fn upsert_summoner(conn: &Connection, summoner: &Value, now_ms: i64) -> rusqlite::Result<()> {
    let s = Some(summoner);
    let get = |key: &str| js::prop(s, key).map_err(js::thrown);
    let null = Value::Null;
    let mut stmt = conn.prepare_cached(
        "
    INSERT OR REPLACE INTO summoner (puuid, game_name, tag_line, summoner_id, account_id, updated_at, profile_icon)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT profile_icon FROM summoner WHERE puuid = ?)))
  ",
    )?;
    js::run(
        &mut stmt,
        &[
            get("puuid")?.into(),
            js::or(&[
                get("displayName")?,
                get("gameName")?,
                get("internalName")?,
                get("game_name")?,
            ])
            .into(),
            js::or(&[get("tagLine")?, get("tag_line")?, Some(&null)]).into(),
            js::nullish(&[get("summonerId")?, get("summoner_id")?]).into(),
            js::nullish(&[get("accountId")?, get("account_id")?]).into(),
            now_ms.into(),
            js::nullish(&[get("profileIconId")?, get("profile_icon")?, Some(&null)]).into(),
            get("puuid")?.into(),
        ],
    )?;
    Ok(())
}

/// One account's name and icon as that game recorded them. Covers databases
/// built purely from an import, where the client has never connected and
/// the summoner table has no icon.
pub fn identity_from_game(
    conn: &Connection,
    game_id: i64,
    puuid: &str,
) -> rusqlite::Result<Profile> {
    let row = conn
        .prepare_cached(
            "SELECT game_name, tag_line, profile_icon FROM match_participants WHERE game_id = ? AND puuid = ?",
        )?
        .query_row(params![game_id, puuid], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .optional()?;
    Ok(match row {
        Some((game_name, tag_line, icon)) => Profile {
            name: display_name(game_name.as_deref(), tag_line.as_deref()),
            profile_icon: icon,
        },
        None => Profile {
            name: None,
            profile_icon: None,
        },
    })
}

/// `getProfile`. The header names whichever account played most recently,
/// so its name and icon always come from the same place. Keying off the
/// summoner table's `updated_at` would name the account the client last
/// synced, which need not be the one that played.
pub fn get_profile(conn: &Connection) -> rusqlite::Result<Profile> {
    let latest: Option<(i64, String)> = conn
        .prepare_cached(
            "SELECT game_id, puuid FROM games WHERE puuid != '' ORDER BY game_creation DESC LIMIT 1",
        )?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;

    type Summoner = (Option<String>, Option<String>, Option<i64>);
    let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Summoner> {
        Ok((
            row.get("game_name")?,
            row.get("tag_line")?,
            row.get("profile_icon")?,
        ))
    };
    // No games yet: the client is the only thing that knows who we are
    let row = match &latest {
        Some((_, puuid)) => conn
            .prepare_cached("SELECT * FROM summoner WHERE puuid = ?")?
            .query_row([puuid], read)
            .optional()?,
        None => conn
            .prepare_cached("SELECT * FROM summoner ORDER BY updated_at DESC LIMIT 1")?
            .query_row([], read)
            .optional()?,
    };
    let (game_name, tag_line, icon) = row.unwrap_or((None, None, None));
    let name = display_name(game_name.as_deref(), tag_line.as_deref());
    if name.is_some() && icon.is_some() {
        return Ok(Profile {
            name,
            profile_icon: icon,
        });
    }

    // profile_icon only fills in once the client has synced this account,
    // and an imported game may have no summoner row at all: read both off
    // the game itself, still the same account.
    let fallback = match &latest {
        Some((game_id, puuid)) => identity_from_game(conn, *game_id, puuid)?,
        None => Profile {
            name: None,
            profile_icon: None,
        },
    };
    Ok(Profile {
        name: name.or(fallback.name),
        profile_icon: icon.or(fallback.profile_icon),
    })
}

pub fn get_all_puuids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached("SELECT puuid FROM summoner")?
        .query_map([], |row| row.get(0))?
        .collect()
}
