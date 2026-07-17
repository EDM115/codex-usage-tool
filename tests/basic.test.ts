import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildDataset } from "../src/aggregate"
import { loadPricing } from "../src/pricing"
import { buildReportModelRows, renderReportHtml, type ReportModelRow } from "../src/report-html"
import { collectRolloutEvents } from "../src/rollouts"
import { resolveUsageThemes } from "../src/theme"
import { compactNumber, exactNumber, money } from "../src/util"

test("French number formatting uses spaces and decimal commas", () => {
  expect(compactNumber(1_234_567_890)).toBe("1,2 B")
  expect(compactNumber(24_900_000)).toBe("24,9 M")
  expect(exactNumber(1_373_622)).toBe("1 373 622")
  expect(money(1373.6223)).toBe("$ 1 373,62")
  expect(money(8)).toBe("$ 8,00")
})

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

test("collectRolloutEvents follows thread settings model and service tier changes", () => {
  const root = join(tmpdir(), `codex-usage-switch-test-${Date.now()}`)
  const codexHome = join(root, ".codex")
  const sessions = join(codexHome, "sessions", "2026", "07", "10")
  mkdirSync(sessions, { recursive: true })
  const rollout = join(
    sessions,
    "rollout-2026-07-10T08-00-00-00000000-0000-0000-0000-000000000002.jsonl",
  )
  writeFileSync(
    rollout,
    [
      JSON.stringify({
        timestamp: "2026-07-10T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "00000000-0000-0000-0000-000000000002" },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:01:00.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5", reasoning_effort: "xhigh" },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
            last_token_usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:03:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:04:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
            last_token_usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:05:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: {
            model: "gpt-5.6-sol",
            reasoning_effort: "high",
            service_tier: "default",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:06:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 140, output_tokens: 35, total_tokens: 175 },
            last_token_usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:07:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: {
            model: "gpt-5.6-sol",
            reasoning_effort: "high",
            service_tier: "priority",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:08:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 148, output_tokens: 37, total_tokens: 185 },
            last_token_usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          },
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

  expect(result.events.map((event) => [event.model, event.reasoningEffort])).toEqual([
    ["gpt-5.5", "xhigh"],
    ["gpt-5.6-sol", "high"],
    ["gpt-5.6-sol", "high"],
    ["gpt-5.6-sol", "high"],
  ])
  expect(result.events.map((event) => [event.serviceTier, event.serviceTierInferred])).toEqual([
    [undefined, undefined],
    ["default", true],
    ["default", undefined],
    ["priority", undefined],
  ])
})

test("collectRolloutEvents does not let SQLite metadata overwrite rollout state", () => {
  const root = join(tmpdir(), `codex-usage-sqlite-test-${Date.now()}`)
  const codexHome = join(root, ".codex")
  const sessions = join(codexHome, "sessions", "2026", "07", "10")
  mkdirSync(sessions, { recursive: true })
  const threadId = "00000000-0000-0000-0000-000000000003"
  const rollout = join(sessions, `rollout-2026-07-10T09-00-00-${threadId}.jsonl`)
  writeFileSync(
    rollout,
    [
      JSON.stringify({
        timestamp: "2026-07-10T09:00:00.000Z",
        type: "session_meta",
        payload: { id: threadId },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T09:01:00.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5", reasoning_effort: "medium" },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T09:02:00.000Z",
        type: "session_meta",
        payload: { id: threadId },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T09:03:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
            last_token_usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
          },
        },
      }),
    ].join("\n"),
  )
  const database = new Database(join(codexHome, "state_5.sqlite"), { create: true })
  database.run(
    "create table threads (id text, rollout_path text, source text, tokens_used integer, archived integer, model text, reasoning_effort text)",
  )
  database.run("insert into threads values (?, ?, ?, ?, ?, ?, ?)", [
    threadId,
    rollout,
    "vscode",
    100,
    0,
    "gpt-5.6-terra",
    "high",
  ])
  database.close()

  const result = collectRolloutEvents({
    homes: [{ path: codexHome, label: "test" }],
    timezone: "Europe/Paris",
    from: null,
    to: null,
  })

  expect(result.events).toHaveLength(1)
  expect(result.events[0].model).toBe("gpt-5.5")
  expect(result.events[0].reasoningEffort).toBe("medium")
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
    ...resolveUsageThemes([]),
  })

  expect(dataset.daily[0].totalTokens).toBe(1000)
  expect(dataset.daily[0].localTokens.totalTokens).toBe(150)
  expect(dataset.daily[0].unattributedTokens).toBe(850)
  expect(dataset.summary.lifetimeTokens).toBe(1000)
  expect(dataset.themeChoice).toBe("EDM115")
  expect(dataset.availableThemes.slice(0, 2).map((row) => row.id)).toEqual([
    "EDM115",
    "absolutely-dark",
  ])
})

test("buildDataset exposes canonical local model usage and exact costs", async () => {
  const pricing = await loadPricing({ source: "bundled" })
  const dataset = buildDataset({
    profileResult: { fetched: false, error: "offline" },
    events: [
      {
        eventId: "high-default",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-07-10T08:00:00.000Z",
        date: "2026-07-10",
        model: "gpt-5.5",
        reasoningEffort: "high",
        serviceTier: "default",
        breakdown: {
          inputTokens: 80,
          cachedInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 100,
        },
      },
      {
        eventId: "high-default-inferred",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-07-10T08:01:00.000Z",
        date: "2026-07-10",
        model: "gpt-5.5",
        reasoningEffort: "high",
        serviceTier: "default",
        serviceTierInferred: true,
        breakdown: {
          inputTokens: 40,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 2,
          totalTokens: 50,
        },
      },
      {
        eventId: "medium-priority",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-07-10T08:02:00.000Z",
        date: "2026-07-10",
        model: "gpt-5.5",
        reasoningEffort: "medium",
        serviceTier: "priority",
        breakdown: {
          inputTokens: 40,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 2,
          totalTokens: 50,
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
    estimateModel: "gpt-5.6-sol",
    ...resolveUsageThemes([]),
  })
  const model = dataset.local.modelUsage[0]

  expect(model.breakdown.totalTokens).toBe(200)
  expect(model.reasoningEfforts.map((row) => [row.effort, row.breakdown.totalTokens])).toEqual([
    ["high", 150],
    ["medium", 50],
  ])
  expect(model.serviceTiers.map((row) => [row.serviceTier, row.breakdown.totalTokens])).toEqual([
    ["default", 150],
    ["priority", 50],
  ])
  expect(model.serviceTiers[0].inferredTokens).toBe(50)
  expect(model.serviceTiers[0].costUsd).toBeCloseTo(0.0015, 8)
  expect(model.serviceTiers[1].costUsd).toBeCloseTo(0.00125, 8)
  expect(model.reasoningEfforts[0].costUsd).toBeCloseTo(0.0015, 8)
  expect(model.reasoningEfforts[1].costUsd).toBeCloseTo(0.00125, 8)
  expect(model.costUsd).toBeCloseTo(0.00275, 8)
  expect(model.reasoningEfforts.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(
    model.costUsd,
  )
  expect(dataset.local.modelUsage.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(
    dataset.summary.knownLocalCostUsd,
  )

  const dailyModelUsage = (dataset.daily[0] as any).modelUsage
  expect(dailyModelUsage).toHaveLength(1)
  expect(dailyModelUsage[0].model).toBe("gpt-5.5")
  expect(dailyModelUsage[0].breakdown.totalTokens).toBe(200)
  expect(
    dailyModelUsage[0].reasoningEfforts.map((row: any) => [
      row.effort,
      row.breakdown.totalTokens,
    ]),
  ).toEqual([
    ["high", 150],
    ["medium", 50],
  ])
  expect(
    dailyModelUsage[0].serviceTiers.map((row: any) => [
      row.serviceTier,
      row.breakdown.totalTokens,
    ]),
  ).toEqual([
    ["default", 150],
    ["priority", 50],
  ])
  expect(dailyModelUsage[0].costUsd).toBeCloseTo(model.costUsd)
})

test("buildDataset applies long-context prices only with explicit rollout context evidence", async () => {
  const pricing = await loadPricing({ source: "bundled" })
  const dataset = buildDataset({
    profileResult: { fetched: false, error: "offline" },
    events: [
      {
        eventId: "known-long-context",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-07-10T08:00:00.000Z",
        date: "2026-07-10",
        model: "gpt-5.5",
        modelContextWindow: 1_050_000,
        breakdown: {
          inputTokens: 300_000,
          cachedInputTokens: 0,
          outputTokens: 100_000,
          reasoningOutputTokens: 20_000,
          totalTokens: 400_000,
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
    estimateModel: "gpt-5.6-sol",
    ...resolveUsageThemes([]),
  })

  expect(dataset.local.modelUsage[0].costUsd).toBeCloseTo(7.5)
  expect(dataset.daily[0].knownLocalCostUsd).toBeCloseTo(7.5)
})

test("report model rows keep local models authoritative and add cloud enrichment", async () => {
  const pricing = await loadPricing({ source: "bundled" })
  const dataset = buildDataset({
    profileResult: { fetched: false, error: "offline" },
    events: [
      {
        eventId: "local-gpt-5.5",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout-1",
        threadId: "thread-1",
        timestamp: "2026-07-10T08:00:00.000Z",
        date: "2026-07-10",
        model: "gpt-5.5",
        breakdown: {
          inputTokens: 160,
          cachedInputTokens: 0,
          outputTokens: 40,
          reasoningOutputTokens: 10,
          totalTokens: 200,
        },
      },
      {
        eventId: "local-terra",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout-2",
        threadId: "thread-2",
        timestamp: "2026-07-10T09:00:00.000Z",
        date: "2026-07-10",
        model: "gpt-5.6-terra",
        breakdown: {
          inputTokens: 80,
          cachedInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 100,
        },
      },
    ],
    codexHomes: [{ path: "home", label: "home" }],
    sourceMode: "local",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    localStats: { rolloutFiles: 2, sqliteDatabases: 0, sqliteThreads: 0, parseErrors: [] },
    pricing,
    estimateModel: "gpt-5.6-sol",
    ...resolveUsageThemes([]),
    analytics: {
      fetched: true,
      endpoints: {},
      totals: { credits: 10, turns: 20, threads: 3, users: 1, textTotalTokens: 300 },
      byModel: [
        { model: "gpt-5.5", credits: 8, turns: 12, threads: 2, users: 1 },
        { model: "gpt-5.4", credits: 2, turns: 8, threads: 1, users: 1 },
      ],
      byModelVariants: [],
      bySurface: [],
      bySource: [],
    },
  })
  const rows = buildReportModelRows(dataset)
  expect(rows.map((row) => [row.model, row.source])).toEqual([
    ["gpt-5.5", "local+cloud"],
    ["gpt-5.6-terra", "local"],
    ["gpt-5.4", "cloud"],
  ])
  expect(rows[0].turns).toBe(12)
  expect(rows[0].localTokens).toBe(200)
  expect(
    buildReportModelRows({ ...dataset, analytics: undefined }).map((row) => row.model),
  ).toEqual(["gpt-5.5", "gpt-5.6-terra"])
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
    ...resolveUsageThemes([]),
  })
  dataset.generatedAt = "2026-07-10T13:33:11.042Z"

  const html = renderReportHtml(dataset)
  expect(html).toContain("Generated at 2026-07-10 15:33:11.042 UTC+02:00 (Europe/Paris)")
  expect(html).not.toContain("Generated at 2026-07-10T13:33:11.042Z")
  dataset.generatedAt = "2026-01-10T13:33:11.042Z"
  expect(renderReportHtml(dataset)).toContain(
    "Generated at 2026-01-10 14:33:11.042 UTC+01:00 (Europe/Paris)",
  )
  expect(html).toContain('id="rawCounts"')
  expect(html).toContain('id="from" type="text" value="27/06/2026"')
  expect(html).toContain('id="fromPicker" type="date" value="2026-06-27"')
  expect(html).toContain('id="to" type="text" value="27/06/2026"')
  expect(html).toContain('id="toPicker" type="date" value="2026-06-27"')
  expect(html).toContain('placeholder="DD/MM/YYYY"')
  expect(html).toContain("function parseDisplayDate")
  expect(html).toContain("function filteredReportModels")
  expect(html).toContain("function filteredAnalytics")
  expect(html).toContain("const models = filteredReportModels()")
  expect(html).toContain("const analytics = filteredAnalytics() || { }")
  expect(html).toContain("Cloud tasks (current snapshot)")
  expect(html).toContain('data-stat-value="120"')
  expect(html).toContain('class="report-title"')
  expect(html).toContain('class="breakdown-sidebar"')
  expect(html).toContain('class="model-details"')
  expect(html).toContain("function serviceTierRows")
  expect(html).toContain('id="themePickerButton"')
  expect(html).toContain('id="themeSearch"')
  expect(html).toContain('role="combobox"')
  expect(html).toContain('id="themeOptions"')
  expect(html).toContain('role="listbox"')
  expect(html).toContain("function applyTheme")
  expect(html).toContain("function selectTheme")
  expect(html).toContain('<link rel="icon" type="image/webp" href="data:image/webp;base64,')
  expect(html).toContain('class="select-control"')
  expect(html).toContain('class="control-chevron"')
  expect(html).toContain('class="theme-picker-label"')
  expect(html).toContain(
    ".theme-picker-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  )
  expect(html).toContain('class="toolbar-meta"')
  expect(html).toContain('class="github-link"')
  expect(html).toContain('class="section-actions breakdown-actions"')
  expect(html).toContain(".model-group.last-model")
  expect(html).not.toContain(".theme-picker-button::after")
  expect(html).toContain(
    "const reasoningEffortOrder = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']",
  )
  expect(html).toContain("function modelColor")
  expect(html).toContain("function surfaceColor")
  expect(html).toContain("function reasoningColor")
  expect(html).toContain("function modeColor")
  expect(html).toContain("function meterWidth")
  expect(html).toContain("Math.max(2,")
  const bundledColorCatalog = html.match(/const modelProgressColors = (\{[^;]+\});/)
  expect(bundledColorCatalog).not.toBeNull()
  expect(
    Object.keys(JSON.parse(bundledColorCatalog?.[1] ?? "{}") as Record<string, unknown>).sort(),
  ).toEqual([...pricing.table.keys()].sort())
  const modelRowsScript = html.match(
    /<script id="model-rows" type="application\/json">([\s\S]*?)<\/script>/,
  )
  expect(modelRowsScript).not.toBeNull()
  const modelRows = JSON.parse(modelRowsScript?.[1] ?? "[]") as ReportModelRow[]
  expect(modelRows.map((row) => [row.model, row.source, row.localTokens])).toEqual([
    ["gpt-5", "local", 120],
  ])
  const scripts = [
    ...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g),
  ].map((match) => match[1])
  expect(scripts.length).toBeGreaterThan(0)

  for (const script of scripts) {
    expect(() => new Function(script)).not.toThrow()
  }

  expect(html).toContain("\\nTotal : ")
})
