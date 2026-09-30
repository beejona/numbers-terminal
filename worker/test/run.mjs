// Runs the Worker in Node against a real SQLite database (node:sqlite) standing in for D1, since
// Cloudflare's local runtime needs macOS 13.5+. node worker/test/run.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

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
for (const file of ["0001_init.sql", "0002_hardening.sql"]) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
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
const run = (over = {}) => ({ name: "Beejona", key: keyA, count: 14, mode: "click", ping: 0, time_ms: 2500, ...over });

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
await call("POST", "/v1/scores", run({ name: "Hoverer", key: keyB, mode: "hover", time_ms: hoverBefore - 100 }));
r = await call("GET", "/v1/scores?count=14&mode=hover");
check(r.body.scores[0].time_ms === hoverBefore - 100, "a new best shows at once despite the board cache");

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
