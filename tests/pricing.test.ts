import { expect, test } from "bun:test"

import { parseArgs } from "../src/cli"
import { estimateBreakdownCost, loadPricing } from "../src/pricing"
import type { TokenBreakdown } from "../src/types"

const OPENAI_PRICING_FIXTURE = `
<TextTokenPricingTables
  tier="standard"
  rows={[
    ["gpt-5.5 (<272K context length)", 5, 0.5, "-", 30],
    ["gpt-5.4", 2.5, 0.25, "-", 15],
    ["gpt-5.1", 1.25, 0.125, "-", 10]
  ]}
/>
<TextTokenPricingTables
  tier="batch"
  rows={[
    ["gpt-5.5", 2.5, 0.25, "-", 15]
  ]}
/>
<TextTokenPricingTables
  tier="flex"
  rows={[
    ["gpt-5.5", 1, 0.1, "-", 6]
  ]}
/>
<TextTokenPricingTables
  tier="priority"
  rows={[
    ["gpt-5.5", 12.5, 1.25, "-", 75],
    ["gpt-5.4", 5, 0.5, "-", 30],
    ["gpt-5.1", 2.5, 0.25, "-", 20]
  ]}
/>
`

const MODELS_DEV_FIXTURE = {
  openai: {
    models: {
      "gpt-5.1-codex": {
        cost: { input: 100, cache_read: 10, output: 100 },
      },
      "gpt-5.3-codex": {
        cost: { input: 1.75, cache_read: 0.175, output: 14 },
      },
      "gpt-5.5": {
        cost: { input: 999, cache_read: 99, output: 999 },
      },
    },
  },
}

const ONE_MILLION_INPUT_AND_OUTPUT: TokenBreakdown = {
  totalTokens: 2_000_000,
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  outputTokens: 1_000_000,
  reasoningOutputTokens: 0,
}

async function loadFixture(openAiMarkdown = OPENAI_PRICING_FIXTURE) {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input)

    if (url.includes("developers.openai.com")) {
      return new Response(openAiMarkdown, { status: 200 })
    }

    if (url.includes("models.dev")) {
      return Response.json(MODELS_DEV_FIXTURE)
    }

    return new Response("not found", { status: 404 })
  }

  return loadPricing({ source: "openai", fetcher: fetcher as typeof fetch })
}

function estimate(
  pricing: Awaited<ReturnType<typeof loadPricing>>,
  model: string,
  serviceTier?: string,
  breakdown = ONE_MILLION_INPUT_AND_OUTPUT,
  modelContextWindow?: number,
) {
  return estimateBreakdownCost(breakdown, model, pricing.table, "gpt-5.6-sol", {
    serviceTier,
    modelContextWindow,
  })
}

test("OpenAI standard and Priority prices override models.dev", async () => {
  const pricing = await loadFixture()

  expect(estimate(pricing, "gpt-5.5")).toBeCloseTo(35)
  expect(estimate(pricing, "gpt-5.5", "default")).toBeCloseTo(35)
  expect(estimate(pricing, "gpt-5.5", "priority")).toBeCloseTo(87.5)
})

test("Batch and Flex prices are used only for an explicit event tier", async () => {
  const pricing = await loadFixture()

  expect(estimate(pricing, "gpt-5.5")).toBeCloseTo(35)
  expect(estimate(pricing, "gpt-5.5", "batch")).toBeCloseTo(17.5)
  expect(estimate(pricing, "gpt-5.5", "flex")).toBeCloseTo(7)
})

test("known aliases use OpenAI prices and models.dev-only models get a 2x Priority fallback", async () => {
  const pricing = await loadFixture()

  expect(estimate(pricing, "gpt-5.1-codex")).toBeCloseTo(11.25)
  expect(estimate(pricing, "gpt-5.1-codex", "priority")).toBeCloseTo(22.5)
  expect(estimate(pricing, "gpt-5.3-codex")).toBeCloseTo(15.75)
  expect(estimate(pricing, "gpt-5.3-codex", "priority")).toBeCloseTo(31.5)
})

test("codex-auto-review maps to GPT-5.4 unless OpenAI publishes an exact row", async () => {
  const pricing = await loadFixture()

  expect(estimate(pricing, "codex-auto-review")).toBeCloseTo(17.5)
  expect(estimate(pricing, "guardian", "priority")).toBeCloseTo(35)

  const exactPricing = await loadFixture(
    OPENAI_PRICING_FIXTURE.replace(
      '["gpt-5.4", 2.5, 0.25, "-", 15],',
      '["gpt-5.4", 2.5, 0.25, "-", 15],\n    ["codex-auto-review", 7, 0.7, "-", 21],',
    ).replace(
      '["gpt-5.4", 5, 0.5, "-", 30],',
      '["gpt-5.4", 5, 0.5, "-", 30],\n    ["codex-auto-review", 14, 1.4, "-", 42],',
    ),
  )

  expect(estimate(exactPricing, "codex-auto-review")).toBeCloseTo(28)
  expect(estimate(exactPricing, "codex-auto-review", "priority")).toBeCloseTo(56)
})

test("long-context prices require both a known high context limit and a request over 272K input tokens", async () => {
  const pricing = await loadFixture()
  const longRequest: TokenBreakdown = {
    totalTokens: 400_000,
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 100_000,
    reasoningOutputTokens: 0,
  }
  const shortRequest: TokenBreakdown = {
    ...longRequest,
    totalTokens: 300_000,
    inputTokens: 200_000,
  }

  expect(estimate(pricing, "gpt-5.5", undefined, longRequest)).toBeCloseTo(4.5)
  expect(estimate(pricing, "gpt-5.5", undefined, longRequest, 128_000)).toBeCloseTo(4.5)
  expect(estimate(pricing, "gpt-5.5", undefined, longRequest, 1_050_000)).toBeCloseTo(7.5)
  expect(estimate(pricing, "gpt-5.5", undefined, shortRequest, 1_050_000)).toBeCloseTo(4)
})

test("CLI pricing defaults to the authoritative OpenAI catalog", () => {
  expect(parseArgs(["generate"]).pricingSource).toBe("openai")
  expect(parseArgs(["generate", "--pricing-source", "openai"]).pricingSource).toBe("openai")
})
