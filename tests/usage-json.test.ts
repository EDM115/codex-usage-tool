import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildDataset } from "../src/aggregate";
import { writeOutputs } from "../src/export";
import { emptyPaymentHistory, paymentMonthTotals } from "../src/payments";
import { loadPricing } from "../src/pricing";
import type { ProgressSink } from "../src/progress";
import { resolveUsageThemes } from "../src/theme";
import type { CapabilityUsageEvent, PaymentHistory, TokenEvent, UsageDataset } from "../src/types";
import { loadUsageDatasets, mergeUsageDatasets } from "../src/usage-json";

test("loadUsageDatasets reads generated datasets and identifies invalid inputs", async () => {
  const root = join(tmpdir(), `codex-usage-json-load-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const dataset = await createDataset({ home: "laptop", model: "gpt-5", tokens: 100 });
  const validPath = join(root, "usage-data.json");
  const invalidPath = join(root, "not-usage-data.json");
  writeFileSync(validPath, JSON.stringify(dataset));
  writeFileSync(invalidPath, "{}");

  expect(loadUsageDatasets([validPath])).toEqual([dataset]);
  expect(() => loadUsageDatasets([invalidPath])).toThrow(
    `Invalid usage JSON ${resolve(invalidPath)} : expected a generated usage-data.json`,
  );
});

test("loadUsageDatasets rejects malformed metrics and unsafe theme CSS", async () => {
  const root = join(tmpdir(), `codex-usage-json-validation-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const malformed = await createDataset({ home: "laptop", model: "gpt-5", tokens: 100 });
  const unsafe = structuredClone(malformed);
  const malformedPath = join(root, "malformed.json");
  const unsafePath = join(root, "unsafe.json");
  (malformed.daily[0].localTokens as unknown as { totalTokens: string }).totalTokens = "100";
  unsafe.theme.colors.bg = "#fff;</style><script>alert(1)</script>";
  writeFileSync(malformedPath, JSON.stringify(malformed));
  writeFileSync(unsafePath, JSON.stringify(unsafe));

  expect(() => loadUsageDatasets([malformedPath])).toThrow("expected a generated usage-data.json");
  expect(() => loadUsageDatasets([unsafePath])).toThrow("expected a generated usage-data.json");
});

test("loadUsageDatasets migrates version 2 payment history in memory", async () => {
  const source = await createDataset({ home: "legacy", model: "gpt-5", tokens: 100 });
  source.schemaVersion = 2;
  delete (source as unknown as { payments?: PaymentHistory }).payments;
  const root = join(tmpdir(), `codex-usage-payment-migration-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "usage-data.json");
  writeFileSync(path, JSON.stringify(source));

  const loaded = loadUsageDatasets([path])[0] as UsageDataset & { payments: PaymentHistory };
  expect(loaded.schemaVersion).toBe(3);
  expect(loaded.payments).toEqual(emptyPaymentHistory());
  expect(JSON.parse(readFileSync(path, "utf8")).payments).toBeUndefined();
});

test("loadUsageDatasets rejects malformed version 3 payment history", async () => {
  const source = await createDataset({ home: "invalid-payment", model: "gpt-5", tokens: 100 });
  (source as UsageDataset & { payments: unknown }).payments = {
    ...emptyPaymentHistory(),
    transactions: [{ fingerprint: "raw-invoice-id", month: "2026-06", amountUsd: 24 }],
  };
  const root = join(tmpdir(), `codex-usage-payment-validation-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "usage-data.json");
  writeFileSync(path, JSON.stringify(source));

  expect(() => loadUsageDatasets([path])).toThrow("expected a generated usage-data.json");
});

test("mergeUsageDatasets deduplicates payment transactions by fingerprint", async () => {
  const first = await createDataset({ home: "first", model: "gpt-5", tokens: 100 });
  const second = await createDataset({ home: "second", model: "gpt-5", tokens: 100 });
  const fingerprint = "a".repeat(64);
  (first as UsageDataset & { payments: PaymentHistory }).payments = paymentHistoryWithFact(
    fingerprint,
    "2026-06",
    24,
  );
  (second as UsageDataset & { payments: PaymentHistory }).payments = paymentHistoryWithFact(
    fingerprint,
    "2026-06",
    24,
  );

  const merged = mergeUsageDatasets([first, second], {
    from: null,
    to: null,
    timezone: "Europe/Paris",
  }) as UsageDataset & { payments: PaymentHistory };
  expect(paymentMonthTotals(merged.payments)).toEqual({ "2026-06": 24 });
});

test("current payment overrides beat imported overrides and first import wins conflicts", async () => {
  const first = await createDataset({ home: "first", model: "gpt-5", tokens: 100 });
  const second = await createDataset({ home: "second", model: "gpt-5", tokens: 100 });
  (first as UsageDataset & { payments: PaymentHistory }).payments = paymentHistoryWithOverride(
    "2026-06",
    24,
  );
  (second as UsageDataset & { payments: PaymentHistory }).payments = paymentHistoryWithOverride(
    "2026-06",
    119.87,
  );
  const options = { from: null, to: null, timezone: "Europe/Paris" };
  const imported = mergeUsageDatasets([first, second], options) as UsageDataset & {
    payments: PaymentHistory;
  };
  const current = mergeUsageDatasets([first, second], {
    ...options,
    payments: paymentHistoryWithOverride("2026-06", 42),
  } as Parameters<typeof mergeUsageDatasets>[1]) as UsageDataset & { payments: PaymentHistory };

  expect(paymentMonthTotals(imported.payments)["2026-06"]).toBe(24);
  expect(paymentMonthTotals(current.payments)["2026-06"]).toBe(42);
});

test("mergeUsageDatasets adds local sources without duplicating cloud enrichment", async () => {
  const desktop = await createDataset({
    home: "desktop",
    model: "gpt-5",
    tokens: 100,
    backendTokens: 300,
    analyticsModel: "gpt-5",
    serviceTier: "default",
  });
  const laptop = await createDataset({
    home: "laptop",
    model: "gpt-5-mini",
    tokens: 50,
    backendTokens: 999,
    analyticsModel: "gpt-5-mini",
    serviceTier: "priority",
  });
  const capabilityEvent: CapabilityUsageEvent = {
    eventId: "desktop-capability",
    homePath: "desktop",
    homeLabel: "desktop",
    rolloutPath: "desktop/rollout.jsonl",
    threadId: "desktop-thread",
    timestamp: "2026-07-10T08:01:00.000Z",
    date: "2026-07-10",
    kind: "plugin",
    name: "Codex Security",
    evidenceType: "injection",
    confidence: "high",
    detail: "Injected plugin capabilities",
  };
  (desktop.local as typeof desktop.local & { capabilityEvents?: unknown[] }).capabilityEvents = [
    capabilityEvent,
  ];

  const merged = mergeUsageDatasets([desktop, laptop], {
    from: null,
    to: null,
    timezone: "Europe/Paris",
  });
  const day = merged.daily.find((row) => row.date === "2026-07-10");

  expect(day?.backendTokens).toBe(300);
  expect(day?.localTokens.totalTokens).toBe(150);
  expect(day?.totalTokens).toBe(300);
  expect(day?.unattributedTokens).toBe(150);
  expect(Object.keys(day?.models ?? {}).sort()).toEqual(["gpt-5", "gpt-5-mini"]);
  expect(merged.local.modelUsage.map((row) => row.model).sort()).toEqual(["gpt-5", "gpt-5-mini"]);
  expect(merged.codexHomes.map((home) => home.label).sort()).toEqual(["desktop", "laptop"]);
  expect(merged.profile).toEqual(desktop.profile);
  expect(merged.analytics).toEqual(desktop.analytics);
  expect(merged.summary.localKnownTokens).toBe(150);
  expect(merged.summary.lifetimeTokens).toBe(300);
  expect(
    (merged.local as typeof merged.local & { capabilityEvents?: unknown[] }).capabilityEvents,
  ).toEqual([capabilityEvent]);
});

test("mergeUsageDatasets deduplicates overlapping portable token events and source manifests", async () => {
  const dataset = await createDataset({ home: "desktop", model: "gpt-5.5", tokens: 100 });
  const distinct = await createDataset({ home: "laptop", model: "gpt-5.5", tokens: 50 });
  const pricing = await loadPricing({ source: "bundled" });

  const merged = mergeUsageDatasets(
    [dataset, structuredClone(dataset), distinct, structuredClone(dataset)],
    {
      from: null,
      to: null,
      timezone: "Europe/Paris",
      pricing,
    },
  );

  expect(merged.summary.localKnownTokens).toBe(150);
  expect(merged.local.distinctSessions).toBe(2);
  expect(merged.sources).toHaveLength(2);
  expect(merged.local.coverage.discoveredFiles).toBe(2);
  expect(merged.local.coverage.parsedFiles).toBe(2);
  expect(merged.local.merge).toMatchObject({ duplicateEvents: 2, duplicateSources: 2 });
});

test("mergeUsageDatasets surfaces conservative overlap handling for aggregate-only inputs", async () => {
  const legacy = await createDataset({ home: "desktop", model: "gpt-5.5", tokens: 100 });
  delete legacy.local.events;
  const merged = mergeUsageDatasets([legacy, structuredClone(legacy)], {
    from: null,
    to: null,
    timezone: "Europe/Paris",
  });

  expect(merged.summary.localKnownTokens).toBe(100);
  expect(merged.local.distinctSessions).toBe(1);
  expect(merged.sources).toHaveLength(1);
  expect(merged.local.merge).toEqual({
    duplicateEvents: 0,
    duplicateSources: 1,
    legacyOverlaps: 1,
  });
});

test("mergeUsageDatasets reprices imported service-tier breakdowns with the active catalog", async () => {
  const imported = await createDataset({
    home: "laptop",
    model: "gpt-5.5",
    tokens: 100,
    serviceTier: "priority",
  });
  const staleModel = imported.local.modelUsage[0];
  const staleDailyModel = imported.daily[0].modelUsage[0];
  staleModel.costUsd = 999;
  staleModel.reasoningEfforts[0].costUsd = 999;
  staleModel.serviceTiers[0].costUsd = 999;
  staleDailyModel.costUsd = 999;
  staleDailyModel.reasoningEfforts[0].costUsd = 999;
  staleDailyModel.serviceTiers[0].costUsd = 999;
  imported.daily[0].knownLocalCostUsd = 999;
  imported.daily[0].estimatedCostUsd = 999;
  imported.summary.knownLocalCostUsd = 999;
  imported.summary.estimatedCostUsd = 999;
  const pricing = await loadPricing({ source: "bundled" });

  const merged = mergeUsageDatasets([imported], {
    from: null,
    to: null,
    timezone: "Europe/Paris",
    pricing,
    estimateModel: "gpt-5.6-sol",
  });

  expect(merged.local.modelUsage[0].costUsd).toBeCloseTo(0.001875, 8);
  expect(merged.local.modelUsage[0].serviceTiers[0].costUsd).toBeCloseTo(0.001875, 8);
  expect(merged.local.modelUsage[0].reasoningEfforts[0].costUsd).toBeCloseTo(0.001875, 8);
  expect(merged.daily[0].knownLocalCostUsd).toBeCloseTo(0.001875, 8);
  expect(merged.summary.knownLocalCostUsd).toBeCloseTo(0.001875, 8);
  expect(merged.pricing.source).toBe(pricing.source);
});

test("mergeUsageDatasets reprices and rebuilds model totals from each daily price period", async () => {
  const beforeReduction = await createDataset({
    home: "before",
    model: "gpt-5.6-luna",
    tokens: 2_000_000,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    date: "2026-07-29",
  });
  const afterReduction = await createDataset({
    home: "after",
    model: "gpt-5.6-luna",
    tokens: 2_000_000,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    date: "2026-07-30",
  });
  beforeReduction.local.modelUsage[0].costUsd = 999;
  afterReduction.local.modelUsage[0].costUsd = 999;
  const pricing = await loadPricing({ source: "bundled" });

  const merged = mergeUsageDatasets([beforeReduction, afterReduction], {
    from: null,
    to: null,
    timezone: "Europe/Paris",
    pricing,
    estimateModel: "gpt-5.6-sol",
  });

  expect(merged.daily.map((day) => day.knownLocalCostUsd)).toEqual([7, 1.4]);
  expect(merged.local.modelUsage).toHaveLength(1);
  expect(merged.local.modelUsage[0].model).toBe("gpt-5.6-luna");
  expect(merged.local.modelUsage[0].costUsd).toBeCloseTo(8.4);
  expect(merged.summary.knownLocalCostUsd).toBeCloseTo(8.4);
});

test("mergeUsageDatasets rejects unsupported date filtering and incompatible timezones", async () => {
  const dataset = await createDataset({ home: "desktop", model: "gpt-5", tokens: 100 });

  expect(() =>
    mergeUsageDatasets([dataset], { from: "2026-07-10", to: null, timezone: "Europe/Paris" }),
  ).toThrow("Usage JSON inputs cannot be re-filtered by date");
  expect(() =>
    mergeUsageDatasets([{ ...dataset, timezone: "America/New_York" }], {
      from: null,
      to: null,
      timezone: "Europe/Paris",
    }),
  ).toThrow("Usage JSON timezone America/New_York does not match Europe/Paris");
});

test("generate rebuilds every report artifact from usage JSON without a Codex home", async () => {
  const root = join(tmpdir(), `codex-usage-json-cli-${crypto.randomUUID()}`);
  const outDir = join(root, "report");
  const inputPath = join(root, "usage-data.json");
  const paymentsPath = join(root, "payments.json");
  mkdirSync(root, { recursive: true });
  const shared = await createDataset({ home: "shared", model: "gpt-5", tokens: 100 });
  shared.timezone = "America/New_York";
  writeFileSync(inputPath, JSON.stringify(shared));
  writeFileSync(paymentsPath, JSON.stringify({ "2026-06": 42 }));

  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "src/cli.ts",
      "generate",
      "--usage-json",
      inputPath,
      "--payments-json",
      paymentsPath,
      "--out",
      outDir,
      "--pricing-source",
      "bundled",
      "--silent",
    ],
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(child.exitCode, `${child.stdout.toString()}\n${child.stderr.toString()}`).toBe(0);

  for (const file of [
    "usage-data.json",
    "cost-estimate.csv",
    "usage-report.html",
    "heatmap-daily.svg",
    "heatmap-daily.png",
    "bar-daily.svg",
    "bar-daily.png",
    "area-daily.svg",
    "area-daily.png",
    "roi.svg",
    "roi.png",
    "skills-plugins-pie.svg",
    "skills-plugins-pie.png",
  ]) {
    expect(existsSync(join(outDir, file)), file).toBe(true);
  }

  const rebuilt = JSON.parse(readFileSync(join(outDir, "usage-data.json"), "utf8")) as UsageDataset;
  expect(rebuilt.summary.localKnownTokens).toBe(100);
  expect(rebuilt.codexHomes).toEqual([{ path: "shared", label: "shared" }]);
  expect(rebuilt.timezone).toBe("America/New_York");
  expect(rebuilt.schemaVersion).toBe(3);
  expect(rebuilt.payments.overrides).toEqual({ "2026-06": 42 });
  expect(rebuilt.payments.sources).toEqual([
    { kind: "json", label: "payments.json", status: "complete" },
  ]);
  expect(rebuilt.payments.endpoint).toBeUndefined();
}, 15_000);

test("writeOutputs writes the HTML report before generating image artifacts", async () => {
  const root = join(tmpdir(), `codex-usage-export-order-${crypto.randomUUID()}`);
  const dataset = await createDataset({ home: "desktop", model: "gpt-5", tokens: 100 });
  const steps: string[] = [];
  const progress: ProgressSink = {
    setSteps() {},
    step(message) {
      steps.push(message);
    },
    status() {},
    statusProgress() {},
    statusDone(message) {
      steps.push(message);
    },
    finish() {},
  };

  await writeOutputs(dataset, root, { includePng: false, progress });

  expect(steps).toEqual([
    "Generated JSON data",
    "Generated HTML report",
    "Generated CSV estimate",
    "Generated 11 SVG",
  ]);
});

async function createDataset(args: {
  home: string;
  model: string;
  tokens: number;
  backendTokens?: number;
  analyticsModel?: string;
  serviceTier?: string;
  date?: string;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<UsageDataset> {
  const pricing = await loadPricing({ source: "bundled" });
  const date = args.date ?? "2026-07-10";
  const outputTokens = args.outputTokens ?? 10;
  const event: TokenEvent = {
    eventId: `${args.home}-event`,
    homePath: args.home,
    homeLabel: args.home,
    rolloutPath: `${args.home}/rollout.jsonl`,
    threadId: `${args.home}-thread`,
    timestamp: `${date}T08:00:00.000Z`,
    date,
    model: args.model,
    reasoningEffort: "high",
    serviceTier: args.serviceTier,
    breakdown: {
      inputTokens: args.inputTokens ?? args.tokens - outputTokens,
      cachedInputTokens: 0,
      outputTokens,
      reasoningOutputTokens: 2,
      totalTokens: args.tokens,
    },
  };

  return buildDataset({
    profileResult: args.backendTokens
      ? {
          fetched: true,
          endpoint: "https://example.test/profile",
          profile: {
            summary: {
              lifetimeTokens: args.backendTokens,
              peakDailyTokens: args.backendTokens,
              currentStreakDays: 1,
              longestStreakDays: 1,
              longestRunningTurnSec: 1,
            },
            dailyUsageBuckets: [{ startDate: date, tokens: args.backendTokens }],
          },
        }
      : { fetched: false, error: "offline" },
    events: [event],
    codexHomes: [{ path: args.home, label: args.home }],
    sourceMode: args.backendTokens ? "hybrid" : "local",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    localStats: { rolloutFiles: 1, sqliteDatabases: 1, sqliteThreads: 1, parseErrors: [] },
    pricing,
    estimateModel: "gpt-5",
    ...resolveUsageThemes([]),
    analytics: args.analyticsModel
      ? {
          fetched: true,
          endpoints: {},
          totals: { credits: 1, turns: 1, threads: 1, users: 1, textTotalTokens: args.tokens },
          byModel: [{ model: args.analyticsModel, credits: 1, turns: 1, threads: 1, users: 1 }],
          byModelVariants: [],
          bySurface: [],
          bySource: [],
        }
      : undefined,
  });
}

function paymentHistoryWithFact(
  fingerprint: string,
  month: string,
  amountUsd: number,
): PaymentHistory {
  const history = emptyPaymentHistory();
  history.complete = true;
  history.transactions = [{ fingerprint, month, amountUsd }];
  history.sources = [{ kind: "api", label: "transaction history", status: "complete" }];
  return history;
}

function paymentHistoryWithOverride(month: string, amountUsd: number): PaymentHistory {
  const history = emptyPaymentHistory();
  history.complete = true;
  history.overrides = { [month]: amountUsd };
  history.sources = [{ kind: "json", label: "payments.json", status: "complete" }];
  return history;
}
