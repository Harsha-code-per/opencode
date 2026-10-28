import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// DeV: local model servers are picked up automatically, so a machine with Ollama or LM Studio
// running works with no keys at all. Both speak the OpenAI-compatible /v1 API. When nothing is
// listening the connection is refused immediately, so detection costs nothing.

type ProviderConfig = NonNullable<ConfigV1.Info["provider"]>[string]

const SERVERS = [
  { id: "ollama", name: "Ollama (local)", url: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio (local)", url: "http://127.0.0.1:1234/v1" },
]

export async function detect(servers = SERVERS, timeoutMs = 500): Promise<Record<string, ProviderConfig>> {
  const found = await Promise.all(
    servers.map(async (server) => {
      const ids = await fetch(`${server.url}/models`, { signal: AbortSignal.timeout(timeoutMs) })
        .then((res) => (res.ok ? res.json() : undefined))
        .then((body: { data?: { id?: unknown }[] } | undefined) =>
          (body?.data ?? []).flatMap((model) => (typeof model.id === "string" ? [model.id] : [])),
        )
        .catch(() => [] as string[])
      if (ids.length === 0) return undefined
      const provider: ProviderConfig = {
        name: server.name,
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: server.url, apiKey: "local" },
        // ponytail: assumes tool calling; models without it fail and auto/free moves on.
        models: Object.fromEntries(ids.map((id) => [id, { name: id, tool_call: true }])),
      }
      return [server.id, provider] as const
    }),
  )
  return Object.fromEntries(found.filter((item) => item !== undefined))
}

export * as LocalProviders from "./local"
