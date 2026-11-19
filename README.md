# Pro Gap: compare your Dota 2 games with the pros

A website where anyone types a Steam ID and sees how their recent ranked games compare with pro players on the same hero and position. It runs entirely in the visitor's browser, talking straight to the free [OpenDota API](https://docs.opendota.com/). There's no server and no database, so you can host it free on GitHub Pages.

## What it shows

- **Your biggest gaps:** the three stats where you're furthest behind pros at your position, each with a reachable first target, plus a four-week practice plan you can copy.
- **Heroes vs pros:** for each hero you've played 3+ times, last-hit and net-worth curves against the pro band, your percentile among all OpenDota players on that hero, and a full stat comparison.
- **Power spikes:** when you hit levels 6, 12 and 18 and your key items compared with pros, and your win rate when on time versus late.
- **Item builds:** your first three big items next to the pros' builds.
- **Progress:** rolling charts, plus an older-half vs newer-half trend.
- **Matchups:** hardest enemy heroes, best allies and lane opponents.
- **Teamfights:** fights joined, fights won with and without you, how often you died first.
- **Vision:** observer ward heatmaps compared with pros (for supports).
- **What wins games:** a logistic regression trained on first-20-minute stats, with a cross-validated AUC.
- **Your matches:** click any game for a deep dive covering what went wrong and right, your last-hit curve against pros, timings, deaths and fights.

Filters let visitors switch position (1–5), hero, and wins/losses.

## Put it online (GitHub Pages, free, about 5 minutes)

1. Create a free account at github.com if you don't have one.
2. Click **New repository**, name it `pro-gap` (any name works), set it to **Public**, and create it.
3. On the new repo page, click **uploading an existing file**. Drag in **everything inside this folder**: `index.html`, `.nojekyll`, and the `css`, `js` and `data` folders. Keep the folder structure. Click **Commit changes**.
4. Go to **Settings > Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. Wait a minute and refresh. Your site is live at `https://YOUR-USERNAME.github.io/pro-gap/`.

To update it later, upload changed files the same way. Netlify Drop (app.netlify.com/drop) also works: drag the whole folder onto the page.

### Sharing a profile link

`https://YOUR-USERNAME.github.io/pro-gap/?id=123456789` opens straight into that player's results. `?demo=1` opens the demo.

## Running it on your computer

Browsers block ES modules opened straight from a file, so start a tiny local server inside this folder:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## How it works

- `js/api.js`: the OpenDota client. It sends one request at a time, about one per second on the free tier (or roughly 8× faster with a free OpenDota API key entered under Options), retries when rate-limited, and caches responses in the browser so repeat visits load instantly.
- `js/analysis.js`: turns match data into per-game stats and does the comparisons: position detection, benchmarks, power spikes, builds, matchups, teamfights, vision, the logistic-regression win model and the coaching plan.
- `js/charts.js`: Chart.js charts and the ward heatmap.
- `js/app.js`: the page flow, filters and every section.
- `js/vendor/chart.umd.js`: Chart.js 4.6.1 (MIT licence), bundled so the site has no runtime CDN dependency.
- `data/demo.json`: a made-up dataset for the "Try it with demo data" button.

A first visit reads about 30 of the visitor's games and 15 pro games on each of their 3 most-played heroes, which is about 100 requests, or a minute and a half on the free tier.

## Limits worth knowing

- **Patch 7.42 came out on 18 Nov 2026.** When a hero has fewer than 10 pro games on 7.42, that hero's pro comparison also includes 7.41 games, and the page says so. Patch dates are at the top of `js/app.js`. Add new patches there.
- **Positions are inferred** from each player's lane and net worth, because OpenDota doesn't record them. Pos 4 and 5 are occasionally swapped.
- **Unparsed games:** OpenDota only has detailed stats for games it has analysed. The site offers a button to request analysis, which takes about 10 minutes.
- **Level times** are estimated from XP per minute and are accurate to about a minute.
- **The win model shows associations, not causes.** For example, a late item often reflects a game that was already going badly.
- **Shared rate limit:** each visitor uses their own browser's OpenDota allowance, so the site scales without you paying anything.

Match data comes from OpenDota. This is a fan project, not affiliated with Valve.
