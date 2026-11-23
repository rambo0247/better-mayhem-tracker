//! `src/shared/text.ts`, and the integer half of `Number.prototype
//! .toLocaleString`, for the text the recap writes in the main process.
//!
//! Without ICU this knows how the common locales group digits, from CLDR:
//! the separator, whether a four-digit number is grouped at all, and
//! India's 2-digit groups. Any other locale groups as en-US does.

/// How a locale groups the digits of an integer.
struct Grouping {
    separator: &'static str,
    /// CLDR `minimumGroupingDigits`: 2 leaves `1000` ungrouped.
    min_digits: usize,
    indian: bool,
}

const fn grouping(separator: &'static str, min_digits: usize) -> Grouping {
    Grouping {
        separator,
        min_digits,
        indian: false,
    }
}

fn grouping_for(locale: Option<&str>) -> Grouping {
    let tag = locale.unwrap_or("en-US");
    let mut parts = tag.split('-');
    let language = parts.next().unwrap_or_default().to_ascii_lowercase();
    let region = parts
        .find(|p| p.len() == 2 || p.len() == 3 && p.bytes().all(|b| b.is_ascii_digit()))
        .map(str::to_ascii_uppercase);
    match (language.as_str(), region.as_deref()) {
        ("de", Some("CH" | "LI")) => grouping("\u{2019}", 1),
        ("de", Some("AT")) => grouping("\u{a0}", 1),
        ("pt", Some("PT")) => grouping("\u{a0}", 2),
        ("en" | "hi", Some("IN")) | ("hi", None) => Grouping {
            separator: ",",
            min_digits: 1,
            indian: true,
        },
        ("es" | "pl", _) => grouping(if language == "es" { "." } else { "\u{a0}" }, 2),
        (
            "de" | "it" | "nl" | "pt" | "da" | "id" | "tr" | "el" | "ro" | "hr" | "sl" | "sr"
            | "vi",
            _,
        ) => grouping(".", 1),
        ("fr", _) => grouping("\u{202f}", 1),
        (
            "fi" | "sv" | "nb" | "no" | "nn" | "cs" | "sk" | "ru" | "uk" | "hu" | "bg" | "lt"
            | "lv" | "et",
            _,
        ) => grouping("\u{a0}", 1),
        _ => grouping(",", 1),
    }
}

/// `n.toLocaleString(locale)` for an integer.
pub fn group_digits(n: i64, locale: Option<&str>) -> String {
    let g = grouping_for(locale);
    let digits = n.unsigned_abs().to_string();
    let sign = if n < 0 { "-" } else { "" };
    if digits.len() < 4 + g.min_digits - 1 {
        return format!("{sign}{digits}");
    }
    let mut groups: Vec<&str> = Vec::new();
    let mut end = digits.len();
    let mut size = 3;
    while end > size {
        groups.push(&digits[end - size..end]);
        end -= size;
        if g.indian {
            size = 2;
        }
    }
    groups.push(&digits[..end]);
    groups.reverse();
    format!("{sign}{}", groups.join(g.separator))
}

/// `ordinal`: "1st", "2nd", "3rd", "4th", teens included, with the number
/// grouped the way `locale` writes it.
pub fn ordinal(n: i64, locale: Option<&str>) -> String {
    let digits = group_digits(n, locale);
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{digits}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinals_follow_english_with_the_teens_apart() {
        let got: Vec<String> = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 111, 1000]
            .iter()
            .map(|n| ordinal(*n, Some("en-US")))
            .collect();
        assert_eq!(
            got,
            [
                "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd",
                "111th", "1,000th"
            ]
        );
    }

    #[test]
    fn digits_group_as_each_locale_writes_them() {
        assert_eq!(group_digits(1000, None), "1,000");
        assert_eq!(group_digits(1000, Some("pt-BR")), "1.000");
        assert_eq!(group_digits(1000, Some("es-ES")), "1000");
        assert_eq!(group_digits(12000, Some("es-ES")), "12.000");
        assert_eq!(group_digits(3000, Some("fr-FR")), "3\u{202f}000");
        assert_eq!(group_digits(1234567, Some("en-IN")), "12,34,567");
        assert_eq!(group_digits(999, Some("de-DE")), "999");
        assert_eq!(
            group_digits(1234567, Some("de-CH")),
            "1\u{2019}234\u{2019}567"
        );
    }
}
