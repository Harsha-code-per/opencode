import path from "path"
import { Flag } from "./flag/flag"

// DeV naming for config files and project folders. DeV names come first; the stock opencode
// names stay readable so existing setups keep working. OPENCODE_DISABLE_DEV_DEFAULTS restores
// stock-only behaviour (used by upstream tests).

const stock = Flag.OPENCODE_DISABLE_DEV_DEFAULTS

/** Config file base names, preferred first. */
export const CONFIG_NAMES = stock ? ["opencode"] : ["dev", "opencode"]

/** Project config folders, preferred first. */
export const CONFIG_DIRS = stock ? [".opencode"] : [".dev", ".opencode"]

/** Where DeV writes new project config. */
export const CONFIG_DIR = CONFIG_DIRS[0]

/** Name for newly written config files. */
export const CONFIG_NAME = CONFIG_NAMES[0]

/** `name.json` and `name.jsonc` for every config name, preferred first. */
export function configFiles(dir: string) {
  return CONFIG_NAMES.flatMap((name) => [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)])
}

export function isConfigDir(dir: string) {
  return CONFIG_DIRS.includes(path.basename(dir))
}

export * as Brand from "./brand"
