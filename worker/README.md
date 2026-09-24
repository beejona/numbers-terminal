# Leaderboard server

A Cloudflare Worker with a D1 database, live at
https://numbers-terminal-leaderboard.numbers-terminal-leaderboard.workers.dev (the page finds it
through the `leaderboard-api` meta tag in `index.html`).

Deploy a change (from this folder, logged in with `npx wrangler login`): `npx wrangler deploy`.
A schema change goes in a new file in `migrations/`, applied with
`npx wrangler d1 migrations apply numbers-terminal-leaderboard --remote`.

Take a name off the board (add `"block": true` to stop it being used again). The admin token is a
Worker secret; the owner keeps a copy outside this repo.

    curl -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
      -d '{"name": "SomeName", "block": true}' \
      https://numbers-terminal-leaderboard.numbers-terminal-leaderboard.workers.dev/v1/admin/remove

Tests: `node test/run.mjs` (the Worker against node:sqlite standing in for D1) and
`node test/serve.mjs` (runs it on http://127.0.0.1:8787; open the page with
`?api=http://127.0.0.1:8787`).
