//! `src/main/db/payloads.ts`: the gzipped `raw_gz` payloads, and the one
//! place a stored payload becomes `match_participants` rows.

use std::io::{Read, Write};

use flate2::read::MultiGzDecoder;
use flate2::{Compression, GzBuilder};
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{Connection, named_params, params};
use serde_json::Value;

use super::js::{self, TypeError, prop as get};

/// `AUGMENT_SLOTS` in `src/shared/queues.ts`.
pub const AUGMENT_SLOTS: usize = 6;

/// Payloads are read a page at a time wherever they're read in bulk: a library
/// of a few thousand is a hundred megabytes-plus of JSON.
pub const PAYLOAD_PAGE_SIZE: i64 = 200;

/// The OS byte zlib writes into a gzip header on this platform, which is
/// what Node's `zlib.gzipSync` leaves there.
const GZIP_OS: u8 = if cfg!(target_os = "macos") {
    19
} else if cfg!(windows) {
    10
} else {
    3
};

/// `zlib.gzipSync(text)` at Node's default level.
pub fn gzip(text: &[u8]) -> Vec<u8> {
    let mut encoder = GzBuilder::new()
        .operating_system(GZIP_OS)
        .write(Vec::new(), Compression::new(6));
    encoder
        .write_all(text)
        .and_then(|()| encoder.finish())
        .expect("gzip into memory cannot fail")
}

/// `packRaw`: `zlib.gzipSync(JSON.stringify(raw))`.
pub fn pack_raw(raw: &Value) -> Vec<u8> {
    gzip(js::stringify(raw).as_bytes())
}

/// `unpackRaw`: the payload, or `None` for no blob or one that will not
/// gunzip or parse.
pub fn unpack_raw(blob: Option<&[u8]>) -> Option<Value> {
    let mut bytes = Vec::new();
    MultiGzDecoder::new(blob?).read_to_end(&mut bytes).ok()?;
    serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()
}

/// One player in one game, unpicked from either of Riot's two shapes: the
/// LCU's `participants[i]` with `participantIdentities[i]`, and SGP's
/// flattened participant with its stats inline. Numbers are JavaScript
/// numbers, so they bind as better-sqlite3 binds them.
#[derive(Debug, Clone, PartialEq)]
pub struct RawParticipantRow {
    pub participant_id: f64,
    pub puuid: Option<String>,
    pub game_name: Option<String>,
    pub tag_line: Option<String>,
    pub profile_icon: Option<f64>,
    pub team_id: f64,
    pub champion_id: f64,
    pub win: f64,
    pub kills: f64,
    pub deaths: f64,
    pub assists: f64,
    pub double_kills: f64,
    pub triple_kills: f64,
    pub quadra_kills: f64,
    pub penta_kills: f64,
    pub total_damage_dealt: f64,
    pub total_damage_taken: f64,
    pub gold_earned: f64,
    pub total_heal: f64,
    pub largest_killing_spree: f64,
    pub early_surrender: f64,
    pub spell1: Option<f64>,
    pub spell2: Option<f64>,
    pub items: [Option<f64>; 7],
    pub augments: Vec<Augment>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Augment {
    pub slot: usize,
    pub augment_id: f64,
}

/// Bots and unresolved players carry an all-zeroes puuid. Dropping it here
/// means every read path can treat "has a puuid" as "a real player".
fn real_puuid(value: Option<&Value>) -> Option<String> {
    let s = js::string(value).filter(|s| !s.is_empty())?;
    // /^0+(-0+)*$/
    let all_zeroes = s
        .split('-')
        .all(|group| !group.is_empty() && group.bytes().all(|b| b == b'0'));
    (!all_zeroes).then(|| s.to_owned())
}

/// `x ?? default` for a field that should be a number. A field that holds
/// something else reads as the default.
fn num_or(v: Option<&Value>, default: f64) -> f64 {
    js::number(js::nullish(&[v])).unwrap_or(default)
}

/// `participantRowsFromRaw`. It throws where the JavaScript does: on a
/// participant that is `null`.
pub fn participant_rows_from_raw(raw: Option<&Value>) -> Result<Vec<RawParticipantRow>, TypeError> {
    let Some(Value::Array(participants)) = js::opt_prop(raw, "participants") else {
        return Ok(Vec::new());
    };
    let empty = Value::Array(Vec::new());
    let identities = js::or(&[js::opt_prop(raw, "participantIdentities"), Some(&empty)]);
    let no_player = Value::Object(Default::default());

    participants
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let p = Some(p);
            let s = js::or(&[js::prop(p, "stats")?, p]);
            let player = js::or(&[
                js::opt_prop(js::index(identities, i), "player"),
                Some(&no_player),
            ]);

            let mut augments = Vec::new();
            for slot in 1..=AUGMENT_SLOTS {
                let id = get(s, &format!("playerAugment{slot}"))?;
                if js::truthy(id)
                    && let Some(augment_id) = js::number(id).filter(|n| *n > 0.0)
                {
                    augments.push(Augment { slot, augment_id });
                }
            }
            let icon = js::number(get(player, "profileIcon")?).filter(|n| *n > 0.0);
            let text = |v: Option<&Value>| js::string(v).map(str::to_owned);
            let mut items = [None; 7];
            for (n, item) in items.iter_mut().enumerate() {
                *item = js::number(get(s, &format!("item{n}"))?);
            }

            Ok(RawParticipantRow {
                participant_id: js::number(js::nullish(&[get(p, "participantId")?]))
                    .unwrap_or((i + 1) as f64),
                puuid: real_puuid(get(p, "puuid")?).or(real_puuid(get(player, "puuid")?)),
                game_name: text(js::or(&[
                    get(player, "gameName")?,
                    get(player, "summonerName")?,
                    get(p, "summonerName")?,
                    get(p, "riotIdGameName")?,
                ])),
                tag_line: text(js::or(&[get(player, "tagLine")?, get(p, "riotIdTagline")?])),
                profile_icon: icon,
                team_id: js::number(js::nullish(&[get(p, "teamId")?, get(s, "teamId")?]))
                    .unwrap_or(100.0),
                champion_id: js::number(js::nullish(&[
                    get(p, "championId")?,
                    get(s, "championId")?,
                ]))
                .unwrap_or(0.0),
                win: if js::truthy(get(s, "win")?) { 1.0 } else { 0.0 },
                kills: num_or(get(s, "kills")?, 0.0),
                deaths: num_or(get(s, "deaths")?, 0.0),
                assists: num_or(get(s, "assists")?, 0.0),
                double_kills: num_or(get(s, "doubleKills")?, 0.0),
                triple_kills: num_or(get(s, "tripleKills")?, 0.0),
                quadra_kills: num_or(get(s, "quadraKills")?, 0.0),
                penta_kills: num_or(get(s, "pentaKills")?, 0.0),
                total_damage_dealt: js::number(js::nullish(&[
                    get(s, "totalDamageDealtToChampions")?,
                    get(s, "totalDamageDealt")?,
                ]))
                .unwrap_or(0.0),
                total_damage_taken: num_or(get(s, "totalDamageTaken")?, 0.0),
                gold_earned: num_or(get(s, "goldEarned")?, 0.0),
                total_heal: num_or(get(s, "totalHeal")?, 0.0),
                largest_killing_spree: num_or(get(s, "largestKillingSpree")?, 0.0),
                early_surrender: if js::truthy(get(s, "gameEndedInEarlySurrender")?) {
                    1.0
                } else {
                    0.0
                },
                spell1: js::number(js::nullish(&[get(p, "spell1Id")?, get(s, "spell1Id")?])),
                spell2: js::number(js::nullish(&[get(p, "spell2Id")?, get(s, "spell2Id")?])),
                items,
                augments,
            })
        })
        .collect()
}

/// The three game columns copied onto every participant row. `queue_id` is
/// whatever JavaScript would bind: a payload's number or string, or a stored
/// column read back.
#[derive(Debug, Clone, PartialEq)]
pub struct GameDenorm {
    pub is_remake: i64,
    pub queue_id: Sql,
    pub game_version: Option<String>,
}

const INSERT_PARTICIPANT: &str = "
        INSERT OR REPLACE INTO match_participants (
          game_id, participant_id, puuid, game_name, tag_line, profile_icon,
          team_id, champion_id, win, kills, deaths, assists,
          double_kills, triple_kills, quadra_kills, penta_kills,
          total_damage_dealt, total_damage_taken, gold_earned, total_heal,
          largest_killing_spree, early_surrender, is_remake, queue_id, game_version,
          spell1, spell2, item0, item1, item2, item3, item4, item5, item6
        ) VALUES (
          @game_id, @participant_id, @puuid, @game_name, @tag_line, @profile_icon,
          @team_id, @champion_id, @win, @kills, @deaths, @assists,
          @double_kills, @triple_kills, @quadra_kills, @penta_kills,
          @total_damage_dealt, @total_damage_taken, @gold_earned, @total_heal,
          @largest_killing_spree, @early_surrender, @is_remake, @queue_id, @game_version,
          @spell1, @spell2, @item0, @item1, @item2, @item3, @item4, @item5, @item6
        )
      ";

const INSERT_AUGMENT: &str = "
        INSERT OR REPLACE INTO match_participant_augments (
          game_id, participant_id, slot, augment_id,
          champion_id, win, is_remake, queue_id, game_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ";

/// `writeParticipants`: replaces one game's participant rows wholesale.
/// Callers are already inside a transaction, so a game and its participants
/// commit together or not at all.
pub fn write_participants(
    conn: &Connection,
    game_id: &Sql,
    meta: &GameDenorm,
    rows: &[RawParticipantRow],
) -> rusqlite::Result<()> {
    conn.prepare_cached("DELETE FROM match_participants WHERE game_id = ?")?
        .execute([game_id])?;
    conn.prepare_cached("DELETE FROM match_participant_augments WHERE game_id = ?")?
        .execute([game_id])?;
    let mut participant = conn.prepare_cached(INSERT_PARTICIPANT)?;
    let mut augment = conn.prepare_cached(INSERT_AUGMENT)?;

    for row in rows {
        let [item0, item1, item2, item3, item4, item5, item6] = row.items;
        participant.execute(named_params! {
            "@game_id": game_id,
            "@participant_id": row.participant_id,
            "@puuid": row.puuid,
            "@game_name": row.game_name,
            "@tag_line": row.tag_line,
            "@profile_icon": row.profile_icon,
            "@team_id": row.team_id,
            "@champion_id": row.champion_id,
            "@win": row.win,
            "@kills": row.kills,
            "@deaths": row.deaths,
            "@assists": row.assists,
            "@double_kills": row.double_kills,
            "@triple_kills": row.triple_kills,
            "@quadra_kills": row.quadra_kills,
            "@penta_kills": row.penta_kills,
            "@total_damage_dealt": row.total_damage_dealt,
            "@total_damage_taken": row.total_damage_taken,
            "@gold_earned": row.gold_earned,
            "@total_heal": row.total_heal,
            "@largest_killing_spree": row.largest_killing_spree,
            "@early_surrender": row.early_surrender,
            "@is_remake": meta.is_remake,
            "@queue_id": meta.queue_id,
            "@game_version": meta.game_version,
            "@spell1": row.spell1,
            "@spell2": row.spell2,
            "@item0": item0,
            "@item1": item1,
            "@item2": item2,
            "@item3": item3,
            "@item4": item4,
            "@item5": item5,
            "@item6": item6,
        })?;
        for aug in &row.augments {
            augment.execute(params![
                game_id,
                row.participant_id,
                aug.slot as i64,
                aug.augment_id,
                row.champion_id,
                row.win,
                meta.is_remake,
                meta.queue_id,
                meta.game_version,
            ])?;
        }
    }
    Ok(())
}

/// What a rebuild did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NormalizeResult {
    /// Games that produced at least one participant row.
    pub normalized: usize,
    /// Games whose payload wouldn't parse, or carried no participants.
    pub unusable: usize,
}

/// `rebuildParticipantsFromPayloads`: re-derives `match_participants` and
/// `match_participant_augments` for every game that still has its payload.
/// The v2 migration and Repair share it, so the two can't drift apart.
pub fn rebuild_participants_from_payloads(conn: &Connection) -> rusqlite::Result<NormalizeResult> {
    let mut page = conn.prepare(
        "
    SELECT game_id, is_remake, queue_id, game_version, raw_gz
    FROM games
    WHERE raw_gz IS NOT NULL AND game_id > ?
    ORDER BY game_id
    LIMIT ?
  ",
    )?;

    let mut last_id = 0i64;
    let mut result = NormalizeResult::default();
    loop {
        let rows = page
            .query_map(params![last_id, PAYLOAD_PAGE_SIZE], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    GameDenorm {
                        is_remake: row.get(1)?,
                        queue_id: row.get::<_, js::Cell>(2)?.to_sql(),
                        game_version: row.get(3)?,
                    },
                    // A blob, or text that gunzips the same way from its bytes
                    match row.get_ref(4)? {
                        ValueRef::Blob(b) | ValueRef::Text(b) => b.to_vec(),
                        _ => Vec::new(),
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let Some((last, _, _)) = rows.last() else {
            break;
        };
        last_id = *last;

        let tx = conn.unchecked_transaction()?;
        for (game_id, meta, blob) in &rows {
            let raw = unpack_raw(Some(blob));
            let participants = participant_rows_from_raw(raw.as_ref()).map_err(js::thrown)?;
            if participants.is_empty() {
                result.unusable += 1;
                continue;
            }
            write_participants(conn, &Sql::Integer(*game_id), meta, &participants)?;
            result.normalized += 1;
        }
        tx.commit()?;
    }
    Ok(result)
}

/// `parsePatch`: `"16.23.123.4567"` to `"16.23"`.
pub fn parse_patch(version: Option<&Value>) -> Option<String> {
    let version = js::string(version)?;
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let major = digits(version);
    let rest = version[major..].strip_prefix('.')?;
    let minor = digits(rest);
    (major > 0 && minor > 0).then(|| format!("{}.{}", &version[..major], &rest[..minor]))
}

/// `detectRemake`. An absent duration is `NaN`, which is never short.
pub fn detect_remake(game_duration: f64, early_surrender: impl IntoIterator<Item = f64>) -> bool {
    // Very short games are always remakes
    if game_duration < 300.0 {
        return true;
    }
    // An early surrender still inside the first ten minutes counts as one too
    if game_duration < 600.0 {
        return early_surrender.into_iter().any(|e| e == 1.0);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patches_parse_as_the_regex_does() {
        assert_eq!(
            parse_patch(Some(&json!("16.23.123.4567"))),
            Some("16.23".into())
        );
        assert_eq!(parse_patch(Some(&json!("16.2"))), Some("16.2".into()));
        assert_eq!(parse_patch(Some(&json!("16."))), None);
        assert_eq!(parse_patch(Some(&json!("v16.2"))), None);
        assert_eq!(parse_patch(Some(&json!(16.2))), None);
        assert_eq!(parse_patch(None), None);
    }

    #[test]
    fn remakes_are_short_games_or_early_surrenders() {
        assert!(detect_remake(299.0, []));
        assert!(detect_remake(500.0, [0.0, 1.0]));
        assert!(!detect_remake(500.0, [0.0]));
        assert!(!detect_remake(700.0, [1.0]));
        assert!(!detect_remake(f64::NAN, [1.0]));
    }

    #[test]
    fn zero_puuids_are_dropped() {
        assert_eq!(real_puuid(Some(&json!("0000-00-0"))), None);
        assert_eq!(real_puuid(Some(&json!("0"))), None);
        assert_eq!(real_puuid(Some(&json!("-0"))), Some("-0".into()));
        assert_eq!(real_puuid(Some(&json!("00a0"))), Some("00a0".into()));
        assert_eq!(real_puuid(Some(&json!(""))), None);
    }

    #[test]
    fn both_payload_shapes_unpick_to_the_same_row() {
        let lcu = json!({
            "participants": [{ "participantId": 3, "championId": 22, "teamId": 200,
                "spell1Id": 4, "stats": { "win": true, "kills": 5, "item0": 1001,
                "playerAugment2": 77, "playerAugment3": 0 } }],
            "participantIdentities": [{ "player": { "puuid": "abc", "gameName": "",
                "summonerName": "Old", "tagLine": "NA1", "profileIcon": 9 } }]
        });
        let sgp = json!({
            "participants": [{ "participantId": 3, "championId": 22, "teamId": 200,
                "spell1Id": 4, "win": true, "kills": 5, "item0": 1001,
                "playerAugment2": 77, "puuid": "abc", "riotIdGameName": "Old",
                "riotIdTagline": "NA1" }]
        });
        let a = participant_rows_from_raw(Some(&lcu)).unwrap();
        let b = participant_rows_from_raw(Some(&sgp)).unwrap();
        assert_eq!(a[0].game_name.as_deref(), Some("Old"));
        assert_eq!(
            a[0].augments,
            vec![Augment {
                slot: 2,
                augment_id: 77.0
            }]
        );
        assert_eq!(a[0].profile_icon, Some(9.0));
        assert_eq!(b[0].profile_icon, None);
        assert_eq!(
            RawParticipantRow {
                profile_icon: None,
                ..a[0].clone()
            },
            b[0]
        );
    }

    #[test]
    fn a_null_participant_throws() {
        let raw = json!({ "participants": [null] });
        assert!(participant_rows_from_raw(Some(&raw)).is_err());
        assert_eq!(participant_rows_from_raw(Some(&json!({}))), Ok(vec![]));
        assert_eq!(participant_rows_from_raw(None), Ok(vec![]));
    }

    #[test]
    fn payloads_round_trip() {
        let raw = json!({ "gameId": 7, "b": [1.5, "x"], "a": null });
        assert_eq!(unpack_raw(Some(&pack_raw(&raw))), Some(raw));
        assert_eq!(unpack_raw(Some(b"not gzip")), None);
        assert_eq!(unpack_raw(None), None);
    }
}
