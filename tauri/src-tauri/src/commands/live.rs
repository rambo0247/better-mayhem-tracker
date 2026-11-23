//! The live game snapshot and ARAM challenge progress. Ported by T21.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::types::ChallengeLevel;
use super::{CommandError, CommandResult, Ctx, Domain};

pub struct Hooks;
impl Domain for Hooks {
    /// Seeds the trackers for the T03 client state a `live:snapshot` or
    /// `challenges:get` state golden was recorded in, through T21's
    /// `live::golden::seed`. `BMT_T21_SCRIPTS` names `record-scenarios.ts`'s
    /// output and `BMT_GOLDEN_DIR` T05's goldens; without both nothing is
    /// seeded and those cases replay on idle trackers.
    #[cfg(feature = "parity-driver")]
    fn before_golden_case<R: Runtime>(app: &tauri::AppHandle<R>, case: &super::GoldenCase<'_>) {
        use std::sync::Arc;

        use tauri::Manager;

        use crate::live::{AppEnv, Tracking, TrackingEnv, golden};
        if !matches!(case.channel, "live:snapshot" | "challenges:get") {
            return;
        }
        let (Some(scripts), Some(goldens)) = (
            std::env::var_os("BMT_T21_SCRIPTS"),
            std::env::var_os("BMT_GOLDEN_DIR"),
        ) else {
            return;
        };
        let Some(state) = golden::states_of_cases(goldens.as_ref(), case.channel)
            .into_iter()
            .find_map(|(seeded, state)| (seeded == case.case).then_some(state))
        else {
            return;
        };
        let Some(tracking) = app.try_state::<Tracking>() else {
            return;
        };
        let env: Arc<dyn TrackingEnv> = Arc::new(AppEnv(app.clone()));
        let runtime = tauri::async_runtime::handle().inner().clone();
        let seeded = tauri::async_runtime::block_on(golden::seed(
            &tracking,
            env,
            runtime,
            &state,
            scripts.as_ref(),
        ));
        if let Err(err) = seeded {
            eprintln!("live golden seed for {} {}: {err}", case.channel, case.case);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRecord {
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub last_played: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LivePlayer {
    pub key: String,
    pub name: String,
    pub tag_line: Option<String>,
    pub puuid: Option<String>,
    pub champion_id: i64,
    pub champion_name: String,
    pub team_id: i64,
    pub is_self: bool,
    pub is_bot: bool,
    pub level: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub creep_score: f64,
    pub items: Vec<i64>,
    pub is_dead: bool,
    pub respawn_timer: i64,
    pub spell1_id: Option<i64>,
    pub spell2_id: Option<i64>,
    pub champion_record: Option<PlayerRecord>,
    pub overall_record: Option<PlayerRecord>,
    pub games_with_us: i64,
    pub friend_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum LiveEventTone {
    Kill,
    Objective,
    Special,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LiveEvent {
    pub id: i64,
    pub time: f64,
    pub text: String,
    pub tone: LiveEventTone,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LiveGameSnapshot {
    pub in_game: bool,
    pub starting: bool,
    pub game_id: Option<i64>,
    pub queue_id: Option<i64>,
    pub map_id: Option<i64>,
    pub map_name: Option<String>,
    pub map_skin: Option<String>,
    pub game_time: f64,
    pub players: Vec<LivePlayer>,
    pub events: Vec<LiveEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ChallengeReward {
    pub category: String,
    pub name: String,
    pub quantity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeProgress {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub level: ChallengeLevel,
    pub value: f64,
    pub current_threshold: f64,
    pub next_level: Option<ChallengeLevel>,
    pub next_threshold: Option<f64>,
    pub next_rewards: Vec<ChallengeReward>,
    pub percentile: f64,
    pub points_awarded: f64,
    pub icon_path: String,
    pub retired: bool,
    pub completed_champion_ids: Option<Vec<i64>>,
    pub delta: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ChallengeGroup {
    pub summary: ChallengeProgress,
    pub challenges: Vec<ChallengeProgress>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChallengePlayerSummary {
    pub level: ChallengeLevel,
    pub points: f64,
    pub points_until_next_rank: f64,
    pub percentile: f64,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChallengesData {
    pub player: ChallengePlayerSummary,
    pub capstone: Option<ChallengeProgress>,
    pub groups: Vec<ChallengeGroup>,
    pub seasonal: Vec<ChallengeProgress>,
    pub equipped: Vec<ChallengeProgress>,
    pub fetched_at: i64,
    pub since: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ChallengesResult {
    pub data: Option<ChallengesData>,
    pub pending: bool,
}

/// `getLiveGame`: a fresh snapshot while the client is up, the last one
/// otherwise.
pub async fn get_live_game<R: Runtime>(ctx: Ctx<R>) -> CommandResult<LiveGameSnapshot> {
    use tauri::Manager;
    let live = ctx.app.state::<crate::live::Tracking>().live();
    let connected = ctx
        .app
        .state::<crate::lcu::sync::LcuSync>()
        .lcu
        .is_client_connected();
    Ok(if connected {
        live.refresh().await
    } else {
        live.latest()
    })
}

/// `getChallenges`: the stored snapshot straight away, never waiting on the
/// client.
pub async fn get_challenges<R: Runtime>(ctx: Ctx<R>) -> CommandResult<ChallengesResult> {
    use tauri::Manager;
    let challenges = ctx.app.state::<crate::live::Tracking>().challenges();
    challenges.get_challenges()
}
