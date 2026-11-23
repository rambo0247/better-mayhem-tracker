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
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use ts_rs::{Config, TS, TypeVisitor};

use self::backup::*;
use self::data::*;
use self::dragon::*;
use self::export::*;
use self::lcu::*;
use self::live::*;
use self::matches::*;
use self::recap::*;
use self::stats::*;
use self::teammates::*;
use self::types::*;
use self::app::*;

/// What a command body gets besides its arguments: the app, for managed
/// state, and the window that invoked it, as Electron's `event.sender`.
pub struct Ctx<R: Runtime> {
    pub app: AppHandle<R>,
    pub window: WebviewWindow<R>,
}

impl<R: Runtime> Ctx<R> {
    /// Milliseconds since the epoch, frozen when the app was built with
    /// [`Clock::Fixed`], as the T05 recordings were.
    pub fn now_ms(&self) -> i64 {
        self.app.state::<Clock>().now_ms()
    }
}

/// The wall clock commands read. Golden replay freezes it at the time the
/// Electron goldens were recorded under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clock {
    System,
    Fixed(i64),
}

impl Clock {
    pub fn now_ms(&self) -> i64 {
        match self {
            Clock::System => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as i64),
            Clock::Fixed(ms) => *ms,
        }
    }
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
            name: "Error".into(),
            message: NOT_PORTED.into(),
            code: Some("NOT_PORTED"),
        }
    }

    /// An `Error` thrown by the handler, as `throw new Error(message)`.
    pub fn thrown(message: impl Into<String>) -> Self {
        Self {
            name: "Error".into(),
            message: message.into(),
            code: None,
        }
    }

    pub fn is_not_ported(&self) -> bool {
        self.code == Some("NOT_PORTED")
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

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
}

impl TypeSpec {
    pub fn of<T>() -> Self
    where
        T: TS + 'static,
        T::OptionInnerType: TS,
    {
        Self {
            ts: |cfg| T::name(cfg),
            inner_ts: |cfg| <T::OptionInnerType as TS>::name(cfg),
            optional: T::IS_OPTION,
            unit: TypeId::of::<T>() == TypeId::of::<()>(),
            visit: |collector| collector.visit::<T>(),
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
    /// The domain module that holds the body.
    pub module: &'static str,
    pub args: Vec<ArgSpec>,
    pub ret: TypeSpec,
}

impl CommandSpec {
    /// Electron's positional arguments as the named object Tauri takes. A
    /// missing trailing argument is left out, which Tauri reads as `None`.
    pub fn named_args(&self, positional: &[serde_json::Value]) -> serde_json::Map<String, serde_json::Value> {
        self.args
            .iter()
            .zip(positional)
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
            let decl = T::decl(&self.cfg);
            self.decls.insert(T::ident(&self.cfg), decl);
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
                $module::$name(Ctx { app, window }, $( $arg ),*).await
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
                    module: stringify!($module),
                    args: vec![$( ArgSpec { name: stringify!($arg), ty: TypeSpec::of::<$ty>() } ),*],
                    ret: TypeSpec::of::<$ret>(),
                },
            )* )*]
        }
    };
}

contract! {
    matches {
        get_match_history = "getMatchHistory" "db:match-history"
            (limit: i64, offset: i64, filters: Option<MatchFilters>) -> MatchPage;
        get_match_sessions = "getMatchSessions" "db:match-sessions"
            (filters: Option<MatchFilters>) -> Vec<MatchSession>;
        get_match_filter_options = "getMatchFilterOptions" "db:match-filters"
            (filters: Option<MatchScope>) -> MatchFilterOptions;
        get_stored_queues = "getStoredQueues" "db:stored-queues" () -> Vec<i64>;
        get_match_detail = "getMatchDetail" "db:match-detail"
            (game_id: i64) -> Option<MatchDetail>;
        toggle_favorite = "toggleFavorite" "db:toggle-favorite" (game_id: i64) -> bool;
        get_champion_match_history = "getChampionMatchHistory" "db:champion-match-history"
            (champion_id: i64, limit: i64, offset: i64, patch: Option<String>, queue: Option<i64>, season: Option<String>) -> MatchPage;
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
        assert_eq!(keys, ["championId", "limit", "offset", "patch", "queue", "season"]);
    }

    #[test]
    fn fixed_clock_does_not_move() {
        assert_eq!(Clock::Fixed(1_764_000_000_000).now_ms(), 1_764_000_000_000);
    }
}
