import { readdirSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { CodexHome, ThreadMetadata } from "./types";
import { fileExists } from "./util";

export type SqliteDiscovery = {
  rolloutPaths: string[];
  metadataByThreadId: Map<string, ThreadMetadata>;
  sqliteDatabases: number;
  sqliteThreads: number;
};

export function discoverFromSqlite(homes: CodexHome[]): SqliteDiscovery {
  const rolloutPaths = new Set<string>();
  const metadataByThreadId = new Map<string, ThreadMetadata>();
  let sqliteDatabases = 0;
  let sqliteThreads = 0;

  for (const home of homes) {
    for (const dbPath of stateDatabasePaths(home.path)) {
      const rows = readThreads(dbPath);
      if (!rows) continue;
      sqliteDatabases += 1;
      sqliteThreads += rows.length;
      for (const row of rows) {
        const rolloutPath = String(row.rollout_path ?? "");
        const threadId = String(row.id ?? "");
        if (!threadId) continue;
        const metadata: ThreadMetadata = {
          threadId,
          rolloutPath,
          model: optionalString(row.model),
          reasoningEffort: optionalString(row.reasoning_effort),
          source: optionalString(row.source),
          tokensUsed: Number(row.tokens_used ?? 0),
          archived: Number(row.archived ?? 0) === 1,
        };
        metadataByThreadId.set(threadId, metadata);
        if (rolloutPath && fileExists(rolloutPath)) rolloutPaths.add(path.resolve(rolloutPath));
      }
    }
  }

  return {
    rolloutPaths: [...rolloutPaths],
    metadataByThreadId,
    sqliteDatabases,
    sqliteThreads,
  };
}

function stateDatabasePaths(home: string): string[] {
  const dirs = [home, path.join(home, "sqlite")];
  const out: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/^state_\d+\.sqlite$/i.test(name)) out.push(path.join(dir, name));
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
    if (!hasThreads) return null;
    return db.query("select id, rollout_path, source, tokens_used, archived, model, reasoning_effort from threads").all() as Array<Record<string, unknown>>;
  } catch {
    return null;
  } finally {
    db?.close(false);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
