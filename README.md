<div align="center">

# Codex usage tool

<img src="./codex_icon.webp" alt="Codex usage tool icon" width="128">

Generate polished, self-contained Codex usage reports from local `.codex` folders, shared `usage-data.json` files, and the authenticated ChatGPT/Codex dashboard APIs.  
The tool is designed for people who use Codex across several machines or surfaces and want one offline report that reconciles authoritative backend totals with the richer context available in local rollout files: models, reasoning effort, cached input, output tokens, cost estimates, themes, surfaces, and cloud task metadata.

![Demo composited](https://i.postimg.cc/N09sFNNC/demo-composited.png)

</div>

> [!TIP]  
> Using Cline ? Check out https://github.com/EDM115/cline-usage-tool !

## What it produces

- Interactive `usage-report.html` with token heatmaps, smooth trend charts, WHAM dashboard breakdowns, local-session and prompt-cache metrics, coverage and attribution diagnostics, hover details, and per-chart SVG/PNG downloads
- Static SVG/PNG heatmaps and charts for daily, weekly, and cumulative views
- Versioned `usage-data.json` with the normalized dataset, event identities, source manifests, distinct session counts, attribution completeness/certainty, local coverage, parse-cache statistics, and merge diagnostics used by the report
- `cost-estimate.csv` for daily token and cost analysis
- Reports styled from the first selected Codex home theme, including named theme fallbacks when the config only stores a theme name

## Preview

![Daily intensity](https://i.postimg.cc/W1cPN2BK/overview.png)  
![Usage trend](https://i.postimg.cc/Hk01jqmS/trend.png)  
![Models](https://i.postimg.cc/Z5Pz0GmH/models-excerpt.png)  
![Surfaces](https://i.postimg.cc/K87h46bN/surfaces.png)  
![Thinking effort + Mode mix](https://i.postimg.cc/SxLbjB4D/effort-mode.png)  
Example of generated images can be found [here](https://github.com/EDM115/codex-usage-tool/issues/1).

## Data sources

The report combines several data sources and keeps their roles explicit :

- **Profile API totals** from `/profiles/me` : authoritative daily total token usage when available
- **Local `.codex` enrichment** from streamed rollout JSONL files and SQLite thread databases : model, token breakdown, reasoning effort, source home, distinct sessions, prompt-cache savings at API-equivalent prices, attribution quality, and local cost context
- **Generated `usage-data.json` inputs** : portable normalized datasets with source and event identities that can be rendered again or combined with other machines without copying their `.codex` folders
- **WHAM dashboard analytics** from the Codex cloud dashboard : model turns, surface tokens, current and archived task samples, PR metadata, and task diff summaries
- **Pricing metadata** from the live [OpenAI pricing reference](https://developers.openai.com/api/docs/pricing), combined with a bundled effective-dated history and [`models.dev`](https://models.dev/) fallback rows

When backend totals and local files disagree, `hybrid` mode keeps backend totals authoritative and uses local files only to explain the portion it can see. Backend-only tokens remain visible instead of being silently discarded.  
On some cases, "local enriched tokens" might appear higher than total tokens. This can happen when the day's usage haven't been processed by the backend yet, and only the local rollout data reflects that usage. This is also why in the Codex App you might see 0 token usage for the day and it only refreshes the next day.

## Installation

```pwsh
bun install --frozen-lockfile
```

Requirements :

- Bun 1.3 or newer
- A readable Codex home, usually `C:\Users\<you>\.codex`, or at least one generated `usage-data.json`
- Optional network access for Profile, WHAM dashboard, theme, and pricing refreshes (make sure you're authenticated through the Codex CLI)

## Quick start

```pwsh
bun usage generate --codex-home "C:\Users\EDM115\.codex" --out ./usage
```

Then open `usage/usage-report.html`, or serve it with Bun while iterating :

```pwsh
bun usage/usage-report.html
```

Bun serves the generated report at `http://localhost:3000/`.

## Multiple codex homes

Pass every copied `.codex` folder you want to include. This is useful when a desktop, laptop, WSL profile, or downloaded backup has local rollout data that the backend total cannot break down by itself, or when you use Codex across multiple machines.

```pwsh
bun usage generate --codex-home "C:\Users\EDM115\.codex" --codex-home "D:\Backups\Laptop\.codex" --codex-root "E:\OldMachines\DesktopProfile" --from 2026-01-01 --to 2026-06-30 --out ./usage
```

`--codex-home` accepts a `.codex` directory. `--codex-root` accepts either a `.codex` directory or a parent directory that contains one.

## Share and combine generated JSON

`--usage-json` accepts the `usage-data.json` produced by an earlier run. It is repeatable and can be mixed freely with explicit Codex homes or roots, so only this one portable file needs to move between machines.

Rebuild every JSON, CSV, SVG, PNG, and HTML artifact from one shared dataset :

```pwsh
bun usage generate --usage-json "D:\Shared\usage-data.json" --out ./usage
```

Combine several shared datasets with this machine's local Codex history :

```pwsh
bun usage generate --codex-home "$env:USERPROFILE\.codex" --usage-json "D:\Laptop\usage-data.json" --usage-json "D:\Workstation\usage-data.json" --out ./usage
```

When at least one `--usage-json` is provided without an explicit `--codex-home` or `--codex-root`, automatic home discovery is disabled. This keeps the recipient's own Codex history out of the rebuilt report. Current portable files are merged by event identity, so overlapping inputs do not count the same local event or source twice. Cloud profile and WHAM analytics remain a single enhancement snapshot so the same account totals are not counted once per machine.  
Older aggregate-only JSON remains accepted and is migrated in memory without rewriting the source file. Exact event overlap cannot be reconstructed from those files; when their source manifests overlap, the later aggregate is skipped conservatively and `legacyOverlaps` is surfaced in JSON, CLI warnings, and the HTML report instead of claiming an exact merge.  
Portable JSON keeps its original timezone because its daily buckets have already been computed. Every combined JSON must use the same timezone, an explicit `--timezone` must match it. When active pricing is loaded, each daily model and service-tier breakdown is repriced with the alias, default model, and price effective on that date before multi-day totals are rebuilt. `--from` and `--to` remain rejected with `--usage-json` because not every report section can be consistently re-filtered from the normalized aggregates. Generate the shared JSON with the wanted date range instead.  
Local rollout files are read as streams. Parsed event manifests are cached under the gitignored `.cache/codex-usage-tool` directory using a versioned file-state key. An unchanged file is reused; a file whose size or modification time changed, including a growing active transcript, is invalidated and streamed again in full. Cached parse diagnostics are replayed too, so a warm scan cannot turn partial coverage into an apparently complete report.

## Commands

```text
generate   Collect data and write HTML, SVG, PNG, JSON, and CSV outputs
collect    Collect data and write usage-data.json and cost-estimate.csv only
help       Show CLI help (default)
```

## Options

```text
--codex-home <path>                        Add a .codex directory, repeatable
--codex-root <path>                        Add a parent directory containing .codex, repeatable
--usage-json <path>                        Add a generated usage-data.json, repeatable
--out <path>                               Output directory (default : outputs/codex-usage)
--from YYYY-MM-DD                          Inclusive date filter, unavailable with --usage-json
--to YYYY-MM-DD                            Inclusive date filter, unavailable with --usage-json
--timezone <tz>                            IANA timezone for local rollouts (default : Europe/Paris), JSON keeps its timezone
--source hybrid|backend|local              Default : hybrid, backend totals plus local enrichment
--profile-json <path>                      Use a saved /profiles/me JSON response instead of calling the API
--analytics-json <path>                    Use saved WHAM analytics JSON instead of calling the dashboard APIs
--no-api                                   Do not call Profile or WHAM APIs
--base-url <url>                           Backend base URL (default : https://chatgpt.com/backend-api)
--pricing-source openai|bundled|models.dev Default : OpenAI current pricing plus bundled effective-dated history
--pricing-json <path>                      Use flat current-date or effective-dated custom pricing JSON
--estimate-model <model>                   Explicit override for missing models; otherwise infer the historical primary
--no-png                                   Skip static PNG export and write SVG/HTML/JSON/CSV only
--silent                                   Hide action lines, file count, and warnings, keep the progress bar and token summary
--theme <theme>                            Default : EDM115, can also be "config" for your `config.toml` one or a any of the built-in Codex themes
--help                                     Show help
```

## Output files

```text
usage-report.html            Interactive offline report
usage-data.json              Normalized report dataset
cost-estimate.csv            Daily token and estimated-cost table
heatmap-daily.{svg,png}      Daily token intensity heatmap
heatmap-weekly.{svg,png}     Weekly token intensity heatmap
heatmap-cumulative.{svg,png} Cumulative token intensity heatmap
chart-daily.{svg,png}        Daily token trend chart
chart-weekly.{svg,png}       Weekly token trend chart
chart-cumulative.{svg,png}   Cumulative token trend chart
```

PNG export uses `@resvg/resvg-js` for static files. If the native renderer is unavailable, SVG and HTML outputs are still written.

## Authentication and privacy

For live API calls, the CLI reads `auth.json` from the first configured Codex home and sends the access token only in request headers. Tokens are not written to generated reports, JSON, CSV, SVG, PNG, or logs.  
If API access fails, the report records the warning and falls back to the data it can still read locally. Use `--profile-json` or `--analytics-json` for reproducible offline reports from saved API responses.

## Themes

The generated HTML and images use the first selected Codex home configuration. Explicit desktop theme colors take priority. If the config only contains a named theme, the tool tries the upstream `openai/codex` theme definitions and falls back to a bundled local palette for common Codex themes.

## Development

```pwsh
bun test
bun typecheck
bun usage generate --codex-home "C:\Users\EDM115\.codex" --out ./usage
```

The HTML report is intentionally self-contained. Renderer regressions should be covered by tests that extract executable script blocks from the generated HTML and parse them.

## Notes on cost estimates

Cost estimates are best-effort operational estimates, not billing statements. Explicit local models are resolved through the alias effective on their usage date. When a local event has no model, or backend totals contain tokens not covered by local rollouts, the tool selects the newest model released by that date and marked as eligible to be the primary Codex model. `--estimate-model` overrides this inference when a fixed assumption is preferable.  
Bundled model definitions start on their documented release dates and bundled price periods remain effective until the next period for the same model.  
Live pricing complements rather than replaces that history. If a fetched current rate differs from the active bundled rate, the new rate starts on the fetch date, so older usage keeps the older bundled price. Effective-dated custom JSON rows use `effectiveFrom` in `YYYY-MM-DD` format; legacy flat custom rows start on the report's fetch date.  
Cached input, output, service tiers, long-context requests, and unattributed backend-only tokens all use the selected model's price effective on the usage date. The report's cache-savings figure is the API-equivalent difference between uncached input and cached-input prices for the same dated model/tier; it is not subscription money returned. Treat official OpenAI billing exports as authoritative for accounting.
