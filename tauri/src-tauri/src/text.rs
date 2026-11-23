//! `src/shared/text.ts`, for the text the recap writes in the main process.

use crate::intl::format_integer;

/// `ordinal`: "1st", "2nd", "3rd", "4th", teens included, with the number
/// grouped the way `locale` writes it.
pub fn ordinal(n: i64, locale: Option<&str>) -> String {
    let digits = format_integer(n, locale);
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
}
