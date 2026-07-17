import type { ThemeChoice } from "./theme"

export type SourceMode = "hybrid" | "backend" | "local"
export type PricingSource = "bundled" | "openai" | "models.dev"

export type UsageTheme = {
  name: string
  source: string
  colors: {
    bg: string
    panel: string
    panel2: string
    line: string
    text: string
    muted: string
    accent: string
    accent2: string
    warning: string
    cells: string[]
    series: string[]
  }
  fonts: {
    ui: string
    code: string
  }
}

export type UsageThemeOption = { id: ThemeChoice; theme: UsageTheme }

export type TokenBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type CodexHome = {
  path: string
  label: string
}

export type ThreadMetadata = {
  threadId: string
  rolloutPath: string
  model?: string
  reasoningEffort?: string
  source?: string
  tokensUsed?: number
  archived?: boolean
}

export type TokenEvent = {
  eventId: string
  homePath: string
  homeLabel: string
  rolloutPath: string
  threadId: string
  timestamp: string
  date: string
  model: string
  reasoningEffort?: string
  serviceTier?: string
  serviceTierInferred?: boolean
  planType?: string
  breakdown: TokenBreakdown
  modelContextWindow?: number
}

export type AccountTokenUsageSummary = {
  lifetimeTokens: number | null
  peakDailyTokens: number | null
  longestRunningTurnSec: number | null
  currentStreakDays: number | null
  longestStreakDays: number | null
}

export type AccountTokenUsageDailyBucket = {
  startDate: string
  tokens: number
}

export type AccountProfileResponse = {
  summary: AccountTokenUsageSummary
  dailyUsageBuckets: AccountTokenUsageDailyBucket[] | null
}

export type WhamUsageResponse = {
  planType?: string
  rateLimit?: {
    primaryUsedPercent?: number
    secondaryUsedPercent?: number
    primaryResetAt?: number | null
    secondaryResetAt?: number | null
  }
  credits?: {
    hasCredits?: boolean
    unlimited?: boolean
    balance?: string
    overageLimitReached?: boolean
    approxLocalMessages?: number[]
    approxCloudMessages?: number[]
  }
}

export type WhamDailyBreakdownBucket = {
  date: string
  productSurfaceUsageValues: Record<string, number>
  models: Array<{ model: string; speed?: string; credits: number }>
}

export type WhamWorkspaceUsageBucket = {
  date: string
  totals: Record<string, number>
  clients: Array<Record<string, string | number>>
  models: Array<Record<string, string | number>>
}

export type WhamAnalytics = {
  fetched: boolean
  endpoints: Record<string, string>
  error?: string
  usage?: WhamUsageResponse
  dailyTokenUsageBreakdown?: {
    units?: string
    groupBy?: string
    data: WhamDailyBreakdownBucket[]
  }
  workspaceUsageCounts?: {
    groupBy?: string
    data: WhamWorkspaceUsageBucket[]
  }
  tasks?: {
    currentCount: number
    archivedCount?: number
    archivedHasMore?: boolean
    currentByEnvironment: Array<{ environment: string; count: number }>
    currentByStatus: Array<{ status: string; count: number }>
    currentByIntent: Array<{ intent: string; count: number }>
    pullRequests: { total: number; open: number; merged: number; closed: number }
    diffStats: { filesModified: number; linesAdded: number; linesRemoved: number }
    recent: Array<{
      title: string
      environment: string
      status: string
      branch?: string
      updatedAt?: number
      archived: boolean
      pullRequests: number
    }>
  }
  totals: {
    credits: number
    turns: number
    threads: number
    users: number
    textTotalTokens: number
  }
  byModel: Array<{ model: string; credits: number; turns: number; threads: number; users: number }>
  byModelVariants: Array<{ model: string; speed: string; credits: number }>
  bySurface: Array<{
    surface: string
    credits: number
    percent: number
    turns: number
    threads: number
    users: number
    textTotalTokens: number
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
  }>
  bySource: Array<{
    source: string
    credits: number
    turns: number
    threads: number
    users: number
    textTotalTokens: number
  }>
}

export type PricingTier = "standard" | "priority" | "batch" | "flex"

export type PricingRates = {
  inputPerMillion: number
  cachedInputPerMillion?: number
  cacheWritePerMillion?: number
  outputPerMillion: number
}

export type ContextPricing = {
  short: PricingRates
  long?: PricingRates
}

export type ModelPricing = PricingRates & {
  model: string
  source: string
  aliasFor?: string
  tiers?: Partial<Record<PricingTier, ContextPricing>>
}

export type LocalUsageSlice = {
  breakdown: TokenBreakdown
  costUsd: number
}

export type LocalReasoningUsage = LocalUsageSlice & {
  effort: string
}

export type LocalServiceTierUsage = LocalUsageSlice & {
  serviceTier: string
  inferredTokens: number
}

export type LocalModelUsage = LocalUsageSlice & {
  model: string
  reasoningEfforts: LocalReasoningUsage[]
  serviceTiers: LocalServiceTierUsage[]
}

export type DailyUsage = {
  date: string
  totalTokens: number
  backendTokens?: number
  localTokens: TokenBreakdown
  unattributedTokens: number
  sourceTotal: "backend" | "local"
  models: Record<string, TokenBreakdown>
  modelUsage: LocalModelUsage[]
  reasoningEfforts: Record<string, number>
  homes: Record<string, number>
  knownLocalCostUsd: number
  estimatedUnattributedCostUsd: number
  estimatedCostUsd: number
}

export type WeeklyUsage = {
  weekStart: string
  totalTokens: number
  backendTokens?: number
  localTokens: TokenBreakdown
  unattributedTokens: number
  estimatedCostUsd: number
}

export type UsageDataset = {
  generatedAt: string
  timezone: string
  sourceMode: SourceMode
  dateRange: {
    from: string | null
    to: string | null
  }
  codexHomes: CodexHome[]
  profile?: {
    fetched: boolean
    endpoint?: string
    error?: string
    summary: AccountTokenUsageSummary
  }
  local: {
    rolloutFiles: number
    tokenEvents: number
    sqliteDatabases: number
    sqliteThreads: number
    parseErrors: Array<{ path: string; line?: number; error: string }>
    modelUsage: LocalModelUsage[]
  }
  pricing: {
    source: string
    estimateModel: string
    models?: string[]
    fetchedAt?: string
    warning?: string
  }
  theme: UsageTheme
  themeChoice: ThemeChoice
  availableThemes: UsageThemeOption[]
  analytics?: WhamAnalytics
  summary: {
    lifetimeTokens: number
    peakDailyTokens: number
    currentStreakDays: number | null
    longestStreakDays: number | null
    longestRunningTurnSec: number | null
    localKnownTokens: number
    unattributedTokens: number
    knownLocalCostUsd: number
    estimatedCostUsd: number
  }
  daily: DailyUsage[]
  weekly: WeeklyUsage[]
}

export type CliOptions = {
  command: "generate" | "collect" | "help"
  codexHomes: string[]
  codexRoots: string[]
  usageJsons: string[]
  outDir: string
  from: string | null
  to: string | null
  timezone?: string
  source: SourceMode
  profileJson?: string
  noApi: boolean
  baseUrl: string
  pricingSource: PricingSource
  pricingJson?: string
  estimateModel: string
  noPng: boolean
  silent: boolean
  analyticsJson?: string
  theme?: ThemeChoice
}
