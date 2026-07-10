import type { CodexHome, UsageTheme } from "./types"

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { fileExists } from "./util"

export type ThemeSeed = {
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

export const EDM115_THEME: UsageTheme = makeTheme(
  {
    name: "EDM115",
    bg: FALLBACK_BG,
    text: FALLBACK_TEXT,
    accent: FALLBACK_ACCENT,
    muted: "#aaaab2",
    panel: "#0b1019",
    line: "#202735",
  },
  "bundled EDM115 theme",
)

export const BUILTIN_CODEX_THEMES = {
  "absolutely-dark": {"name":"absolutely-dark","bg":"#2d2d2b","text":"#f9f9f7","accent":"#cc7d5e","muted":"#b2b2b0","panel":"#373735","line":"#565654"},
  "absolutely-light": {"name":"absolutely-light","bg":"#f9f9f7","text":"#2d2d2b","accent":"#cc7d5e","muted":"#939391","panel":"#f4f4f2","line":"#d0d0ce"},
  "andromeeda": {"name":"andromeeda","bg":"#23262e","text":"#d5ced9","accent":"#746f77","muted":"#87888f","panel":"#23262e","line":"#1b1d23"},
  "aurora-x": {"name":"aurora-x","bg":"#07090f","text":"#576daf","accent":"#262e47","muted":"#546e7a","panel":"#07090f","line":"#15182b"},
  "ayu-dark": {"name":"ayu-dark","bg":"#10141c","text":"#bfbdb6","accent":"#e6b450","muted":"#5a6673","panel":"#0d1017","line":"#1b1f29"},
  "ayu-light": {"name":"ayu-light","bg":"#fcfcfc","text":"#5c6166","accent":"#f29718","muted":"#adaeb1","panel":"#f8f9fa","line":"#eaedef"},
  "ayu-mirage": {"name":"ayu-mirage","bg":"#242936","text":"#cccac2","accent":"#ffcc66","muted":"#6e7c8f","panel":"#1f2430","line":"#171b24"},
  "catppuccin-frappe": {"name":"catppuccin-frappe","bg":"#303446","text":"#c6d0f5","accent":"#ca9ee6","muted":"#949cbb","panel":"#303446","line":"#626880"},
  "catppuccin-latte": {"name":"catppuccin-latte","bg":"#eff1f5","text":"#4c4f69","accent":"#8839ef","muted":"#7c7f93","panel":"#eff1f5","line":"#acb0be"},
  "catppuccin-macchiato": {"name":"catppuccin-macchiato","bg":"#24273a","text":"#cad3f5","accent":"#c6a0f6","muted":"#939ab7","panel":"#24273a","line":"#5b6078"},
  "catppuccin-mocha": {"name":"catppuccin-mocha","bg":"#1e1e2e","text":"#cdd6f4","accent":"#cba6f7","muted":"#9399b2","panel":"#1e1e2e","line":"#585b70"},
  "codex-dark": {"name":"codex-dark","bg":"#111111","text":"#fcfcfc","accent":"#0169cc","muted":"#999999","panel":"#131313","line":"#404040"},
  "codex-light": {"name":"codex-light","bg":"#ffffff","text":"#0d0d0d","accent":"#0169cc","muted":"#666666","panel":"#fcfcfc","line":"#cfcfcf"},
  "dark-plus": {"name":"dark-plus","bg":"#1e1e1e","text":"#d4d4d4","accent":"#007acc","muted":"#6a9955","panel":"#2b2b2b","line":"#424242"},
  "dracula": {"name":"dracula","bg":"#282a36","text":"#f8f8f2","accent":"#6272a4","muted":"#6272a4","panel":"#282a36","line":"#bd93f9"},
  "dracula-soft": {"name":"dracula-soft","bg":"#282a36","text":"#f6f6f4","accent":"#7b7f8b","muted":"#7b7f8b","panel":"#282a36","line":"#bf9eee"},
  "everforest-dark": {"name":"everforest-dark","bg":"#2d353b","text":"#d3c6aa","accent":"#2d353b","muted":"#859289","panel":"#2d353b","line":"#2d353b"},
  "everforest-light": {"name":"everforest-light","bg":"#fdf6e3","text":"#5c6a72","accent":"#fdf6e3","muted":"#939f91","panel":"#fdf6e3","line":"#fdf6e3"},
  "github-dark": {"name":"github-dark","bg":"#24292e","text":"#e1e4e8","accent":"#005cc5","muted":"#6a737d","panel":"#1f2428","line":"#1b1f23"},
  "github-dark-default": {"name":"github-dark-default","bg":"#0d1117","text":"#e6edf3","accent":"#1f6feb","muted":"#8b949e","panel":"#010409","line":"#30363d"},
  "github-dark-dimmed": {"name":"github-dark-dimmed","bg":"#22272e","text":"#adbac7","accent":"#316dca","muted":"#768390","panel":"#1c2128","line":"#444c56"},
  "github-dark-high-contrast": {"name":"github-dark-high-contrast","bg":"#0a0c10","text":"#f0f3f6","accent":"#409eff","muted":"#bdc4cc","panel":"#010409","line":"#7a828e"},
  "github-light": {"name":"github-light","bg":"#ffffff","text":"#24292e","accent":"#2188ff","muted":"#6a737d","panel":"#f6f8fa","line":"#e1e4e8"},
  "github-light-default": {"name":"github-light-default","bg":"#ffffff","text":"#1f2328","accent":"#0969da","muted":"#6e7781","panel":"#f6f8fa","line":"#d0d7de"},
  "github-light-high-contrast": {"name":"github-light-high-contrast","bg":"#ffffff","text":"#0e1116","accent":"#0349b4","muted":"#66707b","panel":"#ffffff","line":"#20252c"},
  "gruvbox-dark-hard": {"name":"gruvbox-dark-hard","bg":"#1d2021","text":"#ebdbb2","accent":"#3c3836","muted":"#928374","panel":"#1d2021","line":"#3c3836"},
  "gruvbox-dark-medium": {"name":"gruvbox-dark-medium","bg":"#282828","text":"#ebdbb2","accent":"#3c3836","muted":"#928374","panel":"#282828","line":"#3c3836"},
  "gruvbox-dark-soft": {"name":"gruvbox-dark-soft","bg":"#32302f","text":"#ebdbb2","accent":"#3c3836","muted":"#928374","panel":"#32302f","line":"#3c3836"},
  "gruvbox-light-hard": {"name":"gruvbox-light-hard","bg":"#f9f5d7","text":"#3c3836","accent":"#ebdbb2","muted":"#928374","panel":"#f9f5d7","line":"#ebdbb2"},
  "gruvbox-light-medium": {"name":"gruvbox-light-medium","bg":"#fbf1c7","text":"#3c3836","accent":"#ebdbb2","muted":"#928374","panel":"#fbf1c7","line":"#ebdbb2"},
  "gruvbox-light-soft": {"name":"gruvbox-light-soft","bg":"#f2e5bc","text":"#3c3836","accent":"#ebdbb2","muted":"#928374","panel":"#f2e5bc","line":"#ebdbb2"},
  "horizon": {"name":"horizon","bg":"#1c1e26","text":"#d5d8da","accent":"#1a1c23","muted":"#4c4d53","panel":"#1c1e26","line":"#1a1c23"},
  "horizon-bright": {"name":"horizon-bright","bg":"#fdf0ed","text":"#06060c","accent":"#e6dad8","muted":"#989190","panel":"#fdf0ed","line":"#e6dad8"},
  "houston": {"name":"houston","bg":"#17191e","text":"#eef0f9","accent":"#00daef","muted":"#545864","panel":"#23262d","line":"#17191e"},
  "kanagawa-dragon": {"name":"kanagawa-dragon","bg":"#181616","text":"#c5c9c5","accent":"#223249","muted":"#737c73","panel":"#181616","line":"#0d0c0c"},
  "kanagawa-lotus": {"name":"kanagawa-lotus","bg":"#f2ecbc","text":"#545464","accent":"#c7d7e0","muted":"#716e61","panel":"#f2ecbc","line":"#d5cea3"},
  "kanagawa-wave": {"name":"kanagawa-wave","bg":"#1f1f28","text":"#dcd7ba","accent":"#223249","muted":"#727169","panel":"#1f1f28","line":"#16161d"},
  "laserwave": {"name":"laserwave","bg":"#27212e","text":"#ffffff","accent":"#eb64b9","muted":"#91889b","panel":"#27212e","line":"#524d58"},
  "light-plus": {"name":"light-plus","bg":"#ffffff","text":"#000000","accent":"#007acc","muted":"#008000","panel":"#f5f5f5","line":"#cccccc"},
  "linear-dark": {"name":"linear-dark","bg":"#17181d","text":"#e6e9ef","accent":"#5e6ad2","muted":"#636b7b","panel":"#0a0c11","line":"#404247"},
  "linear-light": {"name":"linear-light","bg":"#f7f8fa","text":"#2a3140","accent":"#5e6ad2","muted":"#8a93a6","panel":"#f2f4f8","line":"#ced0d5"},
  "lobster-dark": {"name":"lobster-dark","bg":"#111827","text":"#e4e4e7","accent":"#ff5c5c","muted":"#71717a","panel":"#111827","line":"#3b414d"},
  "material-theme": {"name":"material-theme","bg":"#263238","text":"#eeffff","accent":"#263238","muted":"#546e7a","panel":"#263238","line":"#263238"},
  "material-theme-darker": {"name":"material-theme-darker","bg":"#212121","text":"#eeffff","accent":"#212121","muted":"#545454","panel":"#212121","line":"#212121"},
  "material-theme-lighter": {"name":"material-theme-lighter","bg":"#fafafa","text":"#90a4ae","accent":"#fafafa","muted":"#90a4ae","panel":"#fafafa","line":"#fafafa"},
  "material-theme-ocean": {"name":"material-theme-ocean","bg":"#0f111a","text":"#babed8","accent":"#0f111a","muted":"#464b5d","panel":"#0f111a","line":"#0f111a"},
  "material-theme-palenight": {"name":"material-theme-palenight","bg":"#292d3e","text":"#babed8","accent":"#292d3e","muted":"#676e95","panel":"#292d3e","line":"#292d3e"},
  "matrix-dark": {"name":"matrix-dark","bg":"#040805","text":"#b8ffca","accent":"#1eff5a","muted":"#3f8f52","panel":"#020402","line":"#28392c"},
  "min-dark": {"name":"min-dark","bg":"#1f1f1f","text":"#888888","accent":"#444444","muted":"#6b737c","panel":"#1a1a1a","line":"#1a1a1a"},
  "min-light": {"name":"min-light","bg":"#ffffff","text":"#212121","accent":"#d0d0d0","muted":"#c2c3c5","panel":"#ffffff","line":"#f4f4f4"},
  "monokai": {"name":"monokai","bg":"#272822","text":"#f8f8f2","accent":"#99947c","muted":"#88846f","panel":"#1e1f1c","line":"#414339"},
  "night-owl": {"name":"night-owl","bg":"#011627","text":"#d6deeb","accent":"#122d42","muted":"#637777","panel":"#011627","line":"#5f7e97"},
  "night-owl-light": {"name":"night-owl-light","bg":"#fbfbfb","text":"#403f53","accent":"#93a1a1","muted":"#989fb1","panel":"#f0f0f0","line":"#d9d9d9"},
  "nord": {"name":"nord","bg":"#2e3440","text":"#d8dee9","accent":"#3b4252","muted":"#616e88","panel":"#2e3440","line":"#3b4252"},
  "notion-dark": {"name":"notion-dark","bg":"#191919","text":"#d9d9d8","accent":"#3183d8","muted":"#6a9955","panel":"#151515","line":"#3f3f3f"},
  "notion-light": {"name":"notion-light","bg":"#ffffff","text":"#37352f","accent":"#3183d8","muted":"#008000","panel":"#f7f6f3","line":"#d7d7d5"},
  "one-dark-pro": {"name":"one-dark-pro","bg":"#282c34","text":"#abb2bf","accent":"#3e4452","muted":"#abb2bf","panel":"#21252b","line":"#3e4452"},
  "one-light": {"name":"one-light","bg":"#fafafa","text":"#383a42","accent":"#526fff","muted":"#a0a1a7","panel":"#eaeaeb","line":"#dbdbdc"},
  "oscurange": {"name":"oscurange","bg":"#0b0b0f","text":"#e6e6e6","accent":"#f9b98c","muted":"#46474f","panel":"#1a1a1e","line":"#37373a"},
  "pierre-dark": {"name":"pierre-dark","bg":"#0a0a0a","text":"#fafafa","accent":"#009fff","muted":"#737373","panel":"#171717","line":"#0a0a0a"},
  "pierre-dark-soft": {"name":"pierre-dark-soft","bg":"#171717","text":"#d4d4d4","accent":"#69b1ff","muted":"#636363","panel":"#101010","line":"#1d1d1d"},
  "pierre-dark-vibrant": {"name":"pierre-dark-vibrant","bg":"#0a0a0a","text":"#fafafa","accent":"#1ba7ff","muted":"#737373","panel":"#171717","line":"#0a0a0a"},
  "pierre-light": {"name":"pierre-light","bg":"#ffffff","text":"#0a0a0a","accent":"#009fff","muted":"#737373","panel":"#f5f5f5","line":"#e5e5e5"},
  "pierre-light-soft": {"name":"pierre-light-soft","bg":"#ffffff","text":"#525252","accent":"#009fff","muted":"#8a8a8a","panel":"#f7f7f7","line":"#ededed"},
  "pierre-light-vibrant": {"name":"pierre-light-vibrant","bg":"#ffffff","text":"#0a0a0a","accent":"#1ba7ff","muted":"#737373","panel":"#f5f5f5","line":"#e5e5e5"},
  "plastic": {"name":"plastic","bg":"#21252b","text":"#a9b2c3","accent":"#1085ff","muted":"#5f6672","panel":"#181a1f","line":"#0d1117"},
  "poimandres": {"name":"poimandres","bg":"#1b1e28","text":"#a6accd","accent":"#1b1e28","muted":"#5a5f79","panel":"#1b1e28","line":"#161820"},
  "proof-light": {"name":"proof-light","bg":"#f5f3ed","text":"#2f312d","accent":"#3d755d","muted":"#8b877c","panel":"#efede6","line":"#cdccc7"},
  "raycast-dark": {"name":"raycast-dark","bg":"#141414","text":"#ffffff","accent":"#282828","muted":"#666666","panel":"#141414","line":"#262626"},
  "raycast-light": {"name":"raycast-light","bg":"#ffffff","text":"#000000","accent":"#fcfcfc","muted":"#999999","panel":"#ffffff","line":"#ebebeb"},
  "red": {"name":"red","bg":"#390000","text":"#f8f8f8","accent":"#bd4444","muted":"#e7c0c0","panel":"#330000","line":"#611414"},
  "rose-pine": {"name":"rose-pine","bg":"#191724","text":"#e0def4","accent":"#2a2838","muted":"#6e6a86","panel":"#1f1d2e","line":"#191724"},
  "rose-pine-dawn": {"name":"rose-pine-dawn","bg":"#faf4ed","text":"#575279","accent":"#efe9e5","muted":"#9893a5","panel":"#fffaf3","line":"#faf4ed"},
  "rose-pine-moon": {"name":"rose-pine-moon","bg":"#232136","text":"#e0def4","accent":"#312f45","muted":"#6e6a86","panel":"#2a273f","line":"#232136"},
  "sentry-dark": {"name":"sentry-dark","bg":"#2d2935","text":"#e6dff9","accent":"#7055f6","muted":"#8d849f","panel":"#26222d","line":"#524d5c"},
  "slack-dark": {"name":"slack-dark","bg":"#222222","text":"#e6e6e6","accent":"#0077b5","muted":"#6a9955","panel":"#222222","line":"#141414"},
  "slack-ochin": {"name":"slack-ochin","bg":"#ffffff","text":"#000000","accent":"#161f26","muted":"#357b42","panel":"#2d3e4c","line":"#2d3e4c"},
  "snazzy-light": {"name":"snazzy-light","bg":"#fafbfc","text":"#565869","accent":"#09a1ed","muted":"#adb1c2","panel":"#f3f4f5","line":"#dedfe0"},
  "solarized-dark": {"name":"solarized-dark","bg":"#002b36","text":"#839496","accent":"#197271","muted":"#586e75","panel":"#00212b","line":"#2b2b4a"},
  "solarized-light": {"name":"solarized-light","bg":"#fdf6e3","text":"#657b83","accent":"#b49471","muted":"#93a1a1","panel":"#eee8d5","line":"#ddd6c1"},
  "synthwave-84": {"name":"synthwave-84","bg":"#262335","text":"#ffffff","accent":"#1f212b","muted":"#848bbd","panel":"#241b2f","line":"#495495"},
  "temple-dark": {"name":"temple-dark","bg":"#02120c","text":"#c7e6da","accent":"#e4f222","muted":"#394d46","panel":"#1d2d0f","line":"#293c35"},
  "tokyo-night": {"name":"tokyo-night","bg":"#1a1b26","text":"#a9b1d6","accent":"#262838","muted":"#51597d","panel":"#16161e","line":"#101014"},
  "vercel-dark": {"name":"vercel-dark","bg":"#000000","text":"#ededed","accent":"#006efe","muted":"#666666","panel":"#000000","line":"#2f2f2f"},
  "vercel-light": {"name":"vercel-light","bg":"#ffffff","text":"#171717","accent":"#006aff","muted":"#666666","panel":"#ffffff","line":"#d1d1d1"},
  "vesper": {"name":"vesper","bg":"#101010","text":"#ffffff","accent":"#ffc799","muted":"#575757","panel":"#101010","line":"#101010"},
  "vitesse-black": {"name":"vitesse-black","bg":"#000000","text":"#afaca2","accent":"#000000","muted":"#657365","panel":"#000000","line":"#191919"},
  "vitesse-dark": {"name":"vitesse-dark","bg":"#121212","text":"#cecabe","accent":"#121212","muted":"#687668","panel":"#121212","line":"#191919"},
  "vitesse-light": {"name":"vitesse-light","bg":"#ffffff","text":"#393a34","accent":"#ffffff","muted":"#a0ada0","panel":"#ffffff","line":"#f0f0f0"},
  "xcode-dark": {"name":"xcode-dark","bg":"#1f1f24","text":"#dedede","accent":"#5482ff","muted":"#6c7986","panel":"#1f1f24","line":"#454549"},
  "xcode-light": {"name":"xcode-light","bg":"#ffffff","text":"#262626","accent":"#0e0eff","muted":"#5d6c79","panel":"#ffffff","line":"#d4d4d4"},
} as const satisfies Record<string, ThemeSeed>

export type BuiltinThemeName = keyof typeof BUILTIN_CODEX_THEMES
export type ThemeChoice = BuiltinThemeName | "EDM115" | "config"

export type ThemeOption = { id: ThemeChoice; theme: UsageTheme }

export type ThemeResolution = {
  themeChoice: ThemeChoice
  theme: UsageTheme
  availableThemes: ThemeOption[]
}

export function validateThemeChoice(value: string): ThemeChoice {
  if (
    value === "EDM115" ||
    value === "config" ||
    Object.prototype.hasOwnProperty.call(BUILTIN_CODEX_THEMES, value)
  ) {
    return value as ThemeChoice
  }

  throw new Error(
    `Unknown theme : ${value}. Use EDM115, config, or one of : ${Object.keys(BUILTIN_CODEX_THEMES).join(", ")}`,
  )
}

export function resolveUsageThemes(
  codexHomes: CodexHome[],
  requestedTheme?: ThemeChoice,
): ThemeResolution {
  const configTheme = resolveConfigTheme(codexHomes)
  const themeChoice = requestedTheme ?? (configTheme ? "config" : "EDM115")

  if (themeChoice === "config" && !configTheme) {
    throw new Error("--theme config requires a usable Codex config theme")
  }

  const availableThemes: ThemeOption[] = [
    ...(configTheme ? [{ id: "config" as const, theme: configTheme }] : []),
    { id: "EDM115", theme: EDM115_THEME },
    ...Object.keys(BUILTIN_CODEX_THEMES)
      .sort()
      .map((id) => ({
        id: id as BuiltinThemeName,
        theme: makeTheme(
          BUILTIN_CODEX_THEMES[id as BuiltinThemeName],
          `bundled Codex theme ${id}`,
        ),
      })),
  ]
  const selected = availableThemes.find((row) => row.id === themeChoice)

  if (!selected) {
    throw new Error(`Theme is unavailable : ${themeChoice}`)
  }

  return { themeChoice, theme: selected.theme, availableThemes }
}

function resolveConfigTheme(codexHomes: CodexHome[]): UsageTheme | null {
  const config = firstCodexConfig(codexHomes)
  const explicit = config ? themeFromConfig(config.text, config.path) : null

  if (explicit) {
    return explicit
  }

  const themeName = config ? readStringKey(config.text, "tui", "theme") : null

  if (themeName === "EDM115") {
    return { ...EDM115_THEME, source: config!.path }
  }

  if (themeName && Object.prototype.hasOwnProperty.call(BUILTIN_CODEX_THEMES, themeName)) {
    return makeTheme(BUILTIN_CODEX_THEMES[themeName as BuiltinThemeName], config!.path)
  }

  return null
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
    bg: normalizeHex(bg) ?? EDM115_THEME.colors.bg,
    text: normalizeHex(textColor) ?? EDM115_THEME.colors.text,
    accent: normalizeHex(accent) ?? normalizeHex(semanticSkill) ?? EDM115_THEME.colors.accent,
    muted: blendHex(
      normalizeHex(textColor) ?? EDM115_THEME.colors.text,
      normalizeHex(bg) ?? EDM115_THEME.colors.bg,
      0.68,
    ),
    panel: blendHex(
      normalizeHex(textColor) ?? EDM115_THEME.colors.text,
      normalizeHex(bg) ?? EDM115_THEME.colors.bg,
      0.07,
    ),
    line: blendHex(
      normalizeHex(textColor) ?? EDM115_THEME.colors.text,
      normalizeHex(bg) ?? EDM115_THEME.colors.bg,
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

function readStringKey(text: string, section: string, key: string): string | null {
  const lines = text.split(/\r?\n/)
  let current = ""

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim()

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

function stripTomlComment(line: string): string {
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"' && line[index - 1] !== "\\") {
      quoted = !quoted
    } else if (line[index] === "#" && !quoted) {
      return line.slice(0, index)
    }
  }

  return line
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
