import type { CodexHome, UsageTheme } from "./types"

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { fileExists } from "./util"

type ThemeSeed = {
  name: string
  bg: string
  text: string
  accent: string
  muted?: string
  panel?: string
  line?: string
}

const FALLBACK_BG = "#050811"
const FALLBACK_TEXT = "#f7f1e8"
const FALLBACK_ACCENT = "#ffb15f"

const DEFAULT_THEME: UsageTheme = makeTheme(
  {
    name: "codex-dark",
    bg: FALLBACK_BG,
    text: FALLBACK_TEXT,
    accent: FALLBACK_ACCENT,
    muted: "#aaaab2",
    panel: "#0b1019",
    line: "#202735",
  },
  "bundled fallback",
)

const BUILTIN_CODEX_THEMES: Record<string, ThemeSeed> = {
  dark: {
    name: "dark",
    bg: "#050811",
    text: "#f7f1e8",
    accent: "#67e8f9",
    muted: "#a7a7ad",
    panel: "#0b1019",
    line: "#202735",
  },
  light: {
    name: "light",
    bg: "#fbfaf7",
    text: "#1e1e20",
    accent: "#005f87",
    muted: "#62626b",
    panel: "#ffffff",
    line: "#d9d5ca",
  },
  dracula: {
    name: "dracula",
    bg: "#00040e",
    text: "#eae7de",
    accent: "#ffb86c",
    muted: "#b7b3c4",
    panel: "#10121f",
    line: "#343246",
  },
  gruvbox: {
    name: "gruvbox",
    bg: "#1d2021",
    text: "#ebdbb2",
    accent: "#fabd2f",
    muted: "#a89984",
    panel: "#282828",
    line: "#504945",
  },
  monokai: {
    name: "monokai",
    bg: "#272822",
    text: "#f8f8f2",
    accent: "#a6e22e",
    muted: "#c1c1b8",
    panel: "#1f201b",
    line: "#49483e",
  },
  nord: {
    name: "nord",
    bg: "#2e3440",
    text: "#eceff4",
    accent: "#88c0d0",
    muted: "#d8dee9",
    panel: "#3b4252",
    line: "#4c566a",
  },
  solarized_dark: {
    name: "solarized_dark",
    bg: "#002b36",
    text: "#eee8d5",
    accent: "#2aa198",
    muted: "#93a1a1",
    panel: "#073642",
    line: "#586e75",
  },
  solarized_light: {
    name: "solarized_light",
    bg: "#fdf6e3",
    text: "#073642",
    accent: "#268bd2",
    muted: "#657b83",
    panel: "#eee8d5",
    line: "#93a1a1",
  },
}

const REMOTE_THEME_URLS = [
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/terminal_palette.rs",
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/style.rs",
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/color.rs",
]

export async function resolveUsageTheme(codexHomes: CodexHome[]): Promise<UsageTheme> {
  const config = firstCodexConfig(codexHomes)
  const explicit = config ? themeFromConfig(config.text, config.path) : null

  if (explicit) {
    return explicit
  }

  const themeName = config ? readStringKey(config.text, "tui", "theme") : null

  if (themeName) {
    const remote = await tryFetchNamedTheme(themeName)

    if (remote) {
      return remote
    }

    const builtin = BUILTIN_CODEX_THEMES[normalizeThemeName(themeName)]

    if (builtin) {
      return makeTheme(builtin, `bundled Codex theme backup for ${themeName}`)
    }
  }
  return DEFAULT_THEME
}

function firstCodexConfig(codexHomes: CodexHome[]): { path: string; text: string } | null {
  for (const home of codexHomes) {
    for (const filename of ["config.toml", "codex.toml"]) {
      const configPath = join(home.path, filename)

      if (!fileExists(configPath)) {
        continue
      }

      return { path: configPath, text: readFileSync(configPath, "utf8") }
    }
  }

  return null
}

function themeFromConfig(text: string, configPath: string): UsageTheme | null {
  const accent = readStringKey(text, "desktop.appearanceDarkChromeTheme", "accent")
  const bg = readStringKey(text, "desktop.appearanceDarkChromeTheme", "surface")
  const textColor = readStringKey(text, "desktop.appearanceDarkChromeTheme", "ink")

  if (!accent && !bg && !textColor) {
    return null
  }

  const semanticSkill = readStringKey(
    text,
    "desktop.appearanceDarkChromeTheme.semanticColors",
    "skill",
  )
  const seed = {
    name: readStringKey(text, "tui", "theme") ?? "codex-config",
    bg: normalizeHex(bg) ?? DEFAULT_THEME.colors.bg,
    text: normalizeHex(textColor) ?? DEFAULT_THEME.colors.text,
    accent: normalizeHex(accent) ?? normalizeHex(semanticSkill) ?? DEFAULT_THEME.colors.accent,
    muted: blendHex(
      normalizeHex(textColor) ?? DEFAULT_THEME.colors.text,
      normalizeHex(bg) ?? DEFAULT_THEME.colors.bg,
      0.68,
    ),
    panel: blendHex(
      normalizeHex(textColor) ?? DEFAULT_THEME.colors.text,
      normalizeHex(bg) ?? DEFAULT_THEME.colors.bg,
      0.07,
    ),
    line: blendHex(
      normalizeHex(textColor) ?? DEFAULT_THEME.colors.text,
      normalizeHex(bg) ?? DEFAULT_THEME.colors.bg,
      0.2,
    ),
  }
  const theme = makeTheme(seed, configPath)
  const uiFont = readStringKey(text, "desktop.appearanceDarkChromeTheme.fonts", "ui")
  const codeFont = readStringKey(text, "desktop.appearanceDarkChromeTheme.fonts", "code")

  return {
    ...theme,
    fonts: {
      ui: uiFont ? `${uiFont}, ${theme.fonts.ui}` : theme.fonts.ui,
      code: codeFont ? `${codeFont}, ${theme.fonts.code}` : theme.fonts.code,
    },
  }
}

async function tryFetchNamedTheme(name: string): Promise<UsageTheme | null> {
  for (const url of REMOTE_THEME_URLS) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "codex-usage-tool/1.2", Accept: "text/plain" } })

      if (!response.ok) {
        continue
      }

      const text = await response.text()
      const parsed = parseThemeSeedFromText(name, text)

      if (parsed) {
        return makeTheme(parsed, `openai/codex ${url}`)
      }
    } catch {
      continue
    }
  }

  return null
}

function parseThemeSeedFromText(name: string, text: string): ThemeSeed | null {
  const normalized = normalizeThemeName(name)
  const hexes = [...text.matchAll(/#[0-9a-fA-F]{6}/g)].map((match) => match[0])

  if (hexes.length < 3 || !text.toLowerCase().includes(normalized.replaceAll("_", ""))) {
    return null
  }

  return {
    name,
    bg: hexes[0],
    text: hexes[1] ?? DEFAULT_THEME.colors.text,
    accent: hexes[2] ?? DEFAULT_THEME.colors.accent,
  }
}

function readStringKey(text: string, section: string, key: string): string | null {
  const lines = text.split(/\r?\n/)
  let current = ""

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim()

    if (!line) {
      continue
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/)

    if (sectionMatch) {
      current = sectionMatch[1]

      continue
    }

    if (current !== section) {
      continue
    }

    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"\s*$/)

    if (keyMatch && keyMatch[1] === key) {
      return keyMatch[2]
    }
  }

  return null
}

function makeTheme(seed: ThemeSeed, source: string): UsageTheme {
  const bg = normalizeHex(seed.bg) ?? FALLBACK_BG
  const text = normalizeHex(seed.text) ?? FALLBACK_TEXT
  const accent = normalizeHex(seed.accent) ?? FALLBACK_ACCENT
  const panel = normalizeHex(seed.panel) ?? blendHex(text, bg, 0.07)
  const line = normalizeHex(seed.line) ?? blendHex(text, bg, 0.18)
  const muted = normalizeHex(seed.muted) ?? blendHex(text, bg, 0.65)
  const accent2 = blendHex(accent, text, 0.68)

  return {
    name: seed.name,
    source,
    colors: {
      bg,
      panel,
      panel2: blendHex(text, bg, 0.11),
      line,
      text,
      muted,
      accent,
      accent2,
      warning: "#ffd49b",
      cells: [
        blendHex(text, bg, 0.12),
        blendHex(accent, bg, 0.2),
        blendHex(accent, bg, 0.35),
        blendHex(accent, bg, 0.52),
        blendHex(accent, bg, 0.72),
        accent,
      ],
      series: [accent, accent2, "#8be9fd", "#50fa7b", "#ff79c6", "#f1fa8c", "#bd93f9"],
    },
    fonts: {
      ui: "ui-sans-serif, system-ui, Segoe UI, sans-serif",
      code: "ui-monospace, SFMono-Regular, Consolas, monospace",
    },
  }
}

function normalizeThemeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function normalizeHex(value?: string | null): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()

  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }

  return null
}

function blendHex(fg: string, bg: string, alpha: number): string {
  const f = hexToRgb(fg)
  const b = hexToRgb(bg)
  const parts = [0, 1, 2].map((index) => Math.round(f[index] * alpha + b[index] * (1 - alpha)))

  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "")

  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}
