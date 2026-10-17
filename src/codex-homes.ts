import type { CodexHome } from "./types";

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

import { dirExists } from "./util";

export function resolveCodexHomes(
  homeInputs: string[],
  rootInputs: string[],
  autoDiscover = true,
): CodexHome[] {
  const candidates: string[] = [];
  candidates.push(...homeInputs);
  candidates.push(...(rootInputs.map(resolveRootToCodexHome).filter(Boolean) as string[]));

  if (autoDiscover) {
    const envHome = process.env.CODEX_HOME;

    if (envHome) {
      candidates.push(envHome);
    }

    candidates.push(join(homedir(), ".codex"));
  }

  const seen = new Set<string>();
  const homes: CodexHome[] = [];

  for (const candidate of candidates) {
    const resolved = resolveRootToCodexHome(candidate) ?? candidate;
    const absolute = resolve(resolved);
    if (!dirExists(absolute)) {
      continue;
    }

    let canonical = absolute;
    try {
      canonical = realpathSync(absolute);
    } catch {
      // Keep the resolved path if canonicalization is unavailable
    }
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    homes.push({ path: absolute, label: labelForHome(absolute, homes.length + 1) });
  }

  return homes;
}

function resolveRootToCodexHome(input: string): string | null {
  const absolute = resolve(input);

  if (!dirExists(absolute)) {
    return null;
  }

  if (basename(absolute).toLowerCase() === ".codex") {
    return absolute;
  }

  const child = join(absolute, ".codex");

  if (dirExists(child)) {
    return child;
  }

  if (looksLikeCodexHome(absolute)) {
    return absolute;
  }

  return null;
}

function looksLikeCodexHome(dir: string): boolean {
  return (
    existsSync(join(dir, "sessions")) ||
    existsSync(join(dir, "archived_sessions")) ||
    existsSync(join(dir, "auth.json")) ||
    existsSync(join(dir, "config.toml")) ||
    hasStateSqlite(dir)
  );
}

function hasStateSqlite(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => /^state_\d+\.sqlite$/i.test(name));
  } catch {
    return false;
  }
}

function labelForHome(home: string, index: number): string {
  try {
    const stats = statSync(home);

    if (!stats.isDirectory()) {
      return `source-${index}`;
    }
  } catch {
    return `source-${index}`;
  }

  const parent = basename(dirname(home));

  if (parent && parent !== "." && parent !== parse(home).root) {
    return parent;
  }

  return `source-${index}`;
}
