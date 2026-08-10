import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildDemoDataset, serializeDemoDataset } from "../scripts/generate-demo";
import { paymentMonthTotals } from "../src/payments";
import { renderReportHtml } from "../src/report-html";
import { buildRoiMetrics } from "../src/report-runtime";
import { loadUsageDatasets } from "../src/usage-json";

const DEMO_PATH = resolve("demo.json");

test("demo fixture is fresh, portable, complete, coherent, and safe to share", async () => {
  const dataset = await buildDemoDataset();
  const serialized = serializeDemoDataset(dataset);

  expect(readFileSync(DEMO_PATH, "utf8")).toBe(serialized);
  expect(loadUsageDatasets([DEMO_PATH])).toEqual([dataset]);
  expect(dataset.schemaVersion).toBe(3);
  expect(dataset.generatedAt).toBe("2026-07-01T12:00:00.000Z");
  expect(dataset.sourceMode).toBe("hybrid");
  expect(dataset.daily.at(0)?.date).toBe("2026-01-01");
  expect(dataset.daily.at(-1)?.date).toBe("2026-06-30");
  expect(dataset.daily).toHaveLength(181);
  expect(dataset.weekly.length).toBeGreaterThanOrEqual(26);

  expect(dataset.codexHomes).toHaveLength(2);
  expect(dataset.sources).toHaveLength(2);
  expect(dataset.sources.every((source) => source.status === "complete")).toBe(true);
  expect(dataset.sources.every((source) => source.path?.startsWith("demo/"))).toBe(true);
  expect(dataset.local.coverage).toEqual({
    status: "complete",
    discoveredFiles: 181,
    parsedFiles: 181,
    failedFiles: 0,
    malformedLines: 0,
    missingRoots: [],
  });
  expect(dataset.local.cache.version).toBeGreaterThan(0);
  expect(dataset.local.cache.hits).toBeGreaterThan(0);
  expect(dataset.local.cache.reusedBytes).toBeGreaterThan(0);
  expect(dataset.local.merge).toEqual({
    duplicateEvents: 0,
    duplicateSources: 0,
    legacyOverlaps: 0,
  });

  expect(new Set(dataset.local.modelUsage.map((row) => row.model)).size).toBeGreaterThanOrEqual(4);
  expect(
    new Set(
      dataset.local.modelUsage.flatMap((row) => row.serviceTiers.map((tier) => tier.serviceTier)),
    ),
  ).toEqual(new Set(["default", "priority"]));
  const efforts = new Set(
    dataset.local.modelUsage.flatMap((row) => row.reasoningEfforts.map((effort) => effort.effort)),
  );
  expect(efforts).toEqual(new Set(["low", "medium", "high", "xhigh"]));
  expect(dataset.local.capabilityEvents.some((event) => event.kind === "skill")).toBe(true);
  expect(dataset.local.capabilityEvents.some((event) => event.kind === "plugin")).toBe(true);
  const capabilityCountByName = new Map<string, number>();
  for (const event of dataset.local.capabilityEvents) {
    const key = `${event.kind}:${event.name}`;
    capabilityCountByName.set(key, (capabilityCountByName.get(key) ?? 0) + 1);
  }
  const capabilityCounts = [...capabilityCountByName.values()];
  expect(Math.min(...capabilityCounts)).toBe(1);
  expect(Math.max(...capabilityCounts)).toBe(36);
  expect(dataset.local.distinctSessions).toBeGreaterThan(20);
  expect(dataset.local.attribution.model.completeTokens).toBe(
    dataset.local.attribution.totalTokens,
  );
  expect(dataset.local.attribution.model.certainTokens).toBeLessThan(
    dataset.local.attribution.model.completeTokens,
  );
  expect(dataset.local.attribution.reasoningEffort.completeTokens).toBeGreaterThan(0);
  expect(dataset.local.attribution.reasoningEffort.certainTokens).toBeLessThan(
    dataset.local.attribution.reasoningEffort.completeTokens,
  );

  expect(dataset.summary.cachedInputTokens).toBeGreaterThan(0);
  expect(dataset.summary.unattributedTokens).toBeGreaterThan(0);
  expect(dataset.summary.cacheSavingsUsd).toBeGreaterThan(0);
  expect(dataset.summary.estimatedCostUsd).toBeGreaterThan(0);
  expect(dataset.analytics?.bySurface.map((row) => row.surface)).toEqual(
    expect.arrayContaining(["Desktop app", "VS Code", "Service exec"]),
  );
  expect(dataset.analytics?.byModelVariants.map((row) => row.speed)).toEqual(
    expect.arrayContaining(["standard", "fast"]),
  );
  expect(dataset.analytics?.tasks?.currentCount).toBeGreaterThan(0);
  expect(dataset.analytics?.tasks?.archivedCount).toBeGreaterThan(0);
  expect(dataset.analytics?.tasks?.pullRequests.total).toBeGreaterThan(0);
  expect(dataset.analytics?.tasks?.diffStats.linesAdded).toBeGreaterThan(0);

  const sum = <K extends "totalTokens" | "cachedInputTokens">(key: K) =>
    dataset.daily.reduce((total, day) => total + day.localTokens[key], 0);
  expect(dataset.summary.localKnownTokens).toBe(sum("totalTokens"));
  expect(dataset.summary.cachedInputTokens).toBe(sum("cachedInputTokens"));
  expect(dataset.summary.estimatedCostUsd).toBeCloseTo(
    dataset.daily.reduce((total, day) => total + day.estimatedCostUsd, 0),
    8,
  );
  expect(dataset.weekly.reduce((total, week) => total + week.localTokens.totalTokens, 0)).toBe(
    dataset.summary.localKnownTokens,
  );
  expect(
    dataset.daily.some(
      (day) =>
        day.localTokens.inputTokens - day.localTokens.cachedInputTokens > 0 &&
        day.localTokens.outputTokens - day.localTokens.reasoningOutputTokens > 0 &&
        day.localTokens.reasoningOutputTokens > 0,
    ),
  ).toBe(true);

  const payments = paymentMonthTotals(dataset.payments);
  expect(Object.keys(payments).at(0)).toBe("2025-12");
  expect(payments).toEqual({
    "2025-12": 24,
    "2026-01": 24,
    "2026-02": 100,
    "2026-03": 100,
    "2026-04": 100,
    "2026-05": 200,
    "2026-06": 200,
  });
  expect(dataset.payments.sources.map((source) => source.kind)).toEqual(["api", "json"]);
  expect(Object.keys(dataset.payments.overrides)).toContain("2026-06");
  const roi = buildRoiMetrics(dataset.daily, payments, "2025-12-01", "2026-06-30");
  expect(
    roi.monthly
      .filter((month) => month.month <= "2026-02")
      .every((month) => month.status === "negative"),
  ).toBe(true);
  expect(
    roi.monthly
      .filter((month) => month.month >= "2026-03")
      .every((month) => month.status === "positive"),
  ).toBe(true);
  expect(roi.monthly).toHaveLength(7);
  expect(roi.monthly[0]).toMatchObject({
    month: "2025-12",
    estimatedApiValue: 0,
    status: "negative",
  });
  expect(roi.monthly.slice(1).every((month) => month.estimatedApiValue > 0)).toBe(true);
  expect(roi.monthly.at(-1)?.conventionalRoiPercent).toBeGreaterThan(100);
  expect(roi.monthly.find((month) => month.month === "2026-04")?.estimatedApiValue).toBeGreaterThan(
    900,
  );
  expect(roi.monthly.find((month) => month.month === "2026-05")?.estimatedApiValue).toBeGreaterThan(
    2_400,
  );
  expect(roi.monthly.find((month) => month.month === "2026-06")?.estimatedApiValue).toBeGreaterThan(
    4_900,
  );

  expect(dataset.themeChoice).toBe("EDM115");
  expect(dataset.availableThemes.length).toBeGreaterThan(20);
  const html = renderReportHtml(dataset);
  for (const marker of [
    "Usage breakdown",
    "Return on investment",
    "Overall mode mix",
    "Input details",
    "Output details",
    "Models",
    "Skills &amp; plugins",
    "Surfaces",
    "Cloud tasks (current snapshot)",
    "Portable sources",
  ]) {
    expect(html).toContain(marker);
  }
  expect(html).toContain("2025-12");
  expect(html).toContain("2026-06");

  for (const forbidden of [
    /C:\\\\Users\\\\/i,
    /access[_-]?token/i,
    /refresh[_-]?token/i,
    /account[_-]?id/i,
    /invoice[_-]?(?:id|url)/i,
    /auth\.json/i,
    /sk-[a-z0-9_-]+/i,
    /@[a-z0-9.-]+\.[a-z]{2,}/i,
  ]) {
    expect(serialized).not.toMatch(forbidden);
  }
});
