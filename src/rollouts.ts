import type { ProgressSink } from "./progress";
import type { CapabilityUsageEvent, CodexHome, ThreadMetadata, TokenEvent } from "./types";

import { createReadStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { discoverFromSqlite } from "./sqlite";
import { createCapabilityEvidenceTracker, extractCapabilityUsageEvents } from "./capabilities";
import {
  loadRolloutParseCache,
  ROLLOUT_PARSE_CACHE_VERSION,
  rolloutFileState,
  saveRolloutParseCache,
} from "./parse-cache";
import {
  clampDate,
  dateKey,
  dirExists,
  normalizeBreakdown,
  pluralize,
  subtractBreakdown,
  walkFiles,
  ZERO_BREAKDOWN,
} from "./util";

export type RolloutCollection = {
  events: TokenEvent[];
  capabilityEvents: CapabilityUsageEvent[];
  rolloutFiles: number;
  sqliteDatabases: number;
  sqliteThreads: number;
  parseErrors: Array<{ path: string; line?: number; error: string }>;
  cache: {
    version: number;
    hits: number;
    misses: number;
    invalidations: number;
    reusedBytes: number;
    readError?: string;
    writeError?: string;
  };
  coverage: {
    status: "complete" | "partial" | "unavailable";
    discoveredFiles: number;
    parsedFiles: number;
    failedFiles: number;
    malformedLines: number;
    missingRoots: string[];
  };
};

export async function collectRolloutEvents(options: {
  homes: CodexHome[];
  timezone: string;
  from: string | null;
  to: string | null;
  progress?: ProgressSink;
  cacheDir?: string;
}): Promise<RolloutCollection> {
  const sqlite = discoverFromSqlite(options.homes, options.progress);
  const paths = new Set<string>(sqlite.rolloutPaths);
  const scanTargets = options.homes.flatMap((home) =>
    ["sessions", "archived_sessions"].map((subdir) => ({ home, subdir })),
  );
  const missingRoots: string[] = [];
  const discoveryErrors: Array<{ path: string; error: string }> = [];

  for (const [index, { home, subdir }] of scanTargets.entries()) {
    const message = `Scanning ${home.label}/${subdir}`;
    options.progress?.status(message);
    const root = join(home.path, subdir);

    if (dirExists(root)) {
      for (const file of walkFiles(
        root,
        (candidate) => /^rollout-.*\.jsonl$/i.test(basename(candidate)),
        (path, error) =>
          discoveryErrors.push({
            path,
            error: error instanceof Error ? error.message : String(error),
          }),
      )) {
        paths.add(resolve(file));
      }
    } else {
      missingRoots.push(root);
    }

    options.progress?.statusProgress(message, index + 1, scanTargets.length);
  }

  options.progress?.statusDone(`Discovered ${paths.size} ${pluralize("rollout file", paths.size)}`);

  const parseErrors: Array<{ path: string; line?: number; error: string }> = [...discoveryErrors];
  const eventMap = new Map<string, TokenEvent>();
  const capabilityEventMap = new Map<string, CapabilityUsageEvent>();
  const parseCache = loadRolloutParseCache(options.cacheDir);
  const cacheStats: RolloutCollection["cache"] = {
    version: ROLLOUT_PARSE_CACHE_VERSION,
    hits: 0,
    misses: 0,
    invalidations: 0,
    reusedBytes: 0,
    readError: parseCache.readError,
  };

  if (paths.size === 0) {
    options.progress?.statusDone(`Processed 0/0 ${pluralize("source", 0)}`);
  }

  let rolloutIndex = 0;
  let parsedFiles = 0;
  let failedFiles = discoveryErrors.length;

  for (const rolloutPath of paths) {
    rolloutIndex += 1;
    const message = `Processing source ${rolloutIndex}/${paths.size} : ${basename(rolloutPath)}`;
    options.progress?.status(message);

    const fileState = rolloutFileState(rolloutPath);

    if (!fileState) {
      failedFiles += 1;
      options.progress?.statusProgress(message, rolloutIndex, paths.size);

      continue;
    }

    const home = homeForRollout(options.homes, rolloutPath);

    const cached = parseCache.entries.get(rolloutPath);
    let parsedRollout: {
      events: TokenEvent[];
      capabilityEvents: CapabilityUsageEvent[];
      parseErrors: Array<{ path: string; line?: number; error: string }>;
    };

    if (cached && cached.size === fileState.size && cached.mtimeMs === fileState.mtimeMs) {
      parsedRollout = {
        events: cached.events,
        capabilityEvents: cached.capabilityEvents,
        parseErrors: cached.parseErrors,
      };
      cacheStats.hits += 1;
      cacheStats.reusedBytes += fileState.size;
    } else {
      if (cached) {
        cacheStats.invalidations += 1;
      } else {
        cacheStats.misses += 1;
      }

      try {
        parsedRollout = await parseRolloutFile({
          rolloutPath,
          home,
          metadataByThreadId: sqlite.metadataByThreadId,
        });
        parseCache.entries.set(rolloutPath, { ...fileState, ...parsedRollout });
      } catch (error) {
        failedFiles += 1;
        parseErrors.push({
          path: rolloutPath,
          error: error instanceof Error ? error.message : String(error),
        });
        options.progress?.statusProgress(message, rolloutIndex, paths.size);

        continue;
      }
    }

    parsedFiles += 1;
    parseErrors.push(...parsedRollout.parseErrors);

    for (const cachedEvent of parsedRollout.events) {
      const event = materializeTokenEvent(cachedEvent, home, options.timezone);

      if (!clampDate(event.date, options.from, options.to)) {
        continue;
      }

      if (!eventMap.has(event.eventId)) {
        eventMap.set(event.eventId, event);
      }
    }

    for (const cachedEvent of parsedRollout.capabilityEvents) {
      const event = materializeCapabilityEvent(cachedEvent, home, options.timezone);

      if (
        clampDate(event.date, options.from, options.to) &&
        !capabilityEventMap.has(event.eventId)
      ) {
        capabilityEventMap.set(event.eventId, event);
      }
    }

    options.progress?.statusProgress(message, rolloutIndex, paths.size);
  }

  if (paths.size > 0) {
    options.progress?.statusDone(
      `Processed ${paths.size}/${paths.size} ${pluralize("source", paths.size)}`,
    );
  }

  pruneCacheEntries(parseCache.entries, options.homes, paths);
  cacheStats.writeError = saveRolloutParseCache(options.cacheDir, parseCache);

  return {
    events: [...eventMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    capabilityEvents: [...capabilityEventMap.values()].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    ),
    rolloutFiles: paths.size,
    sqliteDatabases: sqlite.sqliteDatabases,
    sqliteThreads: sqlite.sqliteThreads,
    parseErrors,
    cache: cacheStats,
    coverage: {
      status:
        paths.size === 0
          ? "unavailable"
          : failedFiles > 0 ||
              parseErrors.length > 0 ||
              missingRoots.some((root) => basename(root).toLowerCase() === "sessions")
            ? "partial"
            : "complete",
      discoveredFiles: paths.size,
      parsedFiles,
      failedFiles,
      malformedLines: parseErrors.filter((error) => error.line !== undefined).length,
      missingRoots,
    },
  };
}

async function parseRolloutFile(args: {
  rolloutPath: string;
  home: CodexHome;
  metadataByThreadId: Map<string, ThreadMetadata>;
}): Promise<{
  events: TokenEvent[];
  capabilityEvents: CapabilityUsageEvent[];
  parseErrors: Array<{ path: string; line?: number; error: string }>;
}> {
  const out: TokenEvent[] = [];
  const capabilityEvents: CapabilityUsageEvent[] = [];
  const parseErrors: Array<{ path: string; line?: number; error: string }> = [];
  const capabilityTracker = createCapabilityEvidenceTracker();
  const lines = readJsonlLines(args.rolloutPath);
  let threadId = threadIdFromFilename(args.rolloutPath);
  let currentModel: string | undefined;
  let currentModelAttribution: TokenEvent["modelAttribution"];
  let currentReasoningEffort: string | undefined;
  let currentReasoningEffortAttribution: TokenEvent["reasoningEffortAttribution"];
  let currentServiceTier: string | undefined;
  let currentSource: string | undefined;
  const pendingTierEvents = new Map<string, TokenEvent[]>();
  let previousTotal = ZERO_BREAKDOWN;
  let previousLastSignature: string | undefined;
  let previousTotalSignature: string | undefined;
  let sawSessionMeta = false;
  let suppressingForkCopies = false;
  let forkCopyAnchorMs = 0;

  function setCurrentModel(
    nextModel: string | undefined,
    attribution?: TokenEvent["modelAttribution"],
  ): void {
    if (nextModel && nextModel !== currentModel) {
      currentServiceTier = undefined;
    }

    currentModel = nextModel;
    currentModelAttribution = nextModel ? attribution : undefined;
  }

  let index = -1;

  for await (const rawLine of lines) {
    index += 1;
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    let parsed: any;

    try {
      parsed = JSON.parse(line);
    } catch (error) {
      parseErrors.push({
        path: args.rolloutPath,
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });

      continue;
    }

    const type = parsed.type;
    const payload = parsed.payload ?? parsed;

    if (type === "session_meta") {
      if (sawSessionMeta) {
        continue;
      }

      sawSessionMeta = true;
      threadId = payload.id ?? payload.session_id ?? threadId;
      const metadata = args.metadataByThreadId.get(threadId);
      const metaModel = firstString(payload.model);

      if (metaModel) {
        setCurrentModel(metaModel, "observed");
      } else if (!currentModel && metadata?.model) {
        setCurrentModel(metadata.model, "metadata");
      }

      const metaReasoningEffort = firstString(payload.reasoning_effort, payload.reasoningEffort);

      if (metaReasoningEffort) {
        currentReasoningEffort = metaReasoningEffort;
        currentReasoningEffortAttribution = "observed";
      } else if (!currentReasoningEffort && metadata?.reasoningEffort) {
        currentReasoningEffort = metadata.reasoningEffort;
        currentReasoningEffortAttribution = "metadata";
      }

      currentSource = firstString(payload.originator, payload.thread_source, metadata?.source);
      const metaTimestampMs = timestampMs(parsed.timestamp);

      if (metaTimestampMs !== undefined && isForkedSessionMeta(payload)) {
        suppressingForkCopies = true;
        forkCopyAnchorMs = metaTimestampMs;
      }

      continue;
    }

    if (suppressingForkCopies) {
      const recordTimestampMs = timestampMs(parsed.timestamp);

      if (recordTimestampMs !== undefined && recordTimestampMs - forkCopyAnchorMs >= 1_000) {
        suppressingForkCopies = false;
      } else if (recordTimestampMs !== undefined) {
        forkCopyAnchorMs = recordTimestampMs;
      }
    }

    if (suppressingForkCopies && !(type === "event_msg" && payload?.type === "token_count")) {
      continue;
    }

    if (!suppressingForkCopies) {
      capabilityEvents.push(
        ...extractCapabilityUsageEvents({
          parsed,
          payload,
          lineIndex: index,
          rolloutPath: args.rolloutPath,
          homePath: args.home.path,
          homeLabel: args.home.label,
          threadId,
          timezone: "UTC",
          tracker: capabilityTracker,
        }),
      );
    }

    if (type === "turn_context") {
      const turnModel = firstString(payload.model);

      if (turnModel) {
        setCurrentModel(turnModel, "observed");
      }

      const turnReasoningEffort = firstString(
        payload.reasoning_effort,
        payload.reasoningEffort,
        payload.effort,
      );

      if (turnReasoningEffort) {
        currentReasoningEffort = turnReasoningEffort;
        currentReasoningEffortAttribution = "observed";
      }

      continue;
    }

    if (type === "event_msg" && payload?.type === "thread_settings_applied") {
      const settings = payload.thread_settings ?? payload.threadSettings ?? {};
      const collaborationSettings =
        settings.collaboration_mode?.settings ?? settings.collaborationMode?.settings ?? {};
      const settingsModel = firstString(settings.model, collaborationSettings.model);

      if (settingsModel) {
        setCurrentModel(settingsModel, "observed");
      }

      const settingsReasoningEffort = firstString(
        settings.reasoning_effort,
        settings.reasoningEffort,
        collaborationSettings.reasoning_effort,
        collaborationSettings.reasoningEffort,
      );

      if (settingsReasoningEffort) {
        currentReasoningEffort = settingsReasoningEffort;
        currentReasoningEffortAttribution = "observed";
      }
      const nextServiceTier = firstString(
        settings.service_tier,
        settings.serviceTier,
        collaborationSettings.service_tier,
        collaborationSettings.serviceTier,
      );

      if (nextServiceTier && currentModel) {
        for (const event of pendingTierEvents.get(currentModel) ?? []) {
          event.serviceTier = nextServiceTier;
          event.serviceTierInferred = true;
          event.serviceTierAttribution = "inferred";
        }

        pendingTierEvents.delete(currentModel);
        currentServiceTier = nextServiceTier;
      }

      continue;
    }

    if (type !== "event_msg" || payload?.type !== "token_count") {
      continue;
    }

    const info = payload.info;

    if (!info) {
      continue;
    }

    const total = normalizeBreakdown(info.total_token_usage ?? info.totalTokenUsage);
    const explicitLast = info.last_token_usage ?? info.lastTokenUsage;
    const last = explicitLast
      ? normalizeBreakdown(explicitLast)
      : subtractBreakdown(total, previousTotal);
    previousTotal = total;

    if (explicitLast) {
      const lastSignature = breakdownSignature(last);
      const totalSignature = breakdownSignature(total);

      if (lastSignature === previousLastSignature && totalSignature === previousTotalSignature) {
        continue;
      }

      previousLastSignature = lastSignature;
      previousTotalSignature = totalSignature;
    }

    if (last.totalTokens <= 0) {
      continue;
    }

    const timestamp = String(parsed.timestamp ?? new Date().toISOString());

    if (suppressingForkCopies) {
      continue;
    }

    const eventDate = dateKey(timestamp, "UTC");
    const metadata = args.metadataByThreadId.get(threadId);
    const model = firstString(currentModel, metadata?.model, "unknown") ?? "unknown";
    const reasoningEffort = firstString(currentReasoningEffort, metadata?.reasoningEffort);
    const eventId = `${threadId}|${timestamp}|${index}|${last.totalTokens}|${last.inputTokens}|${last.outputTokens}`;
    const event: TokenEvent = {
      eventId,
      homePath: args.home.path,
      homeLabel: args.home.label,
      rolloutPath: args.rolloutPath,
      threadId,
      timestamp,
      date: eventDate,
      model,
      modelAttribution: currentModel
        ? (currentModelAttribution ?? "observed")
        : metadata?.model
          ? "metadata"
          : "missing",
      reasoningEffort,
      reasoningEffortAttribution: currentReasoningEffort
        ? (currentReasoningEffortAttribution ?? "observed")
        : metadata?.reasoningEffort
          ? "metadata"
          : "missing",
      serviceTier: currentServiceTier,
      serviceTierAttribution: currentServiceTier ? "observed" : "missing",
      source: currentSource ?? metadata?.source,
      planType: firstString(payload.rate_limits?.plan_type, payload.rateLimits?.planType),
      breakdown: last,
      modelContextWindow: numberOrUndefined(info.model_context_window ?? info.modelContextWindow),
    };
    out.push(event);

    if (!event.serviceTier) {
      const pending = pendingTierEvents.get(model) ?? [];
      pending.push(event);
      pendingTierEvents.set(model, pending);
    }
  }

  return { events: out, capabilityEvents, parseErrors };
}

async function* readJsonlLines(path: string): AsyncGenerator<string> {
  // Bun 1.4's node:readline treats U+2028 inside valid JSON strings as a line boundary, JSONL records are separated only on physical LF or CRLF delimiters here
  const fragments: string[] = [];

  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = String(chunk);
    let start = 0;
    let end = text.indexOf("\n", start);

    while (end !== -1) {
      fragments.push(text.slice(start, end));
      const line = fragments.join("");
      fragments.length = 0;
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
      start = end + 1;
      end = text.indexOf("\n", start);
    }

    if (start < text.length) {
      fragments.push(text.slice(start));
    }
  }

  if (fragments.length > 0) {
    const line = fragments.join("");
    yield line.endsWith("\r") ? line.slice(0, -1) : line;
  }
}

function materializeTokenEvent(event: TokenEvent, home: CodexHome, timezone: string): TokenEvent {
  return {
    ...event,
    homePath: home.path,
    homeLabel: home.label,
    date: dateKey(event.timestamp, timezone),
  };
}

function materializeCapabilityEvent(
  event: CapabilityUsageEvent,
  home: CodexHome,
  timezone: string,
): CapabilityUsageEvent {
  return {
    ...event,
    homePath: home.path,
    homeLabel: home.label,
    date: dateKey(event.timestamp, timezone),
  };
}

function pruneCacheEntries(
  entries: Map<string, unknown>,
  homes: CodexHome[],
  livePaths: ReadonlySet<string>,
): void {
  const roots = homes.map((home) => `${resolve(home.path).toLowerCase()}\\`);
  const normalizedLivePaths = new Set([...livePaths].map((path) => resolve(path).toLowerCase()));

  for (const path of entries.keys()) {
    const normalized = resolve(path).toLowerCase();

    if (roots.some((root) => normalized.startsWith(root)) && !normalizedLivePaths.has(normalized)) {
      entries.delete(path);
    }
  }
}

function homeForRollout(homes: CodexHome[], rolloutPath: string): CodexHome {
  const normalized = resolve(rolloutPath).toLowerCase();
  const match = homes.find((home) => normalized.startsWith(resolve(home.path).toLowerCase()));

  return match ?? { path: dirname(rolloutPath), label: "external" };
}

function threadIdFromFilename(file: string): string {
  const name = basename(file);
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);

  return match?.[1] ?? name;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") {
    return true;
  }

  const source = payload.source;

  if (!source || typeof source !== "object") {
    return false;
  }

  const subagent = (source as Record<string, unknown>).subagent;

  if (!subagent || typeof subagent !== "object") {
    return false;
  }

  const spawn = (subagent as Record<string, unknown>).thread_spawn;

  return Boolean(
    spawn &&
    typeof spawn === "object" &&
    typeof (spawn as Record<string, unknown>).parent_thread_id === "string",
  );
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? undefined : parsed;
}

function breakdownSignature(value: TokenEvent["breakdown"]): string {
  return `${value.totalTokens}|${value.inputTokens}|${value.cachedInputTokens}|${value.outputTokens}|${value.reasoningOutputTokens}`;
}
