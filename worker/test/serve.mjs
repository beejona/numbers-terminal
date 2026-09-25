// Serves the leaderboard on this machine (http://127.0.0.1:8787, ws://127.0.0.1:8787/v1/play) with
// node:sqlite standing in for D1 and the `ws` package for the ranked terminals' connections, for
// trying the site against it: open http://localhost:8000/?api=http://127.0.0.1:8787
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import worker, { saveRun, playerProblem } from "../src/index.js";
import { Session } from "../src/session.js";

const db = new DatabaseSync(process.env.DB_FILE || ":memory:");
for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
  db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8").replace(/CREATE (TABLE|INDEX) /g, "CREATE $1 IF NOT EXISTS "));
}
const statement = (sql, params = []) => ({
  bind: (...values) => statement(sql, values),
  async first() { return db.prepare(sql).get(...params) ?? null; },
  async all() { return { results: db.prepare(sql).all(...params) }; },
  async run() { return { meta: { changes: db.prepare(sql).run(...params).changes } }; }
});
const unlimited = { async limit() { return { success: true }; } };
const env = {
  DB: { prepare: sql => statement(sql), batch: list => Promise.all(list.map(s => s.run())) },
  ALLOWED_ORIGINS: "http://localhost:8000,http://127.0.0.1:8000",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "local-admin",
  READ_LIMIT: unlimited, POST_LIMIT: unlimited
};

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:8787${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

// What TerminalSession does on Cloudflare: one Session per connection.
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const allowed = env.ALLOWED_ORIGINS.split(",");
  if (!req.url.startsWith("/v1/play") || !allowed.includes(req.headers.origin || "")) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, ws => {
    const session = new Session({
      send: data => ws.send(JSON.stringify(data)),
      close: (code, reason) => ws.close(code, reason),
      checkName: (name, key) => playerProblem(env, name, key),
      save: run => saveRun(env, { ...run, address: req.socket.remoteAddress })
    });
    ws.on("message", data => session.onMessage(String(data)).catch(error => console.error(error)));
    ws.on("close", () => session.end(1000, "closed"));
  });
});
server.listen(8787, "127.0.0.1", () => console.log("leaderboard on http://127.0.0.1:8787"));
