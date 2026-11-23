//! The request half of the IPC contract: every `window.api` request method,
//! registered under its Electron channel name.
//!
//! [`contract!`] below is the single source for the commands. Each entry names
//! the method, the channel, the arguments in Electron's positional order, and
//! the result. From it come the async Tauri command, the invoke handler, and
//! the [`registry`] that `bin/export_bindings.rs` writes `src/bindings.ts` from
//! and `tests/golden.rs` replays by. The body of each command is a plain async
//! function of the same name in its domain module, which the porting unit
//! fills in. Nothing outside those bodies changes after T08.

pub mod app;
pub mod backup;
pub mod data;
pub mod dragon;
pub mod export;
pub mod lcu;
pub mod live;
pub mod matches;
pub mod recap;
pub mod settings;
pub mod stats;
pub mod teammates;
pub mod types;
pub mod window;

use std::any::TypeId;
use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::task::Poll;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Builder, Manager, Runtime, WebviewWindow};
use ts_rs::{Config, TS, TypeVisitor};

use self::app::{DownloadUpdateResult, UpdateInfo, UpdateNotes};
use self::backup::{BackupInfo, CreateBackupResult, RecoveryReport, RestoreBackupResult};
use self::data::{ExportDataResult, ImportDataResult, RepairResult};
use self::dragon::{AugmentData, ChampionData, ItemData, SummonerSpellData};
use self::export::{CardSpec, CopyCardResult, ExportCardResult};
use self::lcu::{BackfillOutcome, LcuStatus};
use self::live::{ChallengesResult, LiveGameSnapshot};
use self::matches::{MatchFilterOptions, MatchFilters, MatchSession, Profile};
use self::recap::{GameCardData, GameRecap, SeasonRecap, SeasonSummary};
use self::stats::{
    AugmentStatsDetailedResult, ChampionStats, DashboardData, GlobalChampionDetail, GlobalStats,
    TrendsData,
};
use self::teammates::{TeammateDetail, TeammateGroup, TeammateGroupDetail};
use self::types::{
    AugmentStats, ItemStats, MatchDetail, MatchPage, MatchScope, RecordsData, TeammateStats,
};
use crate::Host;
use crate::js_arg::Js;

/// What a command body gets besides its arguments: the app, for managed
/// state, and the window that invoked it, as Electron's `event.sender`.
pub struct Ctx<R: Runtime> {
    pub app: AppHandle<R>,
    pub window: WebviewWindow<R>,
}

impl<R: Runtime> Ctx<R> {
    /// Milliseconds since the epoch from the app's [`Clock`], which golden
    /// replay and parity lanes freeze. Every time read in a body goes through
    /// here; clippy refuses the others under `commands/`.
    pub fn now_ms(&self) -> CommandResult<i64> {
        self.app
            .try_state::<Clock>()
            .map(|clock| clock.now_ms())
            .ok_or_else(|| CommandError::thrown("the app manages no Clock"))
    }

    /// Runs blocking work, a database query or file I/O, on the blocking pool
    /// rather than the async workers that serve every other command. A panic
    /// in `work` rejects the call, as one in the body does.
    pub async fn blocking<T, F>(&self, work: F) -> CommandResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> CommandResult<T> + Send + 'static,
    {
        match tauri::async_runtime::spawn_blocking(work).await {
            Ok(result) => result,
            Err(tauri::Error::JoinError(error)) if error.is_panic() => {
                Err(CommandError::panicked(error.into_panic()))
            }
            Err(error) => Err(CommandError::thrown(error.to_string())),
        }
    }
}

/// The wall clock commands read. Golden replay and parity-driver builds
/// freeze it at the time the Electron goldens were recorded under; release
/// builds have only the system clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clock {
    System,
    #[cfg(any(test, feature = "parity-driver"))]
    Fixed(i64),
}

/// `BMT_FIXED_TIME`, epoch milliseconds, freezes a parity-driver build's
/// clock, as `SEAM_FIXED_TIME` freezes Electron's.
#[cfg(feature = "parity-driver")]
pub const FIXED_TIME_ENV: &str = "BMT_FIXED_TIME";

impl Clock {
    pub fn now_ms(&self) -> i64 {
        match self {
            Clock::System => system_now_ms(),
            #[cfg(any(test, feature = "parity-driver"))]
            Clock::Fixed(ms) => *ms,
        }
    }

    /// The clock a parity-driver build runs on: fixed when `BMT_FIXED_TIME`
    /// holds epoch milliseconds, the system clock when it is unset.
    #[cfg(feature = "parity-driver")]
    pub fn from_env() -> Result<Self, String> {
        Self::from_setting(std::env::var(FIXED_TIME_ENV).ok().as_deref())
    }

    #[cfg(feature = "parity-driver")]
    fn from_setting(setting: Option<&str>) -> Result<Self, String> {
        match setting {
            Some(text) => text
                .trim()
                .parse::<i64>()
                .map(Clock::Fixed)
                .map_err(|_| format!("{FIXED_TIME_ENV}={text:?} is not epoch milliseconds")),
            None => Ok(Clock::System),
        }
    }
}

#[allow(clippy::disallowed_methods)]
fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub const NOT_PORTED: &str = "not ported";

/// A command's rejection. It reaches the page as `{ name, message, code? }`,
/// and `src/api.ts` rebuilds the `Error` Electron's invoke would have thrown,
/// `Error invoking remote method '<channel>': <name>: <message>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

impl CommandError {
    /// What every command answers until its porting unit lands.
    pub fn not_ported() -> Self {
        Self {
            code: Some("NOT_PORTED"),
            ..Self::thrown(NOT_PORTED)
        }
    }

    /// An `Error` thrown by the handler, as `throw new Error(message)`.
    pub fn thrown(message: impl Into<String>) -> Self {
        Self::named("Error", message)
    }

    /// An error of another class, as a `TypeError` or better-sqlite3's
    /// `SqliteError`, whose `name` the page sees in the message.
    pub fn named(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
            code: None,
        }
    }

    /// A body that panicked. Electron's handler would have thrown, so the call
    /// rejects instead of taking the app down.
    pub fn panicked(payload: Box<dyn std::any::Any + Send>) -> Self {
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "the command panicked".to_owned());
        Self::thrown(message)
    }

    pub fn is_not_ported(&self) -> bool {
        self.code == Some("NOT_PORTED")
    }
}

/// better-sqlite3 throws a `SqliteError` carrying SQLite's own message.
impl From<rusqlite::Error> for CommandError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(code, message) => {
                Self::named("SqliteError", message.unwrap_or_else(|| code.to_string()))
            }
            other => Self::thrown(other.to_string()),
        }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

/// Runs a command body and turns a panic into a rejection. Every command the
/// contract registers goes through here.
pub async fn guarded<T>(body: impl Future<Output = CommandResult<T>>) -> CommandResult<T> {
    let mut body = std::pin::pin!(body);
    std::future::poll_fn(move |cx| {
        match std::panic::catch_unwind(AssertUnwindSafe(|| body.as_mut().poll(cx))) {
            Ok(poll) => poll,
            Err(payload) => Poll::Ready(Err(CommandError::panicked(payload))),
        }
    })
    .await
}

/// A domain module's hooks into building the app. Each domain file implements
/// it for its `Hooks` and overrides only what it needs, so a porting unit adds
/// managed state without editing `lib.rs` or `tests/golden.rs`.
pub trait Domain {
    /// Adds the domain's managed state, for the app and the golden replay alike.
    fn register<R: Runtime>(builder: Builder<R>, _host: &Host) -> Builder<R> {
        builder
    }

    /// Runs before each golden case is replayed: writes the files the case
    /// reads into its data root, queues a dialog's answer, or seeds state the
    /// mock runtime cannot hold, such as a maximized window.
    #[cfg(feature = "parity-driver")]
    fn before_golden_case<R: Runtime>(_app: &AppHandle<R>, _case: &GoldenCase<'_>) {}
}

/// The golden case about to be replayed, for [`Domain::before_golden_case`].
#[cfg(feature = "parity-driver")]
pub struct GoldenCase<'a> {
    pub channel: &'a str,
    pub case: &'a str,
    pub group: &'a str,
    pub args: &'a [serde_json::Value],
    /// The data folder the case runs over, which goldens write as `$RUN`.
    pub root: &'a std::path::Path,
}

/// What a body asked of the OS shell, recorded in place of doing it. Golden
/// replay manages one and compares it with each golden's `effects`, so a
/// domain's OS seam records here in a parity-driver build when one is managed.
#[cfg(feature = "parity-driver")]
#[derive(Default)]
pub struct EffectRecorder(std::sync::Mutex<Vec<serde_json::Value>>);

#[cfg(feature = "parity-driver")]
impl EffectRecorder {
    /// One call in the seam's shape, as `{ api: "shell.openPath", args: [path] }`.
    pub fn record(&self, api: &str, args: Vec<serde_json::Value>) {
        let effect = serde_json::json!({ "api": api, "args": args });
        self.0.lock().expect("the effect log").push(effect);
    }

    pub fn take(&self) -> Vec<serde_json::Value> {
        std::mem::take(&mut *self.0.lock().expect("the effect log"))
    }
}

/// How one argument or result type prints in TypeScript, and the declarations
/// it needs.
#[derive(Clone, Copy)]
pub struct TypeSpec {
    /// The full type, `X | null` for an `Option`.
    pub ts: fn(&Config) -> String,
    /// The type without its `Option`, for a positional `name?: X`.
    pub inner_ts: fn(&Config) -> String,
    pub optional: bool,
    /// `()`, which the bindings print as `void`, as `api.ts` does.
    pub unit: bool,
    pub visit: fn(&mut TypeCollector),
    /// Reads JSON as this type and writes it back, which shows whether a value
    /// Electron sent survives the Rust type: names, nulls, absent keys, integers.
    pub roundtrip: fn(serde_json::Value) -> Result<serde_json::Value, String>,
}

impl TypeSpec {
    pub fn of<T>() -> Self
    where
        T: TS + Serialize + DeserializeOwned + 'static,
        T::OptionInnerType: TS,
    {
        Self {
            ts: |cfg| T::name(cfg),
            inner_ts: |cfg| <T::OptionInnerType as TS>::name(cfg),
            optional: T::IS_OPTION,
            unit: TypeId::of::<T>() == TypeId::of::<()>(),
            visit: |collector| collector.visit::<T>(),
            roundtrip: |value| {
                let typed: T = serde_json::from_value(value).map_err(|e| e.to_string())?;
                serde_json::to_value(typed).map_err(|e| e.to_string())
            },
        }
    }
}

#[derive(Clone, Copy)]
pub struct ArgSpec {
    /// The Rust parameter name.
    pub name: &'static str,
    pub ty: TypeSpec,
}

impl ArgSpec {
    /// The key Tauri reads the argument from, camelCased as `#[tauri::command]`
    /// does by default.
    pub fn key(&self) -> String {
        heck::ToLowerCamelCase::to_lower_camel_case(self.name)
    }
}

#[derive(Clone)]
pub struct CommandSpec {
    pub method: &'static str,
    pub channel: &'static str,
    pub args: Vec<ArgSpec>,
    pub ret: TypeSpec,
}

impl CommandSpec {
    /// Electron's positional arguments as the named object the generated
    /// wrapper sends. JSON drops a key whose value is `undefined`, and a
    /// golden records a skipped argument as `null`, so a `null` is left out as
    /// a missing trailing argument is. Tauri reads either as `None`.
    pub fn named_args(
        &self,
        positional: &[serde_json::Value],
    ) -> serde_json::Map<String, serde_json::Value> {
        self.args
            .iter()
            .zip(positional)
            .filter(|(_, value)| !value.is_null())
            .map(|(arg, value)| (arg.key(), value.clone()))
            .collect()
    }
}

/// Every named TypeScript declaration a set of types needs, by name.
#[derive(Default)]
pub struct TypeCollector {
    seen: HashSet<TypeId>,
    pub decls: BTreeMap<String, String>,
    cfg: Config,
}

impl TypeCollector {
    pub fn new(cfg: Config) -> Self {
        Self {
            seen: HashSet::new(),
            decls: BTreeMap::new(),
            cfg,
        }
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }
}

impl TypeVisitor for TypeCollector {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if !self.seen.insert(TypeId::of::<T>()) {
            return;
        }
        if T::output_path().is_some() {
            let ident = T::ident(&self.cfg);
            let decl = T::decl(&self.cfg);
            if let Some(earlier) = self.decls.get(&ident) {
                // Two Rust types under one TypeScript name: the file could hold only one
                assert_eq!(
                    earlier, &decl,
                    "two different Rust types export as `{ident}`; rename one"
                );
            }
            self.decls.insert(ident, decl);
        }
        T::visit_dependencies(self);
        T::visit_generics(self);
    }
}

macro_rules! contract {
    ($(
        $module:ident {
            $( $name:ident = $method:literal $channel:literal ( $( $arg:ident : $ty:ty ),* ) -> $ret:ty; )*
        }
    )*) => {
        $( $(
            // The window and app ride along with Electron's positional arguments
            #[allow(clippy::too_many_arguments)]
            #[tauri::command(rename = $channel)]
            pub async fn $name<R: Runtime>(
                app: AppHandle<R>,
                window: WebviewWindow<R>,
                $( $arg: $ty ),*
            ) -> Result<$ret, CommandError> {
                guarded($module::$name(Ctx { app, window }, $( $arg ),*)).await
            }
        )* )*

        /// The invoke handler for every command, plus T01's `page_event`
        /// timing hook. A builder takes one handler, so this is the only one.
        pub fn handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$( $( $name, )* )* crate::page_event]
        }

        /// Every command, in the order of the contract.
        pub fn registry() -> Vec<CommandSpec> {
            vec![$( $(
                CommandSpec {
                    method: $method,
                    channel: $channel,
                    args: vec![$( ArgSpec { name: stringify!($arg), ty: TypeSpec::of::<$ty>() } ),*],
                    ret: TypeSpec::of::<$ret>(),
                },
            )* )*]
        }

        /// Every domain's [`Domain::register`], which `app_builder` runs.
        pub fn register<R: Runtime>(builder: Builder<R>, host: &Host) -> Builder<R> {
            $( let builder = <$module::Hooks as Domain>::register(builder, host); )*
            builder
        }

        /// Every domain's [`Domain::before_golden_case`].
        #[cfg(feature = "parity-driver")]
        pub fn before_golden_case<R: Runtime>(app: &AppHandle<R>, case: &GoldenCase<'_>) {
            $( <$module::Hooks as Domain>::before_golden_case(app, case); )*
        }
    };
}

// Optional arguments: golden JSON cannot tell `null` from a skipped argument,
// and no handler treats them differently for a value the renderer sends. The
// one handler that branches, getAugmentStats (stats.ts:73, `championId !==
// undefined`), never receives null from the renderer (Champions.tsx:188).
contract! {
    matches {
        get_match_history = "getMatchHistory" "db:match-history"
            (limit: Js<i64>, offset: Js<i64>, filters: Option<MatchFilters>) -> MatchPage;
        get_match_sessions = "getMatchSessions" "db:match-sessions"
            (filters: Option<MatchFilters>) -> Vec<MatchSession>;
        get_match_filter_options = "getMatchFilterOptions" "db:match-filters"
            (filters: Option<MatchScope>) -> MatchFilterOptions;
        get_stored_queues = "getStoredQueues" "db:stored-queues" () -> Vec<i64>;
        get_match_detail = "getMatchDetail" "db:match-detail"
            (game_id: Js<i64>) -> Option<MatchDetail>;
        toggle_favorite = "toggleFavorite" "db:toggle-favorite" (game_id: Js<i64>) -> bool;
        get_champion_match_history = "getChampionMatchHistory" "db:champion-match-history"
            (champion_id: Js<i64>, limit: Js<i64>, offset: Js<i64>, patch: Js<Option<String>>, queue: Js<Option<i64>>, season: Js<Option<String>>) -> MatchPage;
        get_all_summoner_puuids = "getAllSummonerPuuids" "db:all-summoner-puuids" () -> Vec<String>;
        get_profile = "getProfile" "db:profile" () -> Profile;
    }
    stats {
        get_champion_stats = "getChampionStats" "db:champion-stats"
            (patch: Option<String>, queue: Option<i64>, season: Option<String>) -> Vec<ChampionStats>;
        get_augment_stats = "getAugmentStats" "db:augment-stats"
            (champion_id: Option<i64>, patch: Option<String>, queue: Option<i64>, season: Option<String>) -> Vec<AugmentStats>;
        get_augment_stats_detailed = "getAugmentStatsDetailed" "db:augment-stats-detailed"
            (patch: Option<String>, queue: Option<i64>, season: Option<String>) -> AugmentStatsDetailedResult;
        get_dashboard = "getDashboard" "db:dashboard" (filters: Option<MatchScope>) -> DashboardData;
        get_champion_item_stats = "getChampionItemStats" "db:champion-item-stats"
            (champion_id: i64, patch: Option<String>, queue: Option<i64>, season: Option<String>) -> Vec<ItemStats>;
        get_global_stats = "getGlobalStats" "db:global-stats"
            (patch: Option<String>, queue: Option<i64>) -> GlobalStats;
        get_global_champion_detail = "getGlobalChampionDetail" "db:global-champion-detail"
            (champion_id: i64, patch: Option<String>, queue: Option<i64>) -> GlobalChampionDetail;
        get_trends = "getTrends" "db:trends" (queue: Option<i64>) -> TrendsData;
        get_records = "getRecords" "db:records"
            (queue: Option<i64>, account: Option<String>) -> RecordsData;
    }
    teammates {
        get_teammate_stats = "getTeammateStats" "db:teammate-stats"
            (season: Option<String>) -> Vec<TeammateStats>;
        get_teammate_groups = "getTeammateGroups" "db:teammate-groups"
            (season: Option<String>) -> Vec<TeammateGroup>;
        get_teammate_group_detail = "getTeammateGroupDetail" "db:teammate-group-detail"
            (key: String) -> Option<TeammateGroupDetail>;
        get_teammate_detail = "getTeammateDetail" "db:teammate-detail"
            (key: String) -> Option<TeammateDetail>;
    }
    recap {
        get_game_recap = "getGameRecap" "db:game-recap" (game_id: Option<i64>) -> Option<GameRecap>;
        get_game_card = "getGameCard" "db:game-card" (game_id: i64) -> Option<GameCardData>;
        get_season_recap = "getSeasonRecap" "db:season-recap"
            (season_id: Option<String>, queue: Option<i64>, account: Option<String>) -> Option<SeasonRecap>;
        get_seasons = "getSeasons" "db:seasons" () -> Vec<SeasonSummary>;
    }
    live {
        get_live_game = "getLiveGame" "live:snapshot" () -> LiveGameSnapshot;
        get_challenges = "getChallenges" "challenges:get" () -> ChallengesResult;
    }
    lcu {
        backfill_history = "backfillHistory" "lcu:backfill" () -> BackfillOutcome;
        cancel_backfill = "cancelBackfill" "lcu:cancel-backfill" () -> ();
        is_backfill_running = "isBackfillRunning" "lcu:backfill-running" () -> bool;
        get_lcu_status = "getLcuStatus" "lcu:status" () -> LcuStatus;
    }
    dragon {
        get_champion_data = "getChampionData" "dragon:champions" () -> ChampionData;
        get_augment_data = "getAugmentData" "dragon:augments" (patch: Option<String>) -> AugmentData;
        resolve_augment_icon = "resolveAugmentIcon" "dragon:augment-icon"
            (id: i64, patch: Option<String>) -> Option<String>;
        get_item_data = "getItemData" "dragon:items" (patch: Option<String>) -> ItemData;
        get_summoner_spell_data = "getSummonerSpellData" "dragon:summoner-spells" () -> SummonerSpellData;
    }
    settings {
        get_setting = "getSetting" "settings:get" (key: String) -> Option<String>;
        is_auto_start_supported = "isAutoStartSupported" "autostart:supported" () -> bool;
        set_setting = "setSetting" "settings:set" (key: String, value: String) -> ();
    }
    export {
        export_card_image = "exportCardImage" "export:card-image" (card: CardSpec) -> ExportCardResult;
        copy_card_image = "copyCardImage" "export:copy-card-image" (card: CardSpec) -> CopyCardResult;
    }
    data {
        export_data = "exportData" "data:export" () -> ExportDataResult;
        import_data = "importData" "data:import" () -> ImportDataResult;
        repair_puuids = "repairPuuids" "data:repair-puuids" () -> RepairResult;
    }
    backup {
        list_backups = "listBackups" "backup:list" () -> Vec<BackupInfo>;
        create_backup = "createBackup" "backup:create" () -> CreateBackupResult;
        restore_backup = "restoreBackup" "backup:restore" (file: String) -> RestoreBackupResult;
        get_recovery_report = "getRecoveryReport" "backup:recovery-report" () -> Option<RecoveryReport>;
        open_backup_folder = "openBackupFolder" "backup:open-folder" () -> ();
    }
    app {
        open_logs_folder = "openLogsFolder" "app:open-logs-folder" () -> ();
        get_version = "getVersion" "app:version" () -> String;
        check_for_update = "checkForUpdate" "app:check-update" () -> UpdateInfo;
        download_update = "downloadUpdate" "app:download-update" (asset_url: String) -> DownloadUpdateResult;
        get_launch_install = "getLaunchInstall" "app:launch-install" () -> Option<UpdateInfo>;
        get_update_notes = "getUpdateNotes" "app:update-notes" () -> Option<UpdateNotes>;
        open_url = "openUrl" "app:open-url" (url: String) -> ();
    }
    window {
        minimize_window = "minimizeWindow" "window:minimize" () -> ();
        toggle_maximize_window = "toggleMaximizeWindow" "window:toggle-maximize" () -> ();
        close_window = "closeWindow" "window:close" () -> ();
        is_window_maximized = "isWindowMaximized" "window:is-maximized" () -> bool;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_holds_61_unique_channels_and_methods() {
        let registry = registry();
        assert_eq!(registry.len(), 61);
        let channels: HashSet<_> = registry.iter().map(|c| c.channel).collect();
        let methods: HashSet<_> = registry.iter().map(|c| c.method).collect();
        assert_eq!(channels.len(), 61, "a channel appears twice");
        assert_eq!(methods.len(), 61, "a method appears twice");
    }

    #[test]
    fn optional_arguments_trail_the_required_ones() {
        for command in registry() {
            let first_optional = command.args.iter().position(|a| a.ty.optional);
            if let Some(first) = first_optional {
                assert!(
                    command.args[first..].iter().all(|a| a.ty.optional),
                    "{}: an optional argument comes before a required one",
                    command.method
                );
            }
        }
    }

    #[test]
    fn argument_keys_are_camel_case() {
        let spec = registry()
            .into_iter()
            .find(|c| c.method == "getChampionMatchHistory")
            .expect("getChampionMatchHistory is registered");
        let keys: Vec<_> = spec.args.iter().map(ArgSpec::key).collect();
        assert_eq!(
            keys,
            ["championId", "limit", "offset", "patch", "queue", "season"]
        );
    }

    #[test]
    fn fixed_clock_does_not_move() {
        assert_eq!(Clock::Fixed(1_764_000_000_000).now_ms(), 1_764_000_000_000);
    }

    #[cfg(feature = "parity-driver")]
    #[test]
    fn a_driver_build_freezes_at_bmt_fixed_time() {
        assert_eq!(
            Clock::from_setting(Some("1795399200000")),
            Ok(Clock::Fixed(1_795_399_200_000))
        );
        assert_eq!(Clock::from_setting(None), Ok(Clock::System));
        assert!(Clock::from_setting(Some("2026-11-23")).is_err());
    }

    fn mock_ctx(clock: Option<Clock>) -> Ctx<tauri::test::MockRuntime> {
        let builder = tauri::test::mock_builder();
        let builder = match clock {
            Some(clock) => builder.manage(clock),
            None => builder,
        };
        let app = builder
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        let window =
            tauri::WebviewWindowBuilder::new(&app, crate::WINDOW_LABEL, Default::default())
                .build()
                .expect("build the mock window");
        Ctx {
            app: app.handle().clone(),
            window,
        }
    }

    #[test]
    fn now_ms_rejects_without_a_clock() {
        assert_eq!(mock_ctx(Some(Clock::Fixed(7))).now_ms(), Ok(7));
        let error = mock_ctx(None).now_ms().expect_err("no clock is managed");
        assert_eq!(error.message, "the app manages no Clock");
    }

    #[test]
    fn a_panicking_body_rejects_with_its_message() {
        let answer: CommandResult<i64> = tauri::async_runtime::block_on(guarded(async {
            panic!("index out of bounds");
        }));
        assert_eq!(answer, Err(CommandError::thrown("index out of bounds")));
        let formatted: CommandResult<()> = tauri::async_runtime::block_on(guarded(async {
            panic!("row {} is missing", 3);
        }));
        assert_eq!(formatted, Err(CommandError::thrown("row 3 is missing")));
    }

    #[test]
    fn blocking_work_runs_and_its_panic_rejects() {
        let ctx = mock_ctx(None);
        let answer = tauri::async_runtime::block_on(ctx.blocking(|| Ok(2 + 2)));
        assert_eq!(answer, Ok(4));
        let panicked: CommandResult<()> =
            tauri::async_runtime::block_on(ctx.blocking(|| panic!("database is locked")));
        assert_eq!(panicked, Err(CommandError::thrown("database is locked")));
    }

    #[test]
    fn a_sqlite_failure_keeps_its_class() {
        let conn = rusqlite::Connection::open_in_memory().expect("an in-memory database");
        let error: CommandError = conn
            .execute("SELECT * FROM games", [])
            .expect_err("no such table")
            .into();
        assert_eq!(
            error,
            CommandError::named("SqliteError", "no such table: games")
        );
    }

    #[test]
    fn named_args_drop_skipped_arguments_as_the_wrapper_does() {
        let spec = registry()
            .into_iter()
            .find(|c| c.method == "getAugmentStatsDetailed")
            .expect("getAugmentStatsDetailed is registered");
        let named = spec.named_args(&[serde_json::Value::Null, serde_json::json!(2400)]);
        assert_eq!(
            serde_json::Value::Object(named),
            serde_json::json!({ "queue": 2400 })
        );
    }

    /// A domain of one panicking command and one that reads state its hooks
    /// set, registered through the same macro as the contract.
    mod probe {
        use std::sync::Mutex;

        use super::super::{CommandResult, Ctx, Domain};
        use crate::Host;
        use tauri::{Builder, Manager, Runtime};

        pub struct Seeded(pub Mutex<String>);

        pub struct Hooks;
        impl Domain for Hooks {
            fn register<R: Runtime>(builder: Builder<R>, _host: &Host) -> Builder<R> {
                builder.manage(Seeded(Mutex::new("registered".into())))
            }

            #[cfg(feature = "parity-driver")]
            fn before_golden_case<R: Runtime>(
                app: &tauri::AppHandle<R>,
                case: &super::super::GoldenCase<'_>,
            ) {
                *app.state::<Seeded>().0.lock().unwrap() = case.case.to_owned();
            }
        }

        pub async fn boom<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<String> {
            panic!("index out of bounds")
        }

        pub async fn seeded<R: Runtime>(ctx: Ctx<R>) -> CommandResult<String> {
            Ok(ctx.app.state::<Seeded>().0.lock().unwrap().clone())
        }
    }

    // The macro writes every item the contract has; the test uses some
    #[allow(dead_code)]
    mod probe_contract {
        use super::super::*;
        use super::probe;

        contract! {
            probe {
                boom = "boom" "test:boom" () -> String;
                seeded = "seeded" "test:seeded" () -> String;
            }
        }
    }

    fn probe_call(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let request = tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        };
        tauri::test::get_ipc_response(window, request).map(|b| b.deserialize().unwrap())
    }

    #[test]
    fn contract_commands_reject_a_panic_and_run_their_domain_hooks() {
        let host = Host::system();
        let builder = probe_contract::register(tauri::test::mock_builder(), &host)
            .invoke_handler(probe_contract::handler());
        let app = builder
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        let window =
            tauri::WebviewWindowBuilder::new(&app, crate::WINDOW_LABEL, Default::default())
                .build()
                .expect("build the mock window");
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let answer = probe_call(&window, "test:boom");
        std::panic::set_hook(hook);
        assert_eq!(
            answer,
            Err(serde_json::json!({ "name": "Error", "message": "index out of bounds" }))
        );
        assert_eq!(probe_call(&window, "test:seeded"), Ok("registered".into()));
        #[cfg(feature = "parity-driver")]
        {
            let case = GoldenCase {
                channel: "window:is-maximized",
                case: "maximized",
                group: "window",
                args: &[],
                root: std::path::Path::new("/nowhere"),
            };
            probe_contract::before_golden_case(app.handle(), &case);
            assert_eq!(probe_call(&window, "test:seeded"), Ok("maximized".into()));
        }
    }

    mod one {
        #[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
        pub struct Row {
            pub a: i64,
        }
    }
    mod two {
        #[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
        pub struct Row {
            pub b: String,
        }
    }

    #[test]
    #[should_panic(expected = "two different Rust types export as `Row`")]
    fn two_types_under_one_name_are_refused() {
        let mut collector = TypeCollector::new(Config::new());
        collector.visit::<one::Row>();
        collector.visit::<two::Row>();
    }
}
