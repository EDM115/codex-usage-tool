import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as analyticsApi from "../src/analytics-api";
import * as paymentsApi from "../src/payments";
import { emptyPaymentHistory, loadPayments, mergePaymentHistories, paymentMonthTotals } from "../src/payments";
import type { WhamAnalytics, PaymentHistory } from "../src/types";

function analytics(accountId: string, credits: number, date = "2026-10-01"): WhamAnalytics {
  return {
    accountId, fetched: true, endpoints: {},
    usage: { planType: accountId, rateLimit: { primaryUsedPercent: credits } },
    dailyTokenUsageBreakdown: { data: [{ date, productSurfaceUsageValues: { cli: credits }, models: [{ model: "test", credits }] }] },
    workspaceUsageCounts: { data: [{ date, totals: { credits, turns: credits, users: 1, text_total_tokens: credits * 10 }, clients: [{ client_id: "cli", credits, turns: credits, users: 1 }], models: [] }] },
    pluginUsage: { data: [{ date, rows: [{ key: "plugin", label: "Plugin", count: credits }] }] },
    skillUsage: { data: [{ date, rows: [{ key: "skill", label: "Skill", count: credits }] }] },
    topChats: { chats: [{ threadId: "same-thread", title: "Chat", homeLabel: accountId, dataStatus: "available", fiveHourLimitPercent: credits, weeklyLimitPercent: credits, balanceUsageCredits: credits, groups: [] }] },
    planLimitHistory: { dataAsOf: null, coverageStart: null, coverageComplete: true, approximate: false, boundaryToleranceSeconds: null, periods: [{ id: "same-period", windowMinutes: 300, planType: accountId, startsAt: `${date}T00:00:00Z`, endsAt: `${date}T05:00:00Z`, accountingComplete: true, usedBasisPoints: credits * 100, breakdowns: null }] },
    totals: { credits, turns: credits, users: 1, threads: 0, textTotalTokens: credits * 10 },
    byModel: [], byModelVariants: [], bySurface: [], bySource: [],
  };
}

test("WHAM distinct accounts add overlapping days while same-account snapshots retain current precedence", () => {
  const mergeAccounts = (analyticsApi as any).mergeWhamAccounts;
  expect(typeof mergeAccounts).toBe("function");
  const combined = mergeAccounts([analytics("a", 3), analytics("a", 99), analytics("b", 7)]);
  expect(combined.totals).toMatchObject({ credits: 10, turns: 10, users: 2, textTotalTokens: 100 });
  expect(combined.dailyTokenUsageBreakdown.data).toHaveLength(1);
  expect(combined.dailyTokenUsageBreakdown.data[0].models).toEqual([{ model: "test", credits: 10 }]);
  expect(combined.pluginUsage.data[0].rows[0].count).toBe(10);
  expect(combined.skillUsage.data[0].rows[0].count).toBe(10);
  expect(combined.usage).toBeUndefined();
  expect(combined.planLimitHistory).toBeUndefined();
  expect(combined.topChats.chats.map((chat: any) => [chat.accountId, chat.fiveHourLimitPercent])).toEqual([["a", 3], ["b", 7]]);
  expect(combined.accounts.map((account: any) => [account.accountId, account.usage.planType, account.planLimitHistory.periods[0].usedBasisPoints])).toEqual([["a", "a", 300], ["b", "b", 700]]);
  expect(combined.accounts.every((account: any) => account.accounts === undefined)).toBe(true);
});

test("WHAM snapshot merges and range filters preserve account scope and account-specific limits", () => {
  const combined = analyticsApi.mergeWhamAnalyticsSnapshots([analytics("a", 3), analytics("b", 7)])!;
  expect(combined.totals.credits).toBe(10);
  const saved = analytics("a", 2, "2026-09-30");
  const merged = analyticsApi.mergeWhamAnalyticsSnapshots([combined, saved])!;
  const filtered = analyticsApi.filterWhamAnalyticsRange(merged, "2026-10-01", "2026-10-01")!;
  expect(filtered.totals.credits).toBe(10);
  expect(filtered.accounts?.map((account) => [account.accountId, account.totals.credits])).toEqual([["a", 3], ["b", 7]]);
  const single = analyticsApi.filterWhamAnalyticsRange(analytics("a", 3), "2026-10-01", null)!;
  expect(single.accountId).toBe("a");
  expect(single.usage?.rateLimit?.primaryUsedPercent).toBe(3);
});

function payment(accountId: string, fetchedAt: string, subscription = false): PaymentHistory {
  return { ...emptyPaymentHistory(), accountId, fetched: true, complete: true, fetchedAt, endpoint: "/payments/transaction-history", sources: [{ kind: "api", label: "transaction history", status: "complete" }], transactions: [{ accountId, fingerprint: "a".repeat(64), month: "2026-09", amountUsd: 10, paidAt: "2026-09-05", subscription }] };
}

test("payment invoices deduplicate within accounts and preserve matching invoice hashes in different accounts", () => {
  const a = payment("a", "2026-10-01T00:00:00Z");
  const b = payment("b", "2026-10-04T00:00:00Z");
  const combined = mergePaymentHistories([a, a, b]);
  expect(combined.transactions).toHaveLength(2);
  expect(paymentMonthTotals(combined)).toEqual({ "2026-09": 20 });
  expect(combined.accounts?.map((account) => [account.accountId, account.fetchedAt])).toEqual([["a", a.fetchedAt], ["b", b.fetchedAt]]);
  const override = emptyPaymentHistory();
  override.overrides = { "2026-09": 30 };
  expect(paymentMonthTotals(mergePaymentHistories([combined, combined], override))).toEqual({ "2026-09": 30 });
});

test("merged payment status retains reuse evidence only when all fetched accounts reused history", () => {
  const a = payment("a", "2026-10-01T00:00:00Z");
  const b = payment("b", "2026-10-04T00:00:00Z");
  a.diagnostics.importedHistoryHit = true;
  b.diagnostics.importedHistoryHit = true;
  expect(mergePaymentHistories([a]).diagnostics.importedHistoryHit).toBe(true);
  expect(mergePaymentHistories([a, b]).diagnostics.importedHistoryHit).toBe(true);
  delete b.diagnostics.importedHistoryHit;
  expect(mergePaymentHistories([a, b]).diagnostics.importedHistoryHit).not.toBe(true);
});

test("a complete current payment snapshot only clears failure metadata for its own account", () => {
  const failed = { ...payment("b", "2026-10-01T00:00:00Z"), complete: false, error: "account b failure", sources: [{ kind: "api" as const, label: "transaction history", status: "unavailable" as const }] };
  const combined = mergePaymentHistories([failed], payment("a", "2026-10-04T00:00:00Z"));
  expect(combined.complete).toBe(false);
  expect(combined.error).toContain("account b failure");
});

test("payment imports match account scope, and multi-account imports cannot renew an older account's freshness", async () => {
  const auth = { accountId: "a", accessToken: "synthetic", sourceHome: "test" };
  const options = { auth, noApi: false, baseUrl: "https://example.test", now: Date.parse("2026-10-05T00:00:00Z"), allowUnscopedImportedHistory: false, fetchImpl: async () => Response.json({ transactions: [{ id: "synthetic", status: "paid", currency: "USD", amount: 1500, created_at: "2026-10-01T00:00:00Z" }], next_cursor: null }) };
  const mismatched = await loadPayments({ ...options, importedHistories: [{ history: payment("b", "2026-10-04T00:00:00Z"), generatedAt: "2026-10-05T00:00:00Z" }] });
  expect(paymentMonthTotals(mismatched)).toEqual({ "2026-10": 15 });
  const scope = (paymentsApi as any).paymentAccountScope;
  expect(typeof scope).toBe("function");
  expect(mismatched.accountId).toBe(scope("a"));
  expect(mismatched.transactions[0]?.accountId).toBe(scope("a"));
  expect(JSON.stringify(mismatched)).not.toContain('"accountId":"a"');
  const unscoped = payment("a", "2026-10-04T00:00:00Z");
  delete unscoped.accountId;
  delete unscoped.transactions[0]!.accountId;
  const rejected = await loadPayments({ ...options, importedHistories: [{ history: unscoped, generatedAt: "2026-10-05T00:00:00Z" }] });
  expect(paymentMonthTotals(rejected)).toEqual({ "2026-10": 15 });
  const combined = mergePaymentHistories([payment(scope("a"), "2026-10-03T00:00:00Z", true), payment(scope("b"), "2026-10-04T00:00:00Z")]);
  const renewed = await loadPayments({ ...options, importedHistories: [{ history: combined, generatedAt: "2026-10-05T00:00:00Z" }] });
  expect(paymentMonthTotals(renewed)).toEqual({ "2026-10": 15 });
  const reused = await loadPayments({ ...options, auth: { ...auth, accountId: "b" }, importedHistories: [{ history: combined, generatedAt: "2026-10-05T00:00:00Z" }] });
  expect(reused.diagnostics.importedHistoryHit).toBe(true);
  expect(reused.fetchedAt).toBe("2026-10-04T00:00:00.000Z");
  expect(paymentMonthTotals(reused)).toEqual({ "2026-09": 10 });
});

test("analytics JSON retains explicit account provenance", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "scoped-analytics-")), "analytics.json");
  writeFileSync(path, JSON.stringify(analytics("a", 3)));
  const loaded = await analyticsApi.loadWhamAnalytics({ analyticsJson: path, noApi: true, baseUrl: "https://example.test", auth: null, from: null, to: null });
  expect(loaded?.accountId).toBe("a");
  expect(loaded?.usage?.rateLimit?.primaryUsedPercent).toBe(3);
});

test("combined analytics JSON reloads individual account limits and unavailable API results keep their scope", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "combined-analytics-")), "analytics.json");
  writeFileSync(path, JSON.stringify(analyticsApi.mergeWhamAnalyticsSnapshots([analytics("a", 3), analytics("b", 7)])));
  const options = { noApi: true, baseUrl: "https://example.test", auth: null, from: null, to: null };
  const loaded = await analyticsApi.loadWhamAnalytics({ ...options, analyticsJson: path });
  expect(loaded?.accounts?.map((account) => [account.accountId, account.usage?.rateLimit?.primaryUsedPercent])).toEqual([["a", 3], ["b", 7]]);
  const unavailable = await analyticsApi.loadWhamAnalytics({ ...options, auth: { accountId: "a", accessToken: "synthetic", sourceHome: "test" } });
  expect(unavailable?.accountId).toBe("account-ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
});
