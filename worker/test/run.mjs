// The leaderboard server, tested in Node: node:sqlite stands in for D1 (Cloudflare's local runtime
// needs macOS 13.5+), and terminals are played through Session with a clock the test controls.
//   node worker/test/run.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import worker, { saveRun, playerProblem } from "../src/index.js";
import { Session, TerminalGame, TICK_MS, QUEUE_LIMIT, MAX_MESSAGES_PER_SECOND } from "../src/session.js";
import { checkRun } from "../src/checkrun.js";
import { humanRun, randomSource } from "./humanrun.mjs";

/** Enough of D1's API for the Worker: prepare().bind().first()/all()/run(), and batch(). */
function d1(db) {
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: r.changes } }; }
  });
  return { prepare: sql => statement(sql), async batch(list) { return Promise.all(list.map(s => s.run())); } };
}
/** Cloudflare's rate limiter: so many calls per key per minute. */
function limiter(limit) {
  const counts = new Map();
  return { async limit({ key }) { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return { success: n <= limit }; } };
}

const db = new DatabaseSync(":memory:");
for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
  db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
}
const env = {
  DB: d1(db), ALLOWED_ORIGINS: "https://beejona.github.io", ADMIN_TOKEN: "admin-test-token",
  READ_LIMIT: limiter(120), POST_LIMIT: limiter(10)
};

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures++;
}
let nextIp = 1;
async function call(method, path, body, headers = {}) {
  const request = new Request(`https://leaderboard.test${path}`, {
    method, headers: { "Content-Type": "application/json", Origin: "https://beejona.github.io", "CF-Connecting-IP": headers.ip || `10.0.${nextIp >> 8}.${nextIp++ & 255}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const response = await worker.fetch(request, env);
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
}
const random = randomSource(42);
const keyA = "a".repeat(64), keyB = "b".repeat(64);
let address = 1;
const save = (over = {}) => {
  const run = { name: "Beejona", key: keyA, count: 14, mode: "click", time: 2500, ping: 30, address: `20.0.0.${address++}`, ...over };
  run.run ??= humanRun({ count: run.count, mode: run.mode, time: run.time, random });
  return saveRun(env, run);
};

// ---- playing a terminal ----------------------------------------------------------------------

/** A tiny event loop on a clock the test controls: sessions' waits and players' clicks, in time order. */
function simulation() {
  let clock = 1_000_000;
  let order = 0;
  const timers = [];
  const schedule = (at, fn) => timers.push({ at, fn, order: order++ });
  async function run(limit = 200_000) {
    while (limit-- > 0) {
      // Real async work (hashing a key, say) finishes outside this clock: give it a moment.
      for (let i = 0; i < 20 && !timers.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
      if (!timers.length) break;
      timers.sort((a, b) => a.at - b.at || a.order - b.order);
      const timer = timers.shift();
      clock = Math.max(clock, timer.at);
      timer.fn();
      await new Promise(resolve => setImmediate(resolve)); // let whatever woke up run to its next wait
    }
  }
  return { now: () => clock, wait: ms => new Promise(resolve => schedule(clock + ms, resolve)), schedule, run };
}

/**
 * Plays one terminal through a Session: a player who clicks pane after pane every [think](k) ms
 * without waiting on the server (pingless), [latency] ms each way, and goes back to a pane when the
 * server rejects it. Returns what the player heard.
 */
async function play({ count = 14, mode = "click", recordMode = mode, think = () => 150, latency = 20, player = null, forge = false } = {}) {
  const sim = simulation();
  const heard = [];
  let terminal = null, fake = null, next = 0, done = null, rejected = 0, kicked = false;
  const session = new Session({
    send: message => sim.schedule(sim.now() + latency, () => hear(message)), close: () => {},
    checkName: (name, key) => playerProblem(env, name, key),
    save: run => saveRun(env, { ...run, address: "30.0.0.1" }),
    now: sim.now, wait: sim.wait
  });
  const toServer = message => sim.schedule(sim.now() + latency, () => { session.onMessage(JSON.stringify(message)); });
  const sentPath = new Set();
  let arrived = 0, lastT = 0;
  function clickAt(k, delay) {
    sim.schedule(sim.now() + delay, () => {
      if (next !== k || done || kicked) return;
      const c = fake.clicks[k];
      // The record's times are when the player really clicked (unless [forge] makes them up), on
      // the page's clock from the terminal arriving; the path onto the pane is stretched to fit.
      const t = forge ? c.t : sim.now() - arrived;
      const from = k ? fake.clicks[k - 1].t : -1;
      const retime = time => forge ? time : +(lastT + (time - Math.max(0, from)) / (c.t - Math.max(0, from)) * (t - lastT)).toFixed(1);
      // The path goes once; a pane clicked again after a rejection has it on record already.
      const path = sentPath.has(k) ? [] : fake.path.filter(p => p[0] > from && p[0] <= c.t).map(([time, x, y]) => [retime(time), x, y]);
      sentPath.add(k);
      lastT = t;
      toServer({ type: "click", i: c.i, t, x: c.x, y: c.y, via: c.via, pointer: c.type, path, fill: fake.fill });
      next = k + 1;
      if (next < count) clickAt(next, think(next));
    });
  }
  function hear(message) {
    heard.push(message);
    if (message.type === "terminal") {
      terminal = message;
      arrived = sim.now();
      toServer({ type: "ready" });
      fake = humanRun({ count, mode: recordMode, time: 5000, random, layout: message.layout });
      clickAt(0, think(0));
    } else if (message.type === "rejected") {
      rejected++;
      const k = terminal.layout[message.i] - 1;
      if (k < next) { next = k; clickAt(k, think(k)); }
    } else if (message.type === "done") done = message;
    else if (message.type === "kicked") kicked = true;
  }
  toServer({ type: "start", count, mode, ...(player || {}) });
  await sim.run();
  session.end();
  if (process.env.DEBUG_PLAY) console.log("heard:", heard.map(m => `${m.type}${m.i !== undefined ? ":" + m.i : ""}${m.error ? " " + m.error : ""}`).join(" "));
  return { heard, done, rejected, kicked };
}

// A human-like run: ~150 ms a pane, 20 ms each way.
let thinking = 0;
let { done, rejected } = await play({ player: { name: "Beejona", key: keyA }, think: k => { const t = 120 + ((k * 37) % 60); thinking += t; return t; } });
check(done && done.ok && done.rank === 1, `a ranked run is timed by the server and saved (${done?.time_ms} ms, #${done?.rank})`);
check(done.time_ms % TICK_MS === 0, "the time is a whole number of server ticks");
check(rejected === 0, "a person clicking at their own pace never has a click rejected");
check(done.time_ms >= thinking && done.time_ms <= thinking + 2 * 20 + TICK_MS,
  `pingless: the ping adds once, not per pane (${done.time_ms} ms for ${thinking} ms of clicking at 40 ms round trip)`);
let row = db.prepare("SELECT time_ms, ping FROM ranked_scores WHERE name_key = 'beejona'").get();
check(row.time_ms === done.time_ms && row.ping === 40, `the board has the server's time and the measured ping (${row.ping} ms)`);

// Bots. One that clicks each pane the moment it can, at 0 ping: one pane a tick at best.
({ done } = await play({ player: { name: "SpeedBot", key: "c".repeat(64) }, think: () => TICK_MS, latency: 0 }));
check(done && done.time_ms === 14 * TICK_MS, `a zero-ping bot can't beat one pane a tick (${done?.time_ms} ms for 14)`);
({ done } = await play({ count: 10, think: () => TICK_MS, latency: 0 }));
check(done && done.time_ms === 10 * TICK_MS, `...or ${10 * TICK_MS} ms for 10 (${done?.time_ms})`);
// One that clicks every tick but sends a record of a slow, human run.
({ done } = await play({ player: { name: "SlowStory", key: "8".repeat(64) }, think: () => TICK_MS, latency: 5, forge: true }));
check(done && /before its record says/.test(done.error || "") && !db.prepare("SELECT 1 FROM ranked_scores WHERE name_key = 'slowstory'").get(),
  `a made-up record that's slower than the clicks really came isn't saved: "${done?.error}"`);
// One that fires every click at once: a few queue, the rest bounce, and it can't go faster anyway.
let kicked;
({ done, rejected, kicked } = await play({ think: () => 10, latency: 0 }));
check((done && done.time_ms >= 14 * TICK_MS) || kicked, `a bot firing clicks as fast as it can is throttled (${done ? done.time_ms + " ms" : "kicked"}, ${rejected} rejected)`);
({ done, kicked } = await play({ think: () => 1, latency: 0 }));
check(kicked && !done, "one hammering the server gets kicked, like \"You are clicking too fast\"");

// The queue and rejections, directly.
{
  const layout = [3, 1, 2, 4, 5, 6, 7, 8, 9, 10];
  const game = new TerminalGame({ count: 10, mode: "click", now: 0, layout });
  const at = n => layout.indexOf(n);
  check(game.click({ i: at(2), t: 1 }, 1)?.rejected === true, "a wrong pane is rejected");
  const accepted = [1, 2, 3, 4, 5].map(n => game.click({ i: at(n), t: n }, 2));
  check(accepted.every(r => r && !r.rejected) && accepted.map(r => r.tick).join() === "50,100,150,200,250",
    `${QUEUE_LIMIT} rapid clicks queue up, one tick apart`);
  check(game.click({ i: at(6), t: 6 }, 3)?.rejected === true, "the next rapid click is rejected: too many queued");
  check(game.click({ i: at(7), t: 7 }, 3)?.rejected === true, "and so is one after it, until the missed pane is clicked again");
  const again = game.click({ i: at(6), t: 8 }, 60);
  check(again && !again.rejected && again.tick === 300, "once a tick has cleared one, it's accepted (and still one pane a tick)");
}

// The page's record still has to check out: hovered panes aren't a click run.
({ done } = await play({ player: { name: "Hoverer", key: "d".repeat(64) }, recordMode: "hover" }));
check(done && /hovered/.test(done.error || "") && !db.prepare("SELECT 1 FROM ranked_scores WHERE name_key = 'hoverer'").get(), `a run whose record fails isn't saved: "${done?.error}"`);
({ done } = await play({ mode: "hover", player: { name: "Hoverer", key: "d".repeat(64) }, think: () => 60 }));
check(done && done.ok, "the same run as a hover run is fine");
let heard;
({ heard } = await play({ player: { name: "beejona", key: keyB } }));
check(heard[0].type === "error" && /taken/.test(heard[0].error), "someone else can't play as a taken name (any capitals)");
({ heard } = await play({ player: { name: "N1GG4_boy", key: keyB } }));
check(heard[0].type === "error" && /allowed/.test(heard[0].error), "a slur name can't play");
({ heard } = await play({ count: 12 }));
check(heard[0].type === "error", "an unknown terminal size is refused");

// ---- saving and boards -----------------------------------------------------------------------

let r = await save({ name: "Saver", key: keyB, time: 3000 });
check(r.ok && r.improved, "a first run saves");
r = await save({ name: "Saver", key: keyB, time: 3500 });
check(r.ok && !r.improved && r.best_ms === 3000, "a slower one doesn't replace the best");
r = await save({ name: "Saver", key: keyB, time: 2800 });
check(r.ok && r.improved && r.best_ms === 2800, "a faster one does");
await save({ name: "TenGuy", key: "e".repeat(64), count: 10, time: 1500 });
await save({ name: "Sweeper", key: "f".repeat(64), mode: "hover", time: 1200 });
db.prepare("INSERT INTO scores (count, mode, name_key, name, time_ms, ping, updated_at) VALUES (14, 'hover', 'oldtimer', 'OldTimer', 900, 0, 1)").run();

r = await call("GET", "/v1/scores?count=14&mode=all");
const times = r.body.scores.map(s => s.time_ms);
check(times.every((t, k) => k === 0 || t >= times[k - 1]) && r.body.scores.some(s => s.name === "Saver" && s.time_ms === 2800) && !r.body.old,
  "the ranked board lists each name's best, fastest first");
check(!r.body.scores.some(s => s.name === "OldTimer"), "old times aren't on the ranked board");
r = await call("GET", "/v1/scores?count=14&mode=all&old=1");
check(r.body.old && r.body.scores.some(s => s.name === "OldTimer"), "old times have a board of their own");
r = await call("GET", "/v1/scores?count=10&mode=all");
check(r.body.scores.length === 1 && r.body.scores[0].name === "TenGuy", "the 10 board is separate");
r = await call("GET", "/v1/scores?count=14&mode=click");
check(!JSON.stringify(r.body).includes("layout"), "boards don't send out run records");
check(r.headers.get("Access-Control-Allow-Origin") === "https://beejona.github.io" && r.headers.get("X-Content-Type-Options") === "nosniff", "the site gets CORS; nosniff is set");
r = await call("GET", "/v1/scores?count=14", undefined, { Origin: "https://evil.example" });
check(!r.headers.get("Access-Control-Allow-Origin"), "other sites don't get CORS");
const before = (await call("GET", "/v1/scores?count=14&mode=hover")).body.scores[0].time_ms;
await save({ name: "Sweeper", key: "f".repeat(64), mode: "hover", time: before - 100 });
r = await call("GET", "/v1/scores?count=14&mode=hover");
check(r.body.scores[0].time_ms === before - 100, "a new best shows at once despite the board cache");

r = await call("POST", "/v1/scores", { name: "Old", time_ms: 2000 });
check(r.status === 410 && /Refresh/.test(r.body.error), "times can't be posted any more (old pages are told to refresh)");
r = await call("GET", "/v1/play");
check(r.status === 426, "/v1/play wants a WebSocket");
r = await worker.fetch(new Request("https://leaderboard.test/v1/play", { headers: { Upgrade: "websocket", Origin: "https://evil.example" } }), env);
check(r.status === 403, "only the site can open a terminal");

const owner = createHash("sha256").update(keyA).digest("hex");
check((await call("GET", `/v1/name?name=BEEJONA&owner=${owner}`)).body.status === "yours", "name check: yours");
check((await call("GET", "/v1/name?name=Beejona&owner=nope")).body.status === "taken", "name check: taken");
check((await call("GET", "/v1/name?name=Newbie")).body.status === "free", "name check: free");
check((await call("GET", "/v1/name?name=faggot")).body.status === "invalid", "name check: a slur is invalid");

let names = 0;
for (let i = 0; i < 8; i++) {
  r = await saveRun(env, { name: `Squatter${i}`, key: "9".repeat(64), address: "8.8.4.4", count: 14, mode: "click", time: 3000, ping: 0, run: {} });
  if (!r.ok) break;
  names++;
}
check(names === 5 && /Too many new names/.test(r.error), `one address can only make 5 new names a day (${names})`);
check(db.prepare("SELECT who FROM name_claims").all().every(row => !row.who.includes("8.8.4.4")), "addresses aren't stored as they are");
const claims = db.prepare("SELECT COUNT(*) AS n FROM name_claims").get().n;
r = await saveRun({ ...env, ADMIN_TOKEN: undefined }, { name: "NoSecret", key: "7".repeat(64), address: "8.8.8.8", count: 14, mode: "click", time: 3000, ping: 0, run: {} });
check(/can't be made/.test(r.error || "") && !db.prepare("SELECT 1 FROM names WHERE name_key = 'nosecret'").get() && db.prepare("SELECT COUNT(*) AS n FROM name_claims").get().n === claims,
  "without the secret no new names are made, so no address is stored with an unsalted hash");

r = await call("GET", "/v1/admin/run?name=beejona&count=14&mode=click", undefined, { Authorization: "Bearer admin-test-token" });
check(r.status === 200 && r.body.run.clicks.length === 14, "the admin can read a best run's record");
check((await call("GET", "/v1/admin/run?name=beejona&count=14&mode=click")).status === 401, "and nobody else can");
check((await call("POST", "/v1/admin/remove", { name: "Saver", block: true })).status === 401, "removing needs the admin token");
r = await call("POST", "/v1/admin/remove", { name: "Saver", block: true }, { Authorization: "Bearer admin-test-token" });
check(r.status === 200 && r.body.scoresRemoved === 1, "the admin can take a name off the board");
check(/allowed/.test((await save({ name: "Saver", key: keyB })).error || ""), "and a blocked name can't come back");
r = await call("POST", "/v1/admin/remove", { name: "OldTimer" }, { Authorization: "Bearer admin-test-token" });
check(r.body.scoresRemoved === 1, "removing reaches old times too");

let reads = 0;
for (let i = 0; i < 130; i++) {
  r = await call("GET", "/v1/scores?count=14", undefined, { ip: "9.9.9.9" });
  if (r.status === 429) break;
  reads++;
}
check(reads === 120, `reading (and opening terminals) is rate limited per address (${reads} a minute)`);
reads = 0;
for (let i = 0; i < 130; i++) {
  r = await call("GET", "/v1/scores?count=10", undefined, { ip: `2001:db8:abcd:12::${i + 1}` });
  if (r.status === 429) break;
  reads++;
}
check(reads === 120, `IPv6 addresses are limited per /64 (${reads})`);

// ---- the record checks (checkrun.js) ----------------------------------------------------------

const recorded = (count, mode, time, change) => { const record = humanRun({ count, mode, time, random }); change?.(record); return record; };
const refused = (record, reason, { count = 14, mode = "click", time = 2000 } = {}) => {
  const problem = checkRun(record, { count, mode, ping: 0, time });
  check(problem && reason.test(problem), `record refused: ${problem}`);
};
check(checkRun(recorded(14, "click", 2000), { count: 14, mode: "click", ping: 0, time: 2000 }) === null, "a person-like record passes");
refused(undefined, /no record/);
refused(recorded(14, "click", 2000, r => { [r.clicks[3], r.clicks[4]] = [r.clicks[4], r.clicks[3]]; }), /(in order|hold together)/);
refused(recorded(14, "click", 2000, r => { r.clicks[5].x += 1.5; }), /wasn't on its pane/);
refused(recorded(14, "hover", 2000), /hovered/);
refused(recorded(14, "click", 2000, r => { r.path = []; }), /without the pointer moving/);
refused(recorded(14, "click", 2000, r => {
  r.clicks[7].t = r.clicks[6].t + 12; r.path.push([r.clicks[6].t + 6, r.clicks[7].x, r.clicks[7].y]); r.path.sort((a, b) => a[0] - b[0]);
}), /closer together/);
refused(recorded(14, "click", 2000, r => { r.clicks.forEach((c, k) => { c.t = 100 + k * 150; }); r.path = r.clicks.map(c => [c.t - 20, c.x, c.y]); }), /evenly spaced/, { time: 100 + 13 * 150 + 1 });
refused(recorded(14, "click", 2000, r => { r.clicks.forEach(c => { c.x = c.i % 7 + 0.5; c.y = Math.floor(c.i / 7) + 0.5; }); r.path = r.clicks.map(c => [c.t - 20, c.x, c.y]); }), /exact middle/);
refused({ ...recorded(14, "click", 2000), path: Array(7000).fill([1, 0.5, 0.5]) }, /hold together/);
const forged = JSON.parse(readFileSync(new URL("./fixtures/forged-2026-09-24.json", import.meta.url), "utf8"));
refused(forged.run, /two places at once/, { count: 10, time: forged.time_ms });
refused(recorded(14, "click", 2000, r => { r.path = r.clicks.flatMap((c, k) => k === 0 ? [[c.t, c.x, c.y]] : [[(r.clicks[k - 1].t + c.t) / 2, c.x - 0.8, c.y], [c.t, c.x, c.y]]); }), /very instant/);
check(checkRun(humanRun({ count: 14, time: 1800, random, touch: true }), { count: 14, mode: "click", ping: 0, time: 1800 }) === null, "taps on a touch screen don't need the pointer moved over first");

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
