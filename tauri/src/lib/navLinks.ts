import { createSignal, type Component } from "solid-js";
import type { JSX } from "@solidjs/web";
import { api } from "./api-shim";
import {
  SwordsIcon,
  TrophyIcon,
  CrosshairIcon,
  UsersIcon,
  GlobeIcon,
  TrendingUpIcon,
  MedalIcon,
  RadioIcon,
  AwardIcon,
  CalendarIcon,
} from "../components/icons";

type IconComponent = Component<JSX.SvgSVGAttributes<SVGSVGElement>>;

export type NavGroup = "Play" | "Analyze" | "Social" | "Achieve";

export type NavLinkDef = { to: string; label: string; icon: IconComponent; group: NavGroup };

// In the order the sidebar lists them, under their group headings
export const NAV_LINKS: NavLinkDef[] = [
  { to: "/", label: "Match History", icon: SwordsIcon, group: "Play" },
  { to: "/live", label: "Live Game", icon: RadioIcon, group: "Play" },
  { to: "/champions", label: "Champions", icon: TrophyIcon, group: "Analyze" },
  { to: "/augments", label: "Augments", icon: CrosshairIcon, group: "Analyze" },
  { to: "/trends", label: "Trends", icon: TrendingUpIcon, group: "Analyze" },
  { to: "/global", label: "Total Stats", icon: GlobeIcon, group: "Analyze" },
  { to: "/friends", label: "Friends", icon: UsersIcon, group: "Social" },
  { to: "/records", label: "Records", icon: MedalIcon, group: "Achieve" },
  { to: "/season", label: "Season Recap", icon: CalendarIcon, group: "Achieve" },
  { to: "/challenges", label: "Challenges", icon: AwardIcon, group: "Achieve" },
];

export const NAV_GROUPS: NavGroup[] = ["Play", "Analyze", "Social", "Achieve"];

// The page the app opens on, so its link can't be hidden
export const HOME_PATH = "/";

export const HIDDEN_NAV_LINKS_SETTING = "hidden_nav_links";

// The paths of the links switched off in Settings, shared between that page
// and the header so a change shows up without a reload
const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());

export const hiddenNavLinks = hidden;

// Read from the database once per launch; after that this module is the copy
// every writer goes through
let loading: Promise<void> | null = null;

export function loadHiddenNavLinks(): Promise<void> {
  loading ??= api.getSetting(HIDDEN_NAV_LINKS_SETTING).then((raw) => {
    setHidden(new Set(raw ? raw.split(",").filter((to) => to !== HOME_PATH) : []));
  });
  return loading;
}

export async function toggleNavLink(to: string): Promise<void> {
  if (to === HOME_PATH) return;
  const next = new Set(hidden());
  if (!next.delete(to)) next.add(to);
  setHidden(next);
  await api.setSetting(HIDDEN_NAV_LINKS_SETTING, [...next].join(","));
}
