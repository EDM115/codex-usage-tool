import type { ApiProgressUpdate } from "./progress";
import type { CodexAuthMaterial } from "./auth";
import type { AccountProfileResponse, AccountProfileSnapshot } from "./types";

import { readFileSync } from "node:fs";

import { numberFrom } from "./util";

export type ProfileLoadResult = {
  profile?: AccountProfileResponse;
  fetched: boolean;
  endpoint?: string;
  error?: string;
  accounts?: AccountProfileSnapshot[];
};

export async function loadProfile(options: {
  profileJson?: string;
  noApi: boolean;
  baseUrl: string;
  auth: CodexAuthMaterial | null;
  onRequestProgress?: ApiProgressUpdate;
}): Promise<ProfileLoadResult> {
  if (options.profileJson) {
    const parsed = JSON.parse(readFileSync(options.profileJson, "utf8"));

    return { profile: normalizeProfile(parsed), fetched: false, endpoint: options.profileJson };
  }

  if (options.noApi) {
    return { fetched: false, error: "API disabled by --no-api" };
  }

  if (!options.auth) {
    return { fetched: false, error: "No ChatGPT account credential found" };
  }

  const endpoint = profileEndpoint(options.baseUrl);
  options.onRequestProgress?.(0, 1, ["profile"]);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.auth.accessToken}`,
      "User-Agent": "codex-usage-tool/3.3",
      Accept: "application/json",
    };

    if (options.auth.accountId) {
      headers["ChatGPT-Account-Id"] = options.auth.accountId;
    }

    const response = await fetch(endpoint, { headers });
    const text = await response.text();

    if (!response.ok) {
      return {
        fetched: true,
        endpoint,
        error: `Profile API returned ${response.status} : ${text.slice(0, 300)}`,
      };
    }

    return { profile: normalizeProfile(JSON.parse(text)), fetched: true, endpoint };
  } catch (error) {
    return {
      fetched: true,
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    options.onRequestProgress?.(1, 1, []);
  }
}

// Snapshots from the same account overlap, snapshots from different accounts add
export function mergeProfileAccounts(snapshots: AccountProfileSnapshot[]): ProfileLoadResult {
  const scoped = snapshots.filter((snapshot) => snapshot.accountId);
  const inputs = scoped.length ? scoped : snapshots;
  const groups = new Map<string, AccountProfileSnapshot[]>();
  for (const snapshot of inputs) {
    const key = snapshot.accountId ?? "unscoped";
    groups.set(key, [...(groups.get(key) ?? []), snapshot]);
  }
  const accounts = [...groups.values()].map((group) => {
    const primary = group.find((snapshot) => snapshot.fetched && !snapshot.error) ?? group.find((snapshot) => snapshot.fetched) ?? group[0];
    const days = new Map<string, number>();
    for (const snapshot of [...group].reverse())
      for (const bucket of snapshot.dailyUsageBuckets ?? []) days.set(bucket.startDate, bucket.tokens);
    return { ...primary, sourceHomes: [...new Set(group.flatMap((snapshot) => snapshot.sourceHomes ?? []))], dailyUsageBuckets: days.size ? [...days].sort(([a], [b]) => a.localeCompare(b)).map(([startDate, tokens]) => ({ startDate, tokens })) : primary.dailyUsageBuckets };
  });
  const usable = accounts.filter((account) => account.dailyUsageBuckets !== undefined || account.summary.lifetimeTokens !== null);
  if (!usable.length) return { fetched: accounts.some((account) => account.fetched), error: accounts.map((account) => account.error).filter(Boolean).join(", ") || undefined, accounts };
  const days = new Map<string, number>();
  for (const account of usable)
    for (const bucket of account.dailyUsageBuckets ?? []) days.set(bucket.startDate, (days.get(bucket.startDate) ?? 0) + bucket.tokens);
  const sumNullable = (key: keyof AccountProfileResponse["summary"]) => usable.every((account) => account.summary[key] !== null) ? usable.reduce((sum, account) => sum + account.summary[key]!, 0) : null;
  const maxNullable = (key: keyof AccountProfileResponse["summary"]) => usable.some((account) => account.summary[key] !== null) ? Math.max(...usable.map((account) => account.summary[key] ?? 0)) : null;
  return {
    fetched: accounts.some((account) => account.fetched),
    endpoint: accounts.length === 1 ? accounts[0].endpoint : undefined,
    error: accounts.map((account) => account.error ? `${account.accountId ?? "profile"} : ${account.error}` : "").filter(Boolean).join(", ") || undefined,
    accounts,
    profile: { summary: { lifetimeTokens: sumNullable("lifetimeTokens"), peakDailyTokens: days.size ? Math.max(...days.values()) : maxNullable("peakDailyTokens"), longestRunningTurnSec: maxNullable("longestRunningTurnSec"), currentStreakDays: usable.length === 1 ? usable[0].summary.currentStreakDays : null, longestStreakDays: usable.length === 1 ? usable[0].summary.longestStreakDays : null }, dailyUsageBuckets: days.size ? [...days].sort(([a], [b]) => a.localeCompare(b)).map(([startDate, tokens]) => ({ startDate, tokens })) : null },
  };
}

export function profileSnapshot(result: ProfileLoadResult, accountId?: string, sourceHomes?: string[]): AccountProfileSnapshot {
  return { accountId, sourceHomes, fetched: result.fetched, endpoint: result.endpoint, error: result.error, summary: result.profile?.summary ?? { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: result.profile?.dailyUsageBuckets };
}

function profileEndpoint(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/, "");

  if (
    (normalized.startsWith("https://chatgpt.com") ||
      normalized.startsWith("https://chat.openai.com")) &&
    !normalized.includes("/backend-api")
  ) {
    normalized += "/backend-api";
  }

  if (normalized.includes("/backend-api")) {
    return `${normalized}/wham/profiles/me`;
  }

  return `${normalized}/api/codex/profiles/me`;
}

function normalizeProfile(value: any): AccountProfileResponse {
  const stats = value?.stats ?? value;
  const summary = value?.summary ?? stats?.summary ?? stats;
  const buckets =
    value?.dailyUsageBuckets ??
    value?.daily_usage_buckets ??
    stats?.daily_usage_buckets ??
    stats?.dailyUsageBuckets ??
    null;

  return {
    summary: {
      lifetimeTokens: nullableNumber(summary?.lifetimeTokens ?? summary?.lifetime_tokens),
      peakDailyTokens: nullableNumber(summary?.peakDailyTokens ?? summary?.peak_daily_tokens),
      longestRunningTurnSec: nullableNumber(
        summary?.longestRunningTurnSec ?? summary?.longest_running_turn_sec,
      ),
      currentStreakDays: nullableNumber(summary?.currentStreakDays ?? summary?.current_streak_days),
      longestStreakDays: nullableNumber(summary?.longestStreakDays ?? summary?.longest_streak_days),
    },
    dailyUsageBuckets: Array.isArray(buckets)
      ? buckets.map((bucket: any) => ({
          startDate: String(bucket.startDate ?? bucket.start_date),
          tokens: numberFrom(bucket.tokens),
        }))
      : null,
  };
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return numberFrom(value);
}
