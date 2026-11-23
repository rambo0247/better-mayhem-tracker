//! `firstDayOfWeek` in `src/shared/session.ts`: the weekday a session week
//! opens on, numbered as `getDay()` numbers them (0 is Sunday). JavaScript
//! resolves the locale against the ICU data Electron ships, then asks the
//! resolved locale's region, or its likely region when it has none.
//! [`week_data`](super::week_data) holds that ICU data.

use super::week_data::{
    BASE_DAYS, BASES, DEFAULT_DAY, LANGUAGE_ALIASES, REGION_ALIASES, REGION_DAYS, WITH_REGION,
};

fn has(list: &[&str], tag: &str) -> bool {
    list.binary_search(&tag).is_ok()
}

fn lookup<T: Copy>(table: &[(&str, T)], key: &str) -> Option<T> {
    table
        .binary_search_by(|(k, _)| (*k).cmp(key))
        .ok()
        .map(|i| table[i].1)
}

fn is_script(s: &str) -> bool {
    s.len() == 4 && s.bytes().all(|b| b.is_ascii_alphabetic())
}

fn is_region(s: &str) -> bool {
    (s.len() == 2 && s.bytes().all(|b| b.is_ascii_uppercase()))
        || (s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit()))
}

/// A tag's language, script, and region, with deprecated subtags replaced
/// as `Intl.getCanonicalLocales` replaces them. Variants and extensions
/// play no part in the week.
struct Tag<'a> {
    lang: &'a str,
    script: Option<&'a str>,
    region: Option<&'a str>,
}

impl<'a> Tag<'a> {
    fn parse(locale: &'a str) -> Option<Self> {
        let mut subtags = locale.split('-').peekable();
        let lang = subtags
            .next()
            .filter(|l| (2..=3).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_lowercase()))?;
        let mut tag = Tag {
            lang,
            script: subtags.next_if(|s| is_script(s)),
            region: subtags.next_if(|s| is_region(s)),
        };
        if let Some(alias) = lookup(LANGUAGE_ALIASES, lang) {
            let mut parts = alias.split('-').peekable();
            tag.lang = parts.next().unwrap_or(lang);
            tag.script = tag.script.or(parts.next_if(|s| is_script(s)));
            tag.region = tag.region.or(parts.next_if(|s| is_region(s)));
        }
        tag.region = tag.region.map(|r| lookup(REGION_ALIASES, r).unwrap_or(r));
        Some(tag)
    }
}

/// `firstDayOfWeek(locale)`. A tag ICU has keeps its region; one it lacks
/// falls back to its language, and a language it lacks to the default
/// locale. A tag that isn't well formed is the `catch`, Monday.
pub fn first_day_of_week(locale: Option<&str>) -> u8 {
    let Some(locale) = locale else {
        return DEFAULT_DAY;
    };
    let Some(Tag {
        lang,
        script,
        region,
    }) = Tag::parse(locale)
    else {
        return 1;
    };
    let with_script = script.map(|s| format!("{lang}-{s}"));
    let base = with_script.as_deref().unwrap_or(lang);
    if let Some(region) = region
        && has(WITH_REGION, &format!("{base}-{region}"))
    {
        return lookup(REGION_DAYS, region).unwrap_or(1);
    }
    for base in [with_script.as_deref(), Some(lang)].into_iter().flatten() {
        if has(BASES, base) {
            return lookup(BASE_DAYS, base).unwrap_or(1);
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
