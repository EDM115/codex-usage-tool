import { writeFileSync } from "node:fs";
import path from "node:path";
import type { UsageDataset } from "./types";
import { ensureDir } from "./util";
import { renderChartSvg, renderHeatmapSvg } from "./render";
import { renderReportHtml } from "./report-html";

export type ExportResult = {
  files: string[];
  warnings: string[];
};

export async function writeOutputs(dataset: UsageDataset, outDir: string, options: { includePng: boolean; reportOnly?: boolean }): Promise<ExportResult> {
  ensureDir(outDir);
  const files: string[] = [];
  const warnings: string[] = [];

  const dataPath = path.join(outDir, "usage-data.json");
  writeFileSync(dataPath, JSON.stringify(dataset, null, 2), "utf8");
  files.push(dataPath);

  const csvPath = path.join(outDir, "cost-estimate.csv");
  writeFileSync(csvPath, costCsv(dataset), "utf8");
  files.push(csvPath);

  if (!options.reportOnly) {
    for (const mode of ["daily", "weekly", "cumulative"] as const) {
      const heatmap = renderHeatmapSvg(dataset, mode);
      const heatmapPath = path.join(outDir, `heatmap-${mode}.svg`);
      writeFileSync(heatmapPath, heatmap, "utf8");
      files.push(heatmapPath);
      const chart = renderChartSvg(dataset, mode);
      const chartPath = path.join(outDir, `chart-${mode}.svg`);
      writeFileSync(chartPath, chart, "utf8");
      files.push(chartPath);
      for (const style of ["bar", "area"] as const) {
        if (style === "bar" && mode === "cumulative") continue;
        const styledChart = renderChartSvg(dataset, mode, style);
        const styledPath = path.join(outDir, `${style}-${mode}.svg`);
        writeFileSync(styledPath, styledChart, "utf8");
        files.push(styledPath);
        if (options.includePng) {
          const styledPng = await tryWritePng(styledChart, styledPath.replace(/\.svg$/, ".png"));
          if (styledPng.ok) files.push(styledPng.path!);
          else warnings.push(styledPng.warning!);
        }
      }
      if (options.includePng) {
        const heatmapPng = await tryWritePng(heatmap, heatmapPath.replace(/\.svg$/, ".png"));
        if (heatmapPng.ok) files.push(heatmapPng.path!);
        else warnings.push(heatmapPng.warning!);
        const chartPng = await tryWritePng(chart, chartPath.replace(/\.svg$/, ".png"));
        if (chartPng.ok) files.push(chartPng.path!);
        else warnings.push(chartPng.warning!);
      }
    }
  }

  const htmlPath = path.join(outDir, "usage-report.html");
  writeFileSync(htmlPath, renderReportHtml(dataset), "utf8");
  files.push(htmlPath);
  return { files, warnings: [...new Set(warnings)] };
}

async function tryWritePng(svg: string, pngPath: string): Promise<{ ok: true; path: string } | { ok: false; warning: string }> {
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const renderer = new Resvg(svg, {
      fitTo: { mode: "original" },
      background: "#050811",
    });
    const png = renderer.render().asPng();
    writeFileSync(pngPath, png);
    return { ok: true, path: pngPath };
  } catch (error) {
    return { ok: false, warning: `PNG export skipped: ${error instanceof Error ? error.message : String(error)}` };
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
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
