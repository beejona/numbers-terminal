// Makes a run record (see ../src/checkrun.js) like a person's: uneven gaps between panes, clicks
// anywhere on the pane, and the pointer's path onto each pane before it's pressed.

/** A small seeded random source, so a test's runs are the same every time. */
export function randomSource(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function humanRun({ count, mode = "click", time, ping = 0, random = randomSource(7), touch = false, layout: given = null }) {
  const columns = count / 2;
  const fill = [1, 1];
  // The terminal's layout (as the server dealt it), or a random one.
  const layout = given ? [...given] : Array.from({ length: count }, (_, i) => i + 1);
  if (!given) {
    for (let i = layout.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [layout[i], layout[j]] = [layout[j], layout[i]];
    }
  }
  // Uneven gaps that add up to the run: the first pane after a moment, the last clear at `time`.
  const end = time - ping - 1;
  const weights = Array.from({ length: count }, (_, k) => (k === 0 ? 0.6 : 0.75 + random() * 0.5));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  const times = weights.map(w => (t += (w / total) * end));
  const via = mode === "click" ? "down" : mode === "hover" ? "hover" : "key";
  const clicks = [];
  const path = [];
  let at = [columns / 2, 2.4]; // below the grid, where a pointer would start
  times.forEach((when, k) => {
    const index = layout.indexOf(k + 1);
    const target = [index % columns + 0.12 + random() * 0.76, Math.floor(index / columns) + 0.12 + random() * 0.76];
    const start = k === 0 ? Math.max(0, when - 60) : times[k - 1];
    // A few points on the way over, the last one on the pane.
    for (const f of [0.35, 0.7, 1]) {
      path.push([+(start + (when - start) * f * 0.95).toFixed(1), +(at[0] + (target[0] - at[0]) * f).toFixed(3), +(at[1] + (target[1] - at[1]) * f).toFixed(3)]);
    }
    clicks.push({ i: index, t: +when.toFixed(1), x: +target[0].toFixed(3), y: +target[1].toFixed(3), via, type: touch ? "touch" : "mouse" });
    at = target;
  });
  return { layout, clicks, path, fill };
}
