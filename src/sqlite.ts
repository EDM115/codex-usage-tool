import type { ProgressSink } from "./progress";
import type { CodexHome, LocalThreadSummary, ThreadMetadata } from "./types";

import { Database } from "bun:sqlite";
import { openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { fileExists, pluralize } from "./util";

export type SqliteDiscovery = {
  rolloutPaths: string[];
  metadataByThreadId: Map<string, ThreadMetadata>;
  threads: LocalThreadSummary[];
  sqliteDatabases: number;
  sqliteThreads: number;
};

export function discoverFromSqlite(homes: CodexHome[], progress?: ProgressSink): SqliteDiscovery {
  const rolloutPaths = new Set<string>();
  const metadataByThreadId = new Map<string, ThreadMetadata>();
  const threads = new Map<string, LocalThreadSummary>();
  let sqliteDatabases = 0;
  let sqliteThreads = 0;
  const dbPaths = homes.flatMap((home) =>
    stateDatabasePaths(home.path).map((dbPath) => ({ home, dbPath })),
  );

  if (dbPaths.length === 0) {
    progress?.statusDone(`SQLite metadata : 0 ${pluralize("database", 0)}`);
  }

  for (const [index, item] of dbPaths.entries()) {
    const message = `SQLite read ${index + 1}/${dbPaths.length} : ${item.home.label}`;
    progress?.status(message);
    const rows = readThreads(item.dbPath);

    if (rows) {
      sqliteDatabases += 1;
      sqliteThreads += rows.length;

      for (const row of rows) {
        const rolloutPath = String(row.rollout_path ?? "");
        const threadId = String(row.id ?? "");

        if (!threadId) {
          continue;
        }

        const metadata: ThreadMetadata = {
          threadId,
          rolloutPath,
          title: optionalString(row.name) ?? optionalString(row.title) ?? optionalString(row.preview)?.slice(0, 60),
          createdAt: sqliteTimestamp(row.created_at_ms ?? row.created_at),
          updatedAt: sqliteTimestamp(row.updated_at_ms ?? row.updated_at),
          parentThreadId: rolloutPath ? parentThreadIdFromRollout(rolloutPath) : undefined,
          model: optionalString(row.model),
          reasoningEffort: optionalString(row.reasoning_effort),
          source: optionalString(row.source),
          tokensUsed: Number(row.tokens_used ?? 0),
          archived: Number(row.archived ?? 0) === 1,
        };
        metadataByThreadId.set(threadId, metadata);
        threads.set(threadId, {
          threadId,
          title: metadata.title ?? "Untitled chat",
          createdAt: metadata.createdAt ?? null,
          updatedAt: metadata.updatedAt ?? null,
          parentThreadId: metadata.parentThreadId,
          archived: metadata.archived ?? false,
          homeLabel: item.home.label,
        });

        if (rolloutPath && fileExists(rolloutPath)) {
          rolloutPaths.add(resolve(rolloutPath));
        }
      }
    }

    progress?.statusProgress(message, index + 1, dbPaths.length);
  }

  if (dbPaths.length > 0) {
    progress?.statusDone(
      `SQLite metadata : ${sqliteDatabases} ${pluralize("database", sqliteDatabases)}, ${sqliteThreads} ${pluralize("thread row", sqliteThreads)}`,
    );
  }

  return {
    rolloutPaths: [...rolloutPaths],
    metadataByThreadId,
    threads: [...threads.values()],
    sqliteDatabases,
    sqliteThreads,
  };
}

function stateDatabasePaths(home: string): string[] {
  const dirs = [home, join(home, "sqlite")];
  const out: string[] = [];

  for (const dir of dirs) {
    let names: string[];

    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      if (/^state_\d+\.sqlite$/i.test(name)) {
        out.push(join(dir, name));
      }
    }
  }

  return out;
}

function readThreads(dbPath: string): Array<Record<string, unknown>> | null {
  let db: Database | null = null;

  try {
    db = new Database(dbPath, { readonly: true });
    const hasThreads = db
      .query("select 1 as ok from sqlite_master where type = 'table' and name = 'threads'")
      .get() as { ok: number } | null;

    if (!hasThreads) {
      return null;
    }

    const columns = new Set((db.query("pragma table_info(threads)").all() as Array<{ name: string }>).map((row) => row.name));
    const selected = ["id", "rollout_path", "source", "tokens_used", "archived", "model", "reasoning_effort", "name", "title", "preview", "created_at_ms", "created_at", "updated_at_ms", "updated_at"].filter((column) => columns.has(column));
    return db.query(`select ${selected.join(", ")} from threads`).all() as Array<Record<string, unknown>>;
  } catch {
    return null;
  } finally {
    db?.close(false);
  }
}

function sqliteTimestamp(value: unknown): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function parentThreadIdFromRollout(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(16384);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytes).split("\n", 1)[0];
    const payload = JSON.parse(firstLine).payload;
    return optionalString(payload?.parent_thread_id);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
