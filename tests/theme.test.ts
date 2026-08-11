import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "bun:test";

import { buildDataset } from "../src/aggregate";
import { emptyPaymentHistory } from "../src/payments";
import { parseArgs } from "../src/cli";
import { loadPricing } from "../src/pricing";
import { renderChartSvg, renderHeatmapSvg, renderRoiSvg } from "../src/render";
import {
  BUILTIN_CODEX_THEMES,
  EDM115_THEME,
  resolveUsageThemes,
  validateThemeChoice,
} from "../src/theme";

test("built-in catalog matches the 91 extracted palettes", () => {
  const palettes = Object.values(BUILTIN_CODEX_THEMES);

  expect(palettes).toHaveLength(91);
  expect(palettes[0].name).toBe("absolutely-dark");
  expect(palettes.at(-1)?.name).toBe("xcode-light");
  expect(createHash("sha256").update(JSON.stringify(palettes)).digest("hex")).toBe(
    "ea9f6d653c88aa3f41428c18f4a835fe5ecb3be9a9950a7c46c31f450c7c473d",
  );
  expect(EDM115_THEME.name).toBe("EDM115");
});

test("theme resolution defaults to EDM115 without a usable config", () => {
  const result = resolveUsageThemes([]);

  expect(result.themeChoice).toBe("EDM115");
  expect(result.theme).toBe(EDM115_THEME);
  expect(result.availableThemes.slice(0, 3).map((row) => row.id)).toEqual([
    "EDM115",
    "absolutely-dark",
    "absolutely-light",
  ]);
});

test("config custom colors win over its named TUI theme", () => {
  const homePath = createConfig(`
[tui]
theme = "dracula"
[desktop.appearanceDarkChromeTheme]
accent = "#123456"
surface = "#010203"
ink = "#fefefe"
`);
  const result = resolveUsageThemes([{ path: homePath, label: "custom" }]);

  expect(result.themeChoice).toBe("config");
  expect(result.theme.colors.bg).toBe("#010203");
  expect(result.theme.colors.accent).toBe("#123456");
  expect(result.availableThemes.slice(0, 3).map((row) => row.id)).toEqual([
    "config",
    "EDM115",
    "absolutely-dark",
  ]);
});

test("config falls back to a checked-in named TUI theme", () => {
  const homePath = createConfig(`[tui]\ntheme = "dracula"\n`);
  const result = resolveUsageThemes([{ path: homePath, label: "named" }]);

  expect(result.themeChoice).toBe("config");
  expect(result.theme.colors.bg).toBe(BUILTIN_CODEX_THEMES.dracula.bg);
  expect(result.theme.source).toContain("config.toml");
});

test("explicit choices override config and invalid choices fail", () => {
  const homePath = createConfig(`[tui]\ntheme = "dracula"\n`);
  const result = resolveUsageThemes([{ path: homePath, label: "named" }], "ayu-light");

  expect(result.themeChoice).toBe("ayu-light");
  expect(result.theme.colors.bg).toBe(BUILTIN_CODEX_THEMES["ayu-light"].bg);
  expect(() => resolveUsageThemes([], "config")).toThrow(
    "--theme config requires a usable Codex config theme",
  );
  expect(() => validateThemeChoice("missing-theme")).toThrow("Unknown theme");
});

function createConfig(text: string): string {
  const homePath = join(tmpdir(), `codex-theme-test-${crypto.randomUUID()}`);
  mkdirSync(homePath, { recursive: true });
  writeFileSync(join(homePath, "config.toml"), text.trim());

  return homePath;
}

test("CLI parses canonical theme choices and rejects unknown names", () => {
  expect(parseArgs(["generate", "--theme", "dracula"]).theme).toBe("dracula");
  expect(parseArgs(["collect", "--theme", "EDM115"]).theme).toBe("EDM115");
  expect(() => parseArgs(["generate", "--theme", "missing-theme"])).toThrow("Unknown theme");
});

test("CLI accepts repeated usage JSON inputs alongside Codex homes", () => {
  const options = parseArgs([
    "generate",
    "--usage-json",
    "laptop/usage-data.json",
    "--codex-home",
    "desktop/.codex",
    "--usage-json",
    "archive/usage-data.json",
  ]);

  expect(options.usageJsons).toEqual(["laptop/usage-data.json", "archive/usage-data.json"]);
  expect(options.codexHomes).toEqual(["desktop/.codex"]);
});

test("CLI accepts a payment override JSON independently of API mode", () => {
  expect(parseArgs(["generate", "--payments-json", "payments.json", "--no-api"]).paymentsJson).toBe(
    "payments.json",
  );
  expect(() => parseArgs(["generate", "--payments-json"])).toThrow(
    "--payments-json requires a value",
  );
});

test("CLI rejects date filters that cannot be applied faithfully to usage JSON", () => {
  expect(() =>
    parseArgs(["generate", "--usage-json", "usage-data.json", "--from", "2026-07-01"]),
  ).toThrow("--from and --to cannot be applied to --usage-json inputs");
});

test("batch SVG renderers use the CLI-selected dataset theme", async () => {
  const pricing = await loadPricing({ source: "bundled" });
  const resolution = resolveUsageThemes([], "dracula");
  const dataset = buildDataset({
    profileResult: { fetched: false, error: "offline" },
    events: [],
    codexHomes: [{ path: "home", label: "home" }],
    sourceMode: "local",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    localStats: { rolloutFiles: 0, sqliteDatabases: 0, sqliteThreads: 0, parseErrors: [] },
    pricing,
    estimateModel: "gpt-5.6-sol",
    ...resolution,
  });
  const heatmap = renderHeatmapSvg(dataset, "daily");
  const chart = renderChartSvg(dataset, "daily", "bar");

  for (const svg of [heatmap, chart]) {
    expect(svg).toContain(resolution.theme.colors.bg);
    expect(svg).toContain(resolution.theme.colors.text);
    expect(svg).toContain(resolution.theme.colors.accent);
  }
});

test("batch heatmap and trend exports align partial weeks and retain compact axis context", async () => {
  const pricing = await loadPricing({ source: "bundled" });
  const dates = Array.from({ length: 30 }, (_, index) =>
    new Date(Date.UTC(2026, 5, 27 + index)).toISOString().slice(0, 10),
  );
  const dataset = buildDataset({
    profileResult: { fetched: false, error: "offline" },
    events: dates.map((date, index) => ({
      eventId: `event-${index}`,
      homePath: "home",
      homeLabel: "home",
      rolloutPath: `home/${date}.jsonl`,
      threadId: `thread-${index}`,
      timestamp: `${date}T08:00:00.000Z`,
      date,
      model: "gpt-5.5",
      breakdown: {
        inputTokens: 90 + index,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 2,
        totalTokens: 100 + index,
      },
    })),
    codexHomes: [{ path: "home", label: "home" }],
    sourceMode: "local",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    localStats: { rolloutFiles: dates.length, sqliteDatabases: 0, sqliteThreads: 0, parseErrors: [] },
    pricing,
    estimateModel: "gpt-5.5",
    ...resolveUsageThemes([]),
  });

  const heatmap = renderHeatmapSvg(dataset, "daily");
  expect(heatmap).toContain('height="204"');
  expect(heatmap).toContain('<rect x="42" y="34"');
  expect(heatmap).toContain(">Less</text>");
  expect(heatmap).toContain(">More</text>");
  expect(heatmap).not.toContain("Profile totals are authoritative");

  const chart = renderChartSvg(dataset, "daily", "bar");
  expect(chart).toContain(">2026-07-01</text>");
  expect(chart).not.toContain(">2026-07-25</text>");
  expect(chart).toContain(">2026-07-26</text>");
});

test("batch ROI export includes payment-only months and its own legend", async () => {
  const pricing = await loadPricing({ source: "bundled" });
  const payments = emptyPaymentHistory();
  payments.complete = true;
  payments.overrides = { "2026-06": 24, "2026-07": 100 };
  payments.sources = [{ kind: "json", label: "payments.json", status: "complete" }];
  const dataset = buildDataset({
    profileResult: { fetched: false, error: "offline" },
    events: [
      {
        eventId: "event-july",
        homePath: "home",
        homeLabel: "home",
        rolloutPath: "home/2026-07-10.jsonl",
        threadId: "thread-july",
        timestamp: "2026-07-10T08:00:00.000Z",
        date: "2026-07-10",
        model: "gpt-5.5",
        breakdown: {
          inputTokens: 900_000,
          cachedInputTokens: 200_000,
          outputTokens: 100_000,
          reasoningOutputTokens: 20_000,
          totalTokens: 1_000_000,
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
    estimateModel: "gpt-5.5",
    payments,
    ...resolveUsageThemes([]),
  });

  const roi = renderRoiSvg(dataset);
  expect(roi).toContain(">2026-06</text>");
  expect(roi).toContain(">2026-07</text>");
  expect(roi).toContain("Amount paid");
  expect(roi).toContain("Estimated API value");
  expect(roi).toContain("Conventional ROI");
});
