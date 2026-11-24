//! Card image export to a file and to the clipboard. Ported by T25.

use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};
use ts_rs::TS;

use super::{CommandResult, Ctx, Domain};
use crate::db::{self, matches};
use crate::dragon::{ChampionData, Dragon};
use crate::export_image;

pub struct Hooks;
impl Domain for Hooks {
    /// Answers the save dialog with the file Electron wrote, as T05's
    /// `ipc-cases.ts` answered it, and draws the card as the bytes Electron
    /// wrote there. A golden that wrote nothing had its dialog dismissed.
    #[cfg(feature = "parity-driver")]
    fn before_golden_case<R: Runtime>(app: &tauri::AppHandle<R>, case: &super::GoldenCase<'_>) {
        use base64::Engine;

        use crate::dialogs::{Answers, Dialogs};
        use export_image::Cards;
        if !case.channel.starts_with("export:") {
            return;
        }
        let written = case.files.first();
        let save = written
            .and_then(|file| file.get("path")?.as_str()?.strip_prefix("$RUN/"))
            .map(|name| case.root.join(name));
        let png = written
            .and_then(|file| file.get("base64")?.as_str())
            .map(|text| {
                base64::engine::general_purpose::STANDARD
                    .decode(text)
                    .expect("a golden's file is base64")
            })
            .unwrap_or_default();
        if app.try_state::<Dialogs>().is_none() {
            app.manage(Dialogs::scripted());
        }
        app.state::<Dialogs>().answer(Answers { save, open: None });
        if app.try_state::<Cards>().is_none() {
            app.manage(Cards::scripted());
        }
        app.state::<Cards>().draw_as(png);
    }
}

/// What a card is of, `src/shared/card.ts`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum CardSpec {
    Game {
        game_id: i64,
    },
    Season {
        season_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        queue: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        account: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        hide_friends: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ExportCardResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct CopyCardResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// Both cards name champions, and a game card's scoreboard scores every
/// player by champion class, so both commands wait for the startup load.
async fn champion_data<R: Runtime>(ctx: &Ctx<R>) -> Option<ChampionData> {
    let dragon = ctx.app.try_state::<Dragon>()?.inner().clone();
    Some(dragon.champion_data().await)
}

/// `defaultFileName`'s inputs: the game's date and champion from
/// `getMatchDetail`, and the clock for a season.
async fn file_name<R: Runtime>(
    ctx: &Ctx<R>,
    card: &CardSpec,
    champions: Option<&ChampionData>,
) -> CommandResult<String> {
    let detail = match card {
        CardSpec::Game { game_id } => {
            let game_id = *game_id;
            db::run(ctx, move |conn| matches::get_match_detail(conn, game_id)).await?
        }
        CardSpec::Season { .. } => None,
    };
    let game = detail.as_ref().map(|detail| {
        let champion = champions
            .and_then(|c| c.get(&detail.stats.champion_id.to_string()))
            .map(|c| c.name.as_str())
            .filter(|name| !name.is_empty());
        (detail.game.game_creation, champion)
    });
    Ok(export_image::default_file_name(
        card,
        ctx.now_ms()?,
        &TimeZone::system(),
        game,
    ))
}

pub async fn export_card_image<R: Runtime>(
    ctx: Ctx<R>,
    card: CardSpec,
) -> CommandResult<ExportCardResult> {
    let champions = champion_data(&ctx).await;
    let name = file_name(&ctx, &card, champions.as_ref()).await?;
    Ok(export_image::export_card_image(&ctx.app, &ctx.window, &card, name).await)
}

pub async fn copy_card_image<R: Runtime>(
    ctx: Ctx<R>,
    card: CardSpec,
) -> CommandResult<CopyCardResult> {
    champion_data(&ctx).await;
    Ok(export_image::copy_card_image(&ctx.app, &card).await)
}
