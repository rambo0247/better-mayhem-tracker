//! Card image export to a file and to the clipboard. Ported by T25.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx};

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

pub async fn export_card_image<R: Runtime>(
    _ctx: Ctx<R>,
    _card: CardSpec,
) -> CommandResult<ExportCardResult> {
    Err(CommandError::not_ported())
}

pub async fn copy_card_image<R: Runtime>(
    _ctx: Ctx<R>,
    _card: CardSpec,
) -> CommandResult<CopyCardResult> {
    Err(CommandError::not_ported())
}
