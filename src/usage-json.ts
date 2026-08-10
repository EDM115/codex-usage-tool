import type {
  CapabilityUsageEvent,
  DailyUsage,
  LocalModelUsage,
  PaymentHistory,
  TokenBreakdown,
  TokenEvent,
  UsageDataset,
  UsageTheme,
  UsageThemeOption,
  WeeklyUsage,
} from "./types";
import type { ThemeChoice } from "./theme";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { buildDataset } from "./aggregate";
import { primaryModelAt, resolveModelAt } from "./model-catalog";
import { emptyPaymentHistory, mergePaymentHistories } from "./payments";
import { estimateBreakdownCost, estimateUnattributedCost, type PricingLoadResult } from "./pricing";
import { addBreakdown, eachDate, isoWeekStart, ZERO_BREAKDOWN } from "./util";

export type MergeUsageOptions = {
  from: string | null;
  to: string | null;
  timezone: string;
  theme?: UsageTheme;
  themeChoice?: ThemeChoice;
  availableThemes?: UsageThemeOption[];
  pricing?: PricingLoadResult;
  estimateModel?: string;
  payments?: PaymentHistory;
};

export function loadUsageDatasets(paths: string[]): UsageDataset[] {
  return paths.map((inputPath) => {
    const path = resolve(inputPath);
    let value: unknown;
    let text: string;

    try {
      text = readFileSync(path, "utf8");
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Unable to read usage JSON ${path} : ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    value = migrateUsageDataset(value, path, text);

    if (!isUsageDataset(value)) {
      throw new Error(`Invalid usage JSON ${path} : expected a generated usage-data.json`);
    }

    value.local.capabilityEvents ??= [];

    return value;
  });
}

export function mergeUsageDatasets(
  datasets: UsageDataset[],
  options: MergeUsageOptions,
): UsageDataset {
  if (datasets.length === 0) {
    throw new Error("At least one usage dataset is required");
  }

  if (options.from || options.to) {
    throw new Error(
      "Usage JSON inputs cannot be re-filtered by date because per-day reasoning and service-tier detail is not available",
    );
  }

  const incompatibleTimezone = datasets.find((dataset) => dataset.timezone !== options.timezone);

  if (incompatibleTimezone) {
    throw new Error(
      `Usage JSON timezone ${incompatibleTimezone.timezone} does not match ${options.timezone}, existing daily buckets cannot be rebucketed`,
    );
  }

  const overlap = inspectOverlap(datasets);
  const payments = mergePaymentHistories(
    datasets.map((dataset) => dataset.payments),
    options.payments,
  );

  if (options.pricing && datasets.every((dataset) => Array.isArray(dataset.local.events))) {
    return mergeEventDatasets(
      datasets,
      { ...options, pricing: options.pricing },
      overlap,
      payments,
    );
  }

  const legacySelection = dedupeLegacyDatasets(datasets);
  datasets = legacySelection.datasets;
  overlap.legacyOverlaps += legacySelection.legacyOverlaps;
  const primary = datasets[0];
  const estimateModel = options.estimateModel ?? primary.pricing.estimateModel;
  const daily = mergeDaily(datasets, options.from, options.to, options.pricing, estimateModel);
  const profile =
    datasets.find((dataset) => dataset.profile?.fetched)?.profile ??
    datasets.find((dataset) => dataset.profile)?.profile;
  const analytics =
    datasets.find((dataset) => dataset.analytics?.fetched && !dataset.analytics.error)?.analytics ??
    datasets.find((dataset) => dataset.analytics)?.analytics;
  const localKnownTokens = daily.reduce((sum, day) => sum + day.localTokens.totalTokens, 0);
  const unattributedTokens = daily.reduce((sum, day) => sum + day.unattributedTokens, 0);
  const knownLocalCostUsd = daily.reduce((sum, day) => sum + day.knownLocalCostUsd, 0);
  const estimatedCostUsd = daily.reduce((sum, day) => sum + day.estimatedCostUsd, 0);
  const lifetimeFromDaily = daily.reduce((sum, day) => sum + day.totalTokens, 0);

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    timezone: options.timezone,
    sourceMode: datasets.every((dataset) => dataset.sourceMode === primary.sourceMode)
      ? primary.sourceMode
      : "hybrid",
    dateRange: datasets.every(
      (dataset) =>
        dataset.dateRange.from === primary.dateRange.from &&
        dataset.dateRange.to === primary.dateRange.to,
    )
      ? primary.dateRange
      : { from: null, to: null },
    codexHomes: uniqueHomes(datasets),
    sources: uniqueSources(datasets),
    profile,
    local: {
      rolloutFiles: datasets.reduce((sum, dataset) => sum + dataset.local.rolloutFiles, 0),
      tokenEvents: datasets.reduce((sum, dataset) => sum + dataset.local.tokenEvents, 0),
      sqliteDatabases: datasets.reduce((sum, dataset) => sum + dataset.local.sqliteDatabases, 0),
      sqliteThreads: datasets.reduce((sum, dataset) => sum + dataset.local.sqliteThreads, 0),
      parseErrors: datasets.flatMap((dataset) => dataset.local.parseErrors),
      modelUsage: mergeModelUsageRows(daily.flatMap(dailyModelUsage)),
      distinctSessions: datasets.reduce((sum, dataset) => sum + dataset.local.distinctSessions, 0),
      attribution: mergeAttribution(datasets),
      coverage: mergeCoverage(datasets),
      cache: mergeCacheStats(datasets),
      merge: overlap,
      capabilityEvents: datasets
        .flatMap((dataset) => dataset.local.capabilityEvents ?? [])
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    },
    pricing: options.pricing
      ? {
          source: options.pricing.source,
          estimateModel,
          models: [...options.pricing.table.keys()].sort(),
          fetchedAt: options.pricing.fetchedAt,
          warning: options.pricing.warning,
        }
      : primary.pricing,
    theme: options.theme ?? primary.theme,
    themeChoice: options.themeChoice ?? primary.themeChoice,
    availableThemes: options.availableThemes ?? primary.availableThemes,
    analytics,
    payments,
    summary: {
      lifetimeTokens: profile?.summary.lifetimeTokens ?? lifetimeFromDaily,
      peakDailyTokens: Math.max(0, ...daily.map((day) => day.localTokens.totalTokens)),
      currentStreakDays: profile?.summary.currentStreakDays ?? null,
      longestStreakDays: profile?.summary.longestStreakDays ?? null,
      longestRunningTurnSec: profile?.summary.longestRunningTurnSec ?? null,
      localKnownTokens,
      unattributedTokens,
      knownLocalCostUsd,
      estimatedCostUsd,
      cachedInputTokens: daily.reduce((sum, day) => sum + day.localTokens.cachedInputTokens, 0),
      cacheSavingsUsd: daily.reduce((sum, day) => sum + day.cacheSavingsUsd, 0),
    },
    daily,
    weekly: buildWeekly(daily),
  };
}

type MergeDiagnostics = UsageDataset["local"]["merge"];

function mergeEventDatasets(
  datasets: UsageDataset[],
  options: MergeUsageOptions & { pricing: PricingLoadResult },
  overlap: MergeDiagnostics,
  payments: PaymentHistory,
): UsageDataset {
  const primary = datasets[0];
  const profile =
    datasets.find((dataset) => dataset.profile?.fetched)?.profile ??
    datasets.find((dataset) => dataset.profile)?.profile;
  const cloudDataset =
    datasets.find((dataset) => dataset.profile === profile) ??
    datasets.find((dataset) => dataset.daily.some((day) => day.backendTokens !== undefined));
  const profileResult: Parameters<typeof buildDataset>[0]["profileResult"] = profile
    ? {
        fetched: profile.fetched,
        endpoint: profile.endpoint,
        error: profile.error,
        profile: {
          summary: profile.summary,
          dailyUsageBuckets:
            cloudDataset?.daily
              .filter((day) => day.backendTokens !== undefined)
              .map((day) => ({ startDate: day.date, tokens: day.backendTokens! })) ?? null,
        },
      }
    : { fetched: false, error: "No backend profile in portable inputs" };
  const eventMap = new Map<string, TokenEvent>();

  for (const event of datasets.flatMap((dataset) => dataset.local.events ?? [])) {
    eventMap.set(event.eventId, event);
  }

  const capabilityEventMap = new Map<string, CapabilityUsageEvent>();

  for (const event of datasets.flatMap((dataset) => dataset.local.capabilityEvents ?? [])) {
    capabilityEventMap.set(event.eventId, event);
  }

  const coverage = mergeCoverage(datasets);
  const cache = mergeCacheStats(datasets);
  const parseErrors = uniqueParseErrors(datasets);
  const analytics =
    datasets.find((dataset) => dataset.analytics?.fetched && !dataset.analytics.error)?.analytics ??
    datasets.find((dataset) => dataset.analytics)?.analytics;
  const merged = buildDataset({
    profileResult,
    events: [...eventMap.values()],
    capabilityEvents: [...capabilityEventMap.values()],
    codexHomes: uniqueHomes(datasets),
    sourceMode: datasets.every((dataset) => dataset.sourceMode === primary.sourceMode)
      ? primary.sourceMode
      : "hybrid",
    from: null,
    to: null,
    timezone: options.timezone,
    localStats: {
      rolloutFiles: new Set([...eventMap.values()].map((event) => event.rolloutPath)).size,
      sqliteDatabases: Math.max(0, ...datasets.map((dataset) => dataset.local.sqliteDatabases)),
      sqliteThreads: Math.max(0, ...datasets.map((dataset) => dataset.local.sqliteThreads)),
      parseErrors,
      coverage,
      cache,
    },
    pricing: options.pricing,
    estimateModel: options.estimateModel ?? primary.pricing.estimateModel,
    theme: options.theme ?? primary.theme,
    themeChoice: options.themeChoice ?? primary.themeChoice,
    availableThemes: options.availableThemes ?? primary.availableThemes,
    analytics,
    payments,
  });
  merged.sources = uniqueSources(datasets);
  merged.local.merge = overlap;

  return merged;
}

function inspectOverlap(datasets: UsageDataset[]): MergeDiagnostics {
  const sourceIds = new Set<string>();
  const eventIds = new Set<string>();
  let duplicateSources = 0;
  let duplicateEvents = 0;

  for (const dataset of datasets) {
    for (const source of dataset.sources) {
      if (sourceIds.has(source.sourceId)) {
        duplicateSources += 1;
      } else {
        sourceIds.add(source.sourceId);
      }
    }

    for (const event of dataset.local.events ?? []) {
      if (eventIds.has(event.eventId)) {
        duplicateEvents += 1;
      } else {
        eventIds.add(event.eventId);
      }
    }
  }

  return { duplicateEvents, duplicateSources, legacyOverlaps: 0 };
}

function dedupeLegacyDatasets(datasets: UsageDataset[]): {
  datasets: UsageDataset[];
  legacyOverlaps: number;
} {
  const selected: UsageDataset[] = [];
  const seenSources = new Set<string>();
  let legacyOverlaps = 0;

  for (const dataset of datasets) {
    const ids = dataset.sources.map((source) => source.sourceId);

    if (ids.some((id) => seenSources.has(id))) {
      legacyOverlaps += 1;

      continue;
    }

    selected.push(dataset);
    ids.forEach((id) => seenSources.add(id));
  }

  return { datasets: selected, legacyOverlaps };
}

function uniqueSources(datasets: UsageDataset[]): UsageDataset["sources"] {
  const sources = new Map<string, UsageDataset["sources"][number]>();

  for (const source of datasets.flatMap((dataset) => dataset.sources)) {
    sources.set(source.sourceId, source);
  }

  return [...sources.values()];
}

function mergeAttribution(datasets: UsageDataset[]): UsageDataset["local"]["attribution"] {
  return datasets.reduce<UsageDataset["local"]["attribution"]>(
    (result, dataset) => ({
      totalTokens: result.totalTokens + dataset.local.attribution.totalTokens,
      model: addAttributionMetric(result.model, dataset.local.attribution.model),
      reasoningEffort: addAttributionMetric(
        result.reasoningEffort,
        dataset.local.attribution.reasoningEffort,
      ),
      serviceTier: addAttributionMetric(result.serviceTier, dataset.local.attribution.serviceTier),
    }),
    {
      totalTokens: 0,
      model: { completeTokens: 0, certainTokens: 0 },
      reasoningEffort: { completeTokens: 0, certainTokens: 0 },
      serviceTier: { completeTokens: 0, certainTokens: 0 },
    },
  );
}

function addAttributionMetric(
  left: { completeTokens: number; certainTokens: number },
  right: { completeTokens: number; certainTokens: number },
): { completeTokens: number; certainTokens: number } {
  return {
    completeTokens: left.completeTokens + right.completeTokens,
    certainTokens: left.certainTokens + right.certainTokens,
  };
}

function mergeCoverage(datasets: UsageDataset[]): UsageDataset["local"]["coverage"] {
  datasets = uniqueOperationalDatasets(datasets);
  const statuses = datasets.map((dataset) => dataset.local.coverage.status);
  const allUnavailable = statuses.every((status) => status === "unavailable");
  const allComplete = statuses.every((status) => status === "complete");

  return {
    status: allUnavailable ? "unavailable" : allComplete ? "complete" : "partial",
    discoveredFiles: datasets.reduce(
      (sum, dataset) => sum + dataset.local.coverage.discoveredFiles,
      0,
    ),
    parsedFiles: datasets.reduce((sum, dataset) => sum + dataset.local.coverage.parsedFiles, 0),
    failedFiles: datasets.reduce((sum, dataset) => sum + dataset.local.coverage.failedFiles, 0),
    malformedLines: datasets.reduce(
      (sum, dataset) => sum + dataset.local.coverage.malformedLines,
      0,
    ),
    missingRoots: [...new Set(datasets.flatMap((dataset) => dataset.local.coverage.missingRoots))],
  };
}

function mergeCacheStats(datasets: UsageDataset[]): UsageDataset["local"]["cache"] {
  datasets = uniqueOperationalDatasets(datasets);
  return {
    version: Math.max(0, ...datasets.map((dataset) => dataset.local.cache.version)),
    hits: datasets.reduce((sum, dataset) => sum + dataset.local.cache.hits, 0),
    misses: datasets.reduce((sum, dataset) => sum + dataset.local.cache.misses, 0),
    invalidations: datasets.reduce((sum, dataset) => sum + dataset.local.cache.invalidations, 0),
    reusedBytes: datasets.reduce((sum, dataset) => sum + dataset.local.cache.reusedBytes, 0),
    readError: datasets.find((dataset) => dataset.local.cache.readError)?.local.cache.readError,
    writeError: datasets.find((dataset) => dataset.local.cache.writeError)?.local.cache.writeError,
  };
}

function uniqueOperationalDatasets(datasets: UsageDataset[]): UsageDataset[] {
  const signatures = new Set<string>();
  return datasets.filter((dataset) => {
    const signature = dataset.sources
      .map((source) => source.sourceId)
      .sort()
      .join("|");

    if (signatures.has(signature)) {
      return false;
    }

    signatures.add(signature);
    return true;
  });
}

function uniqueParseErrors(datasets: UsageDataset[]): UsageDataset["local"]["parseErrors"] {
  const errors = new Map<string, UsageDataset["local"]["parseErrors"][number]>();

  for (const error of datasets.flatMap((dataset) => dataset.local.parseErrors)) {
    errors.set(`${error.path}|${error.line ?? ""}|${error.error}`, error);
  }

  return [...errors.values()];
}

function mergeDaily(
  datasets: UsageDataset[],
  from: string | null,
  to: string | null,
  pricing?: PricingLoadResult,
  estimateModel = datasets[0]?.pricing.estimateModel,
): DailyUsage[] {
  const sourceDays = datasets.map(
    (dataset) => new Map(dataset.daily.map((day) => [day.date, day])),
  );
  const knownDates = [...new Set(sourceDays.flatMap((days) => [...days.keys()]))].sort();

  if (knownDates.length === 0) {
    return [];
  }

  const dates = eachDate(from ?? knownDates[0], to ?? knownDates.at(-1)!);

  return dates.map((date) => {
    const days = sourceDays
      .map((source) => source.get(date))
      .filter((day): day is DailyUsage => Boolean(day));
    const cloudDay = days.find((day) => day.backendTokens !== undefined);
    const localTokens = sumBreakdowns(days.map((day) => day.localTokens));
    const backendTokens = cloudDay?.backendTokens;
    const totalTokens = backendTokens ?? localTokens.totalTokens;
    const unattributedTokens = Math.max(0, totalTokens - localTokens.totalTokens);
    const cloudRate =
      cloudDay && cloudDay.unattributedTokens > 0
        ? cloudDay.estimatedUnattributedCostUsd / cloudDay.unattributedTokens
        : 0;
    const modelUsage = mergeModelUsageRows(
      days.flatMap(dailyModelUsage),
      pricing,
      estimateModel,
      date,
    );
    const knownLocalCostUsd = pricing
      ? modelUsage.reduce((sum, row) => sum + row.costUsd, 0)
      : days.reduce((sum, day) => sum + day.knownLocalCostUsd, 0);
    const estimatedUnattributedCostUsd = pricing
      ? estimateUnattributedCost(
          unattributedTokens,
          knownLocalCostUsd,
          localTokens.totalTokens,
          estimateModel,
          pricing.catalog,
          { date },
        )
      : unattributedTokens * cloudRate;

    return {
      date,
      totalTokens,
      backendTokens,
      localTokens,
      unattributedTokens,
      sourceTotal: backendTokens === undefined ? "local" : "backend",
      models: Object.fromEntries(modelUsage.map((row) => [row.model, row.breakdown])),
      modelUsage,
      reasoningEfforts: mergeNumberRecords(days.map((day) => day.reasoningEfforts)),
      homes: mergeNumberRecords(days.map((day) => day.homes)),
      knownLocalCostUsd,
      cacheSavingsUsd: days.reduce((sum, day) => sum + day.cacheSavingsUsd, 0),
      estimatedUnattributedCostUsd,
      estimatedCostUsd: knownLocalCostUsd + estimatedUnattributedCostUsd,
    };
  });
}

function mergeModelUsageRows(
  rows: LocalModelUsage[],
  pricing?: PricingLoadResult,
  estimateModel?: string,
  date?: string,
): LocalModelUsage[] {
  const models = new Map<string, LocalModelUsage>();

  for (const row of rows) {
    const current = models.get(row.model) ?? {
      model: row.model,
      breakdown: { ...ZERO_BREAKDOWN },
      costUsd: 0,
      reasoningEfforts: [],
      serviceTiers: [],
    };
    current.breakdown = addBreakdown(current.breakdown, row.breakdown);
    current.costUsd += row.costUsd;
    current.reasoningEfforts = mergeNamedUsage(
      current.reasoningEfforts,
      row.reasoningEfforts,
      "effort",
    );
    current.serviceTiers = mergeNamedUsage(current.serviceTiers, row.serviceTiers, "serviceTier");
    models.set(row.model, current);
  }

  const merged = [...models.values()].sort(
    (a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens,
  );

  return pricing
    ? merged.map((row) => repriceModelUsage(row, pricing, estimateModel, date))
    : merged;
}

function repriceModelUsage(
  row: LocalModelUsage,
  pricing: PricingLoadResult,
  estimateModel: string | undefined,
  date = new Date().toISOString().slice(0, 10),
): LocalModelUsage {
  const repriced = structuredClone(row);
  repriced.model =
    row.model && row.model !== "unknown"
      ? resolveModelAt(pricing.catalog, row.model, date)
      : (primaryModelAt(pricing.catalog, date) ?? "unknown");
  let covered = { ...ZERO_BREAKDOWN };
  let costUsd = 0;

  for (const tier of repriced.serviceTiers) {
    tier.costUsd = estimateBreakdownCost(
      tier.breakdown,
      repriced.model,
      pricing.catalog,
      estimateModel,
      { date, serviceTier: tier.serviceTier },
    );
    covered = addBreakdown(covered, tier.breakdown);
    costUsd += tier.costUsd;
  }

  const remainder = subtractBreakdown(repriced.breakdown, covered);

  if (repriced.serviceTiers.length === 0 || remainder.totalTokens > 0) {
    costUsd += estimateBreakdownCost(
      repriced.serviceTiers.length === 0 ? repriced.breakdown : remainder,
      repriced.model,
      pricing.catalog,
      estimateModel,
      { date },
    );
  }

  repriced.costUsd = costUsd;
  const reasoningCosts = repriced.reasoningEfforts.map((effort) =>
    estimateBreakdownCost(effort.breakdown, repriced.model, pricing.catalog, estimateModel, {
      date,
    }),
  );
  const reasoningCostTotal = reasoningCosts.reduce((sum, cost) => sum + cost, 0);
  const reasoningTokenTotal = repriced.reasoningEfforts.reduce(
    (sum, effort) => sum + effort.breakdown.totalTokens,
    0,
  );
  const reconcileReasoning =
    reasoningCostTotal > 0 && reasoningTokenTotal === repriced.breakdown.totalTokens;
  const reasoningScale = reconcileReasoning ? costUsd / reasoningCostTotal : 1;

  repriced.reasoningEfforts.forEach((effort, index) => {
    effort.costUsd = reasoningCosts[index] * reasoningScale;
  });

  return repriced;
}

function subtractBreakdown(total: TokenBreakdown, part: TokenBreakdown): TokenBreakdown {
  return {
    totalTokens: Math.max(0, total.totalTokens - part.totalTokens),
    inputTokens: Math.max(0, total.inputTokens - part.inputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - part.cachedInputTokens),
    outputTokens: Math.max(0, total.outputTokens - part.outputTokens),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - part.reasoningOutputTokens),
  };
}

function dailyModelUsage(day: DailyUsage): LocalModelUsage[] {
  if (Array.isArray(day.modelUsage)) {
    return day.modelUsage;
  }

  const totalTokens = Math.max(1, day.localTokens.totalTokens);

  return Object.entries(day.models).map(([model, breakdown]) => ({
    model,
    breakdown,
    costUsd: day.knownLocalCostUsd * (breakdown.totalTokens / totalTokens),
    reasoningEfforts: [],
    serviceTiers: [],
  }));
}

function mergeNamedUsage<T extends { breakdown: TokenBreakdown; costUsd: number }>(
  left: T[],
  right: T[],
  key: keyof T,
): T[] {
  const rows = new Map<string, T>();

  for (const row of [...left, ...right]) {
    const name = String(row[key]);
    const current = rows.get(name);

    if (!current) {
      rows.set(name, structuredClone(row));
      continue;
    }

    current.breakdown = addBreakdown(current.breakdown, row.breakdown);
    current.costUsd += row.costUsd;

    if ("inferredTokens" in current && "inferredTokens" in row) {
      current.inferredTokens = Number(current.inferredTokens) + Number(row.inferredTokens);
    }
  }

  return [...rows.values()].sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens);
}

function mergeBreakdownRecords(
  records: Array<Record<string, TokenBreakdown>>,
): Record<string, TokenBreakdown> {
  const result: Record<string, TokenBreakdown> = {};

  for (const record of records) {
    for (const [key, breakdown] of Object.entries(record)) {
      result[key] = addBreakdown(result[key] ?? ZERO_BREAKDOWN, breakdown);
    }
  }

  return result;
}

function mergeNumberRecords(records: Array<Record<string, number>>): Record<string, number> {
  const result: Record<string, number> = {};

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] ?? 0) + value;
    }
  }

  return result;
}

function sumBreakdowns(breakdowns: TokenBreakdown[]): TokenBreakdown {
  return breakdowns.reduce((sum, breakdown) => addBreakdown(sum, breakdown), { ...ZERO_BREAKDOWN });
}

function uniqueHomes(datasets: UsageDataset[]): UsageDataset["codexHomes"] {
  const homes = new Map<string, UsageDataset["codexHomes"][number]>();

  for (const home of datasets.flatMap((dataset) => dataset.codexHomes)) {
    homes.set(home.path.toLocaleLowerCase(), home);
  }

  return [...homes.values()];
}

function buildWeekly(daily: DailyUsage[]): WeeklyUsage[] {
  const weeks = new Map<string, WeeklyUsage>();

  for (const day of daily) {
    const weekStart = isoWeekStart(day.date);
    const week = weeks.get(weekStart) ?? {
      weekStart,
      totalTokens: 0,
      localTokens: { ...ZERO_BREAKDOWN },
      unattributedTokens: 0,
      estimatedCostUsd: 0,
    };
    week.totalTokens += day.totalTokens;
    week.backendTokens = (week.backendTokens ?? 0) + (day.backendTokens ?? 0);
    week.localTokens = addBreakdown(week.localTokens, day.localTokens);
    week.unattributedTokens += day.unattributedTokens;
    week.estimatedCostUsd += day.estimatedCostUsd;
    weeks.set(weekStart, week);
  }

  return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

function migrateUsageDataset(value: unknown, path: string, text: string): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if (isNumber(value.schemaVersion) && value.schemaVersion > 3) {
    throw new Error(`Unsupported usage JSON schema version ${value.schemaVersion} in ${path}`);
  }

  if (value.schemaVersion === 3) {
    return value;
  }

  if (value.schemaVersion === 2) {
    value.schemaVersion = 3;
    value.payments = emptyPaymentHistory();
    return value;
  }

  if (!isRecord(value.local) || !isRecord(value.summary) || !Array.isArray(value.daily)) {
    return value;
  }

  const local = value.local;
  const summary = value.summary;
  const daily = value.daily.filter(isRecord);
  const localKnownTokens = isNumber(summary.localKnownTokens)
    ? summary.localKnownTokens
    : daily.reduce(
        (sum, day) =>
          sum +
          (isRecord(day.localTokens) && isNumber(day.localTokens.totalTokens)
            ? day.localTokens.totalTokens
            : 0),
        0,
      );
  const cachedInputTokens = daily.reduce(
    (sum, day) =>
      sum +
      (isRecord(day.localTokens) && isNumber(day.localTokens.cachedInputTokens)
        ? day.localTokens.cachedInputTokens
        : 0),
    0,
  );
  const parseErrors = Array.isArray(local.parseErrors) ? local.parseErrors : [];
  const codexHomes = Array.isArray(value.codexHomes) ? value.codexHomes.filter(isRecord) : [];
  const fallbackId = legacyAggregateFingerprint(value, text);

  value.schemaVersion = 3;
  value.payments = emptyPaymentHistory();
  value.sources =
    codexHomes.length > 0
      ? codexHomes.map((home, index) => {
          const homePath = typeof home.path === "string" ? home.path : `${path}#${index}`;

          return {
            sourceId: `portable-legacy:${createHash("sha256").update(homePath.toLocaleLowerCase()).digest("hex")}`,
            kind: "portable-legacy",
            label: typeof home.label === "string" ? home.label : basename(path),
            path: typeof home.path === "string" ? home.path : undefined,
            status: parseErrors.length > 0 ? "partial" : "complete",
            rolloutFiles: 0,
            tokenEvents: 0,
            distinctSessions: 0,
          };
        })
      : [
          {
            sourceId: `portable-legacy:${fallbackId}`,
            kind: "portable-legacy",
            label: basename(path),
            status: parseErrors.length > 0 ? "partial" : "complete",
            rolloutFiles: isNumber(local.rolloutFiles) ? local.rolloutFiles : 0,
            tokenEvents: isNumber(local.tokenEvents) ? local.tokenEvents : 0,
            distinctSessions: isNumber(local.sqliteThreads) ? local.sqliteThreads : 0,
          },
        ];
  local.distinctSessions = isNumber(local.sqliteThreads) ? local.sqliteThreads : 0;
  local.attribution = {
    totalTokens: localKnownTokens,
    model: { completeTokens: localKnownTokens, certainTokens: 0 },
    reasoningEffort: { completeTokens: 0, certainTokens: 0 },
    serviceTier: { completeTokens: 0, certainTokens: 0 },
  };
  local.coverage = {
    status:
      (isNumber(local.rolloutFiles) ? local.rolloutFiles : 0) === 0
        ? "unavailable"
        : parseErrors.length > 0
          ? "partial"
          : "complete",
    discoveredFiles: isNumber(local.rolloutFiles) ? local.rolloutFiles : 0,
    parsedFiles: isNumber(local.rolloutFiles) ? local.rolloutFiles : 0,
    failedFiles: 0,
    malformedLines: parseErrors.length,
    missingRoots: [],
  };
  local.cache = { version: 0, hits: 0, misses: 0, invalidations: 0, reusedBytes: 0 };
  local.merge = { duplicateEvents: 0, duplicateSources: 0, legacyOverlaps: 0 };
  summary.cachedInputTokens = cachedInputTokens;
  summary.cacheSavingsUsd = 0;

  for (const day of daily) {
    day.cacheSavingsUsd = isNumber(day.cacheSavingsUsd) ? day.cacheSavingsUsd : 0;
  }

  return value;
}

function legacyAggregateFingerprint(value: Record<string, unknown>, fallbackText: string): string {
  const local = isRecord(value.local) ? value.local : {};
  const daily = Array.isArray(value.daily)
    ? value.daily.filter(isRecord).map((day) => ({
        date: day.date,
        localTokens: day.localTokens,
        models: day.models,
        homes: day.homes,
      }))
    : [];
  const semanticIdentity = {
    timezone: value.timezone,
    dateRange: value.dateRange,
    rolloutFiles: local.rolloutFiles,
    tokenEvents: local.tokenEvents,
    daily,
  };
  const serialized = daily.length > 0 ? JSON.stringify(semanticIdentity) : fallbackText;
  return createHash("sha256").update(serialized).digest("hex");
}

function isUsageDataset(value: unknown): value is UsageDataset {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schemaVersion === 3 &&
    typeof value.generatedAt === "string" &&
    typeof value.timezone === "string" &&
    (value.sourceMode === "hybrid" ||
      value.sourceMode === "backend" ||
      value.sourceMode === "local") &&
    isDateRange(value.dateRange) &&
    Array.isArray(value.codexHomes) &&
    value.codexHomes.every(isCodexHome) &&
    Array.isArray(value.sources) &&
    value.sources.every(isUsageSource) &&
    (value.profile === undefined || isProfile(value.profile)) &&
    isLocalUsage(value.local) &&
    isPricing(value.pricing) &&
    isTheme(value.theme) &&
    typeof value.themeChoice === "string" &&
    Array.isArray(value.availableThemes) &&
    value.availableThemes.every(isThemeOption) &&
    (value.analytics === undefined || isAnalytics(value.analytics)) &&
    isPaymentHistory(value.payments) &&
    isSummary(value.summary) &&
    Array.isArray(value.daily) &&
    value.daily.every(isDailyUsage) &&
    Array.isArray(value.weekly) &&
    value.weekly.every(isWeeklyUsage)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isDateRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.from === null || isDate(value.from)) &&
    (value.to === null || isDate(value.to))
  );
}

function isCodexHome(value: unknown): boolean {
  return isRecord(value) && typeof value.path === "string" && typeof value.label === "string";
}

function isUsageSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sourceId === "string" &&
    (value.kind === "codex-home" || value.kind === "portable-legacy") &&
    typeof value.label === "string" &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.status === "complete" || value.status === "partial" || value.status === "unavailable") &&
    isNumber(value.rolloutFiles) &&
    isNumber(value.tokenEvents) &&
    isNumber(value.distinctSessions)
  );
}

function isPaymentHistory(value: unknown): value is PaymentHistory {
  if (
    !isRecord(value) ||
    value.currency !== "USD" ||
    typeof value.fetched !== "boolean" ||
    typeof value.complete !== "boolean"
  ) {
    return false;
  }
  if (
    (value.endpoint !== undefined && value.endpoint !== "/payments/transaction-history") ||
    (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 240))
  ) {
    return false;
  }
  if (
    !Array.isArray(value.transactions) ||
    !value.transactions.every(isPaymentTransaction) ||
    new Set(value.transactions.map((transaction) => transaction.fingerprint)).size !==
      value.transactions.length
  ) {
    return false;
  }
  if (
    !isRecord(value.overrides) ||
    !Object.entries(value.overrides).every(
      ([month, amount]) => isPaymentMonth(month) && isNumber(amount),
    )
  ) {
    return false;
  }
  if (!Array.isArray(value.sources) || !value.sources.every(isPaymentSource)) {
    return false;
  }
  if (
    !isRecord(value.diagnostics) ||
    !isNonNegativeInteger(value.diagnostics.pages) ||
    !isNonNegativeInteger(value.diagnostics.skippedTransactions) ||
    !isNonNegativeInteger(value.diagnostics.duplicateTransactions) ||
    typeof value.diagnostics.repeatedCursor !== "boolean"
  ) {
    return false;
  }
  const expectedComplete =
    value.sources.length > 0 &&
    value.sources.every((source) => isRecord(source) && source.status === "complete") &&
    value.error === undefined;
  return value.complete === expectedComplete;
}

function isPaymentTransaction(value: unknown): value is PaymentHistory["transactions"][number] {
  return (
    isRecord(value) &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(value.fingerprint) &&
    isPaymentMonth(value.month) &&
    isNumber(value.amountUsd)
  );
}

function isPaymentSource(value: unknown): value is PaymentHistory["sources"][number] {
  return (
    isRecord(value) &&
    (value.kind === "api" || value.kind === "json") &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    (value.status === "complete" || value.status === "partial" || value.status === "unavailable")
  );
}

function isPaymentMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value);
}

function isTokenBreakdown(value: unknown): value is TokenBreakdown {
  return (
    isRecord(value) &&
    isNumber(value.totalTokens) &&
    isNumber(value.inputTokens) &&
    isNumber(value.cachedInputTokens) &&
    isNumber(value.outputTokens) &&
    isNumber(value.reasoningOutputTokens)
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isNumber);
}

function isBreakdownRecord(value: unknown): value is Record<string, TokenBreakdown> {
  return isRecord(value) && Object.values(value).every(isTokenBreakdown);
}

function isProfile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.fetched === "boolean" &&
    isOptionalString(value.endpoint) &&
    isOptionalString(value.error) &&
    isRecord(value.summary) &&
    isNullableNumber(value.summary.lifetimeTokens) &&
    isNullableNumber(value.summary.peakDailyTokens) &&
    isNullableNumber(value.summary.currentStreakDays) &&
    isNullableNumber(value.summary.longestStreakDays) &&
    isNullableNumber(value.summary.longestRunningTurnSec)
  );
}

function isLocalUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.rolloutFiles) &&
    isNumber(value.tokenEvents) &&
    isNumber(value.sqliteDatabases) &&
    isNumber(value.sqliteThreads) &&
    Array.isArray(value.parseErrors) &&
    value.parseErrors.every(isParseError) &&
    Array.isArray(value.modelUsage) &&
    value.modelUsage.every(isLocalModelUsage) &&
    isNumber(value.distinctSessions) &&
    isAttribution(value.attribution) &&
    isCoverage(value.coverage) &&
    isCacheStats(value.cache) &&
    isMergeDiagnostics(value.merge) &&
    (value.events === undefined ||
      (Array.isArray(value.events) && value.events.every(isTokenEvent))) &&
    (value.capabilityEvents === undefined ||
      (Array.isArray(value.capabilityEvents) &&
        value.capabilityEvents.every(isCapabilityUsageEvent)))
  );
}

function isTokenEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.homePath === "string" &&
    typeof value.homeLabel === "string" &&
    typeof value.rolloutPath === "string" &&
    typeof value.threadId === "string" &&
    typeof value.timestamp === "string" &&
    isDate(value.date) &&
    typeof value.model === "string" &&
    isTokenBreakdown(value.breakdown)
  );
}

function isAttribution(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.totalTokens) &&
    isAttributionMetric(value.model) &&
    isAttributionMetric(value.reasoningEffort) &&
    isAttributionMetric(value.serviceTier)
  );
}

function isAttributionMetric(value: unknown): boolean {
  return isRecord(value) && isNumber(value.completeTokens) && isNumber(value.certainTokens);
}

function isCoverage(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.status === "complete" || value.status === "partial" || value.status === "unavailable") &&
    isNumber(value.discoveredFiles) &&
    isNumber(value.parsedFiles) &&
    isNumber(value.failedFiles) &&
    isNumber(value.malformedLines) &&
    Array.isArray(value.missingRoots) &&
    value.missingRoots.every((root) => typeof root === "string")
  );
}

function isCacheStats(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.version) &&
    isNumber(value.hits) &&
    isNumber(value.misses) &&
    isNumber(value.invalidations) &&
    isNumber(value.reusedBytes) &&
    isOptionalString(value.readError) &&
    isOptionalString(value.writeError)
  );
}

function isMergeDiagnostics(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.duplicateEvents) &&
    isNumber(value.duplicateSources) &&
    isNumber(value.legacyOverlaps)
  );
}

function isCapabilityUsageEvent(value: unknown): value is CapabilityUsageEvent {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.homePath === "string" &&
    typeof value.homeLabel === "string" &&
    typeof value.rolloutPath === "string" &&
    typeof value.threadId === "string" &&
    typeof value.timestamp === "string" &&
    isDate(value.date) &&
    (value.kind === "skill" || value.kind === "plugin") &&
    typeof value.name === "string" &&
    (value.evidenceType === "injection" ||
      value.evidenceType === "tool_call" ||
      value.evidenceType === "skill_file_read") &&
    (value.confidence === "high" || value.confidence === "medium") &&
    typeof value.detail === "string"
  );
}

function isParseError(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.line === undefined || isNumber(value.line)) &&
    typeof value.error === "string"
  );
}

function isUsageSlice(
  value: unknown,
): value is Record<string, unknown> & { breakdown: TokenBreakdown; costUsd: number } {
  return isRecord(value) && isTokenBreakdown(value.breakdown) && isNumber(value.costUsd);
}

function isLocalModelUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isUsageSlice(value) &&
    typeof value.model === "string" &&
    Array.isArray(value.reasoningEfforts) &&
    value.reasoningEfforts.every(
      (row: unknown) => isRecord(row) && isUsageSlice(row) && typeof row.effort === "string",
    ) &&
    Array.isArray(value.serviceTiers) &&
    value.serviceTiers.every(
      (row: unknown) =>
        isRecord(row) &&
        isUsageSlice(row) &&
        typeof row.serviceTier === "string" &&
        isNumber(row.inferredTokens),
    )
  );
}

function isPricing(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    isOptionalString(value.estimateModel) &&
    (value.models === undefined ||
      (Array.isArray(value.models) && value.models.every((model) => typeof model === "string"))) &&
    isOptionalString(value.fetchedAt) &&
    isOptionalString(value.warning)
  );
}

function isTheme(value: unknown): value is UsageTheme {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.source !== "string" ||
    !isRecord(value.colors) ||
    !isRecord(value.fonts)
  ) {
    return false;
  }

  const colors = value.colors;
  const colorKeys = [
    "bg",
    "panel",
    "panel2",
    "line",
    "text",
    "muted",
    "accent",
    "accent2",
    "warning",
  ];
  const safeFont = /^[\w\s,.'"-]+$/;

  return (
    colorKeys.every((key) => isHexColor(colors[key])) &&
    Array.isArray(colors.cells) &&
    colors.cells.length > 0 &&
    colors.cells.every(isHexColor) &&
    Array.isArray(colors.series) &&
    colors.series.length > 0 &&
    colors.series.every(isHexColor) &&
    typeof value.fonts.ui === "string" &&
    safeFont.test(value.fonts.ui) &&
    typeof value.fonts.code === "string" &&
    safeFont.test(value.fonts.code)
  );
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function isThemeOption(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && isTheme(value.theme);
}

function isSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.lifetimeTokens) &&
    isNumber(value.peakDailyTokens) &&
    isNullableNumber(value.currentStreakDays) &&
    isNullableNumber(value.longestStreakDays) &&
    isNullableNumber(value.longestRunningTurnSec) &&
    isNumber(value.localKnownTokens) &&
    isNumber(value.unattributedTokens) &&
    isNumber(value.knownLocalCostUsd) &&
    isNumber(value.estimatedCostUsd) &&
    isNumber(value.cachedInputTokens) &&
    isNumber(value.cacheSavingsUsd)
  );
}

function isDailyUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isDate(value.date) &&
    isNumber(value.totalTokens) &&
    (value.backendTokens === undefined || isNumber(value.backendTokens)) &&
    isTokenBreakdown(value.localTokens) &&
    isNumber(value.unattributedTokens) &&
    (value.sourceTotal === "backend" || value.sourceTotal === "local") &&
    isBreakdownRecord(value.models) &&
    (value.modelUsage === undefined ||
      (Array.isArray(value.modelUsage) && value.modelUsage.every(isLocalModelUsage))) &&
    isNumberRecord(value.reasoningEfforts) &&
    isNumberRecord(value.homes) &&
    isNumber(value.knownLocalCostUsd) &&
    isNumber(value.cacheSavingsUsd) &&
    isNumber(value.estimatedUnattributedCostUsd) &&
    isNumber(value.estimatedCostUsd)
  );
}

function isWeeklyUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isDate(value.weekStart) &&
    isNumber(value.totalTokens) &&
    (value.backendTokens === undefined || isNumber(value.backendTokens)) &&
    isTokenBreakdown(value.localTokens) &&
    isNumber(value.unattributedTokens) &&
    isNumber(value.estimatedCostUsd)
  );
}

function isAnalytics(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.fetched === "boolean" &&
    isRecord(value.endpoints) &&
    Object.values(value.endpoints).every((endpoint) => typeof endpoint === "string") &&
    isOptionalString(value.error) &&
    isAnalyticsTotals(value.totals) &&
    Array.isArray(value.byModel) &&
    value.byModel.every((row) =>
      isAnalyticsRow(row, ["model", "credits", "turns", "threads", "users"]),
    ) &&
    Array.isArray(value.byModelVariants) &&
    value.byModelVariants.every((row) => isAnalyticsRow(row, ["model", "speed", "credits"])) &&
    Array.isArray(value.bySurface) &&
    value.bySurface.every((row) =>
      isAnalyticsRow(row, [
        "surface",
        "credits",
        "percent",
        "turns",
        "threads",
        "users",
        "textTotalTokens",
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
      ]),
    ) &&
    Array.isArray(value.bySource) &&
    value.bySource.every((row) =>
      isAnalyticsRow(row, ["source", "credits", "turns", "threads", "users", "textTotalTokens"]),
    ) &&
    (value.tasks === undefined || isAnalyticsTasks(value.tasks))
  );
}

function isAnalyticsTotals(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["credits", "turns", "threads", "users", "textTotalTokens"].every((key) => isNumber(value[key]))
  );
}

function isAnalyticsRow(value: unknown, keys: string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return keys.every((key) =>
    key === "model" || key === "speed" || key === "surface" || key === "source"
      ? typeof value[key] === "string"
      : isNumber(value[key]),
  );
}

function isAnalyticsTasks(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.currentCount) &&
    (value.archivedCount === undefined || isNumber(value.archivedCount)) &&
    (value.archivedHasMore === undefined || typeof value.archivedHasMore === "boolean") &&
    isCountRows(value.currentByEnvironment, "environment") &&
    isCountRows(value.currentByStatus, "status") &&
    isCountRows(value.currentByIntent, "intent") &&
    isNumericRecord(value.pullRequests, ["total", "open", "merged", "closed"]) &&
    isNumericRecord(value.diffStats, ["filesModified", "linesAdded", "linesRemoved"]) &&
    Array.isArray(value.recent) &&
    value.recent.every(isRecentTask)
  );
}

function isCountRows(value: unknown, key: string): boolean {
  return (
    Array.isArray(value) &&
    value.every((row) => isRecord(row) && typeof row[key] === "string" && isNumber(row.count))
  );
}

function isNumericRecord(value: unknown, keys: string[]): boolean {
  return isRecord(value) && keys.every((key) => isNumber(value[key]));
}

function isRecentTask(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.environment === "string" &&
    typeof value.status === "string" &&
    isOptionalString(value.branch) &&
    (value.updatedAt === undefined || isNumber(value.updatedAt)) &&
    typeof value.archived === "boolean" &&
    isNumber(value.pullRequests)
  );
}
