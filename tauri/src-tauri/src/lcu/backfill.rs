//! The deep-history backfill in `src/main/lcu.ts`. The client's match list
//! holds twenty games, so ids come from Riot's player-platform service (SGP),
//! which pages back years, and each new one is fetched in full through the
//! client's by-id endpoint.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use serde_json::Value;

use super::log;
use super::sync::{
    Client, DETAILS_IN_FLIGHT, GameSync, Pause, SUMMONER_PATH, Thrown, bound, is_mayhem, js_number,
    mark_ignored_game, template, total_games,
};
use crate::commands::lcu::{BackfillLimit, BackfillOutcome, BackfillProgress, BackfillResult};
use crate::db::filters::{SEASONS, season_bounds};
use crate::db::js;
use crate::db::settings::{get_setting, set_setting};

pub const SGP_HOSTS: [&str; 4] = [
    "https://usw2-red.pp.sgp.pvp.net",
    "https://euc1-red.pp.sgp.pvp.net",
    "https://apne1-red.pp.sgp.pvp.net",
    "https://apse1-red.pp.sgp.pvp.net",
];

/// `SGP_HOST_BY_REGION`: a first guess only, since the service is sharded by
/// geography, not by game region.
fn host_for_region(region: &str) -> Option<&'static str> {
    let shard = match region {
        "NA" | "BR" | "LAN" | "LAS" | "LA1" | "LA2" => 0,
        "EUW" | "EUNE" | "EUN" | "TR" | "RU" | "ME" => 1,
        "KR" | "JP" => 2,
        "OCE" | "OC1" | "PH" | "SG" | "TH" | "TW" | "VN" => 3,
        _ => return None,
    };
    Some(SGP_HOSTS[shard])
}

/// The service clamps `count` to 200, so this is the biggest page it serves.
const SGP_PAGE_SIZE: usize = 200;
/// A bound against a runaway loop only; Riot's window ends in about five pages.
const SGP_MAX_PAGES: usize = 25;
const SGP_MAYHEM_TAGS: &str = "tag=q_2400&tag=q_2450&tagsQueryType=OR";
const SGP_ALL_TAGS: &str = "tagsQueryType=AND";
/// How many new games to store before nudging the page to re-query.
const GAMES_UPDATED_BATCH: i64 = 25;
/// Shards are probed in turn, so one that hangs must not stall the search.
pub const SGP_PROBE_TIMEOUT: Duration = Duration::from_millis(8_000);
pub const SGP_PAGE_TIMEOUT: Duration = Duration::from_millis(30_000);
/// Errors that may mean the remembered shard stopped serving this account.
const SGP_REHOME_STATUSES: [u16; 3] = [401, 403, 404];

/// One answer from the match history service.
pub struct SgpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl SgpResponse {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// `response.json()`, failing with V8's `JSON.parse` messages.
    fn json(&self) -> Result<Value, Thrown> {
        // undici drops a byte order mark before parsing
        let body = self
            .body
            .strip_prefix(b"\xef\xbb\xbf")
            .unwrap_or(&self.body);
        serde_json::from_slice(body).map_err(|err| Thrown::Error(json_parse_message(body, &err)))
    }
}

/// V8's message for a `JSON.parse` failure at the character serde stopped on.
fn json_parse_message(body: &[u8], err: &serde_json::Error) -> String {
    if err.is_eof() {
        return "Unexpected end of JSON input".into();
    }
    let text = String::from_utf8_lossy(body);
    let chars: Vec<char> = text.chars().collect();
    // serde counts lines and columns from 1
    let line_start: usize = text
        .split('\n')
        .take(err.line().saturating_sub(1))
        .map(|line| line.chars().count() + 1)
        .sum();
    let at = (line_start + err.column().saturating_sub(1)).min(chars.len().saturating_sub(1));
    if err.to_string().starts_with("trailing characters") {
        return format!("Unexpected non-whitespace character after JSON at position {at}");
    }
    // A short source is quoted whole; a longer one by ten characters each side
    const CONTEXT: usize = 10;
    let token = chars.get(at).copied().unwrap_or_default();
    let quoted = if chars.len() <= CONTEXT * 2 {
        format!("\"{text}\"")
    } else {
        let from = at.saturating_sub(CONTEXT);
        let to = (at + CONTEXT).min(chars.len());
        let window: String = chars[from..to].iter().collect();
        let before = if from > 0 { "..." } else { "" };
        let after = if to < chars.len() { "..." } else { "" };
        format!("{before}\"{window}\"{after}")
    };
    format!("Unexpected token '{token}', {quoted} is not valid JSON")
}

/// Riot's match history service: Node's global `fetch` with a Bearer token
/// and a timeout covering the whole answer, body included.
pub trait Sgp: Send + Sync {
    fn get<'a>(
        &'a self,
        url: &'a str,
        token: &'a str,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<SgpResponse, Thrown>>;
}

/// Why a walk stopped. `Exhausted` is the ambiguous one: the end of the
/// account's history and the edge of Riot's window answer the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WalkStop {
    Exhausted,
    Known,
    PageLimit,
}

struct Walk {
    ids: Vec<f64>,
    stopped_by: WalkStop,
    mayhem_only: bool,
}

fn sgp_url(host: &str, puuid: &str, start: usize, count: usize, tags: &str) -> String {
    format!(
        "{host}/match-history-query/v1/products/lol/player/{puuid}?startIndex={start}&count={count}&{tags}"
    )
}

/// `matchIdNumber`: ids arrive platform-prefixed, as `NA1_5616465966`.
fn match_id_number(id: &Value) -> Option<f64> {
    let text = template(Some(id));
    let last = text.rsplit('_').next().unwrap_or_default();
    Some(js::string_to_number(last)).filter(|n| n.is_finite())
}

/// A `Set` of numbers, keyed as SameValueZero compares them.
fn id_key(id: f64) -> u64 {
    (id + 0.0).to_bits()
}

/// Clears the running flags however the walk ends, as the `finally` does.
struct Running<'a>(&'a GameSync);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state();
        state.backfill_running = false;
        state.backfill_cancelled = false;
    }
}

impl GameSync {
    pub fn cancel_backfill(&self) {
        let mut state = self.state();
        if state.backfill_running {
            state.backfill_cancelled = true;
        }
    }

    pub fn is_backfill_running(&self) -> bool {
        self.state().backfill_running
    }

    fn backfill_cancelled(&self) -> bool {
        self.state().backfill_cancelled
    }

    /// `backfillHistory`. `full` walks every page Riot serves instead of
    /// stopping at the first one already known in full.
    pub async fn backfill_history(
        self: &Arc<Self>,
        client: &Arc<dyn Client>,
        full: bool,
    ) -> Result<BackfillResult, Thrown> {
        if !self.claim_backfill() {
            return Err(Thrown::Error("A backfill is already running".into()));
        }
        self.backfill_claimed(client, full).await
    }

    /// Marks a walk running, unless one already is.
    pub(super) fn claim_backfill(&self) -> bool {
        let mut state = self.state();
        if state.backfill_running {
            return false;
        }
        state.backfill_running = true;
        state.backfill_cancelled = false;
        true
    }

    /// The walk, once [`GameSync::claim_backfill`] has marked it running.
    pub(super) async fn backfill_claimed(
        self: &Arc<Self>,
        client: &Arc<dyn Client>,
        full: bool,
    ) -> Result<BackfillResult, Thrown> {
        let _running = Running(self);
        match self.walk_and_hydrate(client.as_ref(), full).await {
            Ok(result) => {
                self.env
                    .backfill_done(&BackfillOutcome::Done(result.clone()));
                Ok(result)
            }
            Err(err) => {
                self.env.backfill_done(&BackfillOutcome::Failed {
                    error: err.friendly(),
                });
                Err(err)
            }
        }
    }

    /// The command's answer: a failure is data, not a throw, so the page gets
    /// a clean message instead of Electron's invoke wrapper.
    pub async fn backfill_from_settings(
        self: &Arc<Self>,
        client: &Arc<dyn Client>,
    ) -> BackfillOutcome {
        match self.backfill_history(client, true).await {
            Ok(result) => BackfillOutcome::Done(result),
            Err(err) => BackfillOutcome::Failed {
                error: err.friendly(),
            },
        }
    }

    async fn walk_and_hydrate(
        &self,
        client: &dyn Client,
        full: bool,
    ) -> Result<BackfillResult, Thrown> {
        // The token doesn't depend on who is signed in, so both are asked at once
        let (summoner, token) =
            tokio::join!(client.request_json(SUMMONER_PATH), fetch_sgp_token(client));
        let summoner = summoner?;
        self.upsert_summoner(&summoner)?;
        let puuid_value = js::prop(Some(&summoner), "puuid")?;
        let puuid = template(puuid_value);

        let token = token?;
        let host = self.resolve_sgp_host(client, &puuid, &token).await?;

        let known: HashSet<u64> = self
            .db(crate::db::ingest::get_known_game_ids)?
            .into_iter()
            .map(|id| id_key(id as f64))
            .collect();

        // Once an account has been walked all the way back, a run that only
        // wants the new games can stop at the first page it knows in full
        let completed_key = format!("backfill_complete_{puuid}");
        let walked_before =
            self.db(|conn| get_setting(conn, &completed_key))?.as_str() == Some("1");
        let stop_at_known = walked_before && !full;
        let stop_after =
            |page: &[f64]| stop_at_known && page.iter().all(|id| known.contains(&id_key(*id)));

        let mut active = host;
        let mut walked = match self.walk_shard(&active, &puuid, &token, &stop_after).await {
            Ok(walked) => walked,
            Err(err) => {
                // The remembered shard may simply be the wrong one now
                let rehome =
                    matches!(err, Thrown::SgpHttp(status) if SGP_REHOME_STATUSES.contains(&status));
                if !rehome {
                    return Err(err);
                }
                let Some(rehomed) = self.rehome_sgp_host(client, &puuid, &token, &active).await
                else {
                    return Err(err);
                };
                active = rehomed;
                self.walk_shard(&active, &puuid, &token, &stop_after)
                    .await?
            }
        };

        // No games at all is also how a shard that doesn't hold the player answers
        if walked.ids.is_empty()
            && let Some(rehomed) = self.rehome_sgp_host(client, &puuid, &token, &active).await
        {
            active = rehomed;
            walked = self
                .walk_shard(&active, &puuid, &token, &stop_after)
                .await?;
        }

        let mut limit = None;
        match walked.stopped_by {
            WalkStop::PageLimit => {
                limit = Some(BackfillLimit::Paging);
                crate::log::warn(format!(
                    "Backfill stopped at the {SGP_MAX_PAGES}-page limit ({} games); older games were not checked",
                    walked.ids.len()
                ));
            }
            WalkStop::Exhausted => {
                if let Some(start) = self
                    .truncated_history_start(client, &active, &puuid, &token, &walked)
                    .await
                {
                    limit = Some(BackfillLimit::Service {
                        history_start: start as i64,
                    });
                    log(format!(
                        "Riot's match history for this account only reaches back to {}; nothing older than the {} games found can be fetched",
                        iso_string(start),
                        walked.ids.len()
                    ));
                }
            }
            WalkStop::Known => {}
        }

        let pending: Vec<f64> = walked
            .ids
            .iter()
            .copied()
            .filter(|id| !known.contains(&id_key(*id)))
            .collect();
        let total = pending.len() as i64;
        let progress = |current: usize, added: i64| {
            self.env.backfill_progress(&BackfillProgress {
                current: current as i64,
                total,
                added,
            })
        };
        // A check that finds nothing has no progress to report, and a bar for
        // it would flash at the player every few hours
        if !pending.is_empty() {
            progress(0, 0);
        }

        let mut added = 0;
        let mut announced = 0;
        // A first walk can fetch hundreds of games one request each, so a few
        // are kept in flight. They still arrive in walk order, which keeps the
        // progress and the stored rows as a one-at-a-time walk leaves them.
        let mut details = futures_util::stream::iter(pending.iter().copied().enumerate())
            .map(|(i, game_id)| async move {
                // A cancel stops the requests not yet sent; any already sent
                // still land, as the one in flight did when this went one at a time
                if self.backfill_cancelled() {
                    return (i, game_id, None);
                }
                let path = format!(
                    "/lol-match-history/v1/games/{}",
                    js::number_to_string(game_id)
                );
                (i, game_id, Some(client.request_json(&path).await))
            })
            .buffered(DETAILS_IN_FLIGHT);
        while let Some((i, game_id, detail)) = details.next().await {
            let Some(detail) = detail else {
                break;
            };
            let Ok(game) = detail else {
                // Left unrecorded, so a later run retries it
                progress(i + 1, added);
                continue;
            };
            if !is_mayhem(js::prop(Some(&game), "queueId")?) {
                self.db(|conn| mark_ignored_game(conn, &bound(game_id)))?;
            } else if self.insert_game(&game, puuid_value)? {
                added += 1;
                log(format!(
                    "Backfilled ARAM Mayhem game {}",
                    js::number_to_string(game_id)
                ));
            }
            // The app fills in as the walk goes rather than staying empty for minutes
            if added - announced >= GAMES_UPDATED_BATCH {
                announced = added;
                self.env.games_updated();
            }
            progress(i + 1, added);
        }

        let cancelled = self.backfill_cancelled();
        // Claimed only once every id is resolved, or a later run would stop
        // early and never reach the games skipped. Riot's window still counts:
        // it is as deep as the account goes.
        if limit != Some(BackfillLimit::Paging) && !cancelled {
            self.db(|conn| set_setting(conn, &completed_key, "1"))?;
        } else {
            // Neither outcome marks the account walked, so without this the
            // poll would relaunch the walk a minute later, even after a cancel
            self.pause_auto_backfill(Pause::Forever);
        }

        if added > announced {
            self.env.games_updated();
        }

        Ok(BackfillResult {
            added,
            scanned: walked.ids.len() as i64,
            checked: total,
            total_games: self.db(total_games)?,
            limit,
            cancelled,
        })
    }

    async fn walk_shard(
        &self,
        host: &str,
        puuid: &str,
        token: &str,
        stop_after: &(dyn Fn(&[f64]) -> bool + Sync),
    ) -> Result<Walk, Thrown> {
        // Riot's tag names could change under us, and a filtered walk that
        // finds nothing looks like an account with no Mayhem games
        let (ids, stopped_by) = self
            .fetch_all_match_ids(host, puuid, token, SGP_MAYHEM_TAGS, stop_after)
            .await?;
        if !ids.is_empty() {
            return Ok(Walk {
                ids,
                stopped_by,
                mayhem_only: true,
            });
        }
        let (ids, stopped_by) = self
            .fetch_all_match_ids(host, puuid, token, SGP_ALL_TAGS, stop_after)
            .await?;
        Ok(Walk {
            ids,
            stopped_by,
            mayhem_only: false,
        })
    }

    async fn fetch_all_match_ids(
        &self,
        host: &str,
        puuid: &str,
        token: &str,
        tags: &str,
        stop_after: &(dyn Fn(&[f64]) -> bool + Sync),
    ) -> Result<(Vec<f64>, WalkStop), Thrown> {
        let mut ids = Vec::new();
        for page in 0..SGP_MAX_PAGES {
            let url = sgp_url(host, puuid, page * SGP_PAGE_SIZE, SGP_PAGE_SIZE, tags);
            let response = self.sgp.get(&url, token, SGP_PAGE_TIMEOUT).await?;
            if !response.ok() {
                return Err(Thrown::SgpHttp(response.status));
            }
            let body = match response.json()? {
                Value::Array(body) if !body.is_empty() => body,
                _ => return Ok((ids, WalkStop::Exhausted)),
            };
            let page_ids: Vec<f64> = body.iter().filter_map(match_id_number).collect();
            ids.extend_from_slice(&page_ids);
            // A short page means the service has no more to give
            if body.len() < SGP_PAGE_SIZE {
                return Ok((ids, WalkStop::Exhausted));
            }
            if stop_after(&page_ids) {
                return Ok((ids, WalkStop::Known));
            }
        }
        Ok((ids, WalkStop::PageLimit))
    }

    /// `probeSgpHost`. Every shard answers every player, and one that doesn't
    /// hold them sends an empty list, so only a shard that returns a game is
    /// remembered. With none, the first that answered is as good as any.
    async fn probe_sgp_host(
        &self,
        client: &dyn Client,
        puuid: &str,
        token: &str,
        skip: Option<&str>,
    ) -> Option<(String, bool)> {
        let guess = match client.request_json("/riotclient/region-locale").await {
            Ok(locale) => {
                let region = js::opt_prop(Some(&locale), "region");
                let region = if js::truthy(region) {
                    template(region)
                } else {
                    String::new()
                };
                host_for_region(&region.to_uppercase())
            }
            Err(_) => None,
        };
        let candidates: Vec<&str> = match guess {
            Some(guess) => std::iter::once(guess)
                .chain(SGP_HOSTS.iter().copied().filter(|h| *h != guess))
                .collect(),
            None => SGP_HOSTS.to_vec(),
        };

        let mut answered = None;
        for host in candidates {
            if Some(host) == skip {
                continue;
            }
            let url = sgp_url(host, puuid, 0, 1, SGP_ALL_TAGS);
            let Ok(response) = self.sgp.get(&url, token, SGP_PROBE_TIMEOUT).await else {
                continue;
            };
            if !response.ok() {
                continue;
            }
            let Ok(body) = response.json() else {
                continue;
            };
            if matches!(&body, Value::Array(games) if !games.is_empty()) {
                self.state().sgp_host = Some(host.to_string());
                // Inside the same try as the request, so a failed write just
                // moves on to the next shard
                if self.db(|conn| set_setting(conn, "sgp_host", host)).is_err() {
                    continue;
                }
                return Some((host.to_string(), true));
            }
            answered.get_or_insert(host);
        }
        answered.map(|host| (host.to_string(), false))
    }

    async fn resolve_sgp_host(
        &self,
        client: &dyn Client,
        puuid: &str,
        token: &str,
    ) -> Result<String, Thrown> {
        if let Some(host) = self.state().sgp_host.clone() {
            return Ok(host);
        }
        let cached = self.db(|conn| get_setting(conn, "sgp_host"))?;
        if let Some(cached) = cached
            .as_str()
            .map(str::to_owned)
            .filter(|c| SGP_HOSTS.contains(&c.as_str()))
        {
            self.state().sgp_host = Some(cached.clone());
            return Ok(cached);
        }
        match self.probe_sgp_host(client, puuid, token, None).await {
            Some((host, _)) => Ok(host),
            None => Err(Thrown::Error(
                "Could not reach Riot's match history service for your region".into(),
            )),
        }
    }

    /// Only a shard that returns this player's games replaces the one
    /// remembered: an expired token fails everywhere, and an account with no
    /// games looks the same on every shard.
    async fn rehome_sgp_host(
        &self,
        client: &dyn Client,
        puuid: &str,
        token: &str,
        failed: &str,
    ) -> Option<String> {
        self.state().sgp_host = None;
        match self
            .probe_sgp_host(client, puuid, token, Some(failed))
            .await
        {
            Some((host, true)) => {
                crate::log::warn(format!(
                    "Match history shard {failed} no longer serves this account; moved to {host}"
                ));
                Some(host)
            }
            _ => {
                self.state().sgp_host = Some(failed.to_string());
                None
            }
        }
    }

    async fn sgp_page(
        &self,
        host: &str,
        puuid: &str,
        token: &str,
        start: usize,
    ) -> Option<Vec<Value>> {
        let url = sgp_url(host, puuid, start, SGP_PAGE_SIZE, SGP_ALL_TAGS);
        let response = self.sgp.get(&url, token, SGP_PAGE_TIMEOUT).await.ok()?;
        if !response.ok() {
            return None;
        }
        match response.json().ok()? {
            Value::Array(body) => Some(body),
            _ => None,
        }
    }

    /// `oldestServedGame`: the window applies before any tag filter, so a
    /// Mayhem-only walk ends on its oldest Mayhem game, not the window's edge.
    async fn oldest_served_game(
        &self,
        host: &str,
        puuid: &str,
        token: &str,
        walked: &Walk,
    ) -> Option<f64> {
        if !walked.mayhem_only {
            return walked.ids.last().copied();
        }
        let mut oldest = None;
        let mut start = walked.ids.len().saturating_sub(1);
        for _ in 0..SGP_MAX_PAGES {
            let body = self.sgp_page(host, puuid, token, start).await?;
            if let Some(last) = body.last() {
                oldest = match_id_number(last);
            }
            if body.len() < SGP_PAGE_SIZE {
                return oldest;
            }
            start += SGP_PAGE_SIZE;
        }
        None
    }

    /// When Riot's history for the account starts, if after Mayhem began.
    async fn truncated_history_start(
        &self,
        client: &dyn Client,
        host: &str,
        puuid: &str,
        token: &str,
        walked: &Walk,
    ) -> Option<f64> {
        let game_id = self.oldest_served_game(host, puuid, token, walked).await?;
        let path = format!(
            "/lol-match-history/v1/games/{}",
            js::number_to_string(game_id)
        );
        let game = client.request_json(&path).await.ok()?;
        let created = js_number(js::opt_prop(Some(&game), "gameCreation"));
        let launch = season_bounds(&SEASONS[0]).from?;
        (created.is_finite() && created >= launch as f64).then_some(created)
    }
}

/// The RSO access token, which the service's entitlement follows, with the
/// older league-session token as a fallback.
async fn fetch_sgp_token(client: &dyn Client) -> Result<String, Thrown> {
    if let Ok(rso) = client
        .request_json("/lol-rso-auth/v1/authorization/access-token")
        .await
    {
        let token = match &rso {
            Value::String(_) => Some(&rso),
            _ => js::opt_prop(Some(&rso), "token"),
        };
        if let Some(Value::String(token)) = token
            && !token.is_empty()
        {
            return Ok(token.clone());
        }
    }
    match client
        .request_json("/lol-league-session/v1/league-session-token")
        .await?
    {
        Value::String(token) if !token.is_empty() => Ok(token),
        _ => Err(Thrown::Error(
            "League client hasn't finished signing in — try again in a moment".into(),
        )),
    }
}

/// `new Date(ms).toISOString()`.
fn iso_string(ms: f64) -> String {
    jiff::Timestamp::from_millisecond(ms as i64)
        .map(|t| t.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_else(|_| "Invalid Date".into())
}

/// The service over public roots, as Node's `fetch` reaches it. A parity build
/// sends it to the fake service its environment names, and nowhere else.
pub struct HttpSgp {
    /// Or why it could not be built, which every request then fails with
    client: Result<reqwest::Client, String>,
    /// `BMT_PARITY_SGP_URL`, read once at launch as the seam reads it
    #[cfg(feature = "parity-ca")]
    fake: Option<String>,
}

#[cfg(feature = "parity-ca")]
pub const PARITY_SGP_URL_ENV: &str = "BMT_PARITY_SGP_URL";

impl HttpSgp {
    #[cfg(not(feature = "parity-ca"))]
    pub fn new() -> Self {
        Self {
            client: Self::client(),
        }
    }

    #[cfg(feature = "parity-ca")]
    pub fn new() -> Self {
        Self::with_fake(std::env::var(PARITY_SGP_URL_ENV).ok())
    }

    #[cfg(feature = "parity-ca")]
    fn with_fake(fake: Option<String>) -> Self {
        Self {
            client: Self::client(),
            fake: fake.filter(|u| !u.is_empty()),
        }
    }

    fn client() -> Result<reqwest::Client, String> {
        let client = super::tls::public_config()
            .map_err(|err| err.to_string())
            .and_then(|tls| {
                let builder = reqwest::Client::builder()
                    .tls_backend_preconfigured(tls)
                    .no_gzip()
                    .no_proxy();
                // A redirect would carry the request off the fake's origin
                #[cfg(feature = "parity-ca")]
                let builder = builder.redirect(reqwest::redirect::Policy::none());
                builder.build().map_err(|err| err.to_string())
            });
        if let Err(err) = &client {
            log(format!("Match history client failed to build: {err}"));
        }
        client
    }

    #[cfg(not(feature = "parity-ca"))]
    fn route(&self, url: &str) -> Result<String, Thrown> {
        Ok(url.to_string())
    }

    /// The seam's fetch redirect: a `*.pp.sgp.pvp.net` URL keeps its path and
    /// query on the fake's origin. With no fake named, or one that is not a
    /// loopback address, nothing is sent.
    #[cfg(feature = "parity-ca")]
    fn route(&self, url: &str) -> Result<String, Thrown> {
        let rest = SGP_HOSTS.iter().find_map(|host| url.strip_prefix(host));
        let routed = match (&self.fake, rest) {
            (Some(fake), Some(rest)) => Some(format!("{}{rest}", fake.trim_end_matches('/'))),
            _ => None,
        };
        match routed {
            Some(routed) if is_loopback(&routed) => Ok(routed),
            _ => {
                log(format!("parity: blocked a request to {url}"));
                Err(Thrown::Error("fetch failed".into()))
            }
        }
    }
}

/// An http or https URL whose host is a loopback IP literal, with no
/// userinfo. A name such as `localhost` resolves through files the run does
/// not control.
#[cfg(feature = "parity-ca")]
fn is_loopback(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    // The parser has already normalized the host, and brackets an IPv6 one
    let loopback = url
        .host_str()
        .map(|host| host.trim_start_matches('[').trim_end_matches(']'))
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback());
    loopback
        && matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

impl Sgp for HttpSgp {
    fn get<'a>(
        &'a self,
        url: &'a str,
        token: &'a str,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<SgpResponse, Thrown>> {
        Box::pin(async move {
            let url = self.route(url)?;
            let Ok(client) = &self.client else {
                return Err(Thrown::Error("fetch failed".into()));
            };
            let request = async {
                let response = client.get(url).bearer_auth(token).send().await?;
                let status = response.status().as_u16();
                Ok::<_, reqwest::Error>(SgpResponse {
                    status,
                    body: response.bytes().await?.to_vec(),
                })
            };
            match tokio::time::timeout(timeout, request).await {
                Ok(Ok(response)) => Ok(response),
                // Node's own messages, which reach the player's toast as they are
                Ok(Err(_)) => Err(Thrown::Error("fetch failed".into())),
                Err(_) => Err(Thrown::Error(
                    "The operation was aborted due to timeout".into(),
                )),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::sync::rig::{Reply, Rig, detail_path, payload, rig};
    use super::*;
    use serde_json::json;

    fn query_number(url: &str, key: &str) -> usize {
        url.split(['?', '&'])
            .find_map(|pair| pair.strip_prefix(&format!("{key}=")))
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    }

    /// The match history service listing `ids`, newest first, as the fake does.
    fn serve(rig: &Rig, ids: Vec<i64>) {
        *rig.sgp.answer.lock().unwrap() = Box::new(move |url| {
            let start = query_number(url, "startIndex");
            let count = query_number(url, "count");
            let page: Vec<String> = ids
                .iter()
                .skip(start)
                .take(count)
                .map(|id| format!("NA1_{id}"))
                .collect();
            Reply::Json(json!(page))
        });
    }

    fn games(rig: &Rig, ids: &[i64], delay: Duration) {
        for id in ids {
            rig.client.route(
                &detail_path(*id),
                vec![Reply::After(
                    delay,
                    Box::new(Reply::Json(payload(*id, 2400))),
                )],
            );
        }
    }

    fn hosts(rig: &Rig) -> Vec<String> {
        rig.sgp
            .urls()
            .iter()
            .map(|url| {
                url.split("/match-history-query")
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    async fn run(rig: &Rig, full: bool) -> Result<BackfillResult, Thrown> {
        rig.sync.backfill_history(&rig.dyn_client, full).await
    }

    #[tokio::test(start_paused = true)]
    async fn a_walk_hydrates_the_new_games_and_reports_like_electron() {
        let rig = rig("backfill-done");
        serve(&rig, vec![103, 102, 101]);
        games(&rig, &[103, 102, 101], Duration::ZERO);
        let result = run(&rig, true).await.unwrap();

        // 1_789_999_999_899 is after Mayhem's first day, so the window is Riot's
        let done = json!({"added": 3, "scanned": 3, "checked": 3, "totalGames": 3,
            "limit": {"kind": "service", "historyStart": 1_789_999_999_899_i64}, "cancelled": false});
        assert_eq!(serde_json::to_value(&result).unwrap(), done);
        assert_eq!(
            rig.env.events(),
            [
                r#"lcu:backfill-progress {"current":0,"total":3,"added":0}"#.to_string(),
                r#"lcu:backfill-progress {"current":1,"total":3,"added":1}"#.into(),
                r#"lcu:backfill-progress {"current":2,"total":3,"added":2}"#.into(),
                r#"lcu:backfill-progress {"current":3,"total":3,"added":3}"#.into(),
                "lcu:games-updated null".into(),
                format!("lcu:backfill-done {done}"),
            ]
        );
        // The Mayhem walk, then the unfiltered page its oldest game sits on
        assert_eq!(
            rig.sgp.urls(),
            [
                "https://usw2-red.pp.sgp.pvp.net/match-history-query/v1/products/lol/player/me?startIndex=0&count=1&tagsQueryType=AND",
                "https://usw2-red.pp.sgp.pvp.net/match-history-query/v1/products/lol/player/me?startIndex=0&count=200&tag=q_2400&tag=q_2450&tagsQueryType=OR",
                "https://usw2-red.pp.sgp.pvp.net/match-history-query/v1/products/lol/player/me?startIndex=2&count=200&tagsQueryType=AND",
            ]
        );
        assert_eq!(
            rig.sgp.timeouts(),
            [SGP_PROBE_TIMEOUT, SGP_PAGE_TIMEOUT, SGP_PAGE_TIMEOUT]
        );
        assert_eq!(
            rig.env
                .query::<String>("SELECT value FROM settings WHERE key = 'backfill_complete_me'"),
            "1"
        );
        assert_eq!(
            rig.env
                .query::<String>("SELECT value FROM settings WHERE key = 'sgp_host'"),
            SGP_HOSTS[0]
        );
        assert!(!rig.sync.is_backfill_running());
    }

    #[tokio::test(start_paused = true)]
    async fn shards_are_probed_region_first_then_in_order() {
        let rig = rig("backfill-probe");
        rig.client.route(
            "/riotclient/region-locale",
            vec![Reply::Json(json!({"region": "euw"}))],
        );
        // Only the last shard holds the player
        *rig.sgp.answer.lock().unwrap() = Box::new(|url| {
            if url.starts_with(SGP_HOSTS[3]) {
                Reply::Json(json!(["EUW1_1"]))
            } else if url.starts_with(SGP_HOSTS[0]) {
                Reply::Hang
            } else {
                Reply::Status(500)
            }
        });
        games(&rig, &[1], Duration::ZERO);
        run(&rig, true).await.unwrap();
        let probed: Vec<String> = hosts(&rig).into_iter().take(4).collect();
        assert_eq!(
            probed,
            [SGP_HOSTS[1], SGP_HOSTS[0], SGP_HOSTS[2], SGP_HOSTS[3]]
        );
        assert_eq!(
            rig.env
                .query::<String>("SELECT value FROM settings WHERE key = 'sgp_host'"),
            SGP_HOSTS[3]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn with_no_region_every_shard_is_probed_in_order_and_the_first_answer_kept() {
        let rig = rig("backfill-no-region");
        rig.client
            .route("/riotclient/region-locale", vec![Reply::Status(404)]);
        let result = run(&rig, true).await.unwrap();
        // Four probes, then both walks on the first shard that answered, then
        // a rehome that probes the other three and finds nobody
        assert_eq!(
            hosts(&rig),
            [
                SGP_HOSTS[0],
                SGP_HOSTS[1],
                SGP_HOSTS[2],
                SGP_HOSTS[3],
                SGP_HOSTS[0],
                SGP_HOSTS[0],
                SGP_HOSTS[1],
                SGP_HOSTS[2],
                SGP_HOSTS[3],
            ]
        );
        assert_eq!(result.scanned, 0);
        assert_eq!(result.limit, None);
        assert_eq!(
            rig.env
                .query::<i64>("SELECT count(*) FROM settings WHERE key = 'sgp_host'"),
            0,
            "a shard that only answered is not remembered"
        );
        assert_eq!(
            rig.env.events(),
            [
                r#"lcu:backfill-done {"added":0,"scanned":0,"checked":0,"totalGames":0,"limit":null,"cancelled":false}"#
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_stops_after_the_request_in_flight() {
        let rig = rig("backfill-cancel");
        let ids: Vec<i64> = (1..=10).rev().collect();
        serve(&rig, ids.clone());
        games(&rig, &ids, Duration::from_secs(1));
        let sync = rig.sync.clone();
        let canceller = tokio::spawn(async move {
            // Mid-way through the first window of requests
            tokio::time::sleep(Duration::from_millis(1_500)).await;
            sync.cancel_backfill();
        });
        let result = run(&rig, true).await.unwrap();
        canceller.await.unwrap();

        let fetched: Vec<String> = rig
            .client
            .paths()
            .into_iter()
            .filter(|p| p.starts_with("/lol-match-history/v1/games/"))
            .collect();
        // The window probe's detail request, then games 10 to 7, the window
        // in flight when the cancel landed; nothing after it is asked for
        assert_eq!(
            fetched,
            [
                detail_path(1),
                detail_path(10),
                detail_path(9),
                detail_path(8),
                detail_path(7)
            ]
        );
        assert!(result.cancelled);
        assert_eq!((result.added, result.checked), (4, 10));
        assert_eq!(rig.env.event_times("lcu:backfill-progress").len(), 5);
        assert_eq!(
            rig.env
                .query::<i64>("SELECT count(*) FROM settings WHERE key = 'backfill_complete_me'"),
            0,
            "a cancelled walk is not a complete one"
        );
        assert!(
            !rig.sync.auto_backfill_allowed(),
            "and the poll does not relaunch it"
        );
        assert!(!rig.sync.is_backfill_running());
    }

    #[tokio::test(start_paused = true)]
    async fn a_walk_keeps_a_few_game_requests_in_flight_and_stores_them_in_order() {
        let rig = rig("backfill-in-flight");
        let ids: Vec<i64> = (1..=10).rev().collect();
        serve(&rig, ids.clone());
        games(&rig, &ids, Duration::from_secs(1));
        let result = run(&rig, true).await.unwrap();

        // After the window probe's one second, four at a time
        let started: Vec<u128> = ids
            .iter()
            .map(|id| *rig.client.times(&detail_path(*id)).last().unwrap())
            .collect();
        assert_eq!(
            started,
            [
                1_000, 1_000, 1_000, 1_000, 2_000, 2_000, 2_000, 2_000, 3_000, 3_000
            ]
        );
        assert_eq!((result.added, result.checked), (10, 10));
        let progress: Vec<String> = rig
            .env
            .events()
            .into_iter()
            .filter(|event| event.starts_with("lcu:backfill-progress"))
            .collect();
        let expected: Vec<String> = (0..=10)
            .map(|i| format!(r#"lcu:backfill-progress {{"current":{i},"total":10,"added":{i}}}"#))
            .collect();
        assert_eq!(progress, expected);
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_does_nothing_when_no_walk_runs() {
        let rig = rig("backfill-cancel-idle");
        rig.sync.cancel_backfill();
        serve(&rig, vec![1]);
        games(&rig, &[1], Duration::ZERO);
        assert!(!run(&rig, true).await.unwrap().cancelled);
    }

    #[tokio::test(start_paused = true)]
    async fn a_service_error_reaches_the_toast_and_the_answer() {
        let rig = rig("backfill-error");
        rig.env
            .exec("INSERT INTO settings (key, value) VALUES ('sgp_host', 'https://usw2-red.pp.sgp.pvp.net')");
        *rig.sgp.answer.lock().unwrap() = Box::new(|_| Reply::Status(500));
        let outcome = rig.sync.backfill_from_settings(&rig.dyn_client).await;
        let failed = json!({"error": "Match history service returned 500"});
        assert_eq!(serde_json::to_value(&outcome).unwrap(), failed);
        assert_eq!(rig.env.events(), [format!("lcu:backfill-done {failed}")]);
        assert!(!rig.sync.is_backfill_running());
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_walk_while_one_runs_is_refused_without_a_done_event() {
        let rig = rig("backfill-twice");
        serve(&rig, vec![1]);
        rig.client.route(&detail_path(1), vec![Reply::Hang]);
        let sync = rig.sync.clone();
        let client = rig.dyn_client.clone();
        let first = tokio::spawn(async move { sync.backfill_history(&client, true).await });
        tokio::time::sleep(Duration::from_secs(1)).await;
        let second = rig.sync.backfill_from_settings(&rig.dyn_client).await;
        assert_eq!(
            serde_json::to_value(&second).unwrap(),
            json!({"error": "A backfill is already running"})
        );
        assert!(rig.env.event_times("lcu:backfill-done").is_empty());
        first.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_rejected_shard_is_rehomed_and_the_walk_restarts_there() {
        rehome().await;
    }

    async fn rehome() {
        let rig = rig("backfill-rehome");
        rig.env
            .exec("INSERT INTO settings (key, value) VALUES ('sgp_host', 'https://usw2-red.pp.sgp.pvp.net')");
        *rig.sgp.answer.lock().unwrap() = Box::new(|url| {
            if url.starts_with(SGP_HOSTS[0]) {
                Reply::Status(403)
            } else if url.starts_with(SGP_HOSTS[2]) {
                Reply::Json(json!(["KR_5"]))
            } else {
                Reply::Json(json!([]))
            }
        });
        games(&rig, &[5], Duration::ZERO);
        let result = run(&rig, true).await.unwrap();
        assert_eq!(result.added, 1);
        assert_eq!(
            hosts(&rig)[..4],
            [SGP_HOSTS[0], SGP_HOSTS[1], SGP_HOSTS[2], SGP_HOSTS[2]]
        );
        assert_eq!(
            rig.env
                .query::<String>("SELECT value FROM settings WHERE key = 'sgp_host'"),
            SGP_HOSTS[2]
        );
    }

    /// The child half of [`a_rehome_is_a_warning_in_the_apps_log`]: the app's
    /// log is one per process, so the rehome runs where nothing else starts it.
    #[tokio::test(start_paused = true)]
    async fn rehome_log_child() {
        let Some(data_root) = std::env::var_os("BMT_REHOME_LOG_ROOT") else {
            return;
        };
        crate::log::start(
            crate::paths::Paths::at(std::path::Path::new(&data_root)),
            "9.9.9",
        );
        rehome().await;
    }

    /// `lcu.ts` writes the rehome with `console.warn`, so it is a timestamped
    /// `WARN` line in `logs/main.log`, not a terminal-only line.
    #[test]
    fn a_rehome_is_a_warning_in_the_apps_log() {
        let data_root = std::env::temp_dir().join(format!("bmt-rehome-log-{}", std::process::id()));
        std::fs::create_dir_all(&data_root).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "lcu::backfill::tests::rehome_log_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("BMT_REHOME_LOG_ROOT", &data_root)
            .output()
            .expect("run the child");
        assert!(output.status.success(), "{output:?}");
        let log = std::fs::read_to_string(data_root.join("logs/main.log")).unwrap();
        let line = log
            .lines()
            .find(|l| l.contains("no longer serves this account"))
            .expect("the rehome's line");
        assert!(
            line.ends_with(&format!(
                " WARN Match history shard {} no longer serves this account; moved to {}",
                SGP_HOSTS[0], SGP_HOSTS[2]
            )),
            "{line}"
        );
        std::fs::remove_dir_all(data_root).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn the_page_is_told_to_requery_every_twenty_five_games() {
        let rig = rig("backfill-batches");
        let ids: Vec<i64> = (1..=30).rev().collect();
        serve(&rig, ids.clone());
        games(&rig, &ids, Duration::ZERO);
        run(&rig, true).await.unwrap();
        let events = rig.env.events();
        let updated: Vec<usize> = events
            .iter()
            .enumerate()
            .filter(|(_, e)| e.starts_with("lcu:games-updated"))
            .map(|(i, _)| i)
            .collect();
        // Before the 25th game's progress, and once more for the last five
        assert_eq!(updated, [25, 32]);
        assert_eq!(
            events[26],
            r#"lcu:backfill-progress {"current":25,"total":30,"added":25}"#
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_walked_account_stops_at_the_first_page_it_knows() {
        let rig = rig("backfill-known-page");
        let ids: Vec<i64> = (1..=450).rev().collect();
        serve(&rig, ids.clone());
        rig.env
            .exec("INSERT INTO settings (key, value) VALUES ('backfill_complete_me', '1')");
        for id in &ids[..200] {
            rig.env.exec(&format!(
                "INSERT INTO ignored_games (game_id) VALUES ({id})"
            ));
        }
        let result = run(&rig, false).await.unwrap();
        assert_eq!((result.scanned, result.checked), (200, 0));
        assert_eq!(
            result.limit, None,
            "a walk stopped on known games says nothing about the window"
        );
        assert!(rig.env.event_times("lcu:backfill-progress").is_empty());
    }

    #[test]
    fn a_body_that_is_not_json_fails_with_v8s_message() {
        let message = |body: &[u8]| {
            SgpResponse {
                status: 200,
                body: body.to_vec(),
            }
            .json()
            .map_err(|err| err.to_string())
        };
        let failed = |body: &str| message(body.as_bytes()).unwrap_err();
        assert_eq!(failed(""), "Unexpected end of JSON input");
        assert_eq!(failed(r#"["NA1_1","#), "Unexpected end of JSON input");
        assert_eq!(
            failed("<html>"),
            r#"Unexpected token '<', "<html>" is not valid JSON"#
        );
        assert_eq!(
            failed("<html><body>Service Unavailable</body></html>"),
            r#"Unexpected token '<', "<html><bod"... is not valid JSON"#
        );
        assert_eq!(
            failed("[1] x"),
            "Unexpected non-whitespace character after JSON at position 4"
        );
        assert_eq!(message(b"\xef\xbb\xbf[]"), Ok(json!([])));
    }

    #[test]
    fn match_ids_read_as_number_reads_them() {
        let read = |v: Value| match_id_number(&v);
        assert_eq!(read(json!("NA1_5616465966")), Some(5_616_465_966.0));
        assert_eq!(read(json!("NA1_")), Some(0.0));
        assert_eq!(read(json!("NA1_0x10")), Some(16.0));
        assert_eq!(read(json!(" 12 ")), Some(12.0));
        assert_eq!(read(json!(42)), Some(42.0));
        assert_eq!(read(json!("NA1_inf")), None);
        assert_eq!(read(json!("NA1_Infinity")), None);
        assert_eq!(read(json!("NA1_abc")), None);
        assert_eq!(read(json!(null)), None);
    }
}

/// Loopback listeners only: nothing here can reach another host.
#[cfg(all(test, feature = "parity-ca"))]
mod parity_route {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]";

    fn sgp_url() -> String {
        format!(
            "{}/match-history-query/v1/products/lol/player/p/SUMMARY?startIndex=0&count=1",
            SGP_HOSTS[0]
        )
    }

    struct Listener {
        port: u16,
        hits: Arc<AtomicUsize>,
    }

    impl Listener {
        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
    }

    /// Answers every request on 127.0.0.1 with `reply`, and counts them.
    fn listen(reply: String) -> Listener {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                counted.fetch_add(1, Ordering::SeqCst);
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                stream.write_all(reply.as_bytes()).ok();
            }
        });
        Listener { port, hits }
    }

    #[tokio::test]
    async fn a_redirect_from_the_fake_is_not_followed() {
        let elsewhere = listen(OK.into());
        let fake = listen(format!(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            elsewhere.port
        ));
        let sgp = HttpSgp::with_fake(Some(format!("http://127.0.0.1:{}", fake.port)));
        let response = sgp
            .get(&sgp_url(), "token", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(response.status, 302);
        assert_eq!(fake.hits(), 1);
        assert_eq!(elsewhere.hits(), 0);
    }

    #[tokio::test]
    async fn a_fake_url_with_userinfo_sends_nothing() {
        let named = listen(OK.into());
        let behind = listen(OK.into());
        for fake in [
            format!("http://127.0.0.1:{}@127.0.0.1:{}", named.port, behind.port),
            format!("http://user:secret@127.0.0.1:{}", named.port),
        ] {
            let sgp = HttpSgp::with_fake(Some(fake.clone()));
            let sent = sgp.get(&sgp_url(), "token", Duration::from_secs(5)).await;
            assert!(sent.is_err(), "{fake} was sent");
        }
        assert_eq!(named.hits() + behind.hits(), 0);
    }

    #[test]
    fn only_a_loopback_fake_is_routed_to() {
        for fake in [
            "http://192.0.2.1:9",
            "http://localhost:9",
            "http://127.0.0.1.example.com:9",
            "https://example.com",
            "file:///etc/hosts",
            "127.0.0.1:9",
        ] {
            let routed = HttpSgp::with_fake(Some(fake.into())).route(&sgp_url());
            assert!(routed.is_err(), "{fake} was routed to");
        }
        let path = "/match-history-query/v1/products/lol/player/p/SUMMARY?startIndex=0&count=1";
        for fake in [
            "http://127.0.0.1:9/",
            "http://127.0.0.2:9",
            "http://[::1]:9",
        ] {
            let routed = HttpSgp::with_fake(Some(fake.into()))
                .route(&sgp_url())
                .unwrap();
            assert_eq!(routed, format!("{}{path}", fake.trim_end_matches('/')));
        }
    }
}
