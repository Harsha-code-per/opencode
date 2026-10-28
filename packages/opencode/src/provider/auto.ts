import { APICallError, type LanguageModelV3, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { sortBy } from "remeda"
import type { Provider } from "./provider"

// DeV: virtual "auto" provider. Its single model routes each request across every free
// model from the connected providers and falls through to the next one on any failure.

export const ID = "auto"
export const MODEL = "free"
const MAX_CANDIDATES = 12

// Providers whose models are usable on a free tier even though models.dev lists paid prices.
// ponytail: static list, swap for a live free-tier catalog (e.g. freellmapi's) if it drifts.
const FREE_TIER = new Set([
  "groq",
  "cerebras",
  "google",
  "mistral",
  "nvidia",
  "cohere",
  "huggingface",
  "github-models",
  "cloudflare-workers-ai",
  "ollama",
  "lmstudio",
])

const cooldown = new Map<string, number>()

export function candidates(providers: Record<string, Provider.Info>, now = Date.now()) {
  // Rank within each provider, then interleave providers so one broken provider
  // (bad key, unsupported plan) can't fill every slot.
  const groups = Object.values(providers)
    .filter((p) => p.id !== ID)
    .map((p) =>
      sortBy(
        Object.values(p.models)
          .filter((m) => m.capabilities.toolcall)
          .filter((m) => FREE_TIER.has(m.providerID) || (m.cost.input === 0 && m.cost.output === 0)),
        (m) => m.cost.input,
        [(m) => m.limit.context, "desc"],
        [(m) => m.release_date, "desc"],
      ),
    )
  const interleaved = Array.from({ length: Math.max(0, ...groups.map((g) => g.length)) }, (_, i) =>
    groups.flatMap((g) => (g[i] ? [g[i]] : [])),
  ).flat()
  return sortBy(interleaved, (m) => (cooldown.get(key(m)) ?? 0) > now).slice(0, MAX_CANDIDATES)
}

export function info(providers: Record<string, Provider.Info>): Provider.Info | undefined {
  if (candidates(providers).length === 0) return undefined
  return {
    id: ID as Provider.Info["id"],
    name: "DeV Auto (free)",
    source: "custom",
    env: [],
    options: {},
    models: {
      [MODEL]: {
        id: MODEL as Provider.Model["id"],
        providerID: ID as Provider.Model["providerID"],
        api: { id: MODEL, url: "", npm: "@ai-sdk/openai-compatible" },
        name: "Auto (best free model)",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        // ponytail: fixed window; a candidate with a smaller context errors and the next one is tried.
        limit: { context: 128_000, output: 8_192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "",
        variants: {},
      },
    },
  }
}

export function language(list: { model: Provider.Model; language: LanguageModelV3 }[]): LanguageModelV3 {
  const attempt = async <T>(signal: AbortSignal | undefined, run: (item: (typeof list)[number]) => PromiseLike<T>) => {
    const errors: unknown[] = []
    for (const item of list) {
      if (signal?.aborted) throw signal.reason
      try {
        return await run(item)
      } catch (e) {
        if (signal?.aborted) throw e
        cool(item.model, e)
        errors.push(e)
      }
    }
    throw errors.at(-1) ?? new Error("No free models available. Connect a provider with /connect.")
  }
  return {
    specificationVersion: "v3",
    provider: ID,
    modelId: MODEL,
    supportedUrls: {},
    doGenerate: (options) => attempt(options.abortSignal, (item) => item.language.doGenerate(options)),
    doStream: (options) =>
      attempt(options.abortSignal, async (item) => {
        const result = await item.language.doStream(options)
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
              transform(part, controller) {
                if (part.type === "error") cool(item.model, part.error)
                controller.enqueue(part)
              },
            }),
          ),
        }
      }),
  }
}

export function cool(model: Provider.Model, error: unknown, now = Date.now()) {
  const status = APICallError.isInstance(error) ? error.statusCode : undefined
  const retryAfter = APICallError.isInstance(error) ? Number(error.responseHeaders?.["retry-after"]) : NaN
  const ms = wait(status, retryAfter)
  cooldown.set(key(model), now + ms)
}

function wait(status: number | undefined, retryAfter: number) {
  if (!Number.isNaN(retryAfter) && retryAfter > 0) return retryAfter * 1000
  if (status === 429) return 60_000
  // Other 4xx (bad key, unsupported model or plan) won't fix itself soon.
  if (status !== undefined && status >= 400 && status < 500) return 600_000
  return 15_000
}

function key(model: Provider.Model) {
  return `${model.providerID}/${model.id}`
}

export * as AutoProvider from "./auto"
