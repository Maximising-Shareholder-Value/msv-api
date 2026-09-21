# CLAUDE.md

## What this repo is

The backend for $MSV ("Maximising Shareholder Value" — a joke name for a
genuinely useful stock/ETF/crypto research dashboard). A single Cloudflare
Worker (`worker.js`) that proxies free-tier financial/macro data APIs so
their real keys never reach the browser. No frontend code lives here —
that's [msv-web](https://github.com/Maximising-Shareholder-Value/msv-web),
a separate repo/deployment.

For the project's roadmap, history, and known blockers (spans both this
repo and msv-web), see the org's governance hub:
[github.com/Maximising-Shareholder-Value/.github](https://github.com/Maximising-Shareholder-Value/.github).
This file stays the technical reference for this repo specifically.

## History: split from a combined repo (2026-09)

This started as one repo/one Cloudflare Worker deployment that served
both the static frontend AND this proxy logic (a Worker with an `assets`
binding, `run_worker_first: ["/api/*"]` routing only API calls here and
falling through to static files for everything else). Split into
`msv-web` + `msv-api` once the project moved under a GitHub org and
outside collaboration became a real possibility — a genuine split needed
two *independently deployable* pieces, not just two folders, so:

- `wrangler.jsonc` here no longer has an `assets` block — this Worker is
  API-only now, deployed on its own.
- The frontend's proxy URL helpers (`finnhubUrl`, `twelveDataUrl`,
  `coingeckoUrl`, `fredUrl` — all in msv-web) route through one
  `API_BASE_URL` constant that points at wherever this Worker ends up
  deployed. Don't reintroduce a relative `/api/xxx` path assumption on
  the frontend side — it only works when both are the same deployment,
  which is no longer guaranteed.
- Started fresh in the new repo rather than splitting git history (no
  `git filter-repo` available, and the old repo's history wasn't worth
  the force-push risk to preserve). The original combined repo
  (`JozsuaHeng/Maximising-shareholder-value`) still exists as of the
  split, kept around until the new split deployment is verified working.

## Data sources being proxied

- **Finnhub free tier** — the primary source (quotes, fundamentals,
  filings, news, etc.). 60 requests/minute, shared across every visitor
  hitting this Worker. Known gaps on the free tier (confirmed via live
  requests, not assumed): no historical price candles for stocks, no
  crypto candles, no forex quotes/candles at all, no bid/ask, no company
  description, no bonds/options data, no institutional ownership data.
- **Twelve Data free tier** — historical price candles (Finnhub blocks
  these on stocks). Confirmed real CORS support. 800 requests/day free.
- **FRED** — confirmed **zero CORS support** of its own. Every FRED
  request has to go through this Worker, even from the frontend's own
  local dev — there's no way around that without also running a local
  proxy, which isn't worth it for one API.
- **CoinGecko** — confirmed real CORS support AND a genuine batch
  endpoint (`/coins/markets`, multiple coins in one request). Its API key
  is optional — the public tier works without one, just with a lower
  shared rate limit. `proxy()`'s `keyRequired` parameter defaults `true`
  for the other three, `false` for CoinGecko specifically — don't remove
  that, or an unconfigured `COINGECKO_API_KEY` will 500 instead of
  falling back to the public tier.
- **Alpaca market data** (added 2026-09-21) — options chains/snapshots,
  the one asset class this app had zero data for (Finnhub's free tier
  has none: confirmed live against `/etf/*` — all premium-gated — and
  `/stock/metric`, which has no options fields at all). Uses **paper
  trading** credentials (`ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`),
  which also work against the market-data API. Authenticates via two
  HTTP **headers** (`Apca-Api-Key-Id`/`Apca-Api-Secret-Key`), not a
  query-string key like the other four — that's why it has its own
  `proxyAlpaca()` function instead of going through `proxy()`. Free
  tier: 1,000 calls/min on the Basic market-data plan, the most generous
  limit of any source this app uses. Base URL is hardcoded to
  `https://data.alpaca.markets/v1beta1` inside `proxyAlpaca()` (only one
  base is needed, unlike `proxy()` which is shared across 4 APIs).
- **World Bank Open Data** (added 2026-09-21) — multi-country macro
  indicators (GDP, inflation, unemployment, 20,000+ more), for countries
  FRED doesn't cover (FRED is US-only by definition). Needs **no API key
  at all** — genuinely public, no signup — confirmed live it has **zero
  CORS support** of its own (same situation as FRED), so it's always
  proxied through here too. Reuses the generic `proxy()` function with
  `keyRequired: false` and no key, same pattern as CoinGecko's optional
  key.

## Caching

Every response is cached at Cloudflare's edge (`caches.default`) with a
per-path TTL (`cacheTTL()`) — quotes get 30s, filings/financials/earnings
calendar/FRED series get an hour (they barely change within a day),
everything else gets 2 minutes. This is a normal per-edge-location cache,
not shared globally across every Cloudflare data center — a visitor
hitting a different location can trigger its own live fetch even if
another location's cache is already warm for that request. Accepted
trade-off; see the KV section below for why a global cache isn't worth
the complexity here.

## Removed: Workers KV + cron pre-warming (2026-08-04, removed 2026-08-07)

This Worker briefly had a `scheduled()` cron handler (every 5 minutes)
that proactively wrote ~36 curated symbols + a crypto batch into a KV
namespace, so real visitors could read from a globally-warm cache instead
of calling Finnhub/CoinGecko directly. It worked, but the math didn't fit
the free tier it was built on: 288 cron runs/day × 37 KV writes/run ≈
10,600 writes/day against Workers KV's free-tier cap of 1,000 writes/day
— the account was blowing past the quota roughly an hour into every day,
which triggered Cloudflare's recurring "KV operations nearing daily cap"
emails. Removed in favor of the refresh-on-demand Cache API approach
above — real requests just use the existing per-edge cache, so usage
tracks actual traffic instead of running a fixed, traffic-independent
sweep around the clock. Don't re-add a cron+KV pre-warm layer without
redoing this math against whatever the actual traffic/tier situation is
at the time.

## CORS

Allowed from any origin on every response (`access-control-allow-origin:
*`). Deliberate: FRED has zero CORS support, so even local frontend dev
needs this proxy reachable cross-origin; the data returned isn't
user-specific or sensitive, and the actual secrets never leave this file
regardless of who's asking.

## Secrets

`FINNHUB_API_KEY`, `TWELVE_DATA_API_KEY`, `FRED_API_KEY`,
`COINGECKO_API_KEY`, `ALPACA_API_KEY_ID`, and `ALPACA_API_SECRET_KEY` are
set as Cloudflare secrets (Settings → Variables and secrets, or `wrangler
secret put <NAME>`), read via `env` in `worker.js`. Never committed
anywhere — there's no local `config.js` equivalent in this repo since it
has no direct-call/local-dev mode of its own (see README's "Local
development"). World Bank needs no secret at all.

Cloudflare's "Variables cannot be added to a Worker that only has static
assets" error (a leftover quirk from the pre-split combined project) goes
away once a deploy has actually picked up the current `wrangler.jsonc` —
if this ever recurs, check a deploy ran with the current config before
assuming secrets are broken.
