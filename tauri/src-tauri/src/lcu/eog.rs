//! The post-game capture in `src/main/lcu.ts`: `handleFrame`'s end-of-game
//! paths, `startCapture`, and `captureEogGame` with its retries. The match
//! list the poll reads is cached by the client for a whole session, so a game
//! that just ended is fetched by id the moment the client says so.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::task::JoinHandle;

use super::log;
use super::sync::{
    Client, GameSync, SUMMONER_PATH, Thrown, bound, game_exists, is_mayhem, is_mayhem_number,
    js_number, mark_ignored_game, template,
};
use crate::db::js;

/// The by-id endpoint can still miss for a moment while the match is written,
/// so a failure is retried on this widening schedule, each delay counted from
/// the failure before it. Past the last, the poll is the safety net.
pub const EOG_RETRY_DELAYS: [Duration; 6] = [
    Duration::from_millis(2_000),
    Duration::from_millis(5_000),
    Duration::from_millis(15_000),
    Duration::from_millis(60_000),
    Duration::from_millis(120_000),
    Duration::from_millis(120_000),
];

/// Compared without a leading slash, since not every resource publishes one.
const EOG_STATS_PATHS: [&str; 2] = [
    "lol-end-of-game/v1/eog-stats-block",
    "lol-end-of-game/v1/gameclient-eog-stats-block",
];
const GAMEFLOW_PHASE_PATH: &str = "lol-gameflow/v1/gameflow-phase";

enum Pending {
    /// An attempt is running now
    Running,
    /// A retry is waiting for its delay
    Scheduled(JoinHandle<()>),
}

#[derive(Default)]
struct EogState {
    /// Set on quit, after which nothing more is scheduled
    stopped: bool,
    /// `eogPending`, by the game id's bits. The resource updates more than once
    /// while the screen is open, and each update must not start its own chain.
    games: HashMap<u64, Pending>,
}

#[derive(Default)]
pub struct Eog(Mutex<EogState>);

impl Eog {
    fn state(&self) -> std::sync::MutexGuard<'_, EogState> {
        self.0.lock().expect("capture state lock")
    }

    fn is_pending(&self, game_id: f64) -> bool {
        self.state().games.contains_key(&key(game_id))
    }

    fn set_running(&self, game_id: f64) {
        self.state().games.insert(key(game_id), Pending::Running);
    }

    fn done(&self, game_id: f64) {
        self.state().games.remove(&key(game_id));
    }

    /// `stopEogListener`'s share: every scheduled retry is dropped. An attempt
    /// already running finishes, and schedules nothing after it.
    pub fn stop(&self) {
        let mut state = self.state();
        state.stopped = true;
        for (_, pending) in state.games.drain() {
            if let Pending::Scheduled(retry) = pending {
                retry.abort();
            }
        }
    }

    /// Back to accepting captures, for a transport started again after a stop.
    pub fn resume(&self) {
        self.state().stopped = false;
    }
}

fn key(game_id: f64) -> u64 {
    // A Set treats -0 and 0 as one value
    (game_id + 0.0).to_bits()
}

impl GameSync {
    /// The post-game half of `handleFrame`. The transport has already read
    /// the gameflow session and applied the phase, as Electron does first.
    pub fn on_frame(self: &Arc<Self>, client: Arc<dyn Client>, event: &Value) {
        if let Err(err) = self.handle_frame(client, event) {
            log(format!("Post-game capture failed: {err}"));
        }
    }

    fn handle_frame(
        self: &Arc<Self>,
        client: Arc<dyn Client>,
        event: &Value,
    ) -> Result<(), Thrown> {
        let raw = match js::opt_prop(Some(event), "uri") {
            None | Some(Value::Null) => String::new(),
            uri => template(uri),
        };
        let path = raw.strip_prefix('/').unwrap_or(&raw);
        let data = js::opt_prop(Some(event), "data");

        if path == GAMEFLOW_PHASE_PATH {
            if data.and_then(Value::as_str) == Some("EndOfGame")
                && let Some(live) = client.live_game_ref()
            {
                self.start_capture(client, live.game_id, live.queue_id)?;
            }
            return Ok(());
        }

        if EOG_STATS_PATHS.contains(&path) {
            // The resource is also cleared once the screen is dismissed
            let deleted =
                js::opt_prop(Some(event), "eventType").and_then(Value::as_str) == Some("Delete");
            if deleted || !js::truthy(data) {
                return Ok(());
            }
            let game_id = js_number(js::prop(data, "gameId")?);
            let queue_id = js_number(js::prop(data, "queueId")?);
            self.start_capture(client, game_id, queue_id)?;
        }
        Ok(())
    }

    fn start_capture(
        self: &Arc<Self>,
        client: Arc<dyn Client>,
        game_id: f64,
        queue_id: f64,
    ) -> Result<(), Thrown> {
        if !game_id.is_finite() || game_id <= 0.0 {
            return Ok(());
        }
        if self.eog.is_pending(game_id) || self.db(|conn| game_exists(conn, &bound(game_id)))? {
            return Ok(());
        }
        // The queue rides along when the source has one, so a game the app
        // doesn't track is dismissed without a request
        if queue_id.is_finite() && queue_id > 0.0 && !is_mayhem_number(queue_id) {
            return self.db(|conn| mark_ignored_game(conn, &bound(game_id)));
        }
        self.capture(client, game_id, 0);
        Ok(())
    }

    /// `captureEogGame`. The check that the game is not stored yet runs at
    /// once; the requests run on their own task.
    fn capture(self: &Arc<Self>, client: Arc<dyn Client>, game_id: f64, attempt: usize) {
        self.eog.set_running(game_id);
        // A retry can be minutes out, by which time the poll may have the game
        match self.db(|conn| game_exists(conn, &bound(game_id))) {
            Ok(true) => {
                self.eog.done(game_id);
                return;
            }
            Ok(false) => {}
            // Electron's rejection goes unhandled and leaves the game pending
            Err(err) => {
                log(format!("Post-game capture failed: {err}"));
                return;
            }
        }
        let sync = self.clone();
        self.runtime.spawn(async move {
            match sync.fetch_and_store(client.as_ref(), game_id).await {
                Ok(()) => sync.eog.done(game_id),
                Err(err) => sync.retry(client, game_id, attempt, err),
            }
        });
    }

    async fn fetch_and_store(&self, client: &dyn Client, game_id: f64) -> Result<(), Thrown> {
        // Keeps the stored identity current the way the poll does: the
        // capture may be the first thing to run after an account switch
        let summoner = client.request_json(SUMMONER_PATH).await?;
        self.upsert_summoner(&summoner)?;
        let path = format!(
            "/lol-match-history/v1/games/{}",
            js::number_to_string(game_id)
        );
        let game = client.request_json(&path).await?;
        if !is_mayhem(js::prop(Some(&game), "queueId")?) {
            return self.db(|conn| mark_ignored_game(conn, &bound(game_id)));
        }
        let puuid = js::prop(Some(&summoner), "puuid")?;
        if self.insert_game(&game, puuid)? {
            log(format!(
                "Stored ARAM Mayhem game {} from the post-game screen",
                js::number_to_string(game_id)
            ));
            self.env.games_updated();
        }
        Ok(())
    }

    fn retry(self: &Arc<Self>, client: Arc<dyn Client>, game_id: f64, attempt: usize, err: Thrown) {
        let Some(&delay) = EOG_RETRY_DELAYS.get(attempt) else {
            log(format!(
                "Gave up capturing game {} from the post-game screen: Error: {err}",
                js::number_to_string(game_id)
            ));
            self.eog.done(game_id);
            return;
        };
        // Held across the spawn, so the retry cannot mark itself running
        // before its handle is stored
        let mut state = self.eog.state();
        if state.stopped {
            state.games.remove(&key(game_id));
            return;
        }
        let sync = self.clone();
        let retry = self.runtime.spawn(async move {
            tokio::time::sleep(delay).await;
            sync.capture(client, game_id, attempt + 1);
        });
        state.games.insert(key(game_id), Pending::Scheduled(retry));
    }
}

#[cfg(test)]
mod tests {
    use super::super::sync::rig::{Reply, Rig, detail_path, payload, rig};
    use super::*;
    use serde_json::json;

    const GAME: i64 = 7_000_000_000;

    fn in_game(rig: &Rig) {
        *rig.client.live.lock().unwrap() = Some(super::super::LiveGameRef {
            game_id: GAME as f64,
            queue_id: 2400.0,
        });
    }

    fn phase(rig: &Rig, phase: &str) {
        rig.sync.on_frame(
            rig.dyn_client.clone(),
            &json!({"uri": "/lol-gameflow/v1/gameflow-phase", "eventType": "Update", "data": phase}),
        );
    }

    fn stats_block(rig: &Rig, event_type: &str, data: Value) {
        rig.sync.on_frame(
            rig.dyn_client.clone(),
            &json!({"uri": "/lol-end-of-game/v1/eog-stats-block", "eventType": event_type, "data": data}),
        );
    }

    fn stored(rig: &Rig) -> i64 {
        rig.env.query(&format!(
            "SELECT count(*) FROM games WHERE game_id = {GAME}"
        ))
    }

    /// The `results-late` scenario: the first three requests for the game miss.
    #[tokio::test(start_paused = true)]
    async fn a_late_result_is_captured_on_the_fourth_attempt_at_electrons_times() {
        let rig = rig("eog-late");
        in_game(&rig);
        let misses = vec![Reply::Status(404); 3];
        rig.client.route(
            &detail_path(GAME),
            misses
                .into_iter()
                .chain([Reply::Json(payload(GAME, 2400))])
                .collect(),
        );

        phase(&rig, "EndOfGame");
        tokio::time::sleep(Duration::from_millis(600)).await;
        // The stats block lands while the first retry waits, and starts nothing
        stats_block(&rig, "Create", json!({"gameId": GAME, "gameMode": "KIWI"}));
        tokio::time::sleep(Duration::from_secs(60)).await;

        assert_eq!(
            rig.client.times(&detail_path(GAME)),
            [0, 2_000, 7_000, 22_000]
        );
        assert_eq!(rig.env.event_times("lcu:games-updated"), [22_000]);
        assert_eq!(stored(&rig), 1);
        assert!(!rig.sync.eog.is_pending(GAME as f64));
    }

    #[tokio::test(start_paused = true)]
    async fn the_retry_list_runs_out_after_six_retries() {
        let rig = rig("eog-give-up");
        in_game(&rig);
        rig.client
            .route(&detail_path(GAME), vec![Reply::Status(404)]);
        phase(&rig, "EndOfGame");
        tokio::time::sleep(Duration::from_secs(600)).await;

        // Each delay counts from the failure before it
        assert_eq!(
            rig.client.times(&detail_path(GAME)),
            [0, 2_000, 7_000, 22_000, 82_000, 202_000, 322_000]
        );
        assert!(
            !rig.sync.eog.is_pending(GAME as f64),
            "given up, so a new frame may start again"
        );
        assert!(rig.env.events().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_summoner_request_counts_as_a_failed_attempt() {
        let rig = rig("eog-summoner");
        in_game(&rig);
        rig.client.route(
            super::super::sync::SUMMONER_PATH,
            vec![
                Reply::Lost,
                Reply::Json(super::super::sync::rig::summoner()),
            ],
        );
        rig.client
            .route(&detail_path(GAME), vec![Reply::Json(payload(GAME, 2400))]);
        phase(&rig, "EndOfGame");
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(rig.client.times(&detail_path(GAME)), [2_000]);
        assert_eq!(stored(&rig), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn quitting_drops_every_scheduled_retry() {
        let rig = rig("eog-stop");
        in_game(&rig);
        rig.client
            .route(&detail_path(GAME), vec![Reply::Status(404)]);
        phase(&rig, "EndOfGame");
        tokio::time::sleep(Duration::from_millis(100)).await;
        rig.sync.eog.stop();
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(rig.client.times(&detail_path(GAME)), [0]);
        assert!(!rig.sync.eog.is_pending(GAME as f64));
    }

    #[tokio::test(start_paused = true)]
    async fn the_stats_block_alone_captures_and_repeats_are_deduplicated() {
        let rig = rig("eog-stats");
        rig.client
            .route(&detail_path(GAME), vec![Reply::Json(payload(GAME, 2400))]);
        stats_block(&rig, "Create", json!({"gameId": GAME}));
        stats_block(&rig, "Update", json!({"gameId": GAME}));
        tokio::time::sleep(Duration::from_secs(1)).await;
        stats_block(&rig, "Update", json!({"gameId": GAME}));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(rig.client.times(&detail_path(GAME)).len(), 1);
        assert_eq!(rig.env.events(), ["lcu:games-updated null"]);
    }

    #[tokio::test(start_paused = true)]
    async fn frames_that_carry_nothing_to_capture_send_no_request() {
        let rig = rig("eog-nothing");
        // A cleared screen, an empty block, an end with no session remembered
        stats_block(&rig, "Delete", json!({"gameId": GAME}));
        stats_block(&rig, "Update", Value::Null);
        stats_block(&rig, "Update", json!({"gameId": "nope"}));
        stats_block(&rig, "Update", json!({"gameId": 0}));
        phase(&rig, "EndOfGame");
        // A queue the app does not track is dismissed from the frame alone
        rig.sync.on_frame(
            rig.dyn_client.clone(),
            &json!({"uri": "lol-end-of-game/v1/gameclient-eog-stats-block", "eventType": "Update", "data": {"gameId": 55, "queueId": 450}}),
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(rig.client.paths().is_empty(), "{:?}", rig.client.paths());
        assert_eq!(
            rig.env
                .query::<i64>("SELECT count(*) FROM ignored_games WHERE game_id = 55"),
            1
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_fetched_game_in_another_queue_is_ignored_not_stored() {
        let rig = rig("eog-other-queue");
        rig.client
            .route(&detail_path(GAME), vec![Reply::Json(payload(GAME, 450))]);
        stats_block(&rig, "Create", json!({"gameId": GAME}));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(stored(&rig), 0);
        assert_eq!(
            rig.env.query::<i64>(&format!(
                "SELECT count(*) FROM ignored_games WHERE game_id = {GAME}"
            )),
            1
        );
        assert!(rig.env.events().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_game_already_stored_is_not_fetched() {
        let rig = rig("eog-stored");
        assert!(
            rig.sync
                .insert_game(&payload(GAME, 2400), Some(&json!("me")))
                .unwrap()
        );
        stats_block(&rig, "Create", json!({"gameId": GAME}));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(rig.client.paths().is_empty());
    }
}
