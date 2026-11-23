//! `firstDayOfWeek` in `src/shared/session.ts`: the weekday a session week
//! opens on, numbered as `getDay()` numbers them (0 is Sunday). JavaScript
//! resolves the locale against the ICU data Electron ships, then asks the
//! resolved locale's region, or its likely region when it has none.
//! [`week_data`](super::week_data) holds that ICU data.

use super::week_data::{BASE_DAYS, BASES, DEFAULT_DAY, REGION_DAYS, WITH_REGION};

fn has(list: &[&str], tag: &str) -> bool {
    list.binary_search(&tag).is_ok()
}

fn day(table: &[(&str, u8)], key: &str) -> u8 {
    table
        .binary_search_by(|(k, _)| (*k).cmp(key))
        .map_or(1, |i| table[i].1)
}

/// `firstDayOfWeek(locale)`. A tag ICU has keeps its region; one it lacks
/// falls back to its language, and a language it lacks to the default
/// locale. A tag that isn't well formed is the `catch`, Monday.
pub fn first_day_of_week(locale: Option<&str>) -> u8 {
    let Some(locale) = locale else {
        return DEFAULT_DAY;
    };
    let mut subtags = locale.split('-');
    let Some(lang) = subtags
        .next()
        .filter(|l| (2..=3).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_lowercase()))
    else {
        return 1;
    };
    let mut rest = subtags.peekable();
    let script = rest
        .next_if(|s| s.len() == 4 && s.bytes().all(|b| b.is_ascii_alphabetic()))
        .map(|s| format!("{lang}-{s}"));
    let region = rest.next_if(|s| {
        (s.len() == 2 && s.bytes().all(|b| b.is_ascii_uppercase()))
            || (s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit()))
    });

    let base = script.as_deref().unwrap_or(lang);
    if let Some(region) = region
        && has(WITH_REGION, &format!("{base}-{region}"))
    {
        return day(REGION_DAYS, region);
    }
    for base in [script.as_deref(), Some(lang)].into_iter().flatten() {
        if has(BASES, base) {
            return day(BASE_DAYS, base);
        }
    }
    DEFAULT_DAY
}

#[cfg(test)]
mod tests {
    use super::super::week_data::PROBES;
    use super::*;

    #[test]
    fn tables_are_sorted_for_binary_search() {
        assert!(BASES.is_sorted());
        assert!(WITH_REGION.is_sorted());
        assert!(REGION_DAYS.is_sorted_by_key(|(k, _)| *k));
        assert!(BASE_DAYS.is_sorted_by_key(|(k, _)| *k));
    }

    #[test]
    fn weeks_open_where_electron_opens_them() {
        for &(tag, want) in PROBES {
            assert_eq!(first_day_of_week(Some(tag)), want, "{tag}");
        }
        assert_eq!(first_day_of_week(None), DEFAULT_DAY);
        assert_eq!(first_day_of_week(Some("not a tag")), 1);
    }
}
