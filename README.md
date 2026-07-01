# Codex Usage Tool

Generate polished, self-contained Codex usage reports from local `.codex` folders plus the authenticated ChatGPT/Codex dashboard APIs.  
The tool is designed for people who use Codex across several machines or surfaces and want one offline report that reconciles authoritative backend totals with the richer context available in local rollout files: models, reasoning effort, cached input, output tokens, cost estimates, themes, surfaces, and cloud task metadata.

## What It Produces

- Interactive `usage-report.html` with token heatmaps, trend charts, WHAM dashboard breakdowns, hover details, and per-chart SVG/PNG downloads
- Static SVG/PNG heatmaps and charts for daily, weekly, and cumulative views
- `usage-data.json` with the normalized dataset used by the report
- `cost-estimate.csv` for daily token and cost analysis
- Reports styled from the first selected Codex home theme, including named theme fallbacks when the config only stores a theme name

## Data Sources

The report combines several data sources and keeps their roles explicit:
- **Profile API totals** from `/profiles/me`: authoritative daily total token usage when available
- **Local `.codex` enrichment** from rollout JSONL files and SQLite thread databases: model, token breakdown, reasoning effort, source home, and local cost context
- **WHAM dashboard analytics** from the Codex cloud dashboard: model turns, surface tokens, current and archived task samples, PR metadata, and task diff summaries
- **Pricing metadata** from `models.dev`, with bundled fallback pricing for offline runs

When backend totals and local files disagree, `hybrid` mode keeps backend totals authoritative and uses local files only to explain the portion it can see. Backend-only tokens remain visible instead of being silently discarded.

## Installation

```pwsh
bun install --frozen-lockfile
```

Requirements:
- Bun 1.3 or newer
- A readable Codex home, usually `C:\Users\<you>\.codex`
- Optional network access for Profile, WHAM dashboard, theme, and pricing refreshes

## Quick Start

```pwsh
bun src/cli.ts generate --codex-home "C:\Users\EDM115\.codex" --out ./usage
```

Then open `usage/usage-report.html`, or serve it with Bun while iterating:

```pwsh
bun usage/usage-report.html
```

Bun serves the generated report at `http://localhost:3000/`.

## Multiple Codex Homes

Pass every copied `.codex` folder you want to include. This is useful when a desktop, laptop, WSL profile, or downloaded backup has local rollout data that the backend total cannot break down by itself.

```pwsh
bun src/cli.ts generate --codex-home "C:\Users\EDM115\.codex" --codex-home "D:\Backups\Laptop\.codex" --codex-root "E:\OldMachines\DesktopProfile" --from 2026-01-01 --to 2026-06-30 --out ./usage
```

`--codex-home` accepts a `.codex` directory. `--codex-root` accepts either a `.codex` directory or a parent directory that contains one.

## Commands

```text
generate   Collect data and write HTML, SVG, PNG, JSON, and CSV outputs. This is the default.
collect    Collect data and write usage-data.json and cost-estimate.csv only.
help       Show CLI help.
```

## Options

```text
--codex-home <path>        Add a .codex directory. Repeatable.
--codex-root <path>        Add a parent directory containing .codex. Repeatable.
--out <path>               Output directory. Default: outputs/codex-usage.
--from YYYY-MM-DD          Inclusive date filter.
--to YYYY-MM-DD            Inclusive date filter.
--timezone <tz>            IANA timezone for local rollout bucketing. Default: Europe/Paris.
--source hybrid|backend|local
                           Default: hybrid. Backend totals plus local enrichment.
--profile-json <path>      Use a saved /profiles/me JSON response instead of calling the API.
--analytics-json <path>    Use saved WHAM analytics JSON instead of calling the dashboard APIs.
--no-api                   Do not call Profile or WHAM APIs.
--base-url <url>           Backend base URL. Default: https://chatgpt.com/backend-api.
--pricing-source bundled|models.dev
                           Default: models.dev with bundled fallback.
--pricing-json <path>      Use a custom pricing JSON file.
--estimate-model <model>   Model used for unattributed backend-only token cost estimates.
--no-png                   Skip static PNG export and write SVG/HTML/JSON/CSV only.
--help                     Show help.
```

## Output Files

```text
usage-report.html          Interactive offline report.
usage-data.json            Normalized report dataset.
cost-estimate.csv          Daily token and estimated-cost table.
heatmap-daily.svg/png      Daily token intensity heatmap.
heatmap-weekly.svg/png     Weekly token intensity heatmap.
heatmap-cumulative.svg/png Cumulative token intensity heatmap.
chart-daily.svg/png        Daily token trend chart.
chart-weekly.svg/png       Weekly token trend chart.
chart-cumulative.svg/png   Cumulative token trend chart.
```

PNG export uses `@resvg/resvg-js` for static files. If the native renderer is unavailable, SVG and HTML outputs are still written.

## Authentication and Privacy

For live API calls, the CLI reads `auth.json` from the first configured Codex home and sends the access token only in request headers. Tokens are not written to generated reports, JSON, CSV, SVG, PNG, or logs.  
If API access fails, the report records the warning and falls back to the data it can still read locally. Use `--profile-json` or `--analytics-json` for reproducible offline reports from saved API responses.

## Themes

The generated HTML and images use the first selected Codex home configuration. Explicit desktop theme colors take priority. If the config only contains a named theme, the tool tries the upstream `openai/codex` theme definitions and falls back to a bundled local palette for common Codex themes.

## Development

```pwsh
bun test
bun run typecheck
bun src/cli.ts generate --codex-home "C:\Users\EDM115\.codex" --out ./usage
```

The HTML report is intentionally self-contained. Renderer regressions should be covered by tests that extract executable script blocks from the generated HTML and parse them.

## Notes on Cost Estimates

Cost estimates are best-effort operational estimates, not billing statements. Cached input, output, and unattributed backend-only tokens are priced from the selected pricing source and estimate model. Treat official OpenAI billing exports as authoritative for accounting.
