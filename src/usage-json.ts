import type {
  DailyUsage,
  LocalModelUsage,
  TokenBreakdown,
  UsageDataset,
  UsageTheme,
  UsageThemeOption,
  WeeklyUsage,
} from "./types"
import type { ThemeChoice } from "./theme"

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { addBreakdown, eachDate, isoWeekStart, ZERO_BREAKDOWN } from "./util"

export type MergeUsageOptions = {
  from: string | null
  to: string | null
  timezone: string
  theme?: UsageTheme
  themeChoice?: ThemeChoice
  availableThemes?: UsageThemeOption[]
}

export function loadUsageDatasets(paths: string[]): UsageDataset[] {
  return paths.map((inputPath) => {
    const path = resolve(inputPath)
    let value: unknown

    try {
      value = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      throw new Error(
        `Unable to read usage JSON ${path} : ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (!isUsageDataset(value)) {
      throw new Error(`Invalid usage JSON ${path} : expected a generated usage-data.json`)
    }

    return value
  })
}

export function mergeUsageDatasets(
  datasets: UsageDataset[],
  options: MergeUsageOptions,
): UsageDataset {
  if (datasets.length === 0) {
    throw new Error("At least one usage dataset is required")
  }

  if (options.from || options.to) {
    throw new Error(
      "Usage JSON inputs cannot be re-filtered by date because per-day reasoning and service-tier detail is not available",
    )
  }

  const incompatibleTimezone = datasets.find((dataset) => dataset.timezone !== options.timezone)

  if (incompatibleTimezone) {
    throw new Error(
      `Usage JSON timezone ${incompatibleTimezone.timezone} does not match ${options.timezone}, existing daily buckets cannot be rebucketed`,
    )
  }

  const primary = datasets[0]
  const daily = mergeDaily(datasets, options.from, options.to)
  const profile =
    datasets.find((dataset) => dataset.profile?.fetched)?.profile ??
    datasets.find((dataset) => dataset.profile)?.profile
  const analytics =
    datasets.find((dataset) => dataset.analytics?.fetched && !dataset.analytics.error)?.analytics ??
    datasets.find((dataset) => dataset.analytics)?.analytics
  const localKnownTokens = daily.reduce((sum, day) => sum + day.localTokens.totalTokens, 0)
  const unattributedTokens = daily.reduce((sum, day) => sum + day.unattributedTokens, 0)
  const knownLocalCostUsd = daily.reduce((sum, day) => sum + day.knownLocalCostUsd, 0)
  const estimatedCostUsd = daily.reduce((sum, day) => sum + day.estimatedCostUsd, 0)
  const lifetimeFromDaily = daily.reduce((sum, day) => sum + day.totalTokens, 0)

  return {
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
    profile,
    local: {
      rolloutFiles: datasets.reduce((sum, dataset) => sum + dataset.local.rolloutFiles, 0),
      tokenEvents: datasets.reduce((sum, dataset) => sum + dataset.local.tokenEvents, 0),
      sqliteDatabases: datasets.reduce((sum, dataset) => sum + dataset.local.sqliteDatabases, 0),
      sqliteThreads: datasets.reduce((sum, dataset) => sum + dataset.local.sqliteThreads, 0),
      parseErrors: datasets.flatMap((dataset) => dataset.local.parseErrors).slice(0, 100),
      modelUsage: mergeModelUsage(datasets),
    },
    pricing: primary.pricing,
    theme: options.theme ?? primary.theme,
    themeChoice: options.themeChoice ?? primary.themeChoice,
    availableThemes: options.availableThemes ?? primary.availableThemes,
    analytics,
    summary: {
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
    },
    daily,
    weekly: buildWeekly(daily),
  }
}

function mergeDaily(
  datasets: UsageDataset[],
  from: string | null,
  to: string | null,
): DailyUsage[] {
  const sourceDays = datasets.map((dataset) => new Map(dataset.daily.map((day) => [day.date, day])))
  const knownDates = [...new Set(sourceDays.flatMap((days) => [...days.keys()]))].sort()

  if (knownDates.length === 0) {
    return []
  }

  const dates = eachDate(from ?? knownDates[0], to ?? knownDates.at(-1)!)

  return dates.map((date) => {
    const days = sourceDays
      .map((source) => source.get(date))
      .filter((day): day is DailyUsage => Boolean(day))
    const cloudDay = days.find((day) => day.backendTokens !== undefined)
    const localTokens = sumBreakdowns(days.map((day) => day.localTokens))
    const backendTokens = cloudDay?.backendTokens
    const totalTokens = backendTokens ?? localTokens.totalTokens
    const unattributedTokens = Math.max(0, totalTokens - localTokens.totalTokens)
    const cloudRate =
      cloudDay && cloudDay.unattributedTokens > 0
        ? cloudDay.estimatedUnattributedCostUsd / cloudDay.unattributedTokens
        : 0
    const knownLocalCostUsd = days.reduce((sum, day) => sum + day.knownLocalCostUsd, 0)
    const estimatedUnattributedCostUsd = unattributedTokens * cloudRate

    return {
      date,
      totalTokens,
      backendTokens,
      localTokens,
      unattributedTokens,
      sourceTotal: backendTokens === undefined ? "local" : "backend",
      models: mergeBreakdownRecords(days.map((day) => day.models)),
      reasoningEfforts: mergeNumberRecords(days.map((day) => day.reasoningEfforts)),
      homes: mergeNumberRecords(days.map((day) => day.homes)),
      knownLocalCostUsd,
      estimatedUnattributedCostUsd,
      estimatedCostUsd: knownLocalCostUsd + estimatedUnattributedCostUsd,
    }
  })
}

function mergeModelUsage(datasets: UsageDataset[]): LocalModelUsage[] {
  const models = new Map<string, LocalModelUsage>()

  for (const row of datasets.flatMap((dataset) => dataset.local.modelUsage)) {
    const current = models.get(row.model) ?? {
      model: row.model,
      breakdown: { ...ZERO_BREAKDOWN },
      costUsd: 0,
      reasoningEfforts: [],
      serviceTiers: [],
    }
    current.breakdown = addBreakdown(current.breakdown, row.breakdown)
    current.costUsd += row.costUsd
    current.reasoningEfforts = mergeNamedUsage(
      current.reasoningEfforts,
      row.reasoningEfforts,
      "effort",
    )
    current.serviceTiers = mergeNamedUsage(current.serviceTiers, row.serviceTiers, "serviceTier")
    models.set(row.model, current)
  }

  return [...models.values()].sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens)
}

function mergeNamedUsage<T extends { breakdown: TokenBreakdown; costUsd: number }>(
  left: T[],
  right: T[],
  key: keyof T,
): T[] {
  const rows = new Map<string, T>()

  for (const row of [...left, ...right]) {
    const name = String(row[key])
    const current = rows.get(name)

    if (!current) {
      rows.set(name, structuredClone(row))
      continue
    }

    current.breakdown = addBreakdown(current.breakdown, row.breakdown)
    current.costUsd += row.costUsd

    if ("inferredTokens" in current && "inferredTokens" in row) {
      current.inferredTokens = Number(current.inferredTokens) + Number(row.inferredTokens)
    }
  }

  return [...rows.values()].sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens)
}

function mergeBreakdownRecords(
  records: Array<Record<string, TokenBreakdown>>,
): Record<string, TokenBreakdown> {
  const result: Record<string, TokenBreakdown> = {}

  for (const record of records) {
    for (const [key, breakdown] of Object.entries(record)) {
      result[key] = addBreakdown(result[key] ?? ZERO_BREAKDOWN, breakdown)
    }
  }

  return result
}

function mergeNumberRecords(records: Array<Record<string, number>>): Record<string, number> {
  const result: Record<string, number> = {}

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] ?? 0) + value
    }
  }

  return result
}

function sumBreakdowns(breakdowns: TokenBreakdown[]): TokenBreakdown {
  return breakdowns.reduce((sum, breakdown) => addBreakdown(sum, breakdown), { ...ZERO_BREAKDOWN })
}

function uniqueHomes(datasets: UsageDataset[]): UsageDataset["codexHomes"] {
  const homes = new Map<string, UsageDataset["codexHomes"][number]>()

  for (const home of datasets.flatMap((dataset) => dataset.codexHomes)) {
    homes.set(home.path.toLocaleLowerCase(), home)
  }

  return [...homes.values()]
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

function isUsageDataset(value: unknown): value is UsageDataset {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.generatedAt === "string" &&
    typeof value.timezone === "string" &&
    (value.sourceMode === "hybrid" ||
      value.sourceMode === "backend" ||
      value.sourceMode === "local") &&
    isDateRange(value.dateRange) &&
    Array.isArray(value.codexHomes) &&
    value.codexHomes.every(isCodexHome) &&
    (value.profile === undefined || isProfile(value.profile)) &&
    isLocalUsage(value.local) &&
    isPricing(value.pricing) &&
    isTheme(value.theme) &&
    typeof value.themeChoice === "string" &&
    Array.isArray(value.availableThemes) &&
    value.availableThemes.every(isThemeOption) &&
    (value.analytics === undefined || isAnalytics(value.analytics)) &&
    isSummary(value.summary) &&
    Array.isArray(value.daily) &&
    value.daily.every(isDailyUsage) &&
    Array.isArray(value.weekly) &&
    value.weekly.every(isWeeklyUsage)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isDateRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.from === null || isDate(value.from)) &&
    (value.to === null || isDate(value.to))
  )
}

function isCodexHome(value: unknown): boolean {
  return isRecord(value) && typeof value.path === "string" && typeof value.label === "string"
}

function isTokenBreakdown(value: unknown): value is TokenBreakdown {
  return (
    isRecord(value) &&
    isNumber(value.totalTokens) &&
    isNumber(value.inputTokens) &&
    isNumber(value.cachedInputTokens) &&
    isNumber(value.outputTokens) &&
    isNumber(value.reasoningOutputTokens)
  )
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isNumber)
}

function isBreakdownRecord(value: unknown): value is Record<string, TokenBreakdown> {
  return isRecord(value) && Object.values(value).every(isTokenBreakdown)
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
  )
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
    value.modelUsage.every(isLocalModelUsage)
  )
}

function isParseError(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.line === undefined || isNumber(value.line)) &&
    typeof value.error === "string"
  )
}

function isUsageSlice(
  value: unknown,
): value is Record<string, unknown> & { breakdown: TokenBreakdown; costUsd: number } {
  return isRecord(value) && isTokenBreakdown(value.breakdown) && isNumber(value.costUsd)
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
  )
}

function isPricing(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    typeof value.estimateModel === "string" &&
    isOptionalString(value.fetchedAt) &&
    isOptionalString(value.warning)
  )
}

function isTheme(value: unknown): value is UsageTheme {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.source !== "string" ||
    !isRecord(value.colors) ||
    !isRecord(value.fonts)
  ) {
    return false
  }

  const colors = value.colors
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
  ]
  const safeFont = /^[\w\s,.'"-]+$/

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
  )
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
}

function isThemeOption(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && isTheme(value.theme)
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
    isNumber(value.estimatedCostUsd)
  )
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
    isNumberRecord(value.reasoningEfforts) &&
    isNumberRecord(value.homes) &&
    isNumber(value.knownLocalCostUsd) &&
    isNumber(value.estimatedUnattributedCostUsd) &&
    isNumber(value.estimatedCostUsd)
  )
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
  )
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
  )
}

function isAnalyticsTotals(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["credits", "turns", "threads", "users", "textTotalTokens"].every((key) => isNumber(value[key]))
  )
}

function isAnalyticsRow(value: unknown, keys: string[]): boolean {
  if (!isRecord(value)) {
    return false
  }

  return keys.every((key) =>
    key === "model" || key === "speed" || key === "surface" || key === "source"
      ? typeof value[key] === "string"
      : isNumber(value[key]),
  )
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
  )
}

function isCountRows(value: unknown, key: string): boolean {
  return (
    Array.isArray(value) &&
    value.every((row) => isRecord(row) && typeof row[key] === "string" && isNumber(row.count))
  )
}

function isNumericRecord(value: unknown, keys: string[]): boolean {
  return isRecord(value) && keys.every((key) => isNumber(value[key]))
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
  )
}
