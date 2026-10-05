import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("CLI overlaps payment history with profile, local collection, and WHAM and retains the request count", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-api-overlap-"));
  const home = join(root, ".codex");
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(home, "archived_sessions"));
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test", account_id: "test-account" } }),
  );
  writeFileSync(
    join(home, "sessions", "rollout-2026-09-01T00-00-00-test.jsonl"),
    JSON.stringify({
      timestamp: "2026-09-01T00:00:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 10, total_tokens: 10 } },
      },
    }),
  );
  const requests: string[] = [];
  let releasePayment!: () => void;
  const paymentGate = new Promise<void>((resolve) => {
    releasePayment = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/backend-api/payments/transaction-history") {
        await paymentGate;
        return Response.json({ transactions: [], next_cursor: null });
      }
      if (path === "/backend-api/wham/profiles/me")
        return Response.json({ stats: {}, daily_usage: [] });
      releasePayment();
      return Response.json({ data: [] });
    },
  });
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("src/cli.ts"),
      "collect",
      "--codex-home",
      home,
      "--base-url",
      `http://127.0.0.1:${server.port}/backend-api`,
      "--pricing-source",
      "bundled",
      "--from",
      "2026-09-01",
      "--to",
      "2026-09-30",
      "--sections",
      "skills",
      "--no-history",
      "--out",
      join(root, "output"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => {
    releasePayment();
    child.kill();
  }, 5000);
  try {
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(exit).toBe(0);
    expect(requests[0]).toBe("/backend-api/payments/transaction-history");
    expect(requests).toContain("/backend-api/wham/profiles/me");
    expect(stderr).toContain("WHAM analytics ready [7/7]");
    expect(stderr).toContain("Processed 1/1 source");
    const importedRun = Bun.spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "collect",
        "--codex-home",
        home,
        "--usage-json",
        join(root, "output", "usage-data.json"),
        "--base-url",
        `http://127.0.0.1:${server.port}/backend-api`,
        "--pricing-source",
        "bundled",
        "--from",
        "2026-09-01",
        "--to",
        "2026-09-30",
        "--sections",
        "skills",
        "--no-history",
        "--out",
        join(root, "imported-output"),
      ],
      { cwd: mkdtempSync(join(tmpdir(), "usage-imported-cache-")), stdout: "pipe", stderr: "pipe" },
    );
    const [importedExit, importedStderr] = await Promise.all([
      importedRun.exited,
      new Response(importedRun.stderr).text(),
      new Response(importedRun.stdout).text(),
    ]);
    expect(importedExit).toBe(0);
    expect(importedStderr).toContain("Payment transaction history ready (reused from usage JSON)");
    expect(
      requests.filter((path) => path === "/backend-api/payments/transaction-history"),
    ).toHaveLength(1);
  } finally {
    clearTimeout(timeout);
    releasePayment();
    child.kill();
    server.stop(true);
  }
}, 10000);

test("CLI displays live request counts and active payment pagination names", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-live-progress-"));
  const home = join(root, ".codex");
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(home, "archived_sessions"));
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test", account_id: "test" } }),
  );
  let pages = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (path.endsWith("transaction-history"))
        return Response.json({ transactions: [], next_cursor: ++pages === 1 ? "second" : null });
      return Response.json({ data: [], stats: {} });
    },
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "collect",
        "--codex-home",
        home,
        "--base-url",
        `http://127.0.0.1:${server.port}/backend-api`,
        "--pricing-source",
        "bundled",
        "--sections",
        "skills",
        "--no-history",
        "--out",
        join(root, "output"),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(exit).toBe(0);
    expect(stderr).not.toContain("Waiting for account API requests");
    expect(stderr).toMatch(/Fetching account APIs \[\d+\/\d+\] : .*payments page 2/);
    expect(stderr).toMatch(/Fetching account APIs \[\d+\/\d+\] : .*usage/);
    expect(stderr).toContain("Fetching account APIs [10/10]");
    expect(stderr).toContain("WHAM analytics ready [7/7]");
  } finally {
    server.stop(true);
  }
});
