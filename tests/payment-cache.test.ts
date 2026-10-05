import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayments, paymentMonthTotals } from "../src/payments";

const auth = { accountId: "private-account", accessToken: "private-token", sourceHome: "test" };
const payload = {
  transactions: [
    {
      type: "credit_purchase",
      id: "private-id",
      status: "paid",
      currency: "USD",
      amount: 1000,
      created_at: "2026-10-01T00:00:00Z",
    },
  ],
  next_cursor: null,
};

test("payment cache reuses complete history for seven days, scopes account and base URL, refreshes and reapplies overrides", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "payment-cache-"));
  let requests = 0;
  const options = {
    auth,
    noApi: false,
    baseUrl: "https://example.test/backend-api",
    cacheDir,
    now: Date.now(),
    fetchImpl: async () => {
      requests++;
      return Response.json(payload);
    },
  };
  await loadPayments(options);
  const override = join(cacheDir, "override.json");
  writeFileSync(override, JSON.stringify({ "2026-10": 0 }));
  const cached = await loadPayments({ ...options, paymentsJson: override, now: options.now + 100 });
  expect(requests).toBe(1);
  expect(cached.diagnostics.cacheHit).toBe(true);
  expect(paymentMonthTotals(cached)).toEqual({ "2026-10": 0 });
  const files = readdirSync(cacheDir).filter((name) => name.startsWith("payments-"));
  expect(files).toHaveLength(1);
  expect(files[0]).toStartWith("payments-v1-");
  const stored = readFileSync(join(cacheDir, files[0]!), "utf8");
  expect(JSON.parse(stored).version).toBe(1);
  for (const secret of [auth.accountId, auth.accessToken, "private-id"])
    expect(stored).not.toContain(secret);
  expect(paymentMonthTotals(await loadPayments(options))).toEqual({ "2026-10": 10 });
  await loadPayments({ ...options, now: options.now + 6 * 86400000 });
  expect(requests).toBe(1);
  await loadPayments({ ...options, now: options.now + 7 * 86400000 });
  await loadPayments({ ...options, refreshCache: true });
  await loadPayments({ ...options, auth: { ...auth, accountId: "different-account" } });
  await loadPayments({ ...options, baseUrl: "https://other.test" });
  expect(requests).toBe(5);
  await loadPayments({ ...options, noApi: true });
  expect(requests).toBe(5);
});

test("failed payment requests are never cached and malformed caches are ignored", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "payment-cache-errors-"));
  let requests = 0;
  const options = {
    auth,
    noApi: false,
    baseUrl: "https://example.test",
    cacheDir,
    fetchImpl: async () => {
      requests++;
      return requests === 1 ? new Response("error", { status: 500 }) : Response.json(payload);
    },
  };
  await loadPayments(options);
  expect(readdirSync(cacheDir)).toHaveLength(0);
  await loadPayments(options);
  const file = join(cacheDir, readdirSync(cacheDir)[0]!);
  writeFileSync(file, '{"version":1,"savedAt":999999999999999,"history":{"transactions":[]}}');
  const recovered = await loadPayments(options);
  expect(recovered.complete).toBe(true);
  expect(requests).toBe(3);
});

test("payment histories refresh at the renewal day within a seven-day cache window", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "payment-renewal-"));
  let requests = 0;
  const options = {
    auth,
    noApi: false,
    baseUrl: "https://example.test",
    cacheDir,
    now: Date.parse("2026-10-03T12:00:00Z"),
    fetchImpl: async () => {
      requests++;
      return Response.json({
        transactions: [
          {
            ...payload.transactions[0],
            created_at: "2026-09-05T12:00:00Z",
            product: { type: "subscription" },
          },
        ],
        next_cursor: null,
      });
    },
  };
  const first = await loadPayments(options);
  await loadPayments({ ...options, now: Date.parse("2026-10-04T23:59:59Z") });
  expect(requests).toBe(1);
  await loadPayments({ ...options, now: Date.parse("2026-10-05T00:00:00Z") });
  expect(requests).toBe(2);
  await loadPayments({ ...options, now: Date.parse("2026-10-05T01:00:00Z") });
  expect(requests).toBe(2);
  expect(first.transactions[0]?.paidAt).toBe("2026-09-05");
});

test("newer complete imported histories avoid fetching while old, partial and forced histories fetch", async () => {
  let requests = 0;
  const options = {
    auth,
    noApi: false,
    baseUrl: "https://example.test",
    now: Date.parse("2026-10-05T12:00:00Z"),
    fetchImpl: async () => {
      requests++;
      return Response.json(payload);
    },
  };
  const fresh = await loadPayments({ ...options, now: Date.parse("2026-10-02T12:00:00Z") });
  const importedHistories = [{ history: fresh, generatedAt: "2026-10-04T00:00:00Z" }];
  const reused = await loadPayments({ ...options, importedHistories });
  expect(requests).toBe(1);
  expect(reused.diagnostics.importedHistoryHit).toBe(true);
  expect(reused.fetchedAt).toBe(fresh.fetchedAt);
  await loadPayments({ ...options, importedHistories, now: Date.parse("2026-10-09T12:00:00Z") });
  expect(requests).toBe(2);
  await loadPayments({ ...options, importedHistories, refreshCache: true });
  await loadPayments({
    ...options,
    importedHistories: [
      { ...importedHistories[0], history: { ...fresh, complete: false, error: "partial" } },
    ],
  });
  expect(requests).toBe(4);
});

test("month-end renewal clamps the payment day and fresh imported sources beat older caches", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "payment-month-end-"));
  let requests = 0;
  const options = {
    auth,
    noApi: false,
    baseUrl: "https://example.test",
    cacheDir,
    now: Date.parse("2026-02-25T12:00:00Z"),
    fetchImpl: async () => {
      requests++;
      return Response.json({
        transactions: [
          {
            ...payload.transactions[0],
            created_at: "2026-01-31T12:00:00Z",
            product: { type: "subscription" },
          },
        ],
        next_cursor: null,
      });
    },
  };
  await loadPayments(options);
  await loadPayments({ ...options, now: Date.parse("2026-02-27T12:00:00Z") });
  expect(requests).toBe(1);
  await loadPayments({ ...options, now: Date.parse("2026-02-28T00:00:00Z") });
  expect(requests).toBe(2);
  const newer = await loadPayments({
    ...options,
    now: Date.parse("2026-02-28T12:00:00Z"),
    cacheDir: undefined,
  });
  const result = await loadPayments({
    ...options,
    now: Date.parse("2026-03-01T00:00:00Z"),
    importedHistories: [{ history: newer, generatedAt: "2026-02-28T12:00:00Z" }],
  });
  expect(result.diagnostics.importedHistoryHit).toBe(true);
  expect(requests).toBe(3);
});

test("imported renewal history refreshes on its due date even if the JSON was generated today", async () => {
  let requests = 0;
  const options = {
    auth,
    noApi: false,
    baseUrl: "https://example.test",
    now: Date.parse("2026-10-03T12:00:00Z"),
    fetchImpl: async () => {
      requests++;
      return Response.json({
        transactions: [
          {
            ...payload.transactions[0],
            created_at: "2026-09-05T12:00:00Z",
            product: { type: "subscription" },
          },
        ],
        next_cursor: null,
      });
    },
  };
  const history = await loadPayments(options);
  const importedHistories = [{ history, generatedAt: "2026-10-05T12:00:00Z" }];
  await loadPayments({ ...options, now: Date.parse("2026-10-05T12:00:00Z"), importedHistories });
  expect(requests).toBe(2);
});

test("legacy imported histories use generation time but monthly overrides alone do not replace API history", async () => {
  let requests = 0;
  const options = {
    auth,
    noApi: false,
    baseUrl: "https://example.test",
    now: Date.parse("2026-10-05T12:00:00Z"),
    fetchImpl: async () => {
      requests++;
      return Response.json(payload);
    },
  };
  const history = await loadPayments(options);
  delete history.fetchedAt;
  const reused = await loadPayments({
    ...options,
    importedHistories: [{ history, generatedAt: "2026-10-04T12:00:00Z" }],
  });
  expect(requests).toBe(1);
  expect(reused.fetchedAt).toBe("2026-10-04T12:00:00.000Z");
  const overrideHistory = await loadPayments({
    ...options,
    paymentsJson: paymentOverrides(),
    noApi: true,
  });
  await loadPayments({
    ...options,
    importedHistories: [{ history: overrideHistory, generatedAt: "2026-10-04T12:00:00Z" }],
  });
  expect(requests).toBe(2);
});

function paymentOverrides() {
  const file = join(mkdtempSync(join(tmpdir(), "payment-overrides-")), "payments.json");
  writeFileSync(file, JSON.stringify({ "2026-10": 20 }));
  return file;
}
