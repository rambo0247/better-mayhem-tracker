// The week data `firstDayOfWeek` in src/shared/session.ts reads from ICU,
// collected in whatever V8 evaluates `collectWeekData`: Electron's main
// process for db/week.rs, or Node to compare. `firstDayOfWeek(tag)` is
// `weekStart(resolve(tag))`, where a tag resolves to itself when ICU has
// it and to a shorter tag otherwise.
function collectWeekData() {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const scripts = [
    "Adlm", "Arab", "Beng", "Cyrl", "Deva", "Guru", "Hans", "Hant", "Hebr",
    "Latn", "Mtei", "Olck", "Shaw", "Tfng", "Vaii",
  ];
  const resolve = (tag) => {
    try {
      return new Intl.DateTimeFormat(tag).resolvedOptions().locale;
    } catch {
      return null;
    }
  };
  const firstDay = (tag) => {
    try {
      const resolved = new Intl.DateTimeFormat(tag).resolvedOptions().locale;
      return new Intl.Locale(resolved).getWeekInfo().firstDay % 7;
    } catch {
      return 1;
    }
  };
  const regions = [];
  for (const a of upper) for (const b of upper) regions.push(a + b);
  regions.push("001", "150", "419");
  const candidates = [];
  for (const a of lower) for (const b of lower) {
    candidates.push(a + b);
    for (const c of lower) candidates.push(a + b + c);
  }
  const languages = candidates.filter((tag) => resolve(tag) === tag);
  const bases = [...languages];
  for (const lang of languages) {
    for (const script of scripts) {
      const tag = `${lang}-${script}`;
      if (resolve(tag) === tag) bases.push(tag);
    }
  }
  const withRegion = [];
  for (const base of bases) {
    for (const region of regions) {
      const tag = `${base}-${region}`;
      if (resolve(tag) === tag) withRegion.push(tag);
    }
  }
  const regionDays = {};
  for (const region of regions) {
    const day = new Intl.Locale(`und-${region}`).getWeekInfo().firstDay % 7;
    if (day !== 1) regionDays[region] = day;
  }
  const baseDays = {};
  for (const base of bases) {
    const day = firstDay(base);
    if (day !== 1) baseDays[base] = day;
  }
  const defaultLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
  // Spot checks the Rust port is compared against, tags an OS reports
  const probes = {};
  for (const tag of [
    "en-US", "en-GB", "en-DE", "en-SE", "de-DE", "fr-FR", "fr-FI", "fr-US", "fr-CA", "pt-BR",
    "pt-PT", "es-US", "es-MX", "fa-IR", "ar-EG", "ar-SA", "he-IL", "ja-JP", "ko-KR", "zh-CN",
    "zh-TW", "zh-Hans-CN", "zh-Hant-TW", "zh-Hant-HK", "sr-Latn-RS", "en", "zh", "dv-MV",
    "en-MV", "xx-US", "en-UK", "en-150", "en-001", "es-419", "en-US-u-fw-mon",
    "de-DE-u-ca-gregory", "nb-NO", "no-NO", "fil-PH", "yue-HK", "uz-Arab-AF",
  ]) {
    probes[tag] = firstDay(tag);
  }
  return {
    defaultLocale,
    defaultDay: firstDay(undefined),
    regionDays,
    baseDays,
    bases,
    withRegion,
    probes,
  };
}

if (typeof module !== "undefined") module.exports = { collectWeekData };
