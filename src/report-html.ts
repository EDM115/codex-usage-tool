import type {
  LocalReasoningUsage,
  LocalServiceTierUsage,
  TokenBreakdown,
  UsageDataset,
  UsageTheme,
  WhamAnalytics,
} from "./types"

import { compactNumber, escapeHtml, money, pluralize } from "./util"

export type ReportModelRow = WhamAnalytics["byModel"][number] & {
  localTokens: number
  localBreakdown: TokenBreakdown
  localCostUsd: number
  reasoningEfforts: LocalReasoningUsage[]
  serviceTiers: LocalServiceTierUsage[]
  source: "local" | "local+cloud" | "cloud"
}

export function buildReportModelRows(dataset: UsageDataset): ReportModelRow[] {
  const cloudRows = dataset.analytics?.byModel ?? []
  const cloudByModel = new Map(cloudRows.map((row) => [row.model, row]))
  const localRows = dataset.local.modelUsage.map((usage): ReportModelRow => {
      const cloud = cloudByModel.get(usage.model)

      return {
        model: usage.model,
        credits: cloud?.credits ?? 0,
        turns: cloud?.turns ?? 0,
        threads: cloud?.threads ?? 0,
        users: cloud?.users ?? 0,
        localTokens: usage.breakdown.totalTokens,
        localBreakdown: usage.breakdown,
        localCostUsd: usage.costUsd,
        reasoningEfforts: usage.reasoningEfforts,
        serviceTiers: usage.serviceTiers,
        source: cloud ? "local+cloud" : "local",
      }
    })
  const localModels = new Set(dataset.local.modelUsage.map((row) => row.model))
  const cloudOnlyRows = cloudRows
    .filter((row) => !localModels.has(row.model))
    .map(
      (row): ReportModelRow => ({
        ...row,
        localTokens: 0,
        localBreakdown: {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        localCostUsd: 0,
        reasoningEfforts: [],
        serviceTiers: [],
        source: "cloud",
      }),
    )

  return [...localRows, ...cloudOnlyRows]
}

export function renderReportHtml(dataset: UsageDataset): string {
  const dataJson = JSON.stringify(dataset).replaceAll("</", "<\\/")
  const modelRowsJson = JSON.stringify(buildReportModelRows(dataset)).replaceAll("</", "<\\/")
  const theme = dataset.theme

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex usage report</title>
  <style>
    ${cssVars(theme)}
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 var(--font-ui);
    }
    main { max-width: 1220px; margin: 0 auto; padding: 28px 24px 42px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
    .report-title { display: flex; align-items: flex-start; gap: 10px; }
    .github-link { display: grid; place-items: center; width: 30px; height: 30px; margin-top: 2px; color: var(--muted); border-radius: 6px; }
    .github-link:hover { color: var(--text); background: var(--panel2); }
    .github-link svg { width: 20px; height: 20px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 0; font-size: 16px; letter-spacing: 0; }
    h3 { margin: 0; font-size: 13px; letter-spacing: 0; color: var(--muted); font-weight: 600; }
    p { margin: 0; color: var(--muted); }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button, select, input, summary {
      background: var(--panel2);
      border: 1px solid var(--line);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    button, summary { cursor: pointer; }
    button:hover, summary:hover { border-color: var(--accent2); }
    button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .toggle-control { display: inline-flex; align-items: center; gap: 7px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel2); color: var(--text); cursor: pointer; user-select: none; }
    .toggle-control input { width: auto; margin: 0; padding: 0; accent-color: var(--accent); }
    .stats { display: grid; grid-template-columns: repeat(6, minmax(135px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin-bottom: 22px; }
    .stat { background: var(--panel); padding: 16px; min-width: 0; }
    .stat strong { display: block; font-size: 22px; margin-bottom: 4px; white-space: nowrap; }
    .stat span { color: var(--muted); text-transform: lowercase; }
    .section { border: 1px solid var(--line); background: var(--panel); padding: 18px; margin-bottom: 18px; border-radius: 8px; overflow: auto; }
    .section-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 12px; }
    .section-title { display: grid; gap: 4px; min-width: 0; }
    .section-copy { color: var(--muted); font-size: 13px; }
    .section-actions { display: flex; gap: 8px; align-items: flex-start; flex: 0 0 auto; }
    .download-menu { position: relative; }
    .download-menu summary { list-style: none; user-select: none; width: 36px; height: 36px; display: grid; place-items: center; padding: 0; }
    .download-menu summary::-webkit-details-marker { display: none; }
    .download-icon { width: 18px; height: 18px; display: block; }
    .download-panel {
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      z-index: 6;
      display: grid;
      gap: 6px;
      min-width: 96px;
      padding: 8px;
      background: var(--panel2);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }
    .download-panel button { width: 100%; text-align: left; }
    .subrows { display: grid; gap: 7px; padding-left: 12px; border-left: 1px solid var(--line); }
    .subrow { display: grid; grid-template-columns: minmax(100px, 1fr) auto; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; cursor: help; min-width: 0; }
    .subrow .meter { height: 5px; }
    .model-group { display: grid; gap: 9px; padding-bottom: 12px; border-bottom: 1px solid var(--line); min-width: 0; }
    .model-group:last-child { padding-bottom: 0; border-bottom: 0; }
    .model-details { display: grid; gap: 9px; margin-left: 12px; padding-left: 11px; border-left: 1px solid var(--line); }
    .model-section { display: grid; gap: 7px; }
    .model-section + .model-section { padding-top: 9px; border-top: 1px solid var(--line); }
    .model-section h4 { margin: 0; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .overall-sections { display: grid; gap: 12px; padding-top: 14px; border-top: 1px solid var(--line); }
    .overall-sections .row { font-size: 12px; }
    .dashboard-export { width: 1100px; min-height: 520px; padding: 18px; background: var(--panel); color: var(--text); font: 14px/1.45 var(--font-ui); }
    .heatmap { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 14px); gap: 4px; width: max-content; min-height: 122px; }
    .cell { width: 14px; height: 14px; border-radius: 3px; background: var(--cell0); }
    .cell[data-level="1"] { background: var(--cell1); }
    .cell[data-level="2"] { background: var(--cell2); }
    .cell[data-level="3"] { background: var(--cell3); }
    .cell[data-level="4"] { background: var(--cell4); }
    .cell[data-level="5"] { background: var(--cell5); }
    .legend { display: flex; align-items: center; gap: 6px; color: var(--muted); margin-top: 12px; font-size: 12px; }
    .legend .cell { display: inline-block; }
    svg.chart { display: block; width: 100%; min-width: 720px; height: 330px; }
    .grid { stroke: var(--line); }
    .axis { fill: var(--muted); font-size: 11px; }
    .bar { fill: var(--accent); }
    .line { stroke: var(--accent); fill: none; stroke-width: 3; }
    .area { fill: var(--accent); opacity: 0.22; }
    .hit { fill: transparent; pointer-events: all; }
    .chart-dot { fill: var(--accent); }
    .breakdown-grid { display: grid; grid-template-columns: minmax(0, 2.15fr) minmax(280px, .85fr); gap: 14px; min-width: 0; align-items: start; }
    .breakdown-sidebar { display: grid; gap: 14px; min-width: 0; }
    .breakdown-panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--bg); min-width: 0; overflow: hidden; }
    .rows { display: grid; gap: 10px; margin-top: 12px; }
    .row { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 12px; align-items: center; }
    .row[data-tip] { cursor: help; }
    .row-label { min-width: 0; overflow-wrap: anywhere; }
    .row-value { color: var(--text); font-variant-numeric: tabular-nums; text-align: right; }
    .meter { grid-column: 1 / -1; height: 7px; border-radius: 999px; background: var(--panel2); overflow: hidden; }
    .meter span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .task-list { display: grid; gap: 9px; margin-top: 12px; }
    .task-item { border-top: 1px solid var(--line); padding-top: 9px; display: grid; gap: 2px; }
    .task-item:first-child { border-top: 0; padding-top: 0; }
    .task-title { overflow-wrap: anywhere; }
    .task-meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .environment-list { display: flex; flex-wrap: wrap; gap: 4px 10px; }
    .tooltip {
      position: fixed;
      z-index: 10;
      pointer-events: none;
      background: var(--panel2);
      border: 1px solid var(--line);
      color: var(--text);
      padding: 9px 10px;
      border-radius: 6px;
      max-width: 360px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
      display: none;
      white-space: pre-line;
    }
    .notes { color: var(--muted); display: grid; gap: 6px; }
    .warning { color: var(--warning); }
    @media (max-width: 900px) {
      header { display: block; }
      .toolbar { justify-content: flex-start; margin-top: 14px; }
      .stats { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
      .section-head { display: grid; }
      .section-actions { justify-content: flex-start; }
      .download-panel { right: auto; left: 0; }
      .breakdown-grid { grid-template-columns: 1fr; min-width: 0; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="report-title">
        <div>
          <h1>Codex usage report</h1>
          <p>Generated at ${escapeHtml(dataset.generatedAt)} (${escapeHtml(dataset.timezone)})</p>
        </div>
        <a class="github-link" href="https://github.com/EDM115/codex-usage-tool" target="_blank" rel="noreferrer" aria-label="Open codex-usage-tool on GitHub" title="GitHub repository"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true"><path d="M0 0h16v16H0z" fill="none"/><path fill="currentColor" d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656c0-.781.281-1.625.75-2.188c-.203-.515-.172-1.609.063-2.062c.625-.078 1.468.25 1.968.703c.594-.187 1.219-.281 1.985-.281c.765 0 1.39.094 1.953.265c.484-.437 1.344-.765 1.969-.687c.218.422.25 1.515.046 2.047c.5.593.766 1.39.766 2.203c0 1.922-1.453 3.375-3.547 3.64c.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03C16 3.61 12.406 0 7.984 0C3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156c-1.031 0-1.64-.562-2.078-1.609c-.172-.422-.36-.672-.719-.719c-.187-.015-.25-.093-.25-.187c0-.188.313-.328.625-.328c.453 0 .844.281 1.25.86c.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/></svg></a>
      </div>
      <div class="toolbar">
        <select id="mode" aria-label="Chart time mode">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="cumulative">Cumulative</option>
        </select>
        <select id="chartStyle" aria-label="Chart style">
          <option value="auto">Auto chart</option>
          <option value="bar">Bar</option>
          <option value="area">Line/area</option>
        </select>
        <input id="from" type="date" value="${escapeHtml(dataset.dateRange.from ?? dataset.daily[0]?.date ?? "")}" aria-label="Start date">
        <input id="to" type="date" value="${escapeHtml(dataset.dateRange.to ?? dataset.daily.at(-1)?.date ?? "")}" aria-label="End date">
        <label class="toggle-control"><input id="rawCounts" type="checkbox">Exact counts</label>
      </div>
    </header>

    <section class="stats">
      ${stat("lifetime tokens", dataset.summary.lifetimeTokens)}
      ${stat("peak day", dataset.summary.peakDailyTokens)}
      ${stat("local enriched tokens", dataset.summary.localKnownTokens)}
      ${stat("backend-only tokens", dataset.summary.unattributedTokens)}
      ${stat("estimated API cost", dataset.summary.estimatedCostUsd, "money")}
      ${stat("dashboard turns", dataset.analytics?.totals?.turns ?? 0)}
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-title">
          <h2>Daily intensity</h2>
          <p class="section-copy">Hover a day to inspect total tokens, local attribution, backend-only estimate, and cost</p>
        </div>
        <div class="section-actions">${downloadMenu("heatmap")}</div>
      </div>
      <div id="heatmap" class="heatmap" aria-label="Daily token intensity heatmap"></div>
      <div class="legend">Less <span class="cell" data-level="0"></span><span class="cell" data-level="1"></span><span class="cell" data-level="2"></span><span class="cell" data-level="3"></span><span class="cell" data-level="4"></span><span class="cell" data-level="5"></span> More</div>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-title">
          <h2>Usage trend</h2>
          <p class="section-copy">Switch between daily, weekly, and cumulative views. Hover bars or points for token and cost detail.</p>
        </div>
        <div class="section-actions">${downloadMenu("chart")}</div>
      </div>
      <svg id="chart" class="chart" role="img" aria-label="Codex token usage chart"></svg>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-title">
          <h2>Usage breakdown</h2>
          <p class="section-copy">Local model usage enriched with matching WHAM metrics, plus cloud surface and task metadata</p>
        </div>
        <div class="section-actions">
          <h3>${escapeHtml(dataset.analytics?.error ? "best effort" : dataset.analytics?.fetched ? "from wham APIs" : "saved or unavailable")}</h3>
          ${downloadMenu("dashboard")}
        </div>
      </div>
      <div id="analyticsBreakdown" class="breakdown-grid"></div>
    </section>

    <section class="section notes">
      <div><strong>Data sources :</strong> ${escapeHtml(dataset.sourceMode)}, profile API ${dataset.profile?.endpoint ? `from ${escapeHtml(dataset.profile.endpoint)}` : "not used"}, analytics ${dataset.analytics?.fetched ? "requested from wham dashboard APIs" : "not fetched live"}</div>
      <div><strong>Local enrichment :</strong> ${dataset.local.tokenEvents} ${pluralize("token event", dataset.local.tokenEvents)} from ${dataset.local.rolloutFiles} ${pluralize("rollout file", dataset.local.rolloutFiles)}, ${dataset.local.sqliteThreads} ${pluralize("SQLite thread row", dataset.local.sqliteThreads)} across ${dataset.local.sqliteDatabases} ${pluralize("SQLite database", dataset.local.sqliteDatabases)}, ${dataset.codexHomes.length} .codex ${pluralize("source", dataset.codexHomes.length)}</div>
      <div><strong>Theme :</strong> ${escapeHtml(dataset.theme.name)} from ${escapeHtml(dataset.theme.source)}</div>
      <div><strong>Pricing :</strong> ${escapeHtml(dataset.pricing.source)} using ${escapeHtml(dataset.pricing.estimateModel)} for unattributed backend-only tokens</div>
      ${dataset.profile?.error ? `<div class="warning"><strong>Profile API :</strong> ${escapeHtml(dataset.profile.error)}</div>` : ""}
      ${dataset.analytics?.error ? `<div class="warning"><strong>Analytics API :</strong> ${escapeHtml(dataset.analytics.error)}</div>` : ""}
      ${dataset.pricing.warning ? `<div class="warning"><strong>Pricing :</strong> ${escapeHtml(dataset.pricing.warning)}</div>` : ""}
    </section>
  </main>
  <div id="tooltip" class="tooltip"></div>
  <script id="usage-data" type="application/json">${dataJson}</script>
  <script id="model-rows" type="application/json">${modelRowsJson}</script>
  <script>
    const dataset = JSON.parse(document.getElementById('usage-data').textContent);
    const reportModels = JSON.parse(document.getElementById('model-rows').textContent);
    const modeEl = document.getElementById('mode');
    const chartStyleEl = document.getElementById('chartStyle');
    const fromEl = document.getElementById('from');
    const toEl = document.getElementById('to');
    const rawCountsEl = document.getElementById('rawCounts');
    const tooltip = document.getElementById('tooltip');
    const heatmap = document.getElementById('heatmap');
    const chart = document.getElementById('chart');
    const analyticsBreakdown = document.getElementById('analyticsBreakdown');
    const theme = dataset.theme;

    function exact(value, maximumFractionDigits, minimumFractionDigits) {
      if (!Number.isFinite(value)) {
        return '0';
      }

      return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: maximumFractionDigits == null ? 0 : maximumFractionDigits, minimumFractionDigits: minimumFractionDigits == null ? 0 : minimumFractionDigits, useGrouping: true }).format(value).replace(/[\\u00a0\\u202f]/g, ' ');
    }

    function compact(value) {
      if (rawCountsEl && rawCountsEl.checked) {
        return exact(value, 0);
      }

      const abs = Math.abs(value || 0);

      if (abs >= 1000000000) {
        return exact(value / 1000000000, 1) + ' B';
      }

      if (abs >= 1000000) {
        return exact(value / 1000000, 1) + ' M';
      }

      if (abs >= 1000) {
        return exact(value / 1000, 1) + ' K';
      }

      return exact(value || 0, 0);
    }

    function trimFixed(value) {
      return exact(value, 1);
    }

    function money(value) {
      if (!Number.isFinite(value)) {
        return '$ 0,00';
      }

      const digits = Math.abs(value) < 0.01 && value !== 0 ? 4 : 2;
      return '$ ' + exact(value, digits, digits);
    }

    function renderStats() {
      document.querySelectorAll('[data-stat-value]').forEach(function (el) {
        const value = Number(el.dataset.statValue);
        el.textContent = el.dataset.statKind === 'money' ? money(value) : compact(value);
      });
    }

    function escapeText(value) {
      return String(value).replace(/[&<>\"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; });
    }

    function filteredDaily() {
      return dataset.daily.filter(function (day) { return (!fromEl.value || day.date >= fromEl.value) && (!toEl.value || day.date <= toEl.value); });
    }

    function values() {
      const daily = filteredDaily();
      let cumulative = 0;

      if (modeEl.value === 'weekly') {
        const byWeek = new Map();

        for (let i = 0; i < daily.length; i += 7) {
          const chunk = daily.slice(i, i + 7);
          const total = chunk.reduce(function (sum, day) { return sum + day.totalTokens; }, 0);

          for (const day of chunk) {
            byWeek.set(day.date, total);
          }
        }

        return daily.map(function (day) { return Object.assign({ }, day, { displayValue: byWeek.get(day.date) || 0 }); });
      }

      return daily.map(function (day) {
        cumulative += day.totalTokens;
        return Object.assign({ }, day, { displayValue: modeEl.value === 'cumulative' ? cumulative : day.totalTokens });
      });
    }

    function tipFor(day) {
      return day.date + '\\nTotal : ' + exact(day.displayValue, 0) + ' tokens\\nLocal : ' + exact(day.localTokens.totalTokens, 0) + '\\nBackend-only : ' + exact(day.unattributedTokens, 0) + '\\nCost : ' + money(day.estimatedCostUsd);
    }

    function renderHeatmap() {
      const days = values();
      const max = Math.max(1, ...days.map(function (day) { return day.displayValue; }));
      heatmap.innerHTML = '';

      for (const day of days) {
        const level = day.displayValue <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(day.displayValue / max * 5)));
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.level = String(level);
        cell.dataset.tip = tipFor(day);
        cell.addEventListener('mousemove', showTip);
        cell.addEventListener('mouseleave', hideTip);
        heatmap.appendChild(cell);
      }
    }

    function renderChart() {
      const days = values();
      const width = 920, height = 330, left = 70, right = 28, top = 30, bottom = 42;
      const chartW = width - left - right, chartH = height - top - bottom;
      const max = Math.max(1, ...days.map(function (day) { return day.displayValue; }));
      chart.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      chart.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      chart.innerHTML = '';

      for (const frac of [0, .25, .5, .75, 1]) {
        const y = top + chartH - frac * chartH;
        chart.insertAdjacentHTML('beforeend', '<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'" class="grid"/><text x="'+(left-10)+'" y="'+(y+4)+'" text-anchor="end" class="axis">'+compact(max*frac)+'</text>');
      }

      const style = chartStyleEl.value === 'auto' ? (modeEl.value === 'daily' ? 'bar' : 'area') : chartStyleEl.value;

      if (style === 'bar') {
        const step = chartW / Math.max(1, days.length);
        days.forEach(function (day, i) {
          const h = day.displayValue / max * chartH;
          const x = left + i * step;
          const y = top + chartH - h;
          chart.insertAdjacentHTML('beforeend', '<rect class="bar" x="'+x+'" y="'+y+'" width="'+Math.max(2, step-2)+'" height="'+h+'"></rect><rect class="hit" x="'+x+'" y="'+top+'" width="'+Math.max(3, step-1)+'" height="'+chartH+'" data-tip="'+escapeText(tipFor(day))+'"></rect>');
        });
      } else {
        const pts = days.map(function (day, i) {
          const x = left + (days.length <= 1 ? 0 : i / (days.length - 1) * chartW);
          const y = top + chartH - day.displayValue / max * chartH;
          return {x:x,y:y,day:day};
        });

        if (pts.length) {
          const line = pts.map(function (p) { return p.x + ',' + p.y; }).join(' ');
          const area = pts[0].x + ',' + (top+chartH) + ' ' + line + ' ' + pts[pts.length-1].x + ',' + (top+chartH);
          chart.insertAdjacentHTML('beforeend', '<polygon class="area" points="'+area+'"/><polyline class="line" points="'+line+'"/>');
          pts.forEach(function (p) { chart.insertAdjacentHTML('beforeend', '<circle class="chart-dot" cx="'+p.x+'" cy="'+p.y+'" r="3"></circle><circle class="hit" cx="'+p.x+'" cy="'+p.y+'" r="10" data-tip="'+escapeText(tipFor(p.day))+'"></circle>'); });
        }
      }

      chart.querySelectorAll('.hit').forEach(bindTip);
    }

    function renderAnalytics() {
      const analytics = dataset.analytics;
      const surfaces = analytics && analytics.bySurface ? analytics.bySurface : [];

      if (reportModels.length === 0 && surfaces.length === 0 && !(analytics && analytics.tasks)) {
        analyticsBreakdown.innerHTML = '<div class="breakdown-panel"><h3>Dashboard data unavailable</h3><div class="rows"><p>' + escapeText(analytics && analytics.error ? analytics.error : 'No wham analytics response was available for this run') + '</p></div></div>';

        return;
      }

      const modelHtml = reportModels.length ? modelPanel(reportModels, analytics && analytics.byModelVariants ? analytics.byModelVariants : []) : '<div class="breakdown-panel"><h3>Models</h3><div class="rows"><p>No local model usage was recorded</p></div></div>';
      const cloudHtml = analytics ? surfacePanel(surfaces) + taskPanel(analytics.tasks) : '<div class="breakdown-panel"><h3>Cloud enrichment unavailable</h3><div class="rows"><p>No WHAM analytics response was available for this run</p></div></div>';
      analyticsBreakdown.innerHTML = modelHtml + '<div class="breakdown-sidebar">' + cloudHtml + '</div>';
      analyticsBreakdown.querySelectorAll('[data-tip]').forEach(bindTip);
    }

    function estimatedVariantRows(row, variants) {
      const totalCredits = variants.reduce(function (sum, variant) { return sum + variant.credits; }, 0);

      return variants.map(function (variant) {
        const share = totalCredits > 0 ? variant.credits / totalCredits : 0;
        return Object.assign({ }, variant, {
          label: variant.speed + (variant.speed === 'fast' ? ' mode' : ''),
          totalTokens: row.localTokens && share ? row.localTokens * share : 0,
          costUsd: row.localCostUsd && share ? row.localCostUsd * share : 0,
          source: row.localTokens && share ? 'cloud-estimate' : 'cloud-only',
          inferredTokens: 0,
          estimateSource: row.localTokens && share ? 'Estimated by allocating this model local total across WHAM speed credits' : 'WHAM exposes credits for this model version, but no local token count was available'
        });
      });
    }

    function serviceTierLabel(tier) {
      if (tier === 'default') {
        return 'standard';
      }

      if (tier === 'priority') {
        return 'fast mode';
      }

      return String(tier || 'unknown').replace(/_/g, ' ');
    }

    function serviceTierRows(row, variants) {
      if (row.serviceTiers && row.serviceTiers.length) {
        return row.serviceTiers.map(function (tier) {
          const speed = tier.serviceTier === 'priority' ? 'fast' : tier.serviceTier === 'default' ? 'standard' : tier.serviceTier;
          const cloudVariant = (variants || []).find(function (variant) { return variant.speed === speed; });
          return {
            label: serviceTierLabel(tier.serviceTier),
            speed: tier.serviceTier,
            credits: cloudVariant ? cloudVariant.credits : 0,
            totalTokens: tier.breakdown.totalTokens,
            breakdown: tier.breakdown,
            costUsd: tier.costUsd,
            inferredTokens: tier.inferredTokens || 0,
            source: 'local'
          };
        }).sort(function (a, b) { return b.totalTokens - a.totalTokens; });
      }

      return estimatedVariantRows(row, variants || []).filter(function (variant) { return variant.totalTokens > 0 || variant.credits > 0; }).sort(function (a, b) { return (b.totalTokens || b.credits) - (a.totalTokens || a.credits); });
    }

    function modelPanel(rows, variants) {
      const variantsByModel = modelVariantsByName(variants || []);
      const totalLocalTokens = Math.max(1, rows.reduce(function (sum, row) { return sum + row.localTokens; }, 0));
      const modelRows = rows.map(function (row, index) {
        const color = theme.colors.series[index % theme.colors.series.length];
        const meter = row.localTokens ? '<div class="meter" aria-label="'+escapeText(row.model)+' share of local tokens"><span style="width:'+(row.localTokens / totalLocalTokens * 100)+'%; background:'+color+'"></span></div>' : '';
        const details = modelDetails(row, variantsByModel.get(row.model) || [], color);
        return '<div class="model-group"><div class="row model-summary" data-tip="'+escapeText(modelTip(row))+'"><div class="row-label">'+escapeText(row.model)+'</div><div class="row-value">'+escapeText(modelValueText(row))+'</div>'+meter+'</div>'+details+'</div>';
      }).join('');
      const overall = overallPanels(rows, variantsByModel);

      return '<div class="breakdown-panel model-panel"><h3>Models</h3><div class="rows">' + modelRows + overall + '</div></div>';
    }

    function modelValueText(row) {
      if (row.localTokens) {
        return compact(row.localTokens) + ' local tokens · ' + money(row.localCostUsd) + (row.source === 'local+cloud' && row.turns ? ' · ' + compact(row.turns) + ' cloud turns' : '');
      }

      return row.turns ? compact(row.turns) + ' cloud turns' : compact(row.credits) + ' cloud credits';
    }

    function modelTip(row) {
      const source = row.source === 'local+cloud' ? 'Local rollout usage + WHAM enrichment' : row.source === 'local' ? 'Local rollout usage' : 'WHAM cloud only';
      let tip = row.model + '\\nSource : ' + source;

      if (row.localTokens) {
        tip += breakdownTip(row.localBreakdown) + '\\nEstimated local cost : ' + money(row.localCostUsd);
      }

      if (row.source !== 'local') {
        tip += '\\nDashboard turns : ' + exact(row.turns, 0) + '\\nThreads : ' + exact(row.threads, 0) + '\\nCredits : ' + exact(row.credits, 2);
      }

      return tip;
    }

    function breakdownTip(breakdown) {
      if (!breakdown) {
        return '';
      }

      return '\\nTotal tokens : ' + exact(breakdown.totalTokens, 0) + '\\nInput : ' + exact(breakdown.inputTokens, 0) + '\\nCached input : ' + exact(breakdown.cachedInputTokens, 0) + '\\nOutput : ' + exact(breakdown.outputTokens, 0) + '\\nReasoning output : ' + exact(breakdown.reasoningOutputTokens, 0);
    }

    function modelVariantsByName(variants) {
      const map = new Map();

      for (const variant of variants) {
        if (!map.has(variant.model)) {
          map.set(variant.model, []);
        }

        map.get(variant.model).push(variant);
      }

      for (const list of map.values()) {
        list.sort(function (a, b) { return b.credits - a.credits; });
      }

      return map;
    }

    function modelDetails(row, variants, color) {
      const reasoning = reasoningSection(row, color);
      const tiers = serviceTierSection(row, variants, color);

      if (!reasoning && !tiers) {
        return '';
      }

      return '<div class="model-details">' + reasoning + tiers + '</div>';
    }

    function reasoningSection(row, color) {
      const efforts = (row.reasoningEfforts || []).slice().sort(function (a, b) { return b.breakdown.totalTokens - a.breakdown.totalTokens; });

      if (!efforts.length) {
        return '';
      }

      return '<div class="model-section"><h4>Thinking effort</h4><div class="subrows">' + efforts.map(function (effort) {
        const tokens = effort.breakdown.totalTokens;
        const tip = row.model + ' / ' + effort.effort + '\\nSource : local rollout turn context' + breakdownTip(effort.breakdown) + '\\nEstimated cost : ' + money(effort.costUsd);
        return '<div class="subrow" data-tip="'+escapeText(tip)+'"><div>'+escapeText(effort.effort)+'</div><div>'+escapeText(compact(tokens) + ' tokens · ' + money(effort.costUsd))+'</div><div class="meter"><span style="width:'+(tokens / Math.max(1, row.localTokens) * 100)+'%; background:'+color+'"></span></div></div>';
      }).join('') + '</div></div>';
    }

    function serviceTierSection(row, variants, color) {
      const tiers = serviceTierRows(row, variants);

      if (!tiers.length) {
        return '';
      }

      const denominator = row.localTokens || tiers.reduce(function (sum, tier) { return sum + tier.credits; }, 0) || 1;
      return '<div class="model-section"><h4>Mode mix</h4><div class="subrows">' + tiers.map(function (tier) {
        const value = tier.totalTokens || tier.credits;
        const valueText = tier.totalTokens ? compact(tier.totalTokens) + ' tokens · ' + money(tier.costUsd) : compact(tier.credits) + ' credits';
        let tip = row.model + ' / ' + tier.label;

        if (tier.source === 'local') {
          tip += '\\nSource : local rollout service tier' + breakdownTip(tier.breakdown) + '\\nEstimated cost : ' + money(tier.costUsd);
          if (tier.credits) tip += '\\nMatching WHAM credits : ' + exact(tier.credits, 2);

          if (tier.inferredTokens) {
            tip += '\\nInferred tier tokens : ' + exact(tier.inferredTokens, 0) + '\\nEarlier same-model events were backfilled from the first subsequently recorded tier';
          }
        } else {
          tip += '\\nSource : WHAM speed enrichment';
          if (tier.totalTokens) tip += '\\nEstimated tokens : ' + exact(tier.totalTokens, 0) + '\\nEstimated cost : ' + money(tier.costUsd);
          tip += '\\nVariant credits : ' + exact(tier.credits, 2) + '\\n' + tier.estimateSource;
        }

        return '<div class="subrow" data-tip="'+escapeText(tip)+'"><div>'+escapeText(tier.label)+'</div><div>'+escapeText(valueText)+'</div><div class="meter"><span style="width:'+(value / denominator * 100)+'%; background:'+color+'"></span></div></div>';
      }).join('') + '</div></div>';
    }

    function overallUsageRows(rows, variantsByModel) {
      const reasoning = new Map();
      const modes = new Map();

      rows.forEach(function (row) {
        (row.reasoningEfforts || []).forEach(function (effort) {
          const item = reasoning.get(effort.effort) || { label: effort.effort, totalTokens: 0, costUsd: 0 };
          item.totalTokens += effort.breakdown.totalTokens;
          item.costUsd += effort.costUsd;
          reasoning.set(effort.effort, item);
        });
        serviceTierRows(row, variantsByModel.get(row.model) || []).forEach(function (tier) {
          if (!tier.totalTokens) return;
          const item = modes.get(tier.label) || { label: tier.label, totalTokens: 0, costUsd: 0, estimated: false };
          item.totalTokens += tier.totalTokens;
          item.costUsd += tier.costUsd;
          item.estimated = item.estimated || tier.source !== 'local';
          modes.set(tier.label, item);
        });
      });

      const reasoningRows = [...reasoning.values()].sort(function (a, b) { return b.totalTokens - a.totalTokens; });
      const modeRows = [...modes.values()].sort(function (a, b) { return b.totalTokens - a.totalTokens; });

      return { reasoningRows: reasoningRows, modeRows: modeRows };
    }

    function overallPanels(rows, variantsByModel) {
      const overall = overallUsageRows(rows, variantsByModel);
      const reasoningRows = overall.reasoningRows;
      const modeRows = overall.modeRows;

      if (!reasoningRows.length && !modeRows.length) {
        return '';
      }

      return '<div class="overall-sections">' + overallSection('Overall thinking effort', reasoningRows, 2, 'Exact local totals across models') + overallSection('Overall mode mix', modeRows, 4, 'Local tiers, with WHAM estimates only for models without local tier evidence') + '</div>';
    }

    function overallSection(titleText, rows, colorOffset, sourceText) {
      if (!rows.length) {
        return '';
      }

      const total = rows.reduce(function (sum, row) { return sum + row.totalTokens; }, 0) || 1;
      return '<div class="model-section"><h4>'+escapeText(titleText)+'</h4>' + rows.map(function (row, index) {
        const color = theme.colors.series[(index + colorOffset) % theme.colors.series.length];
        const tip = titleText + ' / ' + row.label + '\\nSource : ' + sourceText + '\\nTokens : ' + exact(row.totalTokens, 0) + '\\nEstimated cost : ' + money(row.costUsd) + (row.estimated ? '\\nContains WHAM-estimated mode allocation' : '');
        return '<div class="row" data-tip="'+escapeText(tip)+'"><div class="row-label">'+escapeText(row.label)+'</div><div class="row-value">'+escapeText(compact(row.totalTokens) + ' tokens · ' + money(row.costUsd))+'</div><div class="meter"><span style="width:'+(row.totalTokens / total * 100)+'%; background:'+color+'"></span></div></div>';
      }).join('') + '</div>';
    }

    function surfacePanel(rows) {
      const totalSurfaceTokens = rows.reduce(function (sum, row) { return sum + row.textTotalTokens; }, 0);

      return '<div class="breakdown-panel"><h3>Surfaces</h3><div class="rows">' + rows.map(function (row, index) {
        const color = theme.colors.series[index % theme.colors.series.length];
        const text = (row.textTotalTokens ? compact(row.textTotalTokens) + ' tokens' : trimFixed(row.percent) + '%') + ' - ' + compact(row.turns) + ' turns';
        const surfaceCost = totalSurfaceTokens ? dataset.summary.estimatedCostUsd * row.textTotalTokens / totalSurfaceTokens : 0;
        const tip = row.surface + '\\nTokens : ' + exact(row.textTotalTokens, 0) + '\\nInput : ' + exact(row.inputTokens, 0) + '\\nCached input : ' + exact(row.cachedInputTokens, 0) + '\\nOutput : ' + exact(row.outputTokens, 0) + '\\nTurns : ' + exact(row.turns, 0) + '\\nThreads : ' + exact(row.threads, 0) + '\\nCredits : ' + exact(row.credits, 2) + (row.textTotalTokens ? '\\nEstimated overall cost share : ' + money(surfaceCost) : '');
        const meter = row.textTotalTokens && totalSurfaceTokens ? '<div class="meter"><span style="width:'+(row.textTotalTokens / totalSurfaceTokens * 100)+'%; background:'+color+'"></span></div>' : '';
        return '<div class="row" data-tip="'+escapeText(tip)+'"><div class="row-label">'+escapeText(row.surface)+'</div><div class="row-value">'+escapeText(text)+'</div>'+meter+'</div>';
      }).join('') + '</div></div>';
    }

    function taskPanel(tasks) {
      if (!tasks) {
        return '<div class="breakdown-panel"><h3>Cloud tasks</h3><div class="rows"><p>No task list response was available</p></div></div>';
      }

      const archived = tasks.archivedCount == null ? '' : ' - ' + compact(tasks.archivedCount) + ' archived sample' + (tasks.archivedHasMore ? '+' : '');
      const pr = tasks.pullRequests || { total: 0, open: 0, merged: 0, closed: 0 };
      const diff = tasks.diffStats || { filesModified: 0, linesAdded: 0, linesRemoved: 0 };
      const envs = (tasks.currentByEnvironment || []).map(function (row) { return '<span>'+escapeText(row.environment)+' ('+exact(row.count, 0)+')</span>'; }).join('') || '<span>none</span>';
      const recent = (tasks.recent || []).map(function (task) {
        const meta = task.environment + ' - ' + task.status + (task.branch ? ' - ' + task.branch : '') + (task.pullRequests ? ' - ' + task.pullRequests + ' PR' : '');
        return '<div class="task-item" data-tip="'+escapeText(task.title + '\\n' + meta)+'"><div class="task-title">'+escapeText(task.title)+'</div><div class="task-meta">'+escapeText(meta)+'</div></div>';
      }).join('');

      return '<div class="breakdown-panel"><h3>Cloud tasks</h3><div class="rows"><div class="row" data-tip="Current task endpoint defaults to current tasks, limit is capped at 20. Archived tasks use task_filter=archived and may paginate."><div class="row-label">Current tasks</div><div class="row-value">'+compact(tasks.currentCount)+archived+'</div></div><div class="task-meta"><strong>Environments :</strong><div class="environment-list">'+envs+'</div></div><div class="task-meta">PRs : '+compact(pr.total)+' total, '+compact(pr.merged)+' merged, '+compact(pr.open)+' open<br>Diff : +'+compact(diff.linesAdded)+' / -'+compact(diff.linesRemoved)+' across '+compact(diff.filesModified)+' files</div></div><div class="task-list">'+recent+'</div></div>';
    }

    function bindTip(el) {
      el.addEventListener('mousemove', showTip);
      el.addEventListener('mouseleave', hideTip);
    }

    function showTip(event) {
      tooltip.textContent = event.currentTarget.dataset.tip;
      tooltip.style.display = 'block';
      tooltip.style.left = Math.max(12, Math.min(window.innerWidth - 380, event.clientX + 14)) + 'px';
      tooltip.style.top = Math.max(12, Math.min(window.innerHeight - 220, event.clientY + 14)) + 'px';
    }

    function hideTip() {
      tooltip.style.display = 'none';
    }

    function render() {
      renderStats();
      renderHeatmap(); renderChart();
      renderAnalytics();
    }

    function chartCss() {
      return '.grid{stroke:'+theme.colors.line+'}.axis{fill:'+theme.colors.muted+';font-size:11px}.bar{fill:'+theme.colors.accent+'}.line{stroke:'+theme.colors.accent+';fill:none;stroke-width:3}.area{fill:'+theme.colors.accent+';opacity:.22}.chart-dot{fill:'+theme.colors.accent+'}text{font-family:'+theme.fonts.ui+'}svg{background:'+theme.colors.bg+';color:'+theme.colors.text+'}';
    }

    function heatmapCss() {
      return 'text{font-family:'+theme.fonts.ui+';fill:'+theme.colors.muted+'}.label{font-size:11px}.cell{stroke:'+theme.colors.bg+';stroke-width:2}svg{background:'+theme.colors.bg+'}';
    }

    function serializedChartSvg() {
      const clone = chart.cloneNode(true);
      clone.querySelectorAll('.hit').forEach(function (el) { el.remove(); });
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', '920');
      clone.setAttribute('height', '330');
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = chartCss();
      clone.insertBefore(style, clone.firstChild);

      return '<?xml version="1.0" encoding="UTF-8"?>\\n' + new XMLSerializer().serializeToString(clone);
    }

    function serializedHeatmapSvg() {
      const days = values();
      const cell = 14, gap = 4, left = 14, top = 18, footer = 38;
      const cols = Math.max(1, Math.ceil(days.length / 7));
      const width = left + cols * (cell + gap) + 12;
      const height = top + 7 * (cell + gap) + footer;
      const max = Math.max(1, ...days.map(function (day) { return day.displayValue; }));
      let body = '<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'"><style>'+heatmapCss()+'</style>';
      days.forEach(function (day, index) {
        const col = Math.floor(index / 7);
        const row = index % 7;
        const level = day.displayValue <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(day.displayValue / max * 5)));
        const color = theme.colors.cells[level];
        body += '<rect class="cell" x="'+(left + col * (cell + gap))+'" y="'+(top + row * (cell + gap))+'" width="'+cell+'" height="'+cell+'" rx="3" fill="'+color+'"><title>'+escapeText(tipFor(day))+'</title></rect>';
      });
      body += '<text class="label" x="'+left+'" y="'+(height - 12)+'">Less to more daily token intensity. Hover cells in the HTML report for details.</text></svg>';

      return '<?xml version="1.0" encoding="UTF-8"?>\\n' + body;
    }

    function serializedDashboardSvg() {
      const clone = analyticsBreakdown.cloneNode(true);
      clone.querySelectorAll('[data-tip]').forEach(function (el) { el.removeAttribute('data-tip'); });
      const width = 1100;
      const height = Math.max(560, analyticsBreakdown.scrollHeight + 72);
      const html = '<div xmlns="http://www.w3.org/1999/xhtml" class="dashboard-export"><h2 style="margin:0 0 12px;font-size:18px;color:'+theme.colors.text+'">Usage Breakdown</h2>' + clone.outerHTML + '</div>';
      const css = '<style>.dashboard-export{box-sizing:border-box;background:'+theme.colors.panel+';color:'+theme.colors.text+';font:14px/1.45 '+theme.fonts.ui+'}.breakdown-grid{display:grid;grid-template-columns:minmax(0,2.15fr) minmax(280px,.85fr);gap:14px;align-items:start}.breakdown-sidebar{display:grid;gap:14px}.breakdown-panel{min-width:0;overflow:hidden;border:1px solid '+theme.colors.line+';border-radius:8px;padding:12px;background:'+theme.colors.bg+'}.rows,.model-group,.model-details,.model-section,.subrows{display:grid}.rows{gap:10px;margin-top:12px}.model-group{gap:9px;padding-bottom:12px;border-bottom:1px solid '+theme.colors.line+'}.model-details{gap:9px;margin-left:12px;padding-left:11px;border-left:1px solid '+theme.colors.line+'}.model-section,.subrows{gap:7px}.model-section+.model-section{padding-top:9px;border-top:1px solid '+theme.colors.line+'}.model-section h4{margin:0;color:'+theme.colors.muted+';font-size:11px;text-transform:uppercase}.row,.subrow{display:grid;grid-template-columns:minmax(100px,1fr) auto;gap:10px;align-items:center;min-width:0}.row-label,.task-title,.task-meta{overflow-wrap:anywhere}.row-value{text-align:right;font-variant-numeric:tabular-nums}.meter{grid-column:1/-1;height:7px;border-radius:999px;background:'+theme.colors.panel2+';overflow:hidden}.meter span{display:block;height:100%;border-radius:inherit}.subrow{color:'+theme.colors.muted+';font-size:12px}.subrow .meter{height:5px}.task-list{display:grid;gap:9px;margin-top:12px}.task-item{border-top:1px solid '+theme.colors.line+';padding-top:9px;display:grid;gap:2px}.task-meta{color:'+theme.colors.muted+';font-size:12px}.environment-list{display:flex;flex-wrap:wrap;gap:4px 10px}h3{margin:0;color:'+theme.colors.muted+';font-size:13px}</style>';

      return '<?xml version="1.0" encoding="UTF-8"?>\\n<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'">' + css + '<foreignObject width="100%" height="100%">' + html + '</foreignObject></svg>';
    }

    function renderDashboardCanvas() {
      const analytics = dataset.analytics || { };
      const models = reportModels;
      const variants = analytics.byModelVariants || [];
      const surfaces = analytics.bySurface || [];
      const tasks = analytics.tasks;
      const variantsByModel = modelVariantsByName(variants);
      const overall = overallUsageRows(models, variantsByModel);
      const modelLineCount = models.reduce(function (sum, row) { return sum + 1 + (row.reasoningEfforts || []).length + serviceTierRows(row, variantsByModel.get(row.model) || []).length + ((row.reasoningEfforts || []).length ? 1 : 0) + (serviceTierRows(row, variantsByModel.get(row.model) || []).length ? 1 : 0); }, 0) + overall.reasoningRows.length + overall.modeRows.length + 4;
      const width = 1400;
      const margin = 28;
      const gap = 18;
      const mainWidth = 900;
      const sideWidth = width - margin * 2 - gap - mainWidth;
      const surfaceHeight = Math.max(220, 82 + surfaces.length * 42);
      const taskLineCount = tasks ? 4 + (tasks.currentByEnvironment || []).length + Math.min(8, (tasks.recent || []).length) : 2;
      const taskHeight = Math.max(300, 100 + taskLineCount * 44);
      const panelHeight = Math.max(620, 112 + modelLineCount * 36, surfaceHeight + gap + taskHeight);
      const height = panelHeight + 96;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      function font(weight, size) { return weight + ' ' + size + 'px ' + theme.fonts.ui; }

      function text(value) { return value == null ? '' : String(value); }

      function fit(value, maxWidth) {
        let out = text(value);

        if (ctx.measureText(out).width <= maxWidth) return out;

        while (out.length > 1 && ctx.measureText(out + '...').width > maxWidth) out = out.slice(0, -1);

        return out + '...';
      }

      function roundRect(x, y, w, h, r, fill, stroke) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();

        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      function title(x, y, value) {
        ctx.font = font('700', 16);
        ctx.fillStyle = theme.colors.muted;
        ctx.fillText(value, x, y);
      }

      function section(x, y, value) {
        ctx.font = font('700', 12);
        ctx.fillStyle = theme.colors.muted;
        ctx.fillText(value.toUpperCase(), x, y);
      }

      function barRow(x, y, w, label, valueText, value, max, color, options) {
        const indent = options && options.indent ? options.indent : 0;
        const muted = options && options.muted;
        const rowH = options && options.small ? 32 : 42;
        ctx.font = font(muted ? '500' : '650', options && options.small ? 12 : 13);
        ctx.fillStyle = muted ? theme.colors.muted : theme.colors.text;
        ctx.fillText(fit(label, w - 150 - indent), x + indent, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = theme.colors.text;
        ctx.fillText(fit(valueText, 140), x + w, y);
        ctx.textAlign = 'left';
        if (options && options.noMeter) return rowH;
        const barY = y + (options && options.small ? 9 : 12);
        roundRect(x + indent, barY, w - indent, options && options.small ? 5 : 7, 4, theme.colors.panel2, '');
        const fillWidth = Math.min(w - indent, (w - indent) * value / Math.max(1, max));
        if (fillWidth > 0) roundRect(x + indent, barY, fillWidth, options && options.small ? 5 : 7, 4, color, '');
        return rowH;
      }

      function taskText(x, y, w, label, value) {
        ctx.font = font('650', 13);
        ctx.fillStyle = theme.colors.text;
        ctx.fillText(fit(label, w), x, y);
        ctx.font = font('500', 12);
        ctx.fillStyle = theme.colors.muted;
        ctx.fillText(fit(value, w), x, y + 18);
        return 44;
      }

      ctx.fillStyle = theme.colors.panel;
      ctx.fillRect(0, 0, width, height);
      ctx.font = font('750', 22);
      ctx.fillStyle = theme.colors.text;
      ctx.fillText('Usage breakdown', margin, 42);
      ctx.font = font('500', 13);
      ctx.fillStyle = theme.colors.muted;
      ctx.fillText('PNG export rendered directly from report data', margin, 64);
      const panelY = 78;
      const modelX = margin;
      const sideX = margin + mainWidth + gap;
      roundRect(modelX, panelY, mainWidth, panelHeight, 8, theme.colors.bg, theme.colors.line);
      roundRect(sideX, panelY, sideWidth, surfaceHeight, 8, theme.colors.bg, theme.colors.line);
      roundRect(sideX, panelY + surfaceHeight + gap, sideWidth, taskHeight, 8, theme.colors.bg, theme.colors.line);
      let y = panelY + 34;
      title(modelX + 16, y, 'Models');
      y += 34;
      const totalModelTokens = Math.max(1, models.reduce(function (sum, row) { return sum + row.localTokens; }, 0));
      models.forEach(function (row, index) {
        const color = theme.colors.series[index % theme.colors.series.length];
        const value = row.localTokens || row.turns || row.credits;
        const valueText = modelValueText(row);
        y += barRow(modelX + 16, y, mainWidth - 32, row.model, valueText, value, totalModelTokens, color, { noMeter: !row.localTokens });
        const efforts = (row.reasoningEfforts || []).slice().sort(function (a, b) { return b.breakdown.totalTokens - a.breakdown.totalTokens; });

        if (efforts.length) {
          y -= 4;
          section(modelX + 34, y, 'Thinking effort');
          y += 22;
          efforts.forEach(function (effort) {
            y += barRow(modelX + 16, y, mainWidth - 32, effort.effort, compact(effort.breakdown.totalTokens) + ' tokens · ' + money(effort.costUsd), effort.breakdown.totalTokens, row.localTokens, color, { indent: 18, small: true, muted: true });
          });
        }

        const tiers = serviceTierRows(row, variantsByModel.get(row.model) || []);
        if (tiers.length) {
          y -= 4;
          section(modelX + 34, y, 'Mode mix');
          y += 22;
          const denominator = row.localTokens || tiers.reduce(function (sum, tier) { return sum + tier.credits; }, 0) || 1;
          tiers.forEach(function (tier) {
            const tierValue = tier.totalTokens || tier.credits;
            const tierText = tier.totalTokens ? compact(tier.totalTokens) + ' tokens · ' + money(tier.costUsd) : compact(tier.credits) + ' credits';
            y += barRow(modelX + 16, y, mainWidth - 32, tier.label, tierText, tierValue, denominator, color, { indent: 18, small: true, muted: true });
          });
        }
      });

      function drawOverallRows(titleText, rows, colorOffset) {
        if (!rows.length) return;
        y += 4;
        section(modelX + 16, y, titleText);
        y += 22;
        const total = rows.reduce(function (sum, row) { return sum + row.totalTokens; }, 0) || 1;
        rows.forEach(function (row, index) {
          y += barRow(modelX + 16, y, mainWidth - 32, row.label, compact(row.totalTokens) + ' tokens · ' + money(row.costUsd), row.totalTokens, total, theme.colors.series[(index + colorOffset) % theme.colors.series.length], { small: true });
        });
      }

      drawOverallRows('Overall thinking effort', overall.reasoningRows, 2);
      drawOverallRows('Overall mode mix', overall.modeRows, 4);

      y = panelY + 34;
      title(sideX + 16, y, 'Surfaces');
      y += 34;
      const totalSurfaceTokens = surfaces.reduce(function (sum, row) { return sum + row.textTotalTokens; }, 0) || 1;
      surfaces.forEach(function (row, index) {
        const valueText = (row.textTotalTokens ? compact(row.textTotalTokens) + ' tokens' : trimFixed(row.percent) + '%') + ' - ' + compact(row.turns) + ' turns';
        y += barRow(sideX + 16, y, sideWidth - 32, row.surface, valueText, row.textTotalTokens, totalSurfaceTokens, theme.colors.series[index % theme.colors.series.length], { noMeter: !row.textTotalTokens });
      });
      y = panelY + surfaceHeight + gap + 34;
      title(sideX + 16, y, 'Cloud tasks');
      y += 34;
      if (!tasks) {
        ctx.font = font('500', 13);
        ctx.fillStyle = theme.colors.muted;
        ctx.fillText('No task list response was available', sideX + 16, y);
      } else {
        const pr = tasks.pullRequests || { total: 0, open: 0, merged: 0, closed: 0 };
        const diff = tasks.diffStats || { filesModified: 0, linesAdded: 0, linesRemoved: 0 };
        const archived = tasks.archivedCount == null ? 'not fetched' : compact(tasks.archivedCount) + (tasks.archivedHasMore ? '+' : '');
        y += taskText(sideX + 16, y, sideWidth - 32, 'Current tasks', compact(tasks.currentCount) + ' current - ' + archived + ' archived sample');
        y += taskText(sideX + 16, y, sideWidth - 32, 'Pull requests', compact(pr.total) + ' total, ' + compact(pr.merged) + ' merged, ' + compact(pr.open) + ' open');
        y += taskText(sideX + 16, y, sideWidth - 32, 'Diff sample', '+' + compact(diff.linesAdded) + ' / -' + compact(diff.linesRemoved) + ' across ' + compact(diff.filesModified) + ' files');
        const environments = tasks.currentByEnvironment || [];
        if (!environments.length) {
          y += taskText(sideX + 16, y, sideWidth - 32, 'Environments', 'none');
        } else {
          environments.forEach(function (environment, index) {
            y += taskText(sideX + 16, y, sideWidth - 32, index === 0 ? 'Environments' : '', environment.environment + ' (' + compact(environment.count) + ')');
          });
        }
        const recent = (tasks.recent || []).slice(0, 8);

        if (recent.length) {
          y += 8;
          section(sideX + 16, y, 'Recent tasks');
          y += 24;
          recent.forEach(function (task) {
            y += taskText(sideX + 16, y, sideWidth - 32, task.title, task.environment + ' - ' + task.status + (task.branch ? ' - ' + task.branch : ''));
          });
        }
      }

      return canvas;
    }

    function saveDashboardAsPng(name) {
      const canvas = renderDashboardCanvas();
      canvas.toBlob(function (blob) {
        if (blob) saveBlob(blob, name);
      }, 'image/png');
    }

    async function download(target, kind) {
      const name = target === 'heatmap' ? 'codex-usage-heatmap' : target === 'dashboard' ? 'codex-usage-dashboard' : 'codex-usage-chart';

      if (target === 'dashboard' && kind === 'png') {
        saveDashboardAsPng(name + '.png');

        return;
      }

      const svg = target === 'heatmap' ? serializedHeatmapSvg() : target === 'dashboard' ? serializedDashboardSvg() : serializedChartSvg();

      if (kind === 'svg') {
        saveBlob(new Blob([svg], {type:'image/svg+xml;charset=utf-8'}), name + '.svg');
      } else {
        await saveSvgAsPng(svg, name + '.png');
      }
    }

    async function saveSvgAsPng(svg, name) {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml;charset=utf-8'}));
      img.onload = function () {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 920;
        canvas.height = img.naturalHeight || 330;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = theme.colors.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (blob) saveBlob(blob, name);
        }, 'image/png');
      };
      img.onerror = function () { URL.revokeObjectURL(url); console.error('PNG export failed while loading serialized SVG'); };
      img.src = url;
    }

    function saveBlob(blob, name) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }

    modeEl.addEventListener('change', render);
    chartStyleEl.addEventListener('change', render);
    fromEl.addEventListener('input', render);
    toEl.addEventListener('input', render);
    rawCountsEl.addEventListener('change', render);
    document.querySelectorAll('[data-download-target]').forEach(function (button) {
      button.addEventListener('click', function () {
        download(button.dataset.downloadTarget, button.dataset.downloadKind);
        const menu = button.closest('details');
        if (menu) menu.open = false;
      });
    });
    document.addEventListener('click', function (event) {
      document.querySelectorAll('details.download-menu[open]').forEach(function (menu) {
        if (!menu.contains(event.target)) menu.open = false;
      });
    });
    render();
  </script>
</body>
</html>`
}

function cssVars(theme: UsageTheme): string {
  const cells = theme.colors.cells
  return `:root {
      color-scheme: dark;
      --bg: ${theme.colors.bg};
      --panel: ${theme.colors.panel};
      --panel2: ${theme.colors.panel2};
      --line: ${theme.colors.line};
      --text: ${theme.colors.text};
      --muted: ${theme.colors.muted};
      --accent: ${theme.colors.accent};
      --accent2: ${theme.colors.accent2};
      --warning: ${theme.colors.warning};
      --cell0: ${cells[0]};
      --cell1: ${cells[1]};
      --cell2: ${cells[2]};
      --cell3: ${cells[3]};
      --cell4: ${cells[4]};
      --cell5: ${cells[5]};
      --font-ui: ${theme.fonts.ui};
      --font-code: ${theme.fonts.code};
    }`
}

function stat(label: string, value: number, kind: "number" | "money" = "number"): string {
  const display = kind === "money" ? money(value) : compactNumber(value)
  return `<div class="stat"><strong data-stat-value="${value}" data-stat-kind="${kind}">${escapeHtml(display)}</strong><span>${escapeHtml(label)}</span></div>`
}

function downloadMenu(target: "heatmap" | "chart" | "dashboard"): string {
  return `<details class="download-menu"><summary aria-label="Download" title="Download"><svg class="download-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg></summary><div class="download-panel"><button type="button" data-download-target="${target}" data-download-kind="svg">SVG</button><button type="button" data-download-target="${target}" data-download-kind="png">PNG</button></div></details>`
}
