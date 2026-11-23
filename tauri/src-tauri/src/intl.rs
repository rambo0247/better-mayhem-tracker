//! ICU4X standing in for the ICU that Electron's `Intl` and `localeCompare`
//! use. Every unit that sorts or formats text the way JavaScript does goes
//! through here, so the data version and the locale rule live in one place.
//!
//! Electron's main process uses its ICU default locale. Under Finder that is
//! en-US, and a terminal launch with `LANG=da_DK.UTF-8` makes it da-DK. A
//! locale argument of `None` here means the en-US default, which is ICU's
//! root order for collation.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use icu_locale_core::Locale;

/// A collator for a BCP 47 tag, with `Intl.Collator`'s default options.
/// `None` and any tag that does not parse give the root collator.
pub fn collator(locale: Option<&str>) -> CollatorBorrowed<'static> {
    let prefs = locale
        .and_then(|tag| tag.parse::<Locale>().ok())
        .map(|locale| CollatorPreferences::from(&locale))
        .unwrap_or_default();
    Collator::try_new(prefs, CollatorOptions::default())
        .expect("collation data for every locale is compiled in")
}

/// `a.localeCompare(b)` with no locale argument, as Electron answers it for
/// an app started from Finder.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    static ROOT: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| collator(None));
    ROOT.compare(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_compare_matches_icu_root_order() {
        let cases: [(&str, &str, Ordering); 14] = [
            ("a", "A", Ordering::Less),
            ("aA", "Aa", Ordering::Less),
            ("a b", "a_b", Ordering::Less),
            ("a_b", "a-b", Ordering::Less),
            ("a-b", "aa", Ordering::Less),
            ("Z", "a", Ordering::Greater),
            ("9", "a", Ordering::Less),
            ("$", "0", Ordering::Less),
            ("Ab", "ab", Ordering::Greater),
            ("ab", "abc", Ordering::Less),
            ("José", "Josh", Ordering::Less),
            ("Jose", "José", Ordering::Less),
            ("e\u{301}", "\u{e9}", Ordering::Equal),
            ("z", "\u{1f600}", Ordering::Greater),
        ];
        for (a, b, want) in cases {
            assert_eq!(locale_compare(a, b), want, "{a:?} against {b:?}");
        }
        // Pairs recorded from Electron's `localeCompare` as `a<TAB>b<TAB>-1|0|1`
        // lines, when a file is given
        let Some(file) = std::env::var_os("BMT_COLLATION_CASES") else {
            return;
        };
        for line in std::fs::read_to_string(file).unwrap().lines() {
            let mut cols = line.split('\t');
            let (a, b, want) = (
                cols.next().unwrap(),
                cols.next().unwrap(),
                cols.next().unwrap().parse::<i32>().unwrap(),
            );
            assert_eq!(locale_compare(a, b) as i32, want, "{a:?} against {b:?}");
        }
    }

    #[test]
    fn a_locale_tailors_the_order() {
        assert_eq!(
            collator(Some("da-DK")).compare("aa", "b"),
            Ordering::Greater
        );
        assert_eq!(collator(Some("en-US")).compare("aa", "b"), Ordering::Less);
        assert_eq!(
            collator(Some("not a tag")).compare("aa", "b"),
            Ordering::Less
        );
    }
}
