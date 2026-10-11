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

test("Top chats groups Guardian reviews within each account and keeps shared thread IDs separate", async () => {
  const dataset = await buildDemoDataset();
  const sample = dataset.analytics!.topChats!.chats[0]!;
  dataset.analytics!.topChats!.chats = [
    { ...sample, accountId: "a", threadId: "guardian-a", title: "Guardian review", homeLabel: "Laptop", weeklyLimitPercent: 2, balanceUsageCredits: 3, groups: [], updatedAt: "2026-09-23T00:00:00Z" },
    { ...sample, accountId: "a", threadId: "guardian-b", title: "Guardian review", homeLabel: "Laptop", weeklyLimitPercent: 5, balanceUsageCredits: 4, groups: [], updatedAt: "2026-09-23T00:00:00Z" },
    { ...sample, accountId: "b", threadId: "guardian-c", title: "Guardian review", homeLabel: "Desktop", weeklyLimitPercent: 11, balanceUsageCredits: 9, groups: [], updatedAt: "2026-09-23T00:00:00Z" },
    { ...sample, accountId: "a", threadId: "shared", title: "Shared ID", homeLabel: "Laptop", weeklyLimitPercent: 1, groups: [], updatedAt: "2026-09-23T00:00:00Z" },
    { ...sample, accountId: "b", threadId: "shared", title: "Shared ID", homeLabel: "Desktop", weeklyLimitPercent: 4, groups: [], updatedAt: "2026-09-23T00:00:00Z" },
  ];
  const target = { innerHTML: "", querySelector: () => null };
  const document = { getElementById: (id: string) => id === "topChats" ? target : null };
  const setup = new Function("document", `return (${setupExtendedAnalytics.toString()});`)(document) as typeof setupExtendedAnalytics;
  setup(dataset, new Set(["chats"]), () => ({ from: "2026-09-23", to: "2026-09-23" }), () => dataset.theme)();
  expect(target.innerHTML).toContain("Guardian review (2 chats)");
  expect(target.innerHTML).toContain("Guardian review (1 chat)");
  expect(target.innerHTML).toContain("<strong>7%</strong><strong>7</strong>");
  expect(target.innerHTML).toContain("<strong>11%</strong><strong>9</strong>");
  expect(target.innerHTML).not.toContain("<strong>18%</strong>");
  expect(target.innerHTML.match(/Shared ID/g)).toHaveLength(2);
  expect(target.innerHTML).toContain("Laptop");
  expect(target.innerHTML).toContain("Desktop");
});

test("plan history renders each account's own percentages, breakdowns and freshness", async () => {
  const dataset = await buildDemoDataset();
  const analytics = dataset.analytics!;
  const history = analytics.planLimitHistory!;
  const sample = history.periods.find((period) => period.windowMinutes === 300)!;
  const period = { ...sample, id: "shared-period", startsAt: "2026-09-23T00:00:00Z", endsAt: "2026-09-23T05:00:00Z", breakdowns: [{ dimension: "model" as const, rows: [{ key: "gpt-test", basisPoints: 1200 }] }] };
  dataset.analytics = { ...analytics, planLimitHistory: undefined, accounts: [
    { ...analytics, accountId: "a", accountLabel: "Laptop account", topChats: undefined, planLimitHistory: { ...history, dataAsOf: "2026-09-23T01:00:00Z", periods: [{ ...period, planType: "Plus", usedBasisPoints: 1200 }] } },
    { ...analytics, accountId: "b", accountLabel: "Desktop account", topChats: undefined, planLimitHistory: { ...history, dataAsOf: "2026-09-23T02:00:00Z", periods: [{ ...period, planType: "Pro", usedBasisPoints: 4300, breakdowns: [{ dimension: "model", rows: [{ key: "gpt-test", basisPoints: 4300 }] }] }] } },
  ] };
  const fiveHour = { innerHTML: "", querySelector: () => null };
  const weekly = { innerHTML: "", querySelector: () => null };
  const select = { value: "model", addEventListener: () => {} };
  const document = { getElementById: (id: string) => ({ limitDimension: select, fiveHourLimits: fiveHour, weeklyLimits: weekly })[id as "limitDimension"] ?? null };
  const setup = new Function("document", `return (${setupExtendedAnalytics.toString()});`)(document) as typeof setupExtendedAnalytics;
  const render = setup(dataset, new Set(["limits-model"]), () => ({ from: "2026-09-23", to: "2026-09-23" }), () => dataset.theme);
  render();
  expect(fiveHour.innerHTML).toContain("Laptop account");
  expect(fiveHour.innerHTML).toContain("Desktop account");
  expect(fiveHour.innerHTML).toContain("12%");
  expect(fiveHour.innerHTML).toContain("43%");
  expect(fiveHour.innerHTML).not.toContain("55%");
  expect(fiveHour.innerHTML).toContain("01:00");
  expect(fiveHour.innerHTML).toContain("02:00");
  expect(fiveHour.innerHTML.match(/gpt-test/g)).toHaveLength(2);
});
