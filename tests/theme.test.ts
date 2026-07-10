import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"

import { buildDataset } from "../src/aggregate"
import { parseArgs } from "../src/cli"
import { loadPricing } from "../src/pricing"
import { renderChartSvg, renderHeatmapSvg } from "../src/render"
import {
  BUILTIN_CODEX_THEMES,
  EDM115_THEME,
  resolveUsageThemes,
  validateThemeChoice,
} from "../src/theme"

test("built-in catalog matches the 91 extracted palettes", () => {
  const palettes = Object.values(BUILTIN_CODEX_THEMES)

  expect(palettes).toHaveLength(91)
  expect(palettes[0].name).toBe("absolutely-dark")
  expect(palettes.at(-1)?.name).toBe("xcode-light")
  expect(createHash("sha256").update(JSON.stringify(palettes)).digest("hex")).toBe(
    "ea9f6d653c88aa3f41428c18f4a835fe5ecb3be9a9950a7c46c31f450c7c473d",
  )
  expect(EDM115_THEME.name).toBe("EDM115")
})

test("theme resolution defaults to EDM115 without a usable config", () => {
  const result = resolveUsageThemes([])

  expect(result.themeChoice).toBe("EDM115")
  expect(result.theme).toBe(EDM115_THEME)
  expect(result.availableThemes.slice(0, 3).map((row) => row.id)).toEqual([
    "EDM115",
    "absolutely-dark",
    "absolutely-light",
  ])
})

test("config custom colors win over its named TUI theme", () => {
  const homePath = createConfig(`
[tui]
theme = "dracula"
[desktop.appearanceDarkChromeTheme]
accent = "#123456"
surface = "#010203"
ink = "#fefefe"
`)
  const result = resolveUsageThemes([{ path: homePath, label: "custom" }])

  expect(result.themeChoice).toBe("config")
  expect(result.theme.colors.bg).toBe("#010203")
  expect(result.theme.colors.accent).toBe("#123456")
  expect(result.availableThemes.slice(0, 3).map((row) => row.id)).toEqual([
    "config",
    "EDM115",
    "absolutely-dark",
  ])
})

test("config falls back to a checked-in named TUI theme", () => {
  const homePath = createConfig(`[tui]\ntheme = "dracula"\n`)
  const result = resolveUsageThemes([{ path: homePath, label: "named" }])

  expect(result.themeChoice).toBe("config")
  expect(result.theme.colors.bg).toBe(BUILTIN_CODEX_THEMES.dracula.bg)
  expect(result.theme.source).toContain("config.toml")
})

test("explicit choices override config and invalid choices fail", () => {
  const homePath = createConfig(`[tui]\ntheme = "dracula"\n`)
  const result = resolveUsageThemes([{ path: homePath, label: "named" }], "ayu-light")

  expect(result.themeChoice).toBe("ayu-light")
  expect(result.theme.colors.bg).toBe(BUILTIN_CODEX_THEMES["ayu-light"].bg)
  expect(() => resolveUsageThemes([], "config")).toThrow(
    "--theme config requires a usable Codex config theme",
  )
  expect(() => validateThemeChoice("missing-theme")).toThrow("Unknown theme")
})

function createConfig(text: string): string {
  const homePath = join(tmpdir(), `codex-theme-test-${crypto.randomUUID()}`)
  mkdirSync(homePath, { recursive: true })
  writeFileSync(join(homePath, "config.toml"), text.trim())

  return homePath
}

test("CLI parses canonical theme choices and rejects unknown names", () => {
  expect(parseArgs(["generate", "--theme", "dracula"]).theme).toBe("dracula")
  expect(parseArgs(["collect", "--theme", "EDM115"]).theme).toBe("EDM115")
  expect(() => parseArgs(["generate", "--theme", "missing-theme"])).toThrow("Unknown theme")
})

test("CLI accepts repeated usage JSON inputs alongside Codex homes", () => {
  const options = parseArgs([
    "generate",
    "--usage-json",
    "laptop/usage-data.json",
    "--codex-home",
    "desktop/.codex",
    "--usage-json",
    "archive/usage-data.json",
  ])

  expect(options.usageJsons).toEqual(["laptop/usage-data.json", "archive/usage-data.json"])
  expect(options.codexHomes).toEqual(["desktop/.codex"])
})

test("CLI rejects date filters that cannot be applied faithfully to usage JSON", () => {
  expect(() =>
    parseArgs(["generate", "--usage-json", "usage-data.json", "--from", "2026-07-01"]),
  ).toThrow("--from and --to cannot be applied to --usage-json inputs")
})

test("batch SVG renderers use the CLI-selected dataset theme", async () => {
  const pricing = await loadPricing({ source: "bundled" })
  const resolution = resolveUsageThemes([], "dracula")
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
  })
  const heatmap = renderHeatmapSvg(dataset, "daily")
  const chart = renderChartSvg(dataset, "daily", "bar")

  for (const svg of [heatmap, chart]) {
    expect(svg).toContain(resolution.theme.colors.bg)
    expect(svg).toContain(resolution.theme.colors.text)
    expect(svg).toContain(resolution.theme.colors.accent)
  }
})
