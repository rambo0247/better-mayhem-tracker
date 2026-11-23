import guard from "./real-folder.cjs";

export const APP_FOLDER_NAMES: string[] = guard.APP_FOLDER_NAMES;
export const realDataRoots: (
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
  home?: string,
) => string[] = guard.realDataRoots;
export const isUnderRealFolder: (target: string, roots?: string[]) => boolean =
  guard.isUnderRealFolder;
export const refuseRealFolder: (target: string, what: string, roots?: string[]) => void =
  guard.refuseRealFolder;
