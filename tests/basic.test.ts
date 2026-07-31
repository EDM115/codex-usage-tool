import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDataset } from "../src/aggregate";
import { loadPricing } from "../src/pricing";
import { renderCapabilitiesPieSvg } from "../src/render";
import { buildReportModelRows, renderReportHtml, type ReportModelRow } from "../src/report-html";
import { collectRolloutEvents } from "../src/rollouts";
import { resolveUsageThemes } from "../src/theme";
import type { CapabilityUsageEvent, UsageDataset } from "../src/types";
import { compactNumber, exactNumber, money } from "../src/util";

test("French number formatting uses spaces and decimal commas", () => {
  expect(compactNumber(1_234_567_890)).toBe("1,2 B");
  expect(compactNumber(24_900_000)).toBe("24,9 M");
  expect(exactNumber(1_373_622)).toBe("1 373 622");
  expect(money(1373.6223)).toBe("$ 1 373,62");
  expect(money(8)).toBe("$ 8,00");
});

test("collectRolloutEvents parses token_count breakdowns", () => {
  const root = join(tmpdir(), `codex-usage-test-${Date.now()}`);
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "06", "27");
  mkdirSync(sessions, { recursive: true });
  const rollout = join(
    sessions,
    "rollout-2026-06-27T10-00-00-00000000-0000-0000-0000-000000000001.jsonl",
  );
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
  );

  const result = collectRolloutEvents({
    homes: [{ path: codexHome, label: "test" }],
    timezone: "Europe/Paris",
    from: null,
    to: null,
  });

  expect(result.events).toHaveLength(1);
  expect(result.events[0].breakdown).toEqual({
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
  });
  expect(result.events[0].model).toBe("gpt-5");
  expect(result.events[0].reasoningEffort).toBe("high");
});

test("collectRolloutEvents extracts dated skill and plugin evidence without low-confidence mentions", () => {
  const root = join(tmpdir(), `codex-capability-test-${Date.now()}`);
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "07", "10");
  mkdirSync(sessions, { recursive: true });
  const rollout = join(
    sessions,
    "rollout-2026-07-10T08-00-00-00000000-0000-0000-0000-000000000010.jsonl",
  );
  const skillBlock =
    "<skill>\n<name>using-superpowers</name>\n<path>C:\\Users\\dev\\.agents\\skills\\using-superpowers\\SKILL.md</path>\nUse the skill.</skill>";
  const pluginBlock =
    "Capabilities from the `Codex Security` plugin:\n- Skills from this plugin are prefixed with `Codex Security:`.\n- MCP servers from this plugin available in this session: `codex-security`.\nUse these plugin-associated capabilities to help solve the task.";
  writeFileSync(
    rollout,
    [
      JSON.stringify({
        timestamp: "2026-07-10T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "00000000-0000-0000-0000-000000000010", model: "gpt-5" },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: skillBlock }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: pluginBlock }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:03:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "open_codex_security_workspace",
          arguments: "{}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:04:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({
            command: "Get-Content -Path 'C:\\Users\\dev\\.agents\\skills\\rtk\\SKILL.md' -Raw",
          }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:05:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input:
            "await tools.shell_command({command:\"Get-Content -Path 'C:\\\\Users\\\\dev\\\\.codex\\\\plugins\\\\cache\\\\openai-curated-remote\\\\codex-security\\\\0.1.14\\\\skills\\\\security-scan\\\\SKILL.md' -Raw\"})",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T08:06:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please consider $rtk and @Codex Security." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-11T08:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: skillBlock }],
        },
      }),
    ].join("\n"),
  );

  const result = collectRolloutEvents({
    homes: [{ path: codexHome, label: "test" }],
    timezone: "Europe/Paris",
    from: null,
    to: null,
  }) as ReturnType<typeof collectRolloutEvents> & {
    capabilityEvents?: Array<Record<string, unknown>>;
  };

  expect(
    result.capabilityEvents?.map((event) => [
      event.date,
      event.kind,
      event.name,
      event.evidenceType,
      event.confidence,
    ]),
  ).toEqual([
    ["2026-07-10", "skill", "using-superpowers", "injection", "high"],
    ["2026-07-10", "plugin", "Codex Security", "injection", "high"],
    ["2026-07-10", "plugin", "Codex Security", "tool_call", "high"],
    ["2026-07-10", "skill", "rtk", "skill_file_read", "medium"],
    ["2026-07-10", "skill", "codex-security:security-scan", "skill_file_read", "medium"],
    ["2026-07-11", "skill", "using-superpowers", "injection", "high"],
  ]);

  const filtered = collectRolloutEvents({
    homes: [{ path: codexHome, label: "test" }],
    timezone: "Europe/Paris",
    from: "2026-07-11",
    to: "2026-07-11",
  }) as ReturnType<typeof collectRolloutEvents> & {
    capabilityEvents?: Array<Record<string, unknown>>;
  };

  expect(filtered.capabilityEvents?.map((event) => [event.date, event.name])).toEqual([
    ["2026-07-11", "using-superpowers"],
  ]);
});

test("collectRolloutEvents follows thread settings model and service tier changes", () => {
  const root = join(tmpdir(), `codex-usage-switch-test-${Date.now()}`);
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "07", "10");
  mkdirSync(sessions, { recursive: true });
  const rollout = join(
    sessions,
    "rollout-2026-07-10T08-00-00-00000000-0000-0000-0000-000000000002.jsonl",
  );
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
  );

  const result = collectRolloutEvents({
    homes: [{ path: codexHome, label: "test" }],
    timezone: "Europe/Paris",
    from: null,
    to: null,
  });

  expect(result.events.map((event) => [event.model, event.reasoningEffort])).toEqual([
    ["gpt-5.5", "xhigh"],
    ["gpt-5.6-sol", "high"],
    ["gpt-5.6-sol", "high"],
    ["gpt-5.6-sol", "high"],
  ]);
  expect(result.events.map((event) => [event.serviceTier, event.serviceTierInferred])).toEqual([
    [undefined, undefined],
    ["default", true],
    ["default", undefined],
    ["priority", undefined],
  ]);
});

test("collectRolloutEvents does not let SQLite metadata overwrite rollout state", () => {
  const root = join(tmpdir(), `codex-usage-sqlite-test-${Date.now()}`);
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "07", "10");
  mkdirSync(sessions, { recursive: true });
  const threadId = "00000000-0000-0000-0000-000000000003";
  const rollout = join(sessions, `rollout-2026-07-10T09-00-00-${threadId}.jsonl`);
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
  );
  const database = new Database(join(codexHome, "state_5.sqlite"), { create: true });
  database.run(
    "create table threads (id text, rollout_path text, source text, tokens_used integer, archived integer, model text, reasoning_effort text)",
  );
  database.run("insert into threads values (?, ?, ?, ?, ?, ?, ?)", [
    threadId,
    rollout,
    "vscode",
    100,
    0,
    "gpt-5.6-terra",
    "high",
  ]);
  database.close();

  const result = collectRolloutEvents({
    homes: [{ path: codexHome, label: "test" }],
    timezone: "Europe/Paris",
    from: null,
    to: null,
  });

  expect(result.events).toHaveLength(1);
  expect(result.events[0].model).toBe("gpt-5.5");
  expect(result.events[0].reasoningEffort).toBe("medium");
});

test("buildDataset keeps backend totals authoritative and local details enriched", async () => {
  const pricing = await loadPricing({ source: "bundled" });
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
  });

  expect(dataset.daily[0].totalTokens).toBe(1000);
  expect(dataset.daily[0].localTokens.totalTokens).toBe(150);
  expect(dataset.daily[0].unattributedTokens).toBe(850);
  expect(dataset.summary.lifetimeTokens).toBe(1000);
  expect(dataset.themeChoice).toBe("EDM115");
  expect(dataset.availableThemes.slice(0, 2).map((row) => row.id)).toEqual([
    "EDM115",
    "absolutely-dark",
  ]);
});

test("buildDataset infers dated primary models for missing local and backend-only usage", async () => {
  const pricing = await loadPricing({ source: "bundled" });
  const breakdown = {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 1_000_000,
    reasoningOutputTokens: 0,
    totalTokens: 2_000_000,
  };
  const dataset = buildDataset({
    profileResult: {
      fetched: true,
      endpoint: "fixture",
      profile: {
        summary: {
          lifetimeTokens: 6_000_000,
          peakDailyTokens: 3_000_000,
          currentStreakDays: 2,
          longestStreakDays: 2,
          longestRunningTurnSec: 10,
        },
        dailyUsageBuckets: [
          { startDate: "2026-04-22", tokens: 3_000_000 },
          { startDate: "2026-04-23", tokens: 3_000_000 },
        ],
      },
    },
    events: [
      {
        eventId: "missing-model",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-04-22T08:00:00.000Z",
        date: "2026-04-22",
        model: "unknown",
        breakdown,
      },
      {
        eventId: "explicit-model",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-04-23T08:00:00.000Z",
        date: "2026-04-23",
        model: "gpt-5.4",
        breakdown,
      },
    ],
    codexHomes: [{ path: "home", label: "home" }],
    sourceMode: "hybrid",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    localStats: { rolloutFiles: 1, sqliteDatabases: 0, sqliteThreads: 0, parseErrors: [] },
    pricing,
    ...resolveUsageThemes([]),
  });

  expect(dataset.daily[0].modelUsage.map((row) => row.model)).toEqual(["gpt-5.4"]);
  expect(dataset.daily[1].modelUsage.map((row) => row.model)).toEqual(["gpt-5.4"]);
  expect(dataset.daily[0].estimatedUnattributedCostUsd).toBeCloseTo(2.5);
  expect(dataset.daily[1].estimatedUnattributedCostUsd).toBeCloseTo(5);
});

test("buildDataset retains capability evidence for report-side date filtering", async () => {
  const pricing = await loadPricing({ source: "bundled" });
  const capabilityEvent: CapabilityUsageEvent = {
    eventId: "capability-1",
    homePath: "home",
    homeLabel: "home",
    rolloutPath: "rollout",
    threadId: "thread",
    timestamp: "2026-07-10T08:00:00.000Z",
    date: "2026-07-10",
    kind: "skill",
    name: "rtk",
    evidenceType: "skill_file_read",
    confidence: "medium",
    detail: "Read skill instructions from C:/skills/rtk/SKILL.md",
  };
  const dataset = buildDataset({
    profileResult: { fetched: false, error: "offline" },
    events: [],
    capabilityEvents: [capabilityEvent],
    codexHomes: [{ path: "home", label: "home" }],
    sourceMode: "local",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    localStats: { rolloutFiles: 1, sqliteDatabases: 0, sqliteThreads: 0, parseErrors: [] },
    pricing,
    estimateModel: "gpt-5",
    ...resolveUsageThemes([]),
  } as Parameters<typeof buildDataset>[0] & { capabilityEvents: Array<typeof capabilityEvent> });

  expect(
    (dataset.local as typeof dataset.local & { capabilityEvents?: unknown[] }).capabilityEvents,
  ).toEqual([capabilityEvent]);
});

test("buildDataset exposes canonical local model usage and exact costs", async () => {
  const pricing = await loadPricing({ source: "bundled" });
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
  });
  const model = dataset.local.modelUsage[0];

  expect(model.breakdown.totalTokens).toBe(200);
  expect(model.reasoningEfforts.map((row) => [row.effort, row.breakdown.totalTokens])).toEqual([
    ["high", 150],
    ["medium", 50],
  ]);
  expect(model.serviceTiers.map((row) => [row.serviceTier, row.breakdown.totalTokens])).toEqual([
    ["default", 150],
    ["priority", 50],
  ]);
  expect(model.serviceTiers[0].inferredTokens).toBe(50);
  expect(model.serviceTiers[0].costUsd).toBeCloseTo(0.0015, 8);
  expect(model.serviceTiers[1].costUsd).toBeCloseTo(0.00125, 8);
  expect(model.reasoningEfforts[0].costUsd).toBeCloseTo(0.0015, 8);
  expect(model.reasoningEfforts[1].costUsd).toBeCloseTo(0.00125, 8);
  expect(model.costUsd).toBeCloseTo(0.00275, 8);
  expect(model.reasoningEfforts.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(
    model.costUsd,
  );
  expect(dataset.local.modelUsage.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(
    dataset.summary.knownLocalCostUsd,
  );

  const dailyModelUsage = (dataset.daily[0] as any).modelUsage;
  expect(dailyModelUsage).toHaveLength(1);
  expect(dailyModelUsage[0].model).toBe("gpt-5.5");
  expect(dailyModelUsage[0].breakdown.totalTokens).toBe(200);
  expect(
    dailyModelUsage[0].reasoningEfforts.map((row: any) => [row.effort, row.breakdown.totalTokens]),
  ).toEqual([
    ["high", 150],
    ["medium", 50],
  ]);
  expect(
    dailyModelUsage[0].serviceTiers.map((row: any) => [row.serviceTier, row.breakdown.totalTokens]),
  ).toEqual([
    ["default", 150],
    ["priority", 50],
  ]);
  expect(dailyModelUsage[0].costUsd).toBeCloseTo(model.costUsd);
});

test("buildDataset applies long-context prices only with explicit rollout context evidence", async () => {
  const pricing = await loadPricing({ source: "bundled" });
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
  });

  expect(dataset.local.modelUsage[0].costUsd).toBeCloseTo(7.5);
  expect(dataset.daily[0].knownLocalCostUsd).toBeCloseTo(7.5);
});

test("report model rows keep local models authoritative and add cloud enrichment", async () => {
  const pricing = await loadPricing({ source: "bundled" });
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
  });
  const rows = buildReportModelRows(dataset);
  expect(rows.map((row) => [row.model, row.source])).toEqual([
    ["gpt-5.5", "local+cloud"],
    ["gpt-5.6-terra", "local"],
    ["gpt-5.4", "cloud"],
  ]);
  expect(rows[0].turns).toBe(12);
  expect(rows[0].localTokens).toBe(200);
  expect(
    buildReportModelRows({ ...dataset, analytics: undefined }).map((row) => row.model),
  ).toEqual(["gpt-5.5", "gpt-5.6-terra"]);
});

test("renderHtmlReport emits parseable runtime scripts", async () => {
  const pricing = await loadPricing({ source: "bundled" });
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
    capabilityEvents: [
      {
        eventId: "skill-injection-1",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-06-27T08:01:00.000Z",
        date: "2026-06-27",
        kind: "skill",
        name: "rtk",
        evidenceType: "injection",
        confidence: "high",
        detail: "Injected skill instructions from C:/skills/rtk/SKILL.md",
      },
      {
        eventId: "skill-injection-2",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-06-27T08:02:00.000Z",
        date: "2026-06-27",
        kind: "skill",
        name: "rtk",
        evidenceType: "injection",
        confidence: "high",
        detail: "Injected skill instructions from C:/skills/rtk/SKILL.md",
      },
      {
        eventId: "skill-read",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-06-27T08:03:00.000Z",
        date: "2026-06-27",
        kind: "skill",
        name: "rtk",
        evidenceType: "skill_file_read",
        confidence: "medium",
        detail: "Read skill instructions from C:/skills/rtk/SKILL.md",
      },
      {
        eventId: "plugin-injection",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-06-28T08:01:00.000Z",
        date: "2026-06-28",
        kind: "plugin",
        name: "Codex Security",
        evidenceType: "injection",
        confidence: "high",
        detail: "Injected plugin capabilities",
      },
      {
        eventId: "plugin-tool",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "rollout",
        threadId: "thread",
        timestamp: "2026-06-28T08:02:00.000Z",
        date: "2026-06-28",
        kind: "plugin",
        name: "Codex Security",
        evidenceType: "tool_call",
        confidence: "high",
        detail: "Called plugin tool open_codex_security_workspace",
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
  });
  dataset.generatedAt = "2026-07-10T13:33:11.042Z";

  const html = renderReportHtml(dataset);
  const formattingScript = html.slice(
    html.indexOf("    function exact"),
    html.indexOf("    function renderStats"),
  );
  const loadFormatters = new Function(
    "navigator",
    "rawCountsEl",
    `${formattingScript}
return { exact, compact, money, percent: typeof percent === "function" ? percent : null };`,
  ) as (
    navigator: { languages: string[]; language: string },
    rawCountsEl: { checked: boolean },
  ) => {
    exact: (
      value: number,
      maximumFractionDigits?: number,
      minimumFractionDigits?: number,
    ) => string;
    compact: (value: number) => string;
    money: (value: number) => string;
    percent: ((value: number) => string) | null;
  };
  const englishFormatters = loadFormatters(
    { languages: ["en-US"], language: "en-US" },
    { checked: false },
  );
  const fallbackFormatters = loadFormatters({ languages: [], language: "" }, { checked: false });
  expect(englishFormatters.exact(1234.5, 2, 2)).toBe("1,234.50");
  expect(englishFormatters.compact(1_250_000)).toBe("1.3 M");
  expect(englishFormatters.money(1234.5)).toBe("$1,234.50");
  expect(englishFormatters.percent?.(12.5)).toBe("12.5%");
  expect(fallbackFormatters.exact(1234.5, 2, 2)).toBe("1 234,50");
  expect(fallbackFormatters.compact(1_250_000)).toBe("1,3 M");
  expect(fallbackFormatters.money(1234.5)).toBe("1 234,50 $");
  expect(fallbackFormatters.percent?.(12.5)).toBe("12,5 %");
  expect(html).toContain("Generated at 2026-07-10 15:33:11.042 UTC+02:00 (Europe/Paris)");
  expect(html).not.toContain("Generated at 2026-07-10T13:33:11.042Z");
  dataset.generatedAt = "2026-01-10T13:33:11.042Z";
  expect(renderReportHtml(dataset)).toContain(
    "Generated at 2026-01-10 14:33:11.042 UTC+01:00 (Europe/Paris)",
  );
  expect(html).toContain('id="rawCounts"');
  expect(html).toContain('id="from" type="text" value="27/06/2026"');
  expect(html).toContain('id="fromPicker" type="date" value="2026-06-27"');
  expect(html).toContain('id="to" type="text" value="28/06/2026"');
  expect(html).toContain('id="toPicker" type="date" value="2026-06-28"');
  expect(html).toContain('placeholder="DD/MM/YYYY"');
  expect(html).toContain("function parseDisplayDate");
  expect(html).toContain("function filteredReportModels");
  expect(html).toContain("function filteredCapabilityRows");
  expect(html).toContain("function capabilitySection");
  expect(html).not.toContain("Recent evidence :");
  expect(html).toContain(
    ".capability-section { padding-top: 12px; border-top: 1px solid var(--line); }",
  );
  expect(html).toContain("function filteredAnalytics");
  expect(html).toContain("const models = filteredReportModels()");
  expect(html).toContain("const analytics = filteredAnalytics() || { }");
  expect(html).toContain("Cloud tasks (current snapshot)");
  expect(html).toContain('data-stat-value="120"');
  expect(html).toContain('class="report-title"');
  expect(html).toContain('class="breakdown-sidebar"');
  expect(html).toContain('class="model-details"');
  expect(html).toContain("function serviceTierRows");
  expect(html).toContain('id="themePickerButton"');
  expect(html).toContain('id="themeSearch"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain('id="themeOptions"');
  expect(html).toContain('role="listbox"');
  expect(html).toContain("function applyTheme");
  expect(html).toContain("function selectTheme");
  expect(html).toContain('<link rel="icon" type="image/webp" href="data:image/webp;base64,');
  expect(html).toContain('class="select-control"');
  expect(html).toContain('class="control-chevron"');
  expect(html).toContain('class="theme-picker-label"');
  expect(html).toContain(
    ".theme-picker-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  );
  expect(html).toContain('class="toolbar-meta"');
  expect(html).toContain('class="github-link"');
  expect(html).toContain('class="section-actions breakdown-actions"');
  expect(html).toContain(".model-group.last-model");
  expect(html).not.toContain(".theme-picker-button::after");
  expect(html).toContain(
    "const reasoningEffortOrder = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']",
  );
  expect(html).toContain("function modelColor");
  expect(html).toContain("function surfaceColor");
  expect(html).toContain("function reasoningColor");
  expect(html).toContain("function modeColor");
  expect(html).toContain("function meterWidth");
  expect(html).toContain("Math.max(2,");
  const bundledColorCatalog = html.match(/const modelProgressColors = (\{[^;]+\});/);
  expect(bundledColorCatalog).not.toBeNull();
  expect(
    Object.keys(JSON.parse(bundledColorCatalog?.[1] ?? "{}") as Record<string, unknown>).sort(),
  ).toEqual([...pricing.table.keys()].sort());
  const modelRowsScript = html.match(
    /<script id="model-rows" type="application\/json">([\s\S]*?)<\/script>/,
  );
  expect(modelRowsScript).not.toBeNull();
  const modelRows = JSON.parse(modelRowsScript?.[1] ?? "[]") as ReportModelRow[];
  expect(modelRows.map((row) => [row.model, row.source, row.localTokens])).toEqual([
    ["gpt-5", "local", 120],
  ]);
  const capabilityScript = html.slice(
    html.indexOf("    function capabilityDateMatches"),
    html.indexOf("    function analyticsDateMatches"),
  );
  const filteredCapabilities = new Function(
    "dataset",
    "fromDateValue",
    "toDateValue",
    `${capabilityScript}
return filteredCapabilityRows();`,
  ) as (
    dataset: UsageDataset,
    fromDateValue: string,
    toDateValue: string,
  ) => Array<{
    kind: string;
    name: string;
    count: number;
    evidenceCounts: Record<string, number>;
    confidenceCounts: Record<string, number>;
    events: Array<{ detail: string }>;
  }>;
  expect(filteredCapabilities(dataset, "2026-06-27", "2026-06-27")).toEqual([
    {
      kind: "skill",
      name: "rtk",
      count: 3,
      evidenceCounts: { injection: 2, skill_file_read: 1 },
      confidenceCounts: { high: 2, medium: 1 },
      events: dataset.local.capabilityEvents.slice(0, 3),
    },
  ]);
  expect(filteredCapabilities(dataset, "2026-06-28", "2026-06-28")).toEqual([
    {
      kind: "plugin",
      name: "Codex Security",
      count: 2,
      evidenceCounts: { injection: 1, tool_call: 1 },
      confidenceCounts: { high: 2 },
      events: dataset.local.capabilityEvents.slice(3),
    },
  ]);
  const tiedDataset = structuredClone(dataset);

  for (const name of ["beta", "alpha"]) {
    for (let occurrence = 1; occurrence <= 2; occurrence += 1) {
      tiedDataset.local.capabilityEvents.push({
        ...dataset.local.capabilityEvents[0],
        eventId: `${name}-${occurrence}`,
        timestamp: `2026-06-29T08:0${occurrence}:00.000Z`,
        date: "2026-06-29",
        name,
      });
    }
  }

  expect(
    filteredCapabilities(tiedDataset, "2026-06-27", "2026-06-29").map((row) => [
      row.name,
      row.count,
    ]),
  ).toEqual([
    ["rtk", 3],
    ["alpha", 2],
    ["beta", 2],
    ["Codex Security", 2],
  ]);
  const pie = renderCapabilitiesPieSvg(tiedDataset);
  expect(pie).toContain("Skills &amp; plugins usage");
  expect(pie).toContain("Skill · rtk");
  expect(pie).toContain("Plugin · Codex Security");
  expect(pie.indexOf("Skill · alpha")).toBeLessThan(pie.indexOf("Skill · beta"));
  expect(html).not.toContain("skills-plugins-pie");

  const crowdedDataset = structuredClone(dataset);
  crowdedDataset.local.capabilityEvents = [];

  for (let rank = 1; rank <= 10; rank += 1) {
    for (let occurrence = rank; occurrence <= 10; occurrence += 1) {
      crowdedDataset.local.capabilityEvents.push({
        ...dataset.local.capabilityEvents[0],
        eventId: `skill-${rank}-${occurrence}`,
        timestamp: `2026-06-${String(30 - rank).padStart(2, "0")}T08:00:00.000Z`,
        date: `2026-06-${String(30 - rank).padStart(2, "0")}`,
        name: `skill-${rank}`,
      });
    }
  }

  const crowdedPie = renderCapabilitiesPieSvg(crowdedDataset);
  expect(crowdedPie).toContain("Other");
  expect(crowdedPie).not.toContain("Skill · skill-9");
  expect(crowdedPie).not.toContain("Skill · skill-10");
  const scripts = [
    ...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g),
  ].map((match) => match[1]);
  expect(scripts.length).toBeGreaterThan(0);

  for (const script of scripts) {
    expect(() => new Function(script)).not.toThrow();
  }

  expect(html).toContain("\\nTotal : ");
});
