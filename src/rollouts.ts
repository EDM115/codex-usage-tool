import type { ProgressSink } from "./progress"
import type { CodexHome, ThreadMetadata, TokenEvent } from "./types"

import { readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

import { discoverFromSqlite } from "./sqlite"
import {
  clampDate,
  dateKey,
  dirExists,
  fileExists,
  normalizeBreakdown,
  pluralize,
  subtractBreakdown,
  walkFiles,
  ZERO_BREAKDOWN,
} from "./util"

export type RolloutCollection = {
  events: TokenEvent[]
  rolloutFiles: number
  sqliteDatabases: number
  sqliteThreads: number
  parseErrors: Array<{ path: string; line?: number; error: string }>
}

export function collectRolloutEvents(options: {
  homes: CodexHome[]
  timezone: string
  from: string | null
  to: string | null
  progress?: ProgressSink
}): RolloutCollection {
  const sqlite = discoverFromSqlite(options.homes, options.progress)
  const paths = new Set<string>(sqlite.rolloutPaths)

  for (const home of options.homes) {
    for (const subdir of ["sessions", "archived_sessions"]) {
      options.progress?.status(`Scanning ${home.label}/${subdir}`)
      const root = join(home.path, subdir)

      if (!dirExists(root)) {
        continue
      }

      for (const file of walkFiles(root, (candidate) =>
        /^rollout-.*\.jsonl$/i.test(basename(candidate)),
      )) {
        paths.add(resolve(file))
      }
    }
  }

  options.progress?.statusDone(`Discovered ${paths.size} ${pluralize("rollout file", paths.size)}`)

  const parseErrors: Array<{ path: string; line?: number; error: string }> = []
  const eventMap = new Map<string, TokenEvent>()

  if (paths.size === 0) {
    options.progress?.statusDone(`Processed 0/0 ${pluralize("source", 0)}`)
  }

  let rolloutIndex = 0

  for (const rolloutPath of paths) {
    rolloutIndex += 1
    options.progress?.status(
      `Processing source ${rolloutIndex}/${paths.size} : ${basename(rolloutPath)}`,
    )

    if (!fileExists(rolloutPath)) {
      continue
    }

    const home = homeForRollout(options.homes, rolloutPath)

    for (const event of parseRolloutFile({
      rolloutPath,
      home,
      timezone: options.timezone,
      metadataByThreadId: sqlite.metadataByThreadId,
      parseErrors,
    })) {
      if (!clampDate(event.date, options.from, options.to)) {
        continue
      }

      if (!eventMap.has(event.eventId)) {
        eventMap.set(event.eventId, event)
      }
    }
  }

  if (paths.size > 0) {
    options.progress?.statusDone(
      `Processed ${paths.size}/${paths.size} ${pluralize("source", paths.size)}`,
    )
  }

  return {
    events: [...eventMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    rolloutFiles: paths.size,
    sqliteDatabases: sqlite.sqliteDatabases,
    sqliteThreads: sqlite.sqliteThreads,
    parseErrors,
  }
}

function parseRolloutFile(args: {
  rolloutPath: string
  home: CodexHome
  timezone: string
  metadataByThreadId: Map<string, ThreadMetadata>
  parseErrors: Array<{ path: string; line?: number; error: string }>
}): TokenEvent[] {
  const out: TokenEvent[] = []
  const text = readFileSync(args.rolloutPath, "utf8")
  const lines = text.split(/\r?\n/)
  let threadId = threadIdFromFilename(args.rolloutPath)
  let currentModel: string | undefined
  let currentReasoningEffort: string | undefined
  let currentServiceTier: string | undefined
  const pendingTierEvents = new Map<string, TokenEvent[]>()
  let previousTotal = ZERO_BREAKDOWN

  function setCurrentModel(nextModel: string | undefined): void {
    if (nextModel && nextModel !== currentModel) {
      currentServiceTier = undefined
    }

    currentModel = nextModel
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()

    if (!line) {
      continue
    }

    let parsed: any

    try {
      parsed = JSON.parse(line)
    } catch (error) {
      args.parseErrors.push({
        path: args.rolloutPath,
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      })

      continue
    }

    const type = parsed.type
    const payload = parsed.payload ?? parsed

    if (type === "session_meta") {
      threadId = payload.id ?? payload.session_id ?? threadId
      setCurrentModel(
        firstString(payload.model, currentModel, args.metadataByThreadId.get(threadId)?.model),
      )
      currentReasoningEffort = firstString(
        payload.reasoning_effort,
        payload.reasoningEffort,
        currentReasoningEffort,
        args.metadataByThreadId.get(threadId)?.reasoningEffort,
      )

      continue
    }

    if (type === "turn_context") {
      setCurrentModel(firstString(payload.model, currentModel))
      currentReasoningEffort = firstString(
        payload.reasoning_effort,
        payload.reasoningEffort,
        payload.effort,
        currentReasoningEffort,
      )

      continue
    }

    if (type === "event_msg" && payload?.type === "thread_settings_applied") {
      const settings = payload.thread_settings ?? payload.threadSettings ?? {}
      const collaborationSettings =
        settings.collaboration_mode?.settings ?? settings.collaborationMode?.settings ?? {}
      setCurrentModel(firstString(settings.model, collaborationSettings.model, currentModel))
      currentReasoningEffort = firstString(
        settings.reasoning_effort,
        settings.reasoningEffort,
        collaborationSettings.reasoning_effort,
        collaborationSettings.reasoningEffort,
        currentReasoningEffort,
      )
      const nextServiceTier = firstString(
        settings.service_tier,
        settings.serviceTier,
        collaborationSettings.service_tier,
        collaborationSettings.serviceTier,
      )

      if (nextServiceTier && currentModel) {
        for (const event of pendingTierEvents.get(currentModel) ?? []) {
          event.serviceTier = nextServiceTier
          event.serviceTierInferred = true
        }

        pendingTierEvents.delete(currentModel)
        currentServiceTier = nextServiceTier
      }

      continue
    }

    if (type !== "event_msg" || payload?.type !== "token_count") {
      continue
    }

    const info = payload.info

    if (!info) {
      continue
    }

    const total = normalizeBreakdown(info.total_token_usage ?? info.totalTokenUsage)
    const explicitLast = info.last_token_usage ?? info.lastTokenUsage
    const last = explicitLast
      ? normalizeBreakdown(explicitLast)
      : subtractBreakdown(total, previousTotal)
    previousTotal = total

    if (last.totalTokens <= 0) {
      continue
    }

    const timestamp = String(parsed.timestamp ?? new Date().toISOString())
    const eventDate = dateKey(timestamp, args.timezone)
    const metadata = args.metadataByThreadId.get(threadId)
    const model = firstString(currentModel, metadata?.model, "unknown") ?? "unknown"
    const reasoningEffort = firstString(currentReasoningEffort, metadata?.reasoningEffort)
    const eventId = `${threadId}|${timestamp}|${index}|${last.totalTokens}|${last.inputTokens}|${last.outputTokens}`
    const event: TokenEvent = {
      eventId,
      homePath: args.home.path,
      homeLabel: args.home.label,
      rolloutPath: args.rolloutPath,
      threadId,
      timestamp,
      date: eventDate,
      model,
      reasoningEffort,
      serviceTier: currentServiceTier,
      planType: firstString(payload.rate_limits?.plan_type, payload.rateLimits?.planType),
      breakdown: last,
      modelContextWindow: numberOrUndefined(info.model_context_window ?? info.modelContextWindow),
    }
    out.push(event)

    if (!event.serviceTier) {
      const pending = pendingTierEvents.get(model) ?? []
      pending.push(event)
      pendingTierEvents.set(model, pending)
    }
  }

  return out
}

function homeForRollout(homes: CodexHome[], rolloutPath: string): CodexHome {
  const normalized = resolve(rolloutPath).toLowerCase()
  const match = homes.find((home) => normalized.startsWith(resolve(home.path).toLowerCase()))

  return match ?? { path: dirname(rolloutPath), label: "external" }
}

function threadIdFromFilename(file: string): string {
  const name = basename(file)
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)

  return match?.[1] ?? name
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value
    }
  }

  return undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)

    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}
