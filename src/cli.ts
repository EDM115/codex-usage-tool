#!/usr/bin/env bun
import type { CliOptions, SourceMode, PricingSource, UsageDataset } from "./types"

import { resolve } from "node:path"

import { buildDataset } from "./aggregate"
import { loadWhamAnalytics } from "./analytics-api"
import { loadAuthFromHomes } from "./auth"
import { resolveCodexHomes } from "./codex-homes"
import { outputStepCount, writeOutputs } from "./export"
import { loadPricing } from "./pricing"
import { loadProfile } from "./profile-api"
import { CliProgress } from "./progress"
import { collectRolloutEvents } from "./rollouts"
import { resolveUsageThemes, validateThemeChoice } from "./theme"
import { loadUsageDatasets, mergeUsageDatasets } from "./usage-json"
import { compactNumber, money, pluralize } from "./util"

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.command === "help") {
    console.log(helpText())

    return
  }

  const progress = new CliProgress({ silent: options.silent })
  progress.setTotal(globalStepCount(options))

  const codexHomes = resolveCodexHomes(options.codexHomes, options.codexRoots, options.usageJsons.length === 0)
  progress.step(
    `Resolved ${codexHomes.length} ${pluralize("Codex home", codexHomes.length)}`,
    codexHomes.length > 0 ? "success" : options.usageJsons.length > 0 ? "neutral" : "failure",
  )
  progress.status("Reading usage JSON inputs")
  const importedDatasets = loadUsageDatasets(options.usageJsons)
  progress.step(
    importedDatasets.length > 0
      ? `Loaded ${importedDatasets.length} ${pluralize("usage JSON", importedDatasets.length)}`
      : "No usage JSON inputs",
    importedDatasets.length > 0 ? "success" : "neutral",
  )
  const timezone = resolveUsageTimezone(codexHomes.length > 0, importedDatasets, options.timezone)

  if (codexHomes.length === 0 && importedDatasets.length === 0) {
    progress.finish()

    throw new Error("No usage sources found, pass --codex-home, --codex-root, or --usage-json")
  }

  if (codexHomes.length === 0) {
    const themeResolution = resolveImportedTheme(importedDatasets, options.theme)
    progress.step(`Theme : ${themeResolution?.themeChoice ?? importedDatasets[0].themeChoice}`)
    progress.status("Merging imported usage datasets")
    const dataset = mergeUsageDatasets(importedDatasets, {
      from: options.from,
      to: options.to,
      timezone,
      ...themeResolution,
    })
    progress.step("Dataset built from usage JSON")
    await writeDataset(dataset, options, progress)

    return
  }

  const auth = loadAuthFromHomes(codexHomes)
  progress.step(
    auth ? "Auth material found" : "No auth material found",
    auth ? "success" : "neutral",
  )
  progress.status("Loading pricing table")
  const pricing = await loadPricing({
    source: options.pricingSource,
    pricingJson: options.pricingJson,
  })
  progress.step(`Pricing table : ${pricing.source}`)
  progress.status("Resolving report theme")
  const themeResolution = resolveUsageThemes(codexHomes, options.theme)
  progress.step(`Theme : ${themeResolution.themeChoice}`)
  progress.status(
    options.source === "local"
      ? "Skipping profile API for local source"
      : options.profileJson
        ? "Reading profile JSON"
        : options.noApi
          ? "Skipping profile API because --no-api is set"
          : "Fetching profile API",
  )
  const profileResult =
    options.source === "local"
      ? { fetched: false, error: "Profile API skipped because --source local was selected" }
      : await loadProfile({
          profileJson: options.profileJson,
          noApi: options.noApi,
          baseUrl: options.baseUrl,
          auth,
        })
  const profileSkipped = !profileResult.profile && (options.source === "local" || options.noApi)
  progress.step(
    profileResult.profile
      ? "Profile data ready"
      : profileSkipped
        ? "Profile API skipped"
        : "Profile data unavailable",
    profileResult.profile ? "success" : profileSkipped ? "neutral" : "failure",
  )

  if (options.source === "backend" && !profileResult.profile) {
    progress.finish()

    throw new Error(
      `Backend source requested but Profile API data is unavailable : ${profileResult.error ?? "unknown error"}`,
    )
  }

  const local =
    options.source === "backend"
      ? (() => {
          progress.step("Skipped local collection for backend source")

          return {
            events: [],
            rolloutFiles: 0,
            sqliteDatabases: 0,
            sqliteThreads: 0,
            parseErrors: [],
          }
        })()
      : collectRolloutEvents({
          homes: codexHomes,
          timezone,
          from: options.from,
          to: options.to,
          progress,
        })

  progress.status(
    options.analyticsJson
      ? "Reading WHAM analytics JSON"
      : options.noApi
        ? "Skipping WHAM analytics APIs because --no-api is set"
        : "Fetching WHAM analytics APIs",
  )
  const analytics = await loadWhamAnalytics({
    analyticsJson: options.analyticsJson,
    noApi: options.noApi,
    baseUrl: options.baseUrl,
    auth,
    from: options.from,
    to: options.to,
  })
  progress.step(
    analytics && !analytics.error
      ? "WHAM analytics ready"
      : options.noApi
        ? "WHAM analytics skipped"
        : "WHAM analytics unavailable or partial",
    analytics && !analytics.error ? "success" : options.noApi ? "neutral" : "failure",
  )

  progress.status("Aggregating daily, weekly, model, and cost summaries")
  const currentDataset = buildDataset({
    profileResult,
    events: local.events,
    codexHomes,
    sourceMode: options.source,
    from: options.from,
    to: options.to,
    timezone,
    localStats: {
      rolloutFiles: local.rolloutFiles,
      sqliteDatabases: local.sqliteDatabases,
      sqliteThreads: local.sqliteThreads,
      parseErrors: local.parseErrors,
    },
    pricing,
    estimateModel: options.estimateModel,
    ...themeResolution,
    analytics,
  })
  const dataset = importedDatasets.length > 0
    ? mergeUsageDatasets([currentDataset, ...importedDatasets], {
        from: options.from,
        to: options.to,
        timezone,
      })
    : currentDataset
  progress.step("Dataset built")

  await writeDataset(dataset, options, progress)
}

async function writeDataset(dataset: UsageDataset, options: CliOptions, progress: CliProgress): Promise<void> {
  const result = await writeOutputs(dataset, resolve(options.outDir), {
    includePng: !options.noPng,
    reportOnly: options.command === "collect",
    progress,
  })

  progress.finish()
  console.log("")

  if (!options.silent) {
    console.log(`Wrote ${result.files.length} ${pluralize("file", result.files.length)} to ${resolve(options.outDir)}`)
  }

  console.log(`Total tokens : ${compactNumber(dataset.summary.lifetimeTokens)}, local enriched : ${compactNumber(dataset.summary.localKnownTokens)}, estimated cost : ${money(dataset.summary.estimatedCostUsd)}`)

  if (!options.silent) {
    if (dataset.profile?.error) {
      console.warn(`Profile API warning : ${dataset.profile.error}`)
    }

    if (dataset.pricing.warning) {
      console.warn(`Pricing warning : ${dataset.pricing.warning}`)
    }

    if (dataset.analytics?.error) {
      console.warn(`Analytics API warning : ${dataset.analytics.error}`)
    }

    for (const warning of result.warnings) {
      console.warn(warning)
    }
  }
}

function resolveImportedTheme(datasets: UsageDataset[], choice: CliOptions["theme"]) {
  if (!choice) {
    return undefined
  }

  if (choice !== "config") {
    return resolveUsageThemes([], choice)
  }

  for (const dataset of datasets) {
    const option = dataset.availableThemes.find((theme) => theme.id === "config")

    if (option) {
      return {
        theme: option.theme,
        themeChoice: option.id,
        availableThemes: dataset.availableThemes,
      }
    }
  }

  throw new Error("--theme config requires a usable Codex config theme")
}

function resolveUsageTimezone(hasCodexHomes: boolean, datasets: UsageDataset[], requested?: string): string {
  const timezone = requested ?? (hasCodexHomes ? "Europe/Paris" : datasets[0]?.timezone ?? "Europe/Paris")
  const incompatible = datasets.find((dataset) => dataset.timezone !== timezone)

  if (incompatible) {
    throw new Error(`Usage JSON timezone ${incompatible.timezone} does not match ${timezone}, existing daily buckets cannot be rebucketed`)
  }

  return timezone
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: "help",
    codexHomes: [],
    codexRoots: [],
    usageJsons: [],
    outDir: "outputs/codex-usage",
    from: null,
    to: null,
    source: "hybrid",
    noApi: false,
    baseUrl: "https://chatgpt.com/backend-api",
    pricingSource: "models.dev",
    estimateModel: "gpt-5.6-sol",
    noPng: false,
    silent: false,
  }

  if (args.length === 0) {
    options.command = "help"
  }

  const first = args[0]

  if (first && !first.startsWith("-")) {
    if (!["generate", "collect", "help"].includes(first)) {
      throw new Error(`Unknown command : ${first}`)
    }

    options.command = first as CliOptions["command"]
    args = args.slice(1)
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const next = () => {
      const value = args[++i]

      if (!value) {
        throw new Error(`${arg} requires a value`)
      }

      return value
    }
    switch (arg) {
      case "--codex-home":
        options.codexHomes.push(next())

        break
      case "--codex-root":
        options.codexRoots.push(next())

        break
      case "--usage-json":
        options.usageJsons.push(next())

        break
      case "--out":
        options.outDir = next()

        break
      case "--from":
        options.from = validateDate(next(), "--from")

        break
      case "--to":
        options.to = validateDate(next(), "--to")

        break
      case "--timezone":
        options.timezone = next()

        break
      case "--source":
        options.source = validateSource(next())

        break
      case "--profile-json":
        options.profileJson = next()

        break
      case "--no-api":
        options.noApi = true

        break
      case "--base-url":
        options.baseUrl = next()

        break
      case "--pricing-source":
        options.pricingSource = validatePricingSource(next())

        break
      case "--pricing-json":
        options.pricingJson = next()

        break
      case "--estimate-model":
        options.estimateModel = next()

        break
      case "--no-png":
        options.noPng = true

        break
      case "--analytics-json":
        options.analyticsJson = next()

        break
      case "--theme":
        options.theme = validateThemeChoice(next())

        break
      case "--silent":
        options.silent = true

        break
      case "--help":
      case "-h":
        options.command = "help"

        break
      default:
        throw new Error(`Unknown option : ${arg}`)
    }
  }

  if (options.usageJsons.length > 0 && (options.from || options.to)) {
    throw new Error("--from and --to cannot be applied to --usage-json inputs because per-day reasoning and service-tier detail is not available")
  }

  return options
}

function globalStepCount(options: CliOptions): number {
  if (options.usageJsons.length > 0 && options.codexHomes.length === 0 && options.codexRoots.length === 0) {
    return 4 + outputStepCount({ includePng: !options.noPng, reportOnly: options.command === "collect" })
  }

  const inputSteps = 5
  const profileSteps = 1
  const localSteps = options.source === "backend" ? 1 : 3
  const analyticsSteps = 1
  const datasetSteps = 1

  return (
    inputSteps +
    profileSteps +
    localSteps +
    analyticsSteps +
    datasetSteps +
    outputStepCount({ includePng: !options.noPng, reportOnly: options.command === "collect" })
  )
}

function validateDate(value: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${flag} must be YYYY-MM-DD`)
  }

  return value
}

function validateSource(value: string): SourceMode {
  if (value === "hybrid" || value === "backend" || value === "local") {
    return value
  }

  throw new Error("--source must be hybrid, backend, or local")
}

function validatePricingSource(value: string): PricingSource {
  if (value === "bundled" || value === "models.dev") {
    return value
  }

  throw new Error("--pricing-source must be bundled or models.dev")
}

function helpText(): string {
  return `Codex usage tool by EDM115

Usage :
  bun usage [generate|collect|help] [options]

Commands :
  generate   Collect data and write HTML, SVG, PNG, JSON, and CSV outputs
  collect    Collect data and write usage-data.json/cost-estimate.csv only
  help       Show this help (default)

Data options :
  --codex-home <path>        Add a .codex directory, repeatable
  --codex-root <path>        Add a parent directory containing .codex, repeatable
  --usage-json <path>        Add a generated usage-data.json, repeatable
  --source <mode>            hybrid (default) | backend | local
  --profile-json <path>      Use a saved /profiles/me JSON response
  --no-api                   Disable Profile API calls
  --base-url <url>           Default : https://chatgpt.com/backend-api

Filters :
  --from YYYY-MM-DD          Inclusive start date, unavailable with --usage-json
  --to YYYY-MM-DD            Inclusive end date, unavailable with --usage-json
  --timezone <tz>            Local .codex default : Europe/Paris, usage JSON keeps its timezone

Pricing :
  --pricing-source <source>  models.dev (default) | bundled
  --pricing-json <path>      Custom pricing JSON
  --estimate-model <model>   Default : gpt-5.6-sol

Output :
  --out <path>               Output directory (default : outputs/codex-usage)
  --no-png                   Skip PNG export
  --analytics-json <path>    Use saved wham analytics JSON instead of calling the dashboard APIs
  --silent                   Hide action lines, file count, and warnings, keep the progress bar and token summary

Theme :
  --theme <theme>            EDM115 | config | a built-in theme, defaults to config when usable, otherwise EDM115

Examples :
  bun usage generate --codex-home C:\\Users\\EDM115\\.codex --out outputs\\codex-usage
  bun usage generate --codex-home C:\\Users\\EDM115\\.codex --codex-home D:\\Laptop\\.codex --from 2026-01-01
  bun usage generate --usage-json D:\\Shared\\usage-data.json --out outputs\\codex-usage
  bun usage generate --codex-home C:\\Users\\EDM115\\.codex --usage-json D:\\Laptop\\usage-data.json
`
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
