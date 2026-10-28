import { describe, expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpLazy } from "@/mcp/lazy"

const real = (log: string[]) =>
  ({
    callTool: async (input: { name: string }) => (log.push(`call:${input.name}`), { content: [] }),
    getServerCapabilities: () => ({ tools: {}, resources: {} }),
    getInstructions: () => "real instructions",
  }) as unknown as Client

describe("McpLazy.client", () => {
  test("starts the server on the first tool call only, then reuses it", async () => {
    const log: string[] = []
    const lazy = McpLazy.client({
      start: async () => (log.push("start"), real(log)),
      stop: async () => void log.push("stop"),
    })
    // Not running yet: advertises tools only, no instructions from the server.
    expect(lazy.getServerCapabilities()).toEqual({ tools: {} })
    expect(lazy.getInstructions()).toBeUndefined()
    expect(log).toEqual([])

    await Promise.all([lazy.callTool({ name: "a" }), lazy.callTool({ name: "b" })])
    expect(log).toEqual(["start", "call:a", "call:b"])
    expect(lazy.getInstructions()).toBe("real instructions")

    await lazy.close()
    expect(log.at(-1)).toBe("stop")
  })

  test("stops an idle server and restarts it on the next call", async () => {
    const log: string[] = []
    const lazy = McpLazy.client({
      start: async () => (log.push("start"), real(log)),
      stop: async () => void log.push("stop"),
      idleMs: 20,
    })
    await lazy.callTool({ name: "a" })
    await Bun.sleep(60)
    expect(log).toEqual(["start", "call:a", "stop"])
    await lazy.callTool({ name: "b" })
    expect(log).toEqual(["start", "call:a", "stop", "start", "call:b"])
    await lazy.close()
  })

  test("a failed start can be retried", async () => {
    const attempts: number[] = []
    const lazy = McpLazy.client({
      start: async () => {
        attempts.push(attempts.length)
        if (attempts.length === 1) throw new Error("boom")
        return real([])
      },
      stop: async () => {},
    })
    await expect(lazy.callTool({ name: "a" })).rejects.toThrow("boom")
    await lazy.callTool({ name: "a" })
    expect(attempts).toEqual([0, 1])
    await lazy.close()
  })
})
