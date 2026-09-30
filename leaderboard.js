import { checkName } from "./namefilter.js?v=8";

/**
 * The live leaderboard panel. Pick a name once; from then on every run that beats your best for
 * its terminal size and play mode is posted. The board refreshes itself while it's open.
 *
 * A name belongs to this browser: a random key made here is sent with every post, and the server
 * only accepts posts for a name from the key that first used it.
 */

// The server is fixed in the page. A ?api= address only works for a copy running on this machine
// pointed at a local test server: taken from a link, it could send your name key to someone else.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
function localTestServer() {
  const wanted = new URLSearchParams(location.search).get("api");
  if (!wanted || !LOCAL_HOSTS.has(location.hostname)) return null;
  try {
    return LOCAL_HOSTS.has(new URL(wanted).hostname) ? wanted : null;
  } catch {
    return null;
  }
}
const API = (localTestServer() || document.querySelector('meta[name="leaderboard-api"]')?.content || "").replace(/\/$/, "");
const REFRESH_MS = 15_000;
const NAME_KEY = "numbers-terminal.leaderboard.name";
const SECRET_KEY = "numbers-terminal.leaderboard.key";
const BESTS_KEY = "numbers-terminal.leaderboard.bests";
const MODE_LABELS = { click: "Click", drop: "Drop key", hover: "Hover" };

const panel = document.getElementById("leaderboard");
const list = document.getElementById("lb-list");
const status = document.getElementById("lb-status");
const updated = document.getElementById("lb-updated");
const nameInput = document.getElementById("lb-name");
const nameNote = document.getElementById("lb-name-note");
const saveButton = document.getElementById("lb-save");

let view = { count: currentCount(), mode: "all" };
let refreshTimer = 0;
let lastLoaded = 0;
let checkTimer = 0;

/* ---------- storage ---------- */

function read(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage full or blocked: the board still works for this visit */ }
}

function secret() {
  let key = read(SECRET_KEY, null);
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    key = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    write(SECRET_KEY, key);
  }
  return key;
}

async function owner() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret()));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function currentCount() {
  const settings = read("numbers-terminal.settings", {});
  return Number(settings.numberCount) === 10 ? 10 : 14;
}

/** This browser's best per size and mode, as { "14": { click: { time_ms, ping, posted } } }. */
function bests() {
  return read(BESTS_KEY, {});
}

/* ---------- server ---------- */

async function api(path, options) {
  if (!API) throw new Error("The leaderboard isn't connected yet.");
  // Only posts carry JSON: a plain GET needs no CORS preflight.
  const headers = options?.body ? { "Content-Type": "application/json" } : {};
  const response = await fetch(API + path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "The leaderboard didn't answer."), { status: response.status });
  return body;
}

async function postRun(count, mode, run) {
  const name = read(NAME_KEY, null);
  if (!name) return null;
  const result = await api("/v1/scores", {
    method: "POST",
    body: JSON.stringify({ name, key: secret(), count, mode, ping: run.ping, time_ms: run.time_ms })
  });
  const all = bests();
  const entry = all[count]?.[mode];
  if (entry && entry.time_ms >= result.best_ms) entry.posted = true;
  write(BESTS_KEY, all);
  return result;
}

/** A run the server turned down for good (an impossible time, say) mustn't stand as a best that blocks real ones. */
function forget(count, mode, run, previous) {
  const all = bests();
  if (all[count]?.[mode]?.time_ms !== run.time_ms) return;
  if (previous) all[count][mode] = previous;
  else delete all[count][mode];
  write(BESTS_KEY, all);
}

/** Posts every best that hasn't made it to the server yet (runs from before a name was picked, or offline). */
async function postPending() {
  const all = bests();
  for (const count of Object.keys(all)) {
    for (const mode of Object.keys(all[count])) {
      const run = all[count][mode];
      if (run.posted) continue;
      try {
        await postRun(Number(count), mode, run);
      } catch (error) {
        if (error.status === 400) {
          forget(count, mode, run);
          continue;
        }
        setStatus(error.message, "bad");
        return;
      }
    }
  }
}

/* ---------- runs ---------- */

window.addEventListener("terminal:finish", async event => {
  const { seconds, count, mode, ping } = event.detail;
  // Rounded the way the page shows it (toFixed), so the board and the Best box always agree.
  const time = Math.round(Number(seconds.toFixed(3)) * 1000);
  const all = bests();
  all[count] ??= {};
  const previous = all[count][mode];
  if (previous && previous.time_ms <= time) return;
  const run = { time_ms: time, ping, posted: false };
  all[count][mode] = run;
  write(BESTS_KEY, all);

  if (!read(NAME_KEY, null) || !API) return;
  try {
    const result = await postRun(count, mode, run);
    setStatus(`${MODE_LABELS[mode]} best posted: #${result.rank} on the ${count} number ${MODE_LABELS[mode].toLowerCase()} board.`, "good");
    const message = document.getElementById("message");
    if (!message.hidden) message.append(element("small", `#${Number(result.rank)} on the leaderboard`));
    if (!panel.hidden) load();
  } catch (error) {
    // Refused outright: forget it. Anything else (offline, say) stays pending and goes up later.
    if (error.status === 400) forget(count, mode, run, previous);
    setStatus(`Couldn't post that run: ${error.message}`, "bad");
  }
});

/* ---------- panel ---------- */

function setStatus(text, tone = "") {
  status.textContent = text;
  status.dataset.tone = tone;
}

function formatTime(ms) {
  return `${(ms / 1000).toFixed(3)}s`;
}

/** A new element with plain text in it: nothing from the server is ever read as HTML. */
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function showNote(text) {
  list.replaceChildren(element("p", text, "lb-empty"));
}

async function load() {
  if (!API) {
    showNote("The leaderboard isn't connected yet.");
    return;
  }
  try {
    const board = await api(`/v1/scores?count=${view.count}&mode=${view.mode}`);
    const scores = Array.isArray(board.scores) ? board.scores : [];
    if (scores.length === 0) {
      showNote(`No times yet${view.mode === "all" ? "" : ` for ${MODE_LABELS[view.mode].toLowerCase()}`}. Be the first.`);
    } else {
      const me = String(read(NAME_KEY, "") || "").toLowerCase();
      const table = element("table");
      const head = table.createTHead().insertRow();
      for (const title of ["#", "Name", "Time", "Mode", "Ping"]) head.append(element("th", title));
      const body = table.createTBody();
      for (const score of scores) {
        const name = String(score.name);
        const mode = MODE_LABELS[score.mode] ? score.mode : "click";
        const row = body.insertRow();
        if (name.toLowerCase() === me) row.className = "me";
        const tag = element("span", MODE_LABELS[mode], `lb-mode ${mode}`);
        row.append(element("td", Number(score.rank)), element("td", name), element("td", formatTime(Number(score.time_ms))),
          element("td"), element("td", `${Number(score.ping)}ms`));
        row.cells[3].append(tag);
      }
      list.replaceChildren(table);
    }
    lastLoaded = Date.now();
    showUpdated();
  } catch (error) {
    showNote(error.message);
  }
}

function showUpdated() {
  if (!lastLoaded) return;
  const seconds = Math.round((Date.now() - lastLoaded) / 1000);
  updated.textContent = `Updated ${seconds < 5 ? "just now" : `${seconds}s ago`} · refreshes live`;
}

function selectTab(group, value) {
  for (const button of panel.querySelectorAll(`[data-${group}]`)) {
    button.classList.toggle("active", button.dataset[group] === String(value));
  }
}

function open(show) {
  panel.hidden = show === undefined ? !panel.hidden : !show;
  clearInterval(refreshTimer);
  if (panel.hidden) return;
  window.dispatchEvent(new CustomEvent("panel:open", { detail: "leaderboard" }));
  view.count = currentCount();
  selectTab("count", view.count);
  load();
  refreshTimer = setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
}

// Back to a tab that stopped refreshing while hidden: catch up at once.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !panel.hidden) load(); });

window.addEventListener("panel:open", event => { if (event.detail !== "leaderboard") open(false); });
setInterval(showUpdated, 1000);

/* ---------- name ---------- */

function showName() {
  const name = read(NAME_KEY, null);
  if (name) {
    nameInput.value = name;
    setStatus(`Posting as ${name}. Your new bests go up automatically.`, "good");
  } else {
    setStatus("Pick a name to put your bests on the board.");
  }
}

async function checkAvailability(name) {
  const local = checkName(name);
  if (!local.ok) return local;
  if (!API) return { ok: true };
  const result = await api(`/v1/name?name=${encodeURIComponent(name)}&owner=${await owner()}`);
  if (result.status === "taken") return { ok: false, reason: "That name is already taken." };
  if (result.status === "invalid") return { ok: false, reason: result.reason };
  return { ok: true, yours: result.status === "yours" };
}

nameInput.addEventListener("input", () => {
  clearTimeout(checkTimer);
  const name = nameInput.value.trim();
  if (!name) {
    nameNote.textContent = "";
    return;
  }
  const local = checkName(name);
  nameNote.textContent = local.ok ? "Checking..." : local.reason;
  nameNote.dataset.tone = local.ok ? "" : "bad";
  if (!local.ok) return;
  checkTimer = setTimeout(async () => {
    try {
      const result = await checkAvailability(name);
      if (nameInput.value.trim() !== name) return;
      nameNote.textContent = result.ok ? (result.yours ? "That's your name." : "Available.") : result.reason;
      nameNote.dataset.tone = result.ok ? "good" : "bad";
    } catch (error) {
      nameNote.textContent = error.message;
      nameNote.dataset.tone = "bad";
    }
  }, 350);
});

document.getElementById("lb-name-form").addEventListener("submit", async event => {
  event.preventDefault();
  const name = nameInput.value.trim();
  saveButton.disabled = true;
  try {
    const result = await checkAvailability(name);
    if (!result.ok) {
      nameNote.textContent = result.reason;
      nameNote.dataset.tone = "bad";
      return;
    }
    write(NAME_KEY, name);
    // A new name hasn't posted anything yet.
    const all = bests();
    for (const count of Object.keys(all)) for (const mode of Object.keys(all[count])) all[count][mode].posted = false;
    write(BESTS_KEY, all);
    nameNote.textContent = "";
    showName();
    await postPending();
    load();
  } catch (error) {
    nameNote.textContent = error.message;
    nameNote.dataset.tone = "bad";
  } finally {
    saveButton.disabled = false;
  }
});

/* ---------- wiring ---------- */

document.getElementById("toggle-leaderboard").addEventListener("click", () => open());
document.getElementById("close-leaderboard").addEventListener("click", () => open(false));
for (const button of panel.querySelectorAll("[data-count]")) {
  button.addEventListener("click", () => { view.count = Number(button.dataset.count); selectTab("count", view.count); load(); });
}
for (const button of panel.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => { view.mode = button.dataset.mode; selectTab("mode", view.mode); load(); });
}

document.addEventListener("keydown", event => {
  // The page's own keys (and the drop key) come first.
  if (event.defaultPrevented || event.target.matches("input, select, textarea")) return;
  if (event.key.toLowerCase() === "l") open();
  else if (event.key === "Escape") open(false);
});

selectTab("mode", view.mode);
showName();
if (read(NAME_KEY, null) && API) postPending();
