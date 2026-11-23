import type { Component } from "solid-js";
import { createRouter, type RouteDefinition } from "@solidjs/router";
import { GAME_CARD_ROUTE, SEASON_CARD_ROUTE } from "@shared/card";
import Layout from "./components/Layout";
import { hashHistoryWithState } from "./lib/history";
import RoutePlaceholder from "./components/RoutePlaceholder";

// Each page unit adds its file under pages/ and its route picks it up here, so
// no page unit edits this one
const pages = import.meta.glob<{ default: Component }>(["./pages/*.tsx", "!./pages/*.test.tsx"], {
  eager: true,
});

function page(name: string): Component {
  return pages[`./pages/${name}.tsx`]?.default ?? (() => <RoutePlaceholder page={name} />);
}

const routes = [
  {
    path: "/",
    component: Layout,
    children: [
      { path: "/", component: page("MatchHistory") },
      { path: "/live", component: page("LiveGame") },
      { path: "/champions", component: page("Champions") },
      { path: "/augments", component: page("Augments") },
      { path: "/friends", component: page("Friends") },
      { path: "/friends/:key", component: page("FriendDetail") },
      { path: "/friends/groups/:key", component: page("GroupDetail") },
      { path: "/trends", component: page("Trends") },
      { path: "/records", component: page("Records") },
      { path: "/season", component: page("SeasonRecap") },
      { path: "/challenges", component: page("Challenges") },
      { path: "/global", component: page("GlobalStats") },
      { path: "/global/champion/:championId", component: page("GlobalChampionDetail") },
      { path: "/settings", component: page("Settings") },
    ],
  },
  // Outside the layout: these are drawn to be captured as images, not to be
  // navigated to, so they carry no sidebar or title bar.
  { path: `${GAME_CARD_ROUTE}/:gameId`, component: page("GameCard") },
  { path: `${SEASON_CARD_ROUTE}/:seasonId`, component: page("SeasonCard") },
] satisfies RouteDefinition[];

// Without explicitLinks the router claims every plain anchor and matches its
// href against the page URL, where the hash does not count: on an http(s)
// origin (WebView2, the dev server) every nav link would read as current on
// Match History. The nav links keep their own state through useLinkState.
const Router = createRouter({ routes, history: hashHistoryWithState(), explicitLinks: true });

export default function App() {
  return <Router>{(props) => props.children}</Router>;
}
