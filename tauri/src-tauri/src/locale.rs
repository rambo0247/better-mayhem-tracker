//! `src/main/locale.ts`: the regional format dates and numbers follow, which
//! a page cannot read for itself. It reaches the page as `window.api.locale`
//! through the boot script, and text Rust writes for the page, like recap
//! milestones, formats with it too.
//!
//! Read the way Electron's `app.getSystemLocale()` reads it, not with
//! `sys-locale`, which returns the display language: `[NSLocale
//! currentLocale]` on macOS (language plus region, `fr-FI`), the regional
//! format on Windows (`fi-FI`). Electron's documentation gives both examples.

/// The system locale as `Intl.getCanonicalLocales` would canonicalize it, or
/// `None` when it is not a well-formed tag, so callers keep their default.
pub fn system_locale() -> Option<String> {
    canonical(&raw_locale()?)
}

#[cfg(target_os = "macos")]
fn raw_locale() -> Option<String> {
    use objc2_core_foundation::CFLocale;
    // Electron swaps `_` for `-` in the identifier before handing it on
    Some(
        CFLocale::current()?
            .identifier()?
            .to_string()
            .replace('_', "-"),
    )
}

#[cfg(windows)]
fn raw_locale() -> Option<String> {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    const LOCALE_NAME_MAX_LENGTH: usize = 85;
    let mut buf = [0u16; LOCALE_NAME_MAX_LENGTH];
    // SAFETY: the buffer holds the length it is passed
    let len = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 1 {
        return None;
    }
    let name = String::from_utf16_lossy(&buf[..len as usize - 1]);
    // An alternate sort order rides after `_` (`de-DE_phoneb`); the format is the part before it
    Some(name.split('_').next().unwrap_or_default().to_owned())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn raw_locale() -> Option<String> {
    let value = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))?;
    let name = value.split(['.', '@']).next()?.replace('_', "-");
    (name != "C" && name != "POSIX").then_some(name)
}

/// `Intl.getCanonicalLocales(tag)[0]`, for the tags an OS reports: casing per
/// subtag, extensions ordered by singleton, `None` where Intl would throw.
/// Tag aliases (`iw` to `he`) are left as they are.
pub fn canonical(tag: &str) -> Option<String> {
    let subtags: Vec<&str> = tag.split('-').collect();
    let is_alpha = |s: &str, lo: usize, hi: usize| {
        (lo..=hi).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphabetic())
    };
    let is_alnum = |s: &str, lo: usize, hi: usize| {
        (lo..=hi).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
    };
    let mut rest = subtags.iter().copied().peekable();

    let language = rest.next()?;
    if !(is_alpha(language, 2, 3) || is_alpha(language, 5, 8)) {
        return None;
    }
    let mut out = vec![language.to_ascii_lowercase()];
    if let Some(script) = rest.next_if(|s| is_alpha(s, 4, 4)) {
        out.push(format!(
            "{}{}",
            script[..1].to_ascii_uppercase(),
            script[1..].to_ascii_lowercase()
        ));
    }
    if let Some(region) = rest
        .next_if(|s| is_alpha(s, 2, 2) || (s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit())))
    {
        out.push(region.to_ascii_uppercase());
    }
    let mut variants = Vec::new();
    while let Some(variant) = rest.next_if(|s| {
        is_alnum(s, 5, 8) || (s.len() == 4 && s.as_bytes()[0].is_ascii_digit() && is_alnum(s, 4, 4))
    }) {
        let variant = variant.to_ascii_lowercase();
        if variants.contains(&variant) {
            return None;
        }
        variants.push(variant);
    }
    out.extend(variants);

    let mut extensions: Vec<(char, Vec<String>)> = Vec::new();
    let mut private = None;
    while let Some(singleton) = rest.next() {
        if singleton.len() != 1 || !singleton.as_bytes()[0].is_ascii_alphanumeric() {
            return None;
        }
        let key = singleton.as_bytes()[0].to_ascii_lowercase() as char;
        let (lo, hi) = if key == 'x' { (1, 8) } else { (2, 8) };
        let mut parts = Vec::new();
        while let Some(part) = rest.next_if(|s| is_alnum(s, lo, hi) && (key == 'x' || s.len() > 1))
        {
            parts.push(part.to_ascii_lowercase());
        }
        if parts.is_empty() || extensions.iter().any(|(k, _)| *k == key) {
            return None;
        }
        if key == 'x' {
            private = Some(parts);
            if rest.peek().is_some() {
                return None;
            }
        } else {
            extensions.push((key, parts));
        }
    }
    extensions.sort_by_key(|(key, _)| *key);
    for (key, parts) in extensions {
        out.push(key.to_string());
        out.extend(parts);
    }
    if let Some(parts) = private {
        out.push("x".into());
        out.extend(parts);
    }
    Some(out.join("-"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each pair is what `Intl.getCanonicalLocales` gives in Node 24, `None`
    /// where it throws a RangeError.
    #[test]
    fn canonicalizes_as_intl_does() {
        let cases: &[(&str, Option<&str>)] = &[
            ("en-US", Some("en-US")),
            ("EN-us", Some("en-US")),
            ("fr-FI", Some("fr-FI")),
            ("zh-hans-cn", Some("zh-Hans-CN")),
            ("es-419", Some("es-419")),
            ("sr-Latn-RS", Some("sr-Latn-RS")),
            ("de-DE-1996", Some("de-DE-1996")),
            ("ca-ES-valencia", Some("ca-ES-valencia")),
            ("de-DE-u-co-phonebk", Some("de-DE-u-co-phonebk")),
            ("en-US-x-test", Some("en-US-x-test")),
            ("en-US@rg=gbzzzz", None),
            ("en_US", None),
            ("de-DE-1996-1996", None),
            ("", None),
            ("e", None),
            ("en-u", None),
            ("de-DE-x-a-u-co", Some("de-DE-x-a-u-co")),
            ("en-u-ca-gregory-t-de", Some("en-t-de-u-ca-gregory")),
            ("en-US-t-de-u-co-x", None),
        ];
        for (tag, want) in cases {
            assert_eq!(canonical(tag).as_deref(), *want, "{tag}");
        }
    }

    #[test]
    fn reads_a_locale_this_machine_reports() {
        // Whatever the machine says, it comes back well formed or not at all
        if let Some(locale) = system_locale() {
            assert_eq!(canonical(&locale).as_deref(), Some(locale.as_str()));
        }
    }
}
