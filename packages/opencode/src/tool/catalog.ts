import { Effect, Schema } from "effect"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import * as Tool from "./tool"
import DESCRIPTION from "./catalog.txt"
import { Catalog } from "@/catalog"
import { MCP } from "@/mcp"
import { InstanceState } from "@/effect/instance-state"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["search", "list", "install", "uninstall", "enable", "disable"]).annotate({
    description: "What to do",
  }),
  query: Schema.optional(Schema.String).annotate({ description: "Keywords for search, e.g. 'browser testing'" }),
  id: Schema.optional(Schema.String).annotate({ description: "Catalog entry id for install/uninstall/enable/disable" }),
  scope: Schema.optional(Schema.Literals(["user", "project"])).annotate({
    description: "user (default): available in every project. project: only this repository.",
  }),
})

export const CatalogTool = Tool.define(
  "catalog",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return {
      // A one-line index per entry so the model knows what exists without searching first.
      description: [
        DESCRIPTION,
        "Catalog entries:",
        ...Catalog.entries().map((entry) => `- ${entry.id} [${entry.kind}]: ${entry.name} (${entry.tags.join(", ")})`),
      ].join("\n"),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // Non-git projects report "/" as their worktree.
          const root = instance.worktree === "/" ? instance.directory : instance.worktree
          const scope = params.scope ?? "user"

          if (params.action === "search" || params.action === "list") {
            const found = params.action === "list" ? Catalog.entries() : Catalog.search(params.query ?? "")
            const rows = yield* Effect.promise(() =>
              Promise.all(
                found.map(async (entry) => {
                  const [user, project] = await Promise.all([
                    Catalog.status(entry, "user", root),
                    Catalog.status(entry, "project", root),
                  ])
                  return `- ${entry.id} [${entry.kind}] user:${user} project:${project}: ${entry.description}`
                }),
              ),
            )
            return {
              title: `${found.length} catalog entries`,
              output: rows.length ? rows.join("\n") : `No catalog entries match "${params.query}".`,
              metadata: {},
            }
          }

          const entry = params.id ? Catalog.get(params.id) : undefined
          if (!entry) throw new Error(`Unknown catalog id "${params.id}". Use action "search" to find one.`)

          yield* ctx.ask({
            permission: "catalog",
            patterns: [`${params.action}:${entry.id}`],
            always: [`${params.action}:${entry.id}`],
            metadata: { action: params.action, id: entry.id, kind: entry.kind, scope, source: entry.source },
          })

          const output = yield* Effect.promise(() => {
            if (params.action === "install") return Catalog.install(entry, scope, root)
            if (params.action === "uninstall") return Catalog.uninstall(entry, scope, root)
            return Catalog.setEnabled(entry, scope, root, params.action === "enable")
          })

          // MCP servers take effect in this session; plugins and skills on the next one.
          if (entry.kind === "mcp" && (params.action === "install" || params.action === "enable"))
            yield* mcp.add(entry.id, { ...entry.mcp, enabled: true } as ConfigMCPV1.Info)
          if (entry.kind === "mcp" && (params.action === "uninstall" || params.action === "disable"))
            yield* mcp.disconnect(entry.id).pipe(Effect.ignore)

          return { title: `${params.action} ${entry.id}`, output, metadata: {} }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
