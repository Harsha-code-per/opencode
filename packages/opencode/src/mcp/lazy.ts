import path from "node:path"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

// DeV: local MCP servers start on first tool call instead of at startup, and stop when idle.
// Their tool list comes from a cache written the last time the server actually ran.

// ponytail: fixed idle window, make it configurable if someone needs servers to stay warm.
export const IDLE_MS = 10 * 60_000

export type Cached = { defs: Tool[]; instructions?: string }

function file(key: string, mcp: ConfigMCPV1.Info) {
  // Any change to how the server is launched (command, version pin, env) invalidates the cache.
  const id = Hash.fast(JSON.stringify(mcp.type === "local" ? [mcp.command, mcp.environment] : mcp))
  return path.join(Global.Path.cache, "mcp", `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}-${id}.json`)
}

export async function read(key: string, mcp: ConfigMCPV1.Info): Promise<Cached | undefined> {
  const cached = await Bun.file(file(key, mcp))
    .json()
    .catch(() => undefined)
  if (!cached || !Array.isArray(cached.defs) || cached.defs.length === 0) return undefined
  return cached
}

export async function write(key: string, mcp: ConfigMCPV1.Info, cached: Cached) {
  await Bun.write(file(key, mcp), JSON.stringify(cached)).catch(() => {})
}

/**
 * A stand-in Client: tool calls start the real server on demand, other calls go to it once
 * running. `stop` must tear down the real client and its process tree.
 */
export function client(input: {
  start: () => Promise<Client>
  stop: (real: Client) => Promise<void>
  idleMs?: number
}): Client {
  const state: { real?: Client; starting?: Promise<Client>; timer?: ReturnType<typeof setTimeout> } = {}

  const ensure = () => {
    if (state.real) return Promise.resolve(state.real)
    state.starting ??= input
      .start()
      .then((real) => {
        state.real = real
        real.onclose = () => {
          if (state.real === real) state.real = undefined
        }
        return real
      })
      .finally(() => {
        state.starting = undefined
      })
    return state.starting
  }

  const touch = () => {
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      const real = state.real
      state.real = undefined
      if (real) void input.stop(real)
    }, input.idleMs ?? IDLE_MS)
    // Never keep the process alive just to stop an idle server.
    state.timer.unref?.()
  }

  return new Proxy({} as Client, {
    get(_, prop) {
      if (prop === "callTool")
        return async (...args: Parameters<Client["callTool"]>) => {
          const real = await ensure()
          touch()
          return real.callTool(...args).finally(touch)
        }
      if (prop === "close")
        return async () => {
          clearTimeout(state.timer)
          const real = state.real
          state.real = undefined
          if (real) await input.stop(real)
        }
      // Before the server runs: it advertises tools only, so resource/prompt lookups skip it.
      if (prop === "getServerCapabilities") return () => state.real?.getServerCapabilities() ?? { tools: {} }
      if (prop === "getInstructions") return () => state.real?.getInstructions()
      if (prop === "then") return undefined
      const real = state.real
      if (!real) return undefined
      const value = Reflect.get(real, prop)
      return typeof value === "function" ? value.bind(real) : value
    },
  })
}

export * as McpLazy from "./lazy"
