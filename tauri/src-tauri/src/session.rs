//! The local-calendar arithmetic `src/shared/session.ts` does with `Date`,
//! for the recap and the season recap. Every function takes the time zone so
//! a query reads the system zone once.

use jiff::civil::DateTime;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

use crate::db::filters::DAY_START_HOUR;

fn local(ms: i64, tz: &TimeZone) -> DateTime {
    Timestamp::from_millisecond(ms)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned_datetime(tz.clone())
        .datetime()
}

/// A local wall time as `new Date(...)` resolves it: a time a clock change
/// skips moves later, a repeated one takes the earlier.
fn resolve(wall: DateTime, tz: &TimeZone) -> i64 {
    wall.to_zoned_datetime(tz.clone())
        .map_or(0, |z| z.timestamp().as_millisecond())
}

/// `sessionDay`: local midnight of the session day a game belongs to, where
/// a day runs from `DAY_START_HOUR` to `DAY_START_HOUR`.
pub fn session_day(ms: i64, tz: &TimeZone) -> i64 {
    let shifted = local(ms, tz)
        .checked_sub(i64::from(DAY_START_HOUR).hours())
        .unwrap_or_default();
    resolve(shifted.date().at(0, 0, 0, 0), tz)
}

/// `addDays`: the same wall time `count` calendar days on, which a multiple
/// of 24 hours isn't across a daylight saving change.
pub fn add_days(day: i64, count: i64, tz: &TimeZone) -> i64 {
    let wall = local(day, tz);
    resolve(wall.checked_add(count.days()).unwrap_or(wall), tz)
}

/// `new Date(ms).getHours()`.
pub fn local_hour(ms: i64, tz: &TimeZone) -> usize {
    local(ms, tz).hour() as usize
}

/// `new Date(ms).getDay()`, Sunday as 0.
pub fn local_weekday(ms: i64, tz: &TimeZone) -> usize {
    local(ms, tz).weekday().to_sunday_zero_offset() as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ny() -> TimeZone {
        TimeZone::get("America/New_York").unwrap()
    }

    fn at(text: &str) -> i64 {
        let wall: DateTime = text.parse().unwrap();
        resolve(wall, &ny())
    }

    #[test]
    fn a_game_before_five_belongs_to_the_night_before() {
        let tz = ny();
        assert_eq!(
            session_day(at("2026-11-22T04:59:00"), &tz),
            at("2026-11-21T00:00")
        );
        assert_eq!(
            session_day(at("2026-11-22T05:00:00"), &tz),
            at("2026-11-22T00:00")
        );
        // The golden's session for its newest game
        assert_eq!(session_day(1_795_393_899_248, &tz), 1_795_323_600_000);
    }

    #[test]
    fn days_step_by_the_calendar_across_a_clock_change() {
        let tz = ny();
        let before = at("2026-11-01T00:00");
        assert_eq!(add_days(at("2026-10-31T00:00"), 1, &tz), before);
        assert_eq!(add_days(before, 1, &tz) - before, 25 * 3_600_000);
        assert_eq!(local_weekday(before, &tz), 0);
        assert_eq!(local_hour(at("2026-11-01T23:30"), &tz), 23);
    }
}
