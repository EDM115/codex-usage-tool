import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../src/cli";
import {
  createModelCatalog,
  pricingAt,
  primaryModelAt,
  resolveModelAt,
} from "../src/model-catalog";
import { estimateBreakdownCost, estimateCacheSavingsUsd, loadPricing } from "../src/pricing";
import { OPENAI_PRICING_MARKDOWN_CACHE } from "../src/openai-pricing-cache";
import type { PricingTier, TokenBreakdown } from "../src/types";

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

test("model defaults, aliases and bundled prices change only on their effective dates", async () => {
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
  expect(resolveModelAt(pricing.catalog, "daybreak-blue-latest", "2026-08-21")).toBe("gpt-5.6-sol");
  expect(pricing.table.get("gpt-daybreak-red-latest")?.aliasFor).toBe("gpt-5.6-cyber");
  expect(pricing.table.get("gpt-daybreak-blue-latest")?.aliasFor).toBe("gpt-5.6-sol");
  expect(pricing.table.get("daybreak-red-latest")?.aliasFor).toBe("gpt-daybreak-red-latest");
  expect(pricing.table.get("daybreak-blue-latest")?.aliasFor).toBe("gpt-daybreak-blue-latest");
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
    estimate(pricing, "gpt-6-astra", undefined, longRequest, 1_050_000, "2026-09-04"),
  ).toBeCloseTo(13.5);
});

test("indented pricing tables retain official rates and distinguish specialized Fast mode", async () => {
  const pricing = await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-09-16");

  expect(pricing.warning).toBeUndefined();
  expect(pricingAt(pricing.catalog, "gpt-6-sol", "2026-09-16")).toBeUndefined();
  expect(pricingAt(pricing.catalog, "gpt-6-luna", "2026-09-16")).toBeUndefined();
  expect(pricing.table.get("gpt-6-astra")?.inputPerMillion).toBe(10);
  expect(pricing.table.get("gpt-5.3-codex")?.aliasFor).toBeUndefined();
  expect(estimate(pricing, "gpt-5.3-codex", "standard")).toBeCloseTo(15.75);
  expect(estimate(pricing, "gpt-5.3-codex", "fast")).toBeCloseTo(31.5);
  expect(pricing.table.has("gpt-live-1")).toBe(false);
  expect(pricing.table.has("gpt-4.1-2025-04-14")).toBe(false);
  expect(resolveModelAt(pricing.catalog, "chat-latest", "2026-09-15")).toBe("gpt-5.6-sol");
  expect(pricingAt(pricing.catalog, "chat-latest", "2026-09-16")?.inputPerMillion).toBe(5);
  expect(pricingAt(pricing.catalog, "gpt-5-search-api", "2026-09-15")).toBeUndefined();
  expect(pricingAt(pricing.catalog, "gpt-5-search-api", "2026-09-16")?.inputPerMillion).toBe(1.25);
});

test("September image models have their own dated rates without changing the primary model", async () => {
  const pricing = await loadPricing({ source: "bundled" });

  for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]) {
    expect(pricingAt(pricing.catalog, model, "2026-09-07")).toBeUndefined();
    expect(pricingAt(pricing.catalog, model, "2026-09-08")).toMatchObject({
      inputPerMillion: 5,
      cachedInputPerMillion: 1.25,
      outputPerMillion: 30,
    });
    expect(pricing.table.get(model)?.aliasFor).toBeUndefined();
    expect(pricing.table.get(model)?.tiers?.priority).toBeUndefined();
    expect(estimate(pricing, model)).toBeCloseTo(35);
  }
  expect(primaryModelAt(pricing.catalog, "2026-09-16")).toBe("gpt-6-astra");
  expect(resolveModelAt(pricing.catalog, "chat-latest", "2026-09-16")).toBe("gpt-5.6-sol");
  expect(estimate(pricing, "gpt-image-2", "batch")).toBeCloseTo(17.5);
});

test("GPT-6 Sol and Luna begin on their release date with distinct tier and context rates", async () => {
  const pricing = await loadPricing({ source: "bundled" });

  for (const [model, input, output, longInput, longOutput] of [
    ["gpt-6-sol", 2, 10, 4, 15],
    ["gpt-6-luna", 0.1, 0.5, 0.2, 0.75],
  ] as const) {
    expect(pricingAt(pricing.catalog, model, "2026-09-21")).toBeUndefined();
    const released = pricingAt(pricing.catalog, model, "2026-09-22");
    expect(released?.effectiveFrom).toBe("2026-09-22");
    expect(released?.inputPerMillion).toBe(input);
    expect(released?.outputPerMillion).toBe(output);
    expect(released?.cachedInputPerMillion).toBe(input / 10);
    expect(released?.cacheWritePerMillion).toBe(input * 1.25);
    expect(released?.tiers?.standard?.long).toMatchObject({
      inputPerMillion: longInput,
      outputPerMillion: longOutput,
    });
    expect(released?.tiers?.batch?.short).toMatchObject({
      inputPerMillion: input / 2,
      outputPerMillion: output / 2,
    });
    expect(released?.tiers?.flex?.short).toMatchObject({
      inputPerMillion: input / 2,
      outputPerMillion: output / 2,
    });
    expect(released?.tiers?.priority?.long).toMatchObject({
      inputPerMillion: longInput * 2,
      outputPerMillion: longOutput * 2,
    });
    expect(pricing.table.get(model)?.aliasFor).toBeUndefined();
    const longRequest: TokenBreakdown = {
      totalTokens: 400_000,
      inputTokens: 300_000,
      cachedInputTokens: 0,
      outputTokens: 100_000,
      reasoningOutputTokens: 0,
    };
    expect(estimate(pricing, model, "standard", longRequest, 1_050_000, "2026-09-22")).toBeCloseTo(
      longInput * 0.3 + longOutput * 0.1,
    );
    expect(estimate(pricing, model, "standard", longRequest, 128_000, "2026-09-22")).toBeCloseTo(
      input * 0.3 + output * 0.1,
    );
  }

  expect(primaryModelAt(pricing.catalog, "2026-09-23")).toBe("gpt-6-astra");
  expect(pricingAt(pricing.catalog, "gpt-5-search-api", "2026-09-16")?.inputPerMillion).toBe(1.25);
});

test("GPT-6.1 Sol starts September 29 with its own cached-input rates and preserved Sol history", async () => {
  const sources = [
    await loadPricing({ source: "bundled" }),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-09-28"),
  ];

  for (const pricing of sources) {
    expect(pricingAt(pricing.catalog, "gpt-6.1-sol", "2026-09-28")).toBeUndefined();
    const released = pricingAt(pricing.catalog, "gpt-6.1-sol", "2026-09-29");
    expect(released?.effectiveFrom).toBe("2026-09-29");
    expect(released).toMatchObject({
      inputPerMillion: 2,
      cachedInputPerMillion: 0.1,
      cacheWritePerMillion: 2.5,
      outputPerMillion: 10,
    });
    expect(released?.tiers?.standard?.long).toEqual({
      inputPerMillion: 4,
      cachedInputPerMillion: 0.2,
      cacheWritePerMillion: 5,
      outputPerMillion: 15,
    });
    expect(released?.tiers?.batch?.short).toEqual({
      inputPerMillion: 1,
      cachedInputPerMillion: 0.05,
      cacheWritePerMillion: 1.25,
      outputPerMillion: 5,
    });
    expect(released?.tiers?.flex?.long).toEqual({
      inputPerMillion: 2,
      cachedInputPerMillion: 0.1,
      cacheWritePerMillion: 2.5,
      outputPerMillion: 7.5,
    });
    expect(released?.tiers?.priority?.long).toEqual({
      inputPerMillion: 8,
      cachedInputPerMillion: 0.4,
      cacheWritePerMillion: 10,
      outputPerMillion: 30,
    });
    expect(pricing.table.get("gpt-6.1-sol")?.aliasFor).toBeUndefined();
    expect(pricing.catalog.aliases.some((row) => row.alias === "gpt-6.1")).toBe(false);
    expect(primaryModelAt(pricing.catalog, "2026-09-29")).toBe("gpt-6-astra");
    expect(pricingAt(pricing.catalog, "gpt-6-sol", "2026-09-22")?.cachedInputPerMillion).toBe(0.2);
    const request = {
      ...ONE_MILLION_INPUT_AND_OUTPUT,
      totalTokens: 400_000,
      inputTokens: 300_000,
      cachedInputTokens: 100_000,
      outputTokens: 100_000,
    };
    expect(
      estimate(pricing, "gpt-6.1-sol", "standard", request, 1_050_000, "2026-09-29"),
    ).toBeCloseTo(2.32);
    expect(estimate(pricing, "gpt-6.1-sol", "fast", request, 1_050_000, "2026-09-29")).toBeCloseTo(
      4.64,
    );
    expect(
      estimateCacheSavingsUsd(request, "gpt-6.1-sol", pricing.catalog, undefined, {
        date: "2026-09-29",
        modelContextWindow: 1_050_000,
      }),
    ).toBeCloseTo(0.38);
  }
});

test("Astra Ultrafast and image Batch start September 29 across bundled, live and offline catalogs", async () => {
  const offline = (async (_input: string | URL | Request): Promise<Response> => {
    throw new Error("offline");
  }) as typeof fetch;
  const sources = [
    await loadPricing({ source: "bundled" }),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-09-16"),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-01"),
    await loadPricing({ source: "openai", fetcher: offline, effectiveDate: "2026-09-16" }),
  ];

  for (const pricing of sources) {
    const tiersBefore = pricingAt(pricing.catalog, "gpt-6-astra", "2026-09-28")?.tiers;
    expect(tiersBefore).not.toHaveProperty("ultrafast");
    expect(tiersBefore?.priority?.short.inputPerMillion).toBe(20);
    const released = pricingAt(pricing.catalog, "gpt-6-astra", "2026-09-29");
    expect(released?.effectiveFrom).toBe("2026-09-29");
    expect(released?.tiers).toHaveProperty("ultrafast", {
      short: {
        inputPerMillion: 60,
        cachedInputPerMillion: 6,
        cacheWritePerMillion: 75,
        outputPerMillion: 300,
      },
      long: {
        inputPerMillion: 120,
        cachedInputPerMillion: 12,
        cacheWritePerMillion: 150,
        outputPerMillion: 450,
      },
    });
    expect(
      estimate(
        pricing,
        "gpt-6-astra",
        "ultrafast",
        ONE_MILLION_INPUT_AND_OUTPUT,
        undefined,
        "2026-09-29",
      ),
    ).toBeCloseTo(360);
    const request = {
      ...ONE_MILLION_INPUT_AND_OUTPUT,
      totalTokens: 400_000,
      inputTokens: 300_000,
      cachedInputTokens: 100_000,
      outputTokens: 100_000,
    };
    expect(
      estimate(pricing, "gpt-6-astra", "ultrafast", request, 1_050_000, "2026-09-29"),
    ).toBeCloseTo(70.2);
    expect(
      estimateCacheSavingsUsd(request, "gpt-6-astra", pricing.catalog, undefined, {
        date: "2026-09-29",
        serviceTier: "ultrafast",
        modelContextWindow: 1_050_000,
      }),
    ).toBeCloseTo(10.8);
    for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]) {
      expect(pricingAt(pricing.catalog, model, "2026-09-28")?.tiers?.batch).toBeUndefined();
      expect(pricingAt(pricing.catalog, model, "2026-09-29")?.effectiveFrom).toBe("2026-09-29");
      expect(pricingAt(pricing.catalog, model, "2026-09-29")?.tiers?.batch?.short).toEqual({
        inputPerMillion: 2.5,
        cachedInputPerMillion: 0.625,
        cacheWritePerMillion: undefined,
        outputPerMillion: 15,
      });
      expect(
        estimate(pricing, model, "batch", ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-09-29"),
      ).toBeCloseTo(17.5);
    }
    expect(pricingAt(pricing.catalog, "gpt-6.1-sol", "2026-10-07")?.tiers?.ultrafast).toBeUndefined();
    for (const model of ["gpt-6-sol", "gpt-6-luna", "gpt-image-2.5-sunburst"])
      expect(pricing.table.get(model)?.tiers).not.toHaveProperty("ultrafast");
    expect(pricing.table.has("sora-2")).toBe(false);
    expect(pricing.table.has("sora-2-pro")).toBe(false);
  }
});

test("GPT-6.1 Sol Ultrafast starts October 8 without repricing earlier tier history", async () => {
  const offline = (async (_input: string | URL | Request): Promise<Response> => { throw new Error("offline"); }) as typeof fetch;
  const sources = [
    await loadPricing({ source: "bundled" }),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-07"),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-09"),
    await loadPricing({ source: "openai", fetcher: offline, effectiveDate: "2026-10-07" }),
  ];

  for (const pricing of sources) {
    expect(pricingAt(pricing.catalog, "gpt-6.1-sol", "2026-09-28")).toBeUndefined();
    for (const date of ["2026-09-29", "2026-10-07"]) {
      const before = pricingAt(pricing.catalog, "gpt-6.1-sol", date);
      expect(before?.effectiveFrom).toBe("2026-09-29");
      expect(before?.tiers?.ultrafast).toBeUndefined();
      expect(before?.tiers?.standard?.short.cachedInputPerMillion).toBe(0.1);
      expect(estimate(pricing, "gpt-6.1-sol", "standard", ONE_MILLION_INPUT_AND_OUTPUT, undefined, date)).toBeCloseTo(12);
      expect(estimate(pricing, "gpt-6.1-sol", "fast", ONE_MILLION_INPUT_AND_OUTPUT, undefined, date)).toBeCloseTo(24);
    }
    const released = pricingAt(pricing.catalog, "gpt-6.1-sol", "2026-10-08");
    expect(released?.effectiveFrom).toBe("2026-10-08");
    expect(released?.tiers?.ultrafast).toEqual({
      short: { inputPerMillion: 12, cachedInputPerMillion: 0.6, cacheWritePerMillion: 15, outputPerMillion: 60 },
      long: { inputPerMillion: 24, cachedInputPerMillion: 1.2, cacheWritePerMillion: 30, outputPerMillion: 90 },
    });
    expect(estimate(pricing, "gpt-6.1-sol", "ultrafast", ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-10-08")).toBeCloseTo(72);
    const request = { ...ONE_MILLION_INPUT_AND_OUTPUT, totalTokens: 400_000, inputTokens: 300_000, cachedInputTokens: 100_000, outputTokens: 100_000 };
    expect(estimate(pricing, "gpt-6.1-sol", "ultrafast", request, undefined, "2026-10-08")).toBeCloseTo(8.46);
    expect(estimate(pricing, "gpt-6.1-sol", "ultrafast", request, 1_050_000, "2026-10-08")).toBeCloseTo(13.92);
    expect(estimateCacheSavingsUsd(request, "gpt-6.1-sol", pricing.catalog, undefined, { date: "2026-10-08", serviceTier: "ultrafast", modelContextWindow: 1_050_000 })).toBeCloseTo(2.28);
    expect(pricingAt(pricing.catalog, "gpt-6-astra", "2026-09-29")?.tiers?.ultrafast?.short.inputPerMillion).toBe(60);
  }
});

test("GPT-6.1 Sol Ultrafast starts October 8 without repricing earlier tier history", async () => {
  const offline = (async (_input: string | URL | Request): Promise<Response> => { throw new Error("offline"); }) as typeof fetch;
  const sources = [
    await loadPricing({ source: "bundled" }),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-07"),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-09"),
    await loadPricing({ source: "openai", fetcher: offline, effectiveDate: "2026-10-07" }),
  ];

  for (const pricing of sources) {
    expect(pricingAt(pricing.catalog, "gpt-6.1-sol", "2026-09-28")).toBeUndefined();
    for (const date of ["2026-09-29", "2026-10-07"]) {
      const before = pricingAt(pricing.catalog, "gpt-6.1-sol", date);
      expect(before?.effectiveFrom).toBe("2026-09-29");
      expect(before?.tiers?.ultrafast).toBeUndefined();
      expect(before?.tiers?.standard?.short.cachedInputPerMillion).toBe(0.1);
      expect(estimate(pricing, "gpt-6.1-sol", "standard", ONE_MILLION_INPUT_AND_OUTPUT, undefined, date)).toBeCloseTo(12);
      expect(estimate(pricing, "gpt-6.1-sol", "fast", ONE_MILLION_INPUT_AND_OUTPUT, undefined, date)).toBeCloseTo(24);
    }
    const released = pricingAt(pricing.catalog, "gpt-6.1-sol", "2026-10-08");
    expect(released?.effectiveFrom).toBe("2026-10-08");
    expect(released?.tiers?.ultrafast).toEqual({
      short: { inputPerMillion: 12, cachedInputPerMillion: 0.6, cacheWritePerMillion: 15, outputPerMillion: 60 },
      long: { inputPerMillion: 24, cachedInputPerMillion: 1.2, cacheWritePerMillion: 30, outputPerMillion: 90 },
    });
    expect(estimate(pricing, "gpt-6.1-sol", "ultrafast", ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-10-08")).toBeCloseTo(72);
    const request = { ...ONE_MILLION_INPUT_AND_OUTPUT, totalTokens: 400_000, inputTokens: 300_000, cachedInputTokens: 100_000, outputTokens: 100_000 };
    expect(estimate(pricing, "gpt-6.1-sol", "ultrafast", request, undefined, "2026-10-08")).toBeCloseTo(8.46);
    expect(estimate(pricing, "gpt-6.1-sol", "ultrafast", request, 1_050_000, "2026-10-08")).toBeCloseTo(13.92);
    expect(estimateCacheSavingsUsd(request, "gpt-6.1-sol", pricing.catalog, undefined, { date: "2026-10-08", serviceTier: "ultrafast", modelContextWindow: 1_050_000 })).toBeCloseTo(2.28);
    expect(pricingAt(pricing.catalog, "gpt-6-astra", "2026-09-29")?.tiers?.ultrafast?.short.inputPerMillion).toBe(60);
  }
});

test("Fast, Fast mode and Ultrafast tables stay separate in both supported Markdown formats", async () => {
  const rates = [2, 0.1, 2.5, 10];
  const row = (factor: number) =>
    `| gpt-tier-probe | ${rates.map((value) => `$${value * factor}`).join(" | ")} |`;
  const header =
    "| Model | Input | Cached input | Cache writes | Output |\n| --- | --- | --- | --- | --- |";
  const video =
    "Video generation models\nStandard\n### Grouped Pricing Table data\n| Model | Price per second |\n| --- | --- |\n| sora-2 | $0.10 |";
  for (const fastLabel of ["Fast", "Fast mode"]) {
    for (const generic of [false, true]) {
      const table = (label: string, factor: number) =>
        `${label}\n### ${generic ? "Grouped Pricing Table data" : `${label} pricing data`}\n${header}\n${row(factor)}`;
      const pricing = await loadFixture(
        [table("Standard", 1), table(fastLabel, 2), table("Ultrafast", 6), video].join("\n\n"),
        "2026-09-29",
      );
      expect(estimate(pricing, "gpt-tier-probe", "standard")).toBeCloseTo(12);
      expect(estimate(pricing, "gpt-tier-probe", "priority")).toBeCloseTo(24);
      expect(estimate(pricing, "gpt-tier-probe", "fast")).toBeCloseTo(24);
      expect(estimate(pricing, "gpt-tier-probe", "ultrafast")).toBeCloseTo(72);
      expect(pricing.table.has("sora-2")).toBe(false);
    }
  }
  const components = ["standard", "fast", "ultrafast"]
    .map(
      (tier, index) =>
        `<TextTokenPricingTables tier="${tier}" rows={[ ["gpt-component-probe", ${rates.map((value) => value * [1, 2, 6][index]).join(", ")}] ]} />`,
    )
    .join("\n");
  const pricing = await loadFixture(components, "2026-09-29");
  expect(estimate(pricing, "gpt-component-probe", "ultrafast")).toBeCloseTo(72);
});

test("Rosalind stays free until its billing date with bundled, live and offline pricing", async () => {
  const offline = (async (_input: string | URL | Request): Promise<Response> => {
    throw new Error("offline");
  }) as typeof fetch;
  const sources = [
    await loadPricing({ source: "bundled" }),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-09-16"),
    await loadPricing({ source: "openai", fetcher: offline, effectiveDate: "2026-09-16" }),
  ];

  for (const pricing of sources) {
    expect(pricingAt(pricing.catalog, "gpt-rosalind-research", "2026-09-07")).toBeUndefined();
    for (const date of ["2026-09-08", "2026-09-16", "2026-10-04"]) {
      expect(
        estimate(
          pricing,
          "gpt-rosalind-research",
          undefined,
          ONE_MILLION_INPUT_AND_OUTPUT,
          undefined,
          date,
        ),
      ).toBe(0);
    }
    expect(
      estimate(
        pricing,
        "gpt-rosalind-research",
        undefined,
        ONE_MILLION_INPUT_AND_OUTPUT,
        undefined,
        "2026-10-05",
      ),
    ).toBeCloseTo(30);
    expect(
      pricingAt(pricing.catalog, "gpt-rosalind-research", "2026-10-05")?.cacheWritePerMillion,
    ).toBeUndefined();
  }
});

test("the refreshed snapshot preserves earlier Rosalind models with only published Standard rates", async () => {
  const offline = (async (_input: string | URL | Request): Promise<Response> => {
    throw new Error("offline");
  }) as typeof fetch;
  const sources = [
    await loadPricing({ source: "bundled" }),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-17"),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-16"),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-09"),
    await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-10"),
    await loadPricing({ source: "openai", fetcher: offline, effectiveDate: "2026-10-17" }),
  ];

  for (const pricing of sources) {
    for (const model of ["gpt-rosalind-research", "gpt-rosalind-discovery"]) {
      const row = pricingAt(pricing.catalog, model, "2026-10-17");
      expect(row?.model).toBe(model);
      expect(row?.inputPerMillion).toBe(5);
      expect(row?.cachedInputPerMillion).toBe(0.5);
      expect(row?.outputPerMillion).toBe(25);
      expect(row?.cacheWritePerMillion).toBeUndefined();
      expect(Object.keys(row?.tiers ?? {})).toEqual(["standard"]);
      expect(row?.tiers?.standard?.long).toBeUndefined();
      expect(pricing.table.get(model)?.aliasFor).toBeUndefined();
      expect(pricing.catalog.models.find((entry) => entry.model === model)?.canBePrimary).toBe(false);
      expect(estimate(pricing, model, undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-10-17")).toBeCloseTo(30);
    }
    expect(pricingAt(pricing.catalog, "gpt-rosalind-discovery", "2026-10-09")).toBeUndefined();
    for (const date of ["2026-10-10", "2026-10-16", "2026-10-17"]) {
      expect(pricingAt(pricing.catalog, "gpt-rosalind-discovery", date)?.effectiveFrom).toBe("2026-10-10");
      expect(estimate(pricing, "gpt-rosalind-discovery", undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, date)).toBeCloseTo(30);
    }
    expect(primaryModelAt(pricing.catalog, "2026-10-17")).toBe("gpt-6-astra");
  }
  expect(sources[0].table.get("gpt-rosalind-discovery")?.source).toContain("2026-11-05");
});

test("Life sciences grouped tables reset a preceding Fast or Ultrafast tier", async () => {
  const header = "| Model | Input | Cached input | Output |\n| --- | --- | --- | --- |";
  for (const tier of ["Fast", "Ultrafast"]) {
    const markdown = `${tier}\n### Grouped Pricing Table data\n${header}\n| gpt-tier-probe | $10 | $1 | $50 |\n\nLife sciences models\n### Grouped Pricing Table data\n${header}\n| gpt-life-sciences-probe | $5 | $0.50 | $25 |`;
    const pricing = await loadFixture(markdown, "2026-10-17");
    expect(pricing.table.get("gpt-life-sciences-probe")?.inputPerMillion).toBe(5);
    expect(Object.keys(pricing.table.get("gpt-life-sciences-probe")?.tiers ?? {})).toEqual(["standard"]);
  }
});

test("Daybreak alias retirement preserves recorded usage mappings and underlying model prices", async () => {
  const pricing = await loadPricing({ source: "bundled" });
  for (const date of ["2026-10-27", "2026-10-28", "2026-10-29"]) {
    for (const [alias, model] of [
      ["gpt-daybreak-blue-latest", "gpt-5.6-sol"],
      ["gpt-daybreak-red-latest", "gpt-5.6-cyber"],
      ["daybreak-blue-latest", "gpt-5.6-sol"],
      ["daybreak-red-latest", "gpt-5.6-cyber"],
    ]) {
      expect(resolveModelAt(pricing.catalog, alias, date)).toBe(model);
      expect(pricingAt(pricing.catalog, alias, date)).toEqual(pricingAt(pricing.catalog, model, date));
      expect(estimate(pricing, alias, undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, date)).toBeCloseTo(estimate(pricing, model, undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, date));
    }
  }
});

test("custom pricing preserves Rosalind's billing schedule unless it explicitly overrides Rosalind", async () => {
  const root = join(tmpdir(), `codex-pricing-billing-${crypto.randomUUID()}`);
  const path = join(root, "pricing.json");
  mkdirSync(root, { recursive: true });

  for (const model of ["gpt-5.6-sol", "gpt-rosalind-research"]) {
    writeFileSync(path, JSON.stringify([{ model, inputPerMillion: 1, outputPerMillion: 2 }]));
    const pricing = await loadPricing({
      source: "bundled",
      pricingJson: path,
      effectiveDate: "2026-09-16",
    });
    expect(
      estimate(
        pricing,
        "gpt-rosalind-research",
        undefined,
        ONE_MILLION_INPUT_AND_OUTPUT,
        undefined,
        "2026-09-16",
      ),
    ).toBe(model === "gpt-rosalind-research" ? 3 : 0);
  }
});

test("CLI pricing defaults to the authoritative OpenAI catalog", () => {
  expect(parseArgs(["generate"]).pricingSource).toBe("openai");
  expect(parseArgs(["generate", "--pricing-source", "openai"]).pricingSource).toBe("openai");
});

test("--estimate-model is an explicit override instead of a timeless default", () => {
  expect(parseArgs(["generate"]).estimateModel).toBeUndefined();
  expect(parseArgs(["generate", "--estimate-model", "gpt-5.4"]).estimateModel).toBe("gpt-5.4");
});

test("split pricing tables retain official legacy rows and nested Batch and Flex tiers", async () => {
  const pricing = await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-11-01");
  for (const [model, input, cached, output] of [
    ["gpt-5.1", 1.25, 0.125, 10],
    ["gpt-5.4-mini", 0.75, 0.075, 4.5],
    ["o3", 2, 0.5, 8],
  ] as const) {
    expect(pricing.table.get(model)?.source).toBe("developers.openai.com/api/docs/pricing.md");
    expect(pricing.table.get(model)?.tiers?.standard?.short).toMatchObject({ inputPerMillion: input, cachedInputPerMillion: cached, outputPerMillion: output });
  }
  expect(pricing.table.get("gpt-5.4-mini")?.tiers?.batch?.short.outputPerMillion).toBe(2.25);
  expect(pricing.table.get("gpt-5.4-mini")?.tiers?.flex?.short.outputPerMillion).toBe(2.25);
  expect(pricing.table.get("gpt-5.4-mini")?.tiers?.priority?.short.outputPerMillion).toBe(9);
  expect(pricing.table.get("o3")?.tiers?.batch?.short.cachedInputPerMillion).toBeUndefined();
  expect(pricing.table.get("o3")?.tiers?.flex?.short.cachedInputPerMillion).toBe(0.25);
  expect(pricing.table.get("gpt-5.2-pro")?.tiers).not.toHaveProperty("flex");
  expect(pricing.table.get("gpt-6.1-sol")?.tiers?.flex?.long?.outputPerMillion).toBe(7.5);
  expect(pricing.table.get("gpt-6-astra-law")?.tiers?.standard?.short).toMatchObject({ inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 50 });
  expect(Object.keys(pricing.table.get("gpt-6-astra-law")?.tiers ?? {})).toEqual(["standard"]);
  expect(pricing.table.get("gpt-6-astra-law")?.tiers?.standard?.long).toBeUndefined();
  for (const model of ["gpt-live-1", "sora-2", "gpt-4.1-2025-04-14", "o4-mini-2025-04-16"]) expect(pricing.table.has(model)).toBe(false);
});

test("Terra, Rosalind and Astra Law pricing starts on each release across bundled, live and offline sources", async () => {
  const offline = (async (_input: string | URL | Request): Promise<Response> => { throw new Error("offline"); }) as typeof fetch;
  const sources = [await loadPricing({ source: "bundled" }), await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-09-16"), await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-11-01"), await loadPricing({ source: "openai", fetcher: offline })];
  for (const pricing of sources) {
    for (const [model, before, released, cost] of [
      ["gpt-6.1-terra", "2026-10-25", "2026-10-26", 6],
      ["gpt-6-rosalind", "2026-10-29", "2026-10-30", 90],
      ["gpt-6-astra-law", "2026-09-16", "2026-09-17", 60],
    ] as const) {
      expect(pricingAt(pricing.catalog, model, before)).toBeUndefined();
      expect(pricingAt(pricing.catalog, model, released)?.effectiveFrom).toBe(released);
      expect(estimate(pricing, model, undefined, ONE_MILLION_INPUT_AND_OUTPUT, undefined, released)).toBe(cost);
      expect(pricing.table.get(model)?.aliasFor).toBeUndefined();
      expect(pricing.catalog.models.find((entry) => entry.model === model)?.canBePrimary).toBe(false);
      expect(primaryModelAt(pricing.catalog, released)).toBe("gpt-6-astra");
    }
    expect(Object.keys(pricing.table.get("gpt-6.1-terra")?.tiers ?? {}).sort()).toEqual(["batch", "flex", "priority", "standard"]);
    const request = { ...ONE_MILLION_INPUT_AND_OUTPUT, totalTokens: 400_000, inputTokens: 300_000, cachedInputTokens: 100_000, outputTokens: 100_000 };
    expect(estimate(pricing, "gpt-6.1-terra", "standard", request, 1_050_000)).toBeCloseTo(1.16);
    expect(estimate(pricing, "gpt-6.1-terra", "batch", request, 1_050_000)).toBeCloseTo(0.58);
    expect(estimate(pricing, "gpt-6.1-terra", "fast", request, 1_050_000)).toBeCloseTo(2.32);
    expect(estimate(pricing, "gpt-6-rosalind", "standard", request, 1_050_000)).toBeCloseTo(17.55);
    expect(Object.keys(pricing.table.get("gpt-6-rosalind")?.tiers ?? {})).toEqual(["standard"]);
  }
});

test("30-minute write prices remain compatible and 12-hour write prices start October 20", async () => {
  const sources = [await loadPricing({ source: "bundled" }), await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-19"), await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-10-20")];
  for (const pricing of sources) {
    for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-cyber"]) {
      const before = pricingAt(pricing.catalog, model, "2026-10-19");
      const after = pricingAt(pricing.catalog, model, "2026-10-20");
      expect(before?.cacheWritePerMillion).toBeGreaterThan(0);
      expect(before?.cacheWrite12hPerMillion).toBeUndefined();
      expect(after?.effectiveFrom).toBe("2026-10-20");
      expect(after?.cacheWrite12hPerMillion).toBe((after?.cacheWritePerMillion ?? 0) * 2);
      for (const context of Object.values(before?.tiers ?? {})) {
        expect(context?.short.cacheWrite12hPerMillion).toBeUndefined();
        expect(context?.long?.cacheWrite12hPerMillion).toBeUndefined();
      }
    }
    const sol = pricingAt(pricing.catalog, "gpt-6.1-sol", "2026-10-20");
    expect(sol?.tiers?.standard?.short.cacheWritePerMillion).toBe(2.5);
    expect(sol?.tiers?.standard?.long?.cacheWrite12hPerMillion).toBe(10);
    expect(sol?.tiers?.flex?.short.cacheWrite12hPerMillion).toBe(2.5);
    expect(sol?.tiers?.ultrafast?.long?.cacheWrite12hPerMillion).toBe(60);
    for (const model of ["gpt-rosalind-research", "gpt-rosalind-discovery", "gpt-6-astra-law"]) expect(pricingAt(pricing.catalog, model, "2026-11-01")?.cacheWrite12hPerMillion).toBeUndefined();
    expect(pricingAt(pricing.catalog, "gpt-6.1-terra", "2026-10-26")?.cacheWrite12hPerMillion).toBe(2.5);
    expect(pricingAt(pricing.catalog, "gpt-6-rosalind", "2026-10-30")?.tiers?.standard?.long?.cacheWrite12hPerMillion).toBe(75);
  }
});

test("removed official rows retain recorded prices and published tiers for historical reports", async () => {
  for (const pricing of [await loadPricing({ source: "bundled" }), await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-11-01")]) {
    for (const [model, standard, batch, batchInput] of [["gpt-3.5-turbo-1106", 3, 3, 1], ["gpt-3.5-turbo-instruct", 3.5, undefined, undefined], ["davinci-002", 4, 2, 1], ["babbage-002", 0.8, 0.4, 0.2], ["gpt-image-1", 45, 22.5, 2.5]] as const) {
      expect(estimate(pricing, model, "standard", ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-10-17")).toBe(standard);
      expect(pricingAt(pricing.catalog, model, "2026-10-17")?.tiers?.batch?.short.inputPerMillion).toBe(batchInput);
      if (batch !== undefined) expect(estimate(pricing, model, "batch", ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-10-17")).toBe(batch);
      expect(pricing.table.get(model)?.tiers).not.toHaveProperty("priority");
      expect(pricing.table.get(model)?.source).toContain("2026-10-17");
    }
  }
});

test("November image models start November 4 with only their published Standard estimate", async () => {
  const offline = (async (_input: string | URL | Request): Promise<Response> => { throw new Error("offline"); }) as typeof fetch;
  const sources = [await loadPricing({ source: "bundled" }), await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-11-03"), await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-11-04"), await loadPricing({ source: "openai", fetcher: offline })];
  for (const pricing of sources) {
    for (const model of ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]) {
      expect(pricingAt(pricing.catalog, model, "2026-11-03")).toBeUndefined();
      const released = pricingAt(pricing.catalog, model, "2026-11-04");
      expect(released?.effectiveFrom).toBe("2026-11-04");
      expect(released).toMatchObject({ inputPerMillion: 5, cachedInputPerMillion: 1.25, outputPerMillion: 30 });
      expect(Object.keys(released?.tiers ?? {})).toEqual(["standard"]);
      expect(released?.tiers?.standard?.long).toBeUndefined();
      expect(released?.cacheWritePerMillion).toBeUndefined();
      expect(released?.cacheWrite12hPerMillion).toBeUndefined();
      expect(pricing.table.get(model)?.aliasFor).toBeUndefined();
      expect(pricing.catalog.models.find((entry) => entry.model === model)?.canBePrimary).toBe(false);
      expect(estimate(pricing, model, "standard", ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-11-04")).toBe(35);
      expect(estimate(pricing, model, "standard", { ...ONE_MILLION_INPUT_AND_OUTPUT, cachedInputTokens: 1_000_000 }, undefined, "2026-11-04")).toBe(31.25);
    }
    expect(primaryModelAt(pricing.catalog, "2026-11-04")).toBe("gpt-6-astra");
  }
});

test("November removals preserve the last published rates and supported tiers across retirement", async () => {
  const retired: { model: string; tiers: Partial<Record<PricingTier, [number, number | undefined, number]>> }[] = [
    { model: "gpt-4.1-nano", tiers: { standard: [0.1, 0.025, 0.4], batch: [0.05, undefined, 0.2], priority: [0.2, 0.05, 0.8] } },
    { model: "gpt-4o-2024-05-13", tiers: { standard: [5, undefined, 15], batch: [2.5, undefined, 7.5], priority: [8.75, undefined, 26.25] } },
    { model: "o1", tiers: { standard: [15, 7.5, 60], batch: [7.5, undefined, 30] } },
    { model: "o1-pro", tiers: { standard: [150, undefined, 600], batch: [75, undefined, 300] } },
    { model: "o4-mini", tiers: { standard: [1.1, 0.275, 4.4], batch: [0.55, undefined, 2.2], flex: [0.55, 0.138, 2.2], priority: [2, 0.5, 8] } },
    { model: "o3-mini", tiers: { standard: [1.1, 0.55, 4.4], batch: [0.55, undefined, 2.2] } },
    { model: "gpt-4-turbo-2024-04-09", tiers: { standard: [10, undefined, 30], batch: [5, undefined, 15] } },
    { model: "gpt-4-0613", tiers: { standard: [30, undefined, 60], batch: [15, undefined, 30] } },
    { model: "gpt-3.5-turbo", tiers: { standard: [0.5, undefined, 1.5] } },
    { model: "gpt-3.5-turbo-0125", tiers: { standard: [0.5, undefined, 1.5], batch: [0.25, undefined, 0.75] } },
  ];
  const offline = (async (_input: string | URL | Request): Promise<Response> => { throw new Error("offline"); }) as typeof fetch;
  for (const pricing of [await loadPricing({ source: "bundled" }), await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE, "2026-11-05"), await loadPricing({ source: "openai", fetcher: offline })]) {
    for (const { model, tiers } of retired) {
      for (const date of ["2026-11-03", "2026-11-04", "2026-11-05"]) {
        const period = pricingAt(pricing.catalog, model, date);
        expect(Object.keys(period?.tiers ?? {}).sort()).toEqual(Object.keys(tiers).sort());
        for (const [tier, rates] of Object.entries(tiers)) {
          const [input, cached, output] = rates;
          const actual = period?.tiers?.[tier as PricingTier]?.short;
          expect(actual).toMatchObject({ inputPerMillion: input, cachedInputPerMillion: cached, outputPerMillion: output });
          expect(estimate(pricing, model, tier, ONE_MILLION_INPUT_AND_OUTPUT, undefined, date)).toBeCloseTo(input + output);
        }
      }
      expect(pricing.table.get(model)?.source).toBe("historical OpenAI pricing cache 2026-11-01");
    }
  }
});

test("both fine-tuning category spellings exclude training rows from token pricing", async () => {
  for (const category of ["Finetuning", "Fine-tuning"]) {
    const pricing = await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE.replace("Fine-tuning", category), "2026-11-05");
    for (const model of ["gpt-4.1-2025-04-14", "gpt-4.1-mini-2025-04-14", "gpt-4o-mini-2024-07-18"]) expect(pricing.table.has(model)).toBe(false);
    expect(pricing.table.get("gpt-4o-2024-08-06")).toMatchObject({ inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10 });
    expect(pricing.table.get("gpt-4.1")?.outputPerMillion).toBe(8);
  }
});

test("an official row that reappears overrides the retired snapshot", async () => {
  const pricing = await loadFixture("### Standard pricing data\n| Model | Input | Output | Cached input |\n| --- | --- | --- | --- |\n| gpt-4.1-nano | $0.30 | $0.90 | $0.075 |", "2026-11-05");
  expect(pricing.table.get("gpt-4.1-nano")?.source).toBe("developers.openai.com/api/docs/pricing.md");
  expect(estimate(pricing, "gpt-4.1-nano", "standard", ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-11-04")).toBeCloseTo(0.5);
  expect(estimate(pricing, "gpt-4.1-nano", "standard", ONE_MILLION_INPUT_AND_OUTPUT, undefined, "2026-11-05")).toBeCloseTo(1.2);
});

test("legal grouped tables reset the preceding Fast tier", async () => {
  const markdown = `Fast\n### Grouped Pricing Table data\n| Model | Input | Output | Cached input |\n| --- | --- | --- | --- |\n| gpt-probe | $8 | $40 | $0.8 |\n\nLegal model configurations\n### Grouped Pricing Table data\n| Model configuration | Input | Output | Cached input |\n| --- | --- | --- | --- |\n| gpt-law-probe | $10 | $50 | $1 |`;
  const pricing = await loadFixture(markdown, "2026-11-01");
  expect(Object.keys(pricing.table.get("gpt-law-probe")?.tiers ?? {})).toEqual(["standard"]);
  expect(pricing.table.get("gpt-law-probe")?.outputPerMillion).toBe(50);
});

test("custom 12-hour write rates override published history and are validated", async () => {
  const directory = join(tmpdir(), `codex-write-pricing-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "pricing.json");
  const custom = { model: "gpt-6.1-sol", inputPerMillion: 2, cachedInputPerMillion: 0.1, cacheWritePerMillion: 2.5, cacheWrite12hPerMillion: 7, outputPerMillion: 10 };
  writeFileSync(path, JSON.stringify([custom]));
  const flat = await loadPricing({ source: "bundled", pricingJson: path, effectiveDate: "2026-10-18" });
  expect(pricingAt(flat.catalog, custom.model, "2026-10-18")?.cacheWrite12hPerMillion).toBe(7);
  writeFileSync(path, JSON.stringify([{ ...custom, effectiveFrom: "2026-10-18" }]));
  const dated = await loadPricing({ source: "bundled", pricingJson: path });
  expect(pricingAt(dated.catalog, custom.model, "2026-10-18")?.cacheWrite12hPerMillion).toBe(7);
  for (const invalid of [-1, NaN, Infinity]) {
    expect(() => createModelCatalog([{ ...custom, cacheWrite12hPerMillion: invalid, effectiveFrom: "2026-10-20", source: "test" }])).toThrow("Invalid pricing rate");
  }
  const changed = await loadFixture(OPENAI_PRICING_MARKDOWN_CACHE.replace("| $2.00 | $10.00 | $0.10 | $2.50 | $5.00 |", "| $2.00 | $10.00 | $0.10 | $2.50 | $7.00 |"), "2026-11-02");
  expect(pricingAt(changed.catalog, custom.model, "2026-11-01")?.cacheWrite12hPerMillion).toBe(5);
  expect(pricingAt(changed.catalog, custom.model, "2026-11-02")?.cacheWrite12hPerMillion).toBe(7);
});
