import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadUsageDatasets, mergeUsageDatasets } from "../src/usage-json";
import { loadPricing } from "../src/pricing";
import { Database } from "bun:sqlite";

function home(root: string, name: string, auth: unknown, tokens: number) {
  const path = join(root, name, ".codex");
  mkdirSync(join(path, "sessions"), { recursive: true });
  mkdirSync(join(path, "archived_sessions"));
  writeFileSync(join(path, "auth.json"), JSON.stringify(auth));
  writeFileSync(join(path, "sessions", `rollout-${name}.jsonl`), [
    { type: "session_meta", payload: { id: name } },
    { type: "event_msg", timestamp: "2026-10-01T12:00:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: tokens, total_tokens: tokens } } } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const db = new Database(join(path, "state_1.sqlite"));
  db.run("create table threads (id text, rollout_path text, title text, updated_at integer)");
  db.run("insert into threads values (?, ?, ?, ?)", [name, join(path, "sessions", `rollout-${name}.jsonl`), name, 1790856000]);
  db.close();
  return path;
}

async function collect(root: string, homes: string[], baseUrl: string, extra: string[] = []) {
  const out = join(root, "output");
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "collect", "--no-auto-discovery", ...homes.flatMap((path) => ["--codex-home", path]), "--base-url", baseUrl, "--pricing-source", "bundled", "--sections", "skills,chats", "--from", "2026-10-01", "--to", "2026-10-02", "--no-history", "--out", out, ...extra], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CODEX_API_KEY: "", OPENAI_API_KEY: "" } });
  const [exit, stderr, stdout] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect(exit, stderr).toBe(0);
  return { dataset: loadUsageDatasets([join(out, "usage-data.json")])[0], stderr, stdout, text: readFileSync(join(out, "usage-data.json"), "utf8") };
}

test("CLI fetches each distinct account and adds API-key local usage without leaking credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-multi-account-"));
  const homes = [
    home(root, "account-a", { tokens: { access_token: "private-token-a", account_id: "a" } }, 20),
    home(root, "account-b", { tokens: { access_token: "private-token-b", account_id: "b" } }, 30),
    home(root, "backup-a", { tokens: { access_token: "private-token-a", account_id: "a" } }, 0),
    home(root, "api-key", { auth_mode: "apikey", OPENAI_API_KEY: "private-api-key" }, 10),
  ];
  const requests: Array<{ account: string | null; path: string; body?: any }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const account = request.headers.get("ChatGPT-Account-Id");
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : undefined;
    requests.push({ account, path, body });
    const tokens = account === "a" ? 100 : 200;
    if (path.endsWith("profiles/me")) return Response.json({ summary: { lifetime_tokens: tokens * 10 }, daily_usage_buckets: [{ start_date: "2026-10-01", tokens }] });
    if (path.endsWith("transaction-history")) return Response.json({ transactions: [], next_cursor: null });
    if (path.endsWith("daily-workspace-usage-counts")) return Response.json({ data: [{ date: "2026-10-01", totals: { text_total_tokens: tokens, turns: 1 }, clients: [], models: [] }] });
    return Response.json({ data: [] });
  } });
  try {
    const run = await collect(root, homes, `http://127.0.0.1:${server.port}/backend-api`);
    expect(requests.filter((row) => row.path.endsWith("profiles/me")).map((row) => row.account).sort()).toEqual(["a", "b"]);
    expect(requests.filter((row) => row.path.endsWith("transaction-history")).map((row) => row.account).sort()).toEqual(["a", "b"]);
    expect(requests.every((row) => row.account === "a" || row.account === "b")).toBe(true);
    expect(run.dataset.daily[0].totalTokens).toBe(310);
    expect(run.dataset.daily[0].backendTokens).toBe(300);
    expect(run.dataset.summary.lifetimeTokens).toBe(3010);
    expect(run.dataset.analytics?.totals.textTotalTokens).toBe(300);
    expect(run.dataset.profile?.accounts).toHaveLength(2);
    expect(run.dataset.authentication?.homes.filter((row) => row.mode === "api-key")).toHaveLength(1);
    const threadRequests = requests.filter((row) => row.body);
    expect(threadRequests).toHaveLength(2);
    expect(threadRequests.every((row) => JSON.stringify(row.body).includes(row.account === "a" ? "account-a" : "account-b") && !JSON.stringify(row.body).includes(row.account === "a" ? "account-b" : "account-a"))).toBe(true);
    expect(run.text).not.toContain("private-token");
    expect(run.text).not.toContain("private-api-key");
    expect(run.stderr).toContain("account-a");
    expect(run.stderr).toContain("account-b");
    const merged = mergeUsageDatasets([run.dataset, run.dataset], { from: null, to: null, timezone: run.dataset.timezone, pricing: await loadPricing({ source: "bundled" }) });
    expect(merged.daily[0].totalTokens).toBe(310);
    expect(merged.summary.lifetimeTokens).toBe(3010);
    expect(merged.analytics?.totals.textTotalTokens).toBe(300);
  } finally { server.stop(true); }
});

test("API-key-only CLI report uses local usage and skips account APIs automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-api-key-only-"));
  const path = home(root, "api-key", { auth_mode: "apikey", OPENAI_API_KEY: "private-api-key" }, 42);
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("unexpected", { status: 500 }); } });
  try {
    const run = await collect(root, [path], `http://127.0.0.1:${server.port}/backend-api`);
    expect(calls).toBe(0);
    expect(run.dataset.summary.lifetimeTokens).toBe(42);
    expect(run.dataset.authentication?.homes[0].mode).toBe("api-key");
    expect(run.stderr).toContain("API-key authentication");
    expect(run.stderr).not.toContain("Profile data unavailable");
    expect(run.stderr).not.toContain("WHAM analytics unavailable");
    expect(run.dataset.payments.error).toBeUndefined();
  } finally { server.stop(true); }
});

test("a revoked token in one home cannot hide another valid credential for the same account", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-account-token-fallback-"));
  const homes = [home(root, "revoked", { tokens: { access_token: "revoked-token", account_id: "shared" } }, 1), home(root, "valid", { tokens: { access_token: "valid-token", account_id: "shared" } }, 1)];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.get("Authorization") === "Bearer revoked-token") return new Response("expired", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path.endsWith("profiles/me")) return Response.json({ summary: { lifetime_tokens: 100 }, daily_usage_buckets: [{ start_date: "2026-10-01", tokens: 100 }] });
    if (path.endsWith("transaction-history")) return Response.json({ transactions: [], next_cursor: null });
    return Response.json({ data: [] });
  } });
  try {
    const run = await collect(root, homes, `http://127.0.0.1:${server.port}/backend-api`);
    expect(run.dataset.daily[0].backendTokens).toBe(100);
    expect(run.dataset.profile?.error).toBeUndefined();
    expect(run.dataset.payments.error).toBeUndefined();
    expect(run.dataset.analytics?.error).toBeUndefined();
  } finally { server.stop(true); }
});

test("a legacy payment JSON cannot establish cache freshness after the home switches accounts", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-legacy-account-switch-"));
  const path = home(root, "shared-home", { tokens: { access_token: "token-a", account_id: "a" } }, 1);
  let paymentCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const endpoint = new URL(request.url).pathname;
    if (endpoint.endsWith("transaction-history")) { paymentCalls++; return Response.json({ transactions: [], next_cursor: null }); }
    if (endpoint.endsWith("profiles/me")) return Response.json({ summary: { lifetime_tokens: 10 }, daily_usage_buckets: [] });
    return Response.json({ data: [] });
  } });
  try {
    const first = await collect(root, [path], `http://127.0.0.1:${server.port}/backend-api`);
    const legacy = structuredClone(first.dataset);
    delete legacy.authentication;
    delete legacy.profile?.accounts;
    delete legacy.analytics?.accountId;
    delete legacy.analytics?.accounts;
    delete legacy.payments.accountId;
    delete legacy.payments.accounts;
    const saved = join(root, "legacy.json");
    writeFileSync(saved, JSON.stringify(legacy));
    writeFileSync(join(path, "auth.json"), JSON.stringify({ tokens: { access_token: "token-b", account_id: "b" } }));
    await collect(root, [path], `http://127.0.0.1:${server.port}/backend-api`, ["--usage-json", saved]);
    expect(paymentCalls).toBe(2);
  } finally { server.stop(true); }
});
