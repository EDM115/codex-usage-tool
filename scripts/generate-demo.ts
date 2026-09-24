import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildDataset } from "../src/aggregate";
import { writeOutputs } from "../src/export";
import { emptyPaymentHistory } from "../src/payments";
import { loadPricing } from "../src/pricing";
import { resolveUsageThemes } from "../src/theme";
import type {
  AccountProfileResponse,
  CapabilityUsageEvent,
  CodexHome,
  PaymentHistory,
  TokenBreakdown,
  TokenEvent,
  UsageDataset,
  WhamAnalytics,
} from "../src/types";
import { loadUsageDatasets } from "../src/usage-json";

const FIRST_USAGE_DATE = "2026-01-01";
const LAST_USAGE_DATE = "2026-09-23";
const DEMO_DAY_COUNT = Math.round((Date.parse(LAST_USAGE_DATE) - Date.parse(FIRST_USAGE_DATE)) / 86_400_000) + 1;
const GENERATED_AT = "2026-09-23T12:00:00.000Z";
const TIMEZONE = "Europe/Paris";
const DEMO_PATH = resolve("demo.json");
const DEMO_REPORT_DIR = resolve("output/demo");

const CODEX_HOMES: CodexHome[] = [
  { path: "demo/codex-home-alpha", label: "Demo workstation" },
  { path: "demo/codex-home-beta", label: "Demo travel laptop" },
];

type SurfaceDefinition = {
  id: string;
  label: string;
  share: number;
};

const SURFACES: SurfaceDefinition[] = [
  { id: "desktop_app", label: "Desktop App", share: 0.85 },
  { id: "vscode", label: "Vscode", share: 0.05 },
  { id: "sdk", label: "Sdk", share: 0.03 },
  { id: "work_web", label: "Work Web", share: 0.025 },
  { id: "github_code_review", label: "GitHub Code Review", share: 0.02 },
  { id: "exec", label: "Exec", share: 0.015 },
  { id: "cli", label: "Cli", share: 0.01 },
];

const FEATURES = [
  { key: "user", share: 0.75 }, { key: "subagent", share: 0.15 }, { key: "guardian_review", share: 0.035 },
  { key: "memory_consolidation", share: 0.025 }, { key: "guardian_classifier", share: 0.02 },
  { key: "thread_description", share: 0.012 }, { key: "thread_title", share: 0.008 },
];

const TURN_STARTS = [
  { key: "composer", share: 0.95 }, { key: "edit_user_message", share: 0.018 }, { key: "memory_consolidation", share: 0.008 },
  { key: "user", share: 0.007 }, { key: "guardian_review", share: 0.006 }, { key: "queue", share: 0.004 },
  { key: "guardian_classifier", share: 0.003 }, { key: "thread_description", share: 0.0025 }, { key: "thread_title", share: 0.0015 },
];

export async function buildDemoDataset(): Promise<UsageDataset> {
  const dates = inclusiveDates(FIRST_USAGE_DATE, LAST_USAGE_DATE);
  const events = dates.map(buildTokenEvent);
  const capabilityEvents = buildCapabilityEvents(dates);
  const localTotals = new Map(events.map((event) => [event.date, event.breakdown.totalTokens]));
  const profile = buildProfile(dates, localTotals);
  const analytics = buildAnalytics(dates, events, profile);
  const pricing = await loadPricing({ source: "bundled", effectiveDate: LAST_USAGE_DATE });
  const themes = resolveUsageThemes(CODEX_HOMES, "EDM115");
  const dataset = buildDataset({
    profileResult: {
      profile,
      fetched: true,
      endpoint: "/wham/profiles/me",
    },
    events,
    capabilityEvents,
    codexHomes: CODEX_HOMES,
    sourceMode: "hybrid",
    from: null,
    to: null,
    timezone: TIMEZONE,
    localStats: {
      rolloutFiles: dates.length,
      sqliteDatabases: 2,
      sqliteThreads: 64,
      threads: buildDemoThreads(),
      parseErrors: [],
      coverage: {
        status: "complete",
        discoveredFiles: dates.length,
        parsedFiles: dates.length,
        failedFiles: 0,
        malformedLines: 0,
        missingRoots: [],
      },
      cache: {
        version: 4,
        hits: 168,
        misses: 13,
        invalidations: 4,
        reusedBytes: 428_736_512,
      },
    },
    pricing,
    estimateModel: "gpt-5.5",
    theme: themes.theme,
    themeChoice: themes.themeChoice,
    availableThemes: themes.availableThemes,
    analytics,
    payments: emptyPaymentHistory(),
  });

  dataset.generatedAt = GENERATED_AT;
  dataset.local.merge = {
    duplicateEvents: 0,
    duplicateSources: 0,
    legacyOverlaps: 0,
  };
  dataset.payments = buildPayments();
  return dataset;
}

export function serializeDemoDataset(dataset: UsageDataset): string {
  return `${JSON.stringify(dataset, null, 2)}\n`;
}

export async function writeDemoDataset(
  options: {
    report?: boolean;
  } = {},
): Promise<{ dataset: UsageDataset; reportPath?: string }> {
  const dataset = await buildDemoDataset();
  writeFileSync(DEMO_PATH, serializeDemoDataset(dataset), "utf8");

  if (!options.report) {
    return { dataset };
  }

  const [reloaded] = loadUsageDatasets([DEMO_PATH]);
  const output = await writeOutputs(reloaded, DEMO_REPORT_DIR, {
    includePng: true,
    reportOnly: false,
  });
  const reportPath = output.files.find((path) => path.endsWith("usage-report.html"));
  if (!reportPath) {
    throw new Error("Demo report generation did not produce usage-report.html");
  }
  if (output.warnings.length > 0) {
    throw new Error(`Demo report generation produced warnings: ${output.warnings.join("; ")}`);
  }
  return { dataset: reloaded, reportPath };
}

function inclusiveDates(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  for (let timestamp = start; timestamp <= end; timestamp += 86_400_000) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}

function buildTokenEvent(date: string, index: number): TokenEvent {
  const home = CODEX_HOMES[index % CODEX_HOMES.length];
  const model = modelForDate(date, index);
  const reasoningEffort = ["low", "medium", "high", "xhigh"][index % 4];
  const serviceTier = index % 5 === 0 ? "priority" : "default";
  const modelAttribution = index % 9 === 0 ? "metadata" : "observed";
  const reasoningEffortAttribution = index % 7 === 0 ? "metadata" : "observed";
  const serviceTierAttribution = index % 11 === 0 ? "inferred" : "observed";
  const breakdown = buildTokenBreakdown(index, date);
  const cyberAccessProgram = date >= "2026-09-03" && index % 7 === 0 ? "daybreak_blue" : date >= "2026-09-22" && index % 5 === 0 ? "daybreak_red" : index % 13 === 0 ? "standard" : undefined;
  const eventNumber = String(index + 1).padStart(4, "0");
  return {
    eventId: `demo-event-${eventNumber}`,
    homePath: home.path,
    homeLabel: home.label,
    rolloutPath: `${home.path}/sessions/rollout-${date}.jsonl`,
    threadId: `demo-thread-${String(Math.floor(index / 3) + 1).padStart(4, "0")}`,
    timestamp: `${date}T${String(8 + (index % 10)).padStart(2, "0")}:24:00.000Z`,
    date,
    model,
    modelAttribution,
    reasoningEffort,
    reasoningEffortAttribution,
    serviceTier,
    serviceTierInferred: serviceTierAttribution === "inferred",
    serviceTierAttribution,
    cyberAccessProgram,
    source: ["desktop", "vscode", "exec"][index % 3],
    planType: "plus",
    breakdown,
    modelContextWindow: index % 17 === 0 ? 1_050_000 : 400_000,
  };
}

function buildTokenBreakdown(index: number, date: string): TokenBreakdown {
  const progress = index / (DEMO_DAY_COUNT - 1);
  const summerRamp = Math.max(0, (progress - 0.56) / 0.44);
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const weekdayMultiplier = weekday === 0 || weekday === 6 ? 0.64 : 1;
  const wave = 0.82 + ((index * 37) % 41) / 100;
  const launchBoost = date >= "2026-04-23" ? 1.06 : 1;
  const totalTokens = Math.round(
    (14_000_000 + 105_000_000 * progress + 75_000_000 * summerRamp) *
      weekdayMultiplier *
      wave *
      launchBoost *
      0.93,
  );
  const outputTokens = Math.round(totalTokens * (0.048 + (index % 5) * 0.003));
  const inputTokens = totalTokens - outputTokens;
  const cachedInputTokens = Math.round(inputTokens * (0.66 + (index % 4) * 0.055));
  const reasoningOutputTokens = Math.round(outputTokens * (0.34 + (index % 4) * 0.11));
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

function modelForDate(date: string, index: number): string {
  if (date >= "2026-09-22") return index % 2 ? "gpt-6-luna" : "gpt-6-sol";
  if (date >= "2026-09-03") return index % 4 === 0 ? "gpt-5.6-sol" : "gpt-6-astra";
  if (date >= "2026-08-21") return ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"][index % 3];
  if (date >= "2026-07-30") return index % 2 ? "gpt-5.6-luna" : "gpt-5.6-terra";
  if (date >= "2026-04-23") return "gpt-5.5";
  if (date >= "2026-03-05") return "gpt-5.4";
  if (date >= "2026-02-05") return "gpt-5.3-codex";
  return "gpt-5.2-codex";
}

function buildDemoThreads(): UsageDataset["local"]["threads"] {
  const titles = ["Refine a sample product dashboard", "Untitled chat", "Untitled chat", "Compare two demo API designs", "codex-auto-review", "codex-auto-review"];
  return titles.map((title, index) => ({
    threadId: `demo-chat-${String(index + 1).padStart(3, "0")}`,
    title,
    createdAt: `2026-09-${String(17 + index).padStart(2, "0")}T09:00:00.000Z`,
    updatedAt: `2026-09-${String(18 + index).padStart(2, "0")}T12:00:00.000Z`,
    archived: false,
    homeLabel: CODEX_HOMES[index % CODEX_HOMES.length].label,
  }));
}

function buildCapabilityEvents(dates: string[]): CapabilityUsageEvent[] {
  const definitions = [
    { kind: "skill" as const, name: "rtk", count: 36 },
    { kind: "plugin" as const, name: "using-superpowers", count: 28 },
    { kind: "plugin" as const, name: "thoughts", count: 21 },
    { kind: "skill" as const, name: "verification-before-completion", count: 15 },
    { kind: "skill" as const, name: "test-driven-development", count: 9 },
    { kind: "skill" as const, name: "executing-plans", count: 5 },
    { kind: "skill" as const, name: "brainstorming", count: 2 },
    { kind: "skill" as const, name: "read-the-damn-docs", count: 1 },
  ];
  return definitions.flatMap((definition, definitionIndex) =>
    Array.from({ length: definition.count }, (_, occurrenceIndex): CapabilityUsageEvent => {
      const dateIndex =
        definition.count === 1
          ? dates.length - 1
          : Math.round((occurrenceIndex * (dates.length - 1)) / (definition.count - 1));
      const date = dates[dateIndex];
      const home = CODEX_HOMES[(definitionIndex + occurrenceIndex) % CODEX_HOMES.length];
      const occurrence = String(occurrenceIndex + 1).padStart(3, "0");
      const slug = definition.name.replaceAll(/[^a-z0-9]+/g, "-");
      return {
        eventId: `demo-${definition.kind}-${slug}-${occurrence}`,
        homePath: home.path,
        homeLabel: home.label,
        rolloutPath: `${home.path}/sessions/rollout-${date}.jsonl`,
        threadId: `demo-capability-${slug}-${occurrence}`,
        timestamp: `${date}T${String(9 + (occurrenceIndex % 9)).padStart(2, "0")}:${String((definitionIndex * 7 + occurrenceIndex) % 60).padStart(2, "0")}:00.000Z`,
        date,
        kind: definition.kind,
        name: definition.name,
        evidenceType:
          definition.kind === "plugin"
            ? "tool_call"
            : occurrenceIndex % 3 === 0
              ? "skill_file_read"
              : "injection",
        confidence: occurrenceIndex % 5 === 0 ? "medium" : "high",
        detail:
          definition.kind === "plugin"
            ? `demo/plugins/${definition.name}`
            : `demo/skills/${definition.name}/SKILL.md`,
      };
    }),
  );
}

function buildProfile(dates: string[], localTotals: Map<string, number>): AccountProfileResponse {
  const dailyUsageBuckets = dates.map((date, index) => {
    const local = localTotals.get(date) ?? 0;
    const backendExtra = index % 4 === 0 ? Math.round(local * (0.035 + (index % 5) * 0.012)) : 0;
    return { startDate: date, tokens: local + backendExtra };
  });
  const timelineTotal = dailyUsageBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  return {
    summary: {
      lifetimeTokens: timelineTotal + 18_400_000,
      peakDailyTokens: Math.max(...dailyUsageBuckets.map((bucket) => bucket.tokens)),
      longestRunningTurnSec: 7_428,
      currentStreakDays: 19,
      longestStreakDays: 47,
    },
    dailyUsageBuckets,
  };
}

function categoryAt(position: number, mix: Array<{ key: string; share: number }>): string {
  let end = 0;
  for (const category of mix) {
    end += category.share;
    if (position < end) return category.key;
  }
  return mix.at(-1)!.key;
}

function apportionedCounts(total: number, shares: number[]): number[] {
  const exact = shares.map((share) => total * share);
  const counts = exact.map(Math.floor);
  const order = shares.map((_, index) => index).sort((left, right) => (exact[right] - counts[right]) - (exact[left] - counts[left]));
  for (let remaining = total - counts.reduce((sum, value) => sum + value, 0), index = 0; remaining > 0; remaining--, index++) counts[order[index % order.length]]++;
  return counts;
}

function demoAttribution(relativeUsage: number, model: string) {
  const mixes = [FEATURES, TURN_STARTS, SURFACES.map((surface) => ({ key: surface.id, share: surface.share })), [{ key: model, share: 0.96 }, { key: "codex-auto-review", share: 0.04 }]];
  const cuts = [...new Set([0, 1, ...mixes.flatMap((mix) => { let sum = 0; return mix.map((row) => Number((sum += row.share).toFixed(6))); })])].sort((left, right) => left - right);
  const cents = apportionedCounts(Math.round(relativeUsage * 100), cuts.slice(0, -1).map((start, index) => cuts[index + 1] - start));
  return cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1];
    const value = cents[index] / 100;
    const middle = (start + end) / 2;
    return { value, threadSource: categoryAt(middle, FEATURES), turnTrigger: categoryAt(middle, TURN_STARTS), surface: categoryAt(middle, mixes[2]), model: categoryAt(middle, mixes[3]) };
  }).filter((row) => row.value > 0);
}

function distributedCounts(total: number, startIndex: number, mix: Array<{ key: string; share: number }>): Map<string, number> {
  const counts = new Map(mix.map((row) => [row.key, 0]));
  for (let index = 0; index < total; index++) {
    const key = categoryAt(((startIndex + index) * 0.618033988749895) % 1, mix);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildAnalytics(
  dates: string[],
  events: TokenEvent[],
  profile: AccountProfileResponse,
): WhamAnalytics {
  const dailyTokenUsageBreakdown: NonNullable<WhamAnalytics["dailyTokenUsageBreakdown"]>["data"] =
    [];
  const workspaceUsageCounts: NonNullable<WhamAnalytics["workspaceUsageCounts"]>["data"] = [];
  const surfaceTotals = new Map<string, ReturnType<typeof emptySurfaceTotal>>(
    SURFACES.map((surface) => [surface.label, emptySurfaceTotal()]),
  );
  const modelTotals = new Map<
    string,
    { model: string; credits: number; turns: number; threads: number; users: number }
  >();
  const variantTotals = new Map<string, { model: string; speed: string; credits: number }>();
  const surfaceMix = SURFACES.map((surface) => ({ key: surface.id, share: surface.share }));
  let totalCredits = 0;
  let totalTurns = 0;
  let totalThreads = 0;
  let textTotalTokens = 0;
  let allocatedTurns = 0;
  let allocatedThreads = 0;
  const peakBackendTokens = Math.max(1, ...(profile.dailyUsageBuckets ?? []).map((bucket) => bucket.tokens));

  for (const [index, date] of dates.entries()) {
    const event = events[index];
    const backendTokens = profile.dailyUsageBuckets?.[index]?.tokens ?? event.breakdown.totalTokens;
    const relativeUsage = 100 * backendTokens / peakBackendTokens;
    const credits = roundMoney(8 + backendTokens / 290_000);
    const turns = 3 + (index % 9);
    const threads = 1 + (index % 3);
    const fastShare = index % 5 === 0 ? 0.42 : 0.18;
    const reviewCredits = roundMoney(credits * 0.04);
    const primaryCredits = roundMoney(credits - reviewCredits);
    const standardCredits = roundMoney(primaryCredits * (1 - fastShare));
    const fastCredits = roundMoney(primaryCredits - standardCredits);
    const reviewTurns = index % 4 === 0 ? 1 : 0;
    const primaryTurns = turns - reviewTurns;
    const reviewThreads = reviewTurns && threads > 1 ? 1 : 0;
    const primaryThreads = threads - reviewThreads;
    const surfaceTurns = distributedCounts(turns, allocatedTurns, surfaceMix);
    const surfaceThreads = distributedCounts(threads, allocatedThreads, surfaceMix);
    allocatedTurns += turns;
    allocatedThreads += threads;
    const surfaceValues = Object.fromEntries(
      SURFACES.map((surface) => [surface.id, roundMoney(100 * surface.share)]),
    );
    dailyTokenUsageBreakdown.push({
      date,
      productSurfaceUsageValues: surfaceValues,
      attribution: demoAttribution(relativeUsage, event.model),
      models: [
        { model: event.model, speed: "standard", credits: standardCredits },
        { model: event.model, speed: "fast", credits: fastCredits },
        { model: "codex-auto-review", speed: "standard", credits: reviewCredits },
      ],
    });

    const clients = SURFACES.map((surface, surfaceIndex) => {
      const localInput = Math.round(event.breakdown.inputTokens * surface.share);
      const cachedInput = Math.round(event.breakdown.cachedInputTokens * surface.share);
      const output = Math.round(event.breakdown.outputTokens * surface.share);
      const clientCredits = roundMoney(credits * surface.share);
      const clientTurns = surfaceTurns.get(surface.id) ?? 0;
      const clientThreads = surfaceThreads.get(surface.id) ?? 0;
      const total = localInput + output;
      const aggregate = surfaceTotals.get(surface.label)!;
      aggregate.credits += clientCredits;
      aggregate.turns += clientTurns;
      aggregate.threads += clientThreads;
      aggregate.users = Math.max(aggregate.users, surfaceIndex === 0 ? 2 : 1);
      aggregate.textTotalTokens += total;
      aggregate.inputTokens += localInput;
      aggregate.cachedInputTokens += cachedInput;
      aggregate.outputTokens += output;
      return {
        client_id: surface.id,
        credits: clientCredits,
        turns: clientTurns,
        threads: clientThreads,
        users: surfaceIndex === 0 ? 2 : 1,
        uncached_text_input_tokens: localInput - cachedInput,
        cached_text_input_tokens: cachedInput,
        text_output_tokens: output,
        text_total_tokens: total,
      };
    });
    for (const row of [{ model: event.model, credits: primaryCredits, turns: primaryTurns, threads: primaryThreads, users: 2 }, { model: "codex-auto-review", credits: reviewCredits, turns: reviewTurns, threads: reviewThreads, users: 1 }]) {
      const model = modelTotals.get(row.model) ?? { model: row.model, credits: 0, turns: 0, threads: 0, users: 0 };
      model.credits += row.credits;
      model.turns += row.turns;
      model.threads += row.threads;
      model.users = Math.max(model.users, row.users);
      modelTotals.set(row.model, model);
    }
    for (const variant of dailyTokenUsageBreakdown.at(-1)!.models) {
      const key = `${variant.model}:${variant.speed}`;
      const aggregate = variantTotals.get(key) ?? {
        model: variant.model,
        speed: variant.speed ?? "standard",
        credits: 0,
      };
      aggregate.credits += variant.credits;
      variantTotals.set(key, aggregate);
    }
    workspaceUsageCounts.push({
      date,
      totals: { credits, turns, threads, users: 2, text_total_tokens: backendTokens },
      clients,
      models: [{ model: event.model, credits: primaryCredits, turns: primaryTurns, threads: primaryThreads, users: 2 }, { model: "codex-auto-review", credits: reviewCredits, turns: reviewTurns, threads: reviewThreads, users: 1 }],
    });
    totalCredits += credits;
    totalTurns += turns;
    totalThreads += threads;
    textTotalTokens += backendTokens;
  }

  return {
    fetched: true,
    endpoints: {
      usage: "/wham/usage",
      daily: "/wham/usage/daily-token-usage-breakdown",
      workspace: "/wham/analytics/workspace-usage-counts",
      tasks: "/wham/tasks",
      planLimitHistory: "/wham/usage/plan_limit_history?days=7",
      dailyPluginUsageMetrics: "/wham/analytics/daily-plugin-usage-metrics",
      dailySkillUsageMetrics: "/wham/analytics/daily-skill-usage-metrics",
      threadUsageQuery: "/wham/usage/thread_usage/query_v2",
    },
    usage: {
      planType: "plus",
      rateLimit: {
        primaryUsedPercent: 42,
        secondaryUsedPercent: 37,
        primaryResetAt: 1_783_113_600,
        secondaryResetAt: 1_783_718_400,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "86.40",
        overageLimitReached: false,
        approxLocalMessages: [420, 510],
        approxCloudMessages: [110, 145],
      },
    },
    dailyTokenUsageBreakdown: {
      units: "percent",
      groupBy: "day",
      dataFreshnessTs: "2026-09-23T03:15:00.000Z",
      data: dailyTokenUsageBreakdown,
    },
    planLimitHistory: buildDemoPlanHistory(),
    pluginUsage: buildDemoToolActivity(dates, "plugin"),
    skillUsage: buildDemoToolActivity(dates, "skill"),
    topChats: buildDemoTopChats(),
    workspaceUsageCounts: {
      groupBy: "day",
      data: workspaceUsageCounts,
    },
    tasks: {
      currentCount: 18,
      archivedCount: 47,
      archivedHasMore: true,
      currentByEnvironment: [
        { environment: "Demo workspace", count: 11 },
        { environment: "Demo cloud", count: 7 },
      ],
      currentByStatus: [
        { status: "Ready for review", count: 7 },
        { status: "In progress", count: 6 },
        { status: "Queued", count: 5 },
      ],
      currentByIntent: [
        { intent: "Build feature", count: 8 },
        { intent: "Fix issue", count: 6 },
        { intent: "Review change", count: 4 },
      ],
      pullRequests: { total: 14, open: 5, merged: 8, closed: 1 },
      diffStats: { filesModified: 286, linesAdded: 18_420, linesRemoved: 6_375 },
      recent: [
        {
          title: "Build the sample analytics dashboard",
          environment: "Demo workspace",
          status: "Ready for review",
          branch: "demo/analytics-dashboard",
          updatedAt: 1_783_108_800,
          archived: false,
          pullRequests: 2,
        },
        {
          title: "Polish responsive report controls",
          environment: "Demo cloud",
          status: "In progress",
          branch: "demo/responsive-report",
          updatedAt: 1_782_849_600,
          archived: false,
          pullRequests: 1,
        },
        {
          title: "Validate historical pricing migration",
          environment: "Demo workspace",
          status: "Completed",
          branch: "demo/pricing-history",
          updatedAt: 1_780_257_600,
          archived: true,
          pullRequests: 1,
        },
      ],
    },
    totals: {
      credits: roundMoney(totalCredits),
      turns: totalTurns,
      threads: totalThreads,
      users: 2,
      textTotalTokens,
    },
    byModel: [...modelTotals.values()].map((row) => ({ ...row, credits: roundMoney(row.credits) })),
    byModelVariants: [...variantTotals.values()].map((row) => ({
      ...row,
      credits: roundMoney(row.credits),
    })),
    bySurface: SURFACES.map((surface) => {
      const row = surfaceTotals.get(surface.label)!;
      return {
        surface: surface.label,
        credits: roundMoney(row.credits),
        percent: surface.share * 100,
        turns: row.turns,
        threads: row.threads,
        users: row.users,
        textTotalTokens: row.textTotalTokens,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens,
      };
    }),
    bySource: [
      {
        source: "Local sessions",
        credits: roundMoney(totalCredits * 0.73),
        turns: Math.round(totalTurns * 0.73),
        threads: Math.round(totalThreads * 0.73),
        users: 2,
        textTotalTokens: Math.round(textTotalTokens * 0.73),
      },
      {
        source: "Cloud tasks",
        credits: roundMoney(totalCredits * 0.27),
        turns: Math.round(totalTurns * 0.27),
        threads: Math.round(totalThreads * 0.27),
        users: 2,
        textTotalTokens: Math.round(textTotalTokens * 0.27),
      },
    ],
  };
}

function buildDemoPlanHistory(): NonNullable<WhamAnalytics["planLimitHistory"]> {
  const periods: NonNullable<WhamAnalytics["planLimitHistory"]>["periods"] = [];
  for (const [index, start] of ["2026-09-07T00:00:00Z", "2026-09-14T00:00:00Z", "2026-09-21T00:00:00Z"].entries()) {
    const used = [4840, 3720, 570][index];
    periods.push({
      id: `demo-week-${index + 1}`,
      windowMinutes: 10080,
      planType: "plus",
      startsAt: start,
      endsAt: new Date(Date.parse(start) + 7 * 86400000).toISOString(),
      accountingComplete: index !== 2,
      usedBasisPoints: used,
      breakdowns: demoLimitBreakdowns(used),
    });
  }
  for (let index = 0; index < 5; index += 1) {
    const start = new Date(Date.parse("2026-09-22T18:00:00Z") + index * 5 * 3600000);
    const used = [220, 410, 315, 180, 80][index];
    periods.push({
      id: `demo-five-hour-${index + 1}`,
      windowMinutes: 300,
      planType: "plus",
      startsAt: start.toISOString(),
      endsAt: new Date(start.valueOf() + 5 * 3600000).toISOString(),
      accountingComplete: index !== 4,
      usedBasisPoints: used,
      breakdowns: demoLimitBreakdowns(used),
    });
  }
  return { dataAsOf: "2026-09-23T03:15:00Z", coverageStart: "2026-09-07T00:00:00Z", coverageComplete: false, approximate: true, boundaryToleranceSeconds: 60, periods };
}

function demoLimitBreakdowns(total: number): NonNullable<NonNullable<WhamAnalytics["planLimitHistory"]>["periods"][number]["breakdowns"]> {
  const split = (mix: Array<{ key: string; share: number }>) => {
    const counts = apportionedCounts(total, mix.map((row) => row.share));
    return mix.map((row, index) => ({ key: row.key, basisPoints: counts[index] }));
  };
  return [
    { dimension: "thread_source", rows: split(FEATURES) },
    { dimension: "model", rows: split([{ key: "gpt-6-astra", share: 0.7296 }, { key: "gpt-5.6-sol", share: 0.1152 }, { key: "gpt-6-sol", share: 0.0672 }, { key: "gpt-6-luna", share: 0.048 }, { key: "codex-auto-review", share: 0.04 }]) },
    { dimension: "surface", rows: split(SURFACES.map((surface) => ({ key: surface.id, share: surface.share }))) },
    { dimension: "turn_trigger", rows: split(TURN_STARTS) },
  ];
}

function buildDemoToolActivity(dates: string[], kind: "plugin" | "skill"): NonNullable<WhamAnalytics["pluginUsage"]> {
  const names = kind === "plugin" ? ["Unified Computer Use", "Codex App Tools", "Thoughts", "Other"] : ["Using Superpowers", "Thoughts", "Verification Before Completion", "Other"];
  return {
    dataFreshnessTs: "2026-09-23T03:15:00.000Z",
    data: dates.slice(-30).map((date, index) => ({
      date,
      rows: names.map((label, nameIndex) => ({ key: label.toLowerCase().replaceAll(" ", "-"), label, count: (index * 7 + nameIndex * 3) % (kind === "plugin" ? 12 : 6) })),
    })),
  };
}

function buildDemoTopChats(): NonNullable<WhamAnalytics["topChats"]> {
  const weekly = [29.14, 5.8, 2.4, 1.3, 0.7, 0.2];
  return {
    dataAsOf: "2026-09-23T03:15:00.000Z",
    chats: buildDemoThreads().map((thread, index) => ({
      threadId: thread.threadId,
      title: thread.title,
      homeLabel: thread.homeLabel,
      dataStatus: "available",
      fiveHourLimitPercent: roundMoney(weekly[index] / 3),
      weeklyLimitPercent: weekly[index],
      balanceUsageCredits: index % 3 === 0 ? 0 : roundMoney(index * 0.35),
      groups: [
        { model: index % 2 ? "gpt-5.6-sol" : "gpt-6-astra", reasoningEffort: "medium", speed: "fast", fiveHourLimitPercent: roundMoney(weekly[index] / 4), weeklyLimitPercent: roundMoney(weekly[index] * 0.83), balanceUsageCredits: 0 },
        { model: "gpt-6-luna", reasoningEffort: "low", speed: "standard", fiveHourLimitPercent: roundMoney(weekly[index] / 12), weeklyLimitPercent: roundMoney(weekly[index] * 0.17), balanceUsageCredits: index % 3 === 0 ? 0 : roundMoney(index * 0.35) },
      ],
    })),
  };
}

function emptySurfaceTotal() {
  return {
    credits: 0,
    turns: 0,
    threads: 0,
    users: 0,
    textTotalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

function buildPayments(): PaymentHistory {
  const amounts: Record<string, number> = {
    "2025-12": 24,
    "2026-01": 24,
    "2026-02": 100,
    "2026-03": 100,
    "2026-04": 100,
    "2026-05": 200,
    "2026-06": 200,
    "2026-07": 200,
    "2026-08": 200,
    "2026-09": 200,
  };
  return {
    currency: "USD",
    fetched: true,
    complete: true,
    endpoint: "/payments/transaction-history",
    transactions: Object.entries(amounts).map(([month, amountUsd]) => ({
      fingerprint: stableHash(`demo-payment:${month}`),
      month,
      amountUsd,
    })),
    overrides: {
      "2026-06": 200,
    },
    sources: [
      { kind: "api", label: "Demo transaction history", status: "complete" },
      { kind: "json", label: "demo-payments.json", status: "complete" },
    ],
    diagnostics: {
      pages: 1,
      skippedTransactions: 0,
      duplicateTransactions: 0,
      repeatedCursor: false,
    },
  };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

if (import.meta.main) {
  const { reportPath } = await writeDemoDataset({ report: process.argv.includes("--report") });
  console.log(
    reportPath ? `Generated demo report: ${reportPath}` : `Generated demo dataset: ${DEMO_PATH}`,
  );
}
