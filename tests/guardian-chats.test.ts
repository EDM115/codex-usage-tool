import { expect, test } from "bun:test";
import { buildDemoDataset } from "../scripts/generate-demo";
import { setupExtendedAnalytics } from "../src/report-extended";

test("Top chats sums Guardian review usage while retaining ordinary chats with matching titles", async () => {
  const dataset = await buildDemoDataset();
  const sample = dataset.analytics!.topChats!.chats[0]!;
  dataset.analytics!.topChats!.chats = [
    {
      ...sample,
      threadId: "guardian-a",
      title: "Guardian review",
      weeklyLimitPercent: 2,
      balanceUsageCredits: 3,
      groups: [],
      updatedAt: "2026-09-23T00:00:00Z",
    },
    {
      ...sample,
      threadId: "guardian-b",
      title: "Guardian review",
      weeklyLimitPercent: 5,
      balanceUsageCredits: 4,
      groups: [],
      updatedAt: "2026-09-22T00:00:00Z",
    },
    { ...sample, threadId: "ordinary-a", title: "Same title", weeklyLimitPercent: 1, groups: [] },
    { ...sample, threadId: "ordinary-b", title: "Same title", weeklyLimitPercent: 1, groups: [] },
  ];
  const target = { innerHTML: "" };
  const document = { getElementById: (id: string) => (id === "topChats" ? target : null) };
  const setup = new Function("document", `return (${setupExtendedAnalytics.toString()});`)(
    document,
  ) as typeof setupExtendedAnalytics;
  let range = { from: "2026-09-01", to: "2026-09-30" };
  const render = setup(
    dataset,
    new Set(["chats"]),
    () => range,
    () => dataset.theme,
  );
  render();
  expect(target.innerHTML).toContain("Guardian review (2 chats)");
  expect(target.innerHTML).toContain("<strong>7%</strong><strong>7</strong>");
  expect(target.innerHTML.match(/Same title/g)).toHaveLength(2);
  range = { from: "2026-09-23", to: "2026-09-23" };
  render();
  expect(target.innerHTML).toContain("Guardian review (1 chat)");
  expect(target.innerHTML).toContain("<strong>2%</strong><strong>3</strong>");
});
