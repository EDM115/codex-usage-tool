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
    h2 { margin: 0 0 12px; font-size: 16px; letter-spacing: 0; }
    h3 { margin: 0; font-size: 13px; letter-spacing: 0; color: var(--muted); font-weight: 600; }
    p { margin: 0; color: var(--muted); }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button, select, input {
      background: var(--panel2);
      border: 1px solid var(--line);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    button { cursor: pointer; }
    button:hover { border-color: var(--accent2); }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .stats { display: grid; grid-template-columns: repeat(6, minmax(135px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin-bottom: 22px; }
    .stat { background: var(--panel); padding: 16px; min-width: 0; }
    .stat strong { display: block; font-size: 22px; margin-bottom: 4px; white-space: nowrap; }
    .stat span { color: var(--muted); text-transform: lowercase; }
    .section { border: 1px solid var(--line); background: var(--panel); padding: 18px; margin-bottom: 18px; border-radius: 8px; overflow: auto; }
    .section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 18px; margin-bottom: 12px; }
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
    .breakdown-grid { display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: 14px; min-width: 900px; }
    .breakdown-panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--bg); }
    .rows { display: grid; gap: 10px; margin-top: 12px; }
    .row { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 12px; align-items: center; }
    .row-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-value { color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .meter { grid-column: 1 / -1; height: 7px; border-radius: 999px; background: var(--panel2); overflow: hidden; }
    .meter span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .tooltip {
      position: fixed;
      z-index: 10;
      pointer-events: none;
      background: var(--panel2);
      border: 1px solid var(--line);
      color: var(--text);
      padding: 9px 10px;
      border-radius: 6px;
      max-width: 320px;
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
        <button id="downloadSvg">SVG</button>
        <button id="downloadPng">PNG</button>
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
        <h2>Token Activity</h2>
        <h3>${escapeHtml(dataset.theme.name)} theme</h3>
      </div>
      <div id="heatmap" class="heatmap" aria-label="token heatmap"></div>
      <div class="legend">Less <span class="cell" data-level="0"></span><span class="cell" data-level="1"></span><span class="cell" data-level="2"></span><span class="cell" data-level="3"></span><span class="cell" data-level="4"></span><span class="cell" data-level="5"></span> More</div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Chart</h2>
        <h3>Hover for token, local, backend-only, and cost detail</h3>
      </div>
      <svg id="chart" class="chart" role="img" aria-label="Codex token usage chart"></svg>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Dashboard Analytics</h2>
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
      chart.querySelectorAll('.hit').forEach(function (el) {
        el.addEventListener('mousemove', showTip);
        el.addEventListener('mouseleave', hideTip);
      });
    }
    function renderAnalytics() {
      const analytics = dataset.analytics;
      if (!analytics || (analytics.byModel.length === 0 && analytics.bySurface.length === 0 && analytics.bySource.length === 0)) {
        analyticsBreakdown.innerHTML = '<div class="breakdown-panel"><h3>Dashboard data unavailable</h3><div class="rows"><p>' + escapeText(analytics && analytics.error ? analytics.error : 'No wham analytics response was available for this run.') + '</p></div></div>';
        return;
      }
      analyticsBreakdown.innerHTML = breakdownPanel('By model', analytics.byModel, 'model', 'credits', function (row) { return compact(row.credits) + ' credits' + (row.turns ? ' - ' + compact(row.turns) + ' turns' : ''); }) + breakdownPanel('By surface', analytics.bySurface, 'surface', 'credits', function (row) { return (row.credits ? compact(row.credits) + ' credits' : trimFixed(row.percent) + '%') + (row.turns ? ' - ' + compact(row.turns) + ' turns' : ''); }) + breakdownPanel('By source', analytics.bySource, 'source', 'credits', function (row) { return compact(row.credits) + ' credits - ' + compact(row.turns) + ' turns'; });
    }
    function breakdownPanel(title, rows, labelField, valueField, valueText) {
      const max = Math.max(1, ...rows.map(function (row) { return row[valueField] || row.percent || 0; }));
      return '<div class="breakdown-panel"><h3>' + escapeText(title) + '</h3><div class="rows">' + rows.map(function (row, index) {
        const value = row[valueField] || row.percent || 0;
        const color = theme.colors.series[index % theme.colors.series.length];
        return '<div class="row"><div class="row-label" title="'+escapeText(row[labelField])+'">'+escapeText(row[labelField])+'</div><div class="row-value">'+escapeText(valueText(row))+'</div><div class="meter"><span style="width:'+Math.max(2, value / max * 100)+'%; background:'+color+'"></span></div></div>';
      }).join('') + '</div></div>';
    }
    function showTip(event) {
      tooltip.textContent = event.currentTarget.dataset.tip;
      tooltip.style.display = 'block';
      tooltip.style.left = Math.max(12, Math.min(window.innerWidth - 340, event.clientX + 14)) + 'px';
      tooltip.style.top = Math.max(12, Math.min(window.innerHeight - 180, event.clientY + 14)) + 'px';
    }
    function hideTip() { tooltip.style.display = 'none'; }
    function render() { renderHeatmap(); renderChart(); renderAnalytics(); }
    function chartCss() {
      return '.grid{stroke:'+theme.colors.line+'}.axis{fill:'+theme.colors.muted+';font-size:11px}.bar{fill:'+theme.colors.accent+'}.line{stroke:'+theme.colors.accent+';fill:none;stroke-width:3}.area{fill:'+theme.colors.accent+';opacity:.22}.chart-dot{fill:'+theme.colors.accent+'}text{font-family:'+theme.fonts.ui+'}svg{background:'+theme.colors.bg+';color:'+theme.colors.text+'}';
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
    async function download(kind) {
      const svg = serializedChartSvg();
      if (kind === 'svg') {
        saveBlob(new Blob([svg], {type:'image/svg+xml;charset=utf-8'}), 'codex-usage-chart.svg');
      } else {
        const img = new Image();
        const url = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml;charset=utf-8'}));
        img.onload = function () {
          const canvas = document.createElement('canvas');
          canvas.width = 920; canvas.height = 330;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = theme.colors.bg;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (blob) saveBlob(blob, 'codex-usage-chart.png');
          }, 'image/png');
        };
        img.onerror = function () { URL.revokeObjectURL(url); console.error('PNG export failed while loading serialized SVG'); };
        img.src = url;
      }
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
    document.getElementById('downloadSvg').addEventListener('click', function () { download('svg'); });
    document.getElementById('downloadPng').addEventListener('click', function () { download('png'); });
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