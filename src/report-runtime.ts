import type { DailyUsage } from "./types";

export type ReportRangePreset = "7d" | "30d" | "90d" | "all";
export type ReportDateRange = { from: string; to: string };

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
    throw new Error(`Unknown report range preset ${String(preset)}.`);
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
  monthlyPayments: Record<string, number>,
  from: string,
  to: string,
): RoiMetrics {
  const start = parseUtcDay(from);
  const end = parseUtcDay(to);
  if (start.getTime() > end.getTime()) {
    throw new Error(`ROI range start ${from} is after end ${to}.`);
  }

  const byMonth: Record<string, { amountPaid: number; estimatedApiValue: number }> = {};
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 86_400_000) {
    const date = new Date(cursor);
    const month = formatUtcDay(date).slice(0, 7);
    const row = byMonth[month] ?? { amountPaid: 0, estimatedApiValue: 0 };
    if (Object.hasOwn(monthlyPayments, month)) {
      row.amountPaid += monthlyPayments[month] / daysInUtcMonth(date);
    }
    byMonth[month] = row;
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

export function reportRuntimeSource(): string {
  const functions = [
    isIsoDay,
    isIsoMonth,
    parseUtcDay,
    formatUtcDay,
    addUtcDays,
    monthEndUtc,
    daysInUtcMonth,
    roundCents,
    roiStatusFor,
    roiColorFor,
    roiPercentages,
    rangeForPreset,
    sampleLabelIndexes,
    summarizeTokenComposition,
    buildRoiMetrics,
    roiCurveSegments,
  ];
  return `const __codexReportRuntime = (() => {\n${functions.map((fn) => fn.toString()).join("\n")}\nreturn { rangeForPreset, sampleLabelIndexes, summarizeTokenComposition, buildRoiMetrics, roiCurveSegments };\n})();\nconst { rangeForPreset, sampleLabelIndexes, summarizeTokenComposition, buildRoiMetrics, roiCurveSegments } = __codexReportRuntime;`;
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
    throw new Error(`Invalid ISO date ${JSON.stringify(value)}.`);
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

function daysInUtcMonth(value: Date): number {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
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
