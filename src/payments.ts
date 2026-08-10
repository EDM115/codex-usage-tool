import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { CodexAuthMaterial } from "./auth";
import type { PaymentHistory, PaymentSource, PaymentTransactionFact } from "./types";

const PAYMENT_ENDPOINT = "/payments/transaction-history";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_ERROR_LENGTH = 240;
type PaymentFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export function emptyPaymentHistory(): PaymentHistory {
  return {
    currency: "USD",
    fetched: false,
    complete: false,
    transactions: [],
    overrides: {},
    sources: [],
    diagnostics: {
      pages: 0,
      skippedTransactions: 0,
      duplicateTransactions: 0,
      repeatedCursor: false,
    },
  };
}

export async function loadPayments(options: {
  paymentsJson?: string;
  noApi: boolean;
  baseUrl: string;
  auth: CodexAuthMaterial | null;
  fetchImpl?: PaymentFetch;
}): Promise<PaymentHistory> {
  const history = emptyPaymentHistory();

  if (options.paymentsJson) {
    history.overrides = readPaymentOverrides(options.paymentsJson);
    history.sources.push({
      kind: "json",
      label: basename(options.paymentsJson),
      status: "complete",
    });
  }

  if (options.noApi) {
    return finalizeHistory(history);
  }

  history.endpoint = PAYMENT_ENDPOINT;
  if (!options.auth) {
    return failApi(history, "Payment API unavailable: no Codex authentication was found.", false);
  }
  if (!options.auth.accountId) {
    return failApi(
      history,
      "Payment API unavailable: the Codex authentication has no account ID.",
      false,
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fingerprints = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const params = new URLSearchParams({ account_id: options.auth.accountId, limit: "10" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const url = `${baseUrl}${PAYMENT_ENDPOINT}?${params.toString()}`;

    let response: Response;
    try {
      history.fetched = true;
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.auth.accessToken}`,
          "ChatGPT-Account-Id": options.auth.accountId,
          "User-Agent": "codex-usage-tool",
        },
      });
    } catch (error) {
      return failApi(
        history,
        `Payment API request failed: ${errorMessage(error)}`,
        history.diagnostics.pages > 0,
      );
    }

    if (!response.ok) {
      const statusText = response.statusText.trim();
      const suffix = statusText ? ` ${statusText}` : "";
      return failApi(
        history,
        `Payment API returned HTTP ${response.status}${suffix}`,
        history.diagnostics.pages > 0,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return failApi(
        history,
        `Payment API returned invalid JSON: ${errorMessage(error)}`,
        history.diagnostics.pages > 0,
      );
    }

    if (!isRecord(payload) || !Array.isArray(payload.transactions)) {
      return failApi(
        history,
        "Payment API response has no transactions array.",
        history.diagnostics.pages > 0,
      );
    }
    if (
      payload.next_cursor !== undefined &&
      payload.next_cursor !== null &&
      typeof payload.next_cursor !== "string"
    ) {
      return failApi(
        history,
        "Payment API response has an invalid next_cursor.",
        history.diagnostics.pages > 0,
      );
    }

    history.diagnostics.pages += 1;
    for (const rawTransaction of payload.transactions) {
      const transaction = normalizeTransaction(rawTransaction);
      if (!transaction) {
        history.diagnostics.skippedTransactions += 1;
        continue;
      }
      if (fingerprints.has(transaction.fingerprint)) {
        history.diagnostics.duplicateTransactions += 1;
        continue;
      }
      fingerprints.add(transaction.fingerprint);
      history.transactions.push(transaction);
    }

    const nextCursor =
      typeof payload.next_cursor === "string" && payload.next_cursor
        ? payload.next_cursor
        : undefined;
    if (!nextCursor) {
      history.sources.push({ kind: "api", label: "transaction history", status: "complete" });
      return finalizeHistory(history);
    }
    if (cursors.has(nextCursor)) {
      history.diagnostics.repeatedCursor = true;
      return failApi(history, "Payment API repeated a pagination cursor.", true);
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export function mergePaymentHistories(
  importedHistories: PaymentHistory[],
  currentHistory?: PaymentHistory,
): PaymentHistory {
  const merged = emptyPaymentHistory();
  const histories = currentHistory ? [...importedHistories, currentHistory] : importedHistories;
  const fingerprints = new Set<string>();
  const sourceKeys = new Set<string>();
  const errors = new Set<string>();

  for (const history of histories) {
    merged.fetched ||= history.fetched;
    merged.endpoint =
      currentHistory === history && history.endpoint
        ? history.endpoint
        : (merged.endpoint ?? history.endpoint);
    merged.diagnostics.pages += history.diagnostics.pages;
    merged.diagnostics.skippedTransactions += history.diagnostics.skippedTransactions;
    merged.diagnostics.duplicateTransactions += history.diagnostics.duplicateTransactions;
    merged.diagnostics.repeatedCursor ||= history.diagnostics.repeatedCursor;
    if (history.error) {
      errors.add(history.error);
    }
    for (const source of history.sources) {
      const key = `${source.kind}\u0000${source.label}\u0000${source.status}`;
      if (!sourceKeys.has(key)) {
        sourceKeys.add(key);
        merged.sources.push({ ...source });
      }
    }
    for (const transaction of history.transactions) {
      if (fingerprints.has(transaction.fingerprint)) {
        merged.diagnostics.duplicateTransactions += 1;
        continue;
      }
      fingerprints.add(transaction.fingerprint);
      merged.transactions.push({ ...transaction });
    }
  }

  for (const history of importedHistories) {
    for (const [month, amount] of Object.entries(history.overrides)) {
      if (!Object.hasOwn(merged.overrides, month)) {
        merged.overrides[month] = amount;
      }
    }
  }
  if (currentHistory) {
    Object.assign(merged.overrides, currentHistory.overrides);
  }

  const currentCompleteApi =
    currentHistory?.sources.some(
      (source) => source.kind === "api" && source.status === "complete",
    ) && !currentHistory.error;
  if (currentCompleteApi) {
    merged.sources = merged.sources.filter(
      (source) => source.kind !== "api" || source.status === "complete",
    );
    errors.clear();
  }

  if (errors.size > 0) {
    merged.error = bounded([...errors].join(" "));
  }
  merged.complete =
    merged.sources.length > 0 &&
    merged.sources.every((source) => source.status === "complete") &&
    !merged.error;
  return merged;
}

export function paymentMonthTotals(history: PaymentHistory): Record<string, number> {
  const totals: Record<string, number> = {};
  const fingerprints = new Set<string>();
  for (const transaction of history.transactions) {
    if (fingerprints.has(transaction.fingerprint)) {
      continue;
    }
    fingerprints.add(transaction.fingerprint);
    totals[transaction.month] = roundCurrency(
      (totals[transaction.month] ?? 0) + transaction.amountUsd,
    );
  }
  for (const [month, amount] of Object.entries(history.overrides)) {
    totals[month] = amount;
  }
  return Object.fromEntries(
    Object.entries(totals).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function proratedPaymentAmount(
  monthly: Record<string, number>,
  from: string,
  to: string,
): number {
  const start = parseIsoDay(from);
  const end = parseIsoDay(to);
  if (start.getTime() > end.getTime()) {
    throw new Error(`Payment range start ${from} is after end ${to}.`);
  }

  let amount = 0;
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 86_400_000) {
    const day = new Date(cursor);
    const month = day.toISOString().slice(0, 7);
    const monthlyAmount = monthly[month];
    if (monthlyAmount === undefined) {
      continue;
    }
    const daysInMonth = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0),
    ).getUTCDate();
    amount += monthlyAmount / daysInMonth;
  }
  return amount;
}

function readPaymentOverrides(path: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read payment JSON ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Payment JSON ${path} must contain a root object.`);
  }

  const overrides: Record<string, number> = {};
  for (const [month, amount] of Object.entries(parsed)) {
    if (!MONTH_PATTERN.test(month)) {
      throw new Error(`Payment JSON ${path} contains invalid month ${JSON.stringify(month)}.`);
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`Payment JSON ${path} contains an invalid amount for ${month}.`);
    }
    overrides[month] = amount;
  }
  return overrides;
}

function normalizeTransaction(value: unknown): PaymentTransactionFact | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.status !== "paid" ||
    typeof value.currency !== "string" ||
    value.currency.toUpperCase() !== "USD"
  ) {
    return null;
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    return null;
  }
  if (typeof value.amount !== "number" || !Number.isInteger(value.amount) || value.amount <= 0) {
    return null;
  }
  if (typeof value.created_at !== "string") {
    return null;
  }
  const timestamp = new Date(value.created_at);
  if (!Number.isFinite(timestamp.getTime())) {
    return null;
  }
  return {
    fingerprint: createHash("sha256").update(value.id).digest("hex"),
    month: timestamp.toISOString().slice(0, 7),
    amountUsd: value.amount / 100,
  };
}

function failApi(history: PaymentHistory, message: string, partial: boolean): PaymentHistory {
  const status: PaymentSource["status"] = partial ? "partial" : "unavailable";
  history.error = bounded(message);
  history.sources.push({ kind: "api", label: "transaction history", status });
  return finalizeHistory(history);
}

function finalizeHistory(history: PaymentHistory): PaymentHistory {
  history.complete =
    history.sources.length > 0 &&
    history.sources.every((source) => source.status === "complete") &&
    !history.error;
  return history;
}

function parseIsoDay(value: string): Date {
  if (!DAY_PATTERN.test(value)) {
    throw new Error(`Invalid ISO date ${JSON.stringify(value)}.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ISO date ${JSON.stringify(value)}.`);
  }
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string): string {
  return value.slice(0, MAX_ERROR_LENGTH);
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
