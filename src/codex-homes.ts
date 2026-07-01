import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CodexHome } from "./types";
import { dirExists } from "./util";

export function resolveCodexHomes(homeInputs: string[], rootInputs: string[]): CodexHome[] {
  const candidates: string[] = [];
  candidates.push(...homeInputs);
  candidates.push(...rootInputs.map(resolveRootToCodexHome).filter(Boolean) as string[]);

  if (candidates.length === 0) {
    const envHome = process.env.CODEX_HOME;
    if (envHome) candidates.push(envHome);
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (userProfile) candidates.push(path.join(userProfile, ".codex"));
  }

  const seen = new Set<string>();
  const homes: CodexHome[] = [];
  for (const candidate of candidates) {
    const resolved = resolveRootToCodexHome(candidate) ?? candidate;
    const absolute = path.resolve(resolved);
    const key = absolute.toLowerCase();
    if (seen.has(key) || !dirExists(absolute)) continue;
    seen.add(key);
    homes.push({ path: absolute, label: labelForHome(absolute, homes.length + 1) });
  }
  return homes;
}

function resolveRootToCodexHome(input: string): string | null {
  const absolute = path.resolve(input);
  if (!dirExists(absolute)) return null;
  if (path.basename(absolute).toLowerCase() === ".codex") return absolute;
  const child = path.join(absolute, ".codex");
  if (dirExists(child)) return child;
  if (looksLikeCodexHome(absolute)) return absolute;
  return null;
}

function looksLikeCodexHome(dir: string): boolean {
  return existsSync(path.join(dir, "sessions"))
    || existsSync(path.join(dir, "archived_sessions"))
    || existsSync(path.join(dir, "auth.json"))
    || hasStateSqlite(dir);
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
    if (!stats.isDirectory()) return `source-${index}`;
  } catch {
    return `source-${index}`;
  }
  const parent = path.basename(path.dirname(home));
  if (parent && parent !== "." && parent !== path.parse(home).root) return parent;
  return `source-${index}`;
}
