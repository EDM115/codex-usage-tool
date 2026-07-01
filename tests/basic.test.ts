import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildDataset } from "../src/aggregate"
import { loadPricing } from "../src/pricing"
import { renderReportHtml } from "../src/report-html"
import { collectRolloutEvents } from "../src/rollouts"
import { resolveUsageTheme } from "../src/theme"

test("collectRolloutEvents parses token_count breakdowns", () => {
  const root = join(tmpdir(), `codex-usage-test-${Date.now()}`)
  const codexHome = join(root, ".codex")
  const sessions = join(codexHome, "sessions", "2026", "06", "27")
  mkdirSync(sessions, { recursive: true })
  const rollout = join(
    sessions,
    "rollout-2026-06-27T10-00-00-00000000-0000-0000-0000-000000000001.jsonl",
  )
  writeFileSync(
    rollout,
    [
      JSON.stringify({
        timestamp: "2026-06-27T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "00000000-0000-0000-0000-000000000001", model: "gpt-5" },
      }),
      JSON.stringify({
        timestamp: "2026-06-27T08:01:00.000Z",
        type: "turn_context",
        payload: { model: "gpt-5", reasoning_effort: "high" },
      }),
      JSON.stringify({
        timestamp: "2026-06-27T08:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
            model_context_window: 400000,
          },
          rate_limits: { plan_type: "pro" },
        },
      }),
    ].join("\n"),
  )

  const result = collectRolloutEvents({
    homes: [{ path: codexHome, label: "test" }],
    timezone: "Europe/Paris",
    from: null,
    to: null,
  })

  expect(result.events).toHaveLength(1)
  expect(result.events[0].breakdown).toEqual({
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
  })
  expect(result.events[0].model).toBe("gpt-5")
  expect(result.events[0].reasoningEffort).toBe("high")
})

test("buildDataset keeps backend totals authoritative and local details enriched", async () => {
  const pricing = await loadPricing({ source: "bundled" })
  const dataset = buildDataset({
    profileResult: {
      fetched: true,
      endpoint: "fixture",
      profile: {
        summary: {
          lifetimeTokens: 1000,
          peakDailyTokens: 1000,
          currentStreakDays: 1,
          longestStreakDays: 1,
          longestRunningTurnSec: 10,
        },
        dailyUsageBuckets: [{ startDate: "2026-06-27", tokens: 1000 }],
      },
    },
    events: [
      {
        eventId: "e1",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-06-27T08:00:00.000Z",
        date: "2026-06-27",
        model: "gpt-5",
        breakdown: {
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 50,
          reasoningOutputTokens: 20,
          totalTokens: 150,
        },
      },
    ],
    codexHomes: [{ path: "home", label: "home" }],
    sourceMode: "hybrid",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    localStats: { rolloutFiles: 1, sqliteDatabases: 0, sqliteThreads: 0, parseErrors: [] },
    pricing,
    estimateModel: "gpt-5",
    theme: await resolveUsageTheme([]),
  })

  expect(dataset.daily[0].totalTokens).toBe(1000)
  expect(dataset.daily[0].localTokens.totalTokens).toBe(150)
  expect(dataset.daily[0].unattributedTokens).toBe(850)
  expect(dataset.summary.lifetimeTokens).toBe(1000)
})
test("renderHtmlReport emits parseable runtime scripts", async () => {
  const pricing = await loadPricing({ source: "bundled" })
  const dataset = buildDataset({
    profileResult: { fetched: false, error: "offline" },
    events: [
      {
        eventId: "e1",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-06-27T08:00:00.000Z",
        date: "2026-06-27",
        model: "gpt-5",
        breakdown: {
          inputTokens: 100,
          cachedInputTokens: 10,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 120,
        },
      },
    ],
    codexHomes: [{ path: "home", label: "home" }],
    sourceMode: "local",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    localStats: { rolloutFiles: 1, sqliteDatabases: 0, sqliteThreads: 0, parseErrors: [] },
    pricing,
    estimateModel: "gpt-5",
    theme: await resolveUsageTheme([]),
  })

  const html = renderReportHtml(dataset)
  const scripts = [
    ...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g),
  ].map((match) => match[1])
  expect(scripts.length).toBeGreaterThan(0)

  for (const script of scripts) {
    expect(() => new Function(script)).not.toThrow()
  }

  expect(html).toContain("\\nTotal: ")
})
