import { readFileSync } from "node:fs";
import path from "node:path";
import type { CodexHome, ThreadMetadata, TokenEvent } from "./types";
import { clampDate, dateKey, dirExists, fileExists, normalizeBreakdown, subtractBreakdown, walkFiles, ZERO_BREAKDOWN } from "./util";
import { discoverFromSqlite } from "./sqlite";

export type RolloutCollection = {
  events: TokenEvent[];
  rolloutFiles: number;
  sqliteDatabases: number;
  sqliteThreads: number;
  parseErrors: Array<{ path: string; line?: number; error: string }>;
};

export function collectRolloutEvents(options: {
  homes: CodexHome[];
  timezone: string;
  from: string | null;
  to: string | null;
}): RolloutCollection {
  const sqlite = discoverFromSqlite(options.homes);
  const paths = new Set<string>(sqlite.rolloutPaths);

  for (const home of options.homes) {
    for (const subdir of ["sessions", "archived_sessions"]) {
      const root = path.join(home.path, subdir);
      if (!dirExists(root)) continue;
      for (const file of walkFiles(root, (candidate) => /^rollout-.*\.jsonl$/i.test(path.basename(candidate)))) {
        paths.add(path.resolve(file));
      }
    }
  }

  const parseErrors: Array<{ path: string; line?: number; error: string }> = [];
  const eventMap = new Map<string, TokenEvent>();
  for (const rolloutPath of paths) {
    if (!fileExists(rolloutPath)) continue;
    const home = homeForRollout(options.homes, rolloutPath);
    for (const event of parseRolloutFile({
      rolloutPath,
      home,
      timezone: options.timezone,
      metadataByThreadId: sqlite.metadataByThreadId,
      parseErrors,
    })) {
      if (!clampDate(event.date, options.from, options.to)) continue;
      if (!eventMap.has(event.eventId)) eventMap.set(event.eventId, event);
    }
  }

  return {
    events: [...eventMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    rolloutFiles: paths.size,
    sqliteDatabases: sqlite.sqliteDatabases,
    sqliteThreads: sqlite.sqliteThreads,
    parseErrors,
  };
}

function parseRolloutFile(args: {
  rolloutPath: string;
  home: CodexHome;
  timezone: string;
  metadataByThreadId: Map<string, ThreadMetadata>;
  parseErrors: Array<{ path: string; line?: number; error: string }>;
}): TokenEvent[] {
  const out: TokenEvent[] = [];
  const text = readFileSync(args.rolloutPath, "utf8");
  const lines = text.split(/\r?\n/);
  let threadId = threadIdFromFilename(args.rolloutPath);
  let currentModel = "unknown";
  let currentReasoningEffort: string | undefined;
  let previousTotal = ZERO_BREAKDOWN;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      args.parseErrors.push({
        path: args.rolloutPath,
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const type = parsed.type;
    const payload = parsed.payload ?? parsed;

    if (type === "session_meta") {
      threadId = payload.id ?? payload.session_id ?? threadId;
      currentModel = firstString(payload.model, args.metadataByThreadId.get(threadId)?.model, currentModel) ?? "unknown";
      currentReasoningEffort = firstString(payload.reasoning_effort, args.metadataByThreadId.get(threadId)?.reasoningEffort, currentReasoningEffort);
      continue;
    }

    if (type === "turn_context") {
      currentModel = firstString(payload.model, currentModel) ?? "unknown";
      currentReasoningEffort = firstString(payload.reasoning_effort, payload.effort, currentReasoningEffort);
      continue;
    }

    if (type !== "event_msg" || payload?.type !== "token_count") continue;
    const info = payload.info;
    if (!info) continue;
    const total = normalizeBreakdown(info.total_token_usage ?? info.totalTokenUsage);
    const explicitLast = info.last_token_usage ?? info.lastTokenUsage;
    const last = explicitLast ? normalizeBreakdown(explicitLast) : subtractBreakdown(total, previousTotal);
    previousTotal = total;
    if (last.totalTokens <= 0) continue;
    const timestamp = String(parsed.timestamp ?? new Date().toISOString());
    const eventDate = dateKey(timestamp, args.timezone);
    const metadata = args.metadataByThreadId.get(threadId);
    const model = firstString(currentModel, metadata?.model, "unknown") ?? "unknown";
    const reasoningEffort = firstString(currentReasoningEffort, metadata?.reasoningEffort);
    const eventId = `${threadId}|${timestamp}|${index}|${last.totalTokens}|${last.inputTokens}|${last.outputTokens}`;
    out.push({
      eventId,
      homePath: args.home.path,
      homeLabel: args.home.label,
      rolloutPath: args.rolloutPath,
      threadId,
      timestamp,
      date: eventDate,
      model,
      reasoningEffort,
      planType: firstString(payload.rate_limits?.plan_type, payload.rateLimits?.planType),
      breakdown: last,
      modelContextWindow: numberOrUndefined(info.model_context_window ?? info.modelContextWindow),
    });
  }
  return out;
}

function homeForRollout(homes: CodexHome[], rolloutPath: string): CodexHome {
  const normalized = path.resolve(rolloutPath).toLowerCase();
  const match = homes.find((home) => normalized.startsWith(path.resolve(home.path).toLowerCase()));
  return match ?? { path: path.dirname(rolloutPath), label: "external" };
}

function threadIdFromFilename(file: string): string {
  const name = path.basename(file);
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? name;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
