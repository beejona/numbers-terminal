(function (root) {
  const MAX_POINTS = 8000;
  const exact = typeof PointerEvent !== "undefined" && "getCoalescedEvents" in PointerEvent.prototype;

  let points = [];
  let clears = [];
  let pitch = 0;
  let last = null;
  let active = false;

  function start(panePitch) {
    points = [];
    clears = [];
    pitch = panePitch;
    active = true;
  }

  function stop() {
    active = false;
  }

  function onMove(event) {
    const batch = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    for (const move of batch.length ? batch : [event]) {
      last = { t: move.timeStamp, x: move.clientX, y: move.clientY };
      if (active && points.length < MAX_POINTS) points.push(last);
    }
  }

  function clear(via, event, rect) {
    if (!active) return;
    const placed = event && typeof event.clientX === "number";
    clears.push({
      t: event ? event.timeStamp : performance.now(),
      x: placed ? event.clientX : last ? last.x : 0,
      y: placed ? event.clientY : last ? last.y : 0,
      via,
      trusted: event ? event.isTrusted : true,
      pointer: event && event.pointerType ? event.pointerType : "mouse",
      rect
    });
  }

  function within(point, rect) {
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  }

  function review(clears, points, pitch, exact) {
    if (clears.some(c => !c.trusted)) return false;
    if (!(pitch > 0) || clears.some(c => c.pointer !== "mouse")) return true;

    let moves = 0, jumps = 0, traced = 0, lines = 0, presses = 0, instant = 0, aimed = 0, centred = 0;
    let from = 0;
    for (let k = 0; k < clears.length; k++) {
      const b = clears[k];
      if (b.via === "down" && b.rect) {
        aimed++;
        const cx = (b.rect.left + b.rect.right) / 2;
        const cy = (b.rect.top + b.rect.bottom) / 2;
        if (Math.abs(b.x - cx) <= 1 && Math.abs(b.y - cy) <= 1) centred++;
      }
      if (k === 0) continue;

      const a = clears[k - 1];
      while (from < points.length && points[from].t <= a.t) from++;
      const path = [];
      for (let j = from; j < points.length && points[j].t <= b.t; j++) path.push(points[j]);

      if (b.via === "down" && exact && b.rect) {
        presses++;
        const arrival = path.find(p => within(p, b.rect));
        if (!arrival || b.t - arrival.t <= 1) instant++;
      }

      const span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span < 0.6 * pitch) continue;
      moves++;
      const line = [a, ...path, b];
      const steps = [];
      for (let j = 1; j < line.length; j++) {
        const d = Math.hypot(line[j].x - line[j - 1].x, line[j].y - line[j - 1].y);
        if (d > 0) steps.push(d);
      }
      if (!steps.length || Math.max(...steps) >= 0.9 * span) {
        jumps++;
        continue;
      }
      if (steps.length >= 6) {
        traced++;
        const mean = steps.reduce((sum, d) => sum + d, 0) / steps.length;
        const spread = Math.sqrt(steps.reduce((sum, d) => sum + (d - mean) ** 2, 0) / steps.length) / mean;
        const ux = (b.x - a.x) / span;
        const uy = (b.y - a.y) / span;
        const off = Math.max(...line.map(p => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux)));
        if (spread < 0.1 && off <= 1) lines++;
      }
    }

    if (moves >= 5 && jumps >= 0.7 * moves) return false;
    if (traced >= 4 && lines >= 0.7 * traced) return false;
    if (presses >= 8 && instant >= 0.9 * presses) return false;
    if (aimed >= 8 && centred >= 0.8 * aimed) return false;
    return true;
  }

  function assess() {
    return review(clears, points, pitch, exact);
  }

  root.runInput = { start, stop, clear, assess, review };
  if (typeof document !== "undefined") document.addEventListener("pointermove", onMove, { capture: true, passive: true });
})(typeof window !== "undefined" ? window : globalThis);
