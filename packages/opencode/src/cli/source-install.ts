import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { UI } from "./ui"

// DeV is installed from source until it has its own release channel (roadmap R6). The stock
// upgrade/uninstall commands would install or remove OpenCode packages instead, so DeV prints the
// exact steps for this install and changes nothing.

/** The DeV checkout this binary was built from, if it can be found. */
function checkout() {
  // <DeV>/engine/packages/opencode/dist/<target>/bin/<binary>
  const engine = path.resolve(fs.realpathSync(process.execPath), "../../../../../..")
  const root = path.dirname(engine)
  if (!fs.existsSync(path.join(root, ".gitmodules"))) return undefined
  return { root, engine }
}

export function upgrade() {
  const repo = checkout()
  UI.println(UI.Style.TEXT_NORMAL_BOLD + "DeV updates from its git checkout:" + UI.Style.TEXT_NORMAL)
  UI.println(`  cd ${repo?.root ?? "<your DeV checkout>"}`)
  UI.println("  git pull --recurse-submodules")
  UI.println("  cd engine && bun install && cd packages/opencode")
  UI.println("  bun run script/build.ts --single --skip-install --skip-embed-web-ui")
}

export function uninstall() {
  UI.println(UI.Style.TEXT_NORMAL_BOLD + "To remove DeV:" + UI.Style.TEXT_NORMAL)
  UI.println(`  rm ${path.join(process.env.HOME ?? "~", ".local/bin/dev")}`)
  UI.println(`  rm -r ${Global.Path.data} ${Global.Path.config} ${Global.Path.cache} ${Global.Path.state}`)
  UI.println("The first line removes the command; the second also deletes sessions, settings and keys.")
}

export * as SourceInstall from "./source-install"
