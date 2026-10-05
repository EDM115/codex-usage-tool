import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDemoDataset } from "../scripts/generate-demo";
import { loadUsageDatasets } from "../src/usage-json";
import { loadRolloutParseCache, saveRolloutParseCache } from "../src/parse-cache";

test("old namespace guesses are dropped from imported evidence and invalidate affected parse entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "recorded-plugins-"));
  const dataset = await buildDemoDataset();
  const guessed = {
    ...dataset.local.capabilityEvents.find((event) => event.kind === "plugin")!,
    eventId: "guessed",
    detail: "Called MCP tool mcp__unknown__action, plugin inferred from namespace",
    evidenceType: "tool_call" as const,
    confidence: "medium" as const,
  };
  const recorded = {
    ...guessed,
    eventId: "recorded",
    detail: "Called plugin tool mcp__unknown__action",
    confidence: "high" as const,
  };
  dataset.local.capabilityEvents = [guessed, recorded];
  const input = join(root, "usage.json");
  writeFileSync(input, JSON.stringify(dataset));
  expect(loadUsageDatasets([input])[0]!.local.capabilityEvents).toEqual([recorded]);
  saveRolloutParseCache(root, {
    entries: new Map([
      [
        "guessed.jsonl",
        { size: 1, mtimeMs: 1, events: [], capabilityEvents: [guessed], parseErrors: [] },
      ],
      [
        "recorded.jsonl",
        { size: 1, mtimeMs: 1, events: [], capabilityEvents: [recorded], parseErrors: [] },
      ],
    ]),
  });
  expect([...loadRolloutParseCache(root).entries.keys()]).toEqual(["recorded.jsonl"]);
});
