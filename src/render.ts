import type { DailyUsage, UsageDataset, UsageTheme } from "./types";

import { paymentMonthTotals } from "./payments";
import {
  buildRoiMetrics,
  roiCurveSegments,
  sampleLabelIndexes,
  type RoiMonthMetrics,
} from "./report-runtime";
import { compactNumber, escapeHtml, money } from "./util";

export function renderCapabilitiesPieSvg(dataset: UsageDataset): string {
  const theme = dataset.theme;
  const grouped = new Map<
    string,
    { kind: "skill" | "plugin"; name: string; count: number; latestDate: string }
  >();

  for (const event of dataset.local.capabilityEvents) {
    if (event.confidence !== "high" && event.confidence !== "medium") {
      continue;
    }

    const key = `${event.kind}:${event.name}`;
    const row = grouped.get(key) ?? {
      kind: event.kind,
      name: event.name,
      count: 0,
      latestDate: event.date,
    };
    row.count += 1;
    row.latestDate = row.latestDate.localeCompare(event.date) >= 0 ? row.latestDate : event.date;
    grouped.set(key, row);
  }

  const rows = [...grouped.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.latestDate.localeCompare(a.latestDate) ||
      a.name.localeCompare(b.name) ||
      a.kind.localeCompare(b.kind),
  );
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const visible = rows.slice(0, 8).map((row) => ({
    label: `${row.kind === "plugin" ? "Plugin" : "Skill"} · ${row.name}`,
    count: row.count,
  }));
  const remainder = rows.slice(8).reduce((sum, row) => sum + row.count, 0);

  if (remainder > 0) {
    visible.push({ label: "Other", count: remainder });
  }

  const width = 920;
  const height = 420;
  const titleX = 42;
  const centerX = 225;
  const centerY = 226;
  const radius = 142;
  const legendX = 438;
  const legendY = 94;
  const palette = [
    ...theme.colors.series,
    theme.colors.accent,
    theme.colors.accent2,
    theme.colors.warning,
    theme.colors.muted,
  ].filter((color, index, colors) => colors.indexOf(color) === index);
  const dates = dataset.local.capabilityEvents
    .filter((event) => event.confidence === "high" || event.confidence === "medium")
    .map((event) => event.date)
    .sort();
  const range =
    dates.length > 0
      ? `Every qualifying event · ${dates[0]} to ${dates.at(-1)} · ${compactNumber(total)} total uses`
      : "No high- or medium-confidence usage evidence";

  if (visible.length === 0) {
    return svgWrap(
      width,
      height,
      theme,
      `
    <text x="${titleX}" y="34" class="title">Skills &amp; plugins usage</text>
    <text x="${titleX}" y="56" class="muted">${escapeHtml(range)}</text>
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="muted">No usage events to chart</text>
  `,
    );
  }

  let angle = -Math.PI / 2;
  const slices = visible
    .map((row, index) => {
      const fraction = row.count / total;
      const nextAngle = angle + fraction * Math.PI * 2;
      const color = palette[index % palette.length];
      const title = `${row.label} : ${compactNumber(row.count)} uses (${(fraction * 100).toFixed(1)}%)`;
      let shape: string;

      if (visible.length === 1) {
        shape = `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="${color}" stroke="${theme.colors.bg}" stroke-width="2">`;
      } else {
        const startX = centerX + Math.cos(angle) * radius;
        const startY = centerY + Math.sin(angle) * radius;
        const endX = centerX + Math.cos(nextAngle) * radius;
        const endY = centerY + Math.sin(nextAngle) * radius;
        const largeArc = fraction > 0.5 ? 1 : 0;
        shape = `<path d="M ${centerX} ${centerY} L ${startX.toFixed(3)} ${startY.toFixed(3)} A ${radius} ${radius} 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)} Z" fill="${color}" stroke="${theme.colors.bg}" stroke-width="2">`;
      }

      angle = nextAngle;

      return `${shape}<title>${escapeHtml(title)}</title>${visible.length === 1 ? "</circle>" : "</path>"}`;
    })
    .join("\n");
  const legend = visible
    .map((row, index) => {
      const y = legendY + index * 34;
      const color = palette[index % palette.length];
      const fraction = row.count / total;
      const label = row.label.length > 38 ? `${row.label.slice(0, 37)}…` : row.label;

      return `<rect x="${legendX}" y="${y - 12}" width="14" height="14" rx="3" fill="${color}"/><text x="${legendX + 24}" y="${y}" class="legend-label">${escapeHtml(label)}</text><text x="${width - 42}" y="${y}" text-anchor="end" class="legend-value">${escapeHtml(`${compactNumber(row.count)} · ${(fraction * 100).toFixed(1)}%`)}</text>`;
    })
    .join("\n");

  return svgWrap(
    width,
    height,
    theme,
    `
    <text x="${titleX}" y="34" class="title">Skills &amp; plugins usage</text>
    <text x="${titleX}" y="56" class="muted">${escapeHtml(range)}</text>
    ${slices}
    ${legend}
  `,
    `
    .legend-label { fill: ${theme.colors.text}; font-size: 13px; }
    .legend-value { fill: ${theme.colors.muted}; font-size: 12px; font-family: ${theme.fonts.code}; }
  `,
  );
}

export function renderHeatmapSvg(
  dataset: UsageDataset,
  mode: "daily" | "weekly" | "cumulative",
): string {
  const theme = dataset.theme;
  const colors = theme.colors.cells;
  const cell = 14;
  const gap = 4;
  const top = 34;
  const left = 42;
  const values = valueMap(dataset.daily, mode);
  const max = Math.max(1, ...values.map((day) => day.value));
  const columns = Math.max(1, Math.ceil(values.length / 7));
  const width = Math.max(820, left + columns * (cell + gap) + 34);
  const gridHeight = 7 * cell + 6 * gap;
  const legendY = top + gridHeight + 16;
  const height = legendY + 32;
  const rects = values
    .map((day, index) => {
      const row = index % 7;
      const col = Math.floor(index / 7);
      const x = left + col * (cell + gap);
      const y = top + row * (cell + gap);
      const fill = colorFor(day.value, max, colors);

      return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${fill}">
      <title>${escapeHtml(`${day.date} : ${compactNumber(day.value)} tokens, local ${compactNumber(day.localTokens)}, cost ${money(day.cost)}`)}</title>
    </rect>`;
    })
    .join("\n");

  return svgWrap(
    width,
    height,
    theme,
    `
    <text x="${left}" y="22" class="title">Codex token activity - ${mode}</text>
    ${rects}
    ${legend(width - 190, legendY, colors)}
  `,
  );
}

export function renderChartSvg(
  dataset: UsageDataset,
  mode: "daily" | "weekly" | "cumulative",
  style: "bar" | "area" = mode === "daily" ? "bar" : "area",
): string {
  const theme = dataset.theme;
  const series =
    mode === "weekly"
      ? dataset.weekly.map((week) => ({
          label: week.weekStart,
          value: week.totalTokens,
          cost: week.estimatedCostUsd,
        }))
      : dataset.daily.map((day) => ({
          label: day.date,
          value: day.totalTokens,
          cost: day.estimatedCostUsd,
        }));

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
  const yTicks = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const y = pad.top + chartH - fraction * chartH;

      return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}" class="grid"/><text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" class="axis">${compactNumber(max * fraction)}</text>`;
    })
    .join("\n");

  const body =
    style === "bar"
      ? points
          .map((point, index) => {
            const barW = Math.max(2, chartW / Math.max(1, points.length) - 2);
            const x = pad.left + index * (chartW / Math.max(1, points.length));
            const h = pad.top + chartH - point.y;

            return `<rect x="${x}" y="${point.y}" width="${barW}" height="${h}" fill="${theme.colors.accent}"><title>${escapeHtml(`${point.label} : ${compactNumber(point.value)} tokens, ${money(point.cost)}`)}</title></rect>`;
          })
          .join("\n")
      : renderArea(points, pad.top + chartH, theme);
  const xLabelIndexes = new Set(sampleLabelIndexes(points.length, 8));
  const xTicks = points
    .filter((_, index) => xLabelIndexes.has(index))
    .map(
      (point) =>
        `<text x="${point.x}" y="${height - 18}" text-anchor="middle" class="axis">${escapeHtml(point.label)}</text>`,
    )
    .join("\n");

  return svgWrap(
    width,
    height,
    theme,
    `
    <text x="${pad.left}" y="24" class="title">Token activity - ${mode}</text>
    ${yTicks}
    ${body}
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + chartH}" y2="${pad.top + chartH}" class="axis-line"/>
    ${xTicks}
  `,
  );
}

export function renderRoiSvg(dataset: UsageDataset): string {
  const theme = dataset.theme;
  const payments = paymentMonthTotals(dataset.payments);
  const usageDates = dataset.daily.map((day) => day.date).sort();
  const paymentMonths = Object.keys(payments).sort();
  const from = [usageDates[0], paymentMonths[0] ? `${paymentMonths[0]}-01` : undefined]
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const to = [usageDates.at(-1), paymentMonths.at(-1) ? monthEnd(paymentMonths.at(-1)!) : undefined]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const width = 920;
  const height = 390;

  if (!from || !to) {
    return svgWrap(
      width,
      height,
      theme,
      `<text x="42" y="28" class="title">Return on investment</text><text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="muted">No usage or payment history to chart</text>`,
    );
  }

  const metrics = buildRoiMetrics(dataset.daily, payments, from, to);
  const months = metrics.monthly;
  const evidenceMonths = new Set([
    ...dataset.daily.map((day) => day.date.slice(0, 7)),
    ...paymentMonths,
  ]);
  const pad = { left: 78, right: 78, top: 42, bottom: 80 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const maximum = Math.max(1, ...months.flatMap((month) => [month.amountPaid, month.estimatedApiValue]));
  const roiValues = months
    .map((month) => month.conventionalRoiPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  let roiMinimum = Math.min(0, ...roiValues);
  let roiMaximum = Math.max(0, ...roiValues);

  if (roiMinimum === roiMaximum) {
    roiMinimum -= 1;
    roiMaximum += 1;
  }

  const xFor = (index: number) =>
    months.length <= 1 ? pad.left + chartW / 2 : pad.left + (index / (months.length - 1)) * chartW;
  const moneyYFor = (value: number) => pad.top + chartH - (value / maximum) * chartH;
  const roiYFor = (value: number) =>
    pad.top + chartH - ((value - roiMinimum) / (roiMaximum - roiMinimum)) * chartH;
  const pointsFor = (key: "amountPaid" | "estimatedApiValue") =>
    months.map((month, index) => ({ x: xFor(index), y: moneyYFor(month[key]), month }));
  const evidenceSegments = (points: Array<{ x: number; y: number; month: RoiMonthMetrics }>) => {
    const segments: Array<Array<{ x: number; y: number; month: RoiMonthMetrics }>> = [];
    let current: Array<{ x: number; y: number; month: RoiMonthMetrics }> = [];

    for (const point of points) {
      if (!evidenceMonths.has(point.month.month)) {
        if (current.length) segments.push(current);
        current = [];
      } else {
        current.push(point);
      }
    }

    if (current.length) segments.push(current);
    return segments;
  };
  const spendPoints = pointsFor("amountPaid");
  const valuePoints = pointsFor("estimatedApiValue");
  const monthIndexes = new Map(months.map((month, index) => [month.month, index]));
  const roiSegments = roiCurveSegments(months).flatMap((segment) =>
    evidenceSegments(
      segment.map((month) => ({
        x: xFor(monthIndexes.get(month.month)!),
        y: roiYFor(month.conventionalRoiPercent!),
        month,
      })),
    ),
  );
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const y = pad.top + chartH - fraction * chartH;
      const roiTick = roiMinimum + (roiMaximum - roiMinimum) * fraction;
      return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}" class="grid"/><text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" class="axis">${escapeHtml(money(maximum * fraction))}</text><text x="${width - pad.right + 10}" y="${y + 4}" class="roi-axis">${escapeHtml(signedPercent(roiTick))}</text>`;
    })
    .join("\n");
  const roiPaths = roiSegments
    .map((segment) => `<path class="roi-percent-line" d="M ${segment[0].x} ${segment[0].y}${smoothCurveCommands(segment)}"/>`)
    .join("\n");
  const spendPaths = evidenceSegments(spendPoints)
    .map((segment) => `<path class="roi-spend-line" d="M ${segment[0].x} ${segment[0].y}${smoothCurveCommands(segment)}"/>`)
    .join("\n");
  const valuePaths = evidenceSegments(valuePoints)
    .map((segment) => `<path class="roi-value-line" d="M ${segment[0].x} ${segment[0].y}${smoothCurveCommands(segment)}"/>`)
    .join("\n");
  const labelIndexes = new Set(sampleLabelIndexes(months.length, 8));
  const pointsAndLabels = months
    .map((month, index) => {
      const x = xFor(index);
      const label = labelIndexes.has(index) ? `<text x="${x}" y="${height - 50}" text-anchor="middle" class="axis">${escapeHtml(month.month)}</text>` : "";

      if (!evidenceMonths.has(month.month)) return label;

      const roiDot = month.conventionalRoiPercent === null ? "" : `<circle class="roi-percent-dot" cx="${x}" cy="${roiYFor(month.conventionalRoiPercent)}" r="4"/>`;
      return `${roiDot}<circle class="roi-spend-dot" cx="${x}" cy="${moneyYFor(month.amountPaid)}" r="4"/><circle class="roi-value-dot" cx="${x}" cy="${moneyYFor(month.estimatedApiValue)}" r="4"/>${label}`;
    })
    .join("\n");

  return svgWrap(
    width,
    height,
    theme,
    `
    <text x="${pad.left}" y="26" class="title">Return on investment</text>
    ${grid}
    ${roiPaths}
    ${spendPaths}
    ${valuePaths}
    ${pointsAndLabels}
    ${roiLegend(pad.left, height - 20)}
  `,
    `
    .roi-spend-line, .roi-value-line, .roi-percent-line { fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    .roi-spend-line { stroke: #ff5555; }
    .roi-value-line { stroke: #50fa7b; }
    .roi-percent-line { stroke: #f1fa8c; stroke-opacity: .55; }
    .roi-spend-dot { fill: #ff5555; }
    .roi-value-dot { fill: #50fa7b; }
    .roi-percent-dot { fill: #f1fa8c; fill-opacity: .55; }
    .roi-axis { fill: #f1fa8c; font-size: 11px; }
    .roi-legend { fill: ${theme.colors.muted}; font-size: 12px; }
  `,
  );
}

function renderArea(
  points: Array<{ x: number; y: number; value: number; label: string; cost: number }>,
  baseline: number,
  theme: UsageTheme,
): string {
  if (points.length === 0) {
    return "";
  }

  const curve = smoothCurveCommands(points);
  const line = `M ${points[0].x} ${points[0].y}${curve}`;
  const area = `M ${points[0].x} ${baseline} L ${points[0].x} ${points[0].y}${curve} L ${points.at(-1)!.x} ${baseline} Z`;
  const circles = points
    .map(
      (point) =>
        `<circle cx="${point.x}" cy="${point.y}" r="3" fill="${theme.colors.accent}"><title>${escapeHtml(`${point.label} : ${compactNumber(point.value)} tokens, ${money(point.cost)}`)}</title></circle>`,
    )
    .join("\n");

  return `<path class="area" d="${area}" fill="${theme.colors.accent}" opacity="0.22"/><path class="line" d="${line}" fill="none" stroke="${theme.colors.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${circles}`;
}

function smoothCurveCommands(points: Array<{ x: number; y: number }>): string {
  let path = "";

  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const following = points[index + 2] ?? next;
    if (Math.abs(next.y - current.y) <= 0.5) {
      path += ` L ${next.x} ${next.y}`;
      continue;
    }
    const control1X = current.x + (next.x - previous.x) / 6;
    const control1Y = current.y + (next.y - previous.y) / 6;
    const control2X = next.x - (following.x - current.x) / 6;
    const control2Y = next.y - (following.y - current.y) / 6;
    path += ` C ${control1X.toFixed(3)} ${control1Y.toFixed(3)} ${control2X.toFixed(3)} ${control2Y.toFixed(3)} ${next.x} ${next.y}`;
  }

  return path;
}

function valueMap(
  daily: DailyUsage[],
  mode: "daily" | "weekly" | "cumulative",
): Array<{ date: string; value: number; localTokens: number; cost: number }> {
  let cumulative = 0;
  const weekly = new Map<string, number>();

  if (mode === "weekly") {
    for (let i = 0; i < daily.length; i += 7) {
      const slice = daily.slice(i, i + 7);
      const total = slice.reduce((sum, day) => sum + day.totalTokens, 0);

      for (const day of slice) {
        weekly.set(day.date, total);
      }
    }
  }

  return daily.map((day) => {
    cumulative += day.totalTokens;

    return {
      date: day.date,
      value:
        mode === "daily"
          ? day.totalTokens
          : mode === "weekly"
            ? (weekly.get(day.date) ?? 0)
            : cumulative,
      localTokens: day.localTokens.totalTokens,
      cost: day.estimatedCostUsd,
    };
  });
}

function colorFor(value: number, max: number, colors: string[]): string {
  if (value <= 0) {
    return colors[0];
  }

  const index = Math.min(
    colors.length - 1,
    Math.max(1, Math.ceil((value / max) * (colors.length - 1))),
  );

  return colors[index];
}

function legend(x: number, y: number, colors: string[]): string {
  return (
    colors
      .map(
        (color, index) =>
          `<rect x="${x + index * 22}" y="${y}" width="16" height="16" rx="3" fill="${color}"/>`,
      )
      .join("\n") +
    `<text x="${x - 8}" y="${y + 13}" text-anchor="end" class="muted">Less</text><text x="${x + colors.length * 22 + 4}" y="${y + 13}" class="muted">More</text>`
  );
}

function roiLegend(x: number, y: number): string {
  const entries = [
    { color: "#ff5555", label: "Amount paid", opacity: 1 },
    { color: "#50fa7b", label: "Estimated API value", opacity: 1 },
    { color: "#f1fa8c", label: "Conventional ROI", opacity: 0.55 },
  ];
  let offset = x;

  return entries
    .map((entry) => {
      const item = `<line x1="${offset}" x2="${offset + 18}" y1="${y - 4}" y2="${y - 4}" stroke="${entry.color}" stroke-opacity="${entry.opacity}" stroke-width="3" stroke-linecap="round"/><text x="${offset + 25}" y="${y}" class="roi-legend">${entry.label}</text>`;
      offset += entry.label.length * 7 + 58;
      return item;
    })
    .join("\n");
}

function monthEnd(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}%`;
}

function svgWrap(
  width: number,
  height: number,
  theme: UsageTheme,
  body: string,
  extraCss = "",
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    svg { background: ${theme.colors.bg}; color: ${theme.colors.text}; font-family: ${theme.fonts.ui}; }
    .title { fill: ${theme.colors.text}; font-size: 18px; font-weight: 700; }
    .muted { fill: ${theme.colors.muted}; font-size: 12px; }
    .axis { fill: ${theme.colors.muted}; font-size: 11px; }
    .grid { stroke: ${theme.colors.line}; stroke-width: 1; }
    .axis-line { stroke: ${theme.colors.line}; stroke-width: 1; }
    ${extraCss}
  </style>
  ${body}
</svg>`;
}
