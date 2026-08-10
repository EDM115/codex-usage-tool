import type { CapabilityUsageEvent, TokenEvent } from "./types";

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDir, fileExists } from "./util";

export const ROLLOUT_PARSE_CACHE_VERSION = 2 as const;

export type CachedRollout = {
  size: number;
  mtimeMs: number;
  events: TokenEvent[];
  capabilityEvents: CapabilityUsageEvent[];
  parseErrors: Array<{ path: string; line?: number; error: string }>;
};

export type RolloutParseCache = {
  entries: Map<string, CachedRollout>;
  readError?: string;
};

type SerializedCache = {
  version: number;
  files: Record<string, CachedRollout>;
};

const CACHE_FILENAME = `rollouts-v${ROLLOUT_PARSE_CACHE_VERSION}.json`;

export function loadRolloutParseCache(cacheDir?: string): RolloutParseCache {
  const entries = new Map<string, CachedRollout>();

  if (!cacheDir) {
    return { entries };
  }

  const path = join(cacheDir, CACHE_FILENAME);

  if (!fileExists(path)) {
    return { entries };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;

    if (
      !isRecord(parsed) ||
      parsed.version !== ROLLOUT_PARSE_CACHE_VERSION ||
      !isRecord(parsed.files)
    ) {
      return { entries, readError: "Ignored an incompatible or malformed rollout parse cache" };
    }

    for (const [rolloutPath, value] of Object.entries(parsed.files)) {
      if (isCachedRollout(value)) {
        entries.set(rolloutPath, value);
      }
    }

    return { entries };
  } catch (error) {
    return {
      entries,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function saveRolloutParseCache(
  cacheDir: string | undefined,
  cache: RolloutParseCache,
): string | undefined {
  if (!cacheDir) {
    return undefined;
  }

  const files = Object.fromEntries(cache.entries);
  const document: SerializedCache = {
    version: ROLLOUT_PARSE_CACHE_VERSION,
    files,
  };
  const path = join(cacheDir, CACHE_FILENAME);
  const temporaryPath = `${path}.${process.pid}.tmp`;

  try {
    ensureDir(cacheDir);
    writeFileSync(temporaryPath, JSON.stringify(document));
    renameSync(temporaryPath, path);

    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function rolloutFileState(path: string): { size: number; mtimeMs: number } | undefined {
  try {
    const stat = statSync(path);

    if (!stat.isFile()) {
      return undefined;
    }

    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function isCachedRollout(value: unknown): value is CachedRollout {
  return (
    isRecord(value) &&
    isNonNegativeNumber(value.size) &&
    isNonNegativeNumber(value.mtimeMs) &&
    Array.isArray(value.events) &&
    value.events.every(isTokenEvent) &&
    Array.isArray(value.capabilityEvents) &&
    value.capabilityEvents.every(isCapabilityEvent) &&
    Array.isArray(value.parseErrors) &&
    value.parseErrors.every(isParseError)
  );
}

function isParseError(value: unknown): value is { path: string; line?: number; error: string } {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.error === "string" &&
    (value.line === undefined || (Number.isInteger(value.line) && Number(value.line) > 0))
  );
}

function isTokenEvent(value: unknown): value is TokenEvent {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    typeof value.homePath !== "string" ||
    typeof value.homeLabel !== "string" ||
    typeof value.rolloutPath !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.timestamp !== "string" ||
    typeof value.date !== "string" ||
    typeof value.model !== "string" ||
    !isRecord(value.breakdown)
  ) {
    return false;
  }

  const breakdown = value.breakdown;

  return [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ].every((key) => isNonNegativeNumber(breakdown[key]));
}

function isCapabilityEvent(value: unknown): value is CapabilityUsageEvent {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.homePath === "string" &&
    typeof value.homeLabel === "string" &&
    typeof value.rolloutPath === "string" &&
    typeof value.threadId === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.date === "string" &&
    (value.kind === "skill" || value.kind === "plugin") &&
    typeof value.name === "string" &&
    typeof value.detail === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
