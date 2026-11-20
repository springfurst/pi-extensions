/**
 * browser-pilot's view of the shared Chrome launcher.
 *
 * The process, profile, and record handling lives in `lib/browser/launch.ts` so
 * the same browser can serve every web tool. This module keeps the names the
 * action handlers and tests already use.
 */

export {
  ChromeLaunchError,
  ProfileInUseError,
  buildChromeArgs,
  closeChrome,
  connectChrome,
  decideExistingInstance,
  disposeChromeSync,
  ensureChrome,
  readDevToolsActivePort,
  shouldRunHeadless,
  spawnChrome,
} from "../../lib/browser/launch";
export type {
  ChromeLaunchConfig,
  EnsureChromeOptions,
  ExistingInstanceDecision,
  SpawnChromeOptions,
} from "../../lib/browser/launch";
export {
  instanceRecordPath,
  pidAlive,
  probeInstance,
  readInstanceRecord,
  removeInstanceRecord,
  resolveProfile,
  resolveUserPath,
  writeInstanceRecord,
} from "../../lib/browser/profile";
export type { ChromeInstance, InstanceRecord, ProfileInfo } from "../../lib/browser/profile";
