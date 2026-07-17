import type {
  ContextPricing,
  ModelPricing,
  PricingRates,
  PricingSource,
  PricingTier,
  TokenBreakdown,
} from "./types"

import { readFileSync } from "node:fs"

import { OPENAI_PRICING_MARKDOWN_CACHE } from "./openai-pricing-cache"

export type PricingLoadResult = {
  table: Map<string, ModelPricing>
  source: string
  fetchedAt?: string
  warning?: string
}

const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md"
const MODELS_DEV_URL = "https://models.dev/api.json"
const LONG_CONTEXT_THRESHOLD = 272_000
const LONG_CONTEXT_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
])

const BUNDLED: ModelPricing[] = [
  // OpenAI docs fallback, present in OpenAI pricing, not currently in models.dev OpenAI table
  {
    model: "chat-latest",
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    source: "bundled/openai dev docs snapshot 2026-07-01",
  },

  // GPT-5.6 latest flagship models
  {
    model: "gpt-5.6-sol",
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    source: "bundled/models.dev snapshot 2026-07-10",
  },
  {
    model: "gpt-5.6-terra",
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 15,
    source: "bundled/models.dev snapshot 2026-07-10",
  },
  {
    model: "gpt-5.6-luna",
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6,
    source: "bundled/models.dev snapshot 2026-07-10",
  },

  // GPT-5.5/GPT-5.4
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
  fetcher?: typeof fetch
}): Promise<PricingLoadResult> {
  if (options.pricingJson) {
    const raw = JSON.parse(readFileSync(options.pricingJson, "utf8"))

    return {
      table: pricingTableFromObject(raw, `file:${options.pricingJson}`),
      source: `file:${options.pricingJson}`,
    }
  }

  if (options.source === "bundled") {
    return { table: bundledPricingTable(), source: "bundled OpenAI pricing cache + models.dev snapshot" }
  }

  const fetcher = options.fetcher ?? fetch
  const [openAiResult, modelsDevResult] = await Promise.allSettled([
    fetchOpenAiPricing(fetcher),
    fetchModelsDevPricing(fetcher),
  ])
  const warnings: string[] = []
  let openAiMarkdown = OPENAI_PRICING_MARKDOWN_CACHE
  let openAiSource = "bundled OpenAI pricing cache"
  let fetchedAt: string | undefined

  if (openAiResult.status === "fulfilled") {
    openAiMarkdown = openAiResult.value
    openAiSource = "developers.openai.com/api/docs/pricing.md"
    fetchedAt = new Date().toISOString()
  } else {
    warnings.push(`OpenAI pricing fetch failed, using bundled cache : ${errorMessage(openAiResult.reason)}`)
  }

  const table = pricingTableFromOpenAiMarkdown(openAiMarkdown, openAiSource)

  if (table.size === 0) {
    warnings.push("OpenAI pricing Markdown contained no usable text pricing rows, using bundled cache")
    mergePricingTables(table, pricingTableFromOpenAiMarkdown(OPENAI_PRICING_MARKDOWN_CACHE, "bundled OpenAI pricing cache"))
  }

  const officialKeys = new Set(table.keys())
  addBundledFallbackRows(table)

  if (modelsDevResult.status === "fulfilled") {
    addModelsDevFallbackRows(table, modelsDevResult.value, "models.dev/api.json")
    fetchedAt ??= new Date().toISOString()
  } else {
    warnings.push(`models.dev pricing fetch failed, using bundled fallback rows : ${errorMessage(modelsDevResult.reason)}`)
  }

  applyOpenAiAliases(table, officialKeys)

  return {
    table,
    source: `${openAiSource} + models.dev fallback`,
    fetchedAt,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  }
}

export function estimateBreakdownCost(
  breakdown: TokenBreakdown,
  model: string,
  pricing: Map<string, ModelPricing>,
  estimateModel: string,
  options: { serviceTier?: string; modelContextWindow?: number } = {},
): number {
  const row =
    findPricing(model, pricing) ??
    findPricing(estimateModel, pricing) ??
    findPricing("gpt-5.6-sol", pricing)

  if (!row) {
    return 0
  }

  const tier = normalizePricingTier(options.serviceTier)
  const contextPricing = row.tiers?.[tier] ?? row.tiers?.standard ?? { short: ratesFromRow(row) }
  const useLongContext =
    typeof options.modelContextWindow === "number" &&
    options.modelContextWindow > LONG_CONTEXT_THRESHOLD &&
    breakdown.inputTokens > LONG_CONTEXT_THRESHOLD
  const rates = useLongContext && contextPricing.long ? contextPricing.long : contextPricing.short
  const cached = Math.max(0, breakdown.cachedInputTokens)
  const nonCached = Math.max(0, breakdown.inputTokens - cached)
  const inputCost = (nonCached / 1_000_000) * rates.inputPerMillion
  const cachedCost = (cached / 1_000_000) * (rates.cachedInputPerMillion ?? rates.inputPerMillion)
  const outputCost = (Math.max(0, breakdown.outputTokens) / 1_000_000) * rates.outputPerMillion

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

  const row = findPricing(estimateModel, pricing) ?? findPricing("gpt-5.6-sol", pricing)

  if (!row) {
    return 0
  }

  const rates = row.tiers?.standard?.short ?? ratesFromRow(row)

  return (tokens / 1_000_000) * rates.inputPerMillion
}

function pricingTableFromOpenAiMarkdown(markdown: string, source: string): Map<string, ModelPricing> {
  const parsed = new Map<string, { model: string; longContext: boolean; tiers: Partial<Record<PricingTier, PricingRates>> }>()
  const componentPattern = /<TextTokenPricingTables[\s\S]*?tier="(standard|batch|flex|priority)"[\s\S]*?rows=\{\[([\s\S]*?)\]\}\s*\/>/g

  for (const component of markdown.matchAll(componentPattern)) {
    const tier = component[1] as PricingTier
    const rows = component[2]
    const rowPattern = /\[\s*"([^"]+)"\s*,([\s\S]*?)\]/g

    for (const rowMatch of rows.matchAll(rowPattern)) {
      const label = rowMatch[1]
      const model = normalizeOpenAiModelLabel(label)
      const rates = parseOpenAiRates(rowMatch[2])

      if (!rates) {
        continue
      }

      const key = model.toLowerCase()
      const current = parsed.get(key) ?? {
        model,
        longContext: LONG_CONTEXT_MODELS.has(key) || /<\s*272k\s+context/i.test(label),
        tiers: {},
      }
      current.longContext ||= LONG_CONTEXT_MODELS.has(key) || /<\s*272k\s+context/i.test(label)
      current.tiers[tier] = rates
      parsed.set(key, current)
    }
  }

  const table = new Map<string, ModelPricing>()

  for (const [key, parsedRow] of parsed) {
    const standard = parsedRow.tiers.standard

    if (!standard) {
      continue
    }

    const tiers: Partial<Record<PricingTier, ContextPricing>> = {}

    for (const [tier, rates] of Object.entries(parsedRow.tiers) as [PricingTier, PricingRates][]) {
      tiers[tier] = {
        short: rates,
        long: tier === "standard" && parsedRow.longContext ? longContextRates(rates) : undefined,
      }
    }

    table.set(key, {
      model: parsedRow.model,
      ...standard,
      source,
      tiers,
    })
  }

  return table
}

function parseOpenAiRates(rawValues: string): PricingRates | undefined {
  const values = rawValues.split(",").map(parsePriceValue)

  if (values.length !== 3 && values.length !== 4) {
    return undefined
  }

  const [input, cached] = values
  const cacheWrite = values.length === 4 ? values[2] : undefined
  const output = values.at(-1)

  if (typeof input !== "number" || typeof output !== "number") {
    return undefined
  }

  return {
    inputPerMillion: input,
    cachedInputPerMillion: typeof cached === "number" ? cached : undefined,
    cacheWritePerMillion: typeof cacheWrite === "number" ? cacheWrite : undefined,
    outputPerMillion: output,
  }
}

function parsePriceValue(value: string): number | undefined {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "")

  if (normalized === "-" || normalized === "null" || normalized === "") {
    return undefined
  }

  const parsed = Number(normalized)

  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeOpenAiModelLabel(label: string): string {
  return label.replace(/\s*\(<\s*272k\s+context length\)\s*$/i, "").trim()
}

async function fetchOpenAiPricing(fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(OPENAI_PRICING_URL)

  if (!response.ok) {
    throw new Error(`OpenAI pricing returned ${response.status}`)
  }

  const markdown = await response.text()

  if (pricingTableFromOpenAiMarkdown(markdown, "validation").size === 0) {
    throw new Error("OpenAI pricing response did not contain usable text pricing rows")
  }

  return markdown
}

async function fetchModelsDevPricing(fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(MODELS_DEV_URL)

  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status}`)
  }

  return response.json()
}

function addModelsDevFallbackRows(table: Map<string, ModelPricing>, raw: any, source: string): void {
  const provider = raw?.openai
  const models = provider?.models ?? {}

  for (const [id, model] of Object.entries<any>(models)) {
    const cost = model?.cost
    const key = id.toLowerCase()

    if (table.has(key) || !cost || typeof cost.input !== "number" || typeof cost.output !== "number") {
      continue
    }

    const standard: PricingRates = {
      inputPerMillion: cost.input,
      cachedInputPerMillion: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
      cacheWritePerMillion: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
      outputPerMillion: cost.output,
    }
    const long = pricingRatesFromModelsDev(cost.context_over_200k)
    const standardContext: ContextPricing = { short: standard, long }
    const priorityContext: ContextPricing = {
      short: scaleRates(standard, 2),
      long: long ? scaleRates(long, 2) : undefined,
    }

    table.set(key, {
      model: id,
      ...standard,
      source,
      tiers: { standard: standardContext, priority: priorityContext },
    })
  }
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

    const standard: PricingRates = {
      inputPerMillion: input,
      cachedInputPerMillion: row.cachedInputPerMillion ?? row.cache_read ?? row.cached_input_per_million,
      cacheWritePerMillion: row.cacheWritePerMillion ?? row.cache_write ?? row.cache_write_per_million,
      outputPerMillion: output,
    }

    table.set(model.toLowerCase(), {
      model,
      ...standard,
      source,
      tiers: { standard: { short: standard } },
    })
  }

  return table
}

function bundledPricingTable(): Map<string, ModelPricing> {
  const table = pricingTableFromOpenAiMarkdown(
    OPENAI_PRICING_MARKDOWN_CACHE,
    "bundled OpenAI pricing cache 2026-07-17",
  )
  const officialKeys = new Set(table.keys())

  addBundledFallbackRows(table)
  applyOpenAiAliases(table, officialKeys)

  return table
}

function addBundledFallbackRows(table: Map<string, ModelPricing>): void {
  for (const bundledRow of BUNDLED) {
    const key = bundledRow.model.toLowerCase()

    if (table.has(key)) {
      continue
    }

    const standard = ratesFromRow(bundledRow)
    table.set(key, {
      ...bundledRow,
      tiers: {
        standard: { short: standard },
        priority: { short: scaleRates(standard, 2) },
      },
    })
  }
}

function findPricing(model: string, pricing: Map<string, ModelPricing>): ModelPricing | undefined {
  const key = model.toLowerCase()

  if (pricing.has(key)) {
    return resolveAlias(pricing.get(key), pricing)
  }

  const simplified = key.replace(/-\d{4}-\d{2}-\d{2}$/, "")

  if (pricing.has(simplified)) {
    return resolveAlias(pricing.get(simplified), pricing)
  }

  if (key.includes("codex") && pricing.has(key.replace("-codex", ""))) {
    return resolveAlias(pricing.get(key.replace("-codex", "")), pricing)
  }

  return undefined
}

function applyOpenAiAliases(table: Map<string, ModelPricing>, officialKeys: Set<string>): void {
  // Auto-review is currently reported as a private codex-auto-review/guardian model. OpenAI says
  // the reviewer uses GPT-5.4 Thinking, so keep this alias until an exact public pricing row appears:
  // https://alignment.openai.com/auto-review/
  // https://github.com/openai/codex/issues/20981
  // https://github.com/openai/codex/issues/19420
  // https://github.com/yuya-takeyama/junrei/pull/67
  const explicitAliases = new Map<string, string>([
    ["codex-auto-review", "gpt-5.4"],
    ["guardian", "gpt-5.4"],
    ["gpt-5.1-codex-mini", "gpt-5-mini"],
    ["gpt-5.6", "gpt-5.6-sol"],
  ])

  for (const key of table.keys()) {
    const canonical = key.replace(/-(?:codex(?:-max)?|chat-latest)$/, "")

    if (canonical !== key && officialKeys.has(canonical)) {
      explicitAliases.set(key, canonical)
    }
  }

  for (const [alias, canonical] of explicitAliases) {
    if (officialKeys.has(alias)) {
      continue
    }

    const target = table.get(canonical)

    if (!target) {
      continue
    }

    table.set(alias, {
      ...target,
      model: alias,
      aliasFor: canonical,
      source: `alias:${canonical}`,
    })
  }
}

function resolveAlias(
  row: ModelPricing | undefined,
  pricing: Map<string, ModelPricing>,
): ModelPricing | undefined {
  const visited = new Set<string>()

  while (row?.aliasFor) {
    const key = row.aliasFor.toLowerCase()

    if (visited.has(key)) {
      return undefined
    }

    visited.add(key)
    row = pricing.get(key)
  }

  return row
}

function normalizePricingTier(serviceTier?: string): PricingTier {
  switch (serviceTier?.toLowerCase()) {
    case "priority":
    case "fast":
      return "priority"
    case "batch":
      return "batch"
    case "flex":
      return "flex"
    default:
      return "standard"
  }
}

function ratesFromRow(row: ModelPricing): PricingRates {
  return {
    inputPerMillion: row.inputPerMillion,
    cachedInputPerMillion: row.cachedInputPerMillion,
    cacheWritePerMillion: row.cacheWritePerMillion,
    outputPerMillion: row.outputPerMillion,
  }
}

function pricingRatesFromModelsDev(cost: any): PricingRates | undefined {
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") {
    return undefined
  }

  return {
    inputPerMillion: cost.input,
    cachedInputPerMillion: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
    cacheWritePerMillion: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
    outputPerMillion: cost.output,
  }
}

function scaleRates(rates: PricingRates, multiplier: number): PricingRates {
  return {
    inputPerMillion: rates.inputPerMillion * multiplier,
    cachedInputPerMillion:
      typeof rates.cachedInputPerMillion === "number"
        ? rates.cachedInputPerMillion * multiplier
        : undefined,
    cacheWritePerMillion:
      typeof rates.cacheWritePerMillion === "number" ? rates.cacheWritePerMillion * multiplier : undefined,
    outputPerMillion: rates.outputPerMillion * multiplier,
  }
}

function longContextRates(rates: PricingRates): PricingRates {
  return {
    inputPerMillion: rates.inputPerMillion * 2,
    cachedInputPerMillion:
      typeof rates.cachedInputPerMillion === "number" ? rates.cachedInputPerMillion * 2 : undefined,
    cacheWritePerMillion:
      typeof rates.cacheWritePerMillion === "number" ? rates.cacheWritePerMillion * 2 : undefined,
    outputPerMillion: rates.outputPerMillion * 1.5,
  }
}

function mergePricingTables(target: Map<string, ModelPricing>, source: Map<string, ModelPricing>): void {
  for (const [key, row] of source) {
    target.set(key, row)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
