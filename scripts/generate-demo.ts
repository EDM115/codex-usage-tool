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
const LAST_USAGE_DATE = "2026-06-30";
const GENERATED_AT = "2026-07-01T12:00:00.000Z";
const TIMEZONE = "Europe/Paris";
const DEMO_PATH = resolve("demo.json");
const DEMO_REPORT_DIR = resolve("output/demo");

const CODEX_HOMES: CodexHome[] = [
  { path: "demo/codex-home-alpha", label: "Demo workstation" },
  { path: "demo/codex-home-beta", label: "Demo travel laptop" },
];

type SurfaceDefinition = {
  id: "desktop_app" | "ide_vscode" | "service_exec";
  label: "Desktop app" | "VS Code" | "Service exec";
  share: number;
};

const SURFACES: SurfaceDefinition[] = [
  { id: "desktop_app", label: "Desktop app", share: 0.55 },
  { id: "ide_vscode", label: "VS Code", share: 0.35 },
  { id: "service_exec", label: "Service exec", share: 0.1 },
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
        version: 2,
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
    includePng: false,
    reportOnly: true,
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
  const model = modelForDate(date);
  const reasoningEffort = ["low", "medium", "high", "xhigh"][index % 4];
  const serviceTier = index % 5 === 0 ? "priority" : "default";
  const modelAttribution = index % 9 === 0 ? "metadata" : "observed";
  const reasoningEffortAttribution = index % 7 === 0 ? "metadata" : "observed";
  const serviceTierAttribution = index % 11 === 0 ? "inferred" : "observed";
  const breakdown = buildTokenBreakdown(index, date);
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
    source: ["desktop", "vscode", "exec"][index % 3],
    planType: "plus",
    breakdown,
    modelContextWindow: index % 17 === 0 ? 1_050_000 : 400_000,
  };
}

function buildTokenBreakdown(index: number, date: string): TokenBreakdown {
  const monthIndex = Number(date.slice(5, 7)) - 1;
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const weekdayMultiplier = weekday === 0 || weekday === 6 ? 0.64 : 1;
  const wave = 0.82 + ((index * 37) % 41) / 100;
  const launchBoost = date >= "2026-04-23" ? 1.12 : 1;
  const presentationBalance =
    {
      "01": 0.25,
      "02": 1.06,
      "03": 0.98,
      "04": 5.315,
      "05": 6.993,
      "06": 13.552,
    }[date.slice(5, 7)] ?? 1;
  const totalTokens = Math.round(
    (1_420_000 + monthIndex * 105_000) *
      weekdayMultiplier *
      wave *
      launchBoost *
      presentationBalance,
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

function modelForDate(date: string): string {
  if (date >= "2026-04-23") return "gpt-5.5";
  if (date >= "2026-03-05") return "gpt-5.4";
  if (date >= "2026-02-05") return "gpt-5.3-codex";
  return "gpt-5.2-codex";
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
      lifetimeTokens: timelineTotal + 184_000_000,
      peakDailyTokens: Math.max(...dailyUsageBuckets.map((bucket) => bucket.tokens)),
      longestRunningTurnSec: 7_428,
      currentStreakDays: 19,
      longestStreakDays: 47,
    },
    dailyUsageBuckets,
  };
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
  let totalCredits = 0;
  let totalTurns = 0;
  let totalThreads = 0;
  let textTotalTokens = 0;

  for (const [index, date] of dates.entries()) {
    const event = events[index];
    const backendTokens = profile.dailyUsageBuckets?.[index]?.tokens ?? event.breakdown.totalTokens;
    const credits = roundMoney(8 + backendTokens / 290_000);
    const turns = 3 + (index % 9);
    const threads = 1 + (index % 3);
    const fastShare = index % 5 === 0 ? 0.42 : 0.18;
    const standardCredits = roundMoney(credits * (1 - fastShare));
    const fastCredits = roundMoney(credits - standardCredits);
    const surfaceValues = Object.fromEntries(
      SURFACES.map((surface) => [surface.id, roundMoney(100 * surface.share)]),
    );
    dailyTokenUsageBreakdown.push({
      date,
      productSurfaceUsageValues: surfaceValues,
      models: [
        { model: event.model, speed: "standard", credits: standardCredits },
        { model: event.model, speed: "fast", credits: fastCredits },
      ],
    });

    const clients = SURFACES.map((surface, surfaceIndex) => {
      const localInput = Math.round(event.breakdown.inputTokens * surface.share);
      const cachedInput = Math.round(event.breakdown.cachedInputTokens * surface.share);
      const output = Math.round(event.breakdown.outputTokens * surface.share);
      const clientCredits = roundMoney(credits * surface.share);
      const clientTurns = Math.max(1, Math.round(turns * surface.share));
      const clientThreads = Math.max(1, Math.round(threads * surface.share));
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
    const model = modelTotals.get(event.model) ?? {
      model: event.model,
      credits: 0,
      turns: 0,
      threads: 0,
      users: 0,
    };
    model.credits += credits;
    model.turns += turns;
    model.threads += threads;
    model.users = Math.max(model.users, 2);
    modelTotals.set(event.model, model);
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
      models: [{ model: event.model, credits, turns, threads, users: 2 }],
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
      daily: "/wham/analytics/daily-token-usage-breakdown",
      workspace: "/wham/analytics/workspace-usage-counts",
      tasks: "/wham/tasks",
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
      units: "credits",
      groupBy: "day",
      data: dailyTokenUsageBreakdown,
    },
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
