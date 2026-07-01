import type { DailyUsage, UsageDataset, UsageTheme } from "./types";
import { compactNumber, escapeHtml, money } from "./util";

export function renderHeatmapSvg(dataset: UsageDataset, mode: "daily" | "weekly" | "cumulative"): string {
  const theme = dataset.theme;
  const colors = theme.colors.cells;
  const cell = 14;
  const gap = 4;
  const top = 34;
  const left = 42;
  const values = valueMap(dataset.daily, mode);
  const max = Math.max(1, ...values.map((day) => day.value));
  const weeks = Math.ceil(dataset.daily.length / 7);
  const width = Math.max(820, left + weeks * (cell + gap) + 34);
  const footerY = top + 7 * (cell + gap) + 32;
  const height = footerY + 70;
  const rects = values.map((day, index) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const weekday = date.getUTCDay();
    const col = Math.floor(index / 7);
    const x = left + col * (cell + gap);
    const y = top + weekday * (cell + gap);
    const fill = colorFor(day.value, max, colors);
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${fill}">
      <title>${escapeHtml(`${day.date}: ${compactNumber(day.value)} tokens; local ${compactNumber(day.localTokens)}; cost ${money(day.cost)}`)}</title>
    </rect>`;
  }).join("\n");
  const sourceText = `Profile totals are authoritative when available. Local rollout detail comes from ${dataset.codexHomes.length} .codex source(s). Theme: ${theme.name}.`;
  return svgWrap(width, height, theme, `
    <text x="${left}" y="22" class="title">Codex token activity - ${mode}</text>
    ${rects}
    ${textLines(sourceText, left, footerY, Math.max(48, Math.floor((width - left - 250) / 6.2)), "muted")}
    ${legend(width - 190, footerY - 12, colors)}
  `);
}

export function renderChartSvg(dataset: UsageDataset, mode: "daily" | "weekly" | "cumulative", style: "bar" | "area" = mode === "daily" ? "bar" : "area"): string {
  const theme = dataset.theme;
  const series = mode === "weekly"
    ? dataset.weekly.map((week) => ({ label: week.weekStart, value: week.totalTokens, cost: week.estimatedCostUsd }))
    : dataset.daily.map((day) => ({ label: day.date, value: day.totalTokens, cost: day.estimatedCostUsd }));
  if (mode === "cumulative") {
    let total = 0;
    for (const point of series) {
      total += point.value;
      point.value = total;
    }
  }
  const width = 920;
  const height = 360;
  const pad = { left: 72, right: 28, top: 42, bottom: 54 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.map((point) => point.value));
  const points = series.map((point, index) => {
    const x = pad.left + (series.length <= 1 ? 0 : (index / (series.length - 1)) * chartW);
    const y = pad.top + chartH - (point.value / max) * chartH;
    return { ...point, x, y };
  });
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const y = pad.top + chartH - fraction * chartH;
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}" class="grid"/><text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" class="axis">${compactNumber(max * fraction)}</text>`;
  }).join("\n");

  const body = style === "bar"
    ? points.map((point, index) => {
        const barW = Math.max(2, chartW / Math.max(1, points.length) - 2);
        const x = pad.left + index * (chartW / Math.max(1, points.length));
        const h = pad.top + chartH - point.y;
        return `<rect x="${x}" y="${point.y}" width="${barW}" height="${h}" fill="${theme.colors.accent}"><title>${escapeHtml(`${point.label}: ${compactNumber(point.value)} tokens; ${money(point.cost)}`)}</title></rect>`;
      }).join("\n")
    : renderArea(points, pad.top + chartH, theme);

  return svgWrap(width, height, theme, `
    <text x="${pad.left}" y="24" class="title">Token activity - ${mode}</text>
    ${yTicks}
    ${body}
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + chartH}" y2="${pad.top + chartH}" class="axis-line"/>
    <text x="${pad.left}" y="${height - 18}" class="muted">${escapeHtml(series[0]?.label ?? "")}</text>
    <text x="${width - pad.right}" y="${height - 18}" text-anchor="end" class="muted">${escapeHtml(series.at(-1)?.label ?? "")}</text>
  `);
}

function renderArea(points: Array<{ x: number; y: number; value: number; label: string; cost: number }>, baseline: number, theme: UsageTheme): string {
  if (points.length === 0) return "";
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${points[0].x},${baseline} ${line} ${points.at(-1)!.x},${baseline}`;
  const circles = points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3" fill="${theme.colors.accent}"><title>${escapeHtml(`${point.label}: ${compactNumber(point.value)} tokens; ${money(point.cost)}`)}</title></circle>`).join("\n");
  return `<polygon points="${area}" fill="${theme.colors.accent}" opacity="0.22"/><polyline points="${line}" fill="none" stroke="${theme.colors.accent}" stroke-width="3"/>${circles}`;
}

function valueMap(daily: DailyUsage[], mode: "daily" | "weekly" | "cumulative"): Array<{ date: string; value: number; localTokens: number; cost: number }> {
  let cumulative = 0;
  const weekly = new Map<string, number>();
  if (mode === "weekly") {
    for (let i = 0; i < daily.length; i += 7) {
      const slice = daily.slice(i, i + 7);
      const total = slice.reduce((sum, day) => sum + day.totalTokens, 0);
      for (const day of slice) weekly.set(day.date, total);
    }
  }
  return daily.map((day) => {
    cumulative += day.totalTokens;
    return {
      date: day.date,
      value: mode === "daily" ? day.totalTokens : mode === "weekly" ? (weekly.get(day.date) ?? 0) : cumulative,
      localTokens: day.localTokens.totalTokens,
      cost: day.estimatedCostUsd,
    };
  });
}

function colorFor(value: number, max: number, colors: string[]): string {
  if (value <= 0) return colors[0];
  const index = Math.min(colors.length - 1, Math.max(1, Math.ceil((value / max) * (colors.length - 1))));
  return colors[index];
}

function legend(x: number, y: number, colors: string[]): string {
  return colors.map((color, index) => `<rect x="${x + index * 22}" y="${y}" width="16" height="16" rx="3" fill="${color}"/>`).join("\n")
    + `<text x="${x - 8}" y="${y + 13}" text-anchor="end" class="muted">Less</text><text x="${x + colors.length * 22 + 4}" y="${y + 13}" class="muted">More</text>`;
}

function textLines(text: string, x: number, y: number, maxChars: number, className: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (`${current} ${word}`.trim().length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3).map((line, index) => `<text x="${x}" y="${y + index * 16}" class="${className}">${escapeHtml(line)}</text>`).join("\n");
}

function svgWrap(width: number, height: number, theme: UsageTheme, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    svg { background: ${theme.colors.bg}; color: ${theme.colors.text}; font-family: ${theme.fonts.ui}; }
    .title { fill: ${theme.colors.text}; font-size: 18px; font-weight: 700; }
    .muted { fill: ${theme.colors.muted}; font-size: 12px; }
    .axis { fill: ${theme.colors.muted}; font-size: 11px; }
    .grid { stroke: ${theme.colors.line}; stroke-width: 1; }
    .axis-line { stroke: ${theme.colors.line}; stroke-width: 1; }
  </style>
  ${body}
</svg>`;
}