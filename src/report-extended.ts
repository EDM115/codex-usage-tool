import type { UsageDataset } from "./types";
import type { ReportSection } from "./sections";

type Range = { from: string; to: string };
type Point = { date: string; values: Record<string, number> };

export function setupExtendedAnalytics(dataset: UsageDataset, sections: Set<ReportSection>, range: () => Range, appearance: () => UsageDataset["theme"]) {
  const byId = (id: string) => document.getElementById(id)!;
  const attrSelect = document.getElementById("attributionDimension") as HTMLSelectElement | null;
  const messagesSelect = document.getElementById("messagesDimension") as HTMLSelectElement | null;
  const limitSelect = document.getElementById("limitDimension") as HTMLSelectElement | null;
  const chartSelections = new Map<string, { day: string; category: string }>();
  const chartData = new Map<string, { points: Point[]; heading: string; unit: string }>();
  let expandedChats = false;
  const expandedLimits: Record<string, boolean> = { "300": false, "10080": false };
  const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const count = (value: number) => Math.round(value).toLocaleString();
  const percent = (value: number | null | undefined) => value == null ? "-" : `${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
  const credits = (value: number | null | undefined) => value == null ? "-" : value > 0 && value < 0.01 ? "<0.01" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Math.max(0, value));
  const basisPercent = (value: number | null | undefined) => value == null ? "Not available" : value > 0 && value < 10 ? "<0.1%" : percent(value / 100);
  const utcDate = (value: string, options: Intl.DateTimeFormatOptions) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date); };
  const periodLabel = (start: string, end: string, minutes: number) => minutes === 300 ? `${utcDate(start, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} - ${utcDate(end, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} UTC` : `${utcDate(start, { month: "short", day: "numeric" })} - ${utcDate(end, { month: "short", day: "numeric" })}`;
  const inRange = (date: string) => (!range().from || date >= range().from) && (!range().to || date <= range().to);
  const color = (index: number) => { const palette = appearance().colors.series; return palette[index % Math.max(1, palette.length)] ?? appearance().colors.accent; };
  const titleCase = (value: string) => /^(gpt-|codex-)/i.test(value) ? value : value.toLowerCase() === "github_code_review" ? "GitHub Code Review" : value.replace(/^start[-_]/, "").replace(/[_-]/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
  const chatTitle = (value: string) => value.trimStart().startsWith("The following is the Codex agent history whose request action you are assessing") || value.includes(">>> TRANSCRIPT START") ? "codex-auto-review" : value;

  function chart(target: HTMLElement, points: Point[], heading: string, unit: string, showHeading = true) {
    chartData.set(target.id, { points, heading, unit });
    if (!points.length) {
      target.innerHTML = '<p class="section-copy">No data available for the selected dates</p>';
      return;
    }
    const shown = points.filter((point) => inRange(point.date));
    if (!shown.length) {
      target.innerHTML = '<p class="section-copy">No data available for the selected dates</p>';
      return;
    }
    const sums = new Map<string, number>();
    for (const point of shown) for (const [key, value] of Object.entries(point.values)) sums.set(key, (sums.get(key) ?? 0) + value);
    const categories = [...sums].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([key]) => key);
    if (!categories.length) {
      target.innerHTML = '<p class="section-copy">No measured activity in the selected dates</p>';
      return;
    }
    const max = Math.max(...shown.map((point) => Object.values(point.values).reduce((sum, value) => sum + value, 0)), 1);
    const selection = chartSelections.get(target.id) ?? { day: "", category: "" };
    if (selection.day && !shown.some((point) => point.date === selection.day)) selection.day = "";
    if (selection.category && !categories.includes(selection.category)) selection.category = "";
    chartSelections.set(target.id, selection);
    const selected = shown.find((point) => point.date === selection.day);
    const bars = shown.map((point) => {
      const total = Object.values(point.values).reduce((sum, value) => sum + value, 0);
      const segments = categories.map((key, index) => {
        const value = point.values[key] ?? 0;
        const height = total > 0 ? value / total * 100 : 0;
        const description = unit === "attribution" ? `${titleCase(key)}: ${percent(total ? value / total * 100 : 0)} of the day's attributed usage` : `${titleCase(key)}: ${count(value)} ${unit}`;
        return value > 0 ? `<span class="${selection.category && selection.category !== key ? "analytics-segment-muted" : ""}" style="height:${height}%;background:${color(index)}" title="${escape(description)}"></span>` : "";
      }).join("");
      const label = unit === "attribution" ? `${point.date}: attributed usage` : `${point.date}: ${count(total)} ${unit}`;
      return `<button type="button" class="analytics-day${point.date === selection.day ? " selected" : ""}${selection.day && point.date !== selection.day ? " analytics-day-muted" : ""}" data-date="${escape(point.date)}" aria-label="${escape(label)}" aria-pressed="${point.date === selection.day}"><span class="analytics-day-stack" style="height:${Math.max(2, total / max * 100)}%">${segments}</span></button>`;
    }).join("");
    const legendValues = selected?.values ?? Object.fromEntries(sums);
    const selectedTotal = Object.values(legendValues).reduce((sum, value) => sum + value, 0);
    const legend = categories.map((key, index) => {
      const value = legendValues[key] ?? 0;
      const display = unit === "attribution" ? percent(selectedTotal ? value / selectedTotal * 100 : 0) : `${count(value)} ${unit}`;
      return `<button type="button" class="analytics-legend-item${selection.category && selection.category !== key ? " analytics-legend-muted" : ""}" data-category="${escape(key)}" aria-pressed="${selection.category === key}"><i style="background:${color(index)}"></i><span>${escape(titleCase(key))}</span><strong>${escape(display)}</strong></button>`;
    }).join("");
    const period = `${shown[0].date} - ${shown.at(-1)!.date}`;
    target.innerHTML = `<div class="analytics-chart-title"><strong>${showHeading ? escape(heading) : ""}</strong><span>${escape(unit === "attribution" ? `${selected?.date ?? period} UTC · share of daily usage` : `${selected?.date ?? period} UTC`)}</span></div><div class="analytics-bars${shown.length > 90 ? " analytics-bars-dense" : ""}">${bars}</div><div class="analytics-axis"><span>${escape(shown[0].date)}</span><span>${escape(shown.at(-1)!.date)}</span></div><div class="analytics-legend">${legend}</div>`;
    target.querySelectorAll<HTMLButtonElement>(".analytics-day").forEach((button) => button.addEventListener("click", () => { const day = button.dataset.date ?? ""; selection.day = selection.day === day ? "" : day; chart(target, points, heading, unit, showHeading); }));
    target.querySelectorAll<HTMLButtonElement>(".analytics-legend-item").forEach((button) => button.addEventListener("click", () => { const category = button.dataset.category ?? ""; selection.category = selection.category === category ? "" : category; chart(target, points, heading, unit, showHeading); }));
  }

  function exportChartSvg(targetId: string): { name: string; svg: string } | null {
    const state = chartData.get(targetId);
    if (!state) return null;
    const name = targetId === "attributionHistory" ? `codex-usage-history-${attrSelect?.value ?? "feature"}` : targetId === "messagesHistory" ? `codex-usage-messages-${messagesSelect?.value ?? "model"}` : targetId === "pluginActivity" ? "codex-usage-plugin-activity" : "codex-usage-skill-activity";
    const shown = state.points.filter((point) => inRange(point.date));
    const totals = new Map<string, number>();
    for (const point of shown) for (const [key, value] of Object.entries(point.values)) totals.set(key, (totals.get(key) ?? 0) + value);
    const categories = [...totals].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([key]) => key);
    const width = Math.max(1100, 140 + shown.length * 6);
    const height = Math.max(420, 405 + Math.ceil(categories.length / 2) * 28);
    const theme = appearance();
    const start = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(state.heading)}"><rect width="100%" height="100%" fill="${escape(theme.colors.panel)}"/><g font-family="${escape(theme.fonts.ui)}"><text x="70" y="36" fill="${escape(theme.colors.text)}" font-size="20" font-weight="700">${escape(state.heading)}</text>`;
    if (!shown.length || !categories.length) return { name, svg: `${start}<text x="70" y="78" fill="${escape(theme.colors.muted)}" font-size="14">No data available for the selected dates</text></g></svg>` };

    const left = 70;
    const right = width - 30;
    const top = 80;
    const bottom = 320;
    const maximum = Math.max(1, ...shown.map((point) => Object.values(point.values).reduce((sum, value) => sum + value, 0)));
    const selection = chartSelections.get(targetId) ?? { day: "", category: "" };
    const selected = shown.find((point) => point.date === selection.day);
    const legendValues = selected?.values ?? Object.fromEntries(totals);
    const legendTotal = Object.values(legendValues).reduce((sum, value) => sum + value, 0);
    const subtitle = `${selected?.date ?? `${shown[0].date} - ${shown.at(-1)!.date}`} UTC${state.unit === "attribution" ? " · share of daily usage" : ""}`;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((fraction) => { const y = bottom - fraction * (bottom - top); return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${escape(theme.colors.line)}"/><text x="${left - 12}" y="${y + 4}" text-anchor="end" fill="${escape(theme.colors.muted)}" font-size="11">${escape(count(maximum * fraction))}</text>`; }).join("");
    const step = (right - left) / shown.length;
    const bars = shown.map((point, dayIndex) => {
      const x = left + dayIndex * step + step * 0.1;
      const barWidth = Math.max(1, step * 0.8);
      const dayOpacity = selection.day && selection.day !== point.date ? 0.27 : 1;
      let y = bottom;
      return `<g opacity="${dayOpacity}">${categories.map((category, categoryIndex) => {
        const value = Math.max(0, point.values[category] ?? 0);
        if (!value) return "";
        const barHeight = value / maximum * (bottom - top);
        y -= barHeight;
        const categoryOpacity = selection.category && selection.category !== category ? 0.18 : 1;
        const detail = state.unit === "attribution" ? `${titleCase(category)}: ${percent(Object.values(point.values).reduce((sum, row) => sum + row, 0) ? value / Object.values(point.values).reduce((sum, row) => sum + row, 0) * 100 : 0)}` : `${titleCase(category)}: ${count(value)} ${state.unit}`;
        return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${escape(color(categoryIndex))}" opacity="${categoryOpacity}"><title>${escape(`${point.date} - ${detail}`)}</title></rect>`;
      }).join("")}</g>`;
    }).join("");
    const labels = [shown[0], shown.at(-1)!].map((point, index) => `<text x="${index ? right : left}" y="${bottom + 24}" text-anchor="${index ? "end" : "start"}" fill="${escape(theme.colors.muted)}" font-size="11">${escape(point.date)}</text>`).join("");
    const legend = categories.map((category, index) => { const column = index % 2; const row = Math.floor(index / 2); const x = left + column * ((right - left) / 2); const y = 386 + row * 28; const value = legendValues[category] ?? 0; const display = state.unit === "attribution" ? percent(legendTotal ? value / legendTotal * 100 : 0) : `${count(value)} ${state.unit}`; const opacity = selection.category && selection.category !== category ? 0.3 : 1; return `<g opacity="${opacity}"><rect x="${x}" y="${y - 10}" width="9" height="13" fill="${escape(color(index))}"/><text x="${x + 17}" y="${y}" fill="${escape(theme.colors.text)}" font-size="12">${escape(`${titleCase(category)}: ${display}`)}</text></g>`; }).join("");
    return { name, svg: `${start}<text x="70" y="57" fill="${escape(theme.colors.muted)}" font-size="12">${escape(subtitle)}</text>${grid}${bars}${labels}${legend}</g></svg>` };
  }

  function renderAttribution() {
    if (!attrSelect) return;
    const target = byId("attributionHistory");
    const buckets = dataset.analytics?.dailyTokenUsageBreakdown?.data ?? [];
    const missing = buckets.some((bucket) => bucket.attribution == null);
    if (missing) {
      chartData.set(target.id, { points: [], heading: "Total usage by " + titleCase(attrSelect.value), unit: "attribution" });
      target.innerHTML = '<p class="section-copy">Attribution is incomplete for this response, no category shares are shown</p>';
      return;
    }
    const field = ({ feature: "threadSource", model: "model", surface: "surface", turn: "turnTrigger" } as const)[attrSelect.value as "feature" | "model" | "surface" | "turn"];
    const points = buckets.map((bucket) => {
      const values: Record<string, number> = {};
      for (const row of bucket.attribution ?? []) values[row[field]] = (values[row[field]] ?? 0) + row.value;
      return { date: bucket.date, values };
    });
    chart(target, points, "Total usage by " + titleCase(attrSelect.value), "attribution");
  }

  function renderLimits() {
    if (!limitSelect) return;
    const history = dataset.analytics?.planLimitHistory;
    const dimension = ({ feature: "thread_source", model: "model", surface: "surface", turn: "turn_trigger" } as const)[limitSelect.value as "feature" | "model" | "surface" | "turn"];
    for (const minutes of [300, 10080]) {
      const target = byId(minutes === 300 ? "fiveHourLimits" : "weeklyLimits");
      if (!history) {
        target.innerHTML = '<p class="section-copy">Plan limit history unavailable from the account API</p>';
        continue;
      }
      const periods = history.periods.filter((period) => period.windowMinutes === minutes).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
      const shown = expandedLimits[String(minutes)] ? periods : periods.slice(0, 5);
      const items = shown.map((period, index) => {
        const rows = period.breakdowns?.find((entry) => entry.dimension === dimension)?.rows;
        const breakdown = rows ? rows.map((row) => `<div class="analytics-limit-row"><span>${escape(titleCase(row.key))}</span><strong>${escape(basisPercent(row.basisPoints))}</strong></div>`).join("") : '<p class="section-copy">Breakdown unavailable.</p>';
        const asOf = history.dataAsOf && new Date(period.endsAt) > new Date(history.dataAsOf) ? `<p class="section-copy">Usage as of ${escape(utcDate(history.dataAsOf, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }))} UTC</p>` : "";
        return `<details class="analytics-period"${index === 0 ? " open" : ""}><summary><span>${escape(periodLabel(period.startsAt, period.endsAt, minutes))} · ${escape(period.planType)}</span><strong>${escape(basisPercent(period.usedBasisPoints))}</strong></summary><div class="analytics-period-body">${asOf}${!period.accountingComplete ? '<p class="section-copy">Accounting is incomplete for this period</p>' : ""}${breakdown}</div></details>`;
      }).join("");
      const caveats = [history.approximate ? "Approximate usage" : "", !history.coverageComplete ? "historical coverage is incomplete" : "", dimension === "turn_trigger" ? "turn start covers Tasks only, so rows may not add up to the period total" : ""].filter(Boolean).join(", ");
      target.innerHTML = `<h3>${minutes === 300 ? "5-hour limits" : "Weekly limits"}</h3>${caveats ? `<div class="section-copy">${escape(caveats)}</div>` : ""}${items || '<p class="section-copy">No periods available</p>'}${periods.length > 5 ? `<button type="button" class="analytics-show-more" data-minutes="${minutes}">${expandedLimits[String(minutes)] ? "Show less" : "Show more"}</button>` : ""}`;
      target.querySelector(".analytics-show-more")?.addEventListener("click", () => { expandedLimits[String(minutes)] = !expandedLimits[String(minutes)]; renderLimits(); });
    }
  }

  function renderChats() {
    if (!sections.has("chats")) return;
    const target = byId("topChats");
    const chats = dataset.analytics?.topChats?.chats ?? [];
    if (!chats.length) {
      target.innerHTML = '<p class="section-copy">No recent chat usage was available, live account access and local task metadata are needed</p>';
      return;
    }
    const recent = [...chats].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, 100).filter((chat) => !chat.updatedAt || inRange(chat.updatedAt.slice(0, 10)));
    if (!recent.length) {
      target.innerHTML = '<p class="section-copy">No chats in the selected date range</p>';
      return;
    }
    const grouped = new Map<string, typeof recent[number] & { chatCount: number; sourceLabels: string[] }>();
    const add = (a: number | null, b: number | null) => a == null && b == null ? null : (a ?? 0) + (b ?? 0);
    for (const chat of recent) {
      const title = chatTitle(chat.title);
      const special = title === "codex-auto-review" || title === "Untitled chat";
      const key = special ? title : chat.threadId;
      const previous = grouped.get(key);
      if (!previous) { grouped.set(key, { ...chat, groups: [...chat.groups], title, chatCount: 1, sourceLabels: [chat.homeLabel] }); continue; }
      previous.chatCount += 1;
      previous.fiveHourLimitPercent = add(previous.fiveHourLimitPercent, chat.fiveHourLimitPercent);
      previous.weeklyLimitPercent = add(previous.weeklyLimitPercent, chat.weeklyLimitPercent);
      previous.balanceUsageCredits = add(previous.balanceUsageCredits, chat.balanceUsageCredits);
      previous.groups.push(...chat.groups);
      if (!previous.sourceLabels.includes(chat.homeLabel)) previous.sourceLabels.push(chat.homeLabel);
      if (chat.dataStatus !== "unavailable") previous.dataStatus = chat.dataStatus;
    }
    const sorted = [...grouped.values()].sort((a, b) => (b.weeklyLimitPercent ?? -1) - (a.weeklyLimitPercent ?? -1));
    const visible = expandedChats ? sorted : sorted.slice(0, 5);
    target.innerHTML = `<div class="analytics-table-head"><span>Chat</span><span>% of weekly limit</span><span>Credits used</span></div>${visible.map((chat) => {
      const groupTotal = chat.groups.reduce((sum, group) => sum + (group.weeklyLimitPercent ?? group.fiveHourLimitPercent ?? group.balanceUsageCredits ?? 0), 0);
      const modelTotals = new Map<string, number>();
      for (const group of chat.groups) modelTotals.set(group.model, (modelTotals.get(group.model) ?? 0) + (group.weeklyLimitPercent ?? group.fiveHourLimitPercent ?? group.balanceUsageCredits ?? 0));
      const models = [...modelTotals].sort((a, b) => b[1] - a[1]).map(([name, value]) => `${escape(name)} ${escape(percent(groupTotal ? value / groupTotal * 100 : 0))}`).join(" · ");
      const efforts = [...new Set(chat.groups.map((group) => group.reasoningEffort))].map(escape).join(", ");
      const speeds = [...new Set(chat.groups.map((group) => group.speed))].map(escape).join(", ");
      const displayTitle = chat.chatCount > 1 || chat.title === "codex-auto-review" || chat.title === "Untitled chat" ? `${chat.title} (${chat.chatCount} ${chat.chatCount === 1 ? "chat" : "chats"})` : chat.title;
      return `<details class="analytics-chat"><summary><span>${escape(displayTitle)}</span><strong>${escape(percent(chat.weeklyLimitPercent))}</strong><strong>${escape(credits(chat.balanceUsageCredits))}</strong></summary><div class="analytics-chat-details"><div><strong>Source</strong> ${escape(chat.sourceLabels.join(", "))}</div><div><strong>Model</strong> ${models || "Unavailable"}</div><div><strong>Effort</strong> ${efforts || "Unavailable"}</div><div><strong>Speed</strong> ${speeds || "Unavailable"}</div>${chat.dataStatus === "unavailable" ? '<p>Usage unavailable for this chat</p>' : ""}</div></details>`;
    }).join("")}${sorted.length > 5 ? `<button type="button" class="analytics-show-more" id="chatsShowMore">${expandedChats ? "Show less" : "Show more"}</button>` : ""}`;
    byId("chatsShowMore")?.addEventListener("click", () => { expandedChats = !expandedChats; renderChats(); });
  }

  function renderTools() {
    if (!sections.has("skills")) return;
    for (const [kind, id] of [["plugin", "pluginActivity"], ["skill", "skillActivity"]] as const) {
      const source = kind === "plugin" ? dataset.analytics?.pluginUsage : dataset.analytics?.skillUsage;
      const points = source?.data.map((bucket) => {
        const values: Record<string, number> = {};
        for (const row of bucket.rows) values[row.label] = (values[row.label] ?? 0) + row.count;
        return { date: bucket.date, values };
      }) ?? [];
      chart(byId(id), points, kind === "plugin" ? "Plugins called" : "Skills used", kind === "plugin" ? "calls" : "uses", false);
    }
  }

  function renderMessages() {
    if (!messagesSelect) return;
    const buckets = dataset.analytics?.workspaceUsageCounts?.data ?? [];
    const kind = messagesSelect.value;
    const points = buckets.map((bucket) => {
      const values: Record<string, number> = {};
      const rows = kind === "model" ? bucket.models : bucket.clients;
      for (const row of rows) {
        const raw = String(kind === "model" ? row.model ?? "other" : row.client_id ?? row.clientId ?? "other");
        const key = kind === "model" ? (/^other$/i.test(raw) ? "other" : raw) : surfaceName(raw);
        values[key] = (values[key] ?? 0) + Number(row.turns ?? 0);
      }
      const classified = Object.values(values).reduce((sum, value) => sum + value, 0);
      values.other = (values.other ?? 0) + Math.max(0, Number(bucket.totals.turns ?? 0) - classified);
      return { date: bucket.date, values };
    });
    chart(byId("messagesHistory"), points, kind === "model" ? "Messages by model" : "Messages by surface", "messages");
  }

  function surfaceName(raw: string) {
    const name = raw.toUpperCase();
    if (["CODEX_DESKTOP_APP", "CODEX_WORK_DESKTOP", "DESKTOP_APP"].includes(name)) return "Desktop App";
    if (["CODEX_IDE_VSCODE", "IDE_VSCODE", "VSCODE"].includes(name)) return "Vscode";
    if (["CODEX_SDK", "SDK"].includes(name)) return "Sdk";
    if (["CODEX_WORK_WEB", "CODEX_WEB"].includes(name)) return "Work Web";
    if (["CODEX_CLI", "CLI"].includes(name)) return "Cli";
    if (["CODEX_GITHUB", "GITHUB_CODE_REVIEW"].includes(name)) return "GitHub Code Review";
    if (["SERVICE_EXEC", "CODEX_EXEC", "EXEC"].includes(name)) return "Exec";
    if (name === "CODEX_WORK_MOBILE") return "Mobile";
    return "other";
  }

  attrSelect?.addEventListener("change", renderAttribution);
  messagesSelect?.addEventListener("change", renderMessages);
  limitSelect?.addEventListener("change", renderLimits);
  return Object.assign(() => { renderAttribution(); renderLimits(); renderChats(); renderTools(); renderMessages(); }, { exportChartSvg });
}

export function extendedAnalyticsRuntimeSource(): string {
  return setupExtendedAnalytics.toString();
}
