//! ICU4X standing in for the ICU that Electron's `Intl` and `localeCompare`
//! use. Every unit that sorts or formats text the way JavaScript does goes
//! through here, so the data version and the locale rule live in one place.
//!
//! Electron's main process uses its ICU default locale. Under Finder that is
//! en-US, and a terminal launch with `LANG=da_DK.UTF-8` makes it da-DK. A
//! locale argument of `None` here means the en-US default, which is ICU's
//! root order for collation and writes integers as en-US does.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use icu_decimal::input::Decimal;
use icu_decimal::options::DecimalFormatterOptions;
use icu_decimal::{DecimalFormatter, DecimalFormatterPreferences};
use icu_locale_core::Locale;

/// Electron's `systemLocale()`, the regional format the main process writes
/// recap text in. T09 ports it as `crate::locale::system_locale`, which is not
/// on this base yet.
pub fn system_locale() -> Option<String> {
    None
}

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

/// `n.toLocaleString(locale)` for an integer. `None` and any tag that does
/// not parse write it as en-US does.
pub fn format_integer(n: i64, locale: Option<&str>) -> String {
    let prefs = locale
        .and_then(|tag| tag.parse::<Locale>().ok())
        .map(|locale| DecimalFormatterPreferences::from(&locale))
        .unwrap_or_default();
    DecimalFormatter::try_new(prefs, DecimalFormatterOptions::default())
        .expect("decimal data for every locale is compiled in")
        .format(&Decimal::from(n))
        .to_string()
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

    #[test]
    fn integers_are_written_as_electron_writes_them() {
        let cases: [(i64, Option<&str>, &str); 12] = [
            (1000, None, "1,000"),
            (1000, Some("not a tag"), "1,000"),
            (1000, Some("pt-BR"), "1.000"),
            (1000, Some("es-ES"), "1000"),
            (1000, Some("es-MX"), "1,000"),
            (1000, Some("it-IT"), "1000"),
            (3000, Some("fr-FR"), "3\u{202f}000"),
            (1234567, Some("en-IN"), "12,34,567"),
            (1234567, Some("de-CH"), "1'234'567"),
            (-1000, Some("sv-SE"), "\u{2212}1\u{a0}000"),
            (
                1234567,
                Some("ar-EG"),
                "\u{661}\u{66c}\u{662}\u{663}\u{664}\u{66c}\u{665}\u{666}\u{667}",
            ),
            (
                -1000,
                Some("ar-EG"),
                "\u{61c}-\u{661}\u{66c}\u{660}\u{660}\u{660}",
            ),
        ];
        for (n, locale, want) in cases {
            assert_eq!(format_integer(n, locale), want, "{n} in {locale:?}");
        }
    }
}
