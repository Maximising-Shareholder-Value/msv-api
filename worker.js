// $MSV backend — a Cloudflare Worker, API-only. This repo (msv-api) used
// to be combined with the frontend in one repo/deployment, where this
// same file also served the static site via an `assets` binding
// (wrangler.jsonc's `run_worker_first: ["/api/*"]` routed only /api/*
// here, everything else fell through to the static files). Split into
// its own repo/deployment (2026-09) — the frontend (msv-web) now deploys
// separately (Cloudflare Pages) and calls this Worker's absolute URL via
// API_BASE_URL (see msv-web's script.js). No assets binding here anymore;
// this Worker does nothing but proxy the four APIs below.
//
// The whole point: FINNHUB_API_KEY, TWELVE_DATA_API_KEY, FRED_API_KEY,
// COINGECKO_API_KEY, ALPACA_API_KEY_ID, and ALPACA_API_SECRET_KEY are set
// as secrets in the Cloudflare dashboard (Settings → Variables and
// secrets), readable only here via `env`, never sent to the browser. The
// page calls /api/finnhub, /api/twelvedata, /api/fred, /api/coingecko,
// and /api/alpaca instead of calling those APIs directly.
//
// Caching: every response is cached at Cloudflare's edge (`caches.default`)
// with a per-path TTL (see cacheTTL()), refreshed on demand — the first
// request for something after its TTL expires does a real live fetch and
// re-populates the cache; every request in between is served from cache
// with zero upstream API usage. This is a normal per-edge-location cache,
// not shared globally across every Cloudflare data center — a visitor
// hitting a different location can trigger its own live fetch even if
// another location's cache is still warm. That's an accepted trade-off.
//
// PREVIOUSLY this also had a Workers KV + cron-trigger layer that
// proactively refreshed ~36 curated symbols every 5 minutes into a
// globally-shared cache, specifically to avoid that per-location gap.
// Removed (2026-08-07): the cron ran 288x/day and each run wrote 37 KV
// entries — ~10,600 writes/day against Workers KV's free-tier cap of
// 1,000 writes/day, which is what was triggering Cloudflare's daily usage
// warning emails. For a personal-dashboard traffic level, the per-location
// Cache API on its own (below) is enough: real requests only happen when
// someone's actually looking at the page, so usage naturally tracks
// traffic instead of running a fixed, traffic-independent sweep around
// the clock. If a future need for a truly global instant cache comes up,
// that's a deliberate re-introduction, not something to casually re-add.
//
// CORS is allowed from any origin on these responses. That's deliberate:
// FRED has no CORS support of its own, so even local development (running
// on localhost, a different origin than this Worker) has to call this
// proxy directly — there's no way around that without also running a
// local proxy, which isn't worth it for one API. The data returned isn't
// user-specific or sensitive; the actual secrets never leave this file.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/finnhub") {
      return proxy(url, "https://finnhub.io/api/v1", "token", env.FINNHUB_API_KEY, "FINNHUB_API_KEY", ctx);
    }
    if (url.pathname === "/api/twelvedata") {
      return proxy(url, "https://api.twelvedata.com", "apikey", env.TWELVE_DATA_API_KEY, "TWELVE_DATA_API_KEY", ctx);
    }
    if (url.pathname === "/api/fred") {
      return proxy(url, "https://api.stlouisfed.org/fred", "api_key", env.FRED_API_KEY, "FRED_API_KEY", ctx);
    }
    if (url.pathname === "/api/coingecko") {
      return proxy(url, "https://api.coingecko.com/api/v3", "x_cg_demo_api_key", env.COINGECKO_API_KEY, "COINGECKO_API_KEY", ctx, false);
    }
    if (url.pathname === "/api/alpaca") {
      return proxyAlpaca(url, env, ctx);
    }
    if (url.pathname === "/api/worldbank") {
      // World Bank's Indicators API needs no key at all — genuinely
      // public, no signup — so this reuses proxy() with keyRequired:false
      // and no key, same as how CoinGecko's optional key works above.
      // Added 2026-09-21 for the multi-country macro dashboard (FRED,
      // still used for the US-only Macro tab, has no other-country data).
      return proxy(url, "https://api.worldbank.org/v2", null, null, null, ctx, false);
    }

    return jsonResponse({ error: "Not found. This Worker only serves /api/finnhub, /api/twelvedata, /api/fred, /api/coingecko, /api/alpaca, and /api/worldbank — the frontend lives in the msv-web repo." }, 404);
  },
};

// How long to cache each kind of request, in seconds. Quotes change fast
// (short cache); filings/financials/earnings calendar/FRED economic data
// barely change within a day (long cache); everything else is a
// reasonable middle ground. Tune per-path rather than one blanket value,
// since caching a quote for an hour would make the dashboard feel stale,
// but caching a 10-K filing list for only 20 seconds wastes the cache
// entirely.
function cacheTTL(path) {
  // Bumped 20s -> 30s (2026-08-07) as part of a broader push to reduce
  // real Finnhub usage now that KV pre-warming is gone — a personal
  // dashboard doesn't need quotes fresher than 30s, and this cuts real
  // upstream hits for popular symbols by roughly a third under repeat
  // traffic within the same edge location.
  if (path === "/quote" || path === "/simple/price") return 30;
  if (
    path === "/stock/filings" ||
    path === "/stock/financials-reported" ||
    path === "/calendar/earnings" ||
    path === "/search" ||
    path === "/series/observations" // FRED — monthly/quarterly data, safe to cache for hours
  ) return 3600;
  return 120;
}

async function proxy(url, apiBase, keyParamName, key, keyEnvName, ctx, keyRequired = true) {
  const path = url.searchParams.get("path");
  if (!path) {
    return jsonResponse({ error: "Missing 'path' parameter" }, 400);
  }
  if (keyRequired && !key) {
    return jsonResponse({ error: `${keyEnvName} not configured on the server` }, 500);
  }

  const search = new URLSearchParams(url.searchParams);
  search.delete("path");
  if (key) search.set(keyParamName, key);
  const targetUrl = `${apiBase}${path}?${search.toString()}`;

  const cache = caches.default;
  const cacheKey = new Request(targetUrl);

  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  try {
    const res = await fetch(targetUrl);
    const body = await res.text();
    const response = new Response(body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        "cache-control": res.ok ? `public, max-age=${cacheTTL(path)}` : "no-store",
      },
    });
    if (res.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return withCors(response);
  } catch {
    return jsonResponse({ error: "Upstream request failed" }, 502);
  }
}

// Alpaca authenticates via two HTTP headers (Apca-Api-Key-Id /
// Apca-Api-Secret-Key), not a single query-string key like the other
// four APIs — hence its own small proxy function rather than forcing it
// through proxy()'s query-param-key shape. The paper-trading credentials
// (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY) also work against Alpaca's
// market-data API — added 2026-09-21 for options coverage, the one asset
// class this app previously had zero data for (Finnhub's free tier has
// none, confirmed via a live request against /etf/* and /stock/metric).
async function proxyAlpaca(url, env, ctx) {
  const path = url.searchParams.get("path");
  if (!path) {
    return jsonResponse({ error: "Missing 'path' parameter" }, 400);
  }
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) {
    return jsonResponse({ error: "ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY not configured on the server" }, 500);
  }

  const search = new URLSearchParams(url.searchParams);
  search.delete("path");
  const targetUrl = `https://data.alpaca.markets/v1beta1${path}?${search.toString()}`;

  const cache = caches.default;
  const cacheKey = new Request(targetUrl);

  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "Apca-Api-Key-Id": env.ALPACA_API_KEY_ID,
        "Apca-Api-Secret-Key": env.ALPACA_API_SECRET_KEY,
      },
    });
    const body = await res.text();
    const response = new Response(body, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        "cache-control": res.ok ? `public, max-age=${cacheTTL(path)}` : "no-store",
      },
    });
    if (res.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return withCors(response);
  } catch {
    return jsonResponse({ error: "Upstream request failed" }, 502);
  }
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, headers });
}

function jsonResponse(obj, status) {
  return withCors(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
}
