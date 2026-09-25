"use strict";

// The terminal itself: a 4-row chest titled "Click in order!", whose 14 numbered panes sit in a
// 2 x 7 block inset one row and one column. Only that block is ever clickable, so that's all the
// page draws.
const ROWS = 2;
const FULL_COLUMNS = 7;
const FULL_COUNT = ROWS * FULL_COLUMNS;

// Odin's own defaults for its terminal solver and simulator.
const DEFAULTS = Object.freeze({
  renderType: "Custom GUI",
  termSize: 3,
  normalTermSize: 3,
  roundness: 0,
  gap: 0,
  showNumbers: false,
  numberCount: 14,
  blockIncorrect: true,
  clientPrediction: true,
  hoverMode: false,
  dropKey: false,
  dropKeyBind: "KeyQ",
  resolveTimeout: 600,
  firstClickProt: 0,
  ping: 0,
  autoRestart: true,
  background: "#1a1a1a",
  order1: "#6dff6d",
  order2: "#379a37",
  order3: "#1c591c"
});

const SETTINGS_KEY = "numbers-terminal.settings";
const BEST_KEY = "numbers-terminal.best";

const elements = {
  terminal: document.getElementById("terminal"),
  message: document.getElementById("message"),
  time: document.getElementById("time"),
  best: document.getElementById("best"),
  last: document.getElementById("last"),
  misclicks: document.getElementById("misclicks"),
  settings: document.getElementById("settings")
};

let settings = loadSettings();
let best = null;

/** One run of the terminal. */
let panes = [];
let startedAt = 0;
let blockedUntil = 0;
let misclicks = 0;
let running = false;
/** Which pane the cursor is over, for hover mode. */
let hoveredIndex = -1;
/** Whether the drop key is down, and whether the settings panel is waiting for a new one. */
let dropKeyHeld = false;
let bindingDropKey = false;
let finishing = false;

/* ---------- settings ---------- */

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applySettings() {
  applyGrid(paneCount());
  const size = settings.renderType === "Normal" ? settings.normalTermSize : settings.termSize;
  const root = document.documentElement.style;
  root.setProperty("--slot", `${Math.round(size * 20)}px`);
  root.setProperty("--gap", `${settings.gap}px`);
  root.setProperty("--radius", `${settings.roundness}px`);
  root.setProperty("--term-bg", settings.background);
  root.setProperty("--order1", settings.order1);
  root.setProperty("--order2", settings.order2);
  root.setProperty("--order3", settings.order3);

  elements.terminal.classList.toggle("normal", settings.renderType === "Normal");
  elements.terminal.classList.toggle("odin", settings.renderType === "Odin");
  render();
}

/* ---------- a run ---------- */

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** How many numbers this terminal has. */
function paneCount() {
  const count = Math.round(Number(settings.numberCount));
  return Number.isFinite(count) ? Math.min(Math.max(count, 1), FULL_COUNT) : FULL_COUNT;
}

/** Two rows, as wide as the count needs: 2 x 7 for fourteen, 2 x 5 for ten. */
function applyGrid(count) {
  document.documentElement.style.setProperty("--columns", String(Math.ceil(count / ROWS)));
}

/** A ten number run isn't comparable to a fourteen, so each count keeps its own best. */
function bestKeyFor(count) {
  return `${BEST_KEY}.${count}`;
}

function loadBest() {
  const stored = Number(localStorage.getItem(bestKeyFor(paneCount())));
  return stored > 0 ? stored : null;
}

function newTerminal() {
  const count = paneCount();
  applyGrid(count);
  // A terminal still being dealt is dropped for this one.
  if (dealing) {
    clearTimeout(dealing.timer);
    dealing = null;
  }
  const player = rankedPlayer();
  if (player) dealRanked(count, player);
  else startTerminal(practiceLayout(count), null);
}

function practiceLayout(count) {
  return shuffle(Array.from({ length: count }, (_, index) => index + 1));
}

/** Puts a terminal in play: [layout] is its numbers row by row; [rankedTerminal] if the server runs it. */
function startTerminal(layout, rankedTerminal) {
  applyGrid(layout.length);
  panes = layout.map(number => ({ number, clicked: false, predicted: false }));
  ranked = rankedTerminal;
  best = loadBest();
  elements.best.textContent = formatTime(best);
  misclicks = 0;
  hoveredIndex = -1;
  finishing = false;
  running = true;
  startedAt = performance.now();
  blockedUntil = startedAt + settings.firstClickProt;

  elements.misclicks.textContent = "0";
  elements.message.hidden = true;
  elements.best.classList.remove("fresh");
  build();
  render();
  startRecord();
}

/** The number that has to be clicked next, or null once the terminal is solved. */
function nextNumber() {
  let next = null;
  for (const pane of panes) {
    if (!pane.clicked && (next === null || pane.number < next)) next = pane.number;
  }
  return next;
}

function build() {
  elements.terminal.replaceChildren();
  panes.forEach((pane, index) => {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "slot";
    slot.dataset.index = String(index);
    slot.append(
      Object.assign(document.createElement("span"), { className: "pane-item" }),
      Object.assign(document.createElement("span"), { className: "count" })
    );
    slot.addEventListener("pointerdown", event => {
      // Only real presses: clicks a script makes up don't play the terminal.
      if (event.button !== 0 || !event.isTrusted) return;
      event.preventDefault();
      track(event, false);
      clickPane(index, "down");
    });
    slot.addEventListener("pointerenter", event => {
      if (!event.isTrusted) return;
      track(event);
      hoveredIndex = index;
      if (hoverClicks()) clickPane(index, "hover");
    });
    slot.addEventListener("pointerleave", () => {
      if (hoveredIndex === index) hoveredIndex = -1;
    });
    elements.terminal.append(slot);
  });
}

function render() {
  const next = nextNumber();
  const slots = elements.terminal.children;

  panes.forEach((pane, index) => {
    const slot = slots[index];
    if (!slot) return;
    const done = pane.clicked || pane.predicted;
    const rank = next === null ? -1 : pane.number - next;

    slot.classList.toggle("done", done);
    slot.classList.toggle("pane", !done);
    slot.classList.toggle("next-1", !done && rank === 0);
    slot.classList.toggle("next-2", !done && rank === 1);
    slot.classList.toggle("next-3", !done && rank === 2);
    slot.querySelector(".count").textContent = settings.showNumbers && !done ? String(pane.number) : "";
  });
}

/** Whether moving the cursor onto a pane should click it right now. */
function hoverClicks() {
  return settings.hoverMode || (settings.dropKey && dropKeyHeld);
}

/** Clears a pane if it's the next one. [via] is how: "down" (pressed), "hover" or "key" (drop key). */
function clickPane(index, via = "down") {
  const viaHover = via !== "down";
  const pane = panes[index];
  if (!running || finishing || !pane || pane.clicked || pane.predicted) return;
  // First click protection: the mod swallows clicks for a moment after the terminal opens.
  if (performance.now() < blockedUntil) return;

  if (pane.number !== nextNumber()) {
    // Sweeping the cursor across panes in hover mode isn't a misclick.
    if (viaHover) return;
    if (!settings.blockIncorrect) {
      misclicks += 1;
      elements.misclicks.textContent = String(misclicks);
      flashWrong(index);
    }
    return;
  }

  // Ranked, one pane at a time as in game: the next click needs the server's new window.
  if (ranked && ranked.awaiting >= 0) return;
  recordClick(index, via);
  if (ranked) {
    sendRankedClick(pane, index, via);
    return;
  }

  // With client prediction the pane clears immediately; otherwise it waits for the "server",
  // which is what ping simulates here.
  if (settings.clientPrediction) {
    pane.predicted = true;
    render();
    // Odin reloads the terminal if the server hasn't confirmed by the resolve timeout, which
    // puts the pane back until the confirmation lands.
    if (settings.ping > settings.resolveTimeout) {
      setTimeout(() => {
        if (!pane.clicked) {
          pane.predicted = false;
          render();
        }
      }, settings.resolveTimeout);
    }
  }

  const solved = panes.every(other => other === pane || other.clicked);
  if (solved) finishing = true;

  const resolve = () => {
    pane.clicked = true;
    pane.predicted = false;
    render();
    if (solved) finish();
    else if (hoverClicks() && hoveredIndex >= 0) clickPane(hoveredIndex, "hover");
  };
  if (settings.ping > 0) setTimeout(resolve, settings.ping);
  else resolve();
}

function flashWrong(index) {
  const slot = elements.terminal.children[index];
  if (!slot) return;
  slot.classList.remove("wrong");
  void slot.offsetWidth; // restart the animation
  slot.classList.add("wrong");
}

/** Ends the run. [result] is the server's word on a ranked one: its time, and where it landed. */
function finish(result = null) {
  running = false;
  const seconds = result ? result.time_ms / 1000 : (performance.now() - startedAt) / 1000;
  elements.time.textContent = formatTime(seconds);
  elements.time.classList.remove("running");
  elements.last.textContent = formatTime(seconds);

  const isBest = best === null || seconds < best;
  if (isBest) {
    best = seconds;
    localStorage.setItem(bestKeyFor(paneCount()), String(seconds));
    elements.best.classList.add("fresh");
  }
  elements.best.textContent = formatTime(best);

  const next = settings.autoRestart ? "Next terminal opening..." : "Press R for another";
  const ranking = !result ? "" : result.error ? `Not ranked: ${result.error}` : result.ok ? `#${Number(result.rank)} on the leaderboard` : "";
  showMessage(`${isBest ? "New best!" : "Solved"} ${formatTime(seconds)}`, ...(ranking ? [ranking, next] : [next]));

  // For the leaderboard panel (leaderboard.js).
  window.dispatchEvent(new CustomEvent("terminal:finish", {
    detail: { seconds, count: paneCount(), mode: runMode(), ranked: result }
  }));
  ranked = null;

  if (settings.autoRestart) setTimeout(newTerminal, 800);
}

/* ---------- run record ---------- */

// Each run keeps a record for the leaderboard, whose server checks it before accepting a time:
// the layout, every pane as it was cleared (when, where the pointer was, and how), and the
// pointer's path. Positions are in panes from the first pane's top-left corner: x 2.5 is halfway
// across the third column. Only real input counts - events a script makes up are ignored.
const PATH_SAMPLE_MS = 16;
const MAX_PATH = 4000;
let record = null;
let pathPane = null;
/** The latest real pointer event's position, in page pixels, and what made it. */
let pointer = null;

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/** Where the panes are on the page right now: the first one's corner, the pitch, and how much of it a pane fills. */
function gridGeometry() {
  const slots = elements.terminal.children;
  const columns = Math.ceil(panes.length / ROWS);
  if (slots.length <= columns) return null;
  const first = slots[0].getBoundingClientRect();
  const pitchX = slots[1].getBoundingClientRect().left - first.left;
  const pitchY = slots[columns].getBoundingClientRect().top - first.top;
  if (!(pitchX > 0 && pitchY > 0)) return null;
  return { left: first.left, top: first.top, pitchX, pitchY, fillX: first.width / pitchX, fillY: first.height / pitchY, columns };
}

function toPanes(clientX, clientY, geometry) {
  return [(clientX - geometry.left) / geometry.pitchX, (clientY - geometry.top) / geometry.pitchY];
}

function paneAt(x, y, geometry) {
  const column = Math.floor(x);
  const row = Math.floor(y);
  if (column < 0 || column >= geometry.columns || row < 0 || row >= ROWS) return -1;
  if (x - column > geometry.fillX || y - row > geometry.fillY) return -1;
  return row * geometry.columns + column;
}

function startRecord() {
  record = { layout: panes.map(pane => pane.number), clicks: [], path: [] };
  pathPane = null;
}

/**
 * Notes a real pointer event: where the pointer is, and (unless [sample] is false) a point on its
 * path - every move onto another pane, and otherwise about one a frame.
 */
function track(event, sample = true) {
  if (!event.isTrusted) return;
  pointer = { clientX: event.clientX, clientY: event.clientY, type: event.pointerType || "mouse" };
  if (!sample || !running || !record) return;
  const geometry = gridGeometry();
  if (!geometry) return;
  const [x, y] = toPanes(event.clientX, event.clientY, geometry);
  const t = performance.now() - startedAt;
  const pane = paneAt(x, y, geometry);
  const last = record.path[record.path.length - 1];
  if (record.path.length < MAX_PATH && (pane !== pathPane || !last || t - last[0] >= PATH_SAMPLE_MS)) {
    record.path.push([round(t, 1), round(x, 3), round(y, 3)]);
    pathPane = pane;
  }
}

function recordClick(index, via) {
  if (!record) return;
  const geometry = gridGeometry();
  const [x, y] = pointer && geometry ? toPanes(pointer.clientX, pointer.clientY, geometry) : [null, null];
  record.clicks.push({
    i: index, t: round(performance.now() - startedAt, 1),
    x: x === null ? null : round(x, 3), y: y === null ? null : round(y, 3),
    via, type: pointer ? pointer.type : null
  });
}

/** The message over the terminal: a line, and smaller lines under it (all plain text). */
function showMessage(title, ...details) {
  elements.message.replaceChildren(document.createTextNode(title));
  for (const detail of details) elements.message.append(Object.assign(document.createElement("small"), { textContent: detail }));
  elements.message.hidden = false;
}

/* ---------- ranked terminals ---------- */

// With a leaderboard name (and Ranked runs on), terminals are played through the leaderboard
// server the way SkyBlock's are (worker/src/session.js): it deals the terminal, every click goes to
// it with the menu's current window id, it clears panes on its ticks, and it times the run. So the
// Ping setting doesn't apply - your real ping does. Otherwise terminals are local practice.

const DEAL_TIMEOUT_MS = 5000;
/** The ranked terminal in play: { id, window, awaiting (pane waiting on the server, or -1), sentPath }. */
let ranked = null;
/** A ranked terminal asked for and not dealt yet: { id, count, timer }. */
let dealing = null;
/** The connection to the server, kept open between terminals (the server closes it when idle). */
let socket = null;
let socketOpen = null;
let rankedSerial = 0;

function stored(key) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
}

/** The leaderboard server (leaderboard.js has the same rule: ?api= only for a copy on this machine). */
function leaderboardApi() {
  let api = document.querySelector('meta[name="leaderboard-api"]')?.content || "";
  const wanted = new URLSearchParams(location.search).get("api");
  const local = new Set(["localhost", "127.0.0.1"]);
  if (wanted && local.has(location.hostname)) {
    try {
      if (local.has(new URL(wanted).hostname)) api = wanted;
    } catch { /* not an address */ }
  }
  return api.replace(/\/$/, "");
}

/** Who plays ranked: a saved leaderboard name and its browser key, if Ranked runs is on. */
function rankedPlayer() {
  const api = leaderboardApi();
  const name = stored("numbers-terminal.leaderboard.name");
  const key = stored("numbers-terminal.leaderboard.key");
  if (!api || typeof name !== "string" || typeof key !== "string") return null;
  if (stored("numbers-terminal.leaderboard.ranked") === false) return null;
  return { api, name, key };
}

function connect(api) {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return socketOpen;
  const connection = new WebSocket(api.replace(/^http/, "ws") + "/v1/play");
  socket = connection;
  socketOpen = new Promise((resolve, reject) => {
    connection.addEventListener("open", () => resolve(connection), { once: true });
    connection.addEventListener("error", () => reject(new Error("Couldn't reach the leaderboard.")), { once: true });
  });
  socketOpen.catch(() => {});
  connection.addEventListener("message", event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    fromServer(message);
  });
  connection.addEventListener("close", () => {
    if (socket === connection) socket = null;
    if (dealing) practiceInstead("Lost the leaderboard connection, so this one's practice.");
    else if (ranked && running) {
      running = false;
      ranked = null;
      showMessage("Lost the connection to the leaderboard", "Press R for another");
    }
  });
  return socketOpen;
}

async function dealRanked(count, player) {
  running = false;
  const id = ++rankedSerial;
  dealing = { id, count, timer: setTimeout(() => {
    if (dealing?.id === id) practiceInstead("The leaderboard didn't answer in time, so this one's practice.");
  }, DEAL_TIMEOUT_MS) };
  showMessage("Dealing a ranked terminal...");
  try {
    const connection = await connect(player.api);
    if (dealing?.id !== id) return;
    connection.send(JSON.stringify({ type: "start", id, count, mode: runMode(), name: player.name, key: player.key }));
  } catch (error) {
    if (dealing?.id === id) practiceInstead(`${error.message} This one's practice.`);
  }
}

function practiceInstead(reason) {
  const count = dealing ? dealing.count : paneCount();
  clearTimeout(dealing?.timer);
  dealing = null;
  window.dispatchEvent(new CustomEvent("ranked:notice", { detail: reason }));
  startTerminal(practiceLayout(count), null);
}

function fromServer(message) {
  if (message.type === "kicked") {
    running = false;
    ranked = null;
    showMessage("Kicked by the leaderboard", String(message.reason || ""), "Press R for another");
    return;
  }
  if (message.type === "terminal" || message.type === "error") {
    if (!dealing || message.id !== dealing.id) return;
    if (message.type === "error") {
      practiceInstead(`Not ranked: ${message.error}`);
      return;
    }
    clearTimeout(dealing.timer);
    dealing = null;
    socket?.send(JSON.stringify({ type: "ready" }));
    startTerminal(message.layout, { id: message.id, window: message.window, awaiting: -1, sentPath: 0 });
    return;
  }
  if (!ranked || message.id !== ranked.id) return;
  if (message.type === "cleared") paneCleared(message.i, message.window, null);
  else if (message.type === "done") paneCleared(message.i, null, message);
}

/** Sends a click to the server, with this browser's record of it; the pane clears when it answers. */
function sendRankedClick(pane, index, via) {
  ranked.awaiting = index;
  if (panes.every(other => other === pane || other.clicked)) finishing = true;
  if (settings.clientPrediction) {
    pane.predicted = true;
    render();
    // Odin reloads the terminal if the server hasn't answered by the resolve timeout.
    ranked.prediction = setTimeout(() => {
      if (!pane.clicked) {
        pane.predicted = false;
        render();
      }
    }, settings.resolveTimeout);
  }
  const click = record.clicks[record.clicks.length - 1];
  const geometry = gridGeometry();
  socket?.send(JSON.stringify({
    type: "click", window: ranked.window, i: index,
    t: click.t, x: click.x, y: click.y, via, pointer: click.type,
    path: record.path.slice(ranked.sentPath),
    fill: geometry ? [round(geometry.fillX, 3), round(geometry.fillY, 3)] : null
  }));
  ranked.sentPath = record.path.length;
}

/** The server cleared a pane: the next one can be clicked (with [window]), or the run is [done]. */
function paneCleared(index, window, done) {
  const pane = panes[index];
  if (!pane || !ranked) return;
  clearTimeout(ranked.prediction);
  ranked.awaiting = -1;
  ranked.window = window;
  pane.clicked = true;
  pane.predicted = false;
  render();
  if (done) finish(done);
  else if (hoverClicks() && hoveredIndex >= 0) clickPane(hoveredIndex, "hover");
}

document.addEventListener("pointermove", event => track(event), { capture: true, passive: true });

/** How the run was played: sweeping without a key, sweeping with the drop key, or clicking. */
function runMode() {
  return settings.hoverMode ? "hover" : settings.dropKey ? "drop" : "click";
}

function formatTime(seconds) {
  return seconds === null ? "–" : `${seconds.toFixed(3)}s`;
}

function tick() {
  if (running) {
    elements.time.textContent = formatTime((performance.now() - startedAt) / 1000);
    elements.time.classList.add("running");
  }
  requestAnimationFrame(tick);
}

/* ---------- settings panel ---------- */

const CONTROLS = [
  "renderType", "termSize", "normalTermSize", "roundness", "gap", "showNumbers",
  "numberCount", "blockIncorrect", "clientPrediction", "hoverMode", "dropKey", "resolveTimeout", "firstClickProt", "ping", "autoRestart",
  "background", "order1", "order2", "order3"
];

const UNITS = { resolveTimeout: "ms", firstClickProt: "ms", ping: "ms" };

function bindControls() {
  for (const name of CONTROLS) {
    const input = document.getElementById(name);
    if (!input) continue;
    input.addEventListener("input", () => {
      settings[name] = input.type === "checkbox" ? input.checked
        : input.type === "range" ? Number(input.value)
        : input.value;
      saveSettings();
      syncOutputs();
      applySettings();
      // Changing how many numbers there are needs a fresh terminal to play on.
      if (name === "numberCount") newTerminal();
    });
  }
}

function syncControls() {
  for (const name of CONTROLS) {
    const input = document.getElementById(name);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(settings[name]);
    else input.value = settings[name];
  }
  syncOutputs();
}

function syncOutputs() {
  for (const name of CONTROLS) {
    const input = document.getElementById(name);
    const output = input && input.parentElement.querySelector("output");
    if (!input || !output) continue;
    output.textContent = `${settings[name]}${UNITS[name] || ""}`;
  }
}

function toggleSettings(show) {
  elements.settings.hidden = show === undefined ? !elements.settings.hidden : !show;
  // One side panel at a time.
  if (!elements.settings.hidden) window.dispatchEvent(new CustomEvent("panel:open", { detail: "settings" }));
}

window.addEventListener("panel:open", event => { if (event.detail !== "settings") toggleSettings(false); });

document.getElementById("restart").addEventListener("click", newTerminal);
document.getElementById("toggle-settings").addEventListener("click", () => toggleSettings());
document.getElementById("close-settings").addEventListener("click", () => toggleSettings(false));

document.getElementById("reset-settings").addEventListener("click", () => {
  settings = { ...DEFAULTS };
  saveSettings();
  syncControls();
  applySettings();
});

document.getElementById("reset-pb").addEventListener("click", () => {
  best = null;
  localStorage.removeItem(bestKeyFor(paneCount()));
  elements.best.textContent = formatTime(null);
  elements.best.classList.remove("fresh");
});

const dropKeyButton = document.getElementById("dropKeyBind");

function keyLabel(code) {
  if (!code) return "None";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Numpad ${code.slice(6)}`;
  return code.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function stopBinding() {
  bindingDropKey = false;
  dropKeyButton.classList.remove("listening");
  dropKeyButton.textContent = keyLabel(settings.dropKeyBind);
}

dropKeyButton.addEventListener("click", () => {
  bindingDropKey = true;
  dropKeyButton.classList.add("listening");
  dropKeyButton.textContent = "Press a key";
});

document.addEventListener("keydown", event => {
  if (bindingDropKey) {
    event.preventDefault();
    if (event.key !== "Escape") {
      settings.dropKeyBind = event.code;
      saveSettings();
    }
    stopBinding();
    return;
  }

  if (settings.dropKey && event.code === settings.dropKeyBind) {
    // Claimed, so other shortcuts (leaderboard.js) leave it alone.
    event.preventDefault();
    dropKeyHeld = true;
    // Pressing it while already over a pane counts too, not just moving onto one.
    if (hoveredIndex >= 0) clickPane(hoveredIndex, "key");
    return;
  }

  if (event.target.matches("input, select")) return;
  const key = event.key.toLowerCase();
  if (key === "r") newTerminal();
  else if (key === "s") toggleSettings();
  else if (event.key === "Escape") toggleSettings(false);
});

document.addEventListener("keyup", event => {
  if (event.code === settings.dropKeyBind) dropKeyHeld = false;
});

// Alt-tabbing with the key down would otherwise leave it stuck.
if (typeof window !== "undefined") window.addEventListener("blur", () => { dropKeyHeld = false; });

// Best times used to be stored without a count; keep that one as the fourteen number best.
const legacyBest = localStorage.getItem(BEST_KEY);
if (legacyBest && !localStorage.getItem(bestKeyFor(FULL_COUNT))) localStorage.setItem(bestKeyFor(FULL_COUNT), legacyBest);

stopBinding();
bindControls();
syncControls();
applySettings();
newTerminal();
requestAnimationFrame(tick);
