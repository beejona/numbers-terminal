import { checkRun } from "./checkrun.js";

/**
 * Ranked terminals, run by the server the way Hypixel SkyBlock runs its pingless terminals.
 *
 * The server makes the terminal and owns it. Clicks count as soon as they're made - the page
 * clears the pane at once and the next can be clicked straight away, without waiting on the
 * server - but the server still clears at most one pane a tick (20 a second), and only lets a few
 * rapid clicks queue up for that: a click past QUEUE_LIMIT is rejected, and so is anything after
 * it until the missed pane is clicked again. The time is the server's own clock from sending the
 * terminal to clearing its last pane, so nothing the browser says about time counts, ping adds once
 * rather than per pane, and nothing can finish faster than one pane a tick. Sending too many
 * messages gets you kicked, like "You are clicking too fast". The browser's record of the run
 * (checkrun.js) is still checked on top.
 */

export const TICK_MS = 50;
// Rapid clicks the server will hold for its ticks; players found SkyBlock's pingless terminals take
// about 5 before throttling hard.
export const QUEUE_LIMIT = 5;
export const MAX_MESSAGES_PER_SECOND = 40;
// A connection nobody's played on for this long is closed (a Durable Object costs while it's open).
const IDLE_MS = 20_000;
const COUNTS = new Set([10, 14]);
const MODES = new Set(["click", "drop", "hover"]);
const MAX_PATH = 6000;
const MAX_PATH_PER_CLICK = 600;

/** 1..count in a random order: the numbers as they sit in the grid, row by row. */
export function randomLayout(count) {
  const layout = Array.from({ length: count }, (_, i) => i + 1);
  const random = new Uint32Array(count);
  crypto.getRandomValues(random);
  for (let i = count - 1; i > 0; i--) {
    const j = random[i] % (i + 1);
    [layout[i], layout[j]] = [layout[j], layout[i]];
  }
  return layout;
}

/** One terminal. Knows nothing about sockets: `now` is passed in, so tests can run the clock. */
export class TerminalGame {
  constructor({ count, mode, now, layout = randomLayout(count) }) {
    this.count = count;
    this.mode = mode;
    this.layout = layout;
    this.start = now;
    this.next = 1;
    this.lastTick = 0;
    // Ticks (server time) of accepted clicks still waiting to clear.
    this.queued = [];
    this.done = false;
    this.clicks = [];
    this.path = [];
    this.fill = null;
  }

  /**
   * A click as it reaches the server. Returns null when it's ignored (finished terminal, nonsense),
   * { rejected: true } for a click that doesn't count (a wrong pane, one after a rejected pane, or
   * one too many queued), or the pane accepted: the tick (server time) it clears on.
   */
  click(message, now) {
    // The pointer's path counts whatever happens to the click, so a pane clicked again after a
    // rejection still has the pointer's way onto it on record.
    if (Array.isArray(message.path)) {
      for (const point of message.path.slice(0, MAX_PATH_PER_CLICK)) {
        if (this.path.length < MAX_PATH) this.path.push(point);
      }
    }
    if (Array.isArray(message.fill)) this.fill = message.fill;
    if (this.done) return null;
    const index = message.i;
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return null;
    if (this.layout[index] !== this.next) return { rejected: true, i: index };
    const elapsed = Math.max(0, now - this.start);
    this.queued = this.queued.filter(tick => tick > elapsed);
    if (this.queued.length >= QUEUE_LIMIT) return { rejected: true, i: index };

    // Cleared on the next tick after it arrives, and never two in one tick.
    let tick = Math.max(TICK_MS, Math.ceil(elapsed / TICK_MS) * TICK_MS);
    if (tick <= this.lastTick) tick = this.lastTick + TICK_MS;
    this.lastTick = tick;
    this.queued.push(tick);

    // What the browser says about the click, for the record checks - never for the time.
    this.clicks.push({
      i: index, t: Number(message.t), x: message.x, y: message.y,
      via: message.via, type: message.pointer, server: tick
    });
    this.next++;
    this.done = this.next > this.count;
    return { i: index, at: this.start + tick, tick, done: this.done };
  }

  /** The browser's record of the run, checked the same way as before (time aside: that's ours). */
  recordProblem() {
    const clicks = this.clicks.map(({ server, ...click }) => click);
    const run = { layout: this.layout, clicks, path: this.path, fill: this.fill };
    const last = clicks[clicks.length - 1];
    return checkRun(run, { count: this.count, mode: this.mode, ping: 0, time: last ? last.t : 0 });
  }

  get record() {
    return { layout: this.layout, clicks: this.clicks, path: this.path, fill: this.fill };
  }
}

/**
 * One player's connection. [send] and [close] talk to the socket; [save] puts a finished run on
 * the board (index.js) and [checkName] vets a name before the run starts.
 */
export class Session {
  constructor({ send, close, save, checkName, now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)) }) {
    this.send = send;
    this.close = close;
    this.save = save;
    this.checkName = checkName;
    this.now = now;
    this.wait = wait;
    this.game = null;
    this.player = null;
    this.second = 0;
    this.messages = 0;
    this.closed = false;
    this.bumpIdle();
  }

  bumpIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.end(4000, "idle"), IDLE_MS);
    this.idle?.unref?.(); // (Node, for tests: an idle timer shouldn't keep the process up)
  }

  end(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    try { this.close(code, reason); } catch { /* already gone */ }
  }

  async onMessage(text) {
    if (this.closed) return;
    // Too many messages: kicked, like SkyBlock's "You are clicking too fast".
    const second = Math.floor(this.now() / 1000);
    if (second !== this.second) { this.second = second; this.messages = 0; }
    if (++this.messages > MAX_MESSAGES_PER_SECOND) {
      this.send({ type: "kicked", reason: "You were clicking too fast." });
      this.end(4001, "too fast");
      return;
    }
    this.bumpIdle();
    let message;
    try {
      message = JSON.parse(typeof text === "string" ? text : "");
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "start") await this.start(message);
    else if (message.type === "ready") this.ready();
    else if (message.type === "click") await this.click(message);
  }

  async start({ count, mode, name, key, id = null }) {
    if (!COUNTS.has(count) || !MODES.has(mode)) {
      this.send({ type: "error", id, error: "Unknown terminal." });
      return;
    }
    let player = null;
    if (name !== undefined && name !== null) {
      const problem = await this.checkName(name, key);
      if (problem) {
        this.send({ type: "error", id, error: problem });
        return;
      }
      player = { name, key };
    }
    this.player = player;
    this.game = new TerminalGame({ count, mode, now: this.now() });
    // The page's number for this terminal, sent back with every reply so a late one for an
    // earlier terminal on the same connection can't be mistaken for this one's.
    this.game.id = id;
    this.rtt = null;
    this.send({ type: "terminal", id, layout: this.game.layout, tick: TICK_MS, queue: QUEUE_LIMIT });
  }

  /** The page answers the terminal as soon as it arrives: that round trip is the player's ping. */
  ready() {
    if (this.game && this.rtt === null) this.rtt = Math.max(0, this.now() - this.game.start);
  }

  async click(message) {
    const game = this.game;
    if (!game) return;
    const result = game.click(message, this.now());
    if (!result) return;
    if (result.rejected) {
      this.send({ type: "rejected", id: game.id, i: result.i });
      return;
    }
    // Cleared on the tick: the player hears back then (the page has shown it cleared all along).
    const delay = result.at - this.now();
    if (delay > 0) await this.wait(delay);
    if (this.closed || game !== this.game) return;
    if (!result.done) {
      this.send({ type: "cleared", id: game.id, i: result.i, tick: result.tick });
      return;
    }

    const time = result.tick;
    const problem = game.recordProblem();
    if (problem) {
      this.send({ type: "done", id: game.id, i: result.i, time_ms: time, error: problem });
      return;
    }
    if (!this.player) {
      this.send({ type: "done", id: game.id, i: result.i, time_ms: time });
      return;
    }
    const saved = await this.save({ ...this.player, count: game.count, mode: game.mode, time, ping: this.rtt ?? 0, run: game.record });
    this.send({ type: "done", id: game.id, i: result.i, time_ms: time, ...saved });
  }
}
