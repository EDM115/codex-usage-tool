# Codex Usage Tool

Local Bun/TypeScript CLI for Codex token usage reports.

It combines two data classes:

- **Profile API totals**: authoritative all-device daily total tokens from Codex Profile (`/profiles/me`)
- **Local enrichment**: token breakdowns from one or more `.codex` folders, including copied folders from other machines. This enriches the totals with input, cached input, output, reasoning output, model, reasoning effort, and plan/rate-limit metadata where rollout files are available.

The API totals remain the source of truth when both are present. Local enrichment is not considered low quality, but it can be incomplete because missing devices, deleted rollouts, or sessions outside copied `.codex` folders cannot be reconstructed locally.

## Requirements

- Bun 1.3+
- A readable Codex home, usually `C:\Users\<you>\.codex`
- Optional network access for Profile API and fresh pricing metadata

Install dependencies once:

```pwsh
bun install --frozen-lockfile
```

## Quick Start

```pwsh
bun src/cli.ts generate `
  --codex-home C:\Users\EDM115\.codex `
  --out ./usage
```

Open `usage-report.html` from the output directory. It is self-contained and works offline after generation.

## Multiple Machines

Pass multiple copied `.codex` folders:

```pwsh
bun src/cli.ts generate `
  --codex-home C:\Users\EDM115\.codex `
  --codex-home D:\Backups\Laptop\.codex `
  --codex-root E:\OldMachines\DesktopProfile `
  --from 2026-01-01 `
  --to 2026-06-27
```

`--codex-home` accepts a `.codex` directory. `--codex-root` accepts either a `.codex` directory or a parent directory that contains one.

## Commands

```text
generate   Collect data and write HTML, SVG, PNG, JSON, and CSV outputs.
collect    Collect and write usage-data.json only.
help       Show CLI help.
```

`generate` is the default command.

## Useful Options

```text
--codex-home <path>        Add a .codex directory. Repeatable.
--codex-root <path>        Add a parent directory containing .codex. Repeatable.
--out <path>               Output directory.
--from YYYY-MM-DD          Inclusive date filter.
--to YYYY-MM-DD            Inclusive date filter.
--timezone <tz>            IANA timezone for local rollout bucketing. Default: Europe/Paris.
--source hybrid|backend|local
                           Default: hybrid. Backend totals plus local enrichment.
--profile-json <path>      Use a saved /profiles/me JSON response instead of calling the API.
--no-api                   Do not call the Profile API.
--base-url <url>           Codex/ChatGPT backend base URL. Default: https://chatgpt.com/backend-api.
--pricing-source bundled|models.dev
                           Default: models.dev with bundled fallback.
--pricing-json <path>      Use a custom pricing JSON file.
--estimate-model <model>   Model used for unattributed backend-only token cost estimates.
--no-png                   Skip PNG export and write SVG only.
--help                     Show help.
```

## Output Files

- `usage-report.html`: interactive offline report with hover details and browser export buttons.
- `usage-data.json`: normalized data used by the report.
- `cost-estimate.csv`: daily cost estimate table.
- `heatmap-daily.svg/png`, `heatmap-weekly.svg/png`, `heatmap-cumulative.svg/png`.
- `chart-daily.svg/png`, `chart-weekly.svg/png`, `chart-cumulative.svg/png`.

PNG export uses `@resvg/resvg-js`. If that package cannot load, SVG and HTML are still written.

## Auth Notes

For API calls, the tool reads `auth.json` from the first configured Codex home and uses the access token in memory only. It does not write tokens to reports or logs. If Profile API access fails, `hybrid` mode falls back to local-only data and records the issue in `usage-data.json`.

Keyring-only auth storage is not implemented in v0.1. Use `--profile-json` if your active Codex auth is not present in `auth.json`.

## Pricing Notes

Default pricing refresh uses `models.dev` structured metadata for OpenAI models and falls back to bundled prices. Official OpenAI pricing should be treated as authoritative when reconciling final bills; pricing changes over time, so reports include pricing source metadata.
