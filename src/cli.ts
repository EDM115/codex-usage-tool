#!/usr/bin/env bun
import path from "node:path";
import { resolveCodexHomes } from "./codex-homes";
import { loadAuthFromHomes } from "./auth";
import { loadProfile } from "./profile-api";
import { collectRolloutEvents } from "./rollouts";
import { buildDataset } from "./aggregate";
import { loadPricing } from "./pricing";
import { writeOutputs } from "./export";
import type { CliOptions, SourceMode, PricingSource } from "./types";
import { compactNumber, money } from "./util";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    console.log(helpText());
    return;
  }

  const codexHomes = resolveCodexHomes(options.codexHomes, options.codexRoots);
  if (codexHomes.length === 0) {
    throw new Error("No .codex homes found. Pass --codex-home or --codex-root.");
  }

  const auth = loadAuthFromHomes(codexHomes);
  const pricing = await loadPricing({ source: options.pricingSource, pricingJson: options.pricingJson });
  const profileResult = options.source === "local"
    ? { fetched: false, error: "Profile API skipped because --source local was selected" }
    : await loadProfile({
        profileJson: options.profileJson,
        noApi: options.noApi,
        baseUrl: options.baseUrl,
        auth,
      });

  if (options.source === "backend" && !profileResult.profile) {
    throw new Error(`Backend source requested but Profile API data is unavailable: ${profileResult.error ?? "unknown error"}`);
  }

  const local = options.source === "backend"
    ? { events: [], rolloutFiles: 0, sqliteDatabases: 0, sqliteThreads: 0, parseErrors: [] }
    : collectRolloutEvents({
        homes: codexHomes,
        timezone: options.timezone,
        from: options.from,
        to: options.to,
      });

  const dataset = buildDataset({
    profileResult,
    events: local.events,
    codexHomes,
    sourceMode: options.source,
    from: options.from,
    to: options.to,
    timezone: options.timezone,
    localStats: {
      rolloutFiles: local.rolloutFiles,
      sqliteDatabases: local.sqliteDatabases,
      sqliteThreads: local.sqliteThreads,
      parseErrors: local.parseErrors,
    },
    pricing,
    estimateModel: options.estimateModel,
  });

  const result = await writeOutputs(dataset, path.resolve(options.outDir), {
    includePng: !options.noPng,
    reportOnly: options.command === "collect",
  });

  console.log(`Wrote ${result.files.length} file(s) to ${path.resolve(options.outDir)}`);
  console.log(`Total tokens: ${compactNumber(dataset.summary.lifetimeTokens)}; local enriched: ${compactNumber(dataset.summary.localKnownTokens)}; estimated cost: ${money(dataset.summary.estimatedCostUsd)}`);
  if (dataset.profile?.error) console.warn(`Profile API warning: ${dataset.profile.error}`);
  if (dataset.pricing.warning) console.warn(`Pricing warning: ${dataset.pricing.warning}`);
  for (const warning of result.warnings) console.warn(warning);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: "generate",
    codexHomes: [],
    codexRoots: [],
    outDir: "outputs/codex-usage",
    from: null,
    to: null,
    timezone: "Europe/Paris",
    source: "hybrid",
    noApi: false,
    baseUrl: "https://chatgpt.com/backend-api",
    pricingSource: "models.dev",
    estimateModel: "gpt-5.5",
    noPng: false,
  };

  const first = args[0];
  if (first && !first.startsWith("-")) {
    if (!["generate", "collect", "help"].includes(first)) throw new Error(`Unknown command: ${first}`);
    options.command = first as CliOptions["command"];
    args = args.slice(1);
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--codex-home":
        options.codexHomes.push(next());
        break;
      case "--codex-root":
        options.codexRoots.push(next());
        break;
      case "--out":
        options.outDir = next();
        break;
      case "--from":
        options.from = validateDate(next(), "--from");
        break;
      case "--to":
        options.to = validateDate(next(), "--to");
        break;
      case "--timezone":
        options.timezone = next();
        break;
      case "--source":
        options.source = validateSource(next());
        break;
      case "--profile-json":
        options.profileJson = next();
        break;
      case "--no-api":
        options.noApi = true;
        break;
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--pricing-source":
        options.pricingSource = validatePricingSource(next());
        break;
      case "--pricing-json":
        options.pricingJson = next();
        break;
      case "--estimate-model":
        options.estimateModel = next();
        break;
      case "--no-png":
        options.noPng = true;
        break;
      case "--help":
      case "-h":
        options.command = "help";
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function validateDate(value: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${flag} must be YYYY-MM-DD`);
  return value;
}

function validateSource(value: string): SourceMode {
  if (value === "hybrid" || value === "backend" || value === "local") return value;
  throw new Error("--source must be hybrid, backend, or local");
}

function validatePricingSource(value: string): PricingSource {
  if (value === "bundled" || value === "models.dev") return value;
  throw new Error("--pricing-source must be bundled or models.dev");
}

function helpText(): string {
  return `Codex Usage Tool

Usage:
  bun src/cli.ts [generate|collect|help] [options]

Commands:
  generate   Collect data and write HTML, SVG, PNG, JSON, and CSV outputs. Default.
  collect    Collect data and write usage-data.json/cost-estimate.csv only.
  help       Show this help.

Data options:
  --codex-home <path>        Add a .codex directory. Repeatable.
  --codex-root <path>        Add a parent directory containing .codex. Repeatable.
  --source <mode>            hybrid | backend | local. Default: hybrid.
  --profile-json <path>      Use a saved /profiles/me JSON response.
  --no-api                   Disable Profile API calls.
  --base-url <url>           Default: https://chatgpt.com/backend-api.

Filters:
  --from YYYY-MM-DD          Inclusive start date.
  --to YYYY-MM-DD            Inclusive end date.
  --timezone <tz>            Default: Europe/Paris.

Pricing:
  --pricing-source <source>  models.dev | bundled. Default: models.dev.
  --pricing-json <path>      Custom pricing JSON.
  --estimate-model <model>   Default: gpt-5.5.

Output:
  --out <path>               Output directory. Default: outputs/codex-usage.
  --no-png                   Skip PNG export.

Examples:
  bun src/cli.ts generate --codex-home C:\\Users\\EDM115\\.codex --out outputs\\codex-usage
  bun src/cli.ts generate --codex-home C:\\Users\\EDM115\\.codex --codex-home D:\\Laptop\\.codex --from 2026-01-01
`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
