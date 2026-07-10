import type { CodexAuthMaterial } from "./auth"
import type { AccountProfileResponse } from "./types"

import { readFileSync } from "node:fs"

import { numberFrom } from "./util"

export type ProfileLoadResult = {
  profile?: AccountProfileResponse
  fetched: boolean
  endpoint?: string
  error?: string
}

export async function loadProfile(options: {
  profileJson?: string
  noApi: boolean
  baseUrl: string
  auth: CodexAuthMaterial | null
}): Promise<ProfileLoadResult> {
  if (options.profileJson) {
    const parsed = JSON.parse(readFileSync(options.profileJson, "utf8"))

    return { profile: normalizeProfile(parsed), fetched: false, endpoint: options.profileJson }
  }

  if (options.noApi) {
    return { fetched: false, error: "API disabled by --no-api" }
  }

  if (!options.auth) {
    return { fetched: false, error: "No auth.json access token found" }
  }

  const endpoint = profileEndpoint(options.baseUrl)

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.auth.accessToken}`,
      "User-Agent": "codex-usage-tool/1.3",
      Accept: "application/json",
    }

    if (options.auth.accountId) {
      headers["ChatGPT-Account-Id"] = options.auth.accountId
    }

    const response = await fetch(endpoint, { headers })
    const text = await response.text()

    if (!response.ok) {
      return {
        fetched: true,
        endpoint,
        error: `Profile API returned ${response.status}: ${text.slice(0, 300)}`,
      }
    }

    return { profile: normalizeProfile(JSON.parse(text)), fetched: true, endpoint }
  } catch (error) {
    return {
      fetched: true,
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function profileEndpoint(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/, "")

  if (
    (normalized.startsWith("https://chatgpt.com") || normalized.startsWith("https://chat.openai.com"))
    && !normalized.includes("/backend-api")
  ) {
    normalized += "/backend-api"
  }

  if (normalized.includes("/backend-api")) {
    return `${normalized}/wham/profiles/me`
  }

  return `${normalized}/api/codex/profiles/me`
}

function normalizeProfile(value: any): AccountProfileResponse {
  const stats = value?.stats ?? value
  const summary = value?.summary ?? stats?.summary ?? stats
  const buckets =
    value?.dailyUsageBuckets ??
    value?.daily_usage_buckets ??
    stats?.daily_usage_buckets ??
    stats?.dailyUsageBuckets ??
    null

  return {
    summary: {
      lifetimeTokens: nullableNumber(summary?.lifetimeTokens ?? summary?.lifetime_tokens),
      peakDailyTokens: nullableNumber(summary?.peakDailyTokens ?? summary?.peak_daily_tokens),
      longestRunningTurnSec: nullableNumber(summary?.longestRunningTurnSec ?? summary?.longest_running_turn_sec),
      currentStreakDays: nullableNumber(summary?.currentStreakDays ?? summary?.current_streak_days),
      longestStreakDays: nullableNumber(summary?.longestStreakDays ?? summary?.longest_streak_days),
    },
    dailyUsageBuckets: Array.isArray(buckets)
      ? buckets.map((bucket: any) => ({
          startDate: String(bucket.startDate ?? bucket.start_date),
          tokens: numberFrom(bucket.tokens),
        }))
      : null,
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }

  return numberFrom(value)
}
