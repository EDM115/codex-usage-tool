import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexHome, UsageDataset } from "../src/types";

let root: string;
let profile: string;
let local: string;
let extra: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "usage-home-discovery-")));
  profile = join(root, "current-user");
  local = join(profile, ".codex");
  extra = join(root, "backup", ".codex");
  mkdirSync(local, { recursive: true });
  mkdirSync(extra, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function isolatedEnv(envHome = "") {
  return { ...process.env, HOME: profile, USERPROFILE: profile, CODEX_HOME: envHome, CODEX_API_KEY: "", OPENAI_API_KEY: "" };
}

function discover(homes: string[] = [], roots: string[] = [], autoDiscover = true, envHome = "", environment: Record<string, string> = {}): CodexHome[] {
  const modulePath = resolve("src/codex-homes.ts");
  const child = Bun.spawnSync({
    cmd: [process.execPath, "--eval", `import { resolveCodexHomes } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(resolveCodexHomes(${JSON.stringify(homes)}, ${JSON.stringify(roots)}, ${autoDiscover})));`],
    env: { ...isolatedEnv(envHome), ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString());
}

test("default discovery checks only the current user's .codex directory", () => {
  mkdirSync(join(profile, "nested", ".codex"), { recursive: true });
  mkdirSync(join(root, "other-user", ".codex"), { recursive: true });
  expect(discover().map((home) => home.path)).toEqual([local]);
  rmSync(local, { recursive: true });
  expect(discover()).toEqual([]);
});

test("automatic discovery remains additive with explicit homes and roots", () => {
  expect(discover([extra]).map((home) => home.path)).toEqual([extra, local]);
  expect(discover([], [join(root, "backup")]).map((home) => home.path)).toEqual([extra, local]);
});

test("discovery follows the platform's home when HOME and USERPROFILE differ", () => {
  const unrelated = join(root, "unrelated-profile");
  mkdirSync(join(unrelated, ".codex"), { recursive: true });
  const environment: Record<string, string> = process.platform === "win32" ? { HOME: unrelated } : { USERPROFILE: unrelated };
  expect(discover([], [], true, "", environment).map((home) => home.path)).toEqual([local]);
});

test("CODEX_HOME and the current user's default home remain additive", () => {
  const configured = join(root, "configured-home");
  mkdirSync(configured);
  expect(discover([extra], [], true, configured).map((home) => home.path)).toEqual([extra, configured, local]);
});

test("equivalent explicit and automatic paths contribute a home only once", () => {
  expect(discover([join(local, "."), local], [profile], true, local).map((home) => home.path)).toEqual([local]);
  const alias = join(root, "home-link");
  symlinkSync(local, alias, process.platform === "win32" ? "junction" : "dir");
  expect(discover([alias]).map((home) => home.path)).toEqual([alias]);
});

test("disabling discovery retains explicit sources and skips automatic ones", () => {
  expect(discover([extra], [], false, local).map((home) => home.path)).toEqual([extra]);
  expect(discover([], [], false, extra)).toEqual([]);
});

function collect(args: string[], output: string): UsageDataset {
  const child = Bun.spawnSync({
    cmd: [process.execPath, resolve("src/cli.ts"), "collect", ...args, "--source", "local", "--no-api", "--pricing-source", "bundled", "--no-history", "--timezone", "Europe/Paris", "--out", output],
    cwd: root,
    env: isolatedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(readFileSync(join(output, "usage-data.json"), "utf8"));
}

test("CLI keeps the local home when importing JSON and supports explicit opt-out", () => {
  mkdirSync(join(local, "sessions"));
  writeFileSync(join(local, "sessions", "rollout-discovery.jsonl"), [
    { type: "session_meta", payload: { id: "discovery-fixture" } },
    { type: "event_msg", timestamp: "2026-10-01T12:00:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 42, total_tokens: 42 } } } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const imported = join(root, "imported", "usage-data.json");
  collect(["--codex-home", extra, "--no-auto-discovery"], join(root, "imported"));

  const explicit = collect(["--codex-home", extra], join(root, "explicit"));
  expect(explicit.codexHomes.map((home) => home.path)).toEqual([extra, local]);
  expect(explicit.summary.localKnownTokens).toBe(42);

  const combined = collect(["--usage-json", imported], join(root, "combined"));
  expect(combined.codexHomes.map((home) => home.path).sort()).toEqual([extra, local].sort());
  expect(combined.summary.localKnownTokens).toBe(42);

  const isolated = collect(["--usage-json", imported, "--no-auto-discovery"], join(root, "isolated"));
  expect(isolated.codexHomes.map((home) => home.path)).toEqual([extra]);
  expect(isolated.summary.localKnownTokens).toBe(0);

  const deduplicated = collect(["--codex-home", local, "--usage-json", imported], join(root, "deduplicated"));
  expect(deduplicated.codexHomes.map((home) => home.path).sort()).toEqual([extra, local].sort());
  expect(deduplicated.summary.localKnownTokens).toBe(42);
});
