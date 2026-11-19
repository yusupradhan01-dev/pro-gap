// Analysis engine: OpenDota match JSON -> per-game rows -> comparisons with pros.
// Ported from the Python version of the tool.

export const POS_NAMES = { 1: "Pos 1 · carry", 2: "Pos 2 · mid", 3: "Pos 3 · offlane", 4: "Pos 4 · soft support", 5: "Pos 5 · hard support" };
export const POS_SHORT = { 1: "Carry", 2: "Mid", 3: "Offlane", 4: "Soft support", 5: "Hard support" };

// metric -> [label, higher is better]
export const METRICS = {
  lh10: ["Last hits at 10:00", true],
  dn10: ["Denies at 10:00", true],
  nw10: ["Net worth at 10:00", true],
  nw10_diff: ["Net worth lead at 10:00", true],
  xp10_diff: ["XP lead at 10:00", true],
  lh20: ["Last hits at 20:00", true],
  nw20_diff: ["Net worth lead at 20:00", true],
  deaths_pre10: ["Deaths before 10:00", false],
  deaths_10_20: ["Deaths 10:00–20:00", false],
  first_core_min: ["First big item (minute)", false],
  lvl6_min: ["Level 6 (minute)", false],
  gpm: ["Gold per minute", true],
  xpm: ["XP per minute", true],
  lh_pm: ["Last hits per minute", true],
  hero_dmg_pm: ["Hero damage per minute", true],
  tower_dmg_pm: ["Tower damage per minute", true],
  ka_pm: ["Kills + assists per minute", true],
  dead_share: ["Time spent dead (%)", false],
  wards: ["Wards placed", true],
  stuns: ["Stun seconds", true],
  camps_stacked: ["Camps stacked", true],
  fight_presence: ["Teamfights joined (%)", true],
  died_first: ["Died first in fights (%)", false],
};
const CORE_FOCUS = ["lh10", "nw10_diff", "lh20", "deaths_pre10", "deaths_10_20", "first_core_min", "lvl6_min",
  "hero_dmg_pm", "tower_dmg_pm", "dead_share", "died_first"];
const SUPPORT_FOCUS = ["xp10_diff", "deaths_pre10", "deaths_10_20", "wards", "stuns", "ka_pm", "dead_share",
  "lvl6_min", "fight_presence", "died_first", "camps_stacked"];
export const focusMetrics = pos => (pos >= 4 ? SUPPORT_FOCUS : CORE_FOCUS);

const XP_TABLE = [0, 240, 640, 1160, 1760, 2440, 3200, 4000, 4900, 5900, 7000, 8200, 9500, 10900, 12400, 14000,
  15700, 17500, 19400, 21400, 23600, 26000, 28600, 31400, 34400, 38400, 43400, 49400, 56400, 64400];
const SKIP_ITEMS = new Set(["aegis", "cheese", "refresher_shard", "aghanims_shard_roshan", "ultimate_scepter_roshan",
  "ward_dispenser", "tome_of_knowledge"]);
const CORE_BASICS = new Set(["blink", "aghanims_shard"]);

// ---------------------------------------------------------------- stats helpers
export const num = v => (v === null || v === undefined || Number.isNaN(v) ? null : v);
export function clean(a) { return a.map(num).filter(v => v !== null); }
export function mean(a) { a = clean(a); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }
export function quantile(a, q) {
  a = clean(a).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
export const median = a => quantile(a, 0.5);
export function std(a) {
  a = clean(a);
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}
const at = (arr, i) => (arr && arr.length > i ? arr[i] : null);
const diff = (a, b) => (a === null || b === null ? null : a - b);

// ---------------------------------------------------------------- positions
export function assignPositions(match) {
  const out = {};
  for (const radiant of [true, false]) {
    const team = match.players.filter(p => (p.player_slot < 128) === radiant);
    const nw = p => (p.net_worth || 0) * 1e4 + (p.gold_per_min || 0);
    let left = [...team];
    for (const [lane, pos] of [[1, 1], [2, 2], [3, 3]]) {
      const cand = left.filter(p => p.lane_role === lane);
      if (cand.length) {
        const best = cand.reduce((a, b) => (nw(b) > nw(a) ? b : a));
        out[best.player_slot] = pos;
        left = left.filter(p => p !== best);
      }
    }
    for (const pos of [1, 2, 3]) {
      if (!team.some(p => out[p.player_slot] === pos) && left.length > 2) {
        const best = left.reduce((a, b) => (nw(b) > nw(a) ? b : a));
        out[best.player_slot] = pos;
        left = left.filter(p => p !== best);
      }
    }
    left.sort((a, b) => nw(a) - nw(b));
    left.forEach((p, i) => { out[p.player_slot] = i === 0 ? 5 : 4; });
  }
  return out;
}
const LANE_VS = { 1: [3, 4], 5: [3, 4], 2: [2], 3: [1, 5], 4: [1, 5] };

function isBuildItem(key, items) {
  const v = items[key];
  if (!v || SKIP_ITEMS.has(key) || (v.cost || 0) < 1000) return false;
  const comps = "components" in v ? v.components : "absent";
  return comps === "absent" || (Array.isArray(comps) && comps.length > 0) || CORE_BASICS.has(key);
}

function levelMinute(xp, level) {
  if (!xp || level < 2) return null;
  const need = XP_TABLE[level - 1];
  for (let m = 1; m < xp.length; m++) {
    if (xp[m] >= need) {
      const a = xp[m - 1], b = xp[m];
      return m - 1 + (b > a ? (need - a) / (b - a) : 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------- one game -> one row
export function buildRow(match, slot, source, heroes, items) {
  const pos = assignPositions(match);
  const p = match.players.find(x => x.player_slot === slot);
  const radiant = slot < 128;
  const myPos = pos[slot];
  const durMin = Math.max(match.duration / 60, 1);
  const enemy = match.players.find(x => (x.player_slot < 128) !== radiant && pos[x.player_slot] === myPos);
  const hname = id => (heroes[String(id)] || {}).localized_name || `Hero ${id}`;
  const byNpc = {};
  Object.values(heroes).forEach(h => { byNpc[h.name] = h.localized_name; });
  const who = key => byNpc[key] || (key.includes("tower") ? "Tower" : key.includes("neutral") ? "Neutral creep"
    : key.includes("roshan") ? "Roshan" : key.replace("npc_dota_", "").replace(/_/g, " "));

  const deaths = p.deaths_log ? p.deaths_log.map(d => [d.time, who(d.key || "")]) : [];
  const nw = p.networth_t || p.gold_t, enw = enemy ? enemy.networth_t || enemy.gold_t : null;
  const xp = p.xp_t, exp = enemy ? enemy.xp_t : null;

  const buys = [];
  (p.purchase_log || []).forEach(b => {
    if (isBuildItem(b.key, items)) buys.push({ item: items[b.key].dname || b.key, key: b.key, minute: b.time / 60 });
  });
  const firstCore = buys.find(b => (items[b.key].cost || 0) >= 2000);

  // teamfights from this player's view
  const order = match.players.map(x => x.player_slot);
  const idx = order.indexOf(slot);
  const allDeaths = match.players.flatMap(q => (q.deaths_log || []).map(d => [d.time, q.player_slot])).sort((a, b) => a[0] - b[0]);
  const fights = (match.teamfights || []).filter(f => f.players && f.players.length === order.length).map((f, i) => {
    const me = f.players[idx];
    let mine = 0, theirs = 0;
    f.players.forEach((fp, j) => { if ((order[j] < 128) === radiant) mine += fp.gold_delta || 0; else theirs += fp.gold_delta || 0; });
    const inFight = allDeaths.filter(([t]) => t >= f.start - 2 && t <= f.end + 2);
    const present = (me.damage || 0) > 0 || (me.deaths || 0) > 0 || (me.healing || 0) > 0 ||
      Object.keys(me.ability_uses || {}).length > 0;
    return {
      fight: i + 1, start: f.start / 60, present, damage: me.damage || 0, deaths: me.deaths || 0,
      kills: Object.values(me.killed || {}).reduce((s, v) => s + v, 0), gold: me.gold_delta || 0,
      won: mine > theirs, diedFirst: allDeaths.length ? inFight.length > 0 && inFight[0][1] === slot : null,
    };
  });
  const pres = fights.filter(f => f.present);
  const dfVals = pres.map(f => f.diedFirst).filter(v => v !== null);

  // wards
  const left = {};
  [...(p.obs_left_log || []), ...(p.sen_left_log || [])].forEach(w => { left[w.ehandle] = w; });
  const wardList = [];
  for (const [kind, log] of [["observer", p.obs_log || []], ["sentry", p.sen_log || []]]) {
    log.forEach(w => {
      const gone = left[w.ehandle];
      wardList.push({ kind, x: w.x, y: w.y, minute: w.time / 60, life: gone ? gone.time - w.time : null,
        destroyed: gone ? !!gone.attackername : null, radiant });
    });
  }

  const sideOf = x => (x.player_slot < 128) === radiant;
  return {
    source, match_id: match.match_id, start_time: match.start_time, hero_id: p.hero_id, hero: hname(p.hero_id),
    position: myPos, win: (!!match.radiant_win) === radiant ? 1 : 0, duration: durMin,
    account_id: p.account_id, player_name: p.name || p.personaname || null,
    kills: p.kills, deaths: p.deaths, assists: p.assists,
    lh10: at(p.lh_t, 10), dn10: at(p.dn_t, 10), nw10: at(nw, 10),
    nw10_diff: diff(at(nw, 10), at(enw, 10)), xp10_diff: diff(at(xp, 10), at(exp, 10)),
    lh20: at(p.lh_t, 20), nw20_diff: diff(at(nw, 20), at(enw, 20)),
    deaths_pre10: p.deaths_log ? deaths.filter(([t]) => t < 600).length : null,
    deaths_10_20: p.deaths_log && durMin >= 20 ? deaths.filter(([t]) => t >= 600 && t < 1200).length : null,
    first_core_min: firstCore ? firstCore.minute : null,
    lvl6_min: levelMinute(xp, 6), lvl12_min: levelMinute(xp, 12), lvl18_min: levelMinute(xp, 18),
    gpm: p.gold_per_min, xpm: p.xp_per_min, lh_pm: (p.last_hits || 0) / durMin,
    hero_dmg_pm: (p.hero_damage || 0) / durMin, tower_dmg_pm: (p.tower_damage || 0) / durMin,
    ka_pm: ((p.kills || 0) + (p.assists || 0)) / durMin,
    dead_share: p.life_state_dead != null ? (100 * p.life_state_dead) / (durMin * 60) : null,
    wards: p.obs_placed != null ? (p.obs_placed || 0) + (p.sen_placed || 0) : null,
    stuns: p.stuns ?? null, camps_stacked: p.camps_stacked ?? null,
    fight_presence: fights.length ? (100 * pres.length) / fights.length : null,
    died_first: dfVals.length ? (100 * dfVals.filter(Boolean).length) / dfVals.length : null,
    allies: match.players.filter(x => sideOf(x) && x !== p).map(x => hname(x.hero_id)),
    enemies: match.players.filter(x => !sideOf(x)).map(x => hname(x.hero_id)),
    laneEnemies: match.players.filter(x => !sideOf(x) && (LANE_VS[myPos] || []).includes(pos[x.player_slot])).map(x => hname(x.hero_id)),
    deathList: deaths, lh: p.lh_t || [], nw: nw || [], buys, fights, wardList,
  };
}

// ---------------------------------------------------------------- comparisons
export const isPro = r => r.source === "pro";

export function compare(you, pros, metrics = Object.keys(METRICS)) {
  const out = [];
  for (const m of metrics) {
    const [label, higher] = METRICS[m];
    const y = clean(you.map(r => r[m])), p = clean(pros.map(r => r[m]));
    if (y.length < 3 || p.length < 8 || std(p) === 0) continue;
    const ym = median(y), pm = median(p);
    const beat = p.filter(v => (higher ? v < ym : v > ym)).length / p.length;
    out.push({ metric: m, label, higher, you: ym, pro: pm, p25: quantile(p, 0.25), p75: quantile(p, 0.75),
      beat: 100 * beat, z: ((ym - pm) / std(p)) * (higher ? 1 : -1), nYou: y.length, nPro: p.length });
  }
  return out;
}

export function proBasis(rows, heroId, pos) {
  const pros = rows.filter(isPro);
  const a = pros.filter(r => r.hero_id === heroId && r.position === pos);
  if (a.length >= 8) return [a, "pros on the same hero and position"];
  const b = pros.filter(r => r.hero_id === heroId);
  if (b.length >= 8) return [b, "pros on the same hero (any position)"];
  return [pros.filter(r => r.position === pos), "all pros at this position"];
}

export function heroGroups(you) {
  const g = new Map();
  you.forEach(r => {
    const k = `${r.hero_id}|${r.position}`;
    if (!g.has(k)) g.set(k, { hero_id: r.hero_id, hero: r.hero, position: r.position, games: [] });
    g.get(k).games.push(r);
  });
  return [...g.values()].sort((a, b) => b.games.length - a.games.length);
}

export function topFixes(rows, you, n = 3) {
  const all = [];
  const byPos = {};
  you.forEach(r => { (byPos[r.position] ||= []).push(r); });
  for (const [pos, g] of Object.entries(byPos)) {
    const pros = rows.filter(r => isPro(r) && r.position === Number(pos));
    compare(g, pros, focusMetrics(Number(pos))).forEach(c => all.push({ ...c, position: Number(pos) }));
  }
  return all.sort((a, b) => a.z - b.z).slice(0, n);
}

export function fixSentence(f) {
  const target = f.higher ? f.p25 : f.p75;
  return {
    head: `${f.label}: ${fmt(f.you)} vs ${fmt(f.pro)} for pros`,
    body: `You're better than ${Math.round(f.beat)}% of pro games here. First target: ${f.higher ? "raise" : "lower"} it to ${fmt(target)}.`,
  };
}

export function fmt(v, d) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (d !== undefined) return v.toFixed(d);
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? String(Number(v.toFixed(1))) : String(Number(v.toFixed(2)));
}

// ---------------------------------------------------------------- per-minute curves
export function curveBands(rows, key, minutes = 30) {
  const out = [];
  for (let m = 0; m <= minutes; m++) {
    const v = clean(rows.map(r => at(r[key], m)));
    out.push(v.length >= 3 ? { m, med: median(v), lo: quantile(v, 0.25), hi: quantile(v, 0.75) } : { m, med: null, lo: null, hi: null });
  }
  return out;
}

// ---------------------------------------------------------------- power spikes
export function keyItems(pros, n = 3) {
  const games = pros.length;
  if (!games) return [];
  const first = {};
  pros.forEach(r => {
    const seen = new Set();
    r.buys.forEach(b => {
      if (seen.has(b.item) || /Boots|Treads|Tranquil|Shard/.test(b.item)) return;
      seen.add(b.item);
      (first[b.item] ||= []).push(b.minute);
    });
  });
  return Object.entries(first).map(([item, t]) => ({ item, rate: t.length / games, med: median(t) }))
    .filter(x => x.rate >= 0.4).sort((a, b) => b.rate - a.rate).slice(0, n).sort((a, b) => a.med - b.med);
}

const firstBuy = (r, item) => { const b = r.buys.find(x => x.item === item); return b ? b.minute : null; };

export function powerSpikes(rows, you, heroId, pos) {
  const [pros, basis] = proBasis(rows, heroId, pos);
  const mine = you.filter(r => r.hero_id === heroId && r.position === pos);
  if (mine.length < 5 || pros.length < 8) return { ok: false, reason: `Needs 5+ of your games and 8+ pro games on this hero (have ${mine.length} and ${pros.length}).` };
  const spikes = [["Level 6", r => r.lvl6_min], ["Level 12", r => r.lvl12_min], ["Level 18", r => r.lvl18_min],
    ...keyItems(pros).map(k => [k.item, r => firstBuy(r, k.item)])];
  const out = [];
  for (const [name, get] of spikes) {
    const pv = clean(pros.map(get));
    if (pv.length < 5) continue;
    const cut = quantile(pv, 0.75);
    const yv = mine.map(get);
    const on = mine.filter((r, i) => yv[i] !== null && yv[i] <= cut), late = mine.filter((r, i) => yv[i] !== null && yv[i] > cut);
    out.push({ name, pro: median(pv), cut, you: median(yv), behind: diff(median(yv), median(pv)),
      onTime: (100 * on.length) / mine.length, winOn: on.length ? 100 * mean(on.map(r => r.win)) : null,
      winLate: late.length ? 100 * mean(late.map(r => r.win)) : null, nOn: on.length, nLate: late.length });
  }
  const swings = out.filter(s => s.nOn >= 3 && s.nLate >= 3).map(s => ({ s, d: s.winOn - s.winLate })).sort((a, b) => b.d - a.d);
  return { ok: out.length > 0, spikes: out, basis, key: swings.length && swings[0].d >= 10 ? swings[0].s : null };
}

// ---------------------------------------------------------------- builds
export function builds(rows, you, heroId, pos) {
  const [pros] = proBasis(rows, heroId, pos);
  const mine = you.filter(r => r.hero_id === heroId && r.position === pos);
  const orderOf = r => [...new Set(r.buys.map(b => b.item))].filter(i => !/Boots|Treads|Tranquil/.test(i)).slice(0, 3).join(" → ");
  const tally = list => {
    const t = {};
    list.forEach(r => { const k = orderOf(r) || "(none)"; (t[k] ||= { build: k, games: 0, wins: 0 }); t[k].games++; t[k].wins += r.win; });
    return Object.values(t).sort((a, b) => b.games - a.games).slice(0, 4)
      .map(x => ({ ...x, share: (100 * x.games) / list.length, winrate: (100 * x.wins) / x.games }));
  };
  return { pro: tally(pros), you: tally(mine), nPro: pros.length, nYou: mine.length };
}

// ---------------------------------------------------------------- progress
export function progress(you, metrics, window = 10) {
  const g = [...you].sort((a, b) => a.start_time - b.start_time);
  const w = Math.min(window, Math.max(3, Math.floor(g.length / 3)));
  const series = {};
  for (const m of [...metrics, "win"]) {
    series[m] = g.map((_, i) => (i + 1 < Math.ceil(w / 2) ? null : mean(g.slice(Math.max(0, i - w + 1), i + 1).map(r => (m === "win" ? 100 * r.win : r[m])))));
  }
  const half = Math.floor(g.length / 2);
  const trend = [...metrics, "win"].map(m => {
    const get = r => (m === "win" ? 100 * r.win : r[m]);
    const a = mean(g.slice(0, half).map(get)), b = mean(g.slice(half).map(get));
    const higher = m === "win" ? true : METRICS[m][1];
    return { metric: m, label: m === "win" ? "Win rate (%)" : METRICS[m][0], older: a, newer: b,
      better: a === null || b === null || a === b ? null : (b > a) === higher };
  });
  return { n: g.length, w, series, trend, dates: g.map(r => r.start_time) };
}

// ---------------------------------------------------------------- matchups
export function matchups(rows, you, pos) {
  const mine = you.filter(r => r.position === pos);
  const base = mean(mine.map(r => r.win)) ?? 0.5;
  const pros = rows.filter(r => isPro(r) && r.position === pos);
  const table = key => {
    const t = {};
    mine.forEach(r => r[key].forEach(h => { (t[h] ||= { hero: h, games: 0, wins: 0, nw: [] }); t[h].games++; t[h].wins += r.win; t[h].nw.push(r.nw10_diff); }));
    const pt = {};
    pros.forEach(r => r[key].forEach(h => { (pt[h] ||= [0, 0]); pt[h][0]++; pt[h][1] += r.win; }));
    return Object.values(t).filter(x => x.games >= 2).map(x => ({
      hero: x.hero, games: x.games, winrate: (100 * x.wins) / x.games,
      adjusted: (100 * (x.wins + base * 4)) / (x.games + 4), nw10: mean(x.nw),
      pro: pt[x.hero] && pt[x.hero][0] >= 3 ? (100 * pt[x.hero][1]) / pt[x.hero][0] : null,
    })).sort((a, b) => a.adjusted - b.adjusted);
  };
  return { base: 100 * base, enemies: table("enemies"), lane: table("laneEnemies"), allies: table("allies").reverse(), n: mine.length };
}

// ---------------------------------------------------------------- teamfights & vision
export function teamfightSummary(list) {
  const f = list.flatMap(r => r.fights);
  const pres = f.filter(x => x.present), away = f.filter(x => !x.present);
  const games = list.filter(r => r.fights.length).length;
  if (!games) return null;
  const df = pres.map(x => x.diedFirst).filter(v => v !== null);
  return {
    "Fights per game": f.length / games,
    "Fights you joined (%)": (100 * pres.length) / Math.max(f.length, 1),
    "Won when you joined (%)": pres.length ? (100 * pres.filter(x => x.won).length) / pres.length : null,
    "Won when you didn't (%)": away.length ? (100 * away.filter(x => x.won).length) / away.length : null,
    "Died first (%)": df.length ? (100 * df.filter(Boolean).length) / df.length : null,
    "Deaths per fight": mean(pres.map(x => x.deaths)),
    "Damage per fight": median(pres.map(x => x.damage)),
  };
}

export function visionSummary(list) {
  const w = list.flatMap(r => r.wardList);
  const obs = w.filter(x => x.kind === "observer");
  const games = Math.max(list.length, 1);
  return {
    wards: w,
    stats: {
      "Observers per game": obs.length / games,
      "Sentries per game": w.filter(x => x.kind === "sentry").length / games,
      "Observers before 10:00": obs.filter(x => x.minute < 10).length / games,
      "Observer lifetime (s)": median(obs.map(x => x.life)),
      "Observers destroyed (%)": obs.some(x => x.destroyed !== null) ? 100 * mean(obs.filter(x => x.destroyed !== null).map(x => (x.destroyed ? 1 : 0))) : null,
    },
    nObs: obs.length,
  };
}

// ---------------------------------------------------------------- win-factor model (logistic regression)
const CORE_FEATS = ["lh10", "nw10_diff", "xp10_diff", "deaths_pre10", "lh20", "nw20_diff", "deaths_10_20", "first_core_min", "lvl6_min"];
const SUP_FEATS = ["xp10_diff", "nw10_diff", "deaths_pre10", "deaths_10_20", "nw20_diff", "wards", "lvl6_min"];

function fitLogit(X, y, l2 = 0.5, iters = 600, lr = 0.15) {
  const n = X.length, k = X[0].length;
  let w = new Array(k).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(k).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = b + X[i].reduce((s, v, j) => s + v * w[j], 0);
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      gb += e; for (let j = 0; j < k; j++) gw[j] += e * X[i][j];
    }
    b -= (lr * gb) / n;
    w = w.map((wj, j) => wj - lr * (gw[j] / n + (l2 * wj) / n));
  }
  return { w, b, p: x => 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + v * w[j], 0)))) };
}

function auc(scores, y) {
  const pos = scores.filter((_, i) => y[i] === 1), neg = scores.filter((_, i) => y[i] === 0);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  pos.forEach(p => neg.forEach(q => { s += p > q ? 1 : p === q ? 0.5 : 0; }));
  return s / (pos.length * neg.length);
}

export function winModel(rows, you, pos) {
  const data = rows.filter(r => r.position === pos && r.nw10_diff !== null);
  const base = pos >= 4 ? SUP_FEATS : CORE_FEATS;
  const feats = base.filter(f => data.filter(r => r[f] !== null).length > 0.6 * data.length);
  if (data.length < 40 || feats.length < 3) return { ok: false, reason: `Needs 40+ games (yours and pros') with 10-minute data at this position (have ${data.length}).` };
  const med = {}, sd = {};
  feats.forEach(f => { const v = clean(data.map(r => r[f])); med[f] = median(v); sd[f] = std(v) || 1; });
  const vec = r => feats.map(f => ((r[f] ?? med[f]) - med[f]) / sd[f]);
  const X = data.map(vec), y = data.map(r => r.win);
  // 5-fold cross-validated AUC (deterministic folds)
  const scores = new Array(X.length);
  for (let k = 0; k < 5; k++) {
    const tr = X.map((_, i) => i).filter(i => i % 5 !== k), te = X.map((_, i) => i).filter(i => i % 5 === k);
    const m = fitLogit(tr.map(i => X[i]), tr.map(i => y[i]));
    te.forEach(i => { scores[i] = m.p(X[i]); });
  }
  const cvAuc = auc(scores, y);
  const model = fitLogit(X, y);
  const imp = feats.map((f, j) => ({ feature: f, label: METRICS[f] ? METRICS[f][0] : f, weight: Math.abs(model.w[j]), sign: model.w[j] }))
    .sort((a, b) => b.weight - a.weight);
  const games = you.filter(r => r.position === pos && r.nw10_diff !== null).map(r => {
    const x = vec(r);
    const contrib = x.map((v, j) => v * model.w[j]);
    const worst = contrib.indexOf(Math.min(...contrib));
    return { r, prob: model.p(x), drag: METRICS[feats[worst]] ? METRICS[feats[worst]][0] : feats[worst], dragValue: r[feats[worst]] };
  }).sort((a, b) => a.prob - b.prob);
  return { ok: true, auc: cvAuc, n: data.length, imp, games, score: r => model.p(vec(r)) };
}

// ---------------------------------------------------------------- coaching plan
const DRILLS = {
  lh10: "10 minutes of last-hitting in demo mode before your first game. In lane, check your last hits at 5:00 and 10:00.",
  nw10_diff: "Trade hits when the enemy goes for a last hit, and pull with your support to keep the lane near your tower.",
  xp10_diff: "Stand in XP range of every dying creep. Don't miss waves for runes before 6.",
  lh20: "After 10:00, never stand still: wave, camp, wave. Stack a camp on the way at x:53.",
  deaths_pre10: "Glance at the minimap after every last hit. Back off when two enemies are missing.",
  deaths_10_20: "Don't farm past the river without vision, and always carry a TP scroll.",
  first_core_min: "Write your core item minute on a sticky note and skip extra components until it's done.",
  lvl6_min: "Don't skip creep waves before level 6. Every missed wave delays your ultimate.",
  hero_dmg_pm: "Join fights once your key item is done, and hit the closest target instead of chasing.",
  tower_dmg_pm: "After a won fight, hit a tower before farming. Push before Roshan, not after.",
  dead_share: "Keep buyback gold after 30:00 and stay behind your frontline in fights.",
  died_first: "In fights, let the enemy commit spells first. Walk in second, not first.",
  wards: "Buy wards every time they're in stock. Ward before objectives, not after.",
  stuns: "Hold your disable for the enemy's key hero and land it first.",
  ka_pm: "Rotate after level 6 when your lane is safe, and follow your cores' fights.",
  fight_presence: "Stay within one screen of your team when Roshan or Tormentor is up.",
  camps_stacked: "Stack one camp every minute you're near the jungle at x:53.",
};

export function coachingPlan(rows, you, weeks = 4) {
  return topFixes(rows, you, 12).filter(f => !["gpm", "xpm"].includes(f.metric)).slice(0, weeks).map((f, i) => ({
    week: i + 1, position: f.position, focus: f.label, now: f.you, target: f.higher ? f.p25 : f.p75, higher: f.higher,
    how: DRILLS[f.metric] || "Watch one pro replay on your hero and copy their timings.",
  }));
}

// ---------------------------------------------------------------- one game deep dive
export function deepDive(rows, you, matchId) {
  const r = you.find(x => x.match_id === matchId);
  if (!r) return null;
  const [pros, basis] = proBasis(rows, r.hero_id, r.position);
  const usual = you.filter(x => x.hero_id === r.hero_id && x.position === r.position && x.match_id !== matchId);
  const stats = [];
  for (const m of [...new Set([...focusMetrics(r.position), "gpm"])]) {
    const [label, higher] = METRICS[m];
    const v = r[m], p = clean(pros.map(x => x[m]));
    if (v === null || p.length < 5) continue;
    const beat = (100 * p.filter(x => (higher ? x < v : x > v)).length) / p.length;
    stats.push({ label, v, pro: median(p), usual: usual.length >= 3 ? median(usual.map(x => x[m])) : null, beat });
  }
  const spikes = [["Level 6", x => x.lvl6_min], ["Level 12", x => x.lvl12_min], ...keyItems(pros).map(k => [k.item, x => firstBuy(x, k.item)])]
    .map(([name, get]) => ({ name, v: get(r), pro: median(pros.map(get)) }));
  return { r, basis, nPros: pros.length, stats, wrong: stats.filter(s => s.beat < 25).sort((a, b) => a.beat - b.beat),
    right: stats.filter(s => s.beat > 60).sort((a, b) => b.beat - a.beat), spikes,
    proLh: curveBands(pros, "lh", 45), proNw: curveBands(pros, "nw", 45), usualLh: curveBands(usual, "lh", 45) };
}

// ---------------------------------------------------------------- public benchmarks (OpenDota /benchmarks)
const BENCH_MAP = { gpm: "gold_per_min", xpm: "xp_per_min", lh_pm: "last_hits_per_min", hero_dmg_pm: "hero_damage_per_min" };
export function publicPercentiles(bench, games) {
  if (!bench || !bench.result) return [];
  const out = [];
  for (const [m, key] of Object.entries(BENCH_MAP)) {
    const table = bench.result[key];
    const v = median(games.map(r => r[m]));
    if (!table || !table.length || v === null) continue;
    let pct = 0;
    for (let i = 0; i < table.length; i++) {
      if (v >= table[i].value) pct = table[i].percentile;
      else {
        const prev = i ? table[i - 1] : { percentile: 0, value: 0 };
        pct = prev.percentile + ((v - prev.value) / (table[i].value - prev.value || 1)) * (table[i].percentile - prev.percentile);
        break;
      }
    }
    out.push({ label: METRICS[m][0], you: v, pct: Math.max(0, Math.min(99, 100 * pct)), p50: (table.find(t => t.percentile === 0.5) || {}).value });
  }
  return out;
}
