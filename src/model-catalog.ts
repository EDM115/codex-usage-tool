import type { ModelPricing } from "./types";

export type ModelDefinition = {
  model: string;
  releasedOn: string;
  canBePrimary: boolean;
  source: string;
};

export type ModelAliasDefinition = {
  alias: string;
  target: string;
  effectiveFrom: string;
  source: string;
};

export type ModelPricingDefinition = ModelPricing & {
  effectiveFrom: string;
};

export type ModelCatalog = {
  models: ModelDefinition[];
  aliases: ModelAliasDefinition[];
  pricing: Map<string, ModelPricingDefinition[]>;
};

const SOURCES = {
  gpt56: "https://openai.com/index/gpt-5-6/",
  gpt56Cyber: "https://developers.openai.com/api/docs/models/gpt-5.6-cyber",
  daybreakBlue: "https://developers.openai.com/api/docs/models/daybreak-blue-latest",
  daybreakRed: "https://developers.openai.com/api/docs/models/daybreak-red-latest",
  pricing: "https://developers.openai.com/api/docs/pricing",
  gpt55: "https://openai.com/index/introducing-gpt-5-5/",
  gpt54: "https://openai.com/index/introducing-gpt-5-4/",
  gpt54Small: "https://openai.com/index/introducing-gpt-5-4-mini-and-nano/",
  gpt53: "https://openai.com/index/introducing-gpt-5-3-codex/",
  gpt53Spark: "https://openai.com/index/introducing-gpt-5-3-codex-spark/",
  gpt52: "https://openai.com/index/introducing-gpt-5-2/",
  gpt52Codex: "https://openai.com/index/introducing-gpt-5-2-codex/",
  gpt51: "https://deploymentsafety.openai.com/gpt-5-1/5_1_system_card.pdf",
  gpt51CodexMax: "https://openai.com/index/gpt-5-1-codex-max/",
  gpt5: "https://openai.com/index/introducing-gpt-5-for-developers/",
  gpt5Codex: "https://openai.com/index/introducing-upgrades-to-codex/",
  gpt41: "https://openai.com/index/gpt-4-1/",
  gpt4o: "https://openai.com/index/gpt-4o-and-more-tools-to-chatgpt-free/",
  gpt4oMini: "https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/",
  o1: "https://openai.com/index/introducing-openai-o1-preview/",
  o1Pro: "https://developers.openai.com/api/docs/models/o1-pro",
  o3Mini: "https://openai.com/index/openai-o3-mini/",
  o3: "https://openai.com/index/introducing-o3-and-o4-mini/",
  legacy: "https://platform.openai.com/docs/deprecations",
  embeddings: "https://openai.com/index/new-embedding-models-and-api-updates/",
  image2:
    "https://community.openai.com/t/introducing-gpt-image-2-available-today-in-the-api-and-codex/1379479",
} as const;

function model(
  name: string,
  releasedOn: string,
  source: string,
  canBePrimary = false,
): ModelDefinition {
  return { model: name, releasedOn, canBePrimary, source };
}

export const BUNDLED_MODEL_DEFINITIONS: ModelDefinition[] = [
  model("gpt-5.6-sol", "2026-07-09", SOURCES.gpt56, true),
  model("gpt-5.6-terra", "2026-07-09", SOURCES.gpt56),
  model("gpt-5.6-luna", "2026-07-09", SOURCES.gpt56),
  model("gpt-5.6-cyber", "2026-08-21", SOURCES.gpt56Cyber),
  model("gpt-5.5-cyber", "2026-07-30", SOURCES.pricing),
  model("gpt-5.4-cyber", "2026-07-30", SOURCES.pricing),
  model("gpt-5.5", "2026-04-23", SOURCES.gpt55, true),
  model("gpt-5.5-pro", "2026-04-23", SOURCES.gpt55),
  model("gpt-5.4", "2026-03-05", SOURCES.gpt54, true),
  model("gpt-5.4-pro", "2026-03-05", SOURCES.gpt54),
  model("gpt-5.4-mini", "2026-03-17", SOURCES.gpt54Small),
  model("gpt-5.4-nano", "2026-03-17", SOURCES.gpt54Small),
  model("gpt-5.3-chat-latest", "2026-02-05", SOURCES.gpt53),
  model("gpt-5.3-codex", "2026-02-05", SOURCES.gpt53, true),
  model("gpt-5.3-codex-spark", "2026-02-12", SOURCES.gpt53Spark),
  model("gpt-5.2", "2025-12-11", SOURCES.gpt52, true),
  model("gpt-5.2-chat-latest", "2025-12-11", SOURCES.gpt52),
  model("gpt-5.2-pro", "2025-12-11", SOURCES.gpt52),
  model("gpt-5.2-codex", "2025-12-18", SOURCES.gpt52Codex, true),
  model("gpt-5.1", "2025-11-12", SOURCES.gpt51, true),
  model("gpt-5.1-chat-latest", "2025-11-12", SOURCES.gpt51),
  model("gpt-5.1-codex", "2025-11-13", SOURCES.gpt51),
  model("gpt-5.1-codex-mini", "2025-11-13", SOURCES.gpt51),
  model("gpt-5.1-codex-max", "2025-11-19", SOURCES.gpt51CodexMax, true),
  model("gpt-5", "2025-08-07", SOURCES.gpt5, true),
  model("gpt-5-chat-latest", "2025-08-07", SOURCES.gpt5),
  model("gpt-5-mini", "2025-08-07", SOURCES.gpt5),
  model("gpt-5-nano", "2025-08-07", SOURCES.gpt5),
  model("gpt-5-pro", "2025-08-07", SOURCES.gpt5),
  model("gpt-5-codex", "2025-09-15", SOURCES.gpt5Codex, true),
  model("gpt-4.1", "2025-04-14", SOURCES.gpt41, true),
  model("gpt-4.1-mini", "2025-04-14", SOURCES.gpt41),
  model("gpt-4.1-nano", "2025-04-14", SOURCES.gpt41),
  model("o4-mini", "2025-04-16", SOURCES.o3, true),
  model("o4-mini-deep-research", "2025-04-16", SOURCES.o3),
  model("o3", "2025-04-16", SOURCES.o3, true),
  model("o3-pro", "2025-06-10", SOURCES.o3),
  model("o3-deep-research", "2025-04-16", SOURCES.o3),
  model("o3-mini", "2025-01-31", SOURCES.o3Mini),
  model("o1", "2024-12-05", SOURCES.o1, true),
  model("o1-pro", "2025-03-19", SOURCES.o1Pro),
  model("o1-mini", "2024-09-12", SOURCES.o1),
  model("gpt-4o", "2024-05-13", SOURCES.gpt4o, true),
  model("gpt-4o-2024-05-13", "2024-05-13", SOURCES.gpt4o),
  model("gpt-4o-2024-08-06", "2024-08-06", SOURCES.gpt4o),
  model("gpt-4o-2024-11-20", "2024-11-20", SOURCES.gpt4o),
  model("gpt-4o-mini", "2024-07-18", SOURCES.gpt4oMini),
  model("gpt-4-turbo", "2023-11-06", SOURCES.legacy),
  model("gpt-4-turbo-2024-04-09", "2024-04-09", SOURCES.legacy),
  model("gpt-4-0125-preview", "2024-01-25", SOURCES.legacy),
  model("gpt-4-1106-preview", "2023-11-06", SOURCES.legacy),
  model("gpt-4-1106-vision-preview", "2023-11-06", SOURCES.legacy),
  model("gpt-4", "2023-03-14", SOURCES.legacy, true),
  model("gpt-4-0613", "2023-06-13", SOURCES.legacy),
  model("gpt-4-0314", "2023-03-14", SOURCES.legacy),
  model("gpt-4-32k", "2023-03-14", SOURCES.legacy),
  model("gpt-3.5-turbo", "2023-03-01", SOURCES.legacy, true),
  model("gpt-3.5-turbo-0125", "2024-01-25", SOURCES.embeddings),
  model("gpt-3.5-turbo-1106", "2023-11-06", SOURCES.legacy),
  model("gpt-3.5-turbo-0613", "2023-06-13", SOURCES.legacy),
  model("gpt-3.5-0301", "2023-03-01", SOURCES.legacy),
  model("gpt-3.5-turbo-instruct", "2023-09-18", SOURCES.legacy),
  model("gpt-3.5-turbo-16k-0613", "2023-06-13", SOURCES.legacy),
  model("davinci-002", "2023-07-06", SOURCES.legacy),
  model("babbage-002", "2023-07-06", SOURCES.legacy),
  model("gpt-image-2", "2026-04-21", SOURCES.image2),
  model("text-embedding-3-large", "2024-01-25", SOURCES.embeddings),
  model("text-embedding-3-small", "2024-01-25", SOURCES.embeddings),
  model("text-embedding-ada-002", "2022-12-15", SOURCES.embeddings),
];

export const BUNDLED_MODEL_ALIASES: ModelAliasDefinition[] = [
  { alias: "chat-latest", target: "gpt-5", effectiveFrom: "2025-08-07", source: SOURCES.gpt5 },
  {
    alias: "chat-latest",
    target: "gpt-5.1-chat-latest",
    effectiveFrom: "2025-11-12",
    source: SOURCES.gpt51,
  },
  {
    alias: "chat-latest",
    target: "gpt-5.2-chat-latest",
    effectiveFrom: "2025-12-11",
    source: SOURCES.gpt52,
  },
  {
    alias: "chat-latest",
    target: "gpt-5.3-chat-latest",
    effectiveFrom: "2026-02-05",
    source: SOURCES.gpt53,
  },
  { alias: "chat-latest", target: "gpt-5.4", effectiveFrom: "2026-03-05", source: SOURCES.gpt54 },
  { alias: "chat-latest", target: "gpt-5.5", effectiveFrom: "2026-04-23", source: SOURCES.gpt55 },
  {
    alias: "chat-latest",
    target: "gpt-5.6-sol",
    effectiveFrom: "2026-07-09",
    source: SOURCES.gpt56,
  },
  {
    alias: "codex-auto-review",
    target: "gpt-5.4",
    effectiveFrom: "2026-03-05",
    source: "https://alignment.openai.com/auto-review/",
  },
  {
    alias: "guardian",
    target: "gpt-5.4",
    effectiveFrom: "2026-03-05",
    source: "https://alignment.openai.com/auto-review/",
  },
  {
    alias: "codex-auto-review",
    target: "gpt-5.6-luna",
    effectiveFrom: "2026-07-30",
    source: `user-supplied mapping; ${SOURCES.gpt56}`,
  },
  {
    alias: "guardian",
    target: "gpt-5.6-luna",
    effectiveFrom: "2026-07-30",
    source: `user-supplied mapping; ${SOURCES.gpt56}`,
  },
  { alias: "gpt-5.6", target: "gpt-5.6-sol", effectiveFrom: "2026-07-09", source: SOURCES.gpt56 },
  {
    alias: "daybreak-blue-latest",
    target: "gpt-5.6-sol",
    effectiveFrom: "2026-08-21",
    source: SOURCES.daybreakBlue,
  },
  {
    alias: "daybreak-red-latest",
    target: "gpt-5.6-cyber",
    effectiveFrom: "2026-08-21",
    source: SOURCES.daybreakRed,
  },
];

export function createModelCatalog(
  pricing: ModelPricingDefinition[] = [],
  models: ModelDefinition[] = BUNDLED_MODEL_DEFINITIONS,
  aliases: ModelAliasDefinition[] = BUNDLED_MODEL_ALIASES,
): ModelCatalog {
  const catalog: ModelCatalog = {
    models: [...models].sort(compareModelDefinitions),
    aliases: [...aliases].sort(compareAliases),
    pricing: new Map(),
  };
  const pricingKeys = new Set<string>();

  for (const row of pricing) {
    const key = `${row.model.toLowerCase()}|${row.effectiveFrom}`;

    if (pricingKeys.has(key)) {
      throw new Error(
        `Duplicate pricing definition for ${row.model.toLowerCase()} on ${row.effectiveFrom}`,
      );
    }

    pricingKeys.add(key);
    addPricingPeriod(catalog, row);
  }

  validateModelCatalog(catalog);

  return catalog;
}

export function addPricingPeriod(catalog: ModelCatalog, row: ModelPricingDefinition): void {
  const key = row.model.toLowerCase();
  const periods = catalog.pricing.get(key) ?? [];
  const withoutSameDate = periods.filter((period) => period.effectiveFrom !== row.effectiveFrom);
  withoutSameDate.push({ ...row, model: key });
  withoutSameDate.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  catalog.pricing.set(key, withoutSameDate);
}

export function ensureModelDefinition(
  catalog: ModelCatalog,
  modelName: string,
  releasedOn: string,
  source: string,
): void {
  const key = modelName.toLowerCase();

  if (catalog.models.some((row) => row.model.toLowerCase() === key)) {
    return;
  }

  catalog.models.push({ model: key, releasedOn, canBePrimary: false, source });
  catalog.models.sort(compareModelDefinitions);
}

export function primaryModelAt(catalog: ModelCatalog, date: string): string | undefined {
  return catalog.models.filter((row) => row.canBePrimary && row.releasedOn <= date).at(-1)?.model;
}

export function resolveModelAt(catalog: ModelCatalog, modelName: string, date: string): string {
  let current = modelName.toLowerCase();
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);
    const rule = newestEffective(
      catalog.aliases.filter((row) => row.alias.toLowerCase() === current),
      date,
    );

    if (!rule) {
      return current;
    }

    const canonicalDefinition = catalog.models.find(
      (row) => row.model.toLowerCase() === current && row.releasedOn <= date,
    );

    if (canonicalDefinition && canonicalDefinition.releasedOn >= rule.effectiveFrom) {
      return current;
    }

    current = rule.target.toLowerCase();
  }

  throw new Error(`Model alias cycle detected for ${modelName}`);
}

export function pricingAt(
  catalog: ModelCatalog,
  modelName: string,
  date: string,
): ModelPricingDefinition | undefined {
  const resolved = resolveModelAt(catalog, modelName, date);
  const direct = newestEffective(catalog.pricing.get(resolved) ?? [], date);

  if (direct) {
    return direct;
  }

  const simplified = resolved.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const simplifiedRow = newestEffective(catalog.pricing.get(simplified) ?? [], date);

  if (simplifiedRow) {
    return simplifiedRow;
  }

  if (resolved.includes("codex")) {
    return newestEffective(catalog.pricing.get(resolved.replace("-codex", "")) ?? [], date);
  }

  return undefined;
}

export function newestEffective<T extends { effectiveFrom: string }>(
  rows: T[],
  date: string,
): T | undefined {
  return rows.filter((row) => row.effectiveFrom <= date).at(-1);
}

export function validateModelCatalog(catalog: ModelCatalog): void {
  const modelKeys = new Set<string>();

  for (const row of catalog.models) {
    assertIsoDate(row.releasedOn, `release date for ${row.model}`);
    const key = row.model.toLowerCase();

    if (modelKeys.has(key)) {
      throw new Error(`Duplicate model definition for ${row.model}`);
    }

    modelKeys.add(key);
  }

  const aliasDates = new Set<string>();

  for (const row of catalog.aliases) {
    assertIsoDate(row.effectiveFrom, `alias date for ${row.alias}`);
    const key = `${row.alias.toLowerCase()}|${row.effectiveFrom}`;

    if (aliasDates.has(key)) {
      throw new Error(`Duplicate alias definition for ${row.alias} on ${row.effectiveFrom}`);
    }

    aliasDates.add(key);

    if (
      !modelKeys.has(row.target.toLowerCase()) &&
      !catalog.aliases.some(
        (candidate) => candidate.alias.toLowerCase() === row.target.toLowerCase(),
      )
    ) {
      throw new Error(`Unknown alias target ${row.target}`);
    }
  }

  for (const [modelName, periods] of catalog.pricing) {
    const definition = catalog.models.find((row) => row.model.toLowerCase() === modelName);

    for (const period of periods) {
      assertIsoDate(period.effectiveFrom, `pricing date for ${modelName}`);

      if (definition && period.effectiveFrom < definition.releasedOn) {
        throw new Error(`Pricing for ${modelName} starts before its release`);
      }

      validateRates(period, modelName);

      for (const context of Object.values(period.tiers ?? {})) {
        if (context) {
          validateRates(context.short, modelName);

          if (context.long) {
            validateRates(context.long, modelName);
          }
        }
      }
    }
  }

  for (const alias of new Set(catalog.aliases.map((row) => row.alias.toLowerCase()))) {
    for (const row of catalog.aliases.filter(
      (candidate) => candidate.alias.toLowerCase() === alias,
    )) {
      resolveModelAt(catalog, alias, row.effectiveFrom);
    }
  }
}

function compareModelDefinitions(a: ModelDefinition, b: ModelDefinition): number {
  return a.releasedOn.localeCompare(b.releasedOn) || a.model.localeCompare(b.model);
}

function compareAliases(a: ModelAliasDefinition, b: ModelAliasDefinition): number {
  return a.alias.localeCompare(b.alias) || a.effectiveFrom.localeCompare(b.effectiveFrom);
}

function assertIsoDate(value: string, label: string): void {
  const parsed = new Date(`${value}T00:00:00Z`);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`Invalid ${label} : ${value}`);
  }
}

function validateRates(
  rates: {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    cacheWritePerMillion?: number;
    outputPerMillion: number;
  },
  modelName: string,
): void {
  for (const value of [
    rates.inputPerMillion,
    rates.cachedInputPerMillion,
    rates.cacheWritePerMillion,
    rates.outputPerMillion,
  ]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid pricing rate for ${modelName}`);
    }
  }
}
