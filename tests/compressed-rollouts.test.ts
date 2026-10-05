import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRolloutEvents } from "../src/rollouts";
import { ROLLOUT_PARSE_CACHE_VERSION } from "../src/parse-cache";

const record = (tokens: number) =>
  JSON.stringify({
    timestamp: "2026-10-01T00:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: tokens, total_tokens: tokens } },
    },
  });

test("compressed archives stream JSONL, reuse cache, invalidate changes and prune replaced plaintext", async () => {
  const home = mkdtempSync(join(tmpdir(), "compressed-rollouts-"));
  const archives = join(home, "archived_sessions");
  mkdirSync(archives);
  mkdirSync(join(home, "sessions"));
  const plain = join(archives, "rollout-test.jsonl");
  const compressed = `${plain}.zst`;
  const cacheDir = join(home, "cache");
  const options = {
    homes: [{ path: home, label: "test" }],
    timezone: "UTC",
    from: null,
    to: null,
    cacheDir,
  };
  const text = `${JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "unicode   preserved" }],
    },
  })}\r\n${record(10)}`;
  writeFileSync(plain, text);
  const initial = await collectRolloutEvents(options);
  renameSync(plain, join(home, "original"));
  writeFileSync(compressed, Bun.zstdCompressSync(text));
  const cold = await collectRolloutEvents(options);
  const warm = await collectRolloutEvents(options);
  expect(cold.events.map((e) => e.breakdown)).toEqual(initial.events.map((e) => e.breakdown));
  expect(cold.coverage).toMatchObject({ discoveredFiles: 1, parsedFiles: 1, malformedLines: 0 });
  expect(warm.cache.hits).toBe(1);
  const cache = JSON.parse(
    readFileSync(join(cacheDir, `rollouts-v${ROLLOUT_PARSE_CACHE_VERSION}.json`), "utf8"),
  );
  expect(Object.keys(cache.files)).toEqual([compressed]);
  writeFileSync(compressed, Bun.zstdCompressSync(record(12345)));
  const changed = await collectRolloutEvents(options);
  expect(changed.cache.invalidations).toBe(1);
  expect(changed.events[0]?.breakdown.totalTokens).toBe(12345);
  expect(readdirSync(archives)).toEqual(["rollout-test.jsonl.zst"]);
});

test("corrupt compressed archives are reported as failed sources", async () => {
  const home = mkdtempSync(join(tmpdir(), "corrupt-rollouts-"));
  mkdirSync(join(home, "sessions"));
  mkdirSync(join(home, "archived_sessions"));
  writeFileSync(join(home, "archived_sessions", "rollout-bad.jsonl.zst"), "invalid zstd");
  const result = await collectRolloutEvents({
    homes: [{ path: home, label: "test" }],
    timezone: "UTC",
    from: null,
    to: null,
  });
  expect(result.coverage).toMatchObject({ status: "partial", failedFiles: 1 });
  expect(result.parseErrors).toHaveLength(1);
});
