import { checkName } from "../../namefilter.js";

/**
 * The numbers terminal leaderboard.
 *
 *   GET  /v1/scores?count=14&mode=all|click|drop|hover   the board (each name's best)
 *   GET  /v1/name?name=Beejona&owner=<sha-256 of key>    whether a name is free, yours or taken
 *   POST /v1/scores {name, key, count, mode, ping, time_ms}   post a run; keeps only a name's best
 *   POST /v1/admin/remove {name, block}   (Authorization: Bearer ADMIN_TOKEN) take a name off
 *
 * Times come from the player's browser, so they can't be proven - only checked for being possible.
 * Names are checked here (namefilter.js) whatever the page did, and a name belongs to the browser
 * key that first posted with it, so nobody can post as someone else.
 *
 * Abuse limits: every address gets READ_LIMIT / POST_LIMIT requests a minute (Cloudflare's rate
 * limiter, so no addresses are kept here), at most NEW_NAMES_PER_DAY new names a day, and boards
 * are served from a few seconds' cache so a crowd watching them barely touches the database.
 */

const COUNTS = new Set([10, 14]);
const MODES = new Set(["click", "drop", "hover"]);
// Nobody finishes a terminal faster than this, whatever the size or mode: the best real runs are
// well over it. (It was 25 ms a pane - 0.35 s for 14 - and scripted runs sat just above that.)
const MIN_TIME_MS = 500;
const MAX_TIME_MS = 60_000;
const MAX_PING = 400;
const BOARD_SIZE = 100;
const MAX_BODY = 1024;
const NEW_NAMES_PER_DAY = 5;
const BOARD_CACHE_MS = 10_000;

// Boards recently read, per instance of the Worker: { "14|all": { at, body } }.
const boardCache = new Map();

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    try {
      const limiter = request.method === "GET" ? env.READ_LIMIT : env.POST_LIMIT;
      if (limiter && !(await limiter.limit({ key: clientKey(request) })).success) {
        return json({ error: "Slow down a little." }, 429, cors);
      }
      if (url.pathname === "/v1/scores" && request.method === "GET") return json(await board(url, env), 200, cors);
      if (url.pathname === "/v1/scores" && request.method === "POST") return await post(request, env, cors);
      if (url.pathname === "/v1/name" && request.method === "GET") return json(await nameStatus(url, env), 200, cors);
      if (url.pathname === "/v1/admin/remove" && request.method === "POST") return await remove(request, env, cors);
      return json({ error: "Not found." }, 404, cors);
    } catch (error) {
      console.error(error);
      return json({ error: "Something went wrong on the leaderboard." }, 500, cors);
    }
  }
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body, status, headers) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

/**
 * Who's asking, for the limits: the address, or for IPv6 its /64 - one home or phone gets a
 * whole /64, so limiting single IPv6 addresses would limit nothing.
 */
function clientKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return groups.slice(0, 4).map(g => g.padStart(4, "0")).join(":") + "::/64";
}

/** Compares two strings in time that doesn't depend on where they differ. */
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const left = new Uint8Array(x), right = new Uint8Array(y);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function board(url, env) {
  const count = Number(url.searchParams.get("count") || 14);
  const mode = url.searchParams.get("mode") || "all";
  if (!COUNTS.has(count)) return { error: "Unknown terminal size." };
  if (mode !== "all" && !MODES.has(mode)) return { error: "Unknown mode." };
  const cacheKey = `${count}|${mode}`;
  const cached = boardCache.get(cacheKey);
  if (cached && Date.now() - cached.at < BOARD_CACHE_MS) return cached.body;
  const body = await readBoard(count, mode, env);
  boardCache.set(cacheKey, { at: Date.now(), body });
  return body;
}

async function readBoard(count, mode, env) {
  let rows;
  if (mode === "all") {
    // Each name's single best across modes. SQLite fills the other columns from the MIN() row.
    ({ results: rows } = await env.DB.prepare(
      `SELECT name, MIN(time_ms) AS time_ms, mode, ping, updated_at FROM scores
       WHERE count = ?1 GROUP BY name_key ORDER BY time_ms ASC, updated_at ASC LIMIT ?2`
    ).bind(count, BOARD_SIZE).all());
  } else {
    ({ results: rows } = await env.DB.prepare(
      `SELECT name, time_ms, mode, ping, updated_at FROM scores
       WHERE count = ?1 AND mode = ?2 ORDER BY time_ms ASC, updated_at ASC LIMIT ?3`
    ).bind(count, mode, BOARD_SIZE).all());
  }
  return { count, mode, scores: rows.map((row, index) => ({ rank: index + 1, ...row })) };
}

async function nameStatus(url, env) {
  const name = url.searchParams.get("name") || "";
  const owner = url.searchParams.get("owner") || "";
  const check = checkName(name);
  if (!check.ok) return { status: "invalid", reason: check.reason };
  const key = name.toLowerCase();
  if (await env.DB.prepare("SELECT 1 FROM blocked_names WHERE name_key = ?1").bind(key).first()) {
    return { status: "invalid", reason: "That name isn't allowed." };
  }
  const row = await env.DB.prepare("SELECT owner FROM names WHERE name_key = ?1").bind(key).first();
  if (!row) return { status: "free" };
  return { status: row.owner === owner ? "yours" : "taken" };
}

/**
 * Counts a new name against this address's allowance for the day; false once it's used up. The
 * address is only kept hashed with a secret, and old days are dropped.
 */
async function mayClaimName(request, env) {
  const day = Math.floor(Date.now() / 86_400_000);
  const who = await sha256(`${env.ADMIN_TOKEN || ""}|${clientKey(request)}`);
  const row = await env.DB.prepare(
    `INSERT INTO name_claims (who, day, n) VALUES (?1, ?2, 1)
     ON CONFLICT (who, day) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(who, day).first();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM name_claims WHERE day < ?1").bind(day - 1).run();
  return row.n <= NEW_NAMES_PER_DAY;
}

async function readBody(request) {
  // Turn big bodies away before reading them.
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function post(request, env, cors) {
  const body = await readBody(request);
  if (!body) return json({ error: "Bad request." }, 400, cors);
  const { name, key, count, mode, ping, time_ms: time } = body;

  const check = checkName(name);
  if (!check.ok) return json({ error: check.reason }, 400, cors);
  if (typeof key !== "string" || !/^[a-f0-9]{32,128}$/.test(key)) return json({ error: "Bad request." }, 400, cors);
  if (!COUNTS.has(count) || !MODES.has(mode)) return json({ error: "Bad request." }, 400, cors);
  if (!Number.isInteger(ping) || ping < 0 || ping > MAX_PING) return json({ error: "Bad request." }, 400, cors);
  if (!Number.isInteger(time) || time < MIN_TIME_MS || time > MAX_TIME_MS) {
    return json({ error: "That time isn't possible." }, 400, cors);
  }

  const nameKey = name.toLowerCase();
  if (await env.DB.prepare("SELECT 1 FROM blocked_names WHERE name_key = ?1").bind(nameKey).first()) {
    return json({ error: "That name isn't allowed." }, 400, cors);
  }
  const owner = await sha256(key);
  const now = Date.now();
  const holder = await env.DB.prepare("SELECT name, owner FROM names WHERE name_key = ?1").bind(nameKey).first();
  if (holder && holder.owner !== owner) return json({ error: "That name is already taken." }, 409, cors);
  const shownName = holder ? holder.name : name;
  if (!holder) {
    if (!(await mayClaimName(request, env))) return json({ error: "Too many new names today. Try again tomorrow." }, 429, cors);
    await env.DB.prepare("INSERT INTO names (name_key, name, owner, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(nameKey, name, owner, now).run();
  }

  // Only ever keeps the faster time.
  await env.DB.prepare(
    `INSERT INTO scores (count, mode, name_key, name, time_ms, ping, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (count, mode, name_key) DO UPDATE SET time_ms = excluded.time_ms, ping = excluded.ping,
       name = excluded.name, updated_at = excluded.updated_at
     WHERE excluded.time_ms < scores.time_ms`
  ).bind(count, mode, nameKey, shownName, time, ping, now).run();
  boardCache.clear();

  const best = await env.DB.prepare("SELECT time_ms FROM scores WHERE count = ?1 AND mode = ?2 AND name_key = ?3")
    .bind(count, mode, nameKey).first();
  const ahead = await env.DB.prepare("SELECT COUNT(*) AS n FROM scores WHERE count = ?1 AND mode = ?2 AND time_ms < ?3")
    .bind(count, mode, best.time_ms).first();
  return json({ ok: true, name: shownName, best_ms: best.time_ms, improved: best.time_ms === time, rank: ahead.n + 1 }, 200, cors);
}

async function remove(request, env, cors) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN || !(await sameSecret(auth, `Bearer ${env.ADMIN_TOKEN}`))) return json({ error: "Not allowed." }, 401, cors);
  const body = await readBody(request);
  if (!body || typeof body.name !== "string") return json({ error: "Bad request." }, 400, cors);
  const nameKey = body.name.toLowerCase();
  const removed = await env.DB.batch([
    env.DB.prepare("DELETE FROM scores WHERE name_key = ?1").bind(nameKey),
    env.DB.prepare("DELETE FROM names WHERE name_key = ?1").bind(nameKey),
    ...(body.block ? [env.DB.prepare("INSERT OR IGNORE INTO blocked_names (name_key, blocked_at) VALUES (?1, ?2)").bind(nameKey, Date.now())] : [])
  ]);
  boardCache.clear();
  return json({ ok: true, scoresRemoved: removed[0].meta.changes, blocked: Boolean(body.block) }, 200, cors);
}
