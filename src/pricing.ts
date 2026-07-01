import type { ModelPricing, PricingSource, TokenBreakdown } from "./types"

import { readFileSync } from "node:fs"

export type PricingLoadResult = {
  table: Map<string, ModelPricing>
  source: string
  fetchedAt?: string
  warning?: string
}

const BUNDLED: ModelPricing[] = [
  // OpenAI docs fallback, present in OpenAI pricing, not currently in models.dev OpenAI table
  {
    model: "chat-latest",
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    source: "bundled/openai dev docs snapshot 2026-07-01",
  },

  // GPT-5.5/GPT-5.4 latest flagship models
  {
    model: "gpt-5.5",
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.5-pro",
    inputPerMillion: 30,
    outputPerMillion: 180,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.4",
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.4-mini",
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.4-nano",
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.25,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.4-pro",
    inputPerMillion: 30,
    outputPerMillion: 180,
    source: "bundled/models.dev snapshot 2026-07-01",
  },

  // GPT-5.3 Codex/Spark
  {
    model: "gpt-5.3-chat-latest",
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.3-codex",
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.3-codex-spark",
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
    source: "bundled/models.dev snapshot 2026-07-01",
  },

  // GPT-5.2
  {
    model: "gpt-5.2",
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.2-chat-latest",
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.2-codex",
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.2-pro",
    inputPerMillion: 21,
    outputPerMillion: 168,
    source: "bundled/models.dev snapshot 2026-07-01",
  },

  // GPT-5.1
  {
    model: "gpt-5.1",
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.13,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.1-chat-latest",
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.1-codex",
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.1-codex-max",
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5.1-codex-mini",
    inputPerMillion: 0.25,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 2,
    source: "bundled/models.dev snapshot 2026-07-01",
  },

  // GPT-5
  {
    model: "gpt-5",
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5-chat-latest",
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5-codex",
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5-mini",
    inputPerMillion: 0.25,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 2,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5-nano",
    inputPerMillion: 0.05,
    cachedInputPerMillion: 0.005,
    outputPerMillion: 0.4,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-5-pro",
    inputPerMillion: 15,
    outputPerMillion: 120,
    source: "bundled/models.dev snapshot 2026-07-01",
  },

  // GPT-4.1/GPT-4o current and dated aliases
  {
    model: "gpt-4.1",
    inputPerMillion: 2,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 8,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4.1-mini",
    inputPerMillion: 0.4,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 1.6,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4.1-nano",
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.03,
    outputPerMillion: 0.4,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4o",
    inputPerMillion: 2.5,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4o-2024-05-13",
    inputPerMillion: 5,
    outputPerMillion: 15,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4o-2024-08-06",
    inputPerMillion: 2.5,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4o-2024-11-20",
    inputPerMillion: 2.5,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 10,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4o-mini",
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.08,
    outputPerMillion: 0.6,
    source: "bundled/models.dev snapshot 2026-07-01",
  },

  // Reasoning models
  {
    model: "o1",
    inputPerMillion: 15,
    cachedInputPerMillion: 7.5,
    outputPerMillion: 60,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "o1-pro",
    inputPerMillion: 150,
    outputPerMillion: 600,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "o3",
    inputPerMillion: 2,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 8,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "o3-mini",
    inputPerMillion: 1.1,
    cachedInputPerMillion: 0.55,
    outputPerMillion: 4.4,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "o3-pro",
    inputPerMillion: 20,
    outputPerMillion: 80,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "o3-deep-research",
    inputPerMillion: 10,
    cachedInputPerMillion: 2.5,
    outputPerMillion: 40,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "o4-mini",
    inputPerMillion: 1.1,
    cachedInputPerMillion: 0.275,
    outputPerMillion: 4.4,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "o4-mini-deep-research",
    inputPerMillion: 2,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 8,
    source: "bundled/models.dev snapshot 2026-07-01",
  },

  // Legacy text models still present in models.dev
  {
    model: "gpt-3.5-turbo",
    inputPerMillion: 0.5,
    outputPerMillion: 1.5,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4",
    inputPerMillion: 30,
    outputPerMillion: 60,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "gpt-4-turbo",
    inputPerMillion: 10,
    outputPerMillion: 30,
    source: "bundled/models.dev snapshot 2026-07-01",
  },

  // Token-priced non-chat rows that models.dev's parser can also load
  {
    model: "gpt-image-2",
    inputPerMillion: 5,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 30,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "text-embedding-3-large",
    inputPerMillion: 0.13,
    outputPerMillion: 0,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "text-embedding-3-small",
    inputPerMillion: 0.02,
    outputPerMillion: 0,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
  {
    model: "text-embedding-ada-002",
    inputPerMillion: 0.1,
    outputPerMillion: 0,
    source: "bundled/models.dev snapshot 2026-07-01",
  },
]

export async function loadPricing(options: {
  source: PricingSource
  pricingJson?: string
}): Promise<PricingLoadResult> {
  if (options.pricingJson) {
    const raw = JSON.parse(readFileSync(options.pricingJson, "utf8"))

    return {
      table: pricingTableFromObject(raw, `file:${options.pricingJson}`),
      source: `file:${options.pricingJson}`,
    }
  }

  if (options.source === "models.dev") {
    try {
      const response = await fetch("https://models.dev/api.json")

      if (!response.ok) {
        throw new Error(`models.dev returned ${response.status}`)
      }

      const raw = await response.json()
      const table = pricingTableFromModelsDev(raw)

      if (table.size > 0) {
        return { table, source: "models.dev/api.json", fetchedAt: new Date().toISOString() }
      }

      throw new Error("models.dev response did not contain OpenAI model costs")
    } catch (error) {
      return {
        table: bundledPricingTable(),
        source: "bundled",
        warning: `models.dev pricing fetch failed, using bundled fallback : ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  return { table: bundledPricingTable(), source: "bundled" }
}

export function estimateBreakdownCost(
  breakdown: TokenBreakdown,
  model: string,
  pricing: Map<string, ModelPricing>,
  estimateModel: string,
): number {
  const row =
    findPricing(model, pricing) ??
    findPricing(estimateModel, pricing) ??
    findPricing("gpt-5.5", pricing)

  if (!row) {
    return 0
  }

  const cached = Math.max(0, breakdown.cachedInputTokens)
  const nonCached = Math.max(0, breakdown.inputTokens - cached)
  const inputCost = (nonCached / 1_000_000) * row.inputPerMillion
  const cachedCost = (cached / 1_000_000) * (row.cachedInputPerMillion ?? row.inputPerMillion)
  const outputCost = (Math.max(0, breakdown.outputTokens) / 1_000_000) * row.outputPerMillion

  return inputCost + cachedCost + outputCost
}

export function estimateUnattributedCost(
  tokens: number,
  observedLocalCost: number,
  observedLocalTokens: number,
  estimateModel: string,
  pricing: Map<string, ModelPricing>,
): number {
  if (tokens <= 0) {
    return 0
  }

  if (observedLocalCost > 0 && observedLocalTokens > 0) {
    return tokens * (observedLocalCost / observedLocalTokens)
  }

  const row = findPricing(estimateModel, pricing) ?? findPricing("gpt-5.5", pricing)

  if (!row) {
    return 0
  }

  return (tokens / 1_000_000) * row.inputPerMillion
}

function pricingTableFromModelsDev(raw: any): Map<string, ModelPricing> {
  const provider = raw?.openai
  const models = provider?.models ?? { }
  const table = bundledPricingTable()

  for (const [id, model] of Object.entries<any>(models)) {
    const cost = model?.cost

    if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") {
      continue
    }

    table.set(id.toLowerCase(), {
      model: id,
      inputPerMillion: cost.input,
      cachedInputPerMillion: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
      outputPerMillion: cost.output,
      source: "models.dev/api.json",
    })
  }

  return table
}

function pricingTableFromObject(raw: any, source: string): Map<string, ModelPricing> {
  const table = bundledPricingTable()
  const rows = Array.isArray(raw) ? raw : Object.values(raw)

  for (const row of rows as any[]) {
    const model = row.model ?? row.id
    const input = row.inputPerMillion ?? row.input ?? row.input_per_million
    const output = row.outputPerMillion ?? row.output ?? row.output_per_million

    if (typeof model !== "string" || typeof input !== "number" || typeof output !== "number") {
      continue
    }

    table.set(model.toLowerCase(), {
      model,
      inputPerMillion: input,
      cachedInputPerMillion: row.cachedInputPerMillion ?? row.cache_read ?? row.cached_input_per_million,
      outputPerMillion: output,
      source,
    })
  }

  return table
}

function bundledPricingTable(): Map<string, ModelPricing> {
  const table = new Map<string, ModelPricing>()

  for (const row of BUNDLED) {
    table.set(row.model.toLowerCase(), row)
  }

  return table
}

function findPricing(model: string, pricing: Map<string, ModelPricing>): ModelPricing | undefined {
  const key = model.toLowerCase()

  if (pricing.has(key)) {
    return pricing.get(key)
  }

  const simplified = key.replace(/-\d{4}-\d{2}-\d{2}$/, "")

  if (pricing.has(simplified)) {
    return pricing.get(simplified)
  }

  if (key.includes("codex") && pricing.has(key.replace("-codex", ""))) {
    return pricing.get(key.replace("-codex", ""))
  }

  return undefined
}
