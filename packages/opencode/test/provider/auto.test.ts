import { describe, expect, test } from "bun:test"
import { APICallError, type LanguageModelV3 } from "@ai-sdk/provider"
import { AutoProvider } from "@/provider/auto"
import type { Provider } from "@/provider/provider"

const model = (providerID: string, id: string, cost = 1) =>
  ({
    id,
    providerID,
    capabilities: { toolcall: true },
    cost: { input: cost, output: cost },
    limit: { context: 100_000 },
    release_date: "2026-01-01",
  }) as unknown as Provider.Model

const fake = (result: () => Promise<unknown>) =>
  ({ doGenerate: result, doStream: result }) as unknown as LanguageModelV3

const rateLimited = new APICallError({
  message: "Too Many Requests",
  url: "https://example.com",
  requestBodyValues: {},
  statusCode: 429,
})

describe("AutoProvider", () => {
  test("falls through to the next candidate on 429 and cools the failed one", async () => {
    const groq = model("groq", "a")
    const cerebras = model("cerebras", "b")
    const calls: string[] = []
    const lm = AutoProvider.language([
      { model: groq, language: fake(async () => (calls.push("groq"), Promise.reject(rateLimited))) },
      { model: cerebras, language: fake(async () => (calls.push("cerebras"), { content: [] })) },
    ])
    expect(await lm.doGenerate({ prompt: [] } as never)).toEqual({ content: [] } as never)
    expect(calls).toEqual(["groq", "cerebras"])

    // groq is cooling down, so the next request ranks cerebras first
    const providers = {
      groq: { id: "groq", models: { a: groq } },
      cerebras: { id: "cerebras", models: { b: cerebras } },
    } as unknown as Record<string, Provider.Info>
    expect(AutoProvider.candidates(providers).map((m) => String(m.providerID))).toEqual(["cerebras", "groq"])
  })

  test("only free-tier or zero-cost models are candidates", () => {
    const providers = {
      openai: { id: "openai", models: { paid: model("openai", "paid", 5), zero: model("openai", "zero", 0) } },
    } as unknown as Record<string, Provider.Info>
    expect(AutoProvider.candidates(providers).map((m) => String(m.id))).toEqual(["zero"])
  })

  test("moves on when a candidate never starts responding", async () => {
    const hanging = {
      doStream: (options: { abortSignal?: AbortSignal }) =>
        new Promise((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")))),
    } as unknown as LanguageModelV3
    const ok = fake(async () => ({ stream: new ReadableStream({ start: (c) => c.close() }) }))
    const lm = AutoProvider.language(
      [
        { model: model("groq", "hang"), language: hanging },
        { model: model("cerebras", "ok"), language: ok },
      ],
      { firstResponseMs: 50 },
    )
    const started = Date.now()
    const result = await lm.doStream({ prompt: [] } as never)
    expect(result.stream).toBeDefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("surfaces a context overflow over later unrelated failures", async () => {
    const tooLarge = new APICallError({
      message: "request entity too large",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 413,
    })
    const lm = AutoProvider.language([
      { model: model("test", "small"), language: fake(() => Promise.reject(tooLarge)) },
      { model: model("groq", "y"), language: fake(() => Promise.reject(rateLimited)) },
    ])
    await expect(lm.doGenerate({ prompt: [] } as never)).rejects.toBe(tooLarge as never)
  })

  test("throws the last error when every candidate fails", async () => {
    const lm = AutoProvider.language([{ model: model("groq", "x"), language: fake(() => Promise.reject(rateLimited)) }])
    await expect(lm.doGenerate({ prompt: [] } as never)).rejects.toBe(rateLimited as never)
  })
})
