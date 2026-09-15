# msv-api

The backend for [$MSV](https://github.com/Maximising-Shareholder-Value/msv-web) — a Cloudflare Worker that proxies four free-tier
financial data APIs (Finnhub, Twelve Data, FRED, CoinGecko) so their real
API keys never reach the browser.

This repo is **API-only** — no HTML/CSS/JS frontend lives here. The
frontend is [msv-web](https://github.com/Maximising-Shareholder-Value/msv-web), deployed separately (Cloudflare Pages) and pointed at
this Worker's URL via `API_BASE_URL`.

## What it does

A single `worker.js` handles four routes:

- `/api/finnhub` → proxies `finnhub.io/api/v1`
- `/api/twelvedata` → proxies `api.twelvedata.com`
- `/api/fred` → proxies `api.stlouisfed.org/fred`
- `/api/coingecko` → proxies `api.coingecko.com/api/v3`

Every request needs a `path` query param naming the upstream endpoint
(e.g. `?path=/quote&symbol=AAPL`); everything else in the query string is
forwarded as-is, with the real API key attached server-side. Responses
are cached at Cloudflare's edge with per-endpoint TTLs (see `cacheTTL()`
in `worker.js`) — repeat requests for the same thing within the TTL never
hit the upstream API at all.

## Local development

There isn't really a "local dev" mode for this repo specifically —
`msv-web`'s frontend calls the real APIs directly when running on
`localhost` (using its own `config.js`), and only routes through this
Worker once deployed. To test this Worker itself locally:

```
npm install -g wrangler   # if you don't have it
wrangler dev
```

You'll need the four API keys as local secrets for `wrangler dev` to
actually proxy anything — see "Deploying" below for where they come from.

## Deploying

1. `wrangler deploy` (or connect this repo to Cloudflare's dashboard —
   **Workers & Pages** → **Create** → **Connect to Git** — for
   auto-deploy on push).
2. In the Cloudflare dashboard, **Settings → Variables and secrets**, add
   four **secrets**: `FINNHUB_API_KEY`, `TWELVE_DATA_API_KEY`,
   `FRED_API_KEY`, `COINGECKO_API_KEY`. Free keys:
   [Finnhub](https://finnhub.io/register) (required for anything to
   work) · [Twelve Data](https://twelvedata.com/pricing) · [FRED](https://fredaccount.stlouisfed.org/apikeys) ·
   [CoinGecko](https://www.coingecko.com/en/developers/dashboard) (this
   one's optional — CoinGecko's public tier works without a key, just
   with a lower shared rate limit).
3. Take note of the deployed URL (e.g. `https://msv-api.<you>.workers.dev`)
   and set it as `API_BASE_URL` in `msv-web`'s `script.js`.

## Why a Worker, not classic Pages Functions

This is a genuine Cloudflare Worker project, not a classic Pages project
with a `functions/` folder — that convention only auto-detects on
Pages-style projects. If Cloudflare's dashboard ever shows "Variables
cannot be added to a Worker that only has static assets," it means it
hasn't picked up a deploy with the current `wrangler.jsonc` yet — trigger
a new deployment first, then add secrets.

## Notes on rate limits and caching

- Finnhub's free tier is 60 requests/minute, shared across every visitor
  hitting this Worker (not per-visitor) — the edge cache exists
  specifically to keep real upstream calls well under that.
- This Worker briefly had a Workers KV + cron-trigger layer that
  proactively refreshed popular symbols in the background. Removed — the
  cron math didn't fit KV's free-tier write cap (see `worker.js`'s
  comments for the numbers). Don't re-add a background pre-warm layer
  without redoing that math against actual traffic first.
- See `CLAUDE.md` for the fuller history of decisions made building this.
