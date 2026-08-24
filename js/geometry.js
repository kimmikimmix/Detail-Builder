/* Geometry helpers. All values are in world units (metres) unless noted. */
window.FB = window.FB || {};

(function (FB) {
  'use strict';

  const G = {};

  G.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  G.snap = (v, step) => (step > 0 ? Math.round(v / step) * step : v);

  G.round = (v, places) => {
    const p = Math.pow(10, places === undefined ? 2 : places);
    return Math.round(v * p) / p;
  };

  G.dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

  G.deg = (rad) => (rad * 180) / Math.PI;
  G.rad = (deg) => (deg * Math.PI) / 180;

  /* Rotate (x,y) around (cx,cy) by `a` radians. */
  G.rotate = (x, y, cx, cy, a) => {
    if (!a) return { x, y };
    const s = Math.sin(a), c = Math.cos(a), dx = x - cx, dy = y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  };

  G.rectCenter = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

  /* The four corners of a possibly rotated rect, clockwise from top-left. */
  G.rectCorners = (r) => {
    const c = G.rectCenter(r), a = G.rad(r.rot || 0);
    return [
      G.rotate(r.x, r.y, c.x, c.y, a),
      G.rotate(r.x + r.w, r.y, c.x, c.y, a),
      G.rotate(r.x + r.w, r.y + r.h, c.x, c.y, a),
      G.rotate(r.x, r.y + r.h, c.x, c.y, a),
    ];
  };

  /* Axis-aligned bounding box of a possibly rotated rect. */
  G.rectAABB = (r) => {
    if (!r.rot) return { x: r.x, y: r.y, w: r.w, h: r.h };
    const pts = G.rectCorners(r);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  };

  /* World point -> the rect's own unrotated frame, origin at its centre. */
  G.toLocal = (p, r) => {
    const c = G.rectCenter(r);
    const q = G.rotate(p.x, p.y, c.x, c.y, -G.rad(r.rot || 0));
    return { x: q.x - c.x, y: q.y - c.y };
  };

  G.fromLocal = (p, r) => {
    const c = G.rectCenter(r);
    return G.rotate(c.x + p.x, c.y + p.y, c.x, c.y, G.rad(r.rot || 0));
  };

  G.pointInRect = (p, r, pad) => {
    pad = pad || 0;
    const l = G.toLocal(p, r);
    return Math.abs(l.x) <= r.w / 2 + pad && Math.abs(l.y) <= r.h / 2 + pad;
  };

  G.aabbOverlap = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  G.aabbContains = (outer, inner) =>
    inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h;

  G.normRect = (ax, ay, bx, by) => ({
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  });

  G.unionAABB = (list) => {
    if (!list.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of list) {
      if (!b) continue;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    if (x0 === Infinity) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  G.padAABB = (b, pad) => ({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 });

  /* Shortest distance from point p to segment a-b. */
  G.distToSegment = (p, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) return G.dist(p.x, p.y, a.x, a.y);
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = G.clamp(t, 0, 1);
    return G.dist(p.x, p.y, a.x + t * vx, a.y + t * vy);
  };

  G.distToPolyline = (p, pts) => {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      best = Math.min(best, G.distToSegment(p, pts[i], pts[i + 1]));
    }
    return pts.length === 1 ? G.dist(p.x, p.y, pts[0].x, pts[0].y) : best;
  };

  G.polylineLength = (pts) => {
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      total += G.dist(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }
    return total;
  };

  /* Point at a given fraction along a polyline, plus the local direction. */
  G.pointAlong = (pts, frac) => {
    const total = G.polylineLength(pts);
    if (total === 0) return { x: pts[0].x, y: pts[0].y, angle: 0 };
    let want = total * frac;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const seg = G.dist(a.x, a.y, b.x, b.y);
      if (seg >= want || i === pts.length - 2) {
        const t = seg === 0 ? 0 : want / seg;
        return {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          angle: Math.atan2(b.y - a.y, b.x - a.x),
        };
      }
      want -= seg;
    }
    return { x: pts[0].x, y: pts[0].y, angle: 0 };
  };

  /* Where a ray from the centre of `rect` toward `target` leaves the rect.
     Returns the world point plus which side it exits ('l','r','t','b'). */
  G.boundaryPoint = (rect, target, inset) => {
    const c = G.rectCenter(rect);
    const local = G.toLocal(target, rect);
    const hw = Math.max(rect.w / 2 + (inset || 0), 0.01);
    const hh = Math.max(rect.h / 2 + (inset || 0), 0.01);
    let dx = local.x, dy = local.y;
    if (dx === 0 && dy === 0) dy = -1;
    const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
    const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
    const t = Math.min(tx, ty);
    const lp = { x: dx * t, y: dy * t };
    let side;
    if (tx <= ty) side = dx > 0 ? 'r' : 'l';
    else side = dy > 0 ? 'b' : 't';
    const world = G.fromLocal(lp, rect);
    /* Rotate the side label so it reflects the on-screen direction. */
    const rot = ((rect.rot || 0) % 360 + 360) % 360;
    const quarters = Math.round(rot / 90) % 4;
    if (quarters) {
      const order = ['t', 'r', 'b', 'l'];
      side = order[(order.indexOf(side) + quarters) % 4];
    }
    return { x: world.x, y: world.y, side, cx: c.x, cy: c.y };
  };

  /* Constrain a vector to the nearest 45 degree step (Shift-drawing). */
  G.constrain45 = (from, to) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: to.x, y: to.y };
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
  };

  FB.geom = G;
})(window.FB);
