import type { UsageDataset } from "./types";
import type { ReportSection } from "./sections";

type Point = { date: string; values: Record<string, number> };
type Chart = { name: string; title: string; points: Point[]; unit: string };

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function renderExtendedChartSvgs(dataset: UsageDataset, sections: readonly ReportSection[]): Array<{ name: string; svg: string }> {
  const enabled = new Set(sections);
  const daily = dataset.analytics?.dailyTokenUsageBreakdown?.data ?? [];
  const workspace = dataset.analytics?.workspaceUsageCounts?.data ?? [];
  const charts: Chart[] = [];
  for (const [section, field, title] of [["feature", "threadSource", "By feature"], ["models", "model", "By model"], ["surfaces", "surface", "By surface"], ["turn", "turnTrigger", "By turn start"]] as const) {
    if (!enabled.has(section) || !daily.length) continue;
    charts.push({ name: `usage-${section}`, title: `Total usage history - ${title}`, unit: "attributed usage", points: daily.map((bucket) => {
      const values: Record<string, number> = {};
      for (const row of bucket.attribution ?? []) { const key = categoryName(row[field]); values[key] = (values[key] ?? 0) + row.value; }
      return { date: bucket.date, values };
    }) });
  }
  if (enabled.has("skills")) {
    for (const [name, title, source] of [["plugin-activity", "Plugins called", dataset.analytics?.pluginUsage], ["skill-activity", "Skills used", dataset.analytics?.skillUsage]] as const) {
      if (!source?.data.length) continue;
      charts.push({ name, title, unit: "uses", points: source.data.map((bucket) => ({ date: bucket.date, values: Object.fromEntries(bucket.rows.map((row) => [row.label, row.count])) })) });
    }
  }
  for (const [section, name, title, field] of [["messages-model", "messages-model", "Messages by model", "models"], ["messages-surface", "messages-surface", "Messages by surface", "clients"]] as const) {
    if (!enabled.has(section) || !workspace.length) continue;
    charts.push({ name, title, unit: "messages", points: workspace.map((bucket) => {
      const values: Record<string, number> = {};
      for (const row of bucket[field]) {
        const raw = String(field === "models" ? row.model ?? "other" : row.client_id ?? row.clientId ?? "other");
        const label = field === "models" ? (/^other$/i.test(raw) ? "other" : raw) : surfaceName(raw);
        values[label] = (values[label] ?? 0) + Number(row.turns ?? 0);
      }
      values.other = (values.other ?? 0) + Math.max(0, Number(bucket.totals.turns ?? 0) - Object.values(values).reduce((sum, value) => sum + value, 0));
      return { date: bucket.date, values };
    }) });
  }
  return charts.map((chart) => ({ name: chart.name, svg: renderStackedChart(dataset, chart) }));
}

function renderStackedChart(dataset: UsageDataset, chart: Chart): string {
  const points = [...chart.points].sort((a, b) => a.date.localeCompare(b.date));
  const sums = new Map<string, number>();
  for (const point of points) for (const [key, value] of Object.entries(point.values)) sums.set(key, (sums.get(key) ?? 0) + value);
  const categories = [...sums].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const width = Math.max(1100, 130 + points.length * 6);
  const legendRows = Math.ceil(categories.length / 3);
  const height = 410 + legendRows * 25;
  const left = 70;
  const right = width - 30;
  const top = 78;
  const bottom = 335;
  const plotWidth = right - left;
  const plotHeight = bottom - top;
  const maximum = Math.max(1, ...points.map((point) => Object.values(point.values).reduce((sum, value) => sum + value, 0)));
  const palette = dataset.theme.colors.series;
  const color = (index: number) => palette[index % palette.length] ?? dataset.theme.colors.accent;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((fraction) => { const y = bottom - fraction * plotHeight; return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${escape(dataset.theme.colors.line)}"/><text x="${left - 12}" y="${y + 4}" text-anchor="end" fill="${escape(dataset.theme.colors.muted)}" font-size="12">${escape(format(maximum * fraction))}</text>`; }).join("");
  const bars = points.map((point, index) => {
    const step = plotWidth / Math.max(1, points.length);
    const x = left + index * step + Math.max(0.5, step * 0.1);
    const barWidth = Math.max(1, step * 0.8);
    let y = bottom;
    return categories.map((category, categoryIndex) => {
      const value = Math.max(0, point.values[category] ?? 0);
      if (!value) return "";
      const barHeight = value / maximum * plotHeight;
      y -= barHeight;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${escape(color(categoryIndex))}"><title>${escape(`${point.date} - ${category}: ${format(value)} ${chart.unit}`)}</title></rect>`;
    }).join("");
  }).join("");
  const labels = points.filter((_, index) => index % Math.max(1, Math.ceil(points.length / 9)) === 0 || index === points.length - 1).map((point) => { const index = points.indexOf(point); const x = left + (index + 0.5) * plotWidth / Math.max(1, points.length); return `<text x="${x}" y="${bottom + 23}" text-anchor="middle" fill="${escape(dataset.theme.colors.muted)}" font-size="11">${escape(point.date)}</text>`; }).join("");
  const legend = categories.map((category, index) => { const column = index % 3; const row = Math.floor(index / 3); const x = left + column * (plotWidth / 3); const y = 390 + row * 25; return `<rect x="${x}" y="${y - 10}" width="10" height="10" fill="${escape(color(index))}"/><text x="${x + 17}" y="${y}" fill="${escape(dataset.theme.colors.text)}" font-size="12">${escape(category)} - ${escape(format(sums.get(category) ?? 0))}</text>`; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(chart.title)}"><rect width="100%" height="100%" fill="${escape(dataset.theme.colors.bg)}"/><g font-family="${escape(dataset.theme.fonts.ui)}"><text x="${left}" y="35" fill="${escape(dataset.theme.colors.text)}" font-size="21" font-weight="700">${escape(chart.title)}</text><text x="${left}" y="57" fill="${escape(dataset.theme.colors.muted)}" font-size="13">${escape(`${points.length} days - ${chart.unit}`)}</text>${grid}${bars}${labels}${legend}</g></svg>`;
}

function format(value: number): string { return Math.round(value).toLocaleString("en-US"); }

function categoryName(raw: string): string { return /^(gpt-|codex-)/i.test(raw) ? raw : raw.toLowerCase() === "github_code_review" ? "GitHub Code Review" : raw.replace(/^start[-_]/, "").replace(/[_-]/g, " ").replace(/\b\w/g, (match) => match.toUpperCase()); }

function surfaceName(raw: string): string {
  const name = raw.toUpperCase();
  if (["CODEX_DESKTOP_APP", "CODEX_WORK_DESKTOP", "DESKTOP_APP"].includes(name)) return "Desktop App";
  if (["CODEX_IDE_VSCODE", "IDE_VSCODE", "VSCODE"].includes(name)) return "Vscode";
  if (["CODEX_SDK", "SDK"].includes(name)) return "Sdk";
  if (["CODEX_WORK_WEB", "CODEX_WEB"].includes(name)) return "Work Web";
  if (["CODEX_CLI", "CLI"].includes(name)) return "Cli";
  if (["CODEX_GITHUB", "GITHUB_CODE_REVIEW"].includes(name)) return "GitHub Code Review";
  if (["SERVICE_EXEC", "CODEX_EXEC", "EXEC"].includes(name)) return "Exec";
  if (name === "CODEX_WORK_MOBILE") return "Mobile";
  return "other";
}
