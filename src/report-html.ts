import type { UsageDataset } from "./types";
import { compactNumber, escapeHtml, money } from "./util";

export function renderReportHtml(dataset: UsageDataset): string {
  const dataJson = JSON.stringify(dataset).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Usage Report</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #050811;
      --panel: #0b1019;
      --line: #202735;
      --text: #f7f1e8;
      --muted: #aaaab2;
      --hot: #ffb15f;
      --hot2: #c9823a;
      --cell0: #20252e;
      --cell1: #3b2f28;
      --cell2: #5a3b26;
      --cell3: #8a5a2c;
      --cell4: #c9823a;
      --cell5: #ffb15f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, Segoe UI, sans-serif;
    }
    main { max-width: 1160px; margin: 0 auto; padding: 28px 24px 42px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 16px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button, select, input {
      background: #121a26;
      border: 1px solid var(--line);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    button { cursor: pointer; }
    button:hover { border-color: var(--hot2); }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(140px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin-bottom: 22px; }
    .stat { background: var(--panel); padding: 16px; min-width: 0; }
    .stat strong { display: block; font-size: 24px; margin-bottom: 4px; }
    .stat span { color: var(--muted); text-transform: lowercase; }
    .section { border: 1px solid var(--line); background: var(--panel); padding: 18px; margin-bottom: 18px; border-radius: 8px; overflow: auto; }
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
    .grid { stroke: #222832; }
    .axis { fill: var(--muted); font-size: 11px; }
    .bar { fill: var(--hot); }
    .line { stroke: var(--hot); fill: none; stroke-width: 3; }
    .area { fill: var(--hot); opacity: 0.22; }
    .tooltip {
      position: fixed;
      z-index: 10;
      pointer-events: none;
      background: #111824;
      border: 1px solid #30394a;
      color: var(--text);
      padding: 9px 10px;
      border-radius: 6px;
      max-width: 280px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
      display: none;
      white-space: pre-line;
    }
    .notes { color: var(--muted); display: grid; gap: 6px; }
    .warning { color: #ffd49b; }
    @media (max-width: 840px) {
      header { display: block; }
      .toolbar { justify-content: flex-start; margin-top: 14px; }
      .stats { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
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
        <select id="mode">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="cumulative">Cumulative</option>
        </select>
        <select id="chartStyle">
          <option value="auto">Auto chart</option>
          <option value="bar">Bar</option>
          <option value="area">Line/area</option>
        </select>
        <input id="from" type="date" value="${escapeHtml(dataset.dateRange.from ?? dataset.daily[0]?.date ?? "")}">
        <input id="to" type="date" value="${escapeHtml(dataset.dateRange.to ?? dataset.daily.at(-1)?.date ?? "")}">
        <button id="downloadSvg">SVG</button>
        <button id="downloadPng">PNG</button>
      </div>
    </header>

    <section class="stats">
      <div class="stat"><strong>${compactNumber(dataset.summary.lifetimeTokens)}</strong><span>lifetime tokens</span></div>
      <div class="stat"><strong>${compactNumber(dataset.summary.peakDailyTokens)}</strong><span>peak day</span></div>
      <div class="stat"><strong>${compactNumber(dataset.summary.localKnownTokens)}</strong><span>local enriched tokens</span></div>
      <div class="stat"><strong>${compactNumber(dataset.summary.unattributedTokens)}</strong><span>backend-only tokens</span></div>
      <div class="stat"><strong>${money(dataset.summary.estimatedCostUsd)}</strong><span>estimated API cost</span></div>
    </section>

    <section class="section">
      <h2>Token Activity</h2>
      <div id="heatmap" class="heatmap" aria-label="token heatmap"></div>
      <div class="legend">Less <span class="cell" data-level="0"></span><span class="cell" data-level="1"></span><span class="cell" data-level="2"></span><span class="cell" data-level="3"></span><span class="cell" data-level="4"></span><span class="cell" data-level="5"></span> More</div>
    </section>

    <section class="section">
      <h2>Chart</h2>
      <svg id="chart" class="chart" role="img"></svg>
    </section>

    <section class="section notes">
      <div><strong>Data sources:</strong> ${escapeHtml(dataset.sourceMode)}. Profile API ${dataset.profile?.endpoint ? `from ${escapeHtml(dataset.profile.endpoint)}` : "not used"}.</div>
      <div><strong>Local enrichment:</strong> ${dataset.local.tokenEvents} token events from ${dataset.local.rolloutFiles} rollout files, ${dataset.local.sqliteThreads} SQLite thread rows across ${dataset.local.sqliteDatabases} DB(s), ${dataset.codexHomes.length} .codex source(s).</div>
      <div><strong>Pricing:</strong> ${escapeHtml(dataset.pricing.source)} using ${escapeHtml(dataset.pricing.estimateModel)} for unattributed backend-only tokens.</div>
      ${dataset.profile?.error ? `<div class="warning"><strong>Profile API:</strong> ${escapeHtml(dataset.profile.error)}</div>` : ""}
      ${dataset.pricing.warning ? `<div class="warning"><strong>Pricing:</strong> ${escapeHtml(dataset.pricing.warning)}</div>` : ""}
    </section>
  </main>
  <div id="tooltip" class="tooltip"></div>
  <script id="usage-data" type="application/json">${dataJson}</script>
  <script>
    const dataset = JSON.parse(document.getElementById('usage-data').textContent);
    const colors = ['0','1','2','3','4','5'];
    const modeEl = document.getElementById('mode');
    const chartStyleEl = document.getElementById('chartStyle');
    const fromEl = document.getElementById('from');
    const toEl = document.getElementById('to');
    const tooltip = document.getElementById('tooltip');
    const heatmap = document.getElementById('heatmap');
    const chart = document.getElementById('chart');

    function trimFixed(value) { return value.toFixed(1).replace(/\.0$/, ''); }
    function compact(value) {
      const abs = Math.abs(value);
      if (abs >= 1000000000) return trimFixed(value / 1000000000) + 'B';
      if (abs >= 1000000) return trimFixed(value / 1000000) + 'M';
      if (abs >= 1000) return trimFixed(value / 1000) + 'K';
      return String(Math.round(value));
    }
    function money(value) {
      if (!Number.isFinite(value)) return '$0.00';
      if (Math.abs(value) < 0.01 && value !== 0) return '$' + value.toFixed(4);
      return '$' + value.toFixed(2);
    }

    function filteredDaily() {
      return dataset.daily.filter(day => (!fromEl.value || day.date >= fromEl.value) && (!toEl.value || day.date <= toEl.value));
    }
    function values() {
      const daily = filteredDaily();
      let cumulative = 0;
      if (modeEl.value === 'weekly') {
        const byWeek = new Map();
        for (let i = 0; i < daily.length; i += 7) {
          const chunk = daily.slice(i, i + 7);
          const total = chunk.reduce((sum, day) => sum + day.totalTokens, 0);
          for (const day of chunk) byWeek.set(day.date, total);
        }
        return daily.map(day => ({...day, displayValue: byWeek.get(day.date) || 0}));
      }
      return daily.map(day => {
        cumulative += day.totalTokens;
        return {...day, displayValue: modeEl.value === 'cumulative' ? cumulative : day.totalTokens};
      });
    }
    function renderHeatmap() {
      const days = values();
      const max = Math.max(1, ...days.map(day => day.displayValue));
      heatmap.innerHTML = '';
      for (const day of days) {
        const level = day.displayValue <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(day.displayValue / max * 5)));
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.level = String(level);
        cell.dataset.tip = day.date + '\\nTotal: ' + compact(day.displayValue) + ' tokens\\nLocal: ' + compact(day.localTokens.totalTokens) + '\\nBackend-only: ' + compact(day.unattributedTokens) + '\\nCost: ' + money(day.estimatedCostUsd);
        cell.addEventListener('mousemove', showTip);
        cell.addEventListener('mouseleave', hideTip);
        heatmap.appendChild(cell);
      }
    }
    function renderChart() {
      const days = values();
      const width = 920, height = 330, left = 70, right = 28, top = 30, bottom = 42;
      const chartW = width - left - right, chartH = height - top - bottom;
      const max = Math.max(1, ...days.map(day => day.displayValue));
      chart.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      chart.innerHTML = '';
      for (const frac of [0, .25, .5, .75, 1]) {
        const y = top + chartH - frac * chartH;
        chart.insertAdjacentHTML('beforeend', '<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'" class="grid"/><text x="'+(left-10)+'" y="'+(y+4)+'" text-anchor="end" class="axis">'+compact(max*frac)+'</text>');
      }
      const style = chartStyleEl.value === 'auto' ? (modeEl.value === 'daily' ? 'bar' : 'area') : chartStyleEl.value;
      if (style === 'bar') {
        const step = chartW / Math.max(1, days.length);
        days.forEach((day, i) => {
          const h = day.displayValue / max * chartH;
          const x = left + i * step;
          const y = top + chartH - h;
          chart.insertAdjacentHTML('beforeend', '<rect class="bar" x="'+x+'" y="'+y+'" width="'+Math.max(2, step-2)+'" height="'+h+'"><title>'+day.date+': '+compact(day.displayValue)+'</title></rect>');
        });
      } else {
        const pts = days.map((day, i) => {
          const x = left + (days.length <= 1 ? 0 : i / (days.length - 1) * chartW);
          const y = top + chartH - day.displayValue / max * chartH;
          return {x,y,day};
        });
        if (pts.length) {
          const line = pts.map(p => p.x + ',' + p.y).join(' ');
          const area = pts[0].x + ',' + (top+chartH) + ' ' + line + ' ' + pts[pts.length-1].x + ',' + (top+chartH);
          chart.insertAdjacentHTML('beforeend', '<polygon class="area" points="'+area+'"/><polyline class="line" points="'+line+'"/>');
        }
      }
    }
    function showTip(event) {
      tooltip.textContent = event.currentTarget.dataset.tip;
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(window.innerWidth - 300, event.clientX + 14) + 'px';
      tooltip.style.top = (event.clientY + 14) + 'px';
    }
    function hideTip() { tooltip.style.display = 'none'; }
    function render() { renderHeatmap(); renderChart(); }
    async function download(kind) {
      const svg = chart.outerHTML;
      if (kind === 'svg') {
        const blob = new Blob([svg], {type:'image/svg+xml'});
        saveBlob(blob, 'codex-usage-chart.svg');
      } else {
        const img = new Image();
        const url = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'}));
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 920; canvas.height = 330;
          canvas.getContext('2d').drawImage(img, 0, 0);
          canvas.toBlob(blob => saveBlob(blob, 'codex-usage-chart.png'));
          URL.revokeObjectURL(url);
        };
        img.src = url;
      }
    }
    function saveBlob(blob, name) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    modeEl.addEventListener('change', render);
    chartStyleEl.addEventListener('change', render);
    fromEl.addEventListener('input', render);
    toEl.addEventListener('input', render);
    document.getElementById('downloadSvg').addEventListener('click', () => download('svg'));
    document.getElementById('downloadPng').addEventListener('click', () => download('png'));
    render();
  </script>
</body>
</html>`;
}
