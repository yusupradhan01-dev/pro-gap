import { OpenDota, DemoSource, isParsed } from "./api.js";
import * as A from "./analysis.js";
import * as C from "./charts.js";

const PATCHES = { "7.41": "2026-03-24", "7.42": "2026-11-18" };
const PATCH = "7.42";
const MIN_PRO_ON_PATCH = 10;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ts = d => Date.parse(d + "T00:00:00Z") / 1000;
const posLabel = p => `${A.POS_SHORT[p]} (pos ${p})`;

const state = { rows: [], you: [], bench: {}, meta: {}, filters: { pos: null, hero: "all", result: "all" }, cancel: false };

// ------------------------------------------------------------------ start
function parseId(raw) {
  const s = raw.trim();
  const m = s.match(/(?:players|profiles|player)\/(\d+)/) || s.match(/^(\d+)$/);
  if (!m) return null;
  let id = BigInt(m[1]);
  if (id > 76561197960265728n) id -= 76561197960265728n; // Steam64 -> Steam32
  return Number(id);
}

function showView(id) {
  ["start", "loading", "results"].forEach(v => { $("#" + v).hidden = v !== id; });
  window.scrollTo(0, 0);
}

function initStart() {
  try { $("#apiKey").value = localStorage.getItem("od_key") || ""; } catch {}
  $("#startForm").addEventListener("submit", e => {
    e.preventDefault();
    const id = parseId($("#steamId").value);
    const err = $("#startError");
    if (!id) {
      err.textContent = "Enter your Steam32 ID (the number in your OpenDota or Dotabuff link), your Steam64 ID, or that profile link. Custom Steam URLs can't be read.";
      err.hidden = false; return;
    }
    err.hidden = true;
    const key = $("#apiKey").value.trim();
    try { localStorage.setItem("od_key", key); } catch {}
    const url = new URL(location.href); url.searchParams.set("id", id); url.searchParams.delete("demo");
    try { history.replaceState(null, "", url); } catch {}
    run({ id, n: +$("#gameCount").value, perHero: +$("#proCount").value, key });
  });
  $("#demoBtn").addEventListener("click", async () => {
    try { const url = new URL(location.href); url.searchParams.set("demo", "1"); url.searchParams.delete("id"); history.replaceState(null, "", url); } catch {}
    await runDemo();
  });
  $("#cancelBtn").addEventListener("click", () => { state.cancel = true; });
  $("#dlgClose").addEventListener("click", () => $("#matchDialog").close());
}

async function runDemo() {
  showView("loading"); setStep("Loading demo data", 0);
  const data = await (await fetch("data/demo.json")).json();
  await run({ id: data.account_id, n: 100, perHero: 25, key: "", demo: new DemoSource(data) });
}

// ------------------------------------------------------------------ loading
let clockStart = 0, clockTimer = null;
function startClock() {
  clockStart = Date.now();
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    const s = Math.floor((Date.now() - clockStart) / 1000);
    $("#clock").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
}
function setStep(text, pct) {
  $("#loadStep").textContent = text;
  if (pct != null) { $("#loadBar span").style.width = pct + "%"; $("#loadBar").setAttribute("aria-valuenow", Math.round(pct)); }
}

async function run({ id, n, perHero, key, demo = null }) {
  state.cancel = false;
  showView("loading"); startClock();
  const api = new OpenDota({ apiKey: key, demo });
  try {
    setStep("Reading your profile", 1);
    const [profile, list, heroes, items] = [await api.player(id), await api.playerMatches(id, n), await api.heroes(), await api.items()];
    if (!list || !list.length) throw new Error("No public ranked games found for this account. In Dota 2, turn on Expose Public Match Data (Settings, Options, Social), play a game, then try again.");
    const rows = [], unparsed = [];
    let hidden = 0;
    for (let i = 0; i < list.length; i++) {
      if (state.cancel) throw new Error("cancelled");
      setStep(`Reading your match ${i + 1} of ${list.length}`, 5 + (55 * i) / list.length);
      const m = await api.match(list[i].match_id);
      if (!isParsed(m)) { unparsed.push(list[i].match_id); continue; }
      const me = m.players.find(p => p.account_id === id) ||
        (demo ? m.players.find(p => p.player_slot === list[i].player_slot) : null);
      if (!me) { hidden++; continue; }
      rows.push(A.buildRow(m, me.player_slot, "you", heroes, items));
    }
    if (!rows.length) {
      const why = unparsed.length ? `${unparsed.length} of your games haven't been analysed by OpenDota yet.` : "Your games are hidden.";
      state.meta = { unparsed, api };
      throw Object.assign(new Error(`${why} Request analysis below, wait about 10 minutes, then try again.`), { unparsed });
    }
    // pro games on your most-played heroes
    const counts = {};
    rows.forEach(r => { counts[r.hero_id] = (counts[r.hero_id] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => +h);
    const patchUsed = {};
    for (let h = 0; h < top.length; h++) {
      const hid = top[h];
      const name = (heroes[hid] || {}).localized_name || hid;
      const all = (await api.heroMatches(hid)) || [];
      let use = all.filter(r => r.start_time >= ts(PATCHES[PATCH]));
      patchUsed[hid] = PATCH;
      if (use.length < MIN_PRO_ON_PATCH) { use = all.filter(r => r.start_time >= ts(PATCHES["7.41"])); patchUsed[hid] = "7.41 and 7.42"; }
      use = use.slice(0, perHero);
      for (let j = 0; j < use.length; j++) {
        if (state.cancel) throw new Error("cancelled");
        setStep(`Reading pro ${name} game ${j + 1} of ${use.length}`, 60 + (35 * (h + j / use.length)) / top.length);
        const m = await api.match(use[j].match_id);
        if (!isParsed(m)) continue;
        const p = m.players.find(x => x.hero_id === hid);
        if (p) rows.push(A.buildRow(m, p.player_slot, "pro", heroes, items));
      }
      state.bench[hid] = await api.benchmarks(hid);
    }
    setStep("Putting it together", 99);
    state.rows = rows;
    state.you = rows.filter(r => r.source === "you");
    state.meta = { id, profile, unparsed, hidden, patchUsed, demo: !!demo, api, calls: api.calls, top, heroes };
    const posCount = {};
    state.you.forEach(r => { posCount[r.position] = (posCount[r.position] || 0) + 1; });
    state.filters = { pos: +Object.entries(posCount).sort((a, b) => b[1] - a[1])[0][0], hero: "all", result: "all" };
    clearInterval(clockTimer);
    showView("results");
    renderAll();
  } catch (e) {
    clearInterval(clockTimer);
    showView("start");
    if (e.message === "cancelled") return;
    const err = $("#startError");
    err.innerHTML = esc(e.message.includes("Failed to fetch") || e.message.includes("NetworkError")
      ? "Couldn't reach OpenDota. Check your connection and try again. (Preview copies hosted on claude.ai can't make live lookups; use the demo there, or your own hosted copy.)"
      : e.message);
    if (e.unparsed && e.unparsed.length) {
      const b = document.createElement("button");
      b.className = "btn small"; b.type = "button"; b.textContent = `Request analysis of ${e.unparsed.length} games`;
      b.style.marginLeft = "8px";
      b.onclick = () => requestParses(e.unparsed, b);
      err.appendChild(b);
    }
    err.hidden = false;
  }
}

async function requestParses(ids, btn) {
  const api = state.meta.api || new OpenDota({});
  btn.disabled = true;
  let ok = 0;
  for (let i = 0; i < ids.length; i++) {
    btn.textContent = `Requesting ${i + 1} of ${ids.length}`;
    try { if ((await api.requestParse(ids[i])).ok) ok++; } catch {}
  }
  btn.textContent = `Requested ${ok} of ${ids.length}. Come back in about 10 minutes.`;
}

// ------------------------------------------------------------------ results
function filtered() {
  const f = state.filters;
  return state.you.filter(r => r.position === f.pos && (f.hero === "all" || r.hero === f.hero) &&
    (f.result === "all" || (f.result === "win") === !!r.win));
}

function renderProfile() {
  const { profile, demo } = state.meta;
  const pr = (profile && profile.profile) || {};
  const you = state.you;
  const wr = Math.round(100 * A.mean(you.map(r => r.win)));
  const rank = rankName(profile && profile.rank_tier);
  $("#profile").innerHTML = `
    ${pr.avatarfull ? `<img src="${esc(pr.avatarfull)}" alt="">` : ""}
    <div>
      <h1>${esc(pr.personaname || "Player " + state.meta.id)}</h1>
      <div class="sub">${demo ? "Demo data, made up for illustration. " : ""}${rank ? esc(rank) + ". " : ""}${you.length} analysed ranked games${state.meta.unparsed.length ? `, ${state.meta.unparsed.length} still waiting for OpenDota` : ""}.</div>
    </div>
    <div class="kpis">
      <div class="kpi"><b>${wr}%</b><span>win rate</span></div>
      <div class="kpi"><b>${A.fmt(A.median(you.map(r => r.lh10)), 0)}</b><span>last hits at 10:00</span></div>
      <div class="kpi"><b>${A.fmt(A.median(you.map(r => r.deaths)), 0)}</b><span>deaths per game</span></div>
    </div>`;
}

function rankName(t) {
  if (!t) return "";
  const names = ["", "Herald", "Guardian", "Crusader", "Archon", "Legend", "Ancient", "Divine", "Immortal"];
  const tier = Math.floor(t / 10), star = t % 10;
  return names[tier] ? `${names[tier]}${tier < 8 && star ? " " + star : ""}` : "";
}

function renderFilters() {
  const f = state.filters;
  const posAvail = new Set(state.you.map(r => r.position));
  const heroes = [...new Set(state.you.filter(r => r.position === f.pos).map(r => r.hero))].sort();
  $("#filters").innerHTML = `
    <div class="chips" role="group" aria-label="Position">
      ${[1, 2, 3, 4, 5].map(p => `<button class="chip" type="button" data-pos="${p}" aria-pressed="${p === f.pos}" ${posAvail.has(p) ? "" : "disabled"}>${posLabel(p)}</button>`).join("")}
    </div>
    <label>Hero <select id="fHero"><option value="all">All heroes</option>${heroes.map(h => `<option ${h === f.hero ? "selected" : ""}>${esc(h)}</option>`).join("")}</select></label>
    <label>Games <select id="fResult">
      <option value="all" ${f.result === "all" ? "selected" : ""}>Wins and losses</option>
      <option value="win" ${f.result === "win" ? "selected" : ""}>Wins only</option>
      <option value="loss" ${f.result === "loss" ? "selected" : ""}>Losses only</option></select></label>
    <button class="btn small ghost" id="newSearch" type="button">New search</button>`;
  $("#filters").querySelectorAll("[data-pos]").forEach(b => b.addEventListener("click", () => {
    state.filters.pos = +b.dataset.pos; state.filters.hero = "all"; renderAll();
  }));
  $("#fHero").addEventListener("change", e => { state.filters.hero = e.target.value; renderAll(); });
  $("#fResult").addEventListener("change", e => { state.filters.result = e.target.value; renderAll(); });
  $("#newSearch").addEventListener("click", () => { try { const u = new URL(location.href); u.search = ""; history.replaceState(null, "", u); } catch {} showView("start"); });
}

const jobs = [];
const chartJob = (fn) => { const id = "c" + Math.random().toString(36).slice(2, 9); jobs.push([id, fn]); return id; };

function table(cols, rows, { cls = () => ({}), rowAttr = () => "" } = {}) {
  if (!rows.length) return `<p class="empty">Not enough games yet.</p>`;
  return `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th scope="col" class="${c[2] === "l" ? "l" : ""}">${esc(c[0])}</th>`).join("")}</tr></thead><tbody>${
    rows.map(r => `<tr ${rowAttr(r)}>${cols.map(c => { const v = c[1](r); const k = ((cls(r)[c[0]]) || "") + (c[2] === "l" ? " l" : ""); return `<td class="${k}">${v}</td>`; }).join("")}</tr>`).join("")
  }</tbody></table></div>`;
}

function gapMeter(f) {
  const vals = [f.you, f.pro, f.p25, f.p75];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.15 || 1; lo -= pad; hi += pad;
  const x = v => (100 * (v - lo)) / (hi - lo);
  return `<div class="gap" role="img" aria-label="You ${A.fmt(f.you)}, pro median ${A.fmt(f.pro)}">
    <div class="track"></div>
    <div class="iqr" style="left:${x(Math.min(f.p25, f.p75))}%;width:${Math.abs(x(f.p75) - x(f.p25))}%"></div>
    <div class="mk pro" style="left:${x(f.pro)}%"></div><span class="cap" style="left:${x(f.pro)}%">Pros</span>
    <div class="mk you" style="left:${x(f.you)}%"></div><span class="cap" style="left:${x(f.you)}%;top:26px">You</span>
  </div>`;
}

function secOverview(you) {
  const fixes = A.topFixes(state.rows, you, 3);
  const plan = A.coachingPlan(state.rows, you);
  const notes = [];
  if (state.meta.unparsed.length) notes.push(`${state.meta.unparsed.length} recent games aren't analysed by OpenDota yet. <button class="link" id="reqParse" type="button">Request analysis</button>, then come back in about 10 minutes.`);
  const older = Object.entries(state.meta.patchUsed || {}).filter(([, p]) => p !== PATCH).map(([h]) => esc((state.meta.heroes[h] || {}).localized_name));
  if (older.length) notes.push(`Patch 7.42 is brand new, so there aren't many pro games on it yet. Pro games for ${older.join(", ").replace(/, ([^,]*)$/, " and $1")} include 7.41 as well.`);
  return `<section id="overview"><h2>Your biggest gaps</h2>
    <p class="intro">Your median game as a ${esc(posLabel(state.filters.pos).toLowerCase())}, compared with pro games at the same position. The shaded band is where the middle half of pro games land.</p>
    ${notes.map(n => `<p class="notice">${n}</p>`).join("")}
    <div class="fixes">${fixes.length ? fixes.map(f => { const s = A.fixSentence(f); return `<div class="fix"><div><h3>${esc(s.head)}</h3><p>${esc(s.body)}</p></div>${gapMeter(f)}</div>`; }).join("") : `<p class="empty">Play a few more games at this position to see your gaps (needs 3+ games).</p>`}</div>
    ${plan.length ? `<h3 style="margin-top:32px">Four-week plan</h3>
      <p class="intro">One focus a week, starting with the biggest gap. Targets are where the lower quarter of pro games sit, so they're reachable.</p>
      <ol class="plan">${plan.map(p => `<li><b>Week ${p.week}: ${esc(p.focus)}</b>, from ${A.fmt(p.now)} to ${p.higher ? "" : "under "}${A.fmt(p.target)}. ${esc(p.how)}</li>`).join("")}</ol>
      <button class="btn small ghost" id="copyPlan" type="button">Copy plan</button>` : ""}
  </section>`;
}

function secHeroes(you) {
  const groups = A.heroGroups(you).filter(g => g.games.length >= 3);
  const parts = groups.map(g => {
    const [pros, basis] = A.proBasis(state.rows, g.hero_id, g.position);
    const cmp = A.compare(g.games, pros);
    const pub = A.publicPercentiles(state.bench[g.hero_id], g.games);
    const lhId = chartJob(c => C.curveChart(c, { pro: A.curveBands(pros, "lh"), you: A.curveBands(g.games, "lh"), yLabel: "Last hits" }));
    const nwId = chartJob(c => C.curveChart(c, { pro: A.curveBands(pros, "nw"), you: A.curveBands(g.games, "nw"), yLabel: "Net worth" }));
    return `<div class="hero-block"><h3>${esc(g.hero)} <small>${g.games.length} games, ${Math.round(100 * A.mean(g.games.map(r => r.win)))}% wins. Compared with ${pros.length} games from ${esc(basis)}.</small></h3>
      <div class="two"><div class="chart"><canvas id="${lhId}" aria-label="Last hits by minute, you vs pros"></canvas></div>
      <div class="chart"><canvas id="${nwId}" aria-label="Net worth by minute, you vs pros"></canvas></div></div>
      ${pub.length ? `<p class="muted" style="margin-top:12px">Where your median sits among all OpenDota players on ${esc(g.hero)} (the line marks the middle):</p>
        <div class="bars-pct">${pub.map(p => `<div class="pct-row"><span>${esc(p.label)}</span><div class="meter"><span style="width:${p.pct}%"></span><i></i></div><b>${Math.round(p.pct)}th</b></div>`).join("")}</div>` : ""}
      ${(() => {
        const cols = [["Stat", r => esc(r.label)], ["You", r => A.fmt(r.you)], ["Pro median", r => A.fmt(r.pro)], ["Pro middle half", r => `${A.fmt(Math.min(r.p25, r.p75))} to ${A.fmt(Math.max(r.p25, r.p75))}`], ["Better than % of pro games", r => Math.round(r.beat)]];
        const opt = { cls: r => ({ "Better than % of pro games": r.beat < 20 ? "bad" : r.beat > 60 ? "good" : "" }) };
        const key = A.focusMetrics(g.position);
        const main = cmp.filter(c => key.includes(c.metric)), rest = cmp.filter(c => !key.includes(c.metric));
        return table(cols, main, opt) + (rest.length ? `<details class="more"><summary>${rest.length} more stats</summary>${table(cols, rest, opt)}</details>` : "");
      })()}
    </div>`;
  });
  return `<section id="heroes"><h2>Heroes vs pros</h2><p class="intro">Each hero you've played 3+ times at this position. Lines are medians, the shaded band is the middle half of pro games.</p>${parts.join("") || `<p class="empty">No hero with 3+ games at this position yet.</p>`}</section>`;
}

function secSpikes(you) {
  const parts = A.heroGroups(you).map(g => {
    const sp = A.powerSpikes(state.rows, you, g.hero_id, g.position);
    if (!sp.ok) return `<div class="hero-block"><h3>${esc(g.hero)}</h3><p class="empty">${esc(sp.reason)}</p></div>`;
    const id = chartJob(c => C.spikeChart(c, sp.spikes));
    const k = sp.key;
    return `<div class="hero-block"><h3>${esc(g.hero)}</h3>
      ${k ? `<p class="callout">${esc(k.name)} matters most for you: you win ${Math.round(k.winOn)}% of games when it's on time (by minute ${A.fmt(k.cut, 1)}) and ${Math.round(k.winLate)}% when it's late. You're on time in ${Math.round(k.onTime)}% of games.</p>` : ""}
      <div class="chart" style="height:${80 + 44 * sp.spikes.length}px"><canvas id="${id}" aria-label="Power spike timings"></canvas></div>
      ${table([["Spike", s => esc(s.name)], ["Pro median (min)", s => A.fmt(s.pro, 1)], ["On time by", s => A.fmt(s.cut, 1)], ["You", s => A.fmt(s.you, 1)], ["Behind by", s => (s.behind > 0 ? "+" : "") + A.fmt(s.behind, 1)], ["On time", s => Math.round(s.onTime) + "%"], ["Wins on time", s => (s.winOn == null ? "–" : Math.round(s.winOn) + "%")], ["Wins late", s => (s.winLate == null ? "–" : Math.round(s.winLate) + "%")]],
        sp.spikes, { cls: s => ({ "Behind by": s.behind > 2 ? "bad" : "" }) })}</div>`;
  });
  return `<section id="spikes"><h2>Power spikes</h2><p class="intro">When you hit key levels and items compared with pros. "On time" means by the minute three out of four pro games had it. Level times come from XP per minute and are accurate to about a minute. Being late is partly a symptom of losing, so treat win rates as a guide, not proof.</p>${parts.join("")}</section>`;
}

function secBuilds(you) {
  const parts = A.heroGroups(you).filter(g => g.games.length >= 3).map(g => {
    const b = A.builds(state.rows, you, g.hero_id, g.position);
    const cols = [["Build (first 3 big items)", x => esc(x.build)], ["Games", x => x.games], ["Share", x => Math.round(x.share) + "%"], ["Win rate", x => Math.round(x.winrate) + "%"]];
    return `<div class="hero-block"><h3>${esc(g.hero)}</h3><div class="two"><div><p class="muted">Pros (${b.nPro} games)</p>${table(cols, b.pro)}</div><div><p class="muted">You (${b.nYou} games)</p>${table(cols, b.you)}</div></div></div>`;
  });
  return `<section id="builds"><h2>Item builds</h2><p class="intro">Your most common first three big items next to the pros', boots left out.</p>${parts.join("") || `<p class="empty">No hero with 3+ games yet.</p>`}</section>`;
}

function secProgress(you) {
  const pos = state.filters.pos;
  const metrics = pos >= 4 ? ["xp10_diff", "deaths_pre10", "wards"] : ["lh10", "deaths_pre10", "first_core_min"];
  if (you.length < 8) return `<section id="progress"><h2>Progress</h2><p class="empty">Needs 8+ games at this position (you have ${you.length}).</p></section>`;
  const pr = A.progress(you, metrics);
  const labels = pr.dates.map((_, i) => i + 1);
  const ids = [...metrics, "win"].map(m => chartJob(c => C.lineChart(c, { labels, series: [{ label: m === "win" ? "Win rate (%)" : A.METRICS[m][0], data: pr.series[m] }], yLabel: m === "win" ? "Win rate (%)" : A.METRICS[m][0] })));
  return `<section id="progress"><h2>Progress</h2><p class="intro">Rolling average over ${pr.w} games, oldest on the left.</p>
    <div class="two">${ids.map(id => `<div class="chart" style="height:220px"><canvas id="${id}"></canvas></div>`).join("")}</div>
    ${table([["Stat", t => esc(t.label)], ["Older half", t => A.fmt(t.older)], ["Newer half", t => A.fmt(t.newer)], ["Trend", t => (t.better == null ? "Flat" : t.better ? "Improving" : "Getting worse")]],
      pr.trend, { cls: t => ({ Trend: t.better == null ? "" : t.better ? "good" : "bad" }) })}</section>`;
}

function secMatchups(you) {
  const mu = A.matchups(state.rows, you, state.filters.pos);
  if (mu.n < 8) return `<section id="matchups"><h2>Matchups</h2><p class="empty">Needs 8+ games at this position (you have ${mu.n}).</p></section>`;
  const cols = label => [[label, x => esc(x.hero)], ["Games", x => x.games], ["Your win rate", x => Math.round(x.winrate) + "%"], ["Adjusted", x => Math.round(x.adjusted) + "%"], ["Pro win rate", x => (x.pro == null ? "–" : Math.round(x.pro) + "%")]];
  return `<section id="matchups"><h2>Matchups</h2><p class="intro">Your overall win rate here is ${Math.round(mu.base)}%. "Adjusted" pulls small samples toward that, so one lucky game doesn't look like 100%.</p>
    <div class="two"><div><h3>Hardest enemy heroes</h3>${table(cols("Enemy"), mu.enemies.slice(0, 6))}</div>
    <div><h3>Best allies</h3>${table(cols("Ally"), mu.allies.slice(0, 6))}</div></div>
    <h3 style="margin-top:20px">Lane opponents</h3>${table([...cols("Opponent"), ["Net worth lead at 10:00", x => (x.nw10 > 0 ? "+" : "") + A.fmt(x.nw10, 0)]], mu.lane.slice(0, 8), { cls: x => ({ "Net worth lead at 10:00": x.nw10 < -300 ? "bad" : x.nw10 > 300 ? "good" : "" }) })}</section>`;
}

function secFights(you) {
  const pos = state.filters.pos;
  const pros = state.rows.filter(r => A.isPro(r) && r.position === pos);
  const a = A.teamfightSummary(you), b = A.teamfightSummary(pros);
  if (!a || !b) return `<section id="fights"><h2>Teamfights</h2><p class="empty">No teamfight data in these games.</p></section>`;
  const rows = Object.keys(a).map(k => ({ k, y: a[k], p: b[k] }));
  return `<section id="fights"><h2>Teamfights</h2><p class="intro">From OpenDota's fight data. A fight counts as won when your team gained more gold in it than the enemy.</p>
    ${table([["", r => esc(r.k)], ["You", r => A.fmt(r.y)], ["Pros", r => A.fmt(r.p)]], rows)}</section>`;
}

function secVision(you) {
  const pos = state.filters.pos;
  const pros = state.rows.filter(r => A.isPro(r) && r.position === pos);
  const a = A.visionSummary(you), b = A.visionSummary(pros);
  if (a.nObs < 10) return `<section id="vision"><h2>Vision</h2><p class="empty">${pos <= 3 ? "Ward maps are for supports. Pick pos 4 or 5 above to see them." : `You've placed ${a.nObs} observer wards in these games. The maps appear once you've placed 10.`}</p></section>`;
  const id1 = chartJob(c => C.wardMap(c, b.wards, "Pro observer wards")), id2 = chartJob(c => C.wardMap(c, a.wards, "Your observer wards"));
  return `<section id="vision"><h2>Vision</h2><p class="intro">Where observer wards go, seen from the Radiant side (Dire games are flipped). The blue line is the river.</p>
    <div class="maps"><figure><canvas id="${id1}"></canvas><figcaption>Pros, ${b.nObs} wards</figcaption></figure><figure><canvas id="${id2}"></canvas><figcaption>You, ${a.nObs} wards</figcaption></figure></div>
    ${table([["", r => esc(r.k)], ["You", r => A.fmt(r.y)], ["Pros", r => A.fmt(r.p)]], Object.keys(a.stats).map(k => ({ k, y: a.stats[k], p: b.stats[k] })))}</section>`;
}

function secModel(you) {
  const m = A.winModel(state.rows, you, state.filters.pos);
  state.model = m.ok ? m : null;
  if (!m.ok) return `<section id="model"><h2>What wins games</h2><p class="empty">${esc(m.reason)}</p></section>`;
  const max = m.imp[0].weight || 1;
  return `<section id="model"><h2>What wins games</h2>
    <p class="intro">A logistic regression trained on ${m.n} games at this position, using only stats from the first 20 minutes. Cross-validated AUC is ${A.fmt(m.auc, 2)} (0.5 is a coin flip, 1.0 is perfect). It shows associations, not causes.</p>
    <div class="bars-pct">${m.imp.map(i => `<div class="pct-row"><span>${esc(i.label)}</span><div class="meter"><span style="width:${(100 * i.weight) / max}%;background:var(--pro)"></span></div><b>${i.sign > 0 ? "more wins" : "fewer wins"}</b></div>`).join("")}</div>
    <p class="muted">Bar length is how strongly each stat moves the prediction; the right column says which way more of it pushes.</p></section>`;
}

function secMatches(you) {
  const g = [...you].sort((a, b) => b.start_time - a.start_time);
  return `<section id="matches"><h2>Your matches</h2><p class="intro">Select a game to see what went wrong and right compared with pros.</p>
    ${table([["Date", r => new Date(r.start_time * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })], ["Hero", r => esc(r.hero), "l"],
      ["Result", r => `<span class="pill ${r.win ? "win" : "loss"}">${r.win ? "Win" : "Loss"}</span>`, "l"], ["K/D/A", r => `${r.kills}/${r.deaths}/${r.assists}`],
      ["Last hits at 10:00", r => A.fmt(r.lh10, 0)], ["Early win chance", r => (state.model ? Math.round(100 * state.model.score(r)) + "%" : "–")], ["Minutes", r => A.fmt(r.duration, 0)]],
      g, { rowAttr: r => `class="click" tabindex="0" data-match="${r.match_id}"` })}</section>`;
}

function openMatch(id) {
  const dd = A.deepDive(state.rows, state.you, id);
  if (!dd) return;
  const r = dd.r;
  $("#dlgTitle").textContent = `${r.hero}, ${r.win ? "win" : "loss"} in ${Math.round(r.duration)} minutes`;
  const lhId = chartJob(c => C.curveChart(c, { pro: dd.proLh.slice(0, Math.min(45, r.lh.length)), you: dd.usualLh.slice(0, Math.min(45, r.lh.length)), single: r.lh, yLabel: "Last hits", youLabel: "Your usual" }));
  $("#dlgBody").innerHTML = `<p class="muted">${esc(posLabel(r.position))}. Compared with ${dd.nPros} games from ${esc(dd.basis)}. <a href="https://www.opendota.com/matches/${r.match_id}" rel="noopener">Open on OpenDota</a></p>
    <div class="ww"><div class="w"><h3>What went wrong</h3>${dd.wrong.length ? `<ul>${dd.wrong.map(s => `<li>${esc(s.label)}: ${A.fmt(s.v)} vs ${A.fmt(s.pro)} for pros${s.usual != null ? `, your usual ${A.fmt(s.usual)}` : ""}</li>`).join("")}</ul>` : `<p>Nothing in the bottom quarter of pro games.</p>`}</div>
    <div class="r"><h3>What went well</h3>${dd.right.length ? `<ul>${dd.right.map(s => `<li>${esc(s.label)}: ${A.fmt(s.v)} vs ${A.fmt(s.pro)} for pros</li>`).join("")}</ul>` : `<p>Nothing above most pro games this time.</p>`}</div></div>
    <div class="chart"><canvas id="${lhId}" aria-label="Last hits this game vs pros"></canvas></div>
    <div class="two"><div><h3>Timings</h3>${table([["", s => esc(s.name)], ["This game (min)", s => A.fmt(s.v, 1)], ["Pro median", s => A.fmt(s.pro, 1)]], dd.spikes, { cls: s => ({ "This game (min)": s.v != null && s.pro != null && s.v - s.pro > 2 ? "bad" : "" }) })}</div>
    <div><h3>Deaths</h3>${r.deathList.length ? table([["Time", d => `${Math.floor(d[0] / 60)}:${String(Math.floor(d[0] % 60)).padStart(2, "0")}`], ["Killed by", d => esc(d[1])]], r.deathList) : "<p>No deaths.</p>"}</div></div>
    ${r.fights.length ? `<h3>Teamfights</h3>${table([["Fight", f => f.fight], ["Minute", f => A.fmt(f.start, 1)], ["You", f => (f.present ? (f.diedFirst ? "In, died first" : "In") : "Not there")], ["Damage", f => f.damage], ["Gold swing", f => (f.gold > 0 ? "+" : "") + f.gold], ["Result", f => (f.won ? "Won" : "Lost")]], r.fights, { cls: f => ({ Result: f.won ? "good" : "bad" }) })}` : ""}`;
  $("#matchDialog").showModal();
  runJobs();
}

function runJobs() {
  while (jobs.length) {
    const [id, fn] = jobs.shift();
    const el = document.getElementById(id);
    if (el) { try { fn(el); } catch (e) { console.error(e); } }
  }
}

function renderAll() {
  C.destroyAll(); jobs.length = 0;
  renderProfile(); renderFilters();
  const you = filtered();
  const html = you.length ? [secOverview, secHeroes, secSpikes, secBuilds, secProgress, secMatchups, secFights, secVision, secModel, secMatches].map(f => f(you)).join("")
    : `<p class="empty">No games match these filters.</p>`;
  $("#content").innerHTML = html;
  runJobs();
  const plan = A.coachingPlan(state.rows, you);
  const cp = $("#copyPlan");
  if (cp) cp.onclick = async () => {
    try { await navigator.clipboard.writeText(plan.map(p => `Week ${p.week}: ${p.focus}, from ${A.fmt(p.now)} to ${A.fmt(p.target)}. ${p.how}`).join("\n")); cp.textContent = "Copied"; }
    catch { cp.textContent = "Copy failed: select the text instead"; }
  };
  const rp = $("#reqParse");
  if (rp) rp.onclick = () => requestParses(state.meta.unparsed, rp);
  document.querySelectorAll("tr[data-match]").forEach(tr => {
    const go = () => openMatch(+tr.dataset.match);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

// highlight the section in view
const io = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) document.querySelectorAll(".toc a").forEach(a => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id));
}), { rootMargin: "-30% 0px -60% 0px" });
new MutationObserver(() => document.querySelectorAll(".content > section").forEach(s => io.observe(s))).observe($("#content"), { childList: true });

// ------------------------------------------------------------------ boot
initStart();
const params = new URLSearchParams(location.search);
if (params.get("demo")) runDemo();
else if (params.get("id")) { $("#steamId").value = params.get("id"); $("#startForm").requestSubmit(); }
