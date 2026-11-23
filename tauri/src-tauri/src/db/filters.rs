//! `src/main/db/filters.ts`, with the Mayhem sets from
//! `src/shared/seasons.ts` its season window reads.

use jiff::ToSpan;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use rusqlite::Connection;
use rusqlite::types::Value as Sql;

use super::js::{self, Cell};
use super::settings::get_setting;

/// `QUEUE_ID_MAYHEM_CLASSIC` in `src/shared/queues.ts`.
pub const QUEUE_ID_MAYHEM_CLASSIC: i64 = 2450;

/// `DAY_START_HOUR` in `src/shared/session.ts`: a game at 1am belongs to the
/// night before.
pub const DAY_START_HOUR: i8 = 5;

/// One Mayhem set, with local calendar dates, both inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Season {
    pub id: &'static str,
    pub name: &'static str,
    pub start: &'static str,
    /// `None` until Riot announces when the pass closes.
    pub end: Option<&'static str>,
}

/// `SEASONS`. The dates are Riot's announcements rather than anything the
/// client reports, and they don't follow patches.
pub const SEASONS: [Season; 4] = [
    Season {
        id: "set-0",
        name: "Set 0",
        start: "2025-10-22",
        end: Some("2026-02-03"),
    },
    Season {
        id: "set-1",
        name: "Set 1",
        start: "2026-02-04",
        end: Some("2026-04-29"),
    },
    Season {
        id: "set-2",
        name: "Set 2",
        start: "2026-06-10",
        end: Some("2026-10-20"),
    },
    Season {
        id: "set-3",
        name: "Set 3",
        start: "2026-10-21",
        end: None,
    },
];

pub fn find_season(id: &str) -> Option<&'static Season> {
    SEASONS.iter().find(|s| s.id == id)
}

/// `new Date(year, month - 1, day + offset, DAY_START_HOUR).getTime()`: the
/// local instant a session day begins. A time a clock change skips resolves
/// as JavaScript resolves it, later, and a repeated one to the earlier.
fn day_start(date: &str, offset_days: i64) -> Option<i64> {
    let date: Date = date.parse().ok()?;
    let day = date.checked_add(offset_days.days()).ok()?;
    let zoned = day
        .at(DAY_START_HOUR, 0, 0, 0)
        .to_zoned_datetime(TimeZone::system())
        .ok()?;
    Some(zoned.timestamp().as_millisecond())
}

/// The `game_creation` span a set covers: from the start of its first day up
/// to, but not including, the start of the day after its last.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SeasonWindow {
    pub from: Option<i64>,
    pub to: Option<i64>,
}

pub fn season_bounds(season: &Season) -> SeasonWindow {
    SeasonWindow {
        from: day_start(season.start, 0),
        to: season.end.and_then(|end| day_start(end, 1)),
    }
}

/// `seasonWindow`: empty for no set, or one this build doesn't know.
pub fn season_window(season: Option<&str>) -> SeasonWindow {
    season
        .and_then(find_season)
        .map(season_bounds)
        .unwrap_or_default()
}

/// Queues switched off on the Settings page. An absent key means the setting
/// was never written; an empty one means everything is switched on.
fn hidden_queues(conn: &Connection) -> rusqlite::Result<Vec<f64>> {
    // `if (!raw) return []`, then `raw.split(",")`, which only a string has
    let raw = match get_setting(conn, "hidden_queues")? {
        Cell::Text(raw) => raw,
        Cell::Null => return Ok(Vec::new()),
        Cell::Number(0.0) => return Ok(Vec::new()),
        Cell::Number(_) | Cell::Blob(_) => {
            return Err(js::thrown(js::TypeError(
                "raw.split is not a function".into(),
            )));
        }
    };
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    Ok(raw
        .split(',')
        .map(js::string_to_number)
        .filter(|n| n.is_finite())
        .collect())
}

/// Every queue with games stored, ignoring which ones are hidden: the
/// Settings page needs the full list to offer a hidden queue's switch back.
pub fn get_stored_queues(conn: &Connection) -> rusqlite::Result<Vec<i64>> {
    conn.prepare_cached(
        "
      SELECT DISTINCT g.queue_id
      FROM games g
      JOIN player_stats ps ON g.game_id = ps.game_id
      ORDER BY g.queue_id
    ",
    )?
    .query_map([], |row| row.get(0))?
    .collect()
}

/// A query's `WHERE` conditions and their parameters, built up as the
/// filters apply.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Where {
    pub conditions: Vec<String>,
    pub params: Vec<Sql>,
}

/// `applyQueueFilter`. An explicit queue wins; otherwise the queues switched
/// off in Settings are left out everywhere.
pub fn apply_queue_filter(
    conn: &Connection,
    w: &mut Where,
    queue: Option<i64>,
    alias: &str,
) -> rusqlite::Result<()> {
    if let Some(queue) = queue {
        w.conditions.push(format!("{alias}.queue_id = ?"));
        w.params.push(Sql::Integer(queue));
        return Ok(());
    }
    let hidden = hidden_queues(conn)?;
    if !hidden.is_empty() {
        let marks = vec!["?"; hidden.len()].join(", ");
        w.conditions
            .push(format!("{alias}.queue_id NOT IN ({marks})"));
        w.params.extend(hidden.into_iter().map(Sql::Real));
    }
    Ok(())
}

/// `applySeasonFilter`: a set's window, the way [`apply_queue_filter`]
/// appends a queue.
pub fn apply_season_filter(w: &mut Where, season: Option<&str>, alias: &str) {
    let SeasonWindow { from, to } = season_window(season);
    if let Some(from) = from {
        w.conditions.push(format!("{alias}.game_creation >= ?"));
        w.params.push(Sql::Integer(from));
    }
    if let Some(to) = to {
        w.conditions.push(format!("{alias}.game_creation < ?"));
        w.params.push(Sql::Integer(to));
    }
}

/// `hideRemakes`: remakes are already left out of every stat; this setting
/// takes them out of the match list as well.
pub fn hide_remakes(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(get_setting(conn, "hide_remakes")?.as_str() == Some("true"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_lists_parse_as_number_does() {
        assert_eq!(js::string_to_number(" 2450 "), 2450.0);
        assert_eq!(js::string_to_number(""), 0.0);
        assert_eq!(js::string_to_number("0x10"), 16.0);
        assert_eq!(js::string_to_number("1e3"), 1000.0);
        assert!(js::string_to_number("abc").is_nan());
        // Node's Number(): Rust's parse reads the first as Infinity and the
        // old radix path read the second as 1
        assert!(js::string_to_number("inf").is_nan());
        assert!(js::string_to_number("0x+1").is_nan());
        assert!(js::string_to_number("-0x10").is_nan());
        assert_eq!(js::string_to_number("\u{feff}\u{a0}12\u{2028}"), 12.0);
        assert!(js::string_to_number("\u{85}12").is_nan());
        assert_eq!(js::string_to_number("-Infinity"), f64::NEG_INFINITY);
    }

    /// `getHiddenQueues` keeps only the finite ids `Number` reads.
    #[test]
    fn hidden_queues_drop_what_number_reads_as_nan() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        crate::db::settings::set_setting(&conn, "hidden_queues", "2450, 0x+1,inf,0x10,,Infinity")
            .unwrap();
        assert_eq!(hidden_queues(&conn).unwrap(), vec![2450.0, 16.0, 0.0]);
    }

    #[test]
    fn a_season_window_starts_at_five_local() {
        let set1 = find_season("set-1").unwrap();
        let window = season_bounds(set1);
        let from = jiff::Timestamp::from_millisecond(window.from.unwrap()).unwrap();
        let local = from.to_zoned_datetime(TimeZone::system());
        assert_eq!(
            (local.year(), local.month(), local.day(), local.hour()),
            (2026, 2, 4, 5)
        );
        let to = jiff::Timestamp::from_millisecond(window.to.unwrap())
            .unwrap()
            .to_zoned_datetime(TimeZone::system());
        assert_eq!((to.month(), to.day(), to.hour()), (4, 30, 5));
        assert_eq!(season_window(Some("set-3")).to, None);
        assert_eq!(season_window(Some("set-9")), SeasonWindow::default());
        assert_eq!(season_window(None), SeasonWindow::default());
    }
}
