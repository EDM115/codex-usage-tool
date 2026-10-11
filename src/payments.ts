import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { ApiProgressUpdate } from "./progress";
import type { CodexAuthMaterial } from "./auth";
import type { PaymentHistory, PaymentSource, PaymentTransactionFact } from "./types";

const PAYMENT_ENDPOINT = "/payments/transaction-history";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_ERROR_LENGTH = 240;
type PaymentFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

/** Stable report scope that never exposes the raw billing account ID */
export function paymentAccountScope(accountId: string): string {
  return `account-${createHash("sha256").update(accountId).digest("hex")}`;
}

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
  cacheDir?: string;
  refreshCache?: boolean;
  now?: number;
  onRequestProgress?: ApiProgressUpdate;
  importedHistories?: Array<{ history: PaymentHistory; generatedAt: string }>;
  allowUnscopedImportedHistory?: boolean;
}): Promise<PaymentHistory> {
  const history = emptyPaymentHistory();
  const accountScope = options.auth?.accountId ? paymentAccountScope(options.auth.accountId) : undefined;
  history.accountId = accountScope;

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
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const now = options.now ?? Date.now();
  const cachePath =
    options.cacheDir && options.auth?.accountId
      ? join(
          options.cacheDir,
          `payments-v1-${createHash("sha256")
            .update(JSON.stringify([baseUrl, options.auth.accountId]))
            .digest("hex")}.json`,
        )
      : undefined;
  if (!options.refreshCache) {
    const cached = cachePath ? readPaymentCache(cachePath, now) : undefined;
    const imported = (options.importedHistories ?? [])
      .flatMap((source) => paymentAccountHistories(source.history).map((history) => ({ ...source, history })))
      .filter((source) => (accountScope !== undefined && source.history.accountId === accountScope) || (source.history.accountId === undefined && options.allowUnscopedImportedHistory !== false && source.history.transactions.every((transaction) => !transaction.accountId || transaction.accountId === accountScope)))
      .map((source) => ({
        ...source,
        savedAt: Date.parse(source.history.fetchedAt ?? source.generatedAt),
      }))
      .filter((source) => isFreshPaymentHistory(source.history, source.savedAt, now))
      .sort((a, b) => b.savedAt - a.savedAt)[0];
    const useImported = imported && (!cached || imported.savedAt > cached.savedAt);
    const reusable = useImported ? imported : cached;
    if (reusable) {
      const reused = {
        ...reusable.history,
        accountId: accountScope ?? reusable.history.accountId,
        transactions: reusable.history.transactions.map((transaction) => ({ ...transaction, accountId: accountScope ?? transaction.accountId })),
        fetchedAt: new Date(reusable.savedAt).toISOString(),
        overrides: { ...reusable.history.overrides, ...history.overrides },
        sources: [...reusable.history.sources, ...history.sources],
        diagnostics: {
          ...reusable.history.diagnostics,
          cacheHit: !useImported,
          importedHistoryHit: Boolean(useImported),
        },
      };
      if (useImported && cachePath) writePaymentCache(cachePath, reusable.savedAt, reused);
      return finalizeHistory(reused);
    }
  }
  if (!options.auth) {
    return failApi(history, "Payment API unavailable : no Codex authentication was found", false);
  }
  if (!options.auth.accountId) {
    return failApi(
      history,
      "Payment API unavailable : the Codex authentication has no account ID",
      false,
    );
  }
  const fingerprints = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let requestPage = 0;

  while (true) {
    const params = new URLSearchParams({ account_id: options.auth.accountId, limit: "10" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const url = `${baseUrl}${PAYMENT_ENDPOINT}?${params.toString()}`;

    requestPage += 1;
    options.onRequestProgress?.(requestPage - 1, requestPage, [`payments page ${requestPage}`]);
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
        `Payment API request failed : ${errorMessage(error)}`,
        history.diagnostics.pages > 0,
      );
    } finally {
      options.onRequestProgress?.(requestPage, requestPage, []);
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
        `Payment API returned invalid JSON : ${errorMessage(error)}`,
        history.diagnostics.pages > 0,
      );
    }

    if (!isRecord(payload) || !Array.isArray(payload.transactions)) {
      return failApi(
        history,
        "Payment API response has no transactions array",
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
        "Payment API response has an invalid next_cursor",
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
      transaction.accountId = accountScope;
      history.transactions.push(transaction);
    }

    const nextCursor =
      typeof payload.next_cursor === "string" && payload.next_cursor
        ? payload.next_cursor
        : undefined;
    if (!nextCursor) {
      history.sources.push({ kind: "api", label: "transaction history", status: "complete" });
      history.fetchedAt = new Date(now).toISOString();
      const complete = finalizeHistory(history);
      if (cachePath) writePaymentCache(cachePath, now, complete);
      return complete;
    }
    if (cursors.has(nextCursor)) {
      history.diagnostics.repeatedCursor = true;
      return failApi(history, "Payment API repeated a pagination cursor", true);
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export function mergePaymentHistories(
  importedHistories: PaymentHistory[],
  currentHistory?: PaymentHistory,
): PaymentHistory {
  const groups = new Map<string | undefined, { imported: PaymentHistory[]; current?: PaymentHistory }>();
  for (const history of importedHistories.flatMap(paymentAccountHistories)) {
    if (isEmptyPaymentHistory(history)) continue;
    const group = groups.get(history.accountId) ?? { imported: [] };
    group.imported.push(history);
    groups.set(history.accountId, group);
  }
  if (currentHistory) for (const history of paymentAccountHistories(currentHistory)) {
    if (isEmptyPaymentHistory(history)) continue;
    const group = groups.get(history.accountId) ?? { imported: [] };
    group.current = history;
    groups.set(history.accountId, group);
  }
  // Older reports have no account scope. An identical invoice already scoped elsewhere is fallback evidence, not a second payment
  const scopedFingerprints = new Set([...groups.entries()].filter(([accountId]) => accountId !== undefined).flatMap(([, group]) => [...group.imported, ...(group.current ? [group.current] : [])].flatMap((history) => history.transactions.map((transaction) => transaction.fingerprint))));
  const unscoped = groups.get(undefined);
  if (unscoped && scopedFingerprints.size) {
    const trim = (history: PaymentHistory) => ({ ...history, transactions: history.transactions.filter((transaction) => !scopedFingerprints.has(transaction.fingerprint)) });
    unscoped.imported = unscoped.imported.map(trim);
    if (unscoped.current) unscoped.current = trim(unscoped.current);
  }
  const accounts = [...groups.entries()].map(([accountId, group]) => ({ ...mergePaymentAccountSnapshots(group.imported, group.current), accountId }));
  const overrides: Record<string, number> = {};
  for (const history of importedHistories)
    for (const [month, amount] of Object.entries(history.overrides))
      if (!Object.hasOwn(overrides, month)) overrides[month] = amount;
  if (currentHistory) Object.assign(overrides, currentHistory.overrides);
  if (accounts.length <= 1) return { ...(accounts[0] ?? emptyPaymentHistory()), overrides };
  const merged = mergePaymentAccountSnapshots(accounts);
  merged.accounts = accounts;
  merged.overrides = overrides;
  // Freshness belongs to each account. A newer account must not make another account's history fresh
  delete merged.fetchedAt;
  merged.complete = accounts.every((account) => account.complete);
  return merged;
}

function isEmptyPaymentHistory(history: PaymentHistory): boolean {
  return !history.fetched && !history.error && !history.transactions.length && !history.sources.length && !Object.keys(history.overrides).length;
}

function paymentAccountHistories(history: PaymentHistory): PaymentHistory[] {
  if (history.accounts?.length) return history.accounts.flatMap(paymentAccountHistories);
  return [history];
}

function transactionKey(transaction: PaymentTransactionFact, accountId?: string): string {
  return JSON.stringify([transaction.accountId ?? accountId ?? null, transaction.fingerprint]);
}

function mergePaymentAccountSnapshots(
  importedHistories: PaymentHistory[],
  currentHistory?: PaymentHistory,
): PaymentHistory {
  const merged = emptyPaymentHistory();
  const histories = currentHistory ? [...importedHistories, currentHistory] : importedHistories;
  const fingerprints = new Set<string>();
  const sourceKeys = new Set<string>();
  const errors = new Set<string>();
  const reuseSources = currentHistory?.fetched ? [currentHistory] : histories.filter((history) => history.fetched);
  if (reuseSources.length) {
    merged.diagnostics.importedHistoryHit = reuseSources.every((history) => history.diagnostics.importedHistoryHit === true);
    merged.diagnostics.cacheHit = reuseSources.every((history) => history.diagnostics.cacheHit === true);
  }

  for (const history of histories) {
    merged.fetched ||= history.fetched;
    if (
      history.complete &&
      history.fetchedAt &&
      (!merged.fetchedAt || history.fetchedAt > merged.fetchedAt)
    )
      merged.fetchedAt = history.fetchedAt;
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
      const key = transactionKey(transaction, history.accountId);
      if (fingerprints.has(key)) {
        merged.diagnostics.duplicateTransactions += 1;
        const existing = merged.transactions.find(
          (known) => transactionKey(known) === key,
        )!;
        if (transaction.paidAt) existing.paidAt = transaction.paidAt;
        if (transaction.subscription !== undefined)
          existing.subscription = transaction.subscription;
        continue;
      }
      fingerprints.add(key);
      merged.transactions.push({ ...transaction, accountId: transaction.accountId ?? history.accountId });
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
    const key = transactionKey(transaction, history.accountId);
    if (fingerprints.has(key)) {
      continue;
    }
    fingerprints.add(key);
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
    throw new Error(`Payment range start ${from} is after end ${to}`);
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
    throw new Error(`Unable to read payment JSON ${path} : ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Payment JSON ${path} must contain a root object`);
  }

  const overrides: Record<string, number> = {};
  for (const [month, amount] of Object.entries(parsed)) {
    if (!MONTH_PATTERN.test(month)) {
      throw new Error(`Payment JSON ${path} contains invalid month ${JSON.stringify(month)}`);
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`Payment JSON ${path} contains an invalid amount for ${month}`);
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
    paidAt: timestamp.toISOString().slice(0, 10),
    ...(isRecord(value.product) &&
    value.product.type === "subscription" &&
    !value.product.is_seat_purchase
      ? { subscription: true }
      : {}),
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
    throw new Error(`Invalid ISO date ${JSON.stringify(value)}`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ISO date ${JSON.stringify(value)}`);
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

const PAYMENT_CACHE_TTL_MS = 7 * 86_400_000;

function readPaymentCache(
  path: string,
  now: number,
): { history: PaymentHistory; savedAt: number } | undefined {
  try {
    const cached = JSON.parse(readFileSync(path, "utf8"));
    if (
      cached.version !== 1 ||
      typeof cached.savedAt !== "number" ||
      !Number.isFinite(cached.savedAt) ||
      cached.savedAt > now ||
      now - cached.savedAt >= PAYMENT_CACHE_TTL_MS
    )
      return undefined;
    const history = cached.history;
    if (
      !isRecord(history) ||
      history.currency !== "USD" ||
      history.complete !== true ||
      history.fetched !== true ||
      history.endpoint !== PAYMENT_ENDPOINT ||
      history.error ||
      !Array.isArray(history.transactions) ||
      !Array.isArray(history.sources) ||
      history.sources.length !== 1 ||
      history.sources[0]?.kind !== "api" ||
      history.sources[0]?.status !== "complete" ||
      !isRecord(history.diagnostics)
    )
      return undefined;
    if (
      history.fetchedAt !== undefined &&
      (typeof history.fetchedAt !== "string" || !Number.isFinite(Date.parse(history.fetchedAt)))
    )
      return undefined;
    const diagnostics = history.diagnostics;
    if (
      !["pages", "skippedTransactions", "duplicateTransactions"].every(
        (key) =>
          typeof diagnostics[key] === "number" &&
          Number.isInteger(diagnostics[key]) &&
          diagnostics[key] >= 0,
      ) ||
      history.diagnostics.repeatedCursor !== false
    )
      return undefined;
    if (
      !history.transactions.every(
        (row: unknown) =>
          isRecord(row) &&
          typeof row.fingerprint === "string" &&
          /^[0-9a-f]{64}$/.test(row.fingerprint) &&
          typeof row.month === "string" &&
          MONTH_PATTERN.test(row.month) &&
          typeof row.amountUsd === "number" &&
          Number.isFinite(row.amountUsd) &&
          row.amountUsd > 0 &&
          (row.paidAt === undefined ||
            (typeof row.paidAt === "string" &&
              isPaymentDay(row.paidAt) &&
              row.paidAt.slice(0, 7) === row.month)) &&
          (row.subscription === undefined || typeof row.subscription === "boolean"),
      )
    )
      return undefined;
    if (!isFreshPaymentHistory(history as PaymentHistory, cached.savedAt, now)) return undefined;
    return { history: history as PaymentHistory, savedAt: cached.savedAt };
  } catch {
    return undefined;
  }
}

function writePaymentCache(path: string, savedAt: number, history: PaymentHistory): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        version: 1,
        savedAt,
        history: {
          ...history,
          accountId: undefined,
          accounts: undefined,
          transactions: history.transactions.map((transaction) => ({ ...transaction, accountId: undefined })),
          overrides: {},
          sources: history.sources.filter((source) => source.kind === "api"),
        },
      }),
      { mode: 0o600 },
    );
    renameSync(temporaryPath, path);
  } catch {
    // Caching is optional, a write failure must not discard successfully fetched payment evidence
  }
}

function isFreshPaymentHistory(history: PaymentHistory, savedAt: number, now: number): boolean {
  if (
    !Number.isFinite(savedAt) ||
    savedAt > now ||
    now - savedAt >= PAYMENT_CACHE_TTL_MS ||
    !history.complete ||
    history.error ||
    !history.sources.some((source) => source.kind === "api" && source.status === "complete")
  )
    return false;
  if (
    history.transactions.some(
      (transaction) =>
        transaction.paidAt !== undefined &&
        (!isPaymentDay(transaction.paidAt) || transaction.paidAt.slice(0, 7) !== transaction.month),
    )
  )
    return false;
  const paidDates = history.transactions
    .filter((transaction) => transaction.subscription && transaction.paidAt)
    .map((transaction) => parseIsoDay(transaction.paidAt!).getTime())
    .sort((a, b) => b - a);
  if (!paidDates.length) return true;
  const lastPayment = new Date(paidDates[0]!);
  // Repeated annual invoices imply a yearly cadence, otherwise assume the monthly subscription cadence
  const gapMonths =
    paidDates.length > 1
      ? (lastPayment.getUTCFullYear() - new Date(paidDates[1]!).getUTCFullYear()) * 12 +
        lastPayment.getUTCMonth() -
        new Date(paidDates[1]!).getUTCMonth()
      : 1;
  const cadence = gapMonths >= 11 && gapMonths <= 13 ? 12 : 1;
  let monthOffset = cadence;
  while (true) {
    const target = new Date(
      Date.UTC(lastPayment.getUTCFullYear(), lastPayment.getUTCMonth() + monthOffset, 1),
    );
    const lastDay = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
    ).getUTCDate();
    target.setUTCDate(Math.min(lastPayment.getUTCDate(), lastDay));
    if (target.getTime() > savedAt) return now < target.getTime();
    monthOffset += cadence;
  }
}

export function isPaymentDay(value: string): boolean {
  return (
    DAY_PATTERN.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}
