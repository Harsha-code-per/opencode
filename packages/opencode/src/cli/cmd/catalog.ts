import { cmd } from "./cmd"
import { UI } from "../ui"
import { Catalog } from "@/catalog"

const scopeOption = {
  describe: "user: every project (default). project: this directory only",
  choices: ["user", "project"] as const,
  default: "user" as const,
}

export const CatalogCommand = cmd({
  command: "catalog <action> [target..]",
  describe: "browse and manage built-in skills, plugins and MCP servers",
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "list | search <words> | install <id> | uninstall <id> | enable <id> | disable <id>",
        choices: ["list", "search", "install", "uninstall", "enable", "disable"] as const,
      })
      .positional("target", { describe: "search words, or a catalog id", type: "string", array: true })
      .option("scope", scopeOption),
  handler: async (args) => {
    const root = process.cwd()
    const target = (args.target ?? []).join(" ")

    if (args.action === "list" || args.action === "search") {
      const found = args.action === "list" ? Catalog.entries() : Catalog.search(target)
      for (const entry of found) {
        const [user, project] = await Promise.all([
          Catalog.status(entry, "user", root),
          Catalog.status(entry, "project", root),
        ])
        UI.println(
          `${UI.Style.TEXT_NORMAL_BOLD}${entry.id}${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_DIM}[${entry.kind}] user:${user} project:${project} · ${entry.license}${UI.Style.TEXT_NORMAL}`,
        )
        UI.println(`  ${entry.description}`)
      }
      if (found.length === 0) UI.println(`No catalog entries match "${target}".`)
      return
    }

    const entry = Catalog.get(target)
    if (!entry) {
      UI.error(`Unknown catalog id "${target}". Run \`dev catalog list\`.`)
      process.exitCode = 1
      return
    }
    const result = await (
      args.action === "install"
        ? Catalog.install(entry, args.scope, root)
        : args.action === "uninstall"
          ? Catalog.uninstall(entry, args.scope, root)
          : Catalog.setEnabled(entry, args.scope, root, args.action === "enable")
    ).catch((error: Error) => {
      UI.error(error.message)
      process.exitCode = 1
    })
    if (result) UI.println(UI.Style.TEXT_SUCCESS_BOLD + result + UI.Style.TEXT_NORMAL)
  },
})
