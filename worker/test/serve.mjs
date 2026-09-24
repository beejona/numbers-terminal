// Serves the Worker over HTTP on this machine (http://127.0.0.1:8787) with node:sqlite standing in
// for D1, for trying the site against it: open http://localhost:8000/?api=http://127.0.0.1:8787
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const db = new DatabaseSync(process.env.DB_FILE || ":memory:");
for (const file of ["0001_init.sql", "0002_hardening.sql"]) {
  db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8").replace(/CREATE (TABLE|INDEX) /g, "CREATE $1 IF NOT EXISTS "));
}
const unlimited = { async limit() { return { success: true }; } };
const statement = (sql, params = []) => ({
  bind: (...values) => statement(sql, values),
  async first() { return db.prepare(sql).get(...params) ?? null; },
  async all() { return { results: db.prepare(sql).all(...params) }; },
  async run() { return { meta: { changes: db.prepare(sql).run(...params).changes } }; }
});
const env = {
  DB: { prepare: sql => statement(sql), batch: list => Promise.all(list.map(s => s.run())) },
  ALLOWED_ORIGINS: "http://localhost:8000,http://127.0.0.1:8000",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "local-admin",
  READ_LIMIT: unlimited, POST_LIMIT: unlimited
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:8787${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8787, "127.0.0.1", () => console.log("leaderboard on http://127.0.0.1:8787"));
