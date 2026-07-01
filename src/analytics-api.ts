import { readFileSync } from "node:fs";
import type { CodexAuthMaterial } from "./auth";
import type { WhamAnalytics, WhamDailyBreakdownBucket, WhamUsageResponse, WhamWorkspaceUsageBucket } from "./types";
import { numberFrom } from "./util";

export async function loadWhamAnalytics(options: {
  analyticsJson?: string;
  noApi: boolean;
  baseUrl: string;
  auth: CodexAuthMaterial | null;
  from: string | null;
  to: string | null;
}): Promise<WhamAnalytics | undefined> {
  const range = analyticsDateRange(options.from, options.to);
  const endpoints = endpointMap(options.baseUrl, range.from, range.to);
  if (options.analyticsJson) {
    const parsed = JSON.parse(readFileSync(options.analyticsJson, "utf8"));
    return normalizeWhamAnalytics(parsed, endpoints, false);
  }
  if (options.noApi) return unavailable(endpoints, false, "Analytics API skipped because --no-api was selected");
  if (!options.auth) return unavailable(endpoints, false, "No auth.json access token found for analytics API");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.auth.accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-usage-tool/0.2",
    Referer: "https://chatgpt.com/codex/cloud/settings/analytics",
  };
  if (options.auth.accountId) headers["ChatGPT-Account-Id"] = options.auth.accountId;
  try {
    const [usage, tasks, dailyBreakdown, workspaceCounts] = await Promise.all([
      fetchJson(endpoints.usage, headers),
      fetchJson(endpoints.tasks, headers),
      fetchJson(endpoints.dailyTokenUsageBreakdown, headers),
      fetchJson(endpoints.dailyWorkspaceUsageCounts, headers),
    ]);
    const errors = [usage, tasks, dailyBreakdown, workspaceCounts].filter((result) => !result.ok).map((result) => result.error);
    const analytics = normalizeWhamAnalytics({ usage: usage.value, tasks: tasks.value, dailyTokenUsageBreakdown: dailyBreakdown.value, workspaceUsageCounts: workspaceCounts.value }, endpoints, true);
    if (errors.length) analytics.error = errors.join("; ");
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
    tasks: `${base}/wham/tasks/list?limit=19&task_filter=current`,
    dailyTokenUsageBreakdown: `${base}/wham/usage/daily-token-usage-breakdown?${query}`,
    dailyWorkspaceUsageCounts: `${base}/wham/analytics/daily-workspace-usage-counts?${query}&workspace_user=true`,
  };
}

function analyticsDateRange(from: string | null, to: string | null): { from: string; to: string } {
  const end = to ?? new Date().toISOString().slice(0, 10);
  if (from) return { from, to: end };
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return { from: start.toISOString().slice(0, 10), to: end };
}

function normalizeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/, "");
  if ((normalized.startsWith("https://chatgpt.com") || normalized.startsWith("https://chat.openai.com")) && !normalized.includes("/backend-api")) normalized += "/backend-api";
  return normalized;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<{ ok: true; value: any } | { ok: false; error: string; value?: any }> {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let value: any;
  try {
    value = text ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }
  if (!response.ok) return { ok: false, error: `${url} returned ${response.status}: ${text.slice(0, 240)}`, value };
  return { ok: true, value };
}

function normalizeWhamAnalytics(raw: any, endpoints: Record<string, string>, fetched: boolean): WhamAnalytics {
  const usage = normalizeUsage(raw?.usage ?? raw?.whamUsage ?? raw?.usageResponse);
  const dailyTokenUsageBreakdown = normalizeDailyBreakdown(raw?.dailyTokenUsageBreakdown ?? raw?.daily_token_usage_breakdown);
  const workspaceUsageCounts = normalizeWorkspaceCounts(raw?.workspaceUsageCounts ?? raw?.dailyWorkspaceUsageCounts ?? raw?.daily_workspace_usage_counts);
  const tasks = raw?.tasks?.items || raw?.tasks?.data || raw?.tasks ? { currentCount: Array.isArray(raw?.tasks?.items) ? raw.tasks.items.length : Array.isArray(raw?.tasks) ? raw.tasks.length : 0 } : undefined;
  const totals = workspaceUsageCounts?.data.reduce((acc, bucket) => {
    acc.credits += numberFrom(bucket.totals.credits);
    acc.turns += numberFrom(bucket.totals.turns);
    acc.threads += numberFrom(bucket.totals.threads);
    acc.users = Math.max(acc.users, numberFrom(bucket.totals.users));
    acc.textTotalTokens += numberFrom(bucket.totals.text_total_tokens ?? bucket.totals.textTotalTokens);
    return acc;
  }, { credits: 0, turns: 0, threads: 0, users: 0, textTotalTokens: 0 });
  const byModel = aggregateModels(workspaceUsageCounts?.data ?? [], dailyTokenUsageBreakdown?.data ?? []);
  const bySurface = aggregateSurfaces(dailyTokenUsageBreakdown?.data ?? [], workspaceUsageCounts?.data ?? []);
  const bySource = aggregateSources(workspaceUsageCounts?.data ?? []);
  return {
    fetched,
    endpoints,
    usage,
    dailyTokenUsageBreakdown,
    workspaceUsageCounts,
    tasks,
    totals,
    byModel,
    bySurface,
    bySource,
  };
}

function normalizeUsage(value: any): WhamUsageResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  return {
    planType: value.plan_type ?? value.planType,
    rateLimit: {
      primaryUsedPercent: numberFrom(value.rate_limit?.primary_window?.used_percent ?? value.rateLimit?.primaryWindow?.usedPercent),
      secondaryUsedPercent: numberFrom(value.rate_limit?.secondary_window?.used_percent ?? value.rateLimit?.secondaryWindow?.usedPercent),
      primaryResetAt: nullableNumber(value.rate_limit?.primary_window?.reset_at ?? value.rateLimit?.primaryWindow?.resetAt),
      secondaryResetAt: nullableNumber(value.rate_limit?.secondary_window?.reset_at ?? value.rateLimit?.secondaryWindow?.resetAt),
    },
    credits: value.credits ? {
      hasCredits: Boolean(value.credits.has_credits ?? value.credits.hasCredits),
      unlimited: Boolean(value.credits.unlimited),
      balance: value.credits.balance == null ? undefined : String(value.credits.balance),
      overageLimitReached: Boolean(value.credits.overage_limit_reached ?? value.credits.overageLimitReached),
      approxLocalMessages: Array.isArray(value.credits.approx_local_messages) ? value.credits.approx_local_messages.map(numberFrom) : undefined,
      approxCloudMessages: Array.isArray(value.credits.approx_cloud_messages) ? value.credits.approx_cloud_messages.map(numberFrom) : undefined,
    } : undefined,
  };
}

function normalizeDailyBreakdown(value: any): WhamAnalytics["dailyTokenUsageBreakdown"] | undefined {
  const data = Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : null;
  if (!data) return undefined;
  return {
    units: value?.units,
    groupBy: value?.group_by ?? value?.groupBy,
    data: data.map((bucket: any): WhamDailyBreakdownBucket => ({
      date: String(bucket.date ?? bucket.start_date ?? bucket.startDate),
      productSurfaceUsageValues: normalizeNumberRecord(bucket.product_surface_usage_values ?? bucket.productSurfaceUsageValues),
      models: Array.isArray(bucket.models) ? bucket.models.map((model: any) => ({ model: String(model.model ?? "unknown"), speed: model.speed == null ? undefined : String(model.speed), credits: numberFrom(model.credits) })) : [],
    })),
  };
}

function normalizeWorkspaceCounts(value: any): WhamAnalytics["workspaceUsageCounts"] | undefined {
  const data = Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : null;
  if (!data) return undefined;
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

function aggregateModels(workspace: WhamWorkspaceUsageBucket[], daily: WhamDailyBreakdownBucket[]): WhamAnalytics["byModel"] {
  const map = new Map<string, { model: string; credits: number; turns: number; threads: number; users: number }>();
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
      const key = row.speed ? `${row.model} (${row.speed})` : row.model;
      const item = map.get(key) ?? { model: key, credits: 0, turns: 0, threads: 0, users: 0 };
      item.credits += row.credits;
      map.set(key, item);
    }
  }
  return [...map.values()].sort((a, b) => b.credits - a.credits).slice(0, 12);
}

function aggregateSurfaces(daily: WhamDailyBreakdownBucket[], workspace: WhamWorkspaceUsageBucket[]): WhamAnalytics["bySurface"] {
  const percents = new Map<string, number>();
  for (const bucket of daily) {
    for (const [surface, value] of Object.entries(bucket.productSurfaceUsageValues)) percents.set(surface, (percents.get(surface) ?? 0) + value);
  }
  const clientStats = new Map<string, { turns: number; threads: number; users: number; credits: number }>();
  for (const bucket of workspace) {
    for (const client of bucket.clients) {
      const surface = labelClient(String(client.client_id ?? client.clientId ?? client.source ?? "unknown"));
      const item = clientStats.get(surface) ?? { turns: 0, threads: 0, users: 0, credits: 0 };
      item.turns += numberFrom(client.turns);
      item.threads += numberFrom(client.threads);
      item.users = Math.max(item.users, numberFrom(client.users));
      item.credits += numberFrom(client.credits);
      clientStats.set(surface, item);
    }
  }
  const totalPercent = Math.max(1, [...percents.values()].reduce((sum, value) => sum + value, 0));
  const surfaces = new Set([...percents.keys()].map(labelClient).concat([...clientStats.keys()]));
  return [...surfaces].map((surface) => {
    const rawKey = [...percents.keys()].find((key) => labelClient(key) === surface);
    const stats = clientStats.get(surface);
    return {
      surface,
      credits: stats?.credits ?? 0,
      percent: rawKey ? (percents.get(rawKey) ?? 0) / totalPercent * 100 : 0,
      turns: stats?.turns ?? 0,
      threads: stats?.threads ?? 0,
      users: stats?.users ?? 0,
    };
  }).filter((row) => row.credits > 0 || row.percent > 0 || row.turns > 0).sort((a, b) => (b.credits || b.percent) - (a.credits || a.percent)).slice(0, 12);
}

function aggregateSources(workspace: WhamWorkspaceUsageBucket[]): WhamAnalytics["bySource"] {
  const map = new Map<string, { source: string; credits: number; turns: number; threads: number; users: number; textTotalTokens: number }>();
  for (const bucket of workspace) {
    for (const client of bucket.clients) {
      const source = labelClient(String(client.client_id ?? client.clientId ?? client.source ?? "unknown"));
      const item = map.get(source) ?? { source, credits: 0, turns: 0, threads: 0, users: 0, textTotalTokens: 0 };
      item.credits += numberFrom(client.credits);
      item.turns += numberFrom(client.turns);
      item.threads += numberFrom(client.threads);
      item.users = Math.max(item.users, numberFrom(client.users));
      item.textTotalTokens += numberFrom(client.text_total_tokens ?? client.textTotalTokens);
      map.set(source, item);
    }
  }
  return [...map.values()].sort((a, b) => b.credits - a.credits).slice(0, 12);
}

function labelClient(value: string): string {
  return value.toLowerCase().replace(/^codex_/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeNumberRecord(value: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) out[key] = numberFrom(item);
  return out;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return numberFrom(value);
}

function unavailable(endpoints: Record<string, string>, fetched: boolean, error: string): WhamAnalytics {
  return {
    fetched,
    endpoints,
    error,
    totals: { credits: 0, turns: 0, threads: 0, users: 0, textTotalTokens: 0 },
    byModel: [],
    bySurface: [],
    bySource: [],
  };
}