import type { UsageDataset, UsageTheme } from "./types";
import { compactNumber, escapeHtml, money } from "./util";

export function renderReportHtml(dataset: UsageDataset): string {
  const dataJson = JSON.stringify(dataset).replaceAll("</", "<\\/");
  const theme = dataset.theme;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Usage Report</title>
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
    .download-menu summary { list-style: none; user-select: none; }
    .download-menu summary::-webkit-details-marker { display: none; }
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
    .breakdown-grid { display: grid; grid-template-columns: repeat(3, minmax(240px, 1fr)); gap: 14px; min-width: 900px; }
    .breakdown-panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--bg); }
    .rows { display: grid; gap: 10px; margin-top: 12px; }
    .row { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 12px; align-items: center; }
    .row[data-tip] { cursor: help; }
    .row-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-value { color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .meter { grid-column: 1 / -1; height: 7px; border-radius: 999px; background: var(--panel2); overflow: hidden; }
    .meter span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .task-list { display: grid; gap: 9px; margin-top: 12px; }
    .task-item { border-top: 1px solid var(--line); padding-top: 9px; display: grid; gap: 2px; }
    .task-item:first-child { border-top: 0; padding-top: 0; }
    .task-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
      <div>
        <h1>Codex Usage Report</h1>
        <p>Generated ${escapeHtml(dataset.generatedAt)}. Timezone: ${escapeHtml(dataset.timezone)}.</p>
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
      </div>
    </header>

    <section class="stats">
      ${stat("lifetime tokens", compactNumber(dataset.summary.lifetimeTokens))}
      ${stat("peak day", compactNumber(dataset.summary.peakDailyTokens))}
      ${stat("local enriched tokens", compactNumber(dataset.summary.localKnownTokens))}
      ${stat("backend-only tokens", compactNumber(dataset.summary.unattributedTokens))}
      ${stat("estimated API cost", money(dataset.summary.estimatedCostUsd))}
      ${stat("dashboard turns", compactNumber(dataset.analytics?.totals?.turns ?? 0))}
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-title">
          <h2>Daily Intensity</h2>
          <p class="section-copy">Hover a day to inspect total tokens, local attribution, backend-only estimate, and cost.</p>
        </div>
        <div class="section-actions">${downloadMenu("heatmap")}</div>
      </div>
      <div id="heatmap" class="heatmap" aria-label="Daily token intensity heatmap"></div>
      <div class="legend">Less <span class="cell" data-level="0"></span><span class="cell" data-level="1"></span><span class="cell" data-level="2"></span><span class="cell" data-level="3"></span><span class="cell" data-level="4"></span><span class="cell" data-level="5"></span> More</div>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-title">
          <h2>Usage Trend</h2>
          <p class="section-copy">Switch between daily, weekly, and cumulative views. Hover bars or points for token and cost detail.</p>
        </div>
        <div class="section-actions">${downloadMenu("chart")}</div>
      </div>
      <svg id="chart" class="chart" role="img" aria-label="Codex token usage chart"></svg>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="section-title">
          <h2>Cloud Dashboard Breakdown</h2>
          <p class="section-copy">Model, surface, and task metadata from the WHAM dashboard APIs. Bars use tokens or turns when credits are zero.</p>
        </div>
        <h3>${escapeHtml(dataset.analytics?.error ? "best effort" : dataset.analytics?.fetched ? "from wham APIs" : "saved or unavailable")}</h3>
      </div>
      <div id="analyticsBreakdown" class="breakdown-grid"></div>
    </section>

    <section class="section notes">
      <div><strong>Data sources:</strong> ${escapeHtml(dataset.sourceMode)}. Profile API ${dataset.profile?.endpoint ? `from ${escapeHtml(dataset.profile.endpoint)}` : "not used"}. Analytics ${dataset.analytics?.fetched ? "requested from wham dashboard APIs" : "not fetched live"}.</div>
      <div><strong>Local enrichment:</strong> ${dataset.local.tokenEvents} token events from ${dataset.local.rolloutFiles} rollout files, ${dataset.local.sqliteThreads} SQLite thread rows across ${dataset.local.sqliteDatabases} DB(s), ${dataset.codexHomes.length} .codex source(s).</div>
      <div><strong>Theme:</strong> ${escapeHtml(dataset.theme.name)} from ${escapeHtml(dataset.theme.source)}.</div>
      <div><strong>Pricing:</strong> ${escapeHtml(dataset.pricing.source)} using ${escapeHtml(dataset.pricing.estimateModel)} for unattributed backend-only tokens.</div>
      ${dataset.profile?.error ? `<div class="warning"><strong>Profile API:</strong> ${escapeHtml(dataset.profile.error)}</div>` : ""}
      ${dataset.analytics?.error ? `<div class="warning"><strong>Analytics API:</strong> ${escapeHtml(dataset.analytics.error)}</div>` : ""}
      ${dataset.pricing.warning ? `<div class="warning"><strong>Pricing:</strong> ${escapeHtml(dataset.pricing.warning)}</div>` : ""}
    </section>
  </main>
  <div id="tooltip" class="tooltip"></div>
  <script id="usage-data" type="application/json">${dataJson}</script>
  <script>
    const dataset = JSON.parse(document.getElementById('usage-data').textContent);
    const modeEl = document.getElementById('mode');
    const chartStyleEl = document.getElementById('chartStyle');
    const fromEl = document.getElementById('from');
    const toEl = document.getElementById('to');
    const tooltip = document.getElementById('tooltip');
    const heatmap = document.getElementById('heatmap');
    const chart = document.getElementById('chart');
    const analyticsBreakdown = document.getElementById('analyticsBreakdown');
    const theme = dataset.theme;

    function trimFixed(value) { return value.toFixed(1).replace(/\\.0$/, ''); }
    function compact(value) {
      const abs = Math.abs(value || 0);
      if (abs >= 1000000000) return trimFixed(value / 1000000000) + 'B';
      if (abs >= 1000000) return trimFixed(value / 1000000) + 'M';
      if (abs >= 1000) return trimFixed(value / 1000) + 'K';
      return String(Math.round(value || 0));
    }
    function money(value) {
      if (!Number.isFinite(value)) return '$0.00';
      if (Math.abs(value) < 0.01 && value !== 0) return '$' + value.toFixed(4);
      return '$' + value.toFixed(2);
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
          for (const day of chunk) byWeek.set(day.date, total);
        }
        return daily.map(function (day) { return Object.assign({}, day, { displayValue: byWeek.get(day.date) || 0 }); });
      }
      return daily.map(function (day) {
        cumulative += day.totalTokens;
        return Object.assign({}, day, { displayValue: modeEl.value === 'cumulative' ? cumulative : day.totalTokens });
      });
    }
    function tipFor(day) {
      return day.date + '\\nTotal: ' + compact(day.displayValue) + ' tokens\\nLocal: ' + compact(day.localTokens.totalTokens) + '\\nBackend-only: ' + compact(day.unattributedTokens) + '\\nCost: ' + money(day.estimatedCostUsd);
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
      if (!analytics || (analytics.byModel.length === 0 && analytics.bySurface.length === 0 && !analytics.tasks)) {
        analyticsBreakdown.innerHTML = '<div class="breakdown-panel"><h3>Dashboard data unavailable</h3><div class="rows"><p>' + escapeText(analytics && analytics.error ? analytics.error : 'No wham analytics response was available for this run.') + '</p></div></div>';
        return;
      }
      analyticsBreakdown.innerHTML = modelPanel(analytics.byModel || []) + surfacePanel(analytics.bySurface || []) + taskPanel(analytics.tasks);
      analyticsBreakdown.querySelectorAll('[data-tip]').forEach(bindTip);
    }
    function modelTokenRows() {
      const map = new Map();
      for (const day of dataset.daily) {
        for (const model of Object.keys(day.models || {})) {
          const item = map.get(model) || { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
          const usage = day.models[model];
          item.totalTokens += usage.totalTokens || 0;
          item.inputTokens += usage.inputTokens || 0;
          item.cachedInputTokens += usage.cachedInputTokens || 0;
          item.outputTokens += usage.outputTokens || 0;
          map.set(model, item);
        }
      }
      return map;
    }
    function estimatedCostForTokens(tokens) {
      const total = dataset.analytics && dataset.analytics.totals ? dataset.analytics.totals.textTotalTokens : 0;
      if (!total || !dataset.summary.estimatedCostUsd) return 0;
      return tokens / total * dataset.summary.estimatedCostUsd;
    }
    function modelPanel(rows) {
      const local = modelTokenRows();
      const merged = rows.map(function (row) { return Object.assign({}, row, { localTokens: (local.get(row.model) || {}).totalTokens || 0 }); });
      const max = Math.max(1, ...merged.map(function (row) { return row.localTokens || row.turns || row.credits || 0; }));
      return '<div class="breakdown-panel"><h3>Models</h3><div class="rows">' + merged.map(function (row, index) {
        const value = row.localTokens || row.turns || row.credits || 0;
        const color = theme.colors.series[index % theme.colors.series.length];
        const text = (row.localTokens ? compact(row.localTokens) + ' tokens - ' : '') + compact(row.turns) + ' turns';
        const tip = row.model + '\\nDashboard turns: ' + compact(row.turns) + '\\nThreads: ' + compact(row.threads) + '\\nCredits: ' + compact(row.credits) + '\\nLocal tokens: ' + compact(row.localTokens) + '\\nEstimated local cost share: ' + money(estimatedCostForTokens(row.localTokens));
        return '<div class="row" data-tip="'+escapeText(tip)+'"><div class="row-label" title="'+escapeText(row.model)+'">'+escapeText(row.model)+'</div><div class="row-value">'+escapeText(text)+'</div><div class="meter"><span style="width:'+Math.max(2, value / max * 100)+'%; background:'+color+'"></span></div></div>';
      }).join('') + '</div></div>';
    }
    function surfacePanel(rows) {
      const max = Math.max(1, ...rows.map(function (row) { return row.textTotalTokens || row.turns || row.credits || row.percent || 0; }));
      return '<div class="breakdown-panel"><h3>Surfaces</h3><div class="rows">' + rows.map(function (row, index) {
        const value = row.textTotalTokens || row.turns || row.credits || row.percent || 0;
        const color = theme.colors.series[index % theme.colors.series.length];
        const text = (row.textTotalTokens ? compact(row.textTotalTokens) + ' tokens' : trimFixed(row.percent) + '%') + ' - ' + compact(row.turns) + ' turns';
        const tip = row.surface + '\\nTokens: ' + compact(row.textTotalTokens) + '\\nInput: ' + compact(row.inputTokens) + '\\nCached input: ' + compact(row.cachedInputTokens) + '\\nOutput: ' + compact(row.outputTokens) + '\\nTurns: ' + compact(row.turns) + '\\nThreads: ' + compact(row.threads) + '\\nCredits: ' + compact(row.credits) + '\\nEstimated cost share: ' + money(estimatedCostForTokens(row.textTotalTokens));
        return '<div class="row" data-tip="'+escapeText(tip)+'"><div class="row-label" title="'+escapeText(row.surface)+'">'+escapeText(row.surface)+'</div><div class="row-value">'+escapeText(text)+'</div><div class="meter"><span style="width:'+Math.max(2, value / max * 100)+'%; background:'+color+'"></span></div></div>';
      }).join('') + '</div></div>';
    }
    function taskPanel(tasks) {
      if (!tasks) return '<div class="breakdown-panel"><h3>Cloud tasks</h3><div class="rows"><p>No task list response was available.</p></div></div>';
      const archived = tasks.archivedCount == null ? '' : ' - ' + compact(tasks.archivedCount) + ' archived sample' + (tasks.archivedHasMore ? '+' : '');
      const pr = tasks.pullRequests || { total: 0, open: 0, merged: 0, closed: 0 };
      const diff = tasks.diffStats || { filesModified: 0, linesAdded: 0, linesRemoved: 0 };
      const envs = (tasks.currentByEnvironment || []).map(function (row) { return row.environment + ' (' + row.count + ')'; }).join(', ') || 'none';
      const recent = (tasks.recent || []).map(function (task) {
        const meta = task.environment + ' - ' + task.status + (task.branch ? ' - ' + task.branch : '') + (task.pullRequests ? ' - ' + task.pullRequests + ' PR' : '');
        return '<div class="task-item" data-tip="'+escapeText(task.title + '\\n' + meta)+'"><div class="task-title">'+escapeText(task.title)+'</div><div class="task-meta">'+escapeText(meta)+'</div></div>';
      }).join('');
      return '<div class="breakdown-panel"><h3>Cloud tasks</h3><div class="rows"><div class="row" data-tip="Current task endpoint defaults to current tasks; limit is capped at 20. Archived tasks use task_filter=archived and may paginate."><div class="row-label">Current tasks</div><div class="row-value">'+compact(tasks.currentCount)+archived+'</div><div class="meter"><span style="width:100%; background:'+theme.colors.accent+'"></span></div></div><div class="task-meta">Environments: '+escapeText(envs)+'</div><div class="task-meta">PRs: '+compact(pr.total)+' total, '+compact(pr.merged)+' merged, '+compact(pr.open)+' open. Diff: +'+compact(diff.linesAdded)+' / -'+compact(diff.linesRemoved)+' across '+compact(diff.filesModified)+' files.</div></div><div class="task-list">'+recent+'</div></div>';
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
    function hideTip() { tooltip.style.display = 'none'; }
    function render() { renderHeatmap(); renderChart(); renderAnalytics(); }
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
    async function download(target, kind) {
      const svg = target === 'heatmap' ? serializedHeatmapSvg() : serializedChartSvg();
      const name = target === 'heatmap' ? 'codex-usage-heatmap' : 'codex-usage-chart';
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
</html>`;
}

function cssVars(theme: UsageTheme): string {
  const cells = theme.colors.cells;
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
    }`;
}

function stat(label: string, value: string): string {
  return `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function downloadMenu(target: "heatmap" | "chart"): string {
  return `<details class="download-menu"><summary>Download</summary><div class="download-panel"><button type="button" data-download-target="${target}" data-download-kind="svg">SVG</button><button type="button" data-download-target="${target}" data-download-kind="png">PNG</button></div></details>`;
}