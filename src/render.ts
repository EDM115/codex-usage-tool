import type { DailyUsage, UsageDataset, UsageTheme } from "./types";

import { compactNumber, escapeHtml, money, pluralize } from "./util";

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
  const weeks = Math.ceil(dataset.daily.length / 7);
  const width = Math.max(820, left + weeks * (cell + gap) + 34);
  const footerY = top + 7 * (cell + gap) + 32;
  const height = footerY + 70;
  const rects = values
    .map((day, index) => {
      const date = new Date(`${day.date}T00:00:00Z`);
      const weekday = date.getUTCDay();
      const col = Math.floor(index / 7);
      const x = left + col * (cell + gap);
      const y = top + weekday * (cell + gap);
      const fill = colorFor(day.value, max, colors);

      return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${fill}">
      <title>${escapeHtml(`${day.date} : ${compactNumber(day.value)} tokens, local ${compactNumber(day.localTokens)}, cost ${money(day.cost)}`)}</title>
    </rect>`;
    })
    .join("\n");
  const sourceText = `Profile totals are authoritative when available. Local rollout detail comes from ${dataset.codexHomes.length} .codex ${pluralize("source", dataset.codexHomes.length)}. Theme : ${theme.name}.`;

  return svgWrap(
    width,
    height,
    theme,
    `
    <text x="${left}" y="22" class="title">Codex token activity - ${mode}</text>
    ${rects}
    ${textLines(sourceText, left, footerY, Math.max(48, Math.floor((width - left - 250) / 6.2)), "muted")}
    ${legend(width - 190, footerY - 12, colors)}
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

  return svgWrap(
    width,
    height,
    theme,
    `
    <text x="${pad.left}" y="24" class="title">Token activity - ${mode}</text>
    ${yTicks}
    ${body}
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + chartH}" y2="${pad.top + chartH}" class="axis-line"/>
    <text x="${pad.left}" y="${height - 18}" class="muted">${escapeHtml(series[0]?.label ?? "")}</text>
    <text x="${width - pad.right}" y="${height - 18}" text-anchor="end" class="muted">${escapeHtml(series.at(-1)?.label ?? "")}</text>
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

  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${points[0].x},${baseline} ${line} ${points.at(-1)!.x},${baseline}`;
  const circles = points
    .map(
      (point) =>
        `<circle cx="${point.x}" cy="${point.y}" r="3" fill="${theme.colors.accent}"><title>${escapeHtml(`${point.label} : ${compactNumber(point.value)} tokens, ${money(point.cost)}`)}</title></circle>`,
    )
    .join("\n");

  return `<polygon points="${area}" fill="${theme.colors.accent}" opacity="0.22"/><polyline points="${line}" fill="none" stroke="${theme.colors.accent}" stroke-width="3"/>${circles}`;
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

function textLines(
  text: string,
  x: number,
  y: number,
  maxChars: number,
  className: string,
): string {
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

  if (current) {
    lines.push(current);
  }

  return lines
    .slice(0, 3)
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * 16}" class="${className}">${escapeHtml(line)}</text>`,
    )
    .join("\n");
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
