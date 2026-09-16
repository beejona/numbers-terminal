"use strict";

// The terminal itself: a 4-row chest titled "Click in order!", whose 14 numbered panes sit in a
// 2 x 7 block inset one row and one column. Only that block is ever clickable, so that's all the
// page draws.
const COLUMNS = 7;
const ROWS = 2;
const PANES = COLUMNS * ROWS;

// Odin's own defaults for its terminal solver and simulator.
const DEFAULTS = Object.freeze({
  renderType: "Custom GUI",
  termSize: 3,
  normalTermSize: 3,
  roundness: 0,
  gap: 0,
  showNumbers: false,
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
let best = Number(localStorage.getItem(BEST_KEY)) || null;

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

function shuffled(count) {
  const numbers = Array.from({ length: count }, (_, i) => i + 1);
  for (let i = numbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }
  return numbers;
}

function newTerminal() {
  panes = shuffled(PANES).map(number => ({ number, clicked: false, predicted: false }));
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
      if (event.button !== 0) return;
      event.preventDefault();
      clickPane(index);
    });
    slot.addEventListener("pointerenter", () => {
      hoveredIndex = index;
      if (hoverClicks()) clickPane(index, true);
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

function clickPane(index, viaHover = false) {
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
    else if (hoverClicks() && hoveredIndex >= 0) clickPane(hoveredIndex, true);
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

function finish() {
  running = false;
  const seconds = (performance.now() - startedAt) / 1000;
  elements.time.textContent = formatTime(seconds);
  elements.time.classList.remove("running");
  elements.last.textContent = formatTime(seconds);

  const isBest = best === null || seconds < best;
  if (isBest) {
    best = seconds;
    localStorage.setItem(BEST_KEY, String(seconds));
    elements.best.classList.add("fresh");
  }
  elements.best.textContent = formatTime(best);

  elements.message.innerHTML = `${isBest ? "New best!" : "Solved"} ${formatTime(seconds)}` +
    `<small>${settings.autoRestart ? "Next terminal opening..." : "Press R for another"}</small>`;
  elements.message.hidden = false;

  if (settings.autoRestart) setTimeout(newTerminal, 800);
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
  "blockIncorrect", "clientPrediction", "hoverMode", "dropKey", "resolveTimeout", "firstClickProt", "ping", "autoRestart",
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
}

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
  localStorage.removeItem(BEST_KEY);
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
    dropKeyHeld = true;
    // Pressing it while already over a pane counts too, not just moving onto one.
    if (hoveredIndex >= 0) clickPane(hoveredIndex, true);
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

elements.best.textContent = formatTime(best);
stopBinding();
bindControls();
syncControls();
applySettings();
newTerminal();
requestAnimationFrame(tick);
