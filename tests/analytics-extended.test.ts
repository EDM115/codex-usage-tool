import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDemoDataset } from "../scripts/generate-demo";
import { filterWhamAnalyticsRange, mergeWhamAnalyticsSnapshots } from "../src/analytics-api";
import { normalizePlanLimitHistory, normalizeToolActivity, normalizeTopChats, recentThreadQueries, topChatTitle } from "../src/analytics-extended";
import { writeOutputs } from "../src/export";
import { renderExtendedChartSvgs } from "../src/render-extended";
import { parseSections, REPORT_SECTIONS } from "../src/sections";

test("--sections composes explicit names and exclusions in order", () => {
  expect(parseSections("all,-chats")).toEqual(REPORT_SECTIONS.filter((section) => section !== "chats"));
  expect(parseSections("-chats")).toEqual(REPORT_SECTIONS.filter((section) => section !== "chats"));
  expect(parseSections("feature,turn,limits-feature")).toEqual(["feature", "turn", "limits-feature"]);
  expect(parseSections("all,-chats,chats")).toContain("chats");
  expect(() => parseSections("all,unknown")).toThrow("Unknown report section unknown");
  expect(() => parseSections("all,,chats")).toThrow("requires section names");
});

test("Plan limit basis points and account caveats survive normalization", () => {
  const history = normalizePlanLimitHistory({
    data_as_of: "2026-09-23T00:00:00Z", coverage_start: "2026-09-01T00:00:00Z", coverage_complete: false, approximate: true, boundary_tolerance_seconds: 60,
    periods: [{ id: "week", window_minutes: 10080, plan_type: "plus", starts_at: "2026-09-21T00:00:00Z", ends_at: "2026-09-28T00:00:00Z", accounting_complete: false, used_basis_points: 570, breakdowns: [{ dimension: "turn_trigger", rows: [{ key: "user_message", basis_points: 440 }] }] }],
  });
  expect(history?.periods[0].usedBasisPoints).toBe(570);
  expect(history?.periods[0].breakdowns?.[0].rows[0].basisPoints).toBe(440);
  expect(history?.coverageComplete).toBe(false);
  expect(history?.approximate).toBe(true);
});

test("local roots and descendants form cross-machine thread usage queries", () => {
  const threads = [
    { threadId: "root", title: "Root", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", archived: false, homeLabel: "laptop" },
    { threadId: "child", title: "Child", createdAt: "2026-09-20T01:00:00Z", updatedAt: "2026-09-22T01:00:00Z", parentThreadId: "root", archived: false, homeLabel: "desktop" },
  ];
  const selected = recentThreadQueries(threads, new Date("2026-09-23T00:00:00Z"));
  expect(selected.queries).toEqual([{ thread_id: "root", created_at: "2026-09-20T00:00:00Z", descendant_thread_ids: ["child"] }]);
  const normalized = normalizeTopChats({ threads: [{ thread_id: "root", data_status: "available", weekly_limit_percent: 29.14, five_hour_limit_percent: 7.5, balance_usage_credits: 0, groups: [] }] }, selected.roots);
  expect(normalized?.chats[0]).toMatchObject({ title: "Root", homeLabel: "laptop", weeklyLimitPercent: 29.14 });
  const manyDescendants = Array.from({ length: 1000 }, (_, index) => ({ ...threads[1], threadId: `child-${index}` }));
  const capped = recentThreadQueries([threads[0], ...manyDescendants], new Date("2026-09-23T00:00:00Z"));
  expect(capped.queries).toEqual([]);
  expect(normalizeTopChats({ threads: [] }, capped.roots)?.chats[0].dataStatus).toBe("unavailable");
});

test("thread usage queries include each thread once when local and saved JSON inputs overlap", () => {
  const root = { threadId: "root", title: "Root", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", archived: false, homeLabel: "local" };
  const child = { threadId: "child", title: "Child", createdAt: "2026-09-20T01:00:00Z", updatedAt: "2026-09-22T01:00:00Z", parentThreadId: "root", archived: false, homeLabel: "local" };
  const savedRoot = { ...root, title: "Updated root", updatedAt: "2026-09-23T00:00:00Z", homeLabel: "saved" };
  const selected = recentThreadQueries([root, child, savedRoot, { ...child, homeLabel: "saved" }]);
  expect(selected.roots).toEqual([savedRoot]);
  expect(selected.queries).toEqual([{ thread_id: "root", created_at: root.createdAt, descendant_thread_ids: ["child"] }]);
});

test("auto-review transcript titles collapse without merging usage rows", () => {
  const prefix = "The following is the Codex agent history whose request action you are assessing";
  expect(topChatTitle(`${prefix}: private request`)).toBe("codex-auto-review");
  expect(topChatTitle("Review task >>> TRANSCRIPT START private transcript")).toBe("codex-auto-review");
  expect(topChatTitle("Ordinary chat")).toBe("Ordinary chat");
});

test("plugin and skill metrics use invocation counts from distinct response fields", () => {
  const plugins = normalizeToolActivity({ data: [{ date: "2026-09-23", plugin_usage_overviews: [{ display_name: "Codex App Tools", invocation_counts: 12 }] }] }, "plugin");
  const skills = normalizeToolActivity({ data: [{ date: "2026-09-23", skill_usage_overviews: [{ skill_name: "using-superpowers", display_name: "Using Superpowers", invocation_counts: 4 }] }] }, "skill");
  expect(plugins?.data[0].rows[0]).toEqual({ key: "Codex App Tools", label: "Codex App Tools", count: 12 });
  expect(skills?.data[0].rows[0]).toEqual({ key: "using-superpowers", label: "Using Superpowers", count: 4 });
});

test("static exports render every available account chart and respect section selection", async () => {
  const dataset = await buildDemoDataset();
  const charts = renderExtendedChartSvgs(dataset, REPORT_SECTIONS);
  expect(charts.map((chart) => chart.name)).toEqual(["usage-feature", "usage-models", "usage-surfaces", "usage-turn", "plugin-activity", "skill-activity", "messages-model", "messages-surface"]);
  expect(charts.every((chart) => chart.svg.startsWith("<svg") && chart.svg.includes("<rect"))).toBe(true);
  expect(renderExtendedChartSvgs(dataset, parseSections("messages-model")).map((chart) => chart.name)).toEqual(["messages-model"]);
});

test("saved WHAM buckets survive later shorter API responses without doubling overlapping days", async () => {
  const analytics = (await buildDemoDataset()).analytics!;
  const recent = { ...analytics, dailyTokenUsageBreakdown: { ...analytics.dailyTokenUsageBreakdown!, data: analytics.dailyTokenUsageBreakdown!.data.slice(-5) }, workspaceUsageCounts: { ...analytics.workspaceUsageCounts!, data: analytics.workspaceUsageCounts!.data.slice(-5) } };
  const saved = { ...analytics, dailyTokenUsageBreakdown: { ...analytics.dailyTokenUsageBreakdown!, data: analytics.dailyTokenUsageBreakdown!.data.slice(-10) }, workspaceUsageCounts: { ...analytics.workspaceUsageCounts!, data: analytics.workspaceUsageCounts!.data.slice(-10) } };
  const merged = mergeWhamAnalyticsSnapshots([recent, saved])!;
  expect(merged.dailyTokenUsageBreakdown?.data).toHaveLength(10);
  expect(merged.workspaceUsageCounts?.data).toHaveLength(10);
  expect(merged.totals.turns).toBe(saved.workspaceUsageCounts.data.reduce((sum, bucket) => sum + Number(bucket.totals.turns), 0));
  const filtered = filterWhamAnalyticsRange(merged, "2026-09-21", "2026-09-23")!;
  expect(filtered.dailyTokenUsageBreakdown?.data.map((bucket) => bucket.date)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
  expect(filtered.workspaceUsageCounts?.data).toHaveLength(3);
});

test("one selected HTML section leaves omitted sections and chat IDs out of the document", async () => {
  const dataset = await buildDemoDataset();
  const out = join(tmpdir(), `codex-usage-one-section-${crypto.randomUUID()}`);
  mkdirSync(out, { recursive: true });
  await writeOutputs(dataset, out, { includePng: false, reportOnly: true, sections: parseSections("trend") });
  const html = readFileSync(join(out, "usage-report.html"), "utf8");
  expect(html).toContain("<h2>Usage trend</h2>");
  expect(html).not.toContain("<h2>Top chats</h2>");
  expect(html).not.toContain("<h2>Usage breakdown</h2>");
  expect(html).not.toContain('<section class="section" hidden>');
  expect(html).not.toContain("demo-chat-001");
});

test("excluding chats removes their titles and IDs from both portable JSON and HTML", async () => {
  const dataset = await buildDemoDataset();
  dataset.local.threads[0].title = "Sensitive sample title";
  dataset.analytics!.topChats!.chats[0].title = "Sensitive sample title";
  const out = join(tmpdir(), `codex-usage-sections-${crypto.randomUUID()}`);
  mkdirSync(out, { recursive: true });
  await writeOutputs(dataset, out, { includePng: false, reportOnly: true, sections: parseSections("all,-chats") });
  const json = readFileSync(join(out, "usage-data.json"), "utf8");
  const html = readFileSync(join(out, "usage-report.html"), "utf8");
  expect(json).not.toContain("Sensitive sample title");
  expect(json).not.toContain("demo-chat-001");
  expect(html).not.toContain("Sensitive sample title");
  expect(html).not.toContain("demo-chat-001");
  expect(html).not.toContain("<h2>Top chats</h2>");
  expect(JSON.parse(json).local.threads).toEqual([]);
  const privateOut = join(tmpdir(), `codex-usage-private-sections-${crypto.randomUUID()}`);
  mkdirSync(privateOut, { recursive: true });
  await writeOutputs(dataset, privateOut, { includePng: false, reportOnly: true, sections: parseSections("all,-chats,-cloud") });
  const privateHtml = readFileSync(join(privateOut, "usage-report.html"), "utf8");
  expect(privateHtml).not.toContain("Build the sample analytics dashboard");
  const privateJson = JSON.parse(readFileSync(join(privateOut, "usage-data.json"), "utf8"));
  expect(privateJson.analytics.tasks).toBeUndefined();

  const prefix = "The following is the Codex agent history whose request action you are assessing";
  dataset.local.threads[0].title = `${prefix}: private request`;
  dataset.analytics!.topChats!.chats[0].title = "Review task >>> TRANSCRIPT START private transcript";
  const normalizedOut = join(tmpdir(), `codex-usage-normalized-chats-${crypto.randomUUID()}`);
  await writeOutputs(dataset, normalizedOut, { includePng: false, reportOnly: true, sections: parseSections("all") });
  const normalizedJson = readFileSync(join(normalizedOut, "usage-data.json"), "utf8");
  const normalizedHtml = readFileSync(join(normalizedOut, "usage-report.html"), "utf8");
  expect(normalizedJson).not.toContain(prefix);
  expect(normalizedJson).not.toContain(">>> TRANSCRIPT START");
  expect(normalizedHtml).not.toContain("private request");
  expect(normalizedHtml).not.toContain("private transcript");
  expect(JSON.parse(normalizedJson).local.threads[0].title).toBe("codex-auto-review");
  expect(JSON.parse(normalizedJson).analytics.topChats.chats[0].title).toBe("codex-auto-review");
});
