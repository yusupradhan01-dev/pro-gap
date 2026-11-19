// Chart helpers (Chart.js is loaded globally from js/vendor/chart.umd.js).
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const charts = new Map();

function base() {
  Chart.defaults.font.family = css("--font-body");
  Chart.defaults.font.size = 12;
  Chart.defaults.color = css("--ink-2");
  Chart.defaults.borderColor = css("--rule");
}

function make(canvas, config) {
  base();
  if (charts.has(canvas)) charts.get(canvas).destroy();
  const c = new Chart(canvas, config);
  charts.set(canvas, c);
  return c;
}

export function destroyAll() {
  charts.forEach(c => c.destroy());
  charts.clear();
}

// Farm curve: pro median with middle-50% band, your median (and optional single game line)
export function curveChart(canvas, { pro, you, single, yLabel, singleLabel = "This game", youLabel = "Your median" }) {
  const PRO = css("--pro"), YOU = css("--you");
  const labels = pro.map(p => p.m);
  const ds = [
    { label: "Pros, middle 50%", data: pro.map(p => p.hi), borderWidth: 0, pointRadius: 0, fill: "+1",
      backgroundColor: PRO + "26" },
    { label: "_lo", data: pro.map(p => p.lo), borderWidth: 0, pointRadius: 0, fill: false },
    { label: "Pro median", data: pro.map(p => p.med), borderColor: PRO, borderWidth: 2, pointRadius: 0, tension: .25 },
  ];
  if (you) ds.push({ label: youLabel, data: you.map(p => p.med), borderColor: single ? css("--ink-3") : YOU,
    borderDash: single ? [5, 4] : [], borderWidth: 2, pointRadius: 0, tension: .25 });
  if (single) ds.push({ label: singleLabel, data: single.slice(0, labels.length), borderColor: YOU, borderWidth: 2.5,
    pointRadius: 0, tension: .25 });
  return make(canvas, {
    type: "line", data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { filter: i => !i.text.startsWith("_"), boxWidth: 14, boxHeight: 2 } },
        tooltip: { filter: i => !i.dataset.label.startsWith("_") } },
      scales: { x: { title: { display: true, text: "Minute" }, ticks: { maxTicksLimit: 10 } },
        y: { title: { display: true, text: yLabel }, beginAtZero: true } },
    },
  });
}

// Power spikes: one row per spike, pro median dot, on-time window bar, your median diamond
export function spikeChart(canvas, spikes) {
  const PRO = css("--pro"), YOU = css("--you");
  const labels = spikes.map(s => s.name);
  return make(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { type: "bar", label: "Pro on-time window", data: spikes.map(s => [s.pro, s.cut]), backgroundColor: PRO + "40",
          borderRadius: 4, barThickness: 10 },
        { type: "scatter", label: "Pro median", data: spikes.map((s, i) => ({ x: s.pro, y: labels[i] })), backgroundColor: PRO,
          pointRadius: 6 },
        { type: "scatter", label: "You", data: spikes.map((s, i) => ({ x: s.you, y: labels[i] })), backgroundColor: YOU,
          pointStyle: "rectRot", pointRadius: 8 },
      ],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${Array.isArray(c.raw) ? c.raw.map(v => v.toFixed(1)).join("–") : (c.raw.x ?? c.raw).toFixed(1)} min` } } },
      scales: { x: { title: { display: true, text: "Game minute" }, beginAtZero: true }, y: { grid: { display: false } } },
    },
  });
}

export function lineChart(canvas, { labels, series, yLabel }) {
  return make(canvas, {
    type: "line",
    data: { labels, datasets: series.map(s => ({ label: s.label, data: s.data, borderColor: s.color || css("--you"),
      borderWidth: 2, pointRadius: 0, tension: .3, spanGaps: true })) },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: series.length > 1 } },
      scales: { x: { ticks: { maxTicksLimit: 8 }, title: { display: true, text: "Game number, oldest to newest" } },
        y: { title: { display: !!yLabel, text: yLabel } } } },
  });
}

export function barChart(canvas, { labels, you, pro, xLabel }) {
  return make(canvas, {
    type: "bar",
    data: { labels, datasets: [
      { label: "Pros", data: pro, backgroundColor: css("--pro"), borderRadius: 3 },
      { label: "You", data: you, backgroundColor: css("--you"), borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { title: { display: !!xLabel, text: xLabel } } } },
  });
}

// Ward heatmap on a plain map grid; Dire wards are flipped so both sides read from Radiant's view
export function wardMap(canvas, wards, title) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 280;
  canvas.width = size * dpr; canvas.height = size * dpr;
  ctx.scale(dpr, dpr);
  const N = 64, grid = new Float32Array(N * N);
  wards.filter(w => w.kind === "observer" && w.x != null).forEach(w => {
    let x = w.x, y = w.y;
    if (!w.radiant) { x = 256 - x; y = 256 - y; }
    const gx = Math.floor(((x - 64) / 128) * N), gy = Math.floor(((y - 64) / 128) * N);
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      const ix = gx + dx, iy = gy + dy;
      if (ix >= 0 && iy >= 0 && ix < N && iy < N) grid[iy * N + ix] += Math.exp(-(dx * dx + dy * dy) / 4);
    }
  });
  const max = Math.max(...grid, 1e-9);
  ctx.fillStyle = css("--map"); ctx.fillRect(0, 0, size, size);
  const cell = size / N;
  const hot = css("--you");
  for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const v = grid[iy * N + ix] / max;
    if (v < .04) continue;
    ctx.fillStyle = hot; ctx.globalAlpha = Math.min(1, Math.sqrt(v));
    ctx.fillRect(ix * cell, size - (iy + 1) * cell, cell + .5, cell + .5);
  }
  ctx.globalAlpha = 1;
  // rough guides: river, lanes, bases
  ctx.strokeStyle = css("--ink-3"); ctx.lineWidth = 1; ctx.globalAlpha = .45;
  const P = v => ((v - 64) / 128) * size;
  const line = pts => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(P(x), size - P(y)) : ctx.moveTo(P(x), size - P(y)))); ctx.stroke(); };
  line([[70, 75], [70, 186], [186, 186]]); line([[75, 70], [186, 70], [186, 186]]); line([[72, 72], [184, 184]]);
  ctx.strokeStyle = css("--pro"); line([[64, 192], [192, 64]]);
  ctx.globalAlpha = 1; ctx.fillStyle = css("--ink-2"); ctx.font = `12px ${css("--font-body")}`;
  ctx.fillText("Radiant", 6, size - 6); ctx.fillText("Dire", size - 34, 14);
  canvas.setAttribute("aria-label", title);
}
