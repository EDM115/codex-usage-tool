import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDemoDataset } from "../scripts/generate-demo";
import { mergeWhamAccounts } from "../src/analytics-api";
import { writeOutputs } from "../src/export";
import { loadUsageDatasets, mergeUsageDatasets, resolvePortableAccountScopes } from "../src/usage-json";
import { loadPricing } from "../src/pricing";
import { emptyPaymentHistory, paymentMonthTotals } from "../src/payments";

const summary = (tokens: number | null) => ({ lifetimeTokens: tokens, peakDailyTokens: tokens, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null });

test("legacy reports from a known single account backfill dates without doubling analytics or invoices", async () => {
  const old = await buildDemoDataset();
  old.codexHomes = [{ path: "/known", label: "known" }];
  old.local.events = [];
  const current = structuredClone(old);
  current.profile = { fetched: true, summary: summary(1000), accounts: [{ accountId: "account-a", sourceHomes: ["/known"], fetched: true, summary: summary(1000), dailyUsageBuckets: [{ startDate: "2026-10-01", tokens: 10 }] }] };
  old.profile = { fetched: true, summary: summary(900) };
  old.daily = [{ ...old.daily[0], date: "2026-09-01", backendTokens: 990, totalTokens: 990 }];
  current.analytics!.accountId = "account-a";
  old.payments = { ...emptyPaymentHistory(), fetched: true, complete: true, fetchedAt: "2026-10-10T00:00:00Z", sources: [{ kind: "api", label: "transaction history", status: "complete" }], transactions: [{ fingerprint: "a".repeat(64), month: "2026-10", amountUsd: 20 }] };
  current.payments = { ...structuredClone(old.payments), accountId: "account-a", transactions: old.payments.transactions.map((transaction) => ({ ...transaction, accountId: "account-a" })) };
  const merged = mergeUsageDatasets([current, old], { from: null, to: null, timezone: old.timezone, pricing: await loadPricing({ source: "bundled" }) });
  expect(merged.daily.filter((day) => day.backendTokens !== undefined).map((day) => [day.date, day.backendTokens])).toEqual([["2026-09-01", 990], ["2026-10-01", 10]]);
  expect(merged.summary.lifetimeTokens).toBe(1000);
  expect(merged.analytics!.totals.credits).toBe(current.analytics!.totals.credits);
  expect(paymentMonthTotals(merged.payments)).toEqual({ "2026-10": 20 });
  old.local.events = undefined;
  const aggregate = mergeUsageDatasets([current, old], { from: null, to: null, timezone: old.timezone });
  expect(aggregate.daily.find((day) => day.date === "2026-09-01")?.backendTokens).toBe(990);
  expect(aggregate.analytics!.totals.credits).toBe(current.analytics!.totals.credits);
});

test("live home ownership cannot manufacture historical payment account identity", async () => {
  const old = await buildDemoDataset();
  old.codexHomes = [{ path: "/known", label: "known" }];
  old.payments = { ...emptyPaymentHistory(), fetched: true, complete: true, fetchedAt: "2026-10-10T00:00:00Z", sources: [{ kind: "api", label: "transaction history", status: "complete" }], transactions: [{ fingerprint: "a".repeat(64), month: "2026-10", amountUsd: 20 }] };
  const [resolved] = resolvePortableAccountScopes([old], [{ homePath: "/known", accountId: "account-a" }]);
  expect(resolved.payments.accountId).toBeUndefined();
  expect(resolved.payments.transactions[0].accountId).toBeUndefined();
  expect(resolved.payments.fetchedAt).toBe(old.payments.fetchedAt);
  expect(old.payments.accountId).toBeUndefined();
  const [ambiguous] = resolvePortableAccountScopes([old], [{ homePath: "/known", accountId: "account-a" }, { homePath: "/known", accountId: "account-b" }]);
  expect(ambiguous.payments.accountId).toBeUndefined();
  expect(ambiguous.authentication?.diagnostics.join(" ")).toContain("unresolved");
});

test("ambiguous legacy coverage preserves older dates and warns without adding overlapping metrics", async () => {
  const old = await buildDemoDataset();
  old.codexHomes = [{ path: "/unknown", label: "unknown" }];
  old.local.events = [];
  const current = structuredClone(old);
  current.codexHomes = [{ path: "/known", label: "known" }];
  current.profile = { fetched: true, summary: summary(1000), accounts: [{ accountId: "account-a", sourceHomes: ["/known"], fetched: true, summary: summary(1000), dailyUsageBuckets: [{ startDate: "2026-10-01", tokens: 10 }] }] };
  old.profile = { fetched: true, summary: summary(900) };
  old.daily = [{ ...old.daily[0], date: "2026-09-01", backendTokens: 990, totalTokens: 990 }];
  current.analytics!.accountId = "account-a";
  const merged = mergeUsageDatasets([current, old], { from: null, to: null, timezone: old.timezone, pricing: await loadPricing({ source: "bundled" }) });
  expect(merged.daily.find((day) => day.date === "2026-09-01")?.backendTokens).toBe(990);
  expect(merged.analytics!.totals.credits).toBe(current.analytics!.totals.credits);
  expect(merged.authentication?.diagnostics.join(" ")).toContain("unresolved");
  old.analytics!.workspaceUsageCounts!.data = [{ ...old.analytics!.workspaceUsageCounts!.data[0], date: "2020-01-01", totals: { credits: 5 } }];
  const historical = mergeUsageDatasets([current, old], { from: null, to: null, timezone: old.timezone, pricing: await loadPricing({ source: "bundled" }) });
  expect(historical.analytics!.totals.credits).toBe(current.analytics!.totals.credits + 5);
  const unavailable = structuredClone(current);
  unavailable.profile = { fetched: true, error: "profile unavailable", summary: summary(null), accounts: [{ accountId: "account-a", sourceHomes: ["/known"], fetched: true, error: "profile unavailable", summary: summary(null) }] };
  const recovered = mergeUsageDatasets([unavailable, old], { from: null, to: null, timezone: old.timezone, pricing: await loadPricing({ source: "bundled" }) });
  expect(recovered.daily.find((day) => day.date === "2026-09-01")?.backendTokens).toBe(990);
  expect(recovered.profile?.error).toContain("profile unavailable");
});

test("aggregate portable reports retain uncovered local usage and add distinct scoped account days", async () => {
  const first = await buildDemoDataset();
  first.local.events = undefined;
  first.codexHomes = [{ path: "/a", label: "a" }];
  first.sources = [];
  first.profile = { fetched: true, summary: summary(100), accounts: [{ accountId: "account-a", sourceHomes: ["/a"], fetched: true, summary: summary(100), dailyUsageBuckets: [{ startDate: "2026-10-01", tokens: 100 }] }] };
  const breakdown = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10 };
  first.daily = [{ ...first.daily[0], date: "2026-10-01", backendTokens: 100, totalTokens: 110, localTokens: breakdown }];
  const second = structuredClone(first);
  second.codexHomes = [{ path: "/b", label: "b" }];
  second.profile = { fetched: true, summary: summary(200), accounts: [{ accountId: "account-b", sourceHomes: ["/b"], fetched: true, summary: summary(200), dailyUsageBuckets: [{ startDate: "2026-10-01", tokens: 200 }] }] };
  second.daily = [{ ...second.daily[0], backendTokens: 200, totalTokens: 210 }];
  const merged = mergeUsageDatasets([first, second], { from: null, to: null, timezone: first.timezone });
  expect(merged.daily[0].backendTokens).toBe(300);
  expect(merged.daily[0].totalTokens).toBe(320);
  expect(merged.summary.lifetimeTokens).toBe(320);
});

test("overlapping aggregate reports keep older local dates absent from the current report", async () => {
  const current = await buildDemoDataset();
  current.local.events = undefined;
  current.profile = undefined;
  current.analytics = undefined;
  current.daily = [{ ...current.daily[0], date: "2026-10-01", backendTokens: undefined }];
  const old = structuredClone(current);
  old.daily = [{ ...old.daily[0], date: "2026-09-01" }, { ...old.daily[0], date: "2026-10-01" }];
  const merged = mergeUsageDatasets([current, old], { from: null, to: null, timezone: current.timezone });
  expect(merged.daily.find((day) => day.date === "2026-09-01")?.localTokens.totalTokens).toBe(old.daily[0].localTokens.totalTokens);
  expect(merged.daily.find((day) => day.date === "2026-10-01")?.localTokens.totalTokens).toBe(current.daily[0].localTokens.totalTokens);
});

test("excluded chat sections remove nested account chat titles from JSON and HTML", async () => {
  const dataset = await buildDemoDataset();
  const snapshot = structuredClone(dataset.analytics!);
  snapshot.topChats!.chats[0].title = "private nested account chat title";
  dataset.analytics = mergeWhamAccounts([{ ...snapshot, accountId: "account-a" }, { ...snapshot, accountId: "account-b" }]);
  const out = mkdtempSync(join(tmpdir(), "usage-account-pruning-"));
  await writeOutputs(dataset, out, { includePng: false, reportOnly: true, sections: ["token"] });
  expect(readFileSync(join(out, "usage-data.json"), "utf8")).not.toContain("private nested account chat title");
  expect(readFileSync(join(out, "usage-report.html"), "utf8")).not.toContain("private nested account chat title");
});

test("portable validation rejects malformed nested account metrics", async () => {
  const dataset = await buildDemoDataset();
  dataset.analytics = mergeWhamAccounts([{ ...dataset.analytics!, accountId: "account-a" }, { ...dataset.analytics!, accountId: "account-b" }]);
  (dataset.analytics!.accounts![0].totals as any).credits = "invalid";
  const path = join(mkdtempSync(join(tmpdir(), "usage-account-validation-")), "bad.json");
  writeFileSync(path, JSON.stringify(dataset));
  expect(() => loadUsageDatasets([path])).toThrow("expected a generated usage-data.json");
});

test("portable validation rejects malformed authentication ownership records", async () => {
  const dataset = await buildDemoDataset();
  dataset.authentication = { homes: [{ homePath: "/home", homeLabel: "home", mode: "chatgpt" }], diagnostics: [] };
  (dataset.authentication.homes[0] as any).mode = "invalid";
  const path = join(mkdtempSync(join(tmpdir(), "usage-authentication-validation-")), "bad.json");
  writeFileSync(path, JSON.stringify(dataset));
  let rejected = false;
  try { loadUsageDatasets([path]); } catch { rejected = true; }
  expect(rejected).toBe(true);
});
