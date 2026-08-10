import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyPaymentHistory,
  loadPayments,
  mergePaymentHistories,
  paymentMonthTotals,
  proratedPaymentAmount,
} from "../src/payments";

function paymentFile(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "codex-payments-"));
  const path = join(root, "payments.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function auth(accountId = "account-1") {
  return {
    accessToken: "secret",
    accountId,
    sourceHome: "C:\\Users\\test\\.codex",
  };
}

test("loadPayments paginates paid USD transactions and lets user months override API totals", async () => {
  const paymentsJson = paymentFile({ "2026-06": 24, "2026-07": 119.87 });
  const requested: string[] = [];
  const pages = [
    {
      transactions: [
        {
          type: "invoice",
          id: "invoice-a",
          created_at: "2026-06-04T16:21:29Z",
          amount: 2400,
          currency: "usd",
          status: "paid",
        },
        {
          type: "invoice",
          id: "invoice-unpaid",
          created_at: "2026-06-05T16:21:29Z",
          amount: 500,
          currency: "usd",
          status: "open",
        },
      ],
      next_cursor: "cursor value",
    },
    {
      transactions: [
        {
          type: "invoice",
          id: "invoice-b",
          created_at: "2026-07-04T16:21:22Z",
          amount: 2400,
          currency: "USD",
          status: "paid",
        },
      ],
      next_cursor: null,
    },
  ];

  const history = await loadPayments({
    paymentsJson,
    noApi: false,
    baseUrl: "https://chatgpt.com/backend-api/",
    auth: auth(),
    fetchImpl: async (input) => {
      requested.push(String(input));
      return new Response(JSON.stringify(pages[requested.length - 1]), { status: 200 });
    },
  });

  expect(requested).toEqual([
    "https://chatgpt.com/backend-api/payments/transaction-history?account_id=account-1&limit=10",
    "https://chatgpt.com/backend-api/payments/transaction-history?account_id=account-1&limit=10&cursor=cursor+value",
  ]);
  expect(history.transactions).toHaveLength(2);
  expect(history.transactions.every((row) => /^[0-9a-f]{64}$/.test(row.fingerprint))).toBe(true);
  expect(history.endpoint).toBe("/payments/transaction-history");
  expect(JSON.stringify(history)).not.toContain("invoice-a");
  expect(JSON.stringify(history)).not.toContain("secret");
  expect(JSON.stringify(history)).not.toContain("account-1");
  expect(JSON.stringify(history)).not.toContain("cursor value");
  expect(paymentMonthTotals(history)).toEqual({ "2026-06": 24, "2026-07": 119.87 });
  expect(history.diagnostics).toEqual({
    pages: 2,
    skippedTransactions: 1,
    duplicateTransactions: 0,
    repeatedCursor: false,
  });
  expect(history.complete).toBe(true);
});

test("loadPayments rejects invalid explicit JSON roots and values", async () => {
  for (const value of [
    [],
    "valid JSON but not a payment object",
    { "2026-13": 24 },
    { "2026-06": -1 },
    { "2026-06": "24" },
    { "2026-06": Number.NaN },
  ]) {
    await expect(
      loadPayments({
        paymentsJson: paymentFile(value),
        noApi: true,
        baseUrl: "https://chatgpt.com/backend-api",
        auth: null,
      }),
    ).rejects.toThrow();
  }
});

test("loadPayments keeps explicit zero overrides", async () => {
  const history = await loadPayments({
    paymentsJson: paymentFile({ "2026-06": 0 }),
    noApi: true,
    baseUrl: "https://chatgpt.com/backend-api",
    auth: null,
  });

  expect(paymentMonthTotals(history)).toEqual({ "2026-06": 0 });
  expect(history.sources).toEqual([{ kind: "json", label: "payments.json", status: "complete" }]);
});

test("loadPayments reports missing account IDs without fetching", async () => {
  let fetched = false;
  const history = await loadPayments({
    noApi: false,
    baseUrl: "https://chatgpt.com/backend-api",
    auth: { accessToken: "secret", sourceHome: "C:\\Users\\test\\.codex" },
    fetchImpl: async () => {
      fetched = true;
      return new Response("{}");
    },
  });

  expect(fetched).toBe(false);
  expect(history.complete).toBe(false);
  expect(history.fetched).toBe(false);
  expect(history.error).toContain("account ID");
  expect(history.sources).toEqual([
    { kind: "api", label: "transaction history", status: "unavailable" },
  ]);
});

test("loadPayments turns HTTP and malformed-payload failures into bounded non-fatal history", async () => {
  const http = await loadPayments({
    noApi: false,
    baseUrl: "https://chatgpt.com/backend-api",
    auth: auth(),
    fetchImpl: async () =>
      new Response(
        `invoice in_secret https://invoice.stripe.com/i/private cursor-secret ${"x".repeat(500)}`,
        { status: 500, statusText: "Internal Server Error" },
      ),
  });
  expect(http.complete).toBe(false);
  expect(http.fetched).toBe(true);
  expect(http.error?.length).toBeLessThanOrEqual(240);
  expect(http.sources[0]?.status).toBe("unavailable");
  expect(JSON.stringify(http)).not.toContain("in_secret");
  expect(JSON.stringify(http)).not.toContain("invoice.stripe.com");
  expect(JSON.stringify(http)).not.toContain("cursor-secret");

  const malformed = await loadPayments({
    noApi: false,
    baseUrl: "https://chatgpt.com/backend-api",
    auth: auth(),
    fetchImpl: async () => new Response(JSON.stringify({ transactions: "nope" })),
  });
  expect(malformed.complete).toBe(false);
  expect(malformed.sources[0]?.status).toBe("unavailable");
  expect(malformed.error).toContain("transactions");
});

test("loadPayments stops repeated cursors and retains the known partial page", async () => {
  let calls = 0;
  const history = await loadPayments({
    noApi: false,
    baseUrl: "https://chatgpt.com/backend-api",
    auth: auth(),
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          transactions: [
            {
              id: `invoice-${calls}`,
              created_at: "2026-06-04T16:21:29Z",
              amount: 2400,
              currency: "usd",
              status: "paid",
            },
          ],
          next_cursor: "again",
        }),
      );
    },
  });

  expect(calls).toBe(2);
  expect(history.transactions).toHaveLength(2);
  expect(history.complete).toBe(false);
  expect(history.diagnostics.repeatedCursor).toBe(true);
  expect(history.sources[0]?.status).toBe("partial");
});

test("loadPayments deduplicates IDs and skips invalid payment facts", async () => {
  const history = await loadPayments({
    noApi: false,
    baseUrl: "https://chatgpt.com/backend-api",
    auth: auth(),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          transactions: [
            {
              id: "duplicate",
              created_at: "2026-06-04T16:21:29Z",
              amount: 2400,
              currency: "usd",
              status: "paid",
            },
            {
              id: "duplicate",
              created_at: "2026-06-04T16:21:29Z",
              amount: 2400,
              currency: "usd",
              status: "paid",
            },
            {
              id: "eur",
              created_at: "2026-06-04T16:21:29Z",
              amount: 2400,
              currency: "eur",
              status: "paid",
            },
            {
              id: "bad-date",
              created_at: "not-a-date",
              amount: 2400,
              currency: "usd",
              status: "paid",
            },
            {
              id: "zero",
              created_at: "2026-06-04T16:21:29Z",
              amount: 0,
              currency: "usd",
              status: "paid",
            },
            {
              id: "fractional",
              created_at: "2026-06-04T16:21:29Z",
              amount: 24.5,
              currency: "usd",
              status: "paid",
            },
          ],
          next_cursor: null,
        }),
      ),
  });

  expect(history.transactions).toHaveLength(1);
  expect(history.diagnostics.duplicateTransactions).toBe(1);
  expect(history.diagnostics.skippedTransactions).toBe(4);
});

test("mergePaymentHistories deduplicates facts and applies first-import then current override precedence", () => {
  const first = emptyPaymentHistory();
  first.transactions = [{ fingerprint: "a".repeat(64), month: "2026-06", amountUsd: 24 }];
  first.overrides = { "2026-06": 30, "2026-07": 31 };
  first.sources = [{ kind: "json", label: "first.json", status: "complete" }];

  const second = emptyPaymentHistory();
  second.transactions = [
    { fingerprint: "a".repeat(64), month: "2026-06", amountUsd: 24 },
    { fingerprint: "b".repeat(64), month: "2026-08", amountUsd: 12 },
  ];
  second.overrides = { "2026-06": 99, "2026-08": 18 };

  const current = emptyPaymentHistory();
  current.overrides = { "2026-07": 0, "2026-08": 42 };

  const merged = mergePaymentHistories([first, second], current);
  expect(merged.transactions).toHaveLength(2);
  expect(paymentMonthTotals(merged)).toEqual({ "2026-06": 30, "2026-07": 0, "2026-08": 42 });
  expect(merged.diagnostics.duplicateTransactions).toBe(1);
});

test("mergePaymentHistories lets a current complete API snapshot supersede older API failure metadata", () => {
  const stale = emptyPaymentHistory();
  stale.error = "older API failure";
  stale.sources = [{ kind: "api", label: "transaction history", status: "unavailable" }];

  const current = emptyPaymentHistory();
  current.fetched = true;
  current.complete = true;
  current.sources = [{ kind: "api", label: "transaction history", status: "complete" }];
  current.transactions = [{ fingerprint: "c".repeat(64), month: "2026-06", amountUsd: 24 }];

  const merged = mergePaymentHistories([stale], current);
  expect(merged.complete).toBe(true);
  expect(merged.error).toBeUndefined();
  expect(merged.sources).toEqual([
    { kind: "api", label: "transaction history", status: "complete" },
  ]);
});

test("proratedPaymentAmount uses inclusive UTC calendar days", () => {
  expect(proratedPaymentAmount({ "2026-06": 30, "2026-07": 31 }, "2026-06-30", "2026-07-01")).toBe(
    2,
  );
  expect(proratedPaymentAmount({ "2028-02": 29 }, "2028-02-28", "2028-02-29")).toBe(2);
  expect(() => proratedPaymentAmount({}, "2026-07-02", "2026-07-01")).toThrow();
});
