import { expect, test } from "bun:test";

import {
  buildRoiMetrics,
  rangeForPreset,
  reportRuntimeSource,
  roiCurveSegments,
  summarizeTokenComposition,
} from "../src/report-runtime";
import type { DailyUsage } from "../src/types";

test("rangeForPreset keeps rolling presets Codex-anchored and expands only All time to payment months", () => {
  const codexDates = ["2026-01-20", "2026-08-09"];
  const paymentMonths = ["2025-02", "2026-10"];

  expect(rangeForPreset(codexDates, "7d", paymentMonths)).toEqual({
    from: "2026-08-03",
    to: "2026-08-09",
  });
  expect(rangeForPreset(codexDates, "30d", paymentMonths)).toEqual({
    from: "2026-07-11",
    to: "2026-08-09",
  });
  expect(rangeForPreset(codexDates, "90d", paymentMonths)).toEqual({
    from: "2026-05-12",
    to: "2026-08-09",
  });
  expect(rangeForPreset(codexDates, "all", paymentMonths)).toEqual({
    from: "2025-02-01",
    to: "2026-10-31",
  });
});

test("rangeForPreset does not clamp rolling ranges and supports payment-only fallback", () => {
  expect(rangeForPreset(["2026-07-29", "2026-07-31"], "30d", ["2025-02"])).toEqual({
    from: "2026-07-02",
    to: "2026-07-31",
  });
  expect(rangeForPreset([], "30d", ["2026-06"])).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  expect(rangeForPreset([], "all", ["2026-02", "2026-06"])).toEqual({
    from: "2026-02-01",
    to: "2026-06-30",
  });
  expect(rangeForPreset([], "30d")).toEqual({ from: "", to: "" });
});

test("summarizeTokenComposition preserves unknown backend and local residual tokens", () => {
  const summary = summarizeTokenComposition([
    reportDay("2026-07-01", {
      total: 130,
      input: 80,
      cached: 50,
      output: 30,
      reasoning: 10,
      backendOnly: 20,
    }),
  ]);

  expect(summary).toEqual({
    input: 80,
    output: 30,
    backendOnly: 20,
    localResidual: 20,
    unknown: 40,
    cachedInput: 50,
    uncachedInput: 30,
    cacheCounterExcess: 0,
    reasoningOutput: 10,
    visibleOutput: 20,
    reasoningCounterExcess: 0,
  });
});

test("summarizeTokenComposition clamps malformed subset counters and reports their excess", () => {
  const summary = summarizeTokenComposition([
    reportDay("2026-07-01", {
      total: 30,
      input: 20,
      cached: 25,
      output: 10,
      reasoning: 15,
      backendOnly: 0,
    }),
  ]);

  expect(summary.cachedInput).toBe(20);
  expect(summary.uncachedInput).toBe(0);
  expect(summary.cacheCounterExcess).toBe(5);
  expect(summary.reasoningOutput).toBe(10);
  expect(summary.visibleOutput).toBe(0);
  expect(summary.reasoningCounterExcess).toBe(5);
});

test("buildRoiMetrics prorates partial months and exposes both percentages", () => {
  const daily = [reportDayWithCost("2026-06-30", 2), reportDayWithCost("2026-07-01", 6)];
  const metrics = buildRoiMetrics(
    daily,
    { "2026-06": 30, "2026-07": 31 },
    "2026-06-30",
    "2026-07-01",
  );

  expect(metrics.amountPaid).toBe(2);
  expect(metrics.estimatedApiValue).toBe(8);
  expect(metrics.valueCoveragePercent).toBe(400);
  expect(metrics.conventionalRoiPercent).toBe(300);
  expect(metrics.status).toBe("positive");
  expect(metrics.color).toBe("#50fa7b");
  expect(metrics.monthly).toEqual([
    {
      month: "2026-06",
      amountPaid: 1,
      estimatedApiValue: 2,
      valueCoveragePercent: 200,
      conventionalRoiPercent: 100,
      status: "positive",
      color: "#50fa7b",
    },
    {
      month: "2026-07",
      amountPaid: 1,
      estimatedApiValue: 6,
      valueCoveragePercent: 600,
      conventionalRoiPercent: 500,
      status: "positive",
      color: "#50fa7b",
    },
  ]);
});

test("buildRoiMetrics handles leap February, zero spend, negative value, and cent equality", () => {
  const leap = buildRoiMetrics(
    [reportDayWithCost("2028-02-29", 1)],
    { "2028-02": 29 },
    "2028-02-28",
    "2028-02-29",
  );
  expect(leap.amountPaid).toBe(2);

  const zero = buildRoiMetrics(
    [reportDayWithCost("2026-07-01", 3)],
    { "2026-07": 0 },
    "2026-07-01",
    "2026-07-01",
  );
  expect(zero.valueCoveragePercent).toBeNull();
  expect(zero.conventionalRoiPercent).toBeNull();
  expect(zero.status).toBe("positive");

  const negative = buildRoiMetrics(
    [reportDayWithCost("2026-07-01", 0.1)],
    { "2026-07": 31 },
    "2026-07-01",
    "2026-07-01",
  );
  expect(negative.amountPaid).toBe(1);
  expect(negative.status).toBe("negative");
  expect(negative.color).toBe("#ff5555");

  const equal = buildRoiMetrics(
    [reportDayWithCost("2026-07-01", 1.003)],
    { "2026-07": 31.124 },
    "2026-07-01",
    "2026-07-01",
  );
  expect(equal.status).toBe("break-even");
  expect(equal.color).toBe("#f1fa8c");
});

test("buildRoiMetrics includes payment-only months before the first Codex entry", () => {
  const metrics = buildRoiMetrics(
    [reportDayWithCost("2026-07-01", 20)],
    { "2026-05": 31, "2026-07": 31 },
    "2026-05-01",
    "2026-07-31",
  );

  expect(metrics.amountPaid).toBe(62);
  expect(metrics.estimatedApiValue).toBe(20);
  expect(metrics.monthly[0]).toEqual({
    month: "2026-05",
    amountPaid: 31,
    estimatedApiValue: 0,
    valueCoveragePercent: 0,
    conventionalRoiPercent: -100,
    status: "negative",
    color: "#ff5555",
  });
});

test("roiCurveSegments keeps payment-only ROI points and leaves gaps where spend is zero", () => {
  const metrics = buildRoiMetrics(
    [
      reportDayWithCost("2026-05-01", 0),
      reportDayWithCost("2026-06-01", 4),
      reportDayWithCost("2026-07-01", 8),
    ],
    { "2026-05": 31, "2026-07": 31 },
    "2026-05-01",
    "2026-07-31",
  );

  expect(metrics.monthly.slice(0, 2).map((month) => month.conventionalRoiPercent)).toEqual([
    -100,
    null,
  ]);
  expect(metrics.monthly[2].conventionalRoiPercent).toBeCloseTo(-74.19354838709677);
  expect(
    roiCurveSegments(metrics.monthly).map((segment) => segment.map((month) => month.month)),
  ).toEqual([["2026-05"], ["2026-07"]]);
});

test("chart label sampling anchors both edges without crowding the final tick", () => {
  const sampleLabelIndexes = new Function(
    `${reportRuntimeSource()}\nreturn typeof __codexReportRuntime.sampleLabelIndexes === "function" ? __codexReportRuntime.sampleLabelIndexes : null;`,
  )() as ((itemCount: number, maxLabels: number) => number[]) | null;

  expect(sampleLabelIndexes).not.toBeNull();
  expect(sampleLabelIndexes?.(30, 8)).toEqual([0, 4, 8, 12, 16, 20, 24, 29]);
  expect(sampleLabelIndexes?.(7, 8)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(sampleLabelIndexes?.(0, 8)).toEqual([]);
});

test("reportRuntimeSource evaluates the exact exported helpers", () => {
  const runtime = new Function(
    `${reportRuntimeSource()}\nreturn { rangeForPreset, summarizeTokenComposition, buildRoiMetrics, roiCurveSegments };`,
  )() as {
    rangeForPreset: typeof rangeForPreset;
    summarizeTokenComposition: typeof summarizeTokenComposition;
    buildRoiMetrics: typeof buildRoiMetrics;
    roiCurveSegments: typeof roiCurveSegments;
  };
  const dates = ["2026-07-01", "2026-07-31"];
  const days = [
    reportDay("2026-07-31", {
      total: 100,
      input: 60,
      cached: 40,
      output: 30,
      reasoning: 12,
      backendOnly: 15,
    }),
  ];
  const costDays = [reportDayWithCost("2026-07-31", 2)];

  expect(runtime.rangeForPreset(dates, "30d", ["2026-01"])).toEqual(
    rangeForPreset(dates, "30d", ["2026-01"]),
  );
  expect(runtime.summarizeTokenComposition(days)).toEqual(summarizeTokenComposition(days));
  expect(runtime.buildRoiMetrics(costDays, { "2026-07": 31 }, "2026-07-31", "2026-07-31")).toEqual(
    buildRoiMetrics(costDays, { "2026-07": 31 }, "2026-07-31", "2026-07-31"),
  );
  expect(
    runtime.roiCurveSegments(
      buildRoiMetrics(costDays, { "2026-07": 31 }, "2026-07-31", "2026-07-31").monthly,
    ),
  ).toEqual(
    roiCurveSegments(
      buildRoiMetrics(costDays, { "2026-07": 31 }, "2026-07-31", "2026-07-31").monthly,
    ),
  );
});

function reportDay(
  date: string,
  values: {
    total: number;
    input: number;
    cached: number;
    output: number;
    reasoning: number;
    backendOnly: number;
  },
): DailyUsage {
  return {
    date,
    totalTokens: values.total + values.backendOnly,
    backendTokens: values.total + values.backendOnly,
    localTokens: {
      totalTokens: values.total,
      inputTokens: values.input,
      cachedInputTokens: values.cached,
      outputTokens: values.output,
      reasoningOutputTokens: values.reasoning,
    },
    unattributedTokens: values.backendOnly,
    sourceTotal: "backend",
    models: {},
    modelUsage: [],
    reasoningEfforts: {},
    homes: {},
    knownLocalCostUsd: 0,
    cacheSavingsUsd: 0,
    estimatedUnattributedCostUsd: 0,
    estimatedCostUsd: 0,
  };
}

function reportDayWithCost(date: string, estimatedCostUsd: number): DailyUsage {
  const day = reportDay(date, {
    total: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    backendOnly: 0,
  });
  day.estimatedCostUsd = estimatedCostUsd;
  return day;
}
