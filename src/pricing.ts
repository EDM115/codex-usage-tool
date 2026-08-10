import type {
  ContextPricing,
  ModelPricing,
  PricingRates,
  PricingSource,
  PricingTier,
  TokenBreakdown,
} from "./types";

import { readFileSync } from "node:fs";

import {
  addPricingPeriod,
  BUNDLED_MODEL_DEFINITIONS,
  createModelCatalog,
  ensureModelDefinition,
  pricingAt,
  primaryModelAt,
  validateModelCatalog,
  type ModelCatalog,
  type ModelPricingDefinition,
} from "./model-catalog";
import { OPENAI_PRICING_MARKDOWN_CACHE } from "./openai-pricing-cache";

export type PricingLoadResult = {
  table: Map<string, ModelPricing>;
  catalog: ModelCatalog;
  source: string;
  fetchedAt?: string;
  warning?: string;
};

const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const MODELS_DEV_URL = "https://models.dev/api.json";
const LONG_CONTEXT_THRESHOLD = 272_000;
const LONG_CONTEXT_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
]);

const BUNDLED: ModelPricing[] = [
  // OpenAI docs fallback, present in OpenAI pricing, not currently in models.dev OpenAI table
  {
    model: "chat-latest",
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    source: "alias:gpt-5.6-sol",
    aliasFor: "gpt-5.6-sol",
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
    inputPerMillion: 2,
    cachedInputPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
    outputPerMillion: 12,
    source: "bundled/OpenAI pricing snapshot 2026-07-30",
  },
  {
    model: "gpt-5.6-luna",
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    cacheWritePerMillion: 0.25,
    outputPerMillion: 1.2,
    source: "bundled/OpenAI pricing snapshot 2026-07-30",
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
];

export async function loadPricing(options: {
  source: PricingSource;
  pricingJson?: string;
  fetcher?: typeof fetch;
  effectiveDate?: string;
}): Promise<PricingLoadResult> {
  const effectiveDate = options.effectiveDate ?? new Date().toISOString().slice(0, 10);

  if (options.pricingJson) {
    const raw = JSON.parse(readFileSync(options.pricingJson, "utf8"));
    const source = `file:${options.pricingJson}`;
    const table = pricingTableFromObject(raw, source);
    const catalog = bundledPricingCatalog();
    const history = pricingHistoryFromObject(raw, source);

    if (history.length > 0) {
      const pricingKeys = new Set<string>();

      for (const row of history) {
        const key = `${row.model}|${row.effectiveFrom}`;

        if (pricingKeys.has(key)) {
          throw new Error(`Duplicate pricing definition for ${row.model} on ${row.effectiveFrom}`);
        }

        pricingKeys.add(key);
        ensureModelDefinition(catalog, row.model, row.effectiveFrom, source);
        addPricingPeriod(catalog, row);
      }

      validateModelCatalog(catalog);
    } else {
      overlayCurrentPricing(catalog, table, effectiveDate);
    }

    return {
      table,
      catalog,
      source,
    };
  }

  if (options.source === "bundled") {
    const table = bundledPricingTable();

    return {
      table,
      catalog: bundledPricingCatalog(table),
      source: "bundled effective-dated OpenAI pricing cache + models.dev snapshot",
    };
  }

  const fetcher = options.fetcher ?? fetch;
  const [openAiResult, modelsDevResult] = await Promise.allSettled([
    fetchOpenAiPricing(fetcher),
    fetchModelsDevPricing(fetcher),
  ]);
  const warnings: string[] = [];
  let openAiMarkdown = OPENAI_PRICING_MARKDOWN_CACHE;
  let openAiSource = "bundled OpenAI pricing cache";
  let fetchedAt: string | undefined;

  if (openAiResult.status === "fulfilled") {
    openAiMarkdown = openAiResult.value;
    openAiSource = "developers.openai.com/api/docs/pricing.md";
    fetchedAt = new Date().toISOString();
  } else {
    warnings.push(
      `OpenAI pricing fetch failed, using bundled cache : ${errorMessage(openAiResult.reason)}`,
    );
  }

  const table = pricingTableFromOpenAiMarkdown(openAiMarkdown, openAiSource);

  if (table.size === 0) {
    warnings.push(
      "OpenAI pricing Markdown contained no usable text pricing rows, using bundled cache",
    );
    mergePricingTables(
      table,
      pricingTableFromOpenAiMarkdown(OPENAI_PRICING_MARKDOWN_CACHE, "bundled OpenAI pricing cache"),
    );
  }

  const officialKeys = new Set(table.keys());
  addBundledFallbackRows(table);

  if (modelsDevResult.status === "fulfilled") {
    addModelsDevFallbackRows(table, modelsDevResult.value, "models.dev/api.json");
    fetchedAt ??= new Date().toISOString();
  } else {
    warnings.push(
      `models.dev pricing fetch failed, using bundled fallback rows : ${errorMessage(modelsDevResult.reason)}`,
    );
  }

  applyOpenAiAliases(table, officialKeys);
  const catalog = overlayCurrentPricing(bundledPricingCatalog(), table, effectiveDate);

  return {
    table,
    catalog,
    source: `bundled effective-dated history + ${openAiSource} current snapshot + models.dev fallback`,
    fetchedAt,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}

export function estimateBreakdownCost(
  breakdown: TokenBreakdown,
  model: string,
  pricing: ModelCatalog,
  estimateModel?: string,
  options: { date?: string; serviceTier?: string; modelContextWindow?: number } = {},
): number {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const primaryModel = primaryModelAt(pricing, date);
  const row =
    pricingAt(pricing, model, date) ??
    (estimateModel ? pricingAt(pricing, estimateModel, date) : undefined) ??
    (primaryModel ? pricingAt(pricing, primaryModel, date) : undefined);

  if (!row) {
    return 0;
  }

  const tier = normalizePricingTier(options.serviceTier);
  const contextPricing = row.tiers?.[tier] ?? row.tiers?.standard ?? { short: ratesFromRow(row) };
  const useLongContext =
    typeof options.modelContextWindow === "number" &&
    options.modelContextWindow > LONG_CONTEXT_THRESHOLD &&
    breakdown.inputTokens > LONG_CONTEXT_THRESHOLD;
  const rates = useLongContext && contextPricing.long ? contextPricing.long : contextPricing.short;
  const cached = Math.max(0, breakdown.cachedInputTokens);
  const nonCached = Math.max(0, breakdown.inputTokens - cached);
  const inputCost = (nonCached / 1_000_000) * rates.inputPerMillion;
  const cachedCost = (cached / 1_000_000) * (rates.cachedInputPerMillion ?? rates.inputPerMillion);
  const outputCost = (Math.max(0, breakdown.outputTokens) / 1_000_000) * rates.outputPerMillion;

  return inputCost + cachedCost + outputCost;
}

export function estimateCacheSavingsUsd(
  breakdown: TokenBreakdown,
  model: string,
  pricing: ModelCatalog,
  estimateModel?: string,
  options: { date?: string; serviceTier?: string; modelContextWindow?: number } = {},
): number {
  const cached = Math.max(0, breakdown.cachedInputTokens);

  if (cached === 0) {
    return 0;
  }

  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const primaryModel = primaryModelAt(pricing, date);
  const row =
    pricingAt(pricing, model, date) ??
    (estimateModel ? pricingAt(pricing, estimateModel, date) : undefined) ??
    (primaryModel ? pricingAt(pricing, primaryModel, date) : undefined);

  if (!row) {
    return 0;
  }

  const tier = normalizePricingTier(options.serviceTier);
  const contextPricing = row.tiers?.[tier] ?? row.tiers?.standard ?? { short: ratesFromRow(row) };
  const useLongContext =
    typeof options.modelContextWindow === "number" &&
    options.modelContextWindow > LONG_CONTEXT_THRESHOLD &&
    breakdown.inputTokens > LONG_CONTEXT_THRESHOLD;
  const rates = useLongContext && contextPricing.long ? contextPricing.long : contextPricing.short;
  const cachedRate = rates.cachedInputPerMillion ?? rates.inputPerMillion;

  return (cached / 1_000_000) * Math.max(0, rates.inputPerMillion - cachedRate);
}

export function estimateUnattributedCost(
  tokens: number,
  _observedLocalCost: number,
  _observedLocalTokens: number,
  estimateModel: string | undefined,
  pricing: ModelCatalog,
  options: { date?: string } = {},
): number {
  if (tokens <= 0) {
    return 0;
  }

  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const primaryModel = primaryModelAt(pricing, date);
  const row =
    (estimateModel ? pricingAt(pricing, estimateModel, date) : undefined) ??
    (primaryModel ? pricingAt(pricing, primaryModel, date) : undefined);

  if (!row) {
    return 0;
  }

  const rates = row.tiers?.standard?.short ?? ratesFromRow(row);

  return (tokens / 1_000_000) * rates.inputPerMillion;
}

function pricingTableFromOpenAiMarkdown(
  markdown: string,
  source: string,
): Map<string, ModelPricing> {
  const parsed = new Map<
    string,
    {
      model: string;
      longContext: boolean;
      tiers: Partial<Record<PricingTier, PricingRates>>;
      longTiers: Partial<Record<PricingTier, PricingRates>>;
    }
  >();
  const componentPattern =
    /<TextTokenPricingTables[\s\S]*?tier="(standard|batch|flex|priority)"[\s\S]*?rows=\{\[([\s\S]*?)\]\}\s*\/>/g;

  for (const component of markdown.matchAll(componentPattern)) {
    const tier = component[1] as PricingTier;
    const rows = component[2];
    const rowPattern = /\[\s*"([^"]+)"\s*,([\s\S]*?)\]/g;

    for (const rowMatch of rows.matchAll(rowPattern)) {
      const label = rowMatch[1];
      const model = normalizeOpenAiModelLabel(label);
      const rates = parseOpenAiRates(rowMatch[2]);

      if (!rates) {
        continue;
      }

      const key = model.toLowerCase();
      const current = parsed.get(key) ?? {
        model,
        longContext: LONG_CONTEXT_MODELS.has(key) || /<\s*272k\s+context/i.test(label),
        tiers: {},
        longTiers: {},
      };
      current.longContext ||= LONG_CONTEXT_MODELS.has(key) || /<\s*272k\s+context/i.test(label);
      current.tiers[tier] = rates;
      parsed.set(key, current);
    }
  }

  const markdownTablePattern = /^###\s+(standard|batch|flex|priority)\s+pricing data\s*$/gim;

  for (const section of markdown.matchAll(markdownTablePattern)) {
    const tier = section[1].toLowerCase() as PricingTier;
    const sectionBody = markdown.slice((section.index ?? 0) + section[0].length);
    const lines = sectionBody.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => line.trimStart().startsWith("|"));

    if (headerIndex < 0) {
      continue;
    }

    const headers = parseMarkdownTableRow(lines[headerIndex]).map((header) => header.toLowerCase());

    if (headers[0] !== "model") {
      continue;
    }

    for (
      let index = headerIndex + 2;
      index < lines.length && lines[index].trimStart().startsWith("|");
      index += 1
    ) {
      const cells = parseMarkdownTableRow(lines[index]);
      const label = cells[0];
      const model = normalizeOpenAiModelLabel(label);
      const shortRates = parseMarkdownPricingRates(headers, cells, "short");

      if (!shortRates) {
        continue;
      }

      const longRates = parseMarkdownPricingRates(headers, cells, "long");
      const key = model.toLowerCase();
      const current = parsed.get(key) ?? {
        model,
        longContext: LONG_CONTEXT_MODELS.has(key) || /<\s*272k\s+context/i.test(label),
        tiers: {},
        longTiers: {},
      };
      current.longContext ||=
        Boolean(longRates) || LONG_CONTEXT_MODELS.has(key) || /<\s*272k\s+context/i.test(label);
      current.tiers[tier] = shortRates;

      if (longRates) {
        current.longTiers[tier] = longRates;
      }

      parsed.set(key, current);
    }
  }

  const table = new Map<string, ModelPricing>();

  for (const [key, parsedRow] of parsed) {
    const standard = parsedRow.tiers.standard;

    if (!standard) {
      continue;
    }

    const tiers: Partial<Record<PricingTier, ContextPricing>> = {};

    for (const [tier, rates] of Object.entries(parsedRow.tiers) as [PricingTier, PricingRates][]) {
      tiers[tier] = {
        short: rates,
        long:
          parsedRow.longTiers[tier] ??
          (tier === "standard" && parsedRow.longContext ? longContextRates(rates) : undefined),
      };
    }

    table.set(key, {
      model: parsedRow.model,
      ...standard,
      source,
      tiers,
    });
  }

  return table;
}

function parseMarkdownTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseMarkdownPricingRates(
  headers: string[],
  cells: string[],
  context: "short" | "long",
): PricingRates | undefined {
  const value = (column: string) => {
    const index = headers.indexOf(`${context} context ${column}`);
    return index < 0 ? undefined : parsePriceValue(cells[index] ?? "");
  };
  const input = value("input");
  const output = value("output");

  if (typeof input !== "number" || typeof output !== "number") {
    return undefined;
  }

  return {
    inputPerMillion: input,
    cachedInputPerMillion: value("cached input"),
    cacheWritePerMillion: value("cache writes"),
    outputPerMillion: output,
  };
}

function parseOpenAiRates(rawValues: string): PricingRates | undefined {
  const values = rawValues.split(",").map(parsePriceValue);

  if (values.length !== 3 && values.length !== 4) {
    return undefined;
  }

  const [input, cached] = values;
  const cacheWrite = values.length === 4 ? values[2] : undefined;
  const output = values.at(-1);

  if (typeof input !== "number" || typeof output !== "number") {
    return undefined;
  }

  return {
    inputPerMillion: input,
    cachedInputPerMillion: typeof cached === "number" ? cached : undefined,
    cacheWritePerMillion: typeof cacheWrite === "number" ? cacheWrite : undefined,
    outputPerMillion: output,
  };
}

function parsePriceValue(value: string): number | undefined {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^\$/, "");

  if (normalized === "-" || normalized === "null" || normalized === "") {
    return undefined;
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOpenAiModelLabel(label: string): string {
  return label.replace(/\s*\(<\s*272k\s+context length\)\s*$/i, "").trim();
}

async function fetchOpenAiPricing(fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(OPENAI_PRICING_URL);

  if (!response.ok) {
    throw new Error(`OpenAI pricing returned ${response.status}`);
  }

  const markdown = await response.text();

  if (pricingTableFromOpenAiMarkdown(markdown, "validation").size === 0) {
    throw new Error("OpenAI pricing response did not contain usable text pricing rows");
  }

  return markdown;
}

async function fetchModelsDevPricing(fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(MODELS_DEV_URL);

  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status}`);
  }

  return response.json();
}

function addModelsDevFallbackRows(
  table: Map<string, ModelPricing>,
  raw: any,
  source: string,
): void {
  const provider = raw?.openai;
  const models = provider?.models ?? {};

  for (const [id, model] of Object.entries<any>(models)) {
    const cost = model?.cost;
    const key = id.toLowerCase();

    if (
      table.has(key) ||
      !cost ||
      typeof cost.input !== "number" ||
      typeof cost.output !== "number"
    ) {
      continue;
    }

    const standard: PricingRates = {
      inputPerMillion: cost.input,
      cachedInputPerMillion: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
      cacheWritePerMillion: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
      outputPerMillion: cost.output,
    };
    const long = pricingRatesFromModelsDev(cost.context_over_200k);
    const standardContext: ContextPricing = { short: standard, long };
    const priorityContext: ContextPricing = {
      short: scaleRates(standard, 2),
      long: long ? scaleRates(long, 2) : undefined,
    };

    table.set(key, {
      model: id,
      ...standard,
      source,
      tiers: { standard: standardContext, priority: priorityContext },
    });
  }
}

function pricingTableFromObject(raw: any, source: string): Map<string, ModelPricing> {
  const table = bundledPricingTable();
  const rows = Array.isArray(raw) ? raw : Object.values(raw);

  for (const row of rows as any[]) {
    const model = row.model ?? row.id;
    const input = row.inputPerMillion ?? row.input ?? row.input_per_million;
    const output = row.outputPerMillion ?? row.output ?? row.output_per_million;

    if (typeof model !== "string" || typeof input !== "number" || typeof output !== "number") {
      continue;
    }

    const standard: PricingRates = {
      inputPerMillion: input,
      cachedInputPerMillion:
        row.cachedInputPerMillion ?? row.cache_read ?? row.cached_input_per_million,
      cacheWritePerMillion:
        row.cacheWritePerMillion ?? row.cache_write ?? row.cache_write_per_million,
      outputPerMillion: output,
    };

    table.set(model.toLowerCase(), {
      model,
      ...standard,
      source,
      tiers: { standard: { short: standard } },
    });
  }

  return table;
}

function pricingHistoryFromObject(raw: any, source: string): ModelPricingDefinition[] {
  const rows = Array.isArray(raw) ? raw : Object.values(raw);
  const history: ModelPricingDefinition[] = [];

  for (const row of rows as any[]) {
    const model = row.model ?? row.id;
    const effectiveFrom = row.effectiveFrom ?? row.effective_from;
    const input = row.inputPerMillion ?? row.input ?? row.input_per_million;
    const output = row.outputPerMillion ?? row.output ?? row.output_per_million;

    if (
      typeof model !== "string" ||
      typeof effectiveFrom !== "string" ||
      typeof input !== "number" ||
      typeof output !== "number"
    ) {
      continue;
    }

    const standard: PricingRates = {
      inputPerMillion: input,
      cachedInputPerMillion:
        row.cachedInputPerMillion ?? row.cache_read ?? row.cached_input_per_million,
      cacheWritePerMillion:
        row.cacheWritePerMillion ?? row.cache_write ?? row.cache_write_per_million,
      outputPerMillion: output,
    };

    history.push({
      model: model.toLowerCase(),
      ...standard,
      effectiveFrom,
      source,
      tiers: row.tiers ?? { standard: { short: standard } },
    });
  }

  return history.sort(
    (a, b) => a.model.localeCompare(b.model) || a.effectiveFrom.localeCompare(b.effectiveFrom),
  );
}

function bundledPricingTable(): Map<string, ModelPricing> {
  const table = pricingTableFromOpenAiMarkdown(
    OPENAI_PRICING_MARKDOWN_CACHE,
    "bundled OpenAI pricing cache 2026-07-30",
  );
  const officialKeys = new Set(table.keys());

  addBundledFallbackRows(table);
  applyOpenAiAliases(table, officialKeys);

  return table;
}

function bundledPricingCatalog(table = bundledPricingTable()): ModelCatalog {
  const catalog = createModelCatalog();

  for (const [key, row] of table) {
    if (row.aliasFor) {
      continue;
    }

    const definition = BUNDLED_MODEL_DEFINITIONS.find(
      (candidate) => candidate.model.toLowerCase() === key,
    );
    const effectiveFrom = definition?.releasedOn ?? "2026-07-30";

    if (key === "gpt-5.6-terra" || key === "gpt-5.6-luna") {
      addPricingPeriod(catalog, preReductionGpt56Pricing(key));
      addPricingPeriod(catalog, pricingDefinition(row, "2026-07-30"));
    } else {
      addPricingPeriod(catalog, pricingDefinition(row, effectiveFrom));
    }
  }

  seedDocumentedPriceHistory(catalog, table);
  validateModelCatalog(catalog);

  return catalog;
}

function overlayCurrentPricing(
  catalog: ModelCatalog,
  table: Map<string, ModelPricing>,
  effectiveDate: string,
): ModelCatalog {
  for (const [key, row] of table) {
    if (row.aliasFor) {
      continue;
    }

    ensureModelDefinition(catalog, key, effectiveDate, row.source);
    const current = pricingAt(catalog, key, effectiveDate);

    if (!current || !samePricing(current, row)) {
      addPricingPeriod(catalog, pricingDefinition(row, effectiveDate));
    }
  }

  validateModelCatalog(catalog);

  return catalog;
}

function pricingDefinition(row: ModelPricing, effectiveFrom: string): ModelPricingDefinition {
  return {
    ...row,
    model: row.model.toLowerCase(),
    effectiveFrom,
  };
}

function preReductionGpt56Pricing(model: "gpt-5.6-terra" | "gpt-5.6-luna"): ModelPricingDefinition {
  const standard =
    model === "gpt-5.6-terra"
      ? {
          inputPerMillion: 2.5,
          cachedInputPerMillion: 0.25,
          cacheWritePerMillion: 3.125,
          outputPerMillion: 15,
        }
      : {
          inputPerMillion: 1,
          cachedInputPerMillion: 0.1,
          cacheWritePerMillion: 1.25,
          outputPerMillion: 6,
        };
  const standardLong =
    model === "gpt-5.6-terra"
      ? {
          inputPerMillion: 5,
          cachedInputPerMillion: 0.5,
          cacheWritePerMillion: 6.25,
          outputPerMillion: 22.5,
        }
      : {
          inputPerMillion: 2,
          cachedInputPerMillion: 0.2,
          cacheWritePerMillion: 2.5,
          outputPerMillion: 9,
        };
  const half = scaleRates(standard, 0.5);
  const halfLong = scaleRates(standardLong, 0.5);

  return {
    model,
    ...standard,
    effectiveFrom: "2026-07-09",
    source: "https://openai.com/index/gpt-5-6/",
    tiers: {
      standard: { short: standard, long: standardLong },
      batch: { short: half, long: halfLong },
      flex: { short: half, long: halfLong },
      priority: { short: scaleRates(standard, 2) },
    },
  };
}

function seedDocumentedPriceHistory(catalog: ModelCatalog, table: Map<string, ModelPricing>): void {
  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "gpt-4o",
      "2024-05-13",
      5,
      undefined,
      15,
      "https://openai.com/index/hello-gpt-4o/",
    ),
  );
  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "gpt-4o",
      "2024-08-06",
      2.5,
      undefined,
      10,
      "https://openai.com/index/api-prompt-caching/",
    ),
  );
  const gpt4o = table.get("gpt-4o");

  if (gpt4o) {
    addPricingPeriod(catalog, pricingDefinition(gpt4o, "2024-10-01"));
  }

  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "gpt-4o-mini",
      "2024-07-18",
      0.15,
      undefined,
      0.6,
      "https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/",
    ),
  );
  const gpt4oMini = table.get("gpt-4o-mini");

  if (gpt4oMini) {
    addPricingPeriod(catalog, pricingDefinition(gpt4oMini, "2024-10-01"));
  }

  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "gpt-3.5-turbo",
      "2023-03-01",
      2,
      undefined,
      2,
      "https://openai.com/index/introducing-chatgpt-and-whisper-apis/",
    ),
  );
  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "gpt-3.5-turbo",
      "2023-06-13",
      1.5,
      undefined,
      2,
      "https://openai.com/index/function-calling-and-other-api-updates/",
    ),
  );
  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "gpt-3.5-turbo",
      "2023-11-06",
      1,
      undefined,
      2,
      "https://openai.com/index/new-models-and-developer-products-announced-at-devday/",
    ),
  );
  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "gpt-3.5-turbo",
      "2024-01-25",
      0.5,
      undefined,
      1.5,
      "https://openai.com/index/new-embedding-models-and-api-updates/",
    ),
  );
  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "text-embedding-ada-002",
      "2022-12-15",
      0.4,
      undefined,
      0,
      "https://openai.com/index/new-and-improved-embedding-model/",
    ),
  );
  addPricingPeriod(
    catalog,
    standardPricingPeriod(
      "text-embedding-ada-002",
      "2023-06-13",
      0.1,
      undefined,
      0,
      "https://openai.com/index/function-calling-and-other-api-updates/",
    ),
  );
}

function standardPricingPeriod(
  model: string,
  effectiveFrom: string,
  inputPerMillion: number,
  cachedInputPerMillion: number | undefined,
  outputPerMillion: number,
  source: string,
): ModelPricingDefinition {
  const short: PricingRates = {
    inputPerMillion,
    cachedInputPerMillion,
    outputPerMillion,
  };

  return {
    model,
    ...short,
    effectiveFrom,
    source,
    tiers: { standard: { short } },
  };
}

function samePricing(left: ModelPricing, right: ModelPricing): boolean {
  return JSON.stringify(pricingFingerprint(left)) === JSON.stringify(pricingFingerprint(right));
}

function pricingFingerprint(row: ModelPricing) {
  return {
    inputPerMillion: row.inputPerMillion,
    cachedInputPerMillion: row.cachedInputPerMillion,
    cacheWritePerMillion: row.cacheWritePerMillion,
    outputPerMillion: row.outputPerMillion,
    tiers: row.tiers,
  };
}

function addBundledFallbackRows(table: Map<string, ModelPricing>): void {
  for (const bundledRow of BUNDLED) {
    const key = bundledRow.model.toLowerCase();

    if (table.has(key)) {
      continue;
    }

    const standard = ratesFromRow(bundledRow);
    table.set(key, {
      ...bundledRow,
      tiers: {
        standard: { short: standard },
        priority: { short: scaleRates(standard, 2) },
      },
    });
  }
}

function findPricing(model: string, pricing: Map<string, ModelPricing>): ModelPricing | undefined {
  const key = model.toLowerCase();

  if (pricing.has(key)) {
    return resolveAlias(pricing.get(key), pricing);
  }

  const simplified = key.replace(/-\d{4}-\d{2}-\d{2}$/, "");

  if (pricing.has(simplified)) {
    return resolveAlias(pricing.get(simplified), pricing);
  }

  if (key.includes("codex") && pricing.has(key.replace("-codex", ""))) {
    return resolveAlias(pricing.get(key.replace("-codex", "")), pricing);
  }

  return undefined;
}

function applyOpenAiAliases(table: Map<string, ModelPricing>, officialKeys: Set<string>): void {
  // Auto-review is reported as a private codex-auto-review/guardian model. Keep a current-table
  // alias for compatibility until an exact public pricing row appears; dated resolution lives in
  // model-catalog.ts.
  // https://alignment.openai.com/auto-review/
  // https://github.com/openai/codex/issues/20981
  // https://github.com/openai/codex/issues/19420
  // https://github.com/yuya-takeyama/junrei/pull/67
  const explicitAliases = new Map<string, string>([
    ["chat-latest", "gpt-5.6-sol"],
    ["codex-auto-review", "gpt-5.6-luna"],
    ["guardian", "gpt-5.6-luna"],
    ["gpt-5.1-codex-mini", "gpt-5-mini"],
    ["gpt-5.6", "gpt-5.6-sol"],
  ]);

  for (const key of table.keys()) {
    const canonical = key.replace(/-(?:codex(?:-max)?|chat-latest)$/, "");

    if (canonical !== key && officialKeys.has(canonical)) {
      explicitAliases.set(key, canonical);
    }
  }

  for (const [alias, canonical] of explicitAliases) {
    if (officialKeys.has(alias)) {
      continue;
    }

    const target = table.get(canonical);

    if (!target) {
      continue;
    }

    table.set(alias, {
      ...target,
      model: alias,
      aliasFor: canonical,
      source: `alias:${canonical}`,
    });
  }
}

function resolveAlias(
  row: ModelPricing | undefined,
  pricing: Map<string, ModelPricing>,
): ModelPricing | undefined {
  const visited = new Set<string>();

  while (row?.aliasFor) {
    const key = row.aliasFor.toLowerCase();

    if (visited.has(key)) {
      return undefined;
    }

    visited.add(key);
    row = pricing.get(key);
  }

  return row;
}

function normalizePricingTier(serviceTier?: string): PricingTier {
  switch (serviceTier?.toLowerCase()) {
    case "priority":
    case "fast":
      return "priority";
    case "batch":
      return "batch";
    case "flex":
      return "flex";
    default:
      return "standard";
  }
}

function ratesFromRow(row: ModelPricing): PricingRates {
  return {
    inputPerMillion: row.inputPerMillion,
    cachedInputPerMillion: row.cachedInputPerMillion,
    cacheWritePerMillion: row.cacheWritePerMillion,
    outputPerMillion: row.outputPerMillion,
  };
}

function pricingRatesFromModelsDev(cost: any): PricingRates | undefined {
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") {
    return undefined;
  }

  return {
    inputPerMillion: cost.input,
    cachedInputPerMillion: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
    cacheWritePerMillion: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
    outputPerMillion: cost.output,
  };
}

function scaleRates(rates: PricingRates, multiplier: number): PricingRates {
  return {
    inputPerMillion: rates.inputPerMillion * multiplier,
    cachedInputPerMillion:
      typeof rates.cachedInputPerMillion === "number"
        ? rates.cachedInputPerMillion * multiplier
        : undefined,
    cacheWritePerMillion:
      typeof rates.cacheWritePerMillion === "number"
        ? rates.cacheWritePerMillion * multiplier
        : undefined,
    outputPerMillion: rates.outputPerMillion * multiplier,
  };
}

function longContextRates(rates: PricingRates): PricingRates {
  return {
    inputPerMillion: rates.inputPerMillion * 2,
    cachedInputPerMillion:
      typeof rates.cachedInputPerMillion === "number" ? rates.cachedInputPerMillion * 2 : undefined,
    cacheWritePerMillion:
      typeof rates.cacheWritePerMillion === "number" ? rates.cacheWritePerMillion * 2 : undefined,
    outputPerMillion: rates.outputPerMillion * 1.5,
  };
}

function mergePricingTables(
  target: Map<string, ModelPricing>,
  source: Map<string, ModelPricing>,
): void {
  for (const [key, row] of source) {
    target.set(key, row);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
