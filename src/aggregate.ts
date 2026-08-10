import type {
  AccountProfileResponse,
  CapabilityUsageEvent,
  CodexHome,
  DailyUsage,
  LocalModelUsage,
  PaymentHistory,
  SourceMode,
  TokenBreakdown,
  TokenEvent,
  UsageDataset,
  UsageTheme,
  UsageThemeOption,
  WeeklyUsage,
  WhamAnalytics,
} from "./types";
import type { ThemeChoice } from "./theme";

import { createHash } from "node:crypto";

import { primaryModelAt, resolveModelAt } from "./model-catalog";
import { ROLLOUT_PARSE_CACHE_VERSION } from "./parse-cache";
import { emptyPaymentHistory } from "./payments";
import {
  estimateBreakdownCost,
  estimateCacheSavingsUsd,
  estimateUnattributedCost,
  type PricingLoadResult,
} from "./pricing";
import { addBreakdown, clampDate, eachDate, isoWeekStart, ZERO_BREAKDOWN } from "./util";

type LocalModelUsageAccumulator = Map<
  string,
  {
    breakdown: TokenBreakdown;
    costUsd: number;
    reasoningEfforts: Map<string, { breakdown: TokenBreakdown; costUsd: number }>;
    serviceTiers: Map<
      string,
      { breakdown: TokenBreakdown; costUsd: number; inferredTokens: number }
    >;
  }
>;

export function buildDataset(args: {
  profileResult: {
    profile?: AccountProfileResponse;
    fetched: boolean;
    endpoint?: string;
    error?: string;
  };
  events: TokenEvent[];
  capabilityEvents?: CapabilityUsageEvent[];
  codexHomes: CodexHome[];
  sourceMode: SourceMode;
  from: string | null;
  to: string | null;
  timezone: string;
  localStats: {
    rolloutFiles: number;
    sqliteDatabases: number;
    sqliteThreads: number;
    parseErrors: Array<{ path: string; line?: number; error: string }>;
    coverage?: UsageDataset["local"]["coverage"];
    cache?: UsageDataset["local"]["cache"];
  };
  pricing: PricingLoadResult;
  estimateModel?: string;
  theme: UsageTheme;
  themeChoice: ThemeChoice;
  availableThemes: UsageThemeOption[];
  analytics?: WhamAnalytics;
  payments?: PaymentHistory;
}): UsageDataset {
  const backendByDate = new Map<string, number>();

  for (const bucket of args.profileResult.profile?.dailyUsageBuckets ?? []) {
    if (!bucket.startDate || !clampDate(bucket.startDate, args.from, args.to)) {
      continue;
    }

    backendByDate.set(bucket.startDate, bucket.tokens);
  }

  const localByDate = new Map<string, DailyUsage>();
  const localModelUsage: LocalModelUsageAccumulator = new Map();
  const localModelUsageByDate = new Map<string, LocalModelUsageAccumulator>();
  const effectiveEvents: TokenEvent[] = [];

  for (const event of args.events) {
    const eventModel =
      event.model && event.model !== "unknown"
        ? resolveModelAt(args.pricing.catalog, event.model, event.date)
        : args.estimateModel
          ? resolveModelAt(args.pricing.catalog, args.estimateModel, event.date)
          : (primaryModelAt(args.pricing.catalog, event.date) ?? "unknown");
    const effectiveEvent =
      eventModel === event.model
        ? event
        : { ...event, model: eventModel, modelAttribution: "inferred" as const };
    effectiveEvents.push(effectiveEvent);
    const day = getOrCreateDay(localByDate, event.date);
    const eventCostUsd = estimateBreakdownCost(
      effectiveEvent.breakdown,
      effectiveEvent.model,
      args.pricing.catalog,
      args.estimateModel,
      {
        date: event.date,
        serviceTier: effectiveEvent.serviceTier,
        modelContextWindow: effectiveEvent.modelContextWindow,
      },
    );
    day.localTokens = addBreakdown(day.localTokens, effectiveEvent.breakdown);
    day.knownLocalCostUsd += eventCostUsd;
    day.cacheSavingsUsd += estimateCacheSavingsUsd(
      effectiveEvent.breakdown,
      effectiveEvent.model,
      args.pricing.catalog,
      args.estimateModel,
      {
        date: event.date,
        serviceTier: effectiveEvent.serviceTier,
        modelContextWindow: effectiveEvent.modelContextWindow,
      },
    );
    day.models[effectiveEvent.model] = addBreakdown(
      day.models[effectiveEvent.model] ?? ZERO_BREAKDOWN,
      effectiveEvent.breakdown,
    );
    day.homes[effectiveEvent.homeLabel] =
      (day.homes[effectiveEvent.homeLabel] ?? 0) + effectiveEvent.breakdown.totalTokens;

    if (effectiveEvent.reasoningEffort) {
      day.reasoningEfforts[effectiveEvent.reasoningEffort] =
        (day.reasoningEfforts[effectiveEvent.reasoningEffort] ?? 0) +
        effectiveEvent.breakdown.totalTokens;
    }

    addEventToModelUsage(localModelUsage, effectiveEvent, eventCostUsd);
    const dailyModelUsage = localModelUsageByDate.get(event.date) ?? new Map();
    addEventToModelUsage(dailyModelUsage, effectiveEvent, eventCostUsd);
    localModelUsageByDate.set(event.date, dailyModelUsage);
  }

  const dates = completeDateRange(backendByDate, localByDate, args.from, args.to);
  const daily = dates.map((date) => {
    const base = getOrCreateDay(localByDate, date);
    const backendTokens = backendByDate.get(date);
    const localTotal = base.localTokens.totalTokens;
    const totalTokens = backendTokens ?? localTotal;
    const unattributedTokens = Math.max(0, totalTokens - localTotal);
    const knownLocalCostUsd = base.knownLocalCostUsd;

    const estimatedUnattributedCostUsd = estimateUnattributedCost(
      unattributedTokens,
      knownLocalCostUsd,
      localTotal,
      args.estimateModel,
      args.pricing.catalog,
      { date },
    );

    return {
      ...base,
      totalTokens,
      backendTokens,
      unattributedTokens,
      sourceTotal: backendTokens === undefined ? ("local" as const) : ("backend" as const),
      modelUsage: buildLocalModelUsage(localModelUsageByDate.get(date) ?? new Map()),
      knownLocalCostUsd,
      estimatedUnattributedCostUsd,
      estimatedCostUsd: knownLocalCostUsd + estimatedUnattributedCostUsd,
    };
  });

  const weekly = buildWeekly(daily);
  const summary = buildSummary(daily, args.profileResult.profile);
  const modelUsage = buildLocalModelUsage(localModelUsage);
  const attribution = summarizeAttribution(effectiveEvents);
  const distinctSessions = new Set(effectiveEvents.map((event) => event.threadId)).size;
  const coverage = args.localStats.coverage ?? defaultCoverage(args.localStats);

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    timezone: args.timezone,
    sourceMode: args.sourceMode,
    dateRange: { from: args.from, to: args.to },
    codexHomes: args.codexHomes,
    sources: buildSources(args.codexHomes, effectiveEvents, coverage.status),
    profile: args.profileResult.profile
      ? {
          fetched: args.profileResult.fetched,
          endpoint: args.profileResult.endpoint,
          error: args.profileResult.error,
          summary: args.profileResult.profile.summary,
        }
      : args.profileResult.error
        ? {
            fetched: args.profileResult.fetched,
            endpoint: args.profileResult.endpoint,
            error: args.profileResult.error,
            summary: emptyProfileSummary(),
          }
        : undefined,
    local: {
      rolloutFiles: args.localStats.rolloutFiles,
      tokenEvents: args.events.length,
      sqliteDatabases: args.localStats.sqliteDatabases,
      sqliteThreads: args.localStats.sqliteThreads,
      parseErrors: [...args.localStats.parseErrors],
      modelUsage,
      events: effectiveEvents,
      distinctSessions,
      attribution,
      coverage,
      cache: args.localStats.cache ?? {
        version: ROLLOUT_PARSE_CACHE_VERSION,
        hits: 0,
        misses: 0,
        invalidations: 0,
        reusedBytes: 0,
      },
      merge: { duplicateEvents: 0, duplicateSources: 0, legacyOverlaps: 0 },
      capabilityEvents: [...(args.capabilityEvents ?? [])].sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      ),
    },
    pricing: {
      source: args.pricing.source,
      estimateModel: args.estimateModel,
      models: [...args.pricing.table.keys()].sort(),
      fetchedAt: args.pricing.fetchedAt,
      warning: args.pricing.warning,
    },
    theme: args.theme,
    themeChoice: args.themeChoice,
    availableThemes: args.availableThemes,
    analytics: args.analytics,
    payments: args.payments ?? emptyPaymentHistory(),
    summary,
    daily,
    weekly,
  };
}

function buildLocalModelUsage(map: LocalModelUsageAccumulator): LocalModelUsage[] {
  return [...map.entries()]
    .map(([model, usage]): LocalModelUsage => ({
      model,
      breakdown: usage.breakdown,
      costUsd: usage.costUsd,
      reasoningEfforts: [...usage.reasoningEfforts.entries()]
        .map(([effort, effortUsage]) => ({
          effort,
          breakdown: effortUsage.breakdown,
          costUsd: effortUsage.costUsd,
        }))
        .sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens),
      serviceTiers: [...usage.serviceTiers.entries()]
        .map(([serviceTier, tierUsage]) => ({
          serviceTier,
          breakdown: tierUsage.breakdown,
          inferredTokens: tierUsage.inferredTokens,
          costUsd: tierUsage.costUsd,
        }))
        .sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens),
    }))
    .sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens);
}

function addEventToModelUsage(
  map: LocalModelUsageAccumulator,
  event: TokenEvent,
  eventCostUsd: number,
): void {
  const modelUsage = map.get(event.model) ?? {
    breakdown: { ...ZERO_BREAKDOWN },
    costUsd: 0,
    reasoningEfforts: new Map<string, { breakdown: TokenBreakdown; costUsd: number }>(),
    serviceTiers: new Map<
      string,
      { breakdown: TokenBreakdown; costUsd: number; inferredTokens: number }
    >(),
  };
  modelUsage.breakdown = addBreakdown(modelUsage.breakdown, event.breakdown);
  modelUsage.costUsd += eventCostUsd;

  if (event.reasoningEffort) {
    const effortUsage = modelUsage.reasoningEfforts.get(event.reasoningEffort) ?? {
      breakdown: { ...ZERO_BREAKDOWN },
      costUsd: 0,
    };
    modelUsage.reasoningEfforts.set(event.reasoningEffort, {
      breakdown: addBreakdown(effortUsage.breakdown, event.breakdown),
      costUsd: effortUsage.costUsd + eventCostUsd,
    });
  }

  if (event.serviceTier) {
    const tierUsage = modelUsage.serviceTiers.get(event.serviceTier) ?? {
      breakdown: { ...ZERO_BREAKDOWN },
      costUsd: 0,
      inferredTokens: 0,
    };
    tierUsage.breakdown = addBreakdown(tierUsage.breakdown, event.breakdown);
    tierUsage.costUsd += eventCostUsd;
    tierUsage.inferredTokens += event.serviceTierInferred ? event.breakdown.totalTokens : 0;
    modelUsage.serviceTiers.set(event.serviceTier, tierUsage);
  }

  map.set(event.model, modelUsage);
}

function getOrCreateDay(map: Map<string, DailyUsage>, date: string): DailyUsage {
  const existing = map.get(date);

  if (existing) {
    return existing;
  }

  const created: DailyUsage = {
    date,
    totalTokens: 0,
    localTokens: { ...ZERO_BREAKDOWN },
    unattributedTokens: 0,
    sourceTotal: "local",
    models: {},
    modelUsage: [],
    reasoningEfforts: {},
    homes: {},
    knownLocalCostUsd: 0,
    cacheSavingsUsd: 0,
    estimatedUnattributedCostUsd: 0,
    estimatedCostUsd: 0,
  };
  map.set(date, created);

  return created;
}

function completeDateRange(
  backendByDate: Map<string, number>,
  localByDate: Map<string, DailyUsage>,
  from: string | null,
  to: string | null,
): string[] {
  const known = [...backendByDate.keys(), ...localByDate.keys()].sort();

  if (known.length === 0) {
    const today = new Date().toISOString().slice(0, 10);

    return [today];
  }

  const start = from ?? known[0];
  const end = to ?? known[known.length - 1];

  return eachDate(start, end);
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

function buildSummary(
  daily: DailyUsage[],
  profile?: AccountProfileResponse,
): UsageDataset["summary"] {
  const lifetimeFromDaily = daily.reduce((sum, day) => sum + day.totalTokens, 0);
  const localKnownTokens = daily.reduce((sum, day) => sum + day.localTokens.totalTokens, 0);
  const unattributedTokens = daily.reduce((sum, day) => sum + day.unattributedTokens, 0);
  const knownLocalCostUsd = daily.reduce((sum, day) => sum + day.knownLocalCostUsd, 0);
  const estimatedCostUsd = daily.reduce((sum, day) => sum + day.estimatedCostUsd, 0);
  const cachedInputTokens = daily.reduce((sum, day) => sum + day.localTokens.cachedInputTokens, 0);
  const cacheSavingsUsd = daily.reduce((sum, day) => sum + day.cacheSavingsUsd, 0);

  return {
    lifetimeTokens: profile?.summary.lifetimeTokens ?? lifetimeFromDaily,
    peakDailyTokens: Math.max(0, ...daily.map((day) => day.localTokens.totalTokens)),
    currentStreakDays: profile?.summary.currentStreakDays ?? null,
    longestStreakDays: profile?.summary.longestStreakDays ?? null,
    longestRunningTurnSec: profile?.summary.longestRunningTurnSec ?? null,
    localKnownTokens,
    unattributedTokens,
    knownLocalCostUsd,
    estimatedCostUsd,
    cachedInputTokens,
    cacheSavingsUsd,
  };
}

function summarizeAttribution(events: TokenEvent[]): UsageDataset["local"]["attribution"] {
  const dimensions = {
    model: { completeTokens: 0, certainTokens: 0 },
    reasoningEffort: { completeTokens: 0, certainTokens: 0 },
    serviceTier: { completeTokens: 0, certainTokens: 0 },
  };

  for (const event of events) {
    addAttribution(
      dimensions.model,
      event.modelAttribution ?? (event.model === "unknown" ? "missing" : "observed"),
      event.breakdown.totalTokens,
    );
    addAttribution(
      dimensions.reasoningEffort,
      event.reasoningEffortAttribution ?? (event.reasoningEffort ? "observed" : "missing"),
      event.breakdown.totalTokens,
    );
    addAttribution(
      dimensions.serviceTier,
      event.serviceTierAttribution ??
        (event.serviceTier ? (event.serviceTierInferred ? "inferred" : "observed") : "missing"),
      event.breakdown.totalTokens,
    );
  }

  return {
    totalTokens: events.reduce((sum, event) => sum + event.breakdown.totalTokens, 0),
    ...dimensions,
  };
}

function addAttribution(
  metric: { completeTokens: number; certainTokens: number },
  provenance: NonNullable<TokenEvent["modelAttribution"]>,
  tokens: number,
): void {
  if (provenance !== "missing") {
    metric.completeTokens += tokens;
  }

  if (provenance === "observed") {
    metric.certainTokens += tokens;
  }
}

function defaultCoverage(localStats: {
  rolloutFiles: number;
  parseErrors: Array<unknown>;
}): UsageDataset["local"]["coverage"] {
  return {
    status:
      localStats.rolloutFiles === 0
        ? "unavailable"
        : localStats.parseErrors.length > 0
          ? "partial"
          : "complete",
    discoveredFiles: localStats.rolloutFiles,
    parsedFiles: localStats.rolloutFiles,
    failedFiles: 0,
    malformedLines: localStats.parseErrors.length,
    missingRoots: [],
  };
}

function buildSources(
  homes: CodexHome[],
  events: TokenEvent[],
  status: UsageDataset["local"]["coverage"]["status"],
): UsageDataset["sources"] {
  return homes.map((home) => {
    const homeEvents = events.filter(
      (event) => event.homePath.toLocaleLowerCase() === home.path.toLocaleLowerCase(),
    );

    return {
      sourceId: `codex-home:${createHash("sha256").update(home.path.toLocaleLowerCase()).digest("hex")}`,
      kind: "codex-home",
      label: home.label,
      path: home.path,
      status,
      rolloutFiles: new Set(homeEvents.map((event) => event.rolloutPath)).size,
      tokenEvents: homeEvents.length,
      distinctSessions: new Set(homeEvents.map((event) => event.threadId)).size,
    };
  });
}

function emptyProfileSummary() {
  return {
    lifetimeTokens: null,
    peakDailyTokens: null,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null,
  };
}
