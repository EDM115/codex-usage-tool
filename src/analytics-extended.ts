import type { LocalThreadSummary, WhamPlanLimitHistory, WhamToolActivity, WhamTopChat } from "./types";

export type ThreadUsageQuery = { thread_id: string; created_at: string | null; descendant_thread_ids: string[] };

export function topChatTitle(title: string): string {
  return title.trimStart().startsWith("The following is the Codex agent history whose request action you are assessing") || title.includes(">>> TRANSCRIPT START") ? "codex-auto-review" : title;
}

export function recentThreadQueries(threads: LocalThreadSummary[], now = new Date()): { queries: ThreadUsageQuery[]; roots: LocalThreadSummary[] } {
  const uniqueThreads = new Map<string, LocalThreadSummary>();
  for (const thread of threads) {
    const previous = uniqueThreads.get(thread.threadId);
    if (!previous || (thread.updatedAt ?? "") > (previous.updatedAt ?? "")) uniqueThreads.set(thread.threadId, thread);
  }
  const byParent = new Map<string, LocalThreadSummary[]>();
  for (const thread of uniqueThreads.values()) {
    if (!thread.parentThreadId) continue;
    const children = byParent.get(thread.parentThreadId) ?? [];
    children.push(thread);
    byParent.set(thread.parentThreadId, children);
  }
  const roots = [...uniqueThreads.values()].filter((thread) => !thread.archived && !thread.parentThreadId).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, 100);
  const queries = roots.flatMap((root) => {
    const descendants: string[] = [];
    const seen = new Set([root.threadId]);
    const pending = [...(byParent.get(root.threadId) ?? [])];
    while (pending.length && descendants.length < 1000) {
      const child = pending.shift()!;
      if (seen.has(child.threadId)) continue;
      seen.add(child.threadId);
      descendants.push(child.threadId);
      pending.push(...(byParent.get(child.threadId) ?? []));
    }
    return descendants.length >= 1000 ? [] : [{ thread_id: root.threadId, created_at: root.createdAt, descendant_thread_ids: descendants }];
  });
  return { queries, roots };
}

export function normalizeTopChats(raw: any, roots: LocalThreadSummary[]): { dataAsOf?: string; chats: WhamTopChat[] } | undefined {
  if (!raw || !Array.isArray(raw.threads)) return undefined;
  const values = new Map(raw.threads.map((row: any) => [String(row.thread_id ?? row.threadId), row]));
  return {
    dataAsOf: optionalString(raw.data_as_of ?? raw.dataAsOf),
    chats: roots.map((root) => {
      const row: any = values.get(root.threadId) ?? {};
      const status = String(row.data_status ?? row.dataStatus ?? "unavailable");
      const metrics = status === "unavailable" ? {} : row;
      return {
        threadId: root.threadId,
        title: topChatTitle(root.title),
        homeLabel: root.homeLabel,
        updatedAt: root.updatedAt ?? undefined,
        dataStatus: status,
        fiveHourLimitPercent: nullableNumber(metrics.five_hour_limit_percent ?? metrics.fiveHourLimitPercent),
        weeklyLimitPercent: nullableNumber(metrics.weekly_limit_percent ?? metrics.weeklyLimitPercent),
        balanceUsageCredits: nullableNumber(metrics.balance_usage_credits ?? metrics.balanceUsageCredits),
        groups: Array.isArray(row.groups) ? row.groups.map((group: any) => ({
          model: String(group.model ?? "Unknown"),
          reasoningEffort: String(group.reasoning_effort ?? group.reasoningEffort ?? "Unknown"),
          speed: String(group.speed ?? "standard"),
          fiveHourLimitPercent: nullableNumber(group.five_hour_limit_percent ?? group.fiveHourLimitPercent),
          weeklyLimitPercent: nullableNumber(group.weekly_limit_percent ?? group.weeklyLimitPercent),
          balanceUsageCredits: nullableNumber(group.balance_usage_credits ?? group.balanceUsageCredits),
        })) : [],
      };
    }),
  };
}

export function normalizePlanLimitHistory(raw: any): WhamPlanLimitHistory | undefined {
  if (!raw || !Array.isArray(raw.periods)) return undefined;
  return {
    dataAsOf: optionalString(raw.data_as_of ?? raw.dataAsOf) ?? null,
    coverageStart: optionalString(raw.coverage_start ?? raw.coverageStart) ?? null,
    coverageComplete: Boolean(raw.coverage_complete ?? raw.coverageComplete),
    approximate: Boolean(raw.approximate ?? true),
    boundaryToleranceSeconds: nullableNumber(raw.boundary_tolerance_seconds ?? raw.boundaryToleranceSeconds),
    periods: raw.periods.filter((period: any) => [300, 10080].includes(period.window_minutes ?? period.windowMinutes)).map((period: any) => ({
      id: String(period.id ?? ""),
      windowMinutes: (period.window_minutes ?? period.windowMinutes) as 300 | 10080,
      planType: String(period.plan_type ?? period.planType ?? "unknown"),
      startsAt: String(period.starts_at ?? period.startsAt ?? ""),
      endsAt: String(period.ends_at ?? period.endsAt ?? ""),
      accountingComplete: Boolean(period.accounting_complete ?? period.accountingComplete),
      usedBasisPoints: nullableNumber(period.used_basis_points ?? period.usedBasisPoints),
      breakdowns: Array.isArray(period.breakdowns) ? period.breakdowns.filter((entry: any) => ["thread_source", "turn_trigger", "model", "surface"].includes(entry.dimension)).map((entry: any) => ({
        dimension: entry.dimension,
        rows: Array.isArray(entry.rows) ? entry.rows.map((row: any) => ({ key: String(row.key ?? ""), basisPoints: nonnegativeNumber(row.basis_points ?? row.basisPoints) })) : [],
      })) : null,
    })),
  };
}

export function normalizeToolActivity(raw: any, kind: "plugin" | "skill"): WhamToolActivity | undefined {
  if (!raw || !Array.isArray(raw.data)) return undefined;
  const field = kind === "plugin" ? "plugin_usage_overviews" : "skill_usage_overviews";
  return {
    dataFreshnessTs: optionalString(raw.data_freshness_ts ?? raw.dataFreshnessTs),
    data: raw.data.map((bucket: any) => ({
      date: String(bucket.date ?? ""),
      rows: (Array.isArray(bucket.rows) ? bucket.rows : Array.isArray(bucket[field]) ? bucket[field] : []).map((row: any) => ({
        key: String(row.key ?? (kind === "skill" ? row.skill_name ?? row.display_name ?? "other" : row.display_name ?? "other")),
        label: String(row.label ?? row.display_name ?? row.skill_name ?? "Other"),
        count: nonnegativeNumber(row.count ?? row.invocation_counts),
      })).filter((row: { count: number }) => row.count > 0),
    })),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nonnegativeNumber(value: unknown): number {
  return nullableNumber(value) ?? 0;
}
