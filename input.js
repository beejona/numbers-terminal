(function (root) {
  const MAX_POINTS = 8000;
  const MAX_MISSES = 20;
  const VIAS = ["down", "hover", "drop"];
  const exact = typeof PointerEvent !== "undefined" && "getCoalescedEvents" in PointerEvent.prototype;

  let points = [];
  let clears = [];
  let pitch = 0;
  let origin = 0;
  let last = null;
  let active = false;

  function start(panePitch, startedAt) {
    points = [];
    clears = [];
    pitch = panePitch;
    origin = startedAt;
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

  function clear(via, event, rect, index) {
    if (!active || !rect) return;
    if (clears.length && clears[clears.length - 1].i === index) return;
    const placed = event && typeof event.clientX === "number";
    clears.push({
      i: index,
      t: event ? event.timeStamp : performance.now(),
      x: placed ? event.clientX : last ? last.x : 0,
      y: placed ? event.clientY : last ? last.y : 0,
      via,
      trusted: event ? event.isTrusted : true,
      pointer: event && event.pointerType ? event.pointerType : "mouse",
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    });
  }

  const r1 = value => Math.round(value * 10) / 10;

  function record(layout, ping, misses) {
    const flat = [];
    for (const p of points) flat.push(r1(Math.max(0, p.t - origin)), r1(p.x), r1(p.y));
    return {
      layout: [...layout],
      pitch: r1(pitch),
      exact,
      ping,
      misses,
      clears: clears.map(c => [
        r1(Math.max(0, c.t - origin)), c.i, r1(c.x), r1(c.y), Math.max(0, VIAS.indexOf(c.via)),
        c.pointer === "mouse" ? 0 : 1, c.trusted ? 1 : 0,
        r1(c.rect.left), r1(c.rect.top), r1(c.rect.width), r1(c.rect.height)
      ]),
      path: flat
    };
  }

  const finite = value => typeof value === "number" && Number.isFinite(value);

  function check(rec, claim) {
    try {
      return checked(rec, claim);
    } catch {
      return false;
    }
  }

  function checked(rec, { count, mode, time_ms, ping }) {
    if (!rec || typeof rec !== "object") return false;
    const { layout, clears: rows, path } = rec;
    if (!Array.isArray(layout) || layout.length !== count) return false;
    if (new Set(layout).size !== count || !layout.every(n => Number.isInteger(n) && n >= 1 && n <= count)) return false;
    if (!Number.isInteger(rec.misses) || rec.misses < 0 || rec.misses > MAX_MISSES) return false;
    if (rec.ping !== ping || !finite(rec.pitch)) return false;
    if (!Array.isArray(rows) || rows.length !== count) return false;
    if (!Array.isArray(path) || path.length % 3 !== 0 || path.length > MAX_POINTS * 3 || !path.every(finite)) return false;

    const list = [];
    let before = -Infinity;
    for (let k = 0; k < count; k++) {
      const row = rows[k];
      if (!Array.isArray(row) || row.length !== 11 || !row.every(finite)) return false;
      const [t, i, x, y, via, pointer, trusted, left, top, width, height] = row;
      if (t < before - 50 || !Number.isInteger(i) || i < 0 || i >= count || layout[i] !== k + 1) return false;
      if (!(width >= 8 && width <= 400 && height >= 8 && height <= 400)) return false;
      if (x < left - 2 || x > left + width + 2 || y < top - 2 || y > top + height + 2) return false;
      before = Math.max(before, t);
      list.push({
        t, x, y, via: VIAS[via] || "down", trusted: trusted === 1, pointer: pointer === 0 ? "mouse" : "other",
        rect: { left, top, right: left + width, bottom: top + height }
      });
    }
    const width = list[0].rect.right - list[0].rect.left;
    if (!(rec.pitch >= width * 0.9 && rec.pitch <= width * 3 + 60)) return false;

    const played = list.some(c => c.via === "hover") ? "hover" : list.some(c => c.via === "drop") ? "drop" : "click";
    if (played !== mode) return false;
    const end = list[count - 1].t + ping;
    if (time_ms < end - 2 || time_ms > end + 3000) return false;

    const moves = [];
    for (let j = 0; j < path.length; j += 3) moves.push({ t: path[j], x: path[j + 1], y: path[j + 2] });
    moves.sort((a, b) => a.t - b.t);
    return review(list, moves, rec.pitch, rec.exact === true);
  }

  function within(point, rect) {
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  }

  function review(clears, points, pitch, exact) {
    if (clears.some(c => !c.trusted)) return false;
    if (!(pitch > 0) || clears.some(c => c.pointer !== "mouse")) return true;

    let moves = 0, jumps = 0, traced = 0, lines = 0, aimed = 0, direct = 0, presses = 0, instant = 0, pressed = 0, centred = 0;
    let from = 0;
    for (let k = 0; k < clears.length; k++) {
      const b = clears[k];
      if (b.via === "down") {
        pressed++;
        const cx = (b.rect.left + b.rect.right) / 2;
        const cy = (b.rect.top + b.rect.bottom) / 2;
        if (Math.abs(b.x - cx) <= 1 && Math.abs(b.y - cy) <= 1) centred++;
      }
      if (k === 0) continue;

      const a = clears[k - 1];
      while (from < points.length && points[from].t <= a.t) from++;
      const path = [];
      for (let j = from; j < points.length && points[j].t <= b.t; j++) path.push(points[j]);

      if (b.via === "down" && exact) {
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
      const ux = (b.x - a.x) / span;
      const uy = (b.y - a.y) / span;
      if (steps.length >= 6) {
        traced++;
        const mean = steps.reduce((sum, d) => sum + d, 0) / steps.length;
        const spread = Math.sqrt(steps.reduce((sum, d) => sum + (d - mean) ** 2, 0) / steps.length) / mean;
        const off = Math.max(...line.map(p => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux)));
        if (spread < 0.1 && off <= 1) lines++;
      }
      if (path.length >= 8) {
        aimed++;
        let s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0, y1 = 0, y2 = 0, y3 = 0, total = 0, widest = 0;
        for (const p of path) {
          const u = ((p.x - a.x) * ux + (p.y - a.y) * uy) / span;
          const v = (p.y - a.y) * ux - (p.x - a.x) * uy;
          const u2 = u * u, u3 = u2 * u;
          s11 += u2; s12 += u3; s13 += u2 * u2; s22 += u2 * u2; s23 += u2 * u3; s33 += u3 * u3;
          y1 += u * v; y2 += u2 * v; y3 += u3 * v;
          total += v * v;
          widest = Math.max(widest, Math.abs(v));
        }
        const det = s11 * (s22 * s33 - s23 * s23) - s12 * (s12 * s33 - s23 * s13) + s13 * (s12 * s23 - s22 * s13);
        let explained = 0;
        if (Math.abs(det) > 1e-12) {
          const c1 = (y1 * (s22 * s33 - s23 * s23) - s12 * (y2 * s33 - s23 * y3) + s13 * (y2 * s23 - s22 * y3)) / det;
          const c2 = (s11 * (y2 * s33 - s23 * y3) - y1 * (s12 * s33 - s23 * s13) + s13 * (s12 * y3 - y2 * s13)) / det;
          const c3 = (s11 * (s22 * y3 - y2 * s23) - s12 * (s12 * y3 - y2 * s13) + y1 * (s12 * s23 - s22 * s13)) / det;
          explained = c1 * y1 + c2 * y2 + c3 * y3;
        }
        const left = Math.max(total - explained, 1e-9);
        const bent = (explained / 3) / (left / (path.length - 3));
        if (widest <= 0.5 || (bent < 4 && widest < 0.03 * span + 3)) direct++;
      }
    }

    if (moves >= 5 && jumps >= 0.7 * moves) return false;
    if (traced >= 4 && lines >= 0.7 * traced) return false;
    if (aimed >= 6 && direct >= 0.8 * aimed) return false;
    if (presses >= 8 && instant >= 0.9 * presses) return false;
    if (pressed >= 8 && centred >= 0.8 * pressed) return false;
    return true;
  }

  root.runInput = { start, stop, clear, record, check, review };
  if (typeof document !== "undefined") document.addEventListener("pointermove", onMove, { capture: true, passive: true });
})(typeof window !== "undefined" ? window : globalThis);
