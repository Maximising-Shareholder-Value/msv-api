# Contributing to msv-api

Thanks for taking a look. This is the backend proxy for
[$MSV](https://github.com/Maximising-Shareholder-Value/msv-web) — if
you're looking for the frontend/UI code, that lives in
[msv-web](https://github.com/Maximising-Shareholder-Value/msv-web) instead.

## Before you start

Open an issue first for anything beyond a small fix — this Worker is
intentionally minimal (one file, four proxy routes), and changes here
affect a live public deployment other people rely on.

## Local setup

See the README's "Local development" section. In short: `wrangler dev`,
with the four API keys available as local secrets to actually proxy
anything real.

## Making a change

1. Fork the repo, branch off `main`.
2. Keep `worker.js` focused — it should only ever proxy the four existing
   APIs (or a newly agreed-upon fifth). Don't add frontend-facing logic
   here; that belongs in `msv-web`.
3. If you're adding a new upstream API or endpoint, check whether it has
   real CORS support before assuming it needs to go through this proxy
   at all — direct browser calls are simpler when they work.
4. Open a PR against `main`. Describe what changed and why, and mention
   which API(s) it affects so a review can double-check rate limits /
   caching behavior.

## Reporting a bug

Include: the request that failed (path + params, with your API key
redacted if you're testing locally), what you expected, and what
actually came back. If it's a live-site issue, note whether it reproduces
consistently or intermittently — a lot of bugs in this kind of proxy are
rate-limit-related and only show up under load.
