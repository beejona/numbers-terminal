// Runs the Worker in Node against a real SQLite database (node:sqlite) standing in for D1, since
// Cloudflare's local runtime needs macOS 13.5+. node worker/test/run.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { humanRun, randomSource } from "./humanrun.mjs";

/** Enough of D1's API for the Worker: prepare().bind().first()/all()/run(), and batch(). */
function d1(db) {
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: r.changes } }; }
  });
  return {
    prepare: sql => statement(sql),
    async batch(list) { return Promise.all(list.map(s => s.run())); }
  };
}

/** Cloudflare's rate limiter: so many calls per key per minute. */
function limiter(limit) {
  const counts = new Map();
  return { async limit({ key }) { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return { success: n <= limit }; } };
}

const db = new DatabaseSync(":memory:");
for (const file of ["0001_init.sql", "0002_hardening.sql", "0003_run_records.sql"]) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
const env = {
  DB: d1(db), ALLOWED_ORIGINS: "https://beejona.github.io", ADMIN_TOKEN: "admin-test-token",
  READ_LIMIT: limiter(120), POST_LIMIT: limiter(10)
};
let nextIp = 1;

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures++;
}
async function call(method, path, body, headers = {}) {
  const request = new Request(`https://leaderboard.test${path}`, {
    // Each call from its own address unless a test says otherwise, so the limits only bite where tested.
    method, headers: { "Content-Type": "application/json", Origin: "https://beejona.github.io", "CF-Connecting-IP": headers.ip || `10.0.${nextIp >> 8}.${nextIp++ & 255}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const response = await worker.fetch(request, env);
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
}
const keyA = "a".repeat(64), keyB = "b".repeat(64);
const random = randomSource(42);
/** A post, with a person-like record of the run to match (unless the test brings its own). */
const run = (over = {}) => {
  const post = { name: "Beejona", key: keyA, count: 14, mode: "click", ping: 0, time_ms: 2500, ...over };
  if (!("run" in over)) post.run = humanRun({ count: post.count, mode: post.mode, time: post.time_ms, ping: post.ping, random });
  return post;
};

let r = await call("POST", "/v1/scores", run());
check(r.status === 200 && r.body.rank === 1 && r.body.best_ms === 2500, "first run posts, rank 1");
check(r.headers.get("Access-Control-Allow-Origin") === "https://beejona.github.io", "the site is allowed to call it (CORS)");
r = await call("POST", "/v1/scores", run({ time_ms: 3100 }));
check(r.status === 200 && r.body.best_ms === 2500 && !r.body.improved, "a slower run doesn't replace the best");
r = await call("POST", "/v1/scores", run({ time_ms: 2210 }));
check(r.body.best_ms === 2210 && r.body.improved, "a faster run does");
r = await call("POST", "/v1/scores", run({ name: "beejona", key: keyB, time_ms: 1000 }));
check(r.status === 409, "someone else can't post as the same name (any capitals)");
r = await call("POST", "/v1/scores", run({ name: "N1GG4_boy", key: keyB }));
check(r.status === 400 && /allowed/.test(r.body.error), "a slur name is refused by the server, not just the page");
r = await call("POST", "/v1/scores", run({ name: "a b", key: keyB }));
check(r.status === 400, "a malformed name is refused");
r = await call("POST", "/v1/scores", run({ name: "Speedy", key: keyB, time_ms: 120 }));
check(r.status === 400 && /possible/.test(r.body.error), "an impossibly fast time is refused");
r = await call("POST", "/v1/scores", run({ name: "Speedy", key: keyB, mode: "teleport" }));
check(r.status === 400, "an unknown mode is refused");
r = await call("POST", "/v1/scores", run({ name: "Hoverer", key: keyB, mode: "hover", time_ms: 1400 }));
check(r.status === 200 && r.body.rank === 1, "a hover run lands on the hover board");
await call("POST", "/v1/scores", run({ name: "Dropper", key: "c".repeat(64), mode: "drop", time_ms: 1800, ping: 120 }));
await call("POST", "/v1/scores", run({ name: "TenGuy", key: "d".repeat(64), count: 10, time_ms: 1500 }));

r = await call("GET", "/v1/scores?count=14&mode=all");
check(JSON.stringify(r.body.scores.map(s => [s.rank, s.name, s.time_ms, s.mode])) ===
  JSON.stringify([[1, "Hoverer", 1400, "hover"], [2, "Dropper", 1800, "drop"], [3, "Beejona", 2210, "click"]]), "the 14 board lists each name's best, fastest first");
r = await call("GET", "/v1/scores?count=14&mode=click");
check(r.body.scores.length === 1 && r.body.scores[0].name === "Beejona", "the click board only has click runs");
r = await call("GET", "/v1/scores?count=10&mode=all");
check(r.body.scores.length === 1 && r.body.scores[0].name === "TenGuy", "the 10 board is separate");
r = await call("GET", "/v1/scores?count=14&mode=all", undefined, { Origin: "https://evil.example" });
check(!r.headers.get("Access-Control-Allow-Origin"), "other sites don't get CORS access");

for (const [mode, count, time, ok] of [
  ["click", 10, 499, false], ["click", 10, 500, true], ["click", 14, 499, false], ["click", 14, 380, false],
  ["hover", 14, 380, true], ["drop", 14, 360, true], ["hover", 14, 349, false], ["hover", 10, 260, true], ["drop", 10, 249, false]
]) {
  r = await call("POST", "/v1/scores", run({ name: `Edge_${mode}${count}x${time}`, key: "7".repeat(64), mode, count, time_ms: time }));
  check(ok ? r.status === 200 : r.status === 400, `${mode}: ${time} ms for ${count} numbers is ${ok ? "accepted" : "refused"}`);
}

const owner = (await import("node:crypto")).createHash("sha256").update(keyA).digest("hex");
r = await call("GET", `/v1/name?name=BEEJONA&owner=${owner}`);
check(r.body.status === "yours", "name check: yours");
r = await call("GET", "/v1/name?name=Beejona&owner=nope");
check(r.body.status === "taken", "name check: taken");
r = await call("GET", "/v1/name?name=Newbie");
check(r.body.status === "free", "name check: free");
r = await call("GET", "/v1/name?name=faggot");
check(r.body.status === "invalid", "name check: a slur is invalid");

r = await call("POST", "/v1/admin/remove", { name: "Dropper", block: true });
check(r.status === 401, "removing needs the admin token");
r = await call("POST", "/v1/admin/remove", { name: "Dropper", block: true }, { Authorization: "Bearer admin-test-token" });
check(r.status === 200 && r.body.scoresRemoved === 1, "the admin can take a name off the board");
r = await call("POST", "/v1/scores", run({ name: "Dropper", key: "c".repeat(64) }));
check(r.status === 400, "and a blocked name can't come back");

let posts = 0;
for (let i = 0; i < 40; i++) {
  r = await call("POST", "/v1/scores", run({ name: "Spammer", key: "e".repeat(64), time_ms: 5000 + i }), { ip: "9.9.9.9" });
  if (r.status === 429) break;
  posts++;
}
check(posts === 10, `posting is rate limited per address (${posts} posts a minute got through)`);
posts = 0;
for (let i = 0; i < 20; i++) {
  // Different addresses in one IPv6 /64 (one home or phone) share a limit.
  r = await call("POST", "/v1/scores", run({ name: "V6user", key: "f".repeat(64), time_ms: 6000 + i }), { ip: `2001:db8:abcd:12::${i + 1}` });
  if (r.status === 429) break;
  posts++;
}
check(posts === 10, `IPv6 addresses are limited per /64 (${posts} got through)`);

let names = 0;
for (let i = 0; i < 8; i++) {
  r = await call("POST", "/v1/scores", run({ name: `Squatter${i}`, key: "9".repeat(64) }), { ip: "8.8.4.4" });
  if (r.status !== 200) break;
  names++;
}
check(names === 5 && r.status === 429 && /Too many new names/.test(r.body.error), `one address can only make 5 new names a day (${names})`);
check(db.prepare("SELECT who FROM name_claims").all().every(row => !row.who.includes("8.8.4.4")), "addresses aren't stored as they are");

r = await worker.fetch(new Request("https://leaderboard.test/v1/scores", {
  method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "999999", "CF-Connecting-IP": "7.7.7.7" }, body: "x"
}), env);
check(r.status === 400, "a body claiming to be huge is turned away before it's read");
r = await call("GET", "/v1/scores?count=14&mode=all");
check(r.headers.get("X-Content-Type-Options") === "nosniff", "responses can't be sniffed as another type");
r = await call("GET", "/v1/scores?count=14&mode=hover");
const hoverBefore = r.body.scores[0].time_ms;
await call("POST", "/v1/scores", run({ name: "Hoverer", key: keyB, mode: "hover", time_ms: hoverBefore - 10 }));
r = await call("GET", "/v1/scores?count=14&mode=hover");
check(r.body.scores[0].time_ms === hoverBefore - 10, "a new best shows at once despite the board cache");

// ---- run records ----
const clone = value => JSON.parse(JSON.stringify(value));
const recorded = (count, mode, time, change) => {
  const record = humanRun({ count, mode, time, random });
  change?.(record);
  return record;
};
async function refused(record, reason, over = {}) {
  const post = run({ name: "Checker", key: "5".repeat(64), time_ms: 2000, ...over, run: record });
  const response = await call("POST", "/v1/scores", post);
  check(response.status === 400 && reason.test(response.body.error || ""), `refused: ${response.body.error || response.status}`);
}
await refused(undefined, /no record/);
await refused(recorded(14, "click", 2000, r => { [r.clicks[3], r.clicks[4]] = [r.clicks[4], r.clicks[3]]; }), /(in order|hold together)/);
await refused(recorded(14, "click", 2000, r => { r.clicks[5].x += 1.5; }), /wasn't on its pane/);
await refused(recorded(14, "click", 2600), /time doesn't match/);
await refused(recorded(14, "hover", 2000), /hovered/);
await refused(recorded(14, "click", 2000, r => { r.path = []; }), /without the pointer moving/);
await refused(recorded(14, "click", 2000, r => {
  r.clicks[7].t = r.clicks[6].t + 12;
  r.path.push([r.clicks[6].t + 6, r.clicks[7].x, r.clicks[7].y]);
  r.path.sort((a, b) => a[0] - b[0]);
}), /closer together/);
await refused(recorded(14, "click", 2000, r => {
  // A script clicking every 150 ms, dead on time.
  r.clicks.forEach((c, k) => { c.t = 100 + k * 150; });
  r.path = r.clicks.map(c => [c.t - 20, c.x, c.y]);
}), /evenly spaced/, { time_ms: 100 + 13 * 150 + 1 });
await refused(recorded(14, "click", 2000, r => {
  const columns = 7;
  r.clicks.forEach(c => { c.x = c.i % columns + 0.5; c.y = Math.floor(c.i / columns) + 0.5; });
  r.path = r.clicks.map(c => [c.t - 20, c.x, c.y]);
}), /exact middle/);
await refused({ ...recorded(14, "click", 2000), path: Array(7000).fill([1, 0.5, 0.5]) }, /hold together/);

r = await call("POST", "/v1/scores", run({ name: "TouchPlayer", key: "6".repeat(64), time_ms: 1800, run: humanRun({ count: 14, time: 1800, random, touch: true }) }));
check(r.status === 200, "taps on a touch screen don't need the pointer moved over first");
const drop = humanRun({ count: 10, mode: "drop", time: 700, random });
drop.path = [];
r = await call("POST", "/v1/scores", run({ name: "Sweeper", key: "4".repeat(64), count: 10, mode: "drop", time_ms: 700, run: drop }));
check(r.status === 200, "drop key runs only need a record that holds together");
const pinged = humanRun({ count: 14, time: 2300, ping: 200, random });
r = await call("POST", "/v1/scores", run({ name: "Pinged", key: "3".repeat(64), time_ms: 2300, ping: 200, run: pinged }));
check(r.status === 200, "a run played with ping lines up with its time");

r = await call("GET", "/v1/admin/run?name=pinged&count=14&mode=click", undefined, { Authorization: "Bearer admin-test-token" });
check(r.status === 200 && r.body.time_ms === 2300 && r.body.run.clicks.length === 14, "the admin can read a best run's record");
r = await call("GET", "/v1/admin/run?name=pinged&count=14&mode=click");
check(r.status === 401, "and nobody else can");
r = await call("GET", "/v1/scores?count=14&mode=click");
check(!JSON.stringify(r.body).includes("layout"), "boards don't send out run records");

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
