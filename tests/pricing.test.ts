import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../src/cli";
import { createModelCatalog, pricingAt, primaryModelAt, resolveModelAt } from "../src/model-catalog";
import { estimateBreakdownCost, loadPricing } from "../src/pricing";
import type { TokenBreakdown } from "../src/types";

const OPENAI_PRICING_FIXTURE = `
<TextTokenPricingTables
  tier="standard"
  rows={[
    ["gpt-5.5 (<272K context length)", 5, 0.5, "-", 30],
    ["gpt-5.4", 2.5, 0.25, "-", 15],
    ["gpt-5.1", 1.25, 0.125, "-", 10]
  ]}
/>
<TextTokenPricingTables
  tier="batch"
  rows={[
    ["gpt-5.5", 2.5, 0.25, "-", 15]
  ]}
/>
<TextTokenPricingTables
  tier="flex"
  rows={[
    ["gpt-5.5", 1, 0.1, "-", 6]
  ]}
/>
<TextTokenPricingTables
  tier="priority"
  rows={[
    ["gpt-5.5", 12.5, 1.25, "-", 75],
    ["gpt-5.4", 5, 0.5, "-", 30],
    ["gpt-5.1", 2.5, 0.25, "-", 20]
  ]}
/>
`;

const OPENAI_MARKDOWN_TABLE_PRICING_FIXTURE = `
### Standard pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-table-layout | $7.00 | $0.70 | $8.75 | $42.00 | $14.00 | $1.40 | $17.50 | $63.00 |

### Batch pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-table-layout | $3.50 | $0.35 | $4.375 | $21.00 | $7.00 | $0.70 | $8.75 | $31.50 |

### Fast pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output |
| --- | --- | --- | --- | --- |
| gpt-table-layout | $14.00 | $1.40 | $17.50 | $84.00 |

Cyber models

### Grouped Pricing Table data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-cyber | $12.50 | $1.25 | $15.625 | $75.00 | - | - | - | - |
`;

const MODELS_DEV_FIXTURE = {
  openai: {
    models: {
      "gpt-5.1-codex": {
        cost: { input: 100, cache_read: 10, output: 100 },
      },
      "gpt-5.3-codex": {
        cost: { input: 1.75, cache_read: 0.175, output: 14 },
      },
      "gpt-5.5": {
        cost: { input: 999, cache_read: 99, output: 999 },
      },
    },
  },
};

const ONE_MILLION_INPUT_AND_OUTPUT: TokenBreakdown = {
  totalTokens: 2_000_000,
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  outputTokens: 1_000_000,
  reasoningOutputTokens: 0,
};

async function loadFixture(openAiMarkdown = OPENAI_PRICING_FIXTURE, effectiveDate?: string) {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);

    if (url.includes("developers.openai.com")) {
      return new Response(openAiMarkdown, { status: 200 });
    }

    if (url.includes("models.dev")) {
      return Response.json(MODELS_DEV_FIXTURE);
    }

    return new Response("not found", { status: 404 });
  };

  return loadPricing({ source: "openai", fetcher: fetcher as typeof fetch, effectiveDate });
}

function estimate(
  pricing: Awaited<ReturnType<typeof loadPricing>>,
  model: string,
  serviceTier?: string,
  breakdown = ONE_MILLION_INPUT_AND_OUTPUT,
  modelContextWindow?: number,
  date = "9999-12-31",
) {
  return estimateBreakdownCost(breakdown, model, pricing.catalog, "gpt-5.6-sol", {
    date,
    serviceTier,
    modelContextWindow,
  });
}

test("model defaults, aliases, and bundled prices change only on their effective dates", async () => {
  const pricing = await loadPricing({ source: "bundled" });

  expect(primaryModelAt(pricing.catalog, "2026-07-08")).toBe("gpt-5.5");
  expect(primaryModelAt(pricing.catalog, "2026-07-09")).toBe("gpt-5.6-sol");
  expect(primaryModelAt(pricing.catalog, "2026-09-02")).toBe("gpt-5.6-sol");
  expect(primaryModelAt(pricing.catalog, "2026-09-03")).toBe("gpt-6-astra");
  expect(pricingAt(pricing.catalog, "gpt-6-astra", "2026-09-02")).toBeUndefined();
  expect(pricingAt(pricing.catalog, "gpt-6-astra", "2026-09-03")?.inputPerMillion).toBe(10);
  expect(resolveModelAt(pricing.catalog, "guardian", "2026-07-29")).toBe("gpt-5.4");
  expect(resolveModelAt(pricing.catalog, "guardian", "2026-07-30")).toBe("gpt-5.6-luna");
  expect(
    estimate(
      pricing,
      "gpt-5.6-terra",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-07-29",
    ),
  ).toBeCloseTo(17.5);
  expect(
    estimate(
      pricing,
      "gpt-5.6-terra",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-07-30",
    ),
  ).toBeCloseTo(14);
  expect(
    estimate(
      pricing,
      "gpt-5.6-luna",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-07-29",
    ),
  ).toBeCloseTo(7);
  expect(
    estimate(
      pricing,
      "gpt-5.6-luna",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-07-30",
    ),
  ).toBeCloseTo(1.4);
  expect(
    estimate(
      pricing,
      "gpt-6-astra",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-09-03",
    ),
  ).toBeCloseTo(60);
});

test("the bundled refresh preserves GPT-5.6 Sol history and uses the official Daybreak IDs", async () => {
  const pricing = await loadPricing({ source: "bundled" });

  expect(
    estimate(
      pricing,
      "gpt-5.6-sol",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-08-20",
    ),
  ).toBeCloseTo(35);
  expect(
    estimate(
      pricing,
      "gpt-5.6-sol",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-08-21",
    ),
  ).toBeCloseTo(24);
  expect(resolveModelAt(pricing.catalog, "gpt-daybreak-red-latest", "2026-08-21")).toBe(
    "gpt-5.6-cyber",
  );
  expect(resolveModelAt(pricing.catalog, "gpt-daybreak-blue-latest", "2026-08-21")).toBe(
    "gpt-5.6-sol",
  );
  expect(resolveModelAt(pricing.catalog, "daybreak-red-latest", "2026-08-21")).toBe(
    "gpt-5.6-cyber",
  );
  expect(resolveModelAt(pricing.catalog, "daybreak-blue-latest", "2026-08-21")).toBe(
    "gpt-5.6-sol",
  );
  expect(pricing.table.get("gpt-daybreak-red-latest")?.aliasFor).toBe("gpt-5.6-cyber");
  expect(pricing.table.get("gpt-daybreak-blue-latest")?.aliasFor).toBe("gpt-5.6-sol");
  expect(pricing.table.get("daybreak-red-latest")?.aliasFor).toBe(
    "gpt-daybreak-red-latest",
  );
  expect(pricing.table.get("daybreak-blue-latest")?.aliasFor).toBe(
    "gpt-daybreak-blue-latest",
  );
  expect(
    estimate(
      pricing,
      "gpt-daybreak-red-latest",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-08-21",
    ),
  ).toBeCloseTo(87.5);
  expect(
    estimate(
      pricing,
      "gpt-daybreak-blue-latest",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-08-21",
    ),
  ).toBeCloseTo(24);
  expect(
    estimate(
      pricing,
      "daybreak-red-latest",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-08-21",
    ),
  ).toBeCloseTo(87.5);
  expect(
    estimate(
      pricing,
      "daybreak-blue-latest",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-08-21",
    ),
  ).toBeCloseTo(24);
});

test("a changed live price starts on the fetch date without repricing earlier usage", async () => {
  const changedMarkdown = OPENAI_PRICING_FIXTURE.replace(
    '["gpt-5.4", 2.5, 0.25, "-", 15],',
    '["gpt-5.4", 7, 0.7, "-", 42],',
  ).replace('["gpt-5.4", 5, 0.5, "-", 30],', '["gpt-5.4", 14, 1.4, "-", 84],');
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);

    if (url.includes("developers.openai.com")) {
      return new Response(changedMarkdown, { status: 200 });
    }

    if (url.includes("models.dev")) {
      return Response.json(MODELS_DEV_FIXTURE);
    }

    return new Response("not found", { status: 404 });
  };
  const pricing = await loadPricing({
    source: "openai",
    fetcher: fetcher as typeof fetch,
    effectiveDate: "2026-07-31",
  });

  expect(
    estimate(pricing, "gpt-5.4", undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-07-30"),
  ).toBeCloseTo(17.5);
  expect(
    estimate(pricing, "gpt-5.4", undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-07-31"),
  ).toBeCloseTo(49);
});

test("bundled history preserves earlier documented GPT-4o and GPT-3.5 price periods", async () => {
  const pricing = await loadPricing({ source: "bundled" });
  const cachedInput: TokenBreakdown = {
    totalTokens: 1_000_000,
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };

  expect(
    estimate(pricing, "gpt-4o", undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2024-08-05"),
  ).toBeCloseTo(20);
  expect(
    estimate(pricing, "gpt-4o", undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2024-08-06"),
  ).toBeCloseTo(12.5);
  expect(estimate(pricing, "gpt-4o", undefined, cachedInput, undefined, "2024-09-30")).toBeCloseTo(
    2.5,
  );
  expect(estimate(pricing, "gpt-4o", undefined, cachedInput, undefined, "2024-10-01")).toBeCloseTo(
    1.25,
  );
  expect(
    estimate(
      pricing,
      "gpt-3.5-turbo",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2023-03-01",
    ),
  ).toBeCloseTo(4);
  expect(
    estimate(
      pricing,
      "gpt-3.5-turbo",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2023-06-13",
    ),
  ).toBeCloseTo(3.5);
  expect(
    estimate(
      pricing,
      "gpt-3.5-turbo",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2023-11-06",
    ),
  ).toBeCloseTo(3);
  expect(
    estimate(
      pricing,
      "gpt-3.5-turbo",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2024-01-25",
    ),
  ).toBeCloseTo(2);
});

test("catalog validation rejects duplicate pricing periods instead of silently replacing one", () => {
  const period = {
    model: "gpt-test",
    effectiveFrom: "2026-01-01",
    inputPerMillion: 1,
    outputPerMillion: 2,
    source: "fixture",
  };

  expect(() =>
    createModelCatalog(
      [period, { ...period, inputPerMillion: 3 }],
      [
        {
          model: "gpt-test",
          releasedOn: "2026-01-01",
          canBePrimary: true,
          source: "fixture",
        },
      ],
      [],
    ),
  ).toThrow("Duplicate pricing definition for gpt-test on 2026-01-01");

  expect(() =>
    createModelCatalog(
      [],
      [
        {
          model: "gpt-invalid-date",
          releasedOn: "2026-02-31",
          canBePrimary: false,
          source: "fixture",
        },
      ],
      [],
    ),
  ).toThrow("Invalid release date for gpt-invalid-date");
});

test("custom pricing JSON accepts explicit effective-dated history", async () => {
  const root = join(tmpdir(), `codex-pricing-history-${crypto.randomUUID()}`);
  const path = join(root, "pricing.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify([
      {
        model: "gpt-custom",
        effectiveFrom: "2026-01-01",
        inputPerMillion: 1,
        outputPerMillion: 2,
      },
      {
        model: "gpt-custom",
        effectiveFrom: "2026-02-01",
        inputPerMillion: 3,
        outputPerMillion: 4,
      },
    ]),
  );
  const pricing = await loadPricing({
    source: "bundled",
    pricingJson: path,
    effectiveDate: "2026-03-01",
  });

  expect(
    estimate(
      pricing,
      "gpt-custom",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-01-31",
    ),
  ).toBeCloseTo(3);
  expect(
    estimate(
      pricing,
      "gpt-custom",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-02-01",
    ),
  ).toBeCloseTo(7);
});

test("OpenAI standard and Priority prices override models.dev", async () => {
  const pricing = await loadFixture();

  expect(estimate(pricing, "gpt-5.5")).toBeCloseTo(35);
  expect(estimate(pricing, "gpt-5.5", "default")).toBeCloseTo(35);
  expect(estimate(pricing, "gpt-5.5", "priority")).toBeCloseTo(87.5);
});

test("rendered OpenAI Markdown parses Fast and Cyber tables while accepting both tier names", async () => {
  const pricing = await loadFixture(OPENAI_MARKDOWN_TABLE_PRICING_FIXTURE, "2026-08-21");
  const longRequest: TokenBreakdown = {
    totalTokens: 400_000,
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 100_000,
    reasoningOutputTokens: 0,
  };

  expect(pricing.source).toBe(
    "bundled effective-dated history + developers.openai.com/api/docs/pricing.md current snapshot + models.dev fallback",
  );
  expect(pricing.warning).toBeUndefined();
  expect(estimate(pricing, "gpt-table-layout")).toBeCloseTo(49);
  expect(estimate(pricing, "gpt-table-layout", "batch")).toBeCloseTo(24.5);
  expect(estimate(pricing, "gpt-table-layout", "priority")).toBeCloseTo(98);
  expect(estimate(pricing, "gpt-table-layout", "fast")).toBeCloseTo(98);
  expect(estimate(pricing, "gpt-5.6-cyber")).toBeCloseTo(87.5);
  expect(estimate(pricing, "gpt-table-layout", undefined, longRequest, 1_050_000)).toBeCloseTo(
    10.5,
  );
});

test("Batch and Flex prices are used only for an explicit event tier", async () => {
  const pricing = await loadFixture();

  expect(estimate(pricing, "gpt-5.5")).toBeCloseTo(35);
  expect(estimate(pricing, "gpt-5.5", "batch")).toBeCloseTo(17.5);
  expect(estimate(pricing, "gpt-5.5", "flex")).toBeCloseTo(7);
});

test("known aliases use OpenAI prices and models.dev-only models get a 2x Priority fallback", async () => {
  const pricing = await loadFixture();

  expect(estimate(pricing, "gpt-5.1-codex")).toBeCloseTo(11.25);
  expect(estimate(pricing, "gpt-5.1-codex", "priority")).toBeCloseTo(22.5);
  expect(estimate(pricing, "gpt-5.3-codex")).toBeCloseTo(15.75);
  expect(estimate(pricing, "gpt-5.3-codex", "priority")).toBeCloseTo(31.5);
});

test("codex-auto-review follows its dated alias unless OpenAI publishes an exact row", async () => {
  const pricing = await loadFixture();

  expect(
    estimate(
      pricing,
      "codex-auto-review",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-07-29",
    ),
  ).toBeCloseTo(17.5);
  expect(
    estimate(
      pricing,
      "guardian",
      "priority",
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-07-30",
    ),
  ).toBeCloseTo(2.8);

  const exactPricing = await loadFixture(
    OPENAI_PRICING_FIXTURE.replace(
      '["gpt-5.4", 2.5, 0.25, "-", 15],',
      '["gpt-5.4", 2.5, 0.25, "-", 15],\n    ["codex-auto-review", 7, 0.7, "-", 21],',
    ).replace(
      '["gpt-5.4", 5, 0.5, "-", 30],',
      '["gpt-5.4", 5, 0.5, "-", 30],\n    ["codex-auto-review", 14, 1.4, "-", 42],',
    ),
    "2026-07-30",
  );

  expect(
    estimate(
      exactPricing,
      "codex-auto-review",
      undefined,
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-07-30",
    ),
  ).toBeCloseTo(28);
  expect(
    estimate(
      exactPricing,
      "codex-auto-review",
      "priority",
      ONE_MILLION_INPUT_AND_OUTPUT,
      undefined,
      "2026-07-30",
    ),
  ).toBeCloseTo(56);
});

test("long-context prices require both a known high context limit and a request over 272K input tokens", async () => {
  const astraMarkdown = OPENAI_PRICING_FIXTURE.replace(
    '["gpt-5.5 (<272K context length)", 5, 0.5, "-", 30],',
    '["gpt-6-astra", 10, 1, 12.5, 50],\n    ["gpt-5.5 (<272K context length)", 5, 0.5, "-", 30],',
  ).replace(
    '["gpt-5.5", 12.5, 1.25, "-", 75],',
    '["gpt-6-astra", 20, 2, 25, 100],\n    ["gpt-5.5", 12.5, 1.25, "-", 75],',
  );
  const pricing = await loadFixture(astraMarkdown, "2026-09-04");
  const longRequest: TokenBreakdown = {
    totalTokens: 400_000,
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 100_000,
    reasoningOutputTokens: 0,
  };
  const shortRequest: TokenBreakdown = {
    ...longRequest,
    totalTokens: 300_000,
    inputTokens: 200_000,
  };

  expect(estimate(pricing, "gpt-5.5", undefined, longRequest)).toBeCloseTo(4.5);
  expect(estimate(pricing, "gpt-5.5", undefined, longRequest, 128_000)).toBeCloseTo(4.5);
  expect(estimate(pricing, "gpt-5.5", undefined, longRequest, 1_050_000)).toBeCloseTo(7.5);
  expect(estimate(pricing, "gpt-5.5", undefined, shortRequest, 1_050_000)).toBeCloseTo(4);
  expect(
    estimate(
      pricing,
      "gpt-6-astra",
      undefined,
      longRequest,
      1_050_000,
      "2026-09-04",
    ),
  ).toBeCloseTo(13.5);
});

test("CLI pricing defaults to the authoritative OpenAI catalog", () => {
  expect(parseArgs(["generate"]).pricingSource).toBe("openai");
  expect(parseArgs(["generate", "--pricing-source", "openai"]).pricingSource).toBe("openai");
});

test("--estimate-model is an explicit override instead of a timeless default", () => {
  expect(parseArgs(["generate"]).estimateModel).toBeUndefined();
  expect(parseArgs(["generate", "--estimate-model", "gpt-5.4"]).estimateModel).toBe("gpt-5.4");
});
