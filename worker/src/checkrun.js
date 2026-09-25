/**
 * Checks a run's record (app.js, "run record") against the time it claims.
 *
 * The record lists the terminal's layout, each pane as it was cleared - when, where the pointer
 * was, and how ("down" pressed, "hover", "key" for the drop key) - and the pointer's path, all in
 * pane units from the first pane's top-left corner. None of it can be proven: it comes from the
 * player's browser like the time does. What it does is make a fake time take a fake run that
 * holds together, and turn away the tells of scripted clicking.
 *
 * Returns null for a run that checks out, or the reason it doesn't.
 */

const MAX_PATH = 6000;
// A click may sit this far (in panes) outside its pane: rounding, and the edge of the button.
const EDGE = 0.03;
// Press to press, no hand clears two panes faster than this.
const MIN_CLICK_GAP_MS = 30;
// Human clicks are never this evenly spaced (standard deviation of the gaps, in ms).
const MIN_GAP_SPREAD_MS = 3;
// A script aims for the exact middle; a hand lands anywhere on the pane.
const CENTRE = 0.01;
// Browsers report the pointer about once a frame; two reports this close together (ms) are the
// same moment, and a pointer can't be this far apart (panes) at one moment.
const SAME_MOMENT_MS = 1.5;
const TELEPORT = 0.25;
// Pointer arriving on a pane in the same instant as the press (ms): a flick can do it now and then,
// a hand can't do it for most of a run.
const INSTANT_MS = 1;

const NO_RECORD = "This run has no record of its clicks. Refresh the page and play it again.";
const BROKEN = "This run's record doesn't hold together.";

const finite = value => typeof value === "number" && Number.isFinite(value);

export function checkRun(run, { count, mode, ping, time }) {
  if (!run || typeof run !== "object") return NO_RECORD;
  const { layout, clicks, path, fill } = run;
  const columns = count / 2;

  if (!Array.isArray(layout) || layout.length !== count) return BROKEN;
  if (new Set(layout).size !== count || !layout.every(n => Number.isInteger(n) && n >= 1 && n <= count)) return BROKEN;
  if (!Array.isArray(fill) || fill.length !== 2 || !fill.every(f => finite(f) && f > 0.3 && f <= 1.001)) return BROKEN;
  if (!Array.isArray(clicks) || clicks.length !== count) return BROKEN;
  if (!Array.isArray(path) || path.length > MAX_PATH) return BROKEN;

  let before = -Infinity;
  for (const point of path) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(finite) || point[0] < before) return BROKEN;
    before = point[0];
  }

  const onPane = (x, y, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return x >= column - EDGE && x <= column + fill[0] + EDGE && y >= row - EDGE && y <= row + fill[1] + EDGE;
  };

  let last = 0;
  for (let k = 0; k < count; k++) {
    const click = clicks[k];
    if (!click || typeof click !== "object" || !Number.isInteger(click.i) || click.i < 0 || click.i >= count) return BROKEN;
    if (!finite(click.t) || click.t < last) return BROKEN;
    if (!["down", "hover", "key"].includes(click.via)) return BROKEN;
    if (layout[click.i] !== k + 1) return "This run's clicks aren't in order.";
    if (!finite(click.x) || !finite(click.y) || !onPane(click.x, click.y, click.i)) return "A click in this run wasn't on its pane.";
    if (mode === "click" && click.via !== "down") return "This run wasn't all clicks: some panes were hovered.";
    last = click.t;
  }

  // A pointer can't be in two places at once. (Fingers can: runs with taps are let off.)
  if (!clicks.some(click => click.type === "touch" || click.type === "pen")) {
    for (let k = 1; k < path.length; k++) {
      const [t0, x0, y0] = path[k - 1];
      const [t1, x1, y1] = path[k];
      if (t1 - t0 <= SAME_MOMENT_MS && Math.hypot(x1 - x0, y1 - y0) > TELEPORT) {
        return "In this run the pointer was in two places at once.";
      }
    }
  }

  // The time can't be shorter than the run it came from (a ping delays the last pane's clear).
  const end = clicks[count - 1].t + (ping > 0 ? ping : 0);
  if (time < end - 5 || time > end + 5000) return "This run's time doesn't match its clicks.";

  if (mode !== "click") return null;

  // Each pane the pointer has to be moved onto before it's pressed - and a hand gets there before
  // it presses, not in the same instant, at least most of the time. A finger (or a pen, which may
  // not hover) lands without moving over first, so those taps are let off.
  let instant = 0;
  let pointed = 0;
  for (let k = 1; k < count; k++) {
    const click = clicks[k];
    if (click.type === "touch" || click.type === "pen") continue;
    const from = clicks[k - 1].t;
    const arrivals = path.filter(([t, x, y]) => t >= from && t <= click.t + 0.5 && onPane(x, y, click.i));
    if (arrivals.length === 0) return "In this run a pane was clicked without the pointer moving onto it.";
    pointed++;
    if (arrivals[0][0] >= click.t - INSTANT_MS) instant++;
  }
  if (pointed >= 4 && instant > pointed / 2) return "In this run the pointer reached each pane at the very instant it clicked.";

  const gaps = clicks.slice(1).map((click, k) => click.t - clicks[k].t);
  if (Math.min(...gaps) < MIN_CLICK_GAP_MS) return "Two clicks in this run were closer together than a hand can click.";
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const spread = Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length);
  if (gaps.length >= 5 && spread < MIN_GAP_SPREAD_MS) return "This run's clicks were too evenly spaced to be by hand.";

  const centred = clicks.filter(click => {
    const column = click.i % columns;
    const row = Math.floor(click.i / columns);
    return Math.abs(click.x - (column + fill[0] / 2)) < CENTRE && Math.abs(click.y - (row + fill[1] / 2)) < CENTRE;
  }).length;
  if (centred >= Math.ceil(count * 0.8)) return "Every click in this run hit the exact middle of its pane.";

  return null;
}
