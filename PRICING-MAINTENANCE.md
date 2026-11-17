# Maintaining the pricing cache

Start with `git diff --cached -w -- src/openai-pricing-cache.ts` to see changes to prices and table contents, then check the regular diff for indentation and other parser-sensitive formatting. Review both staged and unstaged changes if the snapshot is split across them. Keep the Markdown as published and match the cache header date with `BUNDLED_PRICING_DATE` in [pricing.ts](./src/pricing.ts). Escape template-literal backticks and interpolation markers when copying into the cache

Use the [OpenAI pricing reference](https://developers.openai.com/api/docs/pricing) for rates and the [API changelog](https://developers.openai.com/api/docs/changelog), model pages or launch notes for release and billing dates. The snapshot date records when the page was captured. Use a documented effective date for a rate change, or the first observed date when the publisher gives no date. Preserve the source with the model or price period

## From a page change to a code change

| Situation | Action |
| --- | --- |
| A new model appears | Add the exact ID, release date and source in [model-catalog.ts](./src/model-catalog.ts). Use the first documented date when release is unclear. Change missing-model inference only when the Codex model catalog or other release evidence supports a new default. Add a color pair in [report-html.ts](./src/report-html.ts) for the new report model |
| A row disappears | Move its last published token rates into the historical fallback in [pricing.ts](./src/pricing.ts), including any actual Batch, Flex, Fast or Ultrafast tiers and context rates. Preserve its model definition and alias history. If the model reappears, its live rates take effect on the appropriate date |
| An exact ID or alias changes | Keep the prior ID usable for recorded usage. Append an effective-dated alias only when a source establishes the mapping. Check both the current-table alias logic in [pricing.ts](./src/pricing.ts) and dated resolution in [model-catalog.ts](./src/model-catalog.ts). Matching prices alone do not establish a mapping |
| A rate changes, a tier launches or a promotion has a documented end | Keep the complete older rates and add a period on the first date the new rates apply. For example, when Ultrafast switches from a launch rate to list price, carry Standard, Batch and Fast through both periods. A live refresh must respect known billing dates, and explicit `--pricing-json` input can supply a dated override |
| The page rearranges headings, columns or context labels | Update `pricingTableFromOpenAiMarkdown` and preserve support for earlier formats. Map columns by label and keep each tier within its section. A row labeled “long context” belongs to the same model and tier as its short-context row. Test both values, the threshold and explicit context-window evidence |
| The page lists a new API charge | Keep the source text in the snapshot. Tool call fees, container time, storage, training and session duration use separate billing units. Applying those charges requires corresponding billable usage in the logs and portable reports. Likewise, cache-write rates are metadata until usage includes write counts and retention, and endpoint uplifts or background discounts require evidence that a request qualifies |

## Verify the refresh

1. Test the actual snapshot as well as a small fixture for any parser behavior that changed. Check specific rows and tiers, release and billing boundaries, removed rows, published-rate precedence and offline fallback
2. Regenerate the demo when catalog membership or metadata changes. Review the diff for unintended changes to historical usage or totals
3. Run the following checks and smoke-test a live pricing load when the parser changes. Check the source, warnings and representative prices to distinguish an official parse from a fallback

```sh
bun test tests/pricing.test.ts
bun run demo
bun test
bun run typecheck
bun usage help
git -c core.whitespace=-blank-at-eol diff --check
git diff --stat
git diff --cached --stat
```

The whitespace command allows Markdown hard line breaks. Compare the staged snapshot blob before and after with `git ls-files -s src/openai-pricing-cache.ts`. Leave staging and commits to the maintainer
