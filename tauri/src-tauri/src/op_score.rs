//! `src/shared/opScore.ts`, the half the main process calls: each player's
//! score, raw total, and badge. The renderer keeps the TypeScript, breakdown
//! included, so only the totals are ported.
//!
//! Every value is an `f64` and every step runs in the TypeScript's order, so
//! a stored score equals Electron's to the bit. `powf` is the platform's
//! `pow`, which on macOS returns what V8's `**` does.

use std::collections::HashMap;

/// Bump when anything stored on `player_stats` changes, the score or the
/// badge, so startup recomputes them.
pub const SCORE_FORMULA_VERSION: u32 = 4;

/// championId to Data Dragon class tag. Champions missing from the map score
/// with the default weights.
pub type ChampionClassMap = HashMap<i64, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreBadge {
    Mvp,
    Ace,
}

impl ScoreBadge {
    pub fn as_str(self) -> &'static str {
        match self {
            ScoreBadge::Mvp => "MVP",
            ScoreBadge::Ace => "ACE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlayerScore {
    pub score: f64,
    /// Unclamped, unrounded total, stored as an ordering key.
    pub raw: f64,
    pub badge: Option<ScoreBadge>,
}

/// One player's line, as JavaScript numbers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoreInput {
    pub participant_id: f64,
    pub team_id: f64,
    pub champion_id: f64,
    pub kills: f64,
    pub deaths: f64,
    pub assists: f64,
    pub double_kills: f64,
    pub triple_kills: f64,
    pub quadra_kills: f64,
    pub penta_kills: f64,
    pub total_damage_dealt_to_champions: f64,
    pub total_damage_taken: f64,
    pub gold_earned: f64,
    pub total_heal: f64,
    pub win: bool,
}

const CURVE: f64 = 1.3;
const SCALE: f64 = 1.04;
const CARRY_KNEE: f64 = 1.2;
const CARRY_SPAN: f64 = 0.5;
const CARRY_MAX: f64 = 0.6;
const WIN_BONUS: f64 = 0.6;

struct ClassWeights {
    kda: f64,
    kp: f64,
    dmg: f64,
    taken: f64,
    heal: f64,
    gold: f64,
}

const DEFAULT_WEIGHTS: ClassWeights = ClassWeights {
    kda: 2.2,
    kp: 2.2,
    dmg: 2.6,
    taken: 1.1,
    heal: 0.6,
    gold: 1.1,
};

fn class_weights(cls: &str) -> Option<&'static ClassWeights> {
    const fn w(kda: f64, kp: f64, dmg: f64, taken: f64, heal: f64, gold: f64) -> ClassWeights {
        ClassWeights {
            kda,
            kp,
            dmg,
            taken,
            heal,
            gold,
        }
    }
    static ASSASSIN: ClassWeights = w(2.6, 2.4, 2.8, 0.5, 0.2, 1.3);
    static MARKSMAN: ClassWeights = w(2.2, 2.2, 2.8, 0.7, 0.5, 1.4);
    static MAGE: ClassWeights = w(2.2, 2.3, 2.8, 0.7, 0.4, 1.4);
    static FIGHTER: ClassWeights = w(2.2, 2.2, 2.4, 1.4, 0.5, 1.1);
    static TANK: ClassWeights = w(2.0, 2.5, 2.1, 2.2, 0.3, 0.7);
    static SUPPORT: ClassWeights = w(2.2, 2.7, 1.7, 0.8, 1.8, 0.6);
    match cls {
        "Assassin" => Some(&ASSASSIN),
        "Marksman" => Some(&MARKSMAN),
        "Mage" => Some(&MAGE),
        "Fighter" => Some(&FIGHTER),
        "Tank" => Some(&TANK),
        "Support" => Some(&SUPPORT),
        _ => None,
    }
}

/// `Math.max(a, b)`: `NaN` wins, and `+0` beats `-0`.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: `NaN` wins, and `-0` beats `+0`.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.round`: half rounds up, toward positive infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// SameValueZero, the key equality of a JavaScript `Map`.
fn same_key(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

fn clamp01(v: f64) -> f64 {
    js_max(0.0, js_min(1.0, v))
}

/// `classes?.[championId]`: a property key is the number's string, so only
/// a whole id can name an entry.
fn class_of(classes: Option<&ChampionClassMap>, champion_id: f64) -> Option<&str> {
    let id = champion_id as i64;
    if id as f64 != champion_id {
        return None;
    }
    classes?.get(&id).map(String::as_str)
}

struct LobbyMax {
    dmg: f64,
    taken: f64,
    heal: f64,
    gold: f64,
}

/// `buildBreakdown`, down to the total. Returns `(raw, score)`.
fn score_one(
    p: &ScoreInput,
    team_kills: f64,
    max: &LobbyMax,
    runner_up_dmg: f64,
    classes: Option<&ChampionClassMap>,
) -> (f64, f64) {
    let kda = (p.kills + p.assists) / js_max(p.deaths, 1.0);
    let kp = if team_kills > 0.0 {
        (p.kills + p.assists) / team_kills
    } else {
        0.0
    };

    let w = class_of(classes, p.champion_id)
        .filter(|cls| !cls.is_empty())
        .and_then(class_weights)
        .unwrap_or(&DEFAULT_WEIGHTS);

    // Summed unscaled and scaled once at the end, as the TypeScript does
    let mut sum = 0.0;
    let mut component = |value: f64, reference: f64, weight: f64| {
        let ratio = clamp01(value / reference);
        sum += weight * ratio.powf(CURVE);
    };
    component(kda, 8.0, w.kda);
    component(kp, 0.9, w.kp);
    component(p.total_damage_dealt_to_champions, max.dmg, w.dmg);
    component(p.total_damage_taken, max.taken, w.taken);
    component(p.total_heal, max.heal, w.heal);
    component(p.gold_earned, max.gold, w.gold);

    // Only the best multikill of the game counts
    let multikill = [
        (p.penta_kills, 0.6),
        (p.quadra_kills, 0.45),
        (p.triple_kills, 0.3),
        (p.double_kills, 0.15),
    ]
    .into_iter()
    .find(|(count, _)| *count > 0.0);

    let mut carry_points = 0.0;
    if p.total_damage_dealt_to_champions >= max.dmg && runner_up_dmg > 0.0 {
        let lead = p.total_damage_dealt_to_champions / runner_up_dmg;
        carry_points = clamp01((lead - CARRY_KNEE) / CARRY_SPAN) * CARRY_MAX;
    }

    if let Some((_, points)) = multikill {
        sum += points;
    }
    sum += carry_points;
    if p.win {
        sum += WIN_BONUS;
    }

    let raw = sum * SCALE;
    let score = js_min(10.0, js_max(1.0, js_round(raw * 10.0) / 10.0));
    (raw, score)
}

/// The scores `computeMatchScores` returns: a `Map` keyed by participantId,
/// in insertion order. A repeated id keeps its first slot and its last
/// value, as `Map.set` does.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatchScores(Vec<(f64, PlayerScore)>);

impl MatchScores {
    pub fn get(&self, participant_id: f64) -> Option<&PlayerScore> {
        self.slot(participant_id).map(|i| &self.0[i].1)
    }

    pub fn iter(&self) -> impl Iterator<Item = (f64, &PlayerScore)> {
        self.0.iter().map(|(id, score)| (*id, score))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn slot(&self, participant_id: f64) -> Option<usize> {
        self.0
            .iter()
            .position(|(id, _)| same_key(*id, participant_id))
    }

    fn set(&mut self, participant_id: f64, score: PlayerScore) {
        match self.slot(participant_id) {
            Some(i) => self.0[i].1 = score,
            None => self.0.push((participant_id, score)),
        }
    }
}

/// `computeMatchScores`: every player graded against the lobby, plus MVP for
/// the best on the winning team and ACE for the best on the losing one.
pub fn compute_match_scores(
    participants: &[ScoreInput],
    classes: Option<&ChampionClassMap>,
) -> MatchScores {
    let mut scores = MatchScores::default();
    if participants.is_empty() {
        return scores;
    }

    let mut max = LobbyMax {
        dmg: 1.0,
        taken: 1.0,
        heal: 1.0,
        gold: 1.0,
    };
    let mut top_dmg = 0.0;
    let mut runner_up_dmg = 0.0;
    let mut team_kills: Vec<(f64, f64)> = Vec::new();
    for p in participants {
        let dmg = p.total_damage_dealt_to_champions;
        if dmg > top_dmg {
            runner_up_dmg = top_dmg;
            top_dmg = dmg;
        } else if dmg > runner_up_dmg {
            runner_up_dmg = dmg;
        }
        max.dmg = js_max(max.dmg, p.total_damage_dealt_to_champions);
        max.taken = js_max(max.taken, p.total_damage_taken);
        max.heal = js_max(max.heal, p.total_heal);
        max.gold = js_max(max.gold, p.gold_earned);
        match team_kills.iter_mut().find(|(t, _)| same_key(*t, p.team_id)) {
            Some((_, kills)) => *kills += p.kills,
            None => team_kills.push((p.team_id, 0.0 + p.kills)),
        }
    }

    for p in participants {
        let kills = team_kills
            .iter()
            .find(|(t, _)| same_key(*t, p.team_id))
            .map_or(0.0, |(_, k)| *k);
        let (raw, score) = score_one(p, kills, &max, runner_up_dmg, classes);
        scores.set(
            p.participant_id,
            PlayerScore {
                score,
                raw,
                badge: None,
            },
        );
    }

    // Ranked on `raw`, not `score`, so near-ties at 10 go to who played better
    let raw_of = |scores: &MatchScores, p: &ScoreInput| {
        scores.get(p.participant_id).map_or(f64::NAN, |s| s.raw)
    };
    let mut best_by_team: Vec<(f64, &ScoreInput)> = Vec::new();
    for p in participants {
        match best_by_team
            .iter_mut()
            .find(|(t, _)| same_key(*t, p.team_id))
        {
            Some((_, best)) => {
                if raw_of(&scores, p) > raw_of(&scores, best) {
                    *best = p;
                }
            }
            None => best_by_team.push((p.team_id, p)),
        }
    }
    for (_, p) in best_by_team {
        let badge = if p.win {
            ScoreBadge::Mvp
        } else {
            ScoreBadge::Ace
        };
        if let Some(i) = scores.slot(p.participant_id) {
            scores.0[i].1.badge = Some(badge);
        }
    }

    scores
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player(id: f64, team: f64, win: bool) -> ScoreInput {
        ScoreInput {
            participant_id: id,
            team_id: team,
            champion_id: 1.0,
            kills: 5.0,
            deaths: 5.0,
            assists: 10.0,
            double_kills: 0.0,
            triple_kills: 0.0,
            quadra_kills: 0.0,
            penta_kills: 0.0,
            total_damage_dealt_to_champions: 20000.0,
            total_damage_taken: 20000.0,
            gold_earned: 10000.0,
            total_heal: 5000.0,
            win,
        }
    }

    #[test]
    fn math_round_rounds_half_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert!(js_round(-0.2).is_sign_negative());
        assert_eq!(js_round(4503599627370497.0), 4503599627370497.0);
    }

    #[test]
    fn math_max_and_min_follow_javascript() {
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert!(js_min(1.0, f64::NAN).is_nan());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(0.0, -0.0).is_sign_negative());
    }

    #[test]
    fn the_best_on_each_team_takes_the_badge() {
        let mut lobby: Vec<ScoreInput> = (1..=10)
            .map(|i| player(f64::from(i), if i <= 5 { 100.0 } else { 200.0 }, i <= 5))
            .collect();
        lobby[2].kills = 15.0;
        lobby[7].penta_kills = 1.0;
        let scores = compute_match_scores(&lobby, None);
        assert_eq!(scores.len(), 10);
        let badges: Vec<_> = scores.iter().map(|(_, s)| s.badge).collect();
        assert_eq!(badges[2], Some(ScoreBadge::Mvp));
        assert_eq!(badges[7], Some(ScoreBadge::Ace));
        assert_eq!(badges.iter().flatten().count(), 2);
    }

    #[test]
    fn a_tie_keeps_the_badge_on_the_first_listed() {
        let lobby = [player(1.0, 100.0, true), player(2.0, 100.0, true)];
        let scores = compute_match_scores(&lobby, None);
        assert_eq!(scores.get(1.0).unwrap().badge, Some(ScoreBadge::Mvp));
        assert_eq!(scores.get(2.0).unwrap().badge, None);
    }

    #[test]
    fn class_weights_apply_only_to_known_classes() {
        let lobby = [player(1.0, 100.0, true), player(2.0, 200.0, false)];
        let tank: ChampionClassMap = [(1, "Tank".to_owned())].into();
        let unknown: ChampionClassMap = [(1, "Wizard".to_owned())].into();
        let default = compute_match_scores(&lobby, None).get(1.0).unwrap().raw;
        assert_ne!(
            compute_match_scores(&lobby, Some(&tank))
                .get(1.0)
                .unwrap()
                .raw,
            default
        );
        assert_eq!(
            compute_match_scores(&lobby, Some(&unknown))
                .get(1.0)
                .unwrap()
                .raw,
            default
        );
    }

    #[test]
    fn a_repeated_id_keeps_its_slot_and_takes_the_later_score() {
        let mut second = player(1.0, 200.0, false);
        second.kills = 0.0;
        let scores = compute_match_scores(&[player(1.0, 100.0, true), second], None);
        assert_eq!(scores.len(), 1);
        let only = compute_match_scores(&[player(9.0, 100.0, true), second], None);
        assert_eq!(scores.get(1.0).unwrap().raw, only.get(1.0).unwrap().raw);
    }
}
