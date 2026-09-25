import { checkName } from "../../namefilter.js";
import { Session } from "./session.js";

/**
 * The numbers terminal leaderboard.
 *
 *   GET  /v1/play (WebSocket)   play a ranked terminal: the server runs it and times it (session.js)
 *   GET  /v1/scores?count=14&mode=all|click|drop|hover[&old=1]   a board (each name's best); old=1
 *        for the old times, reported by browsers before terminals ran on the server
 *   GET  /v1/name?name=Beejona&owner=<sha-256 of key>    whether a name is free, yours or taken
 *   POST /v1/admin/remove {name, block}   (Authorization: Bearer ADMIN_TOKEN) take a name off
 *   GET  /v1/admin/run?name=&count=&mode=[&old=1]  (Authorization: Bearer ADMIN_TOKEN) a best run's record
 *
 * Ranked runs work the way SkyBlock's terminals do: the server makes the terminal, every click goes
 * to it with the current window id, and it times the run itself, so no time comes from the browser.
 * Each run lives in its own Durable Object (TerminalSession) for the length of the connection.
 * Names are checked here (namefilter.js) whatever the page did, and a name belongs to the browser
 * key that first used it, so nobody can play as someone else.
 *
 * Abuse limits: every address gets READ_LIMIT / POST_LIMIT requests a minute (Cloudflare's rate
 * limiter, so no addresses are kept here; each terminal is one request), at most NEW_NAMES_PER_DAY
 * new names a day, and boards are served from a few seconds' cache.
 */

const COUNTS = new Set([10, 14]);
const MODES = new Set(["click", "drop", "hover"]);
const BOARD_SIZE = 100;
const MAX_BODY = 1024;
const NEW_NAMES_PER_DAY = 5;
const BOARD_CACHE_MS = 10_000;

// Boards recently read, per instance of the Worker: { "ranked_scores|14|all": { at, body } }.
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
      if (url.pathname === "/v1/play" && request.method === "GET") return play(request, env);
      if (url.pathname === "/v1/scores" && request.method === "GET") return json(await board(url, env), 200, cors);
      // Times aren't posted any more: pages from before ranked terminals are told to refresh.
      if (url.pathname === "/v1/scores" && request.method === "POST") {
        return json({ error: "Runs are timed by the server now. Refresh the page." }, 410, cors);
      }
      if (url.pathname === "/v1/name" && request.method === "GET") return json(await nameStatus(url, env), 200, cors);
      if (url.pathname === "/v1/admin/remove" && request.method === "POST") return await remove(request, env, cors);
      if (url.pathname === "/v1/admin/run" && request.method === "GET") return await runRecord(request, url, env, cors);
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

const tableFor = url => (url.searchParams.get("old") === "1" ? "scores" : "ranked_scores");

async function board(url, env) {
  const count = Number(url.searchParams.get("count") || 14);
  const mode = url.searchParams.get("mode") || "all";
  if (!COUNTS.has(count)) return { error: "Unknown terminal size." };
  if (mode !== "all" && !MODES.has(mode)) return { error: "Unknown mode." };
  const table = tableFor(url);
  const cacheKey = `${table}|${count}|${mode}`;
  const cached = boardCache.get(cacheKey);
  if (cached && Date.now() - cached.at < BOARD_CACHE_MS) return cached.body;
  const body = { ...(await readBoard(table, count, mode, env)), old: table === "scores" };
  boardCache.set(cacheKey, { at: Date.now(), body });
  return body;
}

async function readBoard(table, count, mode, env) {
  let rows;
  if (mode === "all") {
    // Each name's single best across modes. SQLite fills the other columns from the MIN() row.
    ({ results: rows } = await env.DB.prepare(
      `SELECT name, MIN(time_ms) AS time_ms, mode, ping, updated_at FROM ${table}
       WHERE count = ?1 GROUP BY name_key ORDER BY time_ms ASC, updated_at ASC LIMIT ?2`
    ).bind(count, BOARD_SIZE).all());
  } else {
    ({ results: rows } = await env.DB.prepare(
      `SELECT name, time_ms, mode, ping, updated_at FROM ${table}
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
 * Counts a new name against this address's allowance for the day: null while there's some left, or
 * why not. The address is only kept hashed with a secret, and old days are dropped. Without the
 * secret the hash would be easy to reverse (there aren't many addresses), so no names are made.
 */
async function newNameRefusal(address, env) {
  if (!env.ADMIN_TOKEN) return "New names can't be made right now.";
  const day = Math.floor(Date.now() / 86_400_000);
  const who = await sha256(`${env.ADMIN_TOKEN}|${address}`);
  const row = await env.DB.prepare(
    `INSERT INTO name_claims (who, day, n) VALUES (?1, ?2, 1)
     ON CONFLICT (who, day) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(who, day).first();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM name_claims WHERE day < ?1").bind(day - 1).run();
  return row.n <= NEW_NAMES_PER_DAY ? null : "Too many new names today. Try again tomorrow.";
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

/** A ranked terminal: the connection is handed to its own TerminalSession. */
function play(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket.", { status: 426 });
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  if (!allowed.includes(request.headers.get("Origin") || "")) return new Response("Not allowed.", { status: 403 });
  return env.SESSIONS.get(env.SESSIONS.newUniqueId()).fetch(request);
}

/** Why [name] (with this browser [key]) can't play ranked, or null if it can. */
export async function playerProblem(env, name, key) {
  const check = checkName(name);
  if (!check.ok) return check.reason;
  if (typeof key !== "string" || !/^[a-f0-9]{32,128}$/.test(key)) return "Bad request.";
  const nameKey = name.toLowerCase();
  if (await env.DB.prepare("SELECT 1 FROM blocked_names WHERE name_key = ?1").bind(nameKey).first()) return "That name isn't allowed.";
  const holder = await env.DB.prepare("SELECT owner FROM names WHERE name_key = ?1").bind(nameKey).first();
  if (holder && holder.owner !== (await sha256(key))) return "That name is already taken.";
  return null;
}

/** Puts a finished ranked run on the board (only ever keeping a name's faster time). */
export async function saveRun(env, { name, key, address, count, mode, time, ping, run }) {
  const problem = await playerProblem(env, name, key);
  if (problem) return { error: problem };
  const nameKey = name.toLowerCase();
  const now = Date.now();
  const holder = await env.DB.prepare("SELECT name FROM names WHERE name_key = ?1").bind(nameKey).first();
  const shownName = holder ? holder.name : name;
  if (!holder) {
    const refusal = await newNameRefusal(address, env);
    if (refusal) return { error: refusal };
    await env.DB.prepare("INSERT INTO names (name_key, name, owner, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(nameKey, name, await sha256(key), now).run();
  }
  await env.DB.prepare(
    `INSERT INTO ranked_scores (count, mode, name_key, name, time_ms, ping, updated_at, run) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (count, mode, name_key) DO UPDATE SET time_ms = excluded.time_ms, ping = excluded.ping,
       name = excluded.name, updated_at = excluded.updated_at, run = excluded.run
     WHERE excluded.time_ms < ranked_scores.time_ms`
  ).bind(count, mode, nameKey, shownName, time, ping, now, JSON.stringify(run)).run();
  boardCache.clear();
  const best = await env.DB.prepare("SELECT time_ms FROM ranked_scores WHERE count = ?1 AND mode = ?2 AND name_key = ?3")
    .bind(count, mode, nameKey).first();
  const ahead = await env.DB.prepare("SELECT COUNT(*) AS n FROM ranked_scores WHERE count = ?1 AND mode = ?2 AND time_ms < ?3")
    .bind(count, mode, best.time_ms).first();
  return { ok: true, name: shownName, best_ms: best.time_ms, improved: best.time_ms === time, rank: ahead.n + 1 };
}

/**
 * One ranked terminal's connection (a Durable Object per terminal, so its state and clock live in
 * one place for the whole run).
 */
export class TerminalSession {
  constructor(ctx, env) {
    this.env = env;
  }

  async fetch(request) {
    const { 0: client, 1: socket } = new WebSocketPair();
    socket.accept();
    const env = this.env;
    const address = clientKey(request);
    const session = new Session({
      send: data => socket.send(JSON.stringify(data)),
      close: (code, reason) => socket.close(code, reason),
      checkName: (name, key) => playerProblem(env, name, key),
      save: run => saveRun(env, { ...run, address })
    });
    socket.addEventListener("message", event => { session.onMessage(event.data).catch(error => console.error(error)); });
    socket.addEventListener("close", () => session.end(1000, "closed"));
    return new Response(null, { status: 101, webSocket: client });
  }
}

async function isAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return Boolean(env.ADMIN_TOKEN) && (await sameSecret(auth, `Bearer ${env.ADMIN_TOKEN}`));
}

/** A best run's record, for looking into a suspicious time. */
async function runRecord(request, url, env, cors) {
  if (!(await isAdmin(request, env))) return json({ error: "Not allowed." }, 401, cors);
  const row = await env.DB.prepare(
    `SELECT name, time_ms, ping, updated_at, run FROM ${tableFor(url)} WHERE name_key = ?1 AND count = ?2 AND mode = ?3`
  ).bind(String(url.searchParams.get("name") || "").toLowerCase(), Number(url.searchParams.get("count")), url.searchParams.get("mode")).first();
  if (!row) return json({ error: "No such run." }, 404, cors);
  return json({ ...row, run: row.run ? JSON.parse(row.run) : null }, 200, cors);
}

async function remove(request, env, cors) {
  if (!(await isAdmin(request, env))) return json({ error: "Not allowed." }, 401, cors);
  const body = await readBody(request);
  if (!body || typeof body.name !== "string") return json({ error: "Bad request." }, 400, cors);
  const nameKey = body.name.toLowerCase();
  const removed = await env.DB.batch([
    env.DB.prepare("DELETE FROM scores WHERE name_key = ?1").bind(nameKey),
    env.DB.prepare("DELETE FROM ranked_scores WHERE name_key = ?1").bind(nameKey),
    env.DB.prepare("DELETE FROM names WHERE name_key = ?1").bind(nameKey),
    ...(body.block ? [env.DB.prepare("INSERT OR IGNORE INTO blocked_names (name_key, blocked_at) VALUES (?1, ?2)").bind(nameKey, Date.now())] : [])
  ]);
  boardCache.clear();
  return json({ ok: true, scoresRemoved: removed[0].meta.changes + removed[1].meta.changes, blocked: Boolean(body.block) }, 200, cors);
}
