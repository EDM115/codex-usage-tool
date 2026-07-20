import type { ProgressSink } from "./progress"
import type { UsageDataset } from "./types"

import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { renderChartSvg, renderHeatmapSvg } from "./render"
import { renderReportHtml } from "./report-html"
import { ensureDir } from "./util"

export type ExportResult = {
  files: string[]
  warnings: string[]
}

type SvgOutput = {
  path: string
  svg: string
}

export async function writeOutputs(
  dataset: UsageDataset,
  outDir: string,
  options: { includePng: boolean; reportOnly?: boolean; progress?: ProgressSink },
): Promise<ExportResult> {
  ensureDir(outDir)
  const files: string[] = []
  const warnings: string[] = []

  const dataPath = join(outDir, "usage-data.json")
  writeFileSync(dataPath, JSON.stringify(dataset, null, 2), "utf8")
  files.push(dataPath)
  options.progress?.step("Generated JSON data")

  const csvPath = join(outDir, "cost-estimate.csv")
  writeFileSync(csvPath, costCsv(dataset), "utf8")
  files.push(csvPath)
  options.progress?.step("Generated CSV estimate")

  const svgOutputs: SvgOutput[] = []

  if (!options.reportOnly) {
    const plannedSvg = svgOutputCount()
    options.progress?.status(`Generating ${plannedSvg} SVG`)
    let svgIndex = 0

    for (const mode of ["daily", "weekly", "cumulative"] as const) {
      const heatmap = renderHeatmapSvg(dataset, mode)
      const heatmapPath = join(outDir, `heatmap-${mode}.svg`)
      writeFileSync(heatmapPath, heatmap, "utf8")
      files.push(heatmapPath)
      svgOutputs.push({ path: heatmapPath, svg: heatmap })
      svgIndex += 1
      options.progress?.statusProgress(`Generating SVG ${svgIndex}/${plannedSvg}`, svgIndex, plannedSvg)

      const chart = renderChartSvg(dataset, mode)
      const chartPath = join(outDir, `chart-${mode}.svg`)
      writeFileSync(chartPath, chart, "utf8")
      files.push(chartPath)
      svgOutputs.push({ path: chartPath, svg: chart })
      svgIndex += 1
      options.progress?.statusProgress(`Generating SVG ${svgIndex}/${plannedSvg}`, svgIndex, plannedSvg)

      for (const style of ["bar", "area"] as const) {
        if (style === "bar" && mode === "cumulative") {
          continue
        }

        const styledChart = renderChartSvg(dataset, mode, style)
        const styledPath = join(outDir, `${style}-${mode}.svg`)
        writeFileSync(styledPath, styledChart, "utf8")
        files.push(styledPath)
        svgOutputs.push({ path: styledPath, svg: styledChart })
        svgIndex += 1
        options.progress?.statusProgress(`Generating SVG ${svgIndex}/${plannedSvg}`, svgIndex, plannedSvg)
      }
    }

    options.progress?.statusDone(`Generated ${svgOutputs.length} SVG`)

    if (options.includePng) {
      options.progress?.status(`Generating ${svgOutputs.length} PNG`)

      for (const [index, output] of svgOutputs.entries()) {
        const message = `Generating PNG ${index + 1}/${svgOutputs.length}`
        options.progress?.status(message)
        const png = await tryWritePng(output.svg, output.path.replace(/\.svg$/, ".png"))

        if (png.ok) {
          files.push(png.path)
        } else {
          warnings.push(png.warning)
        }

        options.progress?.statusProgress(message, index + 1, svgOutputs.length)
      }

      options.progress?.statusDone(
        `Generated ${svgOutputs.length} PNG`,
        warnings.length ? "failure" : "success",
      )
    }
  }

  const htmlPath = join(outDir, "usage-report.html")
  writeFileSync(htmlPath, renderReportHtml(dataset), "utf8")
  files.push(htmlPath)
  options.progress?.step("Generated HTML report")

  return { files, warnings: [...new Set(warnings)] }
}

export function outputProgressWeights(options: { includePng: boolean; reportOnly?: boolean }): number[] {
  if (options.reportOnly) {
    return [1, 1, 1]
  }

  return options.includePng ? [1, 1, 3, 6, 1] : [1, 1, 3, 1]
}

function svgOutputCount(): number {
  return 11
}

async function tryWritePng(
  svg: string,
  pngPath: string,
): Promise<{ ok: true; path: string } | { ok: false; warning: string }> {
  try {
    const { Resvg } = await import("@resvg/resvg-js")
    const renderer = new Resvg(svg, {
      fitTo: { mode: "original" },
      background: "#050811",
    })
    const png = renderer.render().asPng()
    writeFileSync(pngPath, png)

    return { ok: true, path: pngPath }
  } catch (error) {
    return {
      ok: false,
      warning: `PNG export skipped : ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function costCsv(dataset: UsageDataset): string {
  const rows = [
    [
      "date",
      "total_tokens",
      "backend_tokens",
      "local_known_tokens",
      "unattributed_tokens",
      "known_local_cost_usd",
      "estimated_unattributed_cost_usd",
      "estimated_total_cost_usd",
    ],
    ...dataset.daily.map((day) => [
      day.date,
      String(day.totalTokens),
      String(day.backendTokens ?? ""),
      String(day.localTokens.totalTokens),
      String(day.unattributedTokens),
      day.knownLocalCostUsd.toFixed(6),
      day.estimatedUnattributedCostUsd.toFixed(6),
      day.estimatedCostUsd.toFixed(6),
    ]),
  ]

  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n"
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) {
    return value
  }

  return `"${value.replaceAll('"', '""')}"`
}
