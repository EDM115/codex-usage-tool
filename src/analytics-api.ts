import type { CodexAuthMaterial } from "./auth";
import type {
  WhamAnalytics,
  WhamDailyBreakdownBucket,
  WhamUsageResponse,
  WhamWorkspaceUsageBucket,
  LocalThreadSummary,
} from "./types";
import type { ReportSection } from "./sections";
import type { ProgressSink } from "./progress";

import { readFileSync } from "node:fs";

import { numberFrom } from "./util";
import { normalizePlanLimitHistory, normalizeToolActivity, normalizeTopChats, recentThreadQueries } from "./analytics-extended";

export async function loadWhamAnalytics(options: {
  analyticsJson?: string;
  noApi: boolean;
  baseUrl: string;
  auth: CodexAuthMaterial | null;
  from: string | null;
  to: string | null;
  threads?: LocalThreadSummary[];
  sections?: readonly ReportSection[];
  progress?: ProgressSink;
}): Promise<WhamAnalytics | undefined> {
  const range = analyticsDateRange(options.from, options.to);
  const endpoints = endpointMap(options.baseUrl, range.from, range.to);
  const sections = new Set(options.sections ?? ["chats", "limits-feature", "limits-model", "limits-surface", "limits-turn", "skills"]);

  if (options.analyticsJson) {
    const parsed = JSON.parse(readFileSync(options.analyticsJson, "utf8"));

    return normalizeWhamAnalytics(parsed, endpoints, false);
  }

  if (options.noApi) {
    return unavailable(endpoints, false, "Analytics API skipped because --no-api was selected");
  }

  if (!options.auth) {
    return unavailable(endpoints, false, "No auth.json access token found for analytics API");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.auth.accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-usage-tool/3.0",
    Referer: "https://chatgpt.com/codex/cloud/settings/analytics",
  };

  if (options.auth.accountId) {
    headers["ChatGPT-Account-Id"] = options.auth.accountId;
  }

  try {
    const threadSelection = recentThreadQueries(options.threads ?? []);
    const wantsLimits = [...sections].some((section) => section.startsWith("limits-"));
    const requests: Array<{ key: string; url: string; init?: { method: "POST"; body: string } }> = [
      { key: "usage", url: endpoints.usage },
      { key: "tasksCurrent", url: endpoints.tasksCurrent },
      { key: "tasksArchived", url: endpoints.tasksArchived },
    ];
    if (wantsLimits) requests.push({ key: "planHistory", url: endpoints.planLimitHistory });
    if (sections.has("chats") && threadSelection.queries.length > 0) requests.push({ key: "threadUsage", url: endpoints.threadUsageQuery, init: { method: "POST", body: JSON.stringify({ threads: threadSelection.queries }) } });
    for (const chunk of analyticsDateChunks(range.from, range.to)) {
      const urls = endpointMap(options.baseUrl, chunk.from, chunk.to);
      requests.push({ key: "dailyBreakdown", url: urls.dailyTokenUsageBreakdown }, { key: "workspaceCounts", url: urls.dailyWorkspaceUsageCounts });
      if (sections.has("skills")) requests.push({ key: "pluginUsage", url: urls.dailyPluginUsageMetrics }, { key: "skillUsage", url: urls.dailySkillUsageMetrics });
    }
    const results = await fetchAnalyticsRequests(requests, headers, options.progress);
    const first = (key: string) => results.find((result) => result.key === key)?.response.value;
    const combined = (key: string) => {
      const values = results.filter((result) => result.key === key && result.response.ok && Array.isArray(result.response.value?.data)).map((result) => result.response.value);
      return values.length ? { ...values.at(-1), data: values.flatMap((value) => value.data) } : undefined;
    };
    const errors = [...new Set(results.flatMap(({ key, response }) => !response.ok && !(key === "planHistory" && response.status === 404) ? [response.error] : []))];
    const analytics = normalizeWhamAnalytics(
      {
        usage: first("usage"),
        tasks: { current: first("tasksCurrent"), archived: first("tasksArchived") },
        dailyTokenUsageBreakdown: combined("dailyBreakdown"),
        workspaceUsageCounts: combined("workspaceCounts"),
        planLimitHistory: first("planHistory"),
        pluginUsage: combined("pluginUsage"),
        skillUsage: combined("skillUsage"),
        topChats: normalizeTopChats(first("threadUsage"), threadSelection.roots),
      },
      endpoints,
      true,
    );

    if (errors.length) {
      analytics.error = errors.slice(0, 5).join(", ") + (errors.length > 5 ? `, ${errors.length - 5} more API errors` : "");
    }

    return analytics;
  } catch (error) {
    return unavailable(endpoints, true, error instanceof Error ? error.message : String(error));
  }
}

function endpointMap(baseUrl: string, from: string, to: string): Record<string, string> {
  const base = normalizeBaseUrl(baseUrl);
  const query = `start_date=${encodeURIComponent(from)}&end_date=${encodeURIComponent(to)}&group_by=day`;

  return {
    usage: `${base}/wham/usage`,
    tasksCurrent: `${base}/wham/tasks/list?limit=20&task_filter=current`,
    tasksArchived: `${base}/wham/tasks/list?limit=20&task_filter=archived`,
    dailyTokenUsageBreakdown: `${base}/wham/usage/daily-token-usage-breakdown?${query}`,
    dailyWorkspaceUsageCounts: `${base}/wham/analytics/daily-workspace-usage-counts?${query}&workspace_user=true`,
    planLimitHistory: `${base}/wham/usage/plan_limit_history?days=30`,
    dailyPluginUsageMetrics: `${base}/wham/analytics/daily-plugin-usage-metrics?${query}&workspace_user=true&top_plugin_limit=500`,
    dailySkillUsageMetrics: `${base}/wham/analytics/daily-skill-usage-metrics?${query}&workspace_user=true&top_skill_limit=500`,
    threadUsageQuery: `${base}/wham/usage/thread_usage/query_v2`,
  };
}

function analyticsDateRange(from: string | null, to: string | null): { from: string; to: string } {
  const end = to ?? new Date().toISOString().slice(0, 10);

  if (from) {
    return { from, to: end };
  }

  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);

  return { from: start.toISOString().slice(0, 10), to: end };
}

export function analyticsDateChunks(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let start = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (start <= last) {
    const end = new Date(Math.min(last.valueOf(), start.valueOf() + 119 * 86400000));
    chunks.push({ from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) });
    start = new Date(end.valueOf() + 86400000);
  }
  return chunks;
}

async function fetchAnalyticsRequests(
  requests: Array<{ key: string; url: string; init?: { method: "POST"; body: string } }>,
  headers: Record<string, string>,
  progress?: ProgressSink,
): Promise<Array<{ key: string; response: Awaited<ReturnType<typeof fetchJson>> }>> {
  const results: Array<{ key: string; response: Awaited<ReturnType<typeof fetchJson>> }> = new Array(requests.length);
  let next = 0;
  let completed = 0;
  progress?.statusProgress(`Fetching WHAM API [0/${requests.length}]`, 0, requests.length);
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (next < requests.length) {
      const index = next++;
      const request = requests[index];
      const response = await fetchJson(request.url, headers, request.init);
      results[index] = { key: request.key, response };
      completed += 1;
      progress?.statusProgress(`Fetching WHAM API [${completed}/${requests.length}] : ${request.key}`, completed, requests.length);
    }
  }));
  return results;
}

function normalizeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/, "");

  if (
    (normalized.startsWith("https://chatgpt.com") ||
      normalized.startsWith("https://chat.openai.com")) &&
    !normalized.includes("/backend-api")
  ) {
    normalized += "/backend-api";
  }

  return normalized;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  init?: { method: "POST"; body: string },
): Promise<{ ok: true; value: any; status?: number } | { ok: false; error: string; status?: number; value?: any }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: init ? { ...headers, "Content-Type": "application/json" } : headers, ...init });
  } catch (error) {
    return { ok: false, error: `${new URL(url).pathname} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const text = await response.text();
  let value: any;

  try {
    value = text ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `${new URL(url).pathname} returned ${response.status}`,
      status: response.status,
      value,
    };
  }

  return { ok: true, value, status: response.status };
}

function normalizeWhamAnalytics(
  raw: any,
  endpoints: Record<string, string>,
  fetched: boolean,
): WhamAnalytics {
  const usage = normalizeUsage(raw?.usage ?? raw?.whamUsage ?? raw?.usageResponse);
  const dailyTokenUsageBreakdown = normalizeDailyBreakdown(
    raw?.dailyTokenUsageBreakdown ?? raw?.daily_token_usage_breakdown,
  );
  const planLimitHistory = normalizePlanLimitHistory(raw?.planLimitHistory ?? raw?.plan_limit_history);
  const pluginUsage = normalizeToolActivity(raw?.pluginUsage ?? raw?.dailyPluginUsageMetrics, "plugin");
  const skillUsage = normalizeToolActivity(raw?.skillUsage ?? raw?.dailySkillUsageMetrics, "skill");
  const workspaceUsageCounts = normalizeWorkspaceCounts(
    raw?.workspaceUsageCounts ??
      raw?.dailyWorkspaceUsageCounts ??
      raw?.daily_workspace_usage_counts,
  );
  const tasks = normalizeTasks(raw?.tasks);
  const totals = workspaceUsageCounts?.data.reduce(
    (acc, bucket) => {
      acc.credits += numberFrom(bucket.totals.credits);
      acc.turns += numberFrom(bucket.totals.turns);
      acc.threads += numberFrom(bucket.totals.threads);
      acc.users = Math.max(acc.users, numberFrom(bucket.totals.users));
      acc.textTotalTokens += numberFrom(
        bucket.totals.text_total_tokens ?? bucket.totals.textTotalTokens,
      );

      return acc;
    },
    { credits: 0, turns: 0, threads: 0, users: 0, textTotalTokens: 0 },
  ) ?? { credits: 0, turns: 0, threads: 0, users: 0, textTotalTokens: 0 };
  const byModel = aggregateModels(
    workspaceUsageCounts?.data ?? [],
    dailyTokenUsageBreakdown?.data ?? [],
  );
  const byModelVariants = aggregateModelVariants(dailyTokenUsageBreakdown?.data ?? []);
  const bySurface = aggregateSurfaces(
    dailyTokenUsageBreakdown?.data ?? [],
    workspaceUsageCounts?.data ?? [],
  );
  const bySource = aggregateSources(workspaceUsageCounts?.data ?? []);

  return {
    fetched,
    endpoints,
    usage,
    dailyTokenUsageBreakdown,
    planLimitHistory,
    pluginUsage,
    skillUsage,
    topChats: raw?.topChats,
    workspaceUsageCounts,
    tasks,
    totals,
    byModel,
    byModelVariants,
    bySurface,
    bySource,
  };
}

export function mergeWhamAnalyticsSnapshots(snapshots: WhamAnalytics[]): WhamAnalytics | undefined {
  const primary = snapshots.find((snapshot) => snapshot.fetched) ?? snapshots[0];
  if (!primary) return undefined;
  const byDate = <T extends { date: string }>(pick: (snapshot: WhamAnalytics) => { data: T[] } | undefined): T[] => {
    const rows = new Map<string, T>();
    for (const snapshot of [...snapshots].reverse()) for (const row of pick(snapshot)?.data ?? []) rows.set(row.date, row);
    return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  };
  const daily = byDate((snapshot) => snapshot.dailyTokenUsageBreakdown);
  const workspace = byDate((snapshot) => snapshot.workspaceUsageCounts);
  const plugins = byDate((snapshot) => snapshot.pluginUsage);
  const skills = byDate((snapshot) => snapshot.skillUsage);
  const periodMap = new Map<string, NonNullable<WhamAnalytics["planLimitHistory"]>["periods"][number]>();
  for (const snapshot of [...snapshots].reverse()) for (const period of snapshot.planLimitHistory?.periods ?? []) periodMap.set(period.id || `${period.windowMinutes}:${period.startsAt}:${period.endsAt}`, period);
  const chatMap = new Map<string, NonNullable<WhamAnalytics["topChats"]>["chats"][number]>();
  for (const snapshot of [...snapshots].reverse()) for (const chat of snapshot.topChats?.chats ?? []) {
    const previous = chatMap.get(chat.threadId);
    if (chat.dataStatus !== "unavailable" || !previous || previous.dataStatus === "unavailable") chatMap.set(chat.threadId, chat);
  }
  const newest = <T>(pick: (snapshot: WhamAnalytics) => T | undefined): T | undefined => snapshots.map(pick).find((value) => value !== undefined);
  const computed = normalizeWhamAnalytics({
    dailyTokenUsageBreakdown: daily.length ? { ...newest((snapshot) => snapshot.dailyTokenUsageBreakdown), data: daily } : undefined,
    workspaceUsageCounts: workspace.length ? { ...newest((snapshot) => snapshot.workspaceUsageCounts), data: workspace } : undefined,
    pluginUsage: plugins.length ? { ...newest((snapshot) => snapshot.pluginUsage), data: plugins } : undefined,
    skillUsage: skills.length ? { ...newest((snapshot) => snapshot.skillUsage), data: skills } : undefined,
    planLimitHistory: periodMap.size ? { ...newest((snapshot) => snapshot.planLimitHistory), periods: [...periodMap.values()] } : undefined,
    topChats: chatMap.size ? { dataAsOf: newest((snapshot) => snapshot.topChats?.dataAsOf), chats: [...chatMap.values()] } : undefined,
  }, primary.endpoints, primary.fetched);
  return { ...computed, totals: workspace.length ? computed.totals : primary.totals, byModel: workspace.length || daily.length ? computed.byModel : primary.byModel, byModelVariants: daily.length ? computed.byModelVariants : primary.byModelVariants, bySurface: workspace.length || daily.length ? computed.bySurface : primary.bySurface, bySource: workspace.length ? computed.bySource : primary.bySource, usage: newest((snapshot) => snapshot.usage), tasks: newest((snapshot) => snapshot.tasks), error: primary.error };
}

export function filterWhamAnalyticsRange(snapshot: WhamAnalytics | undefined, from: string | null, to: string | null): WhamAnalytics | undefined {
  if (!snapshot || (!from && !to)) return snapshot;
  const within = (date: string) => (!from || date >= from) && (!to || date <= to);
  const daily = snapshot.dailyTokenUsageBreakdown && { ...snapshot.dailyTokenUsageBreakdown, data: snapshot.dailyTokenUsageBreakdown.data.filter((row) => within(row.date)) };
  const workspace = snapshot.workspaceUsageCounts && { ...snapshot.workspaceUsageCounts, data: snapshot.workspaceUsageCounts.data.filter((row) => within(row.date)) };
  const pluginUsage = snapshot.pluginUsage && { ...snapshot.pluginUsage, data: snapshot.pluginUsage.data.filter((row) => within(row.date)) };
  const skillUsage = snapshot.skillUsage && { ...snapshot.skillUsage, data: snapshot.skillUsage.data.filter((row) => within(row.date)) };
  const planLimitHistory = snapshot.planLimitHistory && { ...snapshot.planLimitHistory, periods: snapshot.planLimitHistory.periods.filter((period) => (!from || period.endsAt.slice(0, 10) >= from) && (!to || period.startsAt.slice(0, 10) <= to)) };
  const topChats = snapshot.topChats && { ...snapshot.topChats, chats: snapshot.topChats.chats.filter((chat) => !chat.updatedAt || within(chat.updatedAt.slice(0, 10))) };
  const filtered = normalizeWhamAnalytics({ dailyTokenUsageBreakdown: daily, workspaceUsageCounts: workspace, pluginUsage, skillUsage, planLimitHistory, topChats }, snapshot.endpoints, snapshot.fetched);
  return { ...filtered, error: snapshot.error };
}

function normalizeTasks(value: any): WhamAnalytics["tasks"] | undefined {
  if (!value) {
    return undefined;
  }

  const current = taskItems(value.current ?? value.currentTasks ?? value);
  const archivedResponse = value.archived ?? value.archivedTasks;
  const archived = taskItems(archivedResponse);

  if (current.length === 0 && archived.length === 0) {
    return undefined;
  }

  const pullRequests = { total: 0, open: 0, merged: 0, closed: 0 };
  const diffStats = { filesModified: 0, linesAdded: 0, linesRemoved: 0 };
  const byEnvironment = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const byIntent = new Map<string, number>();

  for (const task of current) {
    const display = task.task_status_display ?? task.taskStatusDisplay ?? {};
    const latest = display.latest_turn_status_display ?? display.latestTurnStatusDisplay ?? {};
    const environment = String(
      display.environment_label ?? display.environmentLabel ?? "Unknown environment",
    );
    const status = String(latest.turn_status ?? latest.turnStatus ?? "unknown");
    const intent = String(
      latest.intent ?? display.initial_intent ?? display.initialIntent ?? "unknown",
    );
    increment(byEnvironment, environment);
    increment(byStatus, labelClient(status));
    increment(byIntent, labelClient(intent));
    const diff = latest.diff_stats ?? latest.diffStats ?? {};
    diffStats.filesModified += numberFrom(diff.files_modified ?? diff.filesModified);
    diffStats.linesAdded += numberFrom(diff.lines_added ?? diff.linesAdded);
    diffStats.linesRemoved += numberFrom(diff.lines_removed ?? diff.linesRemoved);
    const prs = Array.isArray(task.pull_requests) ? task.pull_requests : [];

    for (const pr of prs) {
      const item = pr.pull_request ?? pr.pullRequest ?? pr;
      pullRequests.total += 1;

      if (item.merged) {
        pullRequests.merged += 1;
      } else if (item.state === "open") {
        pullRequests.open += 1;
      } else if (item.state === "closed") {
        pullRequests.closed += 1;
      }
    }
  }

  return {
    currentCount: current.length,
    archivedCount: archived.length,
    archivedHasMore: Boolean(
      (archivedResponse && typeof archivedResponse === "object" && archivedResponse.cursor) ||
      false,
    ),
    currentByEnvironment: sortedCounts(byEnvironment, "environment"),
    currentByStatus: sortedCounts(byStatus, "status"),
    currentByIntent: sortedCounts(byIntent, "intent"),
    pullRequests,
    diffStats,
    recent: current
      .slice()
      .sort(
        (a, b) => numberFrom(b.updated_at ?? b.updatedAt) - numberFrom(a.updated_at ?? a.updatedAt),
      )
      .slice(0, 5)
      .map((task: any) => {
        const display = task.task_status_display ?? task.taskStatusDisplay ?? {};
        const latest = display.latest_turn_status_display ?? display.latestTurnStatusDisplay ?? {};

        return {
          title: String(task.title ?? "Untitled task"),
          environment: String(
            display.environment_label ?? display.environmentLabel ?? "Unknown environment",
          ),
          status: String(latest.turn_status ?? latest.turnStatus ?? "unknown"),
          branch: display.branch_name ?? display.branchName,
          updatedAt: nullableNumber(task.updated_at ?? task.updatedAt) ?? undefined,
          archived: Boolean(task.archived),
          pullRequests: Array.isArray(task.pull_requests) ? task.pull_requests.length : 0,
        };
      }),
  };
}

function taskItems(value: any): any[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value?.items)) {
    return value.items;
  }

  if (Array.isArray(value?.data)) {
    return value.data;
  }

  return [];
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCounts<Key extends string>(
  map: Map<string, number>,
  key: Key,
): Array<Record<Key, string> & { count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ [key]: label, count }) as Record<Key, string> & { count: number });
}

function normalizeUsage(value: any): WhamUsageResponse | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return {
    planType: value.plan_type ?? value.planType,
    rateLimit: {
      primaryUsedPercent: numberFrom(
        value.rate_limit?.primary_window?.used_percent ??
          value.rateLimit?.primaryWindow?.usedPercent,
      ),
      secondaryUsedPercent: numberFrom(
        value.rate_limit?.secondary_window?.used_percent ??
          value.rateLimit?.secondaryWindow?.usedPercent,
      ),
      primaryResetAt: nullableNumber(
        value.rate_limit?.primary_window?.reset_at ?? value.rateLimit?.primaryWindow?.resetAt,
      ),
      secondaryResetAt: nullableNumber(
        value.rate_limit?.secondary_window?.reset_at ?? value.rateLimit?.secondaryWindow?.resetAt,
      ),
    },
    credits: value.credits
      ? {
          hasCredits: Boolean(value.credits.has_credits ?? value.credits.hasCredits),
          unlimited: Boolean(value.credits.unlimited),
          balance: value.credits.balance == null ? undefined : String(value.credits.balance),
          overageLimitReached: Boolean(
            value.credits.overage_limit_reached ?? value.credits.overageLimitReached,
          ),
          approxLocalMessages: Array.isArray(value.credits.approx_local_messages)
            ? value.credits.approx_local_messages.map(numberFrom)
            : undefined,
          approxCloudMessages: Array.isArray(value.credits.approx_cloud_messages)
            ? value.credits.approx_cloud_messages.map(numberFrom)
            : undefined,
        }
      : undefined,
  };
}

function normalizeDailyBreakdown(
  value: any,
): WhamAnalytics["dailyTokenUsageBreakdown"] | undefined {
  const data = Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : null;

  if (!data) {
    return undefined;
  }

  return {
    units: value?.units,
    groupBy: value?.group_by ?? value?.groupBy,
    dataFreshnessTs: value?.data_freshness_ts ?? value?.dataFreshnessTs,
    data: data.map((bucket: any): WhamDailyBreakdownBucket => ({
      date: String(bucket.date ?? bucket.start_date ?? bucket.startDate),
      attribution: bucket.attribution === null ? null : Array.isArray(bucket.attribution) ? bucket.attribution.map((row: any) => ({
        value: numberFrom(row.value),
        threadSource: String(row.thread_source ?? row.threadSource ?? "Unknown"),
        turnTrigger: String(row.turn_trigger ?? row.turnTrigger ?? "Unknown"),
        model: String(row.model ?? "Unknown"),
        surface: String(row.surface ?? "Unknown"),
      })) : undefined,
      productSurfaceUsageValues: normalizeNumberRecord(
        bucket.product_surface_usage_values ?? bucket.productSurfaceUsageValues,
      ),
      models: Array.isArray(bucket.models)
        ? bucket.models.map((model: any) => ({
            model: String(model.model ?? "unknown"),
            speed: model.speed == null ? undefined : String(model.speed),
            credits: numberFrom(model.credits),
          }))
        : [],
    })),
  };
}

function normalizeWorkspaceCounts(value: any): WhamAnalytics["workspaceUsageCounts"] | undefined {
  const data = Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : null;

  if (!data) {
    return undefined;
  }

  return {
    groupBy: value?.group_by ?? value?.groupBy,
    data: data.map((bucket: any): WhamWorkspaceUsageBucket => ({
      date: String(bucket.date ?? bucket.start_date ?? bucket.startDate),
      totals: normalizeNumberRecord(bucket.totals),
      clients: Array.isArray(bucket.clients) ? bucket.clients : [],
      models: Array.isArray(bucket.models) ? bucket.models : [],
    })),
  };
}

function aggregateModels(
  workspace: WhamWorkspaceUsageBucket[],
  daily: WhamDailyBreakdownBucket[],
): WhamAnalytics["byModel"] {
  const map = new Map<
    string,
    { model: string; credits: number; turns: number; threads: number; users: number }
  >();

  for (const bucket of workspace) {
    for (const row of bucket.models) {
      const model = String(row.model ?? "unknown");
      const item = map.get(model) ?? { model, credits: 0, turns: 0, threads: 0, users: 0 };
      item.credits += numberFrom(row.credits);
      item.turns += numberFrom(row.turns);
      item.threads += numberFrom(row.threads);
      item.users = Math.max(item.users, numberFrom(row.users));
      map.set(model, item);
    }
  }

  for (const bucket of daily) {
    for (const row of bucket.models) {
      const model = row.model;
      const item = map.get(model) ?? { model, credits: 0, turns: 0, threads: 0, users: 0 };
      item.credits += row.credits;
      map.set(model, item);
    }
  }

  return [...map.values()]
    .sort((a, b) => (b.turns || b.credits) - (a.turns || a.credits))
    .slice(0, 12);
}

function aggregateModelVariants(
  daily: WhamDailyBreakdownBucket[],
): WhamAnalytics["byModelVariants"] {
  const map = new Map<string, { model: string; speed: string; credits: number }>();

  for (const bucket of daily) {
    for (const row of bucket.models) {
      const speed = row.speed ?? "standard";
      const key = row.model + "\u0000" + speed;
      const item = map.get(key) ?? { model: row.model, speed, credits: 0 };
      item.credits += row.credits;
      map.set(key, item);
    }
  }

  return [...map.values()].filter((row) => row.credits > 0).sort((a, b) => b.credits - a.credits);
}

function aggregateSurfaces(
  daily: WhamDailyBreakdownBucket[],
  workspace: WhamWorkspaceUsageBucket[],
): WhamAnalytics["bySurface"] {
  const percents = new Map<string, number>();

  for (const bucket of daily) {
    for (const [surface, value] of Object.entries(bucket.productSurfaceUsageValues)) {
      percents.set(surface, (percents.get(surface) ?? 0) + value);
    }
  }

  const clientStats = new Map<
    string,
    {
      turns: number;
      threads: number;
      users: number;
      credits: number;
      textTotalTokens: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
    }
  >();

  for (const bucket of workspace) {
    for (const client of bucket.clients) {
      const surface = labelClient(
        String(client.client_id ?? client.clientId ?? client.source ?? "unknown"),
      );
      const item = clientStats.get(surface) ?? {
        turns: 0,
        threads: 0,
        users: 0,
        credits: 0,
        textTotalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
      item.turns += numberFrom(client.turns);
      item.threads += numberFrom(client.threads);
      item.users = Math.max(item.users, numberFrom(client.users));
      item.credits += numberFrom(client.credits);
      item.inputTokens += numberFrom(
        client.uncached_text_input_tokens ?? client.uncachedTextInputTokens,
      );
      item.cachedInputTokens += numberFrom(
        client.cached_text_input_tokens ?? client.cachedTextInputTokens,
      );
      item.outputTokens += numberFrom(client.text_output_tokens ?? client.textOutputTokens);
      item.textTotalTokens += numberFrom(client.text_total_tokens ?? client.textTotalTokens);
      clientStats.set(surface, item);
    }
  }
  const totalPercent = Math.max(
    1,
    [...percents.values()].reduce((sum, value) => sum + value, 0),
  );
  const surfaces = new Set([...percents.keys()].map(labelClient).concat([...clientStats.keys()]));

  return [...surfaces]
    .map((surface) => {
      const rawKey = [...percents.keys()].find((key) => labelClient(key) === surface);
      const stats = clientStats.get(surface);

      return {
        surface,
        credits: stats?.credits ?? 0,
        percent: rawKey ? ((percents.get(rawKey) ?? 0) / totalPercent) * 100 : 0,
        turns: stats?.turns ?? 0,
        threads: stats?.threads ?? 0,
        users: stats?.users ?? 0,
        textTotalTokens: stats?.textTotalTokens ?? 0,
        inputTokens: stats?.inputTokens ?? 0,
        cachedInputTokens: stats?.cachedInputTokens ?? 0,
        outputTokens: stats?.outputTokens ?? 0,
      };
    })
    .filter((row) => row.credits > 0 || row.percent > 0 || row.turns > 0 || row.textTotalTokens > 0)
    .sort(
      (a, b) =>
        (b.textTotalTokens || b.turns || b.credits || b.percent) -
        (a.textTotalTokens || a.turns || a.credits || a.percent),
    )
    .slice(0, 12);
}

function aggregateSources(workspace: WhamWorkspaceUsageBucket[]): WhamAnalytics["bySource"] {
  const map = new Map<
    string,
    {
      source: string;
      credits: number;
      turns: number;
      threads: number;
      users: number;
      textTotalTokens: number;
    }
  >();

  for (const bucket of workspace) {
    for (const client of bucket.clients) {
      const source = labelClient(
        String(client.client_id ?? client.clientId ?? client.source ?? "unknown"),
      );
      const item = map.get(source) ?? {
        source,
        credits: 0,
        turns: 0,
        threads: 0,
        users: 0,
        textTotalTokens: 0,
      };
      item.credits += numberFrom(client.credits);
      item.turns += numberFrom(client.turns);
      item.threads += numberFrom(client.threads);
      item.users = Math.max(item.users, numberFrom(client.users));
      item.textTotalTokens += numberFrom(client.text_total_tokens ?? client.textTotalTokens);
      map.set(source, item);
    }
  }

  return [...map.values()]
    .sort(
      (a, b) =>
        (b.textTotalTokens || b.turns || b.credits) - (a.textTotalTokens || a.turns || a.credits),
    )
    .slice(0, 12);
}

function labelClient(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/^codex_/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const known: Record<string, string> = {
    cli: "CLI",
    desktop_app: "Desktop app",
    ide_vscode: "VS Code",
    vscode: "VS Code",
    service_exec: "Service exec",
    exec: "Service exec",
    github_code_review: "GitHub code review",
    pr: "PR",
    qa: "QA",
  };

  if (known[normalized]) {
    return known[normalized];
  }

  return normalized.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeNumberRecord(value: any): Record<string, number> {
  const out: Record<string, number> = {};

  if (!value || typeof value !== "object") {
    return out;
  }

  for (const [key, item] of Object.entries(value)) {
    out[key] = numberFrom(item);
  }

  return out;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return numberFrom(value);
}

function unavailable(
  endpoints: Record<string, string>,
  fetched: boolean,
  error: string,
): WhamAnalytics {
  return {
    fetched,
    endpoints,
    error,
    totals: { credits: 0, turns: 0, threads: 0, users: 0, textTotalTokens: 0 },
    byModel: [],
    byModelVariants: [],
    bySurface: [],
    bySource: [],
  };
}
