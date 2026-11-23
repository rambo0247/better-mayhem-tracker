//! The writer and the history lookup from `src/main/db/live.ts`: the map a
//! running game was rolled onto, and what this app has seen of the players in
//! a lobby. The recap's readers of `match_maps` are T16's, in `db/recap.rs`.

use std::collections::HashMap;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};

use super::filters::{Where, apply_queue_filter};
use super::summoner::{display_name, get_all_puuids};
use crate::commands::live::PlayerRecord;

/// `MIN_SHARED_GAMES` in `src/shared/api.ts`.
pub const MIN_SHARED_GAMES: f64 = 2.0;

/// `setGameMap`. The id is a JavaScript number, bound as better-sqlite3 binds
/// one.
pub fn set_game_map(
    conn: &Connection,
    game_id: f64,
    map_id: Option<f64>,
    map_skin: &str,
) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT OR REPLACE INTO match_maps (game_id, map_id, map_skin) VALUES (?, ?, ?)",
    )?
    .execute([
        Sql::Real(game_id),
        map_id.map_or(Sql::Null, Sql::Real),
        Sql::Text(map_skin.to_owned()),
    ])?;
    Ok(())
}

/// A player to look up, however much of their identity there is.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerRef {
    pub key: String,
    pub puuid: Option<String>,
    pub game_name: Option<String>,
    pub tag_line: Option<String>,
    pub champion_id: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlayerHistory {
    pub champion: Option<PlayerRecord>,
    pub overall: Option<PlayerRecord>,
    pub with_us: f64,
    pub friend_key: Option<String>,
}

/// A record as the JavaScript adds it up, in numbers.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Tally {
    games: f64,
    wins: f64,
    kills: f64,
    deaths: f64,
    assists: f64,
    last_played: f64,
}

impl Tally {
    fn record(self) -> PlayerRecord {
        PlayerRecord {
            games: self.games as i64,
            wins: self.wins as i64,
            kills: self.kills as i64,
            deaths: self.deaths as i64,
            assists: self.assists as i64,
            last_played: self.last_played as i64,
        }
    }
}

/// `playerNameKey`: lowercased, since the client and the game disagree about
/// a riot id's casing.
fn player_name_key(game_name: Option<&str>, tag_line: Option<&str>) -> Option<String> {
    let game_name = game_name.filter(|name| !name.is_empty())?;
    Some(format!("{game_name}#{}", tag_line.unwrap_or("")).to_lowercase())
}

fn name_key_sql(alias: &str) -> String {
    format!("lower({alias}.game_name) || '#' || lower(COALESCE({alias}.tag_line, ''))")
}

/// `[...new Set(values)]`: first occurrences, in order.
fn unique(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        if !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// `playerMatchClause`: rows of any of the players, by puuid where there is
/// one and by riot id otherwise.
fn player_match_clause(
    alias: &str,
    players: &[PlayerRef],
    params: &mut Vec<Sql>,
) -> Option<String> {
    let puuids = unique(
        players
            .iter()
            .filter_map(|p| p.puuid.clone().filter(|p| !p.is_empty())),
    );
    let names = unique(
        players
            .iter()
            .filter_map(|p| player_name_key(p.game_name.as_deref(), p.tag_line.as_deref())),
    );
    let marks = |n: usize| vec!["?"; n].join(", ");
    let mut clauses = Vec::new();
    if !puuids.is_empty() {
        clauses.push(format!("{alias}.puuid IN ({})", marks(puuids.len())));
        params.extend(puuids.into_iter().map(Sql::Text));
    }
    if !names.is_empty() {
        clauses.push(format!(
            "{} IN ({})",
            name_key_sql(alias),
            marks(names.len())
        ));
        params.extend(names.into_iter().map(Sql::Text));
    }
    (!clauses.is_empty()).then(|| format!("({})", clauses.join(" OR ")))
}

struct Owners<'a> {
    by_puuid: HashMap<&'a str, &'a PlayerRef>,
    by_name: HashMap<String, &'a PlayerRef>,
}

impl<'a> Owners<'a> {
    fn new(players: &'a [PlayerRef]) -> Self {
        let mut by_puuid = HashMap::new();
        let mut by_name = HashMap::new();
        for player in players {
            if let Some(puuid) = player.puuid.as_deref().filter(|p| !p.is_empty()) {
                by_puuid.insert(puuid, player);
            }
            if let Some(name) =
                player_name_key(player.game_name.as_deref(), player.tag_line.as_deref())
            {
                by_name.insert(name, player);
            }
        }
        Self { by_puuid, by_name }
    }

    fn of(
        &self,
        puuid: Option<&str>,
        game_name: Option<&str>,
        tag_line: Option<&str>,
    ) -> Option<&'a PlayerRef> {
        if let Some(puuid) = puuid.filter(|p| !p.is_empty())
            && let Some(owner) = self.by_puuid.get(puuid)
        {
            return Some(owner);
        }
        self.by_name
            .get(&player_name_key(game_name, tag_line)?)
            .copied()
    }
}

/// `0 + null` is 0 in JavaScript, which is what a `SUM` over nothing adds.
fn number(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<f64> {
    Ok(row.get::<_, Option<f64>>(index)?.unwrap_or(0.0))
}

/// `getPlayerHistories`, keyed by each player's own key.
pub fn get_player_histories(
    conn: &Connection,
    players: &[PlayerRef],
) -> rusqlite::Result<HashMap<String, PlayerHistory>> {
    let mut histories: HashMap<String, PlayerHistory> = HashMap::new();
    if players.is_empty() {
        return Ok(histories);
    }
    let mut params = Vec::new();
    let Some(matched) = player_match_clause("mp", players, &mut params) else {
        return Ok(histories);
    };
    let mut filters = Where {
        conditions: vec![matched, "mp.is_remake = 0".into()],
        params,
    };
    apply_queue_filter(conn, &mut filters, None, "mp")?;
    let sql = format!(
        "
      SELECT mp.puuid, mp.game_name, mp.tag_line, mp.champion_id,
             COUNT(*) AS games, SUM(mp.win) AS wins,
             SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths, SUM(mp.assists) AS assists,
             MAX(g.game_creation) AS last_played
      FROM match_participants mp
      JOIN games g ON g.game_id = mp.game_id
      WHERE {}
      GROUP BY mp.puuid, lower(mp.game_name), lower(COALESCE(mp.tag_line, '')), mp.champion_id
    ",
        filters.conditions.join(" AND ")
    );

    let owners = Owners::new(players);
    let mut tallies: HashMap<String, (Option<Tally>, Option<Tally>)> = HashMap::new();
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(filters.params))?;
    while let Some(row) = rows.next()? {
        let puuid: Option<String> = row.get(0)?;
        let game_name: Option<String> = row.get(1)?;
        let tag_line: Option<String> = row.get(2)?;
        let Some(owner) = owners.of(puuid.as_deref(), game_name.as_deref(), tag_line.as_deref())
        else {
            continue;
        };
        histories.entry(owner.key.clone()).or_default();
        let champion_id: Option<f64> = row.get(3)?;
        let add = Tally {
            games: number(row, 4)?,
            wins: number(row, 5)?,
            kills: number(row, 6)?,
            deaths: number(row, 7)?,
            assists: number(row, 8)?,
            last_played: number(row, 9)?,
        };
        let (overall, champion) = tallies.entry(owner.key.clone()).or_default();
        let on_champion = owner.champion_id != 0.0
            && !owner.champion_id.is_nan()
            && champion_id == Some(owner.champion_id);
        let overall = overall.get_or_insert_default();
        let mut targets = vec![overall];
        if on_champion {
            targets.push(champion.get_or_insert_default());
        }
        for target in targets {
            target.games += add.games;
            target.wins += add.wins;
            target.kills += add.kills;
            target.deaths += add.deaths;
            target.assists += add.assists;
            target.last_played = target.last_played.max(add.last_played);
        }
    }
    for (key, (overall, champion)) in tallies {
        let history = histories.entry(key).or_default();
        history.overall = overall.map(Tally::record);
        history.champion = champion.map(Tally::record);
    }

    // Games on our own side, which is what the Friends page counts
    let ours = get_all_puuids(conn)?;
    if ours.is_empty() {
        return Ok(histories);
    }
    let mut team_params = Vec::new();
    let Some(team_match) = player_match_clause("o", players, &mut team_params) else {
        return Ok(histories);
    };
    let our_list = vec!["?"; ours.len()].join(", ");
    team_params.extend(ours.iter().cloned().map(Sql::Text));
    let mut team_filters = Where {
        conditions: vec![
            team_match,
            "o.is_remake = 0".into(),
            format!("(o.puuid IS NULL OR o.puuid NOT IN ({our_list}))"),
        ],
        params: team_params,
    };
    apply_queue_filter(conn, &mut team_filters, None, "o")?;
    let team_sql = format!(
        "
          WITH our_teams AS (
            SELECT DISTINCT game_id, team_id FROM match_participants WHERE puuid IN ({our_list})
          )
          SELECT o.puuid, o.game_name, o.tag_line, COUNT(*) AS games
          FROM our_teams t
          JOIN match_participants o ON o.game_id = t.game_id AND o.team_id = t.team_id
          WHERE {}
          GROUP BY o.puuid, lower(o.game_name), lower(COALESCE(o.tag_line, ''))
        ",
        team_filters.conditions.join(" AND ")
    );
    let bound = ours.into_iter().map(Sql::Text).chain(team_filters.params);
    let mut statement = conn.prepare(&team_sql)?;
    let mut rows = statement.query(params_from_iter(bound))?;
    while let Some(row) = rows.next()? {
        let puuid: Option<String> = row.get(0)?;
        let game_name: Option<String> = row.get(1)?;
        let tag_line: Option<String> = row.get(2)?;
        let Some(owner) = owners.of(puuid.as_deref(), game_name.as_deref(), tag_line.as_deref())
        else {
            continue;
        };
        let history = histories.entry(owner.key.clone()).or_default();
        history.with_us += number(row, 3)?;
        // From the stored row, so it matches the key the Friends page routes on
        if history.with_us >= MIN_SHARED_GAMES {
            history.friend_key = puuid
                .filter(|p| !p.is_empty())
                .or_else(|| display_name(game_name.as_deref(), tag_line.as_deref()))
                .or(history.friend_key.take());
        }
    }
    Ok(histories)
}
