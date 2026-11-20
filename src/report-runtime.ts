import type { DailyUsage, UsageTheme } from "./types";

export type ReportRangePreset = "7d" | "30d" | "90d" | "all";
export type ReportDateRange = { from: string; to: string };

export type UsageTrendMode = "daily" | "weekly" | "cumulative";
export const USAGE_TREND_SIZE = { width: 920, height: 330 };

type UsageTrendPoint = {
  label: string;
  tokens: number;
  localTokens: number;
  unattributedTokens: number;
  cost: number;
  costPerMillion: number | null;
};

export type TokenComposition = {
  input: number;
  output: number;
  backendOnly: number;
  localResidual: number;
  unknown: number;
  cachedInput: number;
  uncachedInput: number;
  cacheCounterExcess: number;
  reasoningOutput: number;
  visibleOutput: number;
  reasoningCounterExcess: number;
};

export type RoiStatus = "positive" | "negative" | "break-even";

export type RoiMonthMetrics = {
  month: string;
  amountPaid: number;
  estimatedApiValue: number;
  valueCoveragePercent: number | null;
  conventionalRoiPercent: number | null;
  status: RoiStatus;
  color: string;
};

export type RoiMetrics = {
  amountPaid: number;
  estimatedApiValue: number;
  valueCoveragePercent: number | null;
  conventionalRoiPercent: number | null;
  status: RoiStatus;
  color: string;
  monthly: RoiMonthMetrics[];
};

export type SurfaceUsageDetail = {
  surface: string;
  credits: number;
  percent: number;
  turns: number;
  threads: number;
  users: number;
  textTotalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type SurfaceUsageRow = SurfaceUsageDetail & {
  details?: SurfaceUsageDetail[];
};

export type MergedSurfaceUsageRow = SurfaceUsageDetail & {
  details: SurfaceUsageDetail[];
};

export function rangeForPreset(
  codexDates: string[],
  preset: ReportRangePreset,
  paymentMonths: string[] = [],
): ReportDateRange {
  const sortedCodex = [...new Set(codexDates.filter(isIsoDay))].sort();
  const sortedPayments = [...new Set(paymentMonths.filter(isIsoMonth))].sort();
  if (sortedCodex.length === 0 && sortedPayments.length === 0) {
    return { from: "", to: "" };
  }

  const combinedFrom = [sortedCodex[0], sortedPayments[0] ? `${sortedPayments[0]}-01` : ""]
    .filter(Boolean)
    .sort()[0];
  const combinedTo = [
    sortedCodex.at(-1) ?? "",
    sortedPayments.at(-1) ? monthEndUtc(sortedPayments.at(-1)!) : "",
  ]
    .filter(Boolean)
    .sort()
    .at(-1)!;
  if (preset === "all") {
    return { from: combinedFrom, to: combinedTo };
  }

  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : preset === "90d" ? 90 : 0;
  if (days === 0) {
    throw new Error(`Unknown report range preset ${String(preset)}`);
  }
  const newestCodex = sortedCodex.at(-1) ?? combinedTo;
  return { from: formatUtcDay(addUtcDays(parseUtcDay(newestCodex), -(days - 1))), to: newestCodex };
}

export function sampleLabelIndexes(itemCount: number, maxLabels: number): number[] {
  const count = Math.max(0, Math.floor(itemCount));
  const limit = Math.max(1, Math.floor(maxLabels));
  if (count === 0) {
    return [];
  }
  if (count <= limit) {
    return Array.from({ length: count }, (_, index) => index);
  }
  if (limit === 1) {
    return [count - 1];
  }

  const lastIndex = count - 1;
  return Array.from({ length: limit }, (_, index) =>
    index === limit - 1 ? lastIndex : Math.floor((index * lastIndex) / (limit - 1)),
  );
}

export function mergeSurfaceRows(rows: SurfaceUsageRow[]): MergedSurfaceUsageRow[] {
  const number = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const canonicalName = (value: unknown): string => {
    const surface = String(value || "Unknown").trim() || "Unknown";
    const normalized = surface
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (normalized === "sdk" || normalized === "sdk_ts") return "Sdk";
    if (normalized === "github" || normalized === "github_code_review") return "GitHub";
    if (normalized === "unknown" || normalized === "unknown_default") return "Unknown";
    return surface;
  };
  const groups = new Map<
    string,
    MergedSurfaceUsageRow & { detailMap: Map<string, SurfaceUsageDetail> }
  >();

  for (const row of rows) {
    const surface = canonicalName(row.surface);
    const group = groups.get(surface) ?? {
      surface,
      credits: 0,
      percent: 0,
      turns: 0,
      threads: 0,
      users: 0,
      textTotalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      details: [],
      detailMap: new Map<string, SurfaceUsageDetail>(),
    };
    group.credits += number(row.credits);
    group.percent += number(row.percent);
    group.turns += number(row.turns);
    group.threads += number(row.threads);
    group.users = Math.max(group.users, number(row.users));
    group.textTotalTokens += number(row.textTotalTokens);
    group.inputTokens += number(row.inputTokens);
    group.cachedInputTokens += number(row.cachedInputTokens);
    group.outputTokens += number(row.outputTokens);

    const details = row.details?.length ? row.details : [row];
    for (const detail of details) {
      const detailSurface = String(detail.surface || row.surface || "Unknown");
      const current = group.detailMap.get(detailSurface) ?? {
        surface: detailSurface,
        credits: 0,
        percent: 0,
        turns: 0,
        threads: 0,
        users: 0,
        textTotalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
      current.credits += number(detail.credits);
      current.percent += number(detail.percent);
      current.turns += number(detail.turns);
      current.threads += number(detail.threads);
      current.users = Math.max(current.users, number(detail.users));
      current.textTotalTokens += number(detail.textTotalTokens);
      current.inputTokens += number(detail.inputTokens);
      current.cachedInputTokens += number(detail.cachedInputTokens);
      current.outputTokens += number(detail.outputTokens);
      group.detailMap.set(detailSurface, current);
    }
    groups.set(surface, group);
  }

  return [...groups.values()]
    .map(({ detailMap, ...row }) => ({ ...row, details: [...detailMap.values()] }))
    .sort(
      (a, b) =>
        (b.textTotalTokens || b.turns || b.credits || b.percent) -
        (a.textTotalTokens || a.turns || a.credits || a.percent),
    );
}

export function summarizeTokenComposition(days: DailyUsage[]): TokenComposition {
  let input = 0;
  let output = 0;
  let localTotal = 0;
  let backendOnly = 0;
  let cachedCounter = 0;
  let reasoningCounter = 0;

  for (const day of days) {
    input += day.localTokens.inputTokens;
    output += day.localTokens.outputTokens;
    localTotal += day.localTokens.totalTokens;
    backendOnly += day.unattributedTokens;
    cachedCounter += day.localTokens.cachedInputTokens;
    reasoningCounter += day.localTokens.reasoningOutputTokens;
  }

  const localResidual = Math.max(0, localTotal - input - output);
  const cachedInput = Math.min(input, cachedCounter);
  const reasoningOutput = Math.min(output, reasoningCounter);
  return {
    input,
    output,
    backendOnly,
    localResidual,
    unknown: backendOnly + localResidual,
    cachedInput,
    uncachedInput: Math.max(0, input - cachedInput),
    cacheCounterExcess: Math.max(0, cachedCounter - input),
    reasoningOutput,
    visibleOutput: Math.max(0, output - reasoningOutput),
    reasoningCounterExcess: Math.max(0, reasoningCounter - output),
  };
}

export function buildRoiMetrics(
  days: DailyUsage[],
  paymentsByDate: Record<string, number>,
  from: string,
  to: string,
): RoiMetrics {
  const start = parseUtcDay(from);
  const end = parseUtcDay(to);
  if (start.getTime() > end.getTime()) {
    throw new Error(`ROI range start ${from} is after end ${to}`);
  }

  const byMonth: Record<string, { amountPaid: number; estimatedApiValue: number }> = {};
  const cursor = parseUtcDay(`${from.slice(0, 7)}-01`);
  while (cursor <= end) {
    byMonth[formatUtcDay(cursor).slice(0, 7)] = { amountPaid: 0, estimatedApiValue: 0 };
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  for (const [date, amount] of Object.entries(paymentsByDate)) {
    if (date < from || date > to || !isIsoDay(date)) continue;
    byMonth[date.slice(0, 7)].amountPaid += amount;
  }

  for (const day of days) {
    if (day.date < from || day.date > to || !isIsoDay(day.date)) {
      continue;
    }
    const month = day.date.slice(0, 7);
    const row = byMonth[month] ?? { amountPaid: 0, estimatedApiValue: 0 };
    row.estimatedApiValue += day.estimatedCostUsd;
    byMonth[month] = row;
  }

  const monthly = Object.entries(byMonth)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, values]) => {
      const percentages = roiPercentages(values.amountPaid, values.estimatedApiValue);
      const status = roiStatusFor(values.amountPaid, values.estimatedApiValue);
      return {
        month,
        amountPaid: values.amountPaid,
        estimatedApiValue: values.estimatedApiValue,
        ...percentages,
        status,
        color: roiColorFor(status),
      };
    });
  const amountPaid = monthly.reduce((sum, month) => sum + month.amountPaid, 0);
  const estimatedApiValue = monthly.reduce((sum, month) => sum + month.estimatedApiValue, 0);
  const percentages = roiPercentages(amountPaid, estimatedApiValue);
  const status = roiStatusFor(amountPaid, estimatedApiValue);
  return {
    amountPaid,
    estimatedApiValue,
    ...percentages,
    status,
    color: roiColorFor(status),
    monthly,
  };
}

export function roiCurveSegments(months: RoiMonthMetrics[]): RoiMonthMetrics[][] {
  const segments: RoiMonthMetrics[][] = [];
  let current: RoiMonthMetrics[] = [];

  for (const month of months) {
    if (month.conventionalRoiPercent == null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(month);
  }

  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

export function buildUsageTrend(daily: DailyUsage[], mode: UsageTrendMode): UsageTrendPoint[] {
  const periods = new Map<string, Omit<UsageTrendPoint, "costPerMillion">>();
  let cumulative = { tokens: 0, cost: 0, localTokens: 0, unattributedTokens: 0 };

  for (const day of daily) {
    let label = day.date;
    if (mode === "weekly") {
      const date = parseUtcDay(day.date);
      label = formatUtcDay(addUtcDays(date, 1 - (date.getUTCDay() || 7)));
    }
    const previous = mode === "cumulative" ? cumulative : periods.get(label);
    const period = {
      label,
      tokens: (previous?.tokens ?? 0) + day.totalTokens,
      cost: (previous?.cost ?? 0) + day.estimatedCostUsd,
      localTokens: (previous?.localTokens ?? 0) + day.localTokens.totalTokens,
      unattributedTokens: (previous?.unattributedTokens ?? 0) + day.unattributedTokens,
    };
    periods.set(label, period);
    cumulative = period;
  }

  return [...periods.values()].map((period) => ({
    ...period,
    costPerMillion: period.tokens > 0 ? period.cost / period.tokens * 1_000_000 : null,
  }));
}

export function formatTrendCost(value: number, money: (value: number) => string): string {
  return value > 0 && value < 0.0001 ? `$${value.toPrecision(2)}` : money(value);
}

export function renderUsageTrend(
  series: UsageTrendPoint[],
  mode: UsageTrendMode,
  style: "bar" | "area",
  theme: UsageTheme,
  format: { tokens: (value: number) => string; money: (value: number) => string; escape: (value: string) => string },
  interactive = false,
): string {
  const { width, height } = USAGE_TREND_SIZE;
  const left = 102, right = width - 115, top = 46, baseline = height - 72;
  const plotWidth = right - left, plotHeight = baseline - top;
  const { colors } = theme;
  const tokens = (value: number) => format.escape(format.tokens(value));
  const cost = (value: number) => formatTrendCost(value, format.money);
  const range = mode === "cumulative" ? series.slice(-1) : series;
  const totalTokens = range.reduce((total, point) => total + point.tokens, 0);
  const totalCost = range.reduce((total, point) => total + point.cost, 0);
  const rate = totalTokens > 0 ? totalCost / totalTokens : 0;
  const peakTokens = series.reduce((peak, point) => Math.max(peak, point.tokens), 1);
  const peakCost = series.reduce((peak, point) => Math.max(peak, point.cost), 0);
  // Equal heights mean the period matches the range's weighted cost per token
  const tokenMax = rate > 0 ? Math.max(peakTokens, peakCost / rate) : peakTokens;
  const costMax = rate > 0 ? tokenMax * rate : peakCost || 1;
  const modeLabel = { daily: "Daily", weekly: "Weekly", cumulative: "Cumulative" }[mode];
  const note = rate > 0 ? `Cost above tokens means a higher cost per token than the range average (${cost(rate * 1_000_000)} per 1M tokens)` : "";
  const dash = "6 4";
  const step = plotWidth / Math.max(1, series.length);
  const barWidth = step * 0.78;
  const points = series.map((point, index) => ({
    ...point,
    x: style === "bar" ? left + (index + 0.5) * step : series.length === 1 ? (left + right) / 2 : left + index * plotWidth / (series.length - 1),
    y: baseline - point.tokens / tokenMax * plotHeight,
    costY: baseline - point.cost / costMax * plotHeight,
  }));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const y = baseline - fraction * plotHeight;
    return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${colors.line}"/><text class="axis" x="${left - 9}" y="${y + 4}" text-anchor="end">${tokens(tokenMax * fraction)}</text><text class="axis" x="${right + 9}" y="${y + 4}">${format.escape(cost(costMax * fraction))}</text>`;
  }).join("");

  const costPoints = points.map(({ x, costY }) => ({ x, y: costY }));
  const tokenCurve = style === "area" ? smoothCurveCommands(points, true) : "";
  const costCurve = style === "area" ? smoothCurveCommands(costPoints, true) : costPoints.slice(1).map(({ x, y }) => ` L ${x} ${y}`).join("");
  const first = points[0], last = points.at(-1);
  const tokenMarks = style === "bar"
    ? points.map(({ x, y }) => `<rect class="bar" x="${x - barWidth / 2}" y="${y}" width="${barWidth}" height="${baseline - y}"/>`).join("")
    : first && last
      ? `<path class="area" d="M ${first.x} ${baseline} L ${first.x} ${first.y}${tokenCurve} L ${last.x} ${baseline} Z" opacity="0.22"/><path class="line" d="M ${first.x} ${first.y}${tokenCurve}" fill="none" stroke="${colors.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${points.length === 1 ? `<circle cx="${first.x}" cy="${first.y}" r="5"/>` : ""}`
      : "";
  const costPath = first ? `<path class="trend-cost-line" d="M ${first.x} ${first.costY}${costCurve}" fill="none" stroke="${colors.text}" stroke-width="2.5" stroke-dasharray="${dash}"/>` : "";
  const details = points.map((point) => {
    const label = mode === "weekly" ? `Week of ${point.label}` : point.label;
    const detail = [label, `Total : ${format.tokens(point.tokens)} tokens`, `Local : ${format.tokens(point.localTokens)} tokens`, `Backend-only : ${format.tokens(point.unattributedTokens)} tokens`, `Estimated API cost : ${cost(point.cost)}`];
    if (point.costPerMillion !== null) detail.push(`Effective cost : ${cost(point.costPerMillion)} per 1M tokens`);
    return format.escape(detail.join("\n")).replaceAll("\n", "&#10;");
  });
  const costDots = points.map((point, index) => `<circle class="trend-cost-dot" cx="${point.x}" cy="${point.costY}" r="${points.length < 95 ? 3 : 1.5}" fill="${colors.text}" stroke="${colors.bg}" stroke-width="1"><title>${details[index]}</title></circle>`).join("");
  const labelIndexes = sampleLabelIndexes(points.length, 8);
  const dates = labelIndexes.map((index) => `<text class="axis" x="${points[index].x}" y="${baseline + 24}" text-anchor="middle">${format.escape(points[index].label)}</text>`).join("");
  const hitWidth = style === "bar" ? step : plotWidth / Math.max(1, points.length - 1);
  const hits = interactive ? points.map((point, index) => {
    const start = Math.max(left, point.x - hitWidth / 2);
    return `<rect class="hit" x="${start}" y="${top - 4}" width="${Math.min(right, point.x + hitWidth / 2) - start}" height="${plotHeight + 8}" data-tip="${details[index]}"/>`;
  }).join("") : "";

  return `<title>${modeLabel} token usage and estimated API cost</title><desc>${format.escape(note || "Tokens and estimated API cost share the same time axis")}</desc>
    ${interactive ? "" : `<rect width="100%" height="100%" fill="${colors.bg}"/>`}
    <g font-family="${format.escape(theme.fonts.ui)}" fill="${colors.muted}" font-size="11">
      <rect x="${left}" y="17" width="15" height="9" rx="1" fill="${colors.accent}"/><text x="${left + 22}" y="26" fill="${colors.text}" font-size="13">Tokens</text>
      <text x="${width / 2}" y="26" text-anchor="middle" font-size="13">${modeLabel}</text>
      <line x1="${right - 188}" x2="${right - 167}" y1="22" y2="22" stroke="${colors.text}" stroke-width="2.5" stroke-dasharray="${dash}"/><text x="${right}" y="26" text-anchor="end" fill="${colors.text}" font-size="13">Estimated API cost (USD)</text>
      ${ticks}<g fill="${colors.accent}">${tokenMarks}</g>${costPath}${costDots}${dates}${hits}
      ${note ? `<text x="${width / 2}" y="${height - 20}" text-anchor="middle" font-size="12">${format.escape(note)}</text>` : ""}
      ${points.length ? "" : `<text x="${width / 2}" y="${top + plotHeight / 2}" text-anchor="middle" font-size="13">No usage in this date range</text>`}
    </g>`;
}

export function smoothCurveCommands(points: Array<{ x: number; y: number }>, clamp = false): string {
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
    const control2X = next.x - (following.x - current.x) / 6;
    let control1Y = current.y + (next.y - previous.y) / 6;
    let control2Y = next.y - (following.y - current.y) / 6;
    if (clamp) {
      const min = Math.min(current.y, next.y), max = Math.max(current.y, next.y);
      control1Y = Math.max(min, Math.min(max, control1Y));
      control2Y = Math.max(min, Math.min(max, control2Y));
    }
    path += ` C ${control1X.toFixed(3)} ${control1Y.toFixed(3)} ${control2X.toFixed(3)} ${control2Y.toFixed(3)} ${next.x} ${next.y}`;
  }

  return path;
}

export function reportRuntimeSource(): string {
  const functions = [
    isIsoDay,
    isIsoMonth,
    parseUtcDay,
    formatUtcDay,
    addUtcDays,
    monthEndUtc,
    roundCents,
    roiStatusFor,
    roiColorFor,
    roiPercentages,
    rangeForPreset,
    sampleLabelIndexes,
    mergeSurfaceRows,
    summarizeTokenComposition,
    buildRoiMetrics,
    roiCurveSegments,
    buildUsageTrend,
    formatTrendCost,
    smoothCurveCommands,
    renderUsageTrend,
  ];
  const exports = "rangeForPreset, sampleLabelIndexes, mergeSurfaceRows, summarizeTokenComposition, buildRoiMetrics, roiCurveSegments, buildUsageTrend, formatTrendCost, renderUsageTrend, USAGE_TREND_SIZE";
  return `const __codexReportRuntime = (() => {\nconst USAGE_TREND_SIZE = ${JSON.stringify(USAGE_TREND_SIZE)};\n${functions.map((fn) => fn.toString()).join("\n")}\nreturn { ${exports} };\n})();\nconst { ${exports} } = __codexReportRuntime;`;
}

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isIsoMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function parseUtcDay(value: string): Date {
  if (!isIsoDay(value)) {
    throw new Error(`Invalid ISO date ${JSON.stringify(value)}`);
  }
  return new Date(`${value}T00:00:00.000Z`);
}

function formatUtcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function monthEndUtc(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return formatUtcDay(new Date(Date.UTC(year, monthNumber, 0)));
}

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100);
}

function roiStatusFor(amountPaid: number, estimatedApiValue: number): RoiStatus {
  const paidCents = roundCents(amountPaid);
  const valueCents = roundCents(estimatedApiValue);
  return valueCents > paidCents ? "positive" : valueCents < paidCents ? "negative" : "break-even";
}

function roiColorFor(status: RoiStatus): string {
  return status === "positive" ? "#50fa7b" : status === "negative" ? "#ff5555" : "#f1fa8c";
}

function roiPercentages(
  amountPaid: number,
  estimatedApiValue: number,
): Pick<RoiMetrics, "valueCoveragePercent" | "conventionalRoiPercent"> {
  return amountPaid === 0
    ? { valueCoveragePercent: null, conventionalRoiPercent: null }
    : {
        valueCoveragePercent: (estimatedApiValue / amountPaid) * 100,
        conventionalRoiPercent: ((estimatedApiValue - amountPaid) / amountPaid) * 100,
      };
}
