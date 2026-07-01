import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { TokenBreakdown } from "./types";

export const ZERO_BREAKDOWN: TokenBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export function addBreakdown(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

export function subtractBreakdown(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens),
  };
}

export function normalizeBreakdown(value: any): TokenBreakdown {
  return {
    totalTokens: numberFrom(value?.total_tokens ?? value?.totalTokens),
    inputTokens: numberFrom(value?.input_tokens ?? value?.inputTokens),
    cachedInputTokens: numberFrom(value?.cached_input_tokens ?? value?.cachedInputTokens),
    outputTokens: numberFrom(value?.output_tokens ?? value?.outputTokens),
    reasoningOutputTokens: numberFrom(value?.reasoning_output_tokens ?? value?.reasoningOutputTokens),
  };
}

export function numberFrom(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function dateKey(isoTimestamp: string, timezone: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const current = parseDateOnly(from);
  const end = parseDateOnly(to);
  while (current <= end) {
    out.push(formatDateOnly(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return out;
}

export function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function isoWeekStart(dateKeyValue: string): string {
  const date = parseDateOnly(dateKeyValue);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return formatDateOnly(date);
}

export function clampDate(value: string, from: string | null, to: string | null): boolean {
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimFixed(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

export function money(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  if (Math.abs(value) < 0.01 && value !== 0) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function fileExists(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

export function dirExists(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function walkFiles(root: string, predicate: (file: string) => boolean): string[] {
  const out: string[] = [];
  if (!dirExists(root)) return out;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) stack.push(full);
      else if (stats.isFile() && predicate(full)) out.push(full);
    }
  }
  return out;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function sanitizeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}
