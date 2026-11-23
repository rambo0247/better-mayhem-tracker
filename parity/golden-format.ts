/** The on-disk shape of the T05 IPC goldens. FORMAT.md in `goldens/` explains every field. */

export const GOLDEN_FORMAT = 1;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Outcome =
  | { kind: "value"; result: Json }
  | { kind: "void" }
  | { kind: "error"; name: string; message: string; invokeMessage: string };

export interface EventRecord {
  seq: number;
  event: string;
  /** Absent when the event carries no payload. */
  payload?: Json;
}

export interface EffectRecord {
  seq: number;
  api: string;
  args: Json[];
}

export interface FileRecord {
  /** `$RUN/...` placeholder path the handler wrote. */
  path: string;
  size: number;
  sha256: string;
  /** Set when the file is UTF-8 text. */
  text?: string;
  /** Set otherwise. */
  base64?: string;
}

export interface IpcGolden {
  format: typeof GOLDEN_FORMAT;
  channel: string;
  /** The `window.api` name, or null for a channel Electron does not register. */
  method: string | null;
  registered: boolean;
  case: string;
  description: string;
  /** `read` cases are independent. Any other group ran in `seq` order on one fresh copy of the data. */
  group: string;
  seq: number;
  args: Json[];
  outcome: Outcome;
  /** Events the main process pushed while this call ran, in order. */
  events: EventRecord[];
  /** Calls to the OS the handler made and the seam stubbed, in order. */
  effects: EffectRecord[];
  /** Files the handler wrote, read back after the call. */
  files: FileRecord[];
  /** JSON paths in `outcome.result` that held NaN or an infinity and were written as null. */
  nonFinite: string[];
}

/** One line of `events/<scenario>.jsonl`. */
export interface EventLine extends EventRecord {
  /** The invoke that was running when the event fired, or "scenario" when none was. */
  cause: { channel: string; case: string } | "scenario";
}

export interface GoldenManifest {
  format: typeof GOLDEN_FORMAT;
  appVersion: string;
  platform: string;
  fixedTime: string;
  /** The IANA zone Electron ran in (`TZ`). A replay sets it before it starts. */
  timeZone: string;
  /** The renderer's locale (`--lang`, `LANG`). A replay sets it before it starts. */
  locale: string;
  data: string;
  dbSha256: string;
  channels: string[];
  events: string[];
  /** Ids of the states recorded under `states/`. Absent until `record-states.ts` has run. */
  states?: string[];
}

/** `states/<id>.json`: every call one page state made, in order, and the case that answers each. */
export interface StateIndex {
  format: typeof GOLDEN_FORMAT;
  state: string;
  group: string;
  route: string;
  viewport: { width: number; height: number };
  calls: { seq: number; channel: string; method: string | null; args: Json[]; case: string }[];
  /** Set when the state never reached its expected page. The calls are those made until then. */
  error?: string;
}

/** `:` is not a legal file name character on Windows, and no channel contains a dot. */
export const channelDirName = (channel: string) => channel.replace(/:/g, ".");
export const channelFromDirName = (dir: string) => dir.replace(/\./g, ":");

export const RUN_TOKEN = "$RUN";
/** Not in `INVOKE_CHANNELS`. Records what Electron does for a channel nobody registered. */
export const UNREGISTERED_CHANNEL = "bmt:unregistered-channel";
