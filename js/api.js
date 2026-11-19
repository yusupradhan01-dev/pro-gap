// OpenDota client: one request at a time, polite rate limit, retries, and a browser cache.
// Demo mode answers the same calls from data/demo.json, so the whole app runs on one code path.

const BASE = "https://api.opendota.com/api";
const CACHE_NAME = "dota-analyser-v1";

export class OpenDota {
  constructor({ apiKey = "", demo = null } = {}) {
    this.apiKey = apiKey.trim();
    this.demo = demo;
    this.interval = this.apiKey ? 120 : 1050; // free tier: ~60 calls/minute
    this.last = 0;
    this.chain = Promise.resolve();
    this.calls = 0;
    this.memory = new Map();
  }

  async _cacheGet(url, maxAgeH) {
    if (this.memory.has(url)) return this.memory.get(url);
    try {
      const c = await caches.open(CACHE_NAME);
      const r = await c.match(url);
      if (!r) return null;
      const age = (Date.now() - Number(r.headers.get("x-saved") || 0)) / 3.6e6;
      if (maxAgeH != null && age > maxAgeH) return null;
      const data = await r.json();
      this.memory.set(url, data);
      return data;
    } catch { return null; }
  }

  async _cachePut(url, data) {
    this.memory.set(url, data);
    try {
      const c = await caches.open(CACHE_NAME);
      await c.put(url, new Response(JSON.stringify(data), { headers: { "x-saved": String(Date.now()) } }));
    } catch { /* storage full or unavailable: memory cache is enough */ }
  }

  _wait() {
    // serialise requests and keep them spaced out
    const run = this.chain.then(async () => {
      const gap = this.interval - (Date.now() - this.last);
      if (gap > 0) await new Promise(r => setTimeout(r, gap));
      this.last = Date.now();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async get(path, { maxAgeH = null, cache = true } = {}) {
    if (this.demo) return this.demo.answer(path);
    const url = BASE + path;
    if (cache) {
      const hit = await this._cacheGet(url, maxAgeH);
      if (hit) return hit;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      await this._wait();
      this.calls++;
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(url + (this.apiKey ? `${sep}api_key=${encodeURIComponent(this.apiKey)}` : ""));
      if (res.status === 429) { await new Promise(r => setTimeout(r, 8000 * (attempt + 1))); continue; }
      if (res.status >= 500) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`OpenDota answered ${res.status} for ${path}`);
      const data = await res.json();
      if (cache) await this._cachePut(url, data);
      return data;
    }
    throw new Error(`OpenDota is busy (rate limit). Try again in a minute, or add a free API key.`);
  }

  // ---- endpoints ----
  player(id) { return this.get(`/players/${id}`, { maxAgeH: 6 }); }
  playerMatches(id, limit) {
    return this.get(`/players/${id}/matches?limit=${limit}&lobby_type=7&significant=1`, { maxAgeH: 0.5 });
  }
  async match(id) {
    const m = await this.get(`/matches/${id}`, { cache: true });
    if (!isParsed(m) && !this.demo) this.memory.delete(BASE + `/matches/${id}`); // retry later
    return m;
  }
  heroMatches(hid) { return this.get(`/heroes/${hid}/matches`, { maxAgeH: 6 }); }
  benchmarks(hid) { return this.get(`/benchmarks?hero_id=${hid}`, { maxAgeH: 24 }); }
  heroes() { return this.get(`/constants/heroes`, { maxAgeH: 24 * 7 }); }
  items() { return this.get(`/constants/items`, { maxAgeH: 24 * 7 }); }
  async requestParse(id) {
    if (this.demo) return { ok: true };
    await this._wait();
    const res = await fetch(`${BASE}/request/${id}` + (this.apiKey ? `?api_key=${this.apiKey}` : ""), { method: "POST" });
    return { ok: res.ok };
  }
}

export function isParsed(m) {
  return !!(m && m.players && m.players.some(p => p.lh_t));
}

export class DemoSource {
  constructor(data) { this.d = data; }
  async answer(path) {
    await new Promise(r => setTimeout(r, 15)); // keeps the progress clock visible
    const d = this.d;
    let m;
    if ((m = path.match(/^\/players\/\d+\/matches/))) return d.player_matches;
    if ((m = path.match(/^\/players\/\d+$/))) return d.profile;
    if ((m = path.match(/^\/matches\/(\d+)/))) return d.matches[m[1]] || {};
    if ((m = path.match(/^\/heroes\/(\d+)\/matches/))) return d.hero_matches[m[1]] || [];
    if ((m = path.match(/^\/benchmarks\?hero_id=(\d+)/))) return d.benchmarks[m[1]] || { result: {} };
    if (path === "/constants/heroes") return d.heroes;
    if (path === "/constants/items") return d.items;
    return null;
  }
}
