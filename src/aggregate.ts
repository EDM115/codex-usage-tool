import type {
  AccountProfileResponse,
  CodexHome,
  DailyUsage,
  LocalModelUsage,
  SourceMode,
  TokenBreakdown,
  TokenEvent,
  UsageDataset,
  UsageTheme,
  UsageThemeOption,
  WeeklyUsage,
  WhamAnalytics,
} from "./types"
import type { ThemeChoice } from "./theme"

import { estimateBreakdownCost, estimateUnattributedCost, type PricingLoadResult } from "./pricing"
import { addBreakdown, clampDate, eachDate, isoWeekStart, ZERO_BREAKDOWN } from "./util"

type LocalModelUsageAccumulator = Map<
  string,
  {
    breakdown: TokenBreakdown
    reasoningEfforts: Map<string, TokenBreakdown>
    serviceTiers: Map<string, { breakdown: TokenBreakdown; inferredTokens: number }>
  }
>

export function buildDataset(args: {
  profileResult: {
    profile?: AccountProfileResponse
    fetched: boolean
    endpoint?: string
    error?: string
  }
  events: TokenEvent[]
  codexHomes: CodexHome[]
  sourceMode: SourceMode
  from: string | null
  to: string | null
  timezone: string
  localStats: {
    rolloutFiles: number
    sqliteDatabases: number
    sqliteThreads: number
    parseErrors: Array<{ path: string; line?: number; error: string }>
  }
  pricing: PricingLoadResult
  estimateModel: string
  theme: UsageTheme
  themeChoice: ThemeChoice
  availableThemes: UsageThemeOption[]
  analytics?: WhamAnalytics
}): UsageDataset {
  const backendByDate = new Map<string, number>()

  for (const bucket of args.profileResult.profile?.dailyUsageBuckets ?? []) {
    if (!bucket.startDate || !clampDate(bucket.startDate, args.from, args.to)) {
      continue
    }

    backendByDate.set(bucket.startDate, bucket.tokens)
  }

  const localByDate = new Map<string, DailyUsage>()
  const localModelUsage: LocalModelUsageAccumulator = new Map()
  const localModelUsageByDate = new Map<string, LocalModelUsageAccumulator>()

  for (const event of args.events) {
    const day = getOrCreateDay(localByDate, event.date)
    day.localTokens = addBreakdown(day.localTokens, event.breakdown)
    day.models[event.model] = addBreakdown(
      day.models[event.model] ?? ZERO_BREAKDOWN,
      event.breakdown,
    )
    day.homes[event.homeLabel] = (day.homes[event.homeLabel] ?? 0) + event.breakdown.totalTokens

    if (event.reasoningEffort) {
      day.reasoningEfforts[event.reasoningEffort] =
        (day.reasoningEfforts[event.reasoningEffort] ?? 0) + event.breakdown.totalTokens
    }

    addEventToModelUsage(localModelUsage, event)
    const dailyModelUsage = localModelUsageByDate.get(event.date) ?? new Map()
    addEventToModelUsage(dailyModelUsage, event)
    localModelUsageByDate.set(event.date, dailyModelUsage)
  }

  const dates = completeDateRange(backendByDate, localByDate, args.from, args.to)
  const daily = dates.map((date) => {
    const base = getOrCreateDay(localByDate, date)
    const backendTokens = backendByDate.get(date)
    const localTotal = base.localTokens.totalTokens
    const totalTokens = backendTokens ?? localTotal
    const unattributedTokens = Math.max(0, totalTokens - localTotal)
    let knownLocalCostUsd = 0

    for (const [model, breakdown] of Object.entries(base.models)) {
      knownLocalCostUsd += estimateBreakdownCost(
        breakdown,
        model,
        args.pricing.table,
        args.estimateModel,
      )
    }

    const estimatedUnattributedCostUsd = estimateUnattributedCost(
      unattributedTokens,
      knownLocalCostUsd,
      localTotal,
      args.estimateModel,
      args.pricing.table,
    )

    return {
      ...base,
      totalTokens,
      backendTokens,
      unattributedTokens,
      sourceTotal: backendTokens === undefined ? ("local" as const) : ("backend" as const),
      modelUsage: buildLocalModelUsage(
        localModelUsageByDate.get(date) ?? new Map(),
        args.pricing,
        args.estimateModel,
      ),
      knownLocalCostUsd,
      estimatedUnattributedCostUsd,
      estimatedCostUsd: knownLocalCostUsd + estimatedUnattributedCostUsd,
    }
  })

  const weekly = buildWeekly(daily)
  const summary = buildSummary(daily, args.profileResult.profile)
  const modelUsage = buildLocalModelUsage(localModelUsage, args.pricing, args.estimateModel)

  return {
    generatedAt: new Date().toISOString(),
    timezone: args.timezone,
    sourceMode: args.sourceMode,
    dateRange: { from: args.from, to: args.to },
    codexHomes: args.codexHomes,
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
      parseErrors: args.localStats.parseErrors.slice(0, 100),
      modelUsage,
    },
    pricing: {
      source: args.pricing.source,
      estimateModel: args.estimateModel,
      fetchedAt: args.pricing.fetchedAt,
      warning: args.pricing.warning,
    },
    theme: args.theme,
    themeChoice: args.themeChoice,
    availableThemes: args.availableThemes,
    analytics: args.analytics,
    summary,
    daily,
    weekly,
  }
}

function buildLocalModelUsage(
  map: LocalModelUsageAccumulator,
  pricing: PricingLoadResult,
  estimateModel: string,
): LocalModelUsage[] {
  return [...map.entries()]
    .map(
      ([model, usage]): LocalModelUsage => ({
        model,
        breakdown: usage.breakdown,
        costUsd: estimateBreakdownCost(usage.breakdown, model, pricing.table, estimateModel),
        reasoningEfforts: [...usage.reasoningEfforts.entries()]
          .map(([effort, breakdown]) => ({
            effort,
            breakdown,
            costUsd: estimateBreakdownCost(breakdown, model, pricing.table, estimateModel),
          }))
          .sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens),
        serviceTiers: [...usage.serviceTiers.entries()]
          .map(([serviceTier, tierUsage]) => ({
            serviceTier,
            breakdown: tierUsage.breakdown,
            inferredTokens: tierUsage.inferredTokens,
            costUsd: estimateBreakdownCost(
              tierUsage.breakdown,
              model,
              pricing.table,
              estimateModel,
            ),
          }))
          .sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens),
      }),
    )
    .sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens)
}

function addEventToModelUsage(map: LocalModelUsageAccumulator, event: TokenEvent): void {
  const modelUsage = map.get(event.model) ?? {
    breakdown: { ...ZERO_BREAKDOWN },
    reasoningEfforts: new Map<string, TokenBreakdown>(),
    serviceTiers: new Map<string, { breakdown: TokenBreakdown; inferredTokens: number }>(),
  }
  modelUsage.breakdown = addBreakdown(modelUsage.breakdown, event.breakdown)

  if (event.reasoningEffort) {
    modelUsage.reasoningEfforts.set(
      event.reasoningEffort,
      addBreakdown(
        modelUsage.reasoningEfforts.get(event.reasoningEffort) ?? ZERO_BREAKDOWN,
        event.breakdown,
      ),
    )
  }

  if (event.serviceTier) {
    const tierUsage = modelUsage.serviceTiers.get(event.serviceTier) ?? {
      breakdown: { ...ZERO_BREAKDOWN },
      inferredTokens: 0,
    }
    tierUsage.breakdown = addBreakdown(tierUsage.breakdown, event.breakdown)
    tierUsage.inferredTokens += event.serviceTierInferred ? event.breakdown.totalTokens : 0
    modelUsage.serviceTiers.set(event.serviceTier, tierUsage)
  }

  map.set(event.model, modelUsage)
}

function getOrCreateDay(map: Map<string, DailyUsage>, date: string): DailyUsage {
  const existing = map.get(date)

  if (existing) {
    return existing
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
    estimatedUnattributedCostUsd: 0,
    estimatedCostUsd: 0,
  }
  map.set(date, created)

  return created
}

function completeDateRange(
  backendByDate: Map<string, number>,
  localByDate: Map<string, DailyUsage>,
  from: string | null,
  to: string | null,
): string[] {
  const known = [...backendByDate.keys(), ...localByDate.keys()].sort()

  if (known.length === 0) {
    const today = new Date().toISOString().slice(0, 10)

    return [today]
  }

  const start = from ?? known[0]
  const end = to ?? known[known.length - 1]

  return eachDate(start, end)
}

function buildWeekly(daily: DailyUsage[]): WeeklyUsage[] {
  const weeks = new Map<string, WeeklyUsage>()

  for (const day of daily) {
    const weekStart = isoWeekStart(day.date)
    const week = weeks.get(weekStart) ?? {
      weekStart,
      totalTokens: 0,
      localTokens: { ...ZERO_BREAKDOWN },
      unattributedTokens: 0,
      estimatedCostUsd: 0,
    }
    week.totalTokens += day.totalTokens
    week.backendTokens = (week.backendTokens ?? 0) + (day.backendTokens ?? 0)
    week.localTokens = addBreakdown(week.localTokens, day.localTokens)
    week.unattributedTokens += day.unattributedTokens
    week.estimatedCostUsd += day.estimatedCostUsd
    weeks.set(weekStart, week)
  }

  return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
}

function buildSummary(
  daily: DailyUsage[],
  profile?: AccountProfileResponse,
): UsageDataset["summary"] {
  const lifetimeFromDaily = daily.reduce((sum, day) => sum + day.totalTokens, 0)
  const localKnownTokens = daily.reduce((sum, day) => sum + day.localTokens.totalTokens, 0)
  const unattributedTokens = daily.reduce((sum, day) => sum + day.unattributedTokens, 0)
  const knownLocalCostUsd = daily.reduce((sum, day) => sum + day.knownLocalCostUsd, 0)
  const estimatedCostUsd = daily.reduce((sum, day) => sum + day.estimatedCostUsd, 0)

  return {
    lifetimeTokens: profile?.summary.lifetimeTokens ?? lifetimeFromDaily,
    peakDailyTokens:
      profile?.summary.peakDailyTokens ?? Math.max(0, ...daily.map((day) => day.totalTokens)),
    currentStreakDays: profile?.summary.currentStreakDays ?? null,
    longestStreakDays: profile?.summary.longestStreakDays ?? null,
    longestRunningTurnSec: profile?.summary.longestRunningTurnSec ?? null,
    localKnownTokens,
    unattributedTokens,
    knownLocalCostUsd,
    estimatedCostUsd,
  }
}

function emptyProfileSummary() {
  return {
    lifetimeTokens: null,
    peakDailyTokens: null,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null,
  }
}
