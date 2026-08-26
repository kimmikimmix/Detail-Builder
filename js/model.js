/* Document model: item factories, geometry per item type, (de)serialisation. */
(function (FB) {
  'use strict';

  const G = FB.geom;
  const M = {};

  M.VERSION = 1;

  /* Machines have no built-in catalogue — every type is one the user defines
     and lives in the document, so a layout file carries its own palette. */
  M.DEFAULT_TYPE_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ef4444', '#0ea5e9',
    '#84cc16', '#ec4899', '#14b8a6', '#6366f1', '#f97316', '#64748b',
  ];
  M.UNTYPED_COLOR = '#64748b';

  M.ZONE_COLORS = ['#4f9cf9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#64748b'];

  let seq = 0;
  M.uid = () => 'i' + (Date.now().toString(36).slice(-5)) + (seq++).toString(36) + Math.floor(Math.random() * 1296).toString(36);

  M.newDoc = () => ({
    version: M.VERSION,
    name: 'Untitled Factory',
    grid: 1,
    unit: 'm',
    types: [],
    items: [],
    process: [],
    animation: { stops: [], speed: 6, loop: true, driver: null },
  });

  /* One stop on the animated run: either an item to visit or a loose point on
     a hand-drawn path, plus how long work takes there, in seconds. */
  M.stop = (itemId, dwell) => ({ item: itemId, dwell: dwell === undefined ? 1 : Math.max(0, dwell) });
  M.stopAt = (x, y, dwell) => ({ x: x, y: y, dwell: dwell === undefined ? 0 : Math.max(0, dwell) });

  M.anim = (doc) => {
    if (!doc.animation || typeof doc.animation !== 'object') {
      doc.animation = { stops: [], speed: 6, loop: true, driver: null };
    }
    if (!Array.isArray(doc.animation.stops)) doc.animation.stops = [];
    return doc.animation;
  };

  /* ---------- machine types ---------- */

  M.type = (name, w, h, color, vehicle) => ({
    id: M.uid(),
    name: name || 'New machine',
    w: Math.max(0.2, Number(w) || 2),
    h: Math.max(0.2, Number(h) || 2),
    color: color || M.DEFAULT_TYPE_COLORS[0],
    vehicle: !!vehicle,      /* EVs, AGVs, forklifts — things that drive */
  });

  M.types = (doc) => {
    if (!Array.isArray(doc.types)) doc.types = [];
    return doc.types;
  };

  M.typeById = (doc, id) => (id ? M.types(doc).find((t) => t.id === id) || null : null);

  /* A colour that is not already in heavy use, for the next new type. */
  M.nextTypeColor = (doc) => {
    const used = new Set(M.types(doc).map((t) => t.color));
    return M.DEFAULT_TYPE_COLORS.find((c) => !used.has(c)) ||
      M.DEFAULT_TYPE_COLORS[M.types(doc).length % M.DEFAULT_TYPE_COLORS.length];
  };

  M.machinesOfType = (doc, id) => doc.items.filter((it) => it.type === 'machine' && it.kind === id);

  /* A written process step, optionally tied to an item on the floor. */
  M.step = (title, details, link) => ({
    id: M.uid(),
    title: title || '',
    details: details || '',
    link: link || null,
  });

  /* Step numbers (1-based) that point at a given item. */
  M.stepsFor = (doc, id) => {
    const out = [];
    (doc.process || []).forEach((st, i) => { if (st.link === id) out.push(i + 1); });
    return out;
  };

  /* ---------- factories ---------- */

  /* `type` is a type object from doc.types, or null for a plain box. */
  M.machine = (type, x, y, w, h) => ({
    id: M.uid(),
    type: 'machine',
    kind: type ? type.id : null,
    x, y,
    w: w || (type ? type.w : 2),
    h: h || (type ? type.h : 2),
    rot: 0,
    label: type ? type.name : 'Machine',
    color: type ? type.color : M.UNTYPED_COLOR,
    clearance: 0,
    notes: '',
    params: [],          /* [{ k: 'Wash pressure', v: '120 bar' }] */
    vehicle: !!(type && type.vehicle),
    locked: false,
    hidden: false,
  });

  M.param = (k, v) => ({ k: k || '', v: v || '' });

  M.wall = (points, thickness) => ({
    id: M.uid(),
    type: 'wall',
    points: points.map((p) => ({ x: p.x, y: p.y })),
    thickness: thickness || 0.25,
    closed: false,
    color: '#3f4756',
    locked: false,
    hidden: false,
  });

  M.zone = (x, y, w, h, label) => ({
    id: M.uid(),
    type: 'zone',
    x, y, w, h,
    rot: 0,
    label: label || 'Zone',
    color: '#4f9cf9',
    hatch: false,
    process: '',         /* what happens here, and when */
    duration: 0,         /* minutes of process time */
    locked: false,
    hidden: false,
  });

  M.label = (x, y, text) => ({
    id: M.uid(),
    type: 'label',
    x, y,
    text: text || 'Label',
    size: 0.8,
    color: '#1f2937',
    rot: 0,
    locked: false,
    hidden: false,
  });

  M.route = (from, to, waypoints) => ({
    id: M.uid(),
    type: 'route',
    from, to,
    waypoints: (waypoints || []).map((p) => ({ x: p.x, y: p.y })),
    mode: 'ortho',           /* 'ortho' | 'direct' */
    color: '#f97316',
    width: 0.16,
    dashed: false,
    arrows: 'end',           /* 'end' | 'both' | 'none' */
    label: '',
    locked: false,
    hidden: false,
  });

  /* An endpoint is either { item: id } (docked to a machine/zone) or { x, y }. */
  M.endpointAt = (x, y) => ({ x, y });
  M.endpointOn = (id) => ({ item: id });

  /* ---------- lookups ---------- */

  M.byId = (doc, id) => doc.items.find((it) => it.id === id) || null;

  M.isRect = (it) => it.type === 'machine' || it.type === 'zone';

  M.indexOf = (doc, id) => doc.items.findIndex((it) => it.id === id);

  /* ---------- bounds ---------- */

  M.bounds = (doc, it) => {
    switch (it.type) {
      case 'machine':
      case 'zone':
        return G.rectAABB(it);
      case 'wall': {
        const xs = it.points.map((p) => p.x), ys = it.points.map((p) => p.y);
        const t = it.thickness / 2;
        return {
          x: Math.min(...xs) - t,
          y: Math.min(...ys) - t,
          w: Math.max(...xs) - Math.min(...xs) + t * 2,
          h: Math.max(...ys) - Math.min(...ys) + t * 2,
        };
      }
      case 'label': {
        const w = Math.max(1, it.text.length * it.size * 0.55);
        return { x: it.x - w / 2, y: it.y - it.size * 0.7, w, h: it.size * 1.4 };
      }
      case 'route': {
        const pts = M.routePath(doc, it);
        if (!pts.length) return null;
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        return {
          x: Math.min(...xs), y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
        };
      }
      default:
        return null;
    }
  };

  M.docBounds = (doc) => G.unionAABB(doc.items.map((it) => M.bounds(doc, it)));

  /* ---------- routes ---------- */

  /* Resolve an endpoint to a world point, aiming at `toward`. */
  const resolveEnd = (doc, end, toward) => {
    if (end && end.item) {
      const host = M.byId(doc, end.item);
      if (host && M.isRect(host)) {
        return G.boundaryPoint(host, toward, 0.05);
      }
      if (host && host.type === 'label') return { x: host.x, y: host.y, side: 't' };
      return null;
    }
    return { x: end.x, y: end.y, side: null };
  };

  const anchorHint = (doc, end) => {
    if (end && end.item) {
      const host = M.byId(doc, end.item);
      if (host && M.isRect(host)) return G.rectCenter(host);
    }
    return end ? { x: end.x, y: end.y } : null;
  };

  /* Insert an elbow between p and q so the run stays orthogonal.
     `preferAxis` is 'x' or 'y' — the direction to travel first. */
  const elbow = (p, q, preferAxis) => {
    if (Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6) return [];
    return preferAxis === 'x' ? [{ x: q.x, y: p.y }] : [{ x: p.x, y: q.y }];
  };

  /* Full polyline for a route, in world coordinates. */
  M.routePath = (doc, route) => {
    const wps = route.waypoints || [];
    const firstTarget = wps[0] || anchorHint(doc, route.to);
    const lastTarget = wps[wps.length - 1] || anchorHint(doc, route.from);
    if (!firstTarget || !lastTarget) return [];

    const a = resolveEnd(doc, route.from, firstTarget);
    const b = resolveEnd(doc, route.to, lastTarget);
    if (!a || !b) return [];

    const nodes = [a, ...wps, b];
    if (route.mode === 'direct') return nodes.map((p) => ({ x: p.x, y: p.y }));

    const out = [{ x: nodes[0].x, y: nodes[0].y }];
    for (let i = 0; i < nodes.length - 1; i++) {
      const p = out[out.length - 1];
      const q = nodes[i + 1];
      let axis;
      if (i === 0 && a.side) axis = a.side === 'l' || a.side === 'r' ? 'x' : 'y';
      else if (i === nodes.length - 2 && b.side) axis = b.side === 'l' || b.side === 'r' ? 'y' : 'x';
      else axis = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y) ? 'x' : 'y';
      for (const e of elbow(p, q, axis)) out.push(e);
      out.push({ x: q.x, y: q.y });
    }
    /* Drop consecutive duplicates. */
    return out.filter((p, i) => i === 0 || Math.abs(p.x - out[i - 1].x) > 1e-6 || Math.abs(p.y - out[i - 1].y) > 1e-6);
  };

  M.routeLength = (doc, route) => G.polylineLength(M.routePath(doc, route));

  /* Routes referencing an item, used when deleting. */
  M.routesFor = (doc, id) =>
    doc.items.filter((it) => it.type === 'route' &&
      ((it.from && it.from.item === id) || (it.to && it.to.item === id)));

  /* ---------- hit testing ---------- */

  /* tol is in world units and should scale with zoom. */
  M.pickable = (it) => !it.locked && !it.hidden;

  M.hitTest = (doc, p, tol) => {
    for (let i = doc.items.length - 1; i >= 0; i--) {
      const it = doc.items[i];
      if (!M.pickable(it)) continue;
      if (M.hits(doc, it, p, tol)) return it;
    }
    return null;
  };

  M.hits = (doc, it, p, tol) => {
    switch (it.type) {
      case 'machine':
        return G.pointInRect(p, it, 0);
      case 'zone': {
        if (!G.pointInRect(p, it, tol)) return false;
        /* Zones are hollow: only the border and the title bar catch clicks,
           so machines dropped inside stay clickable. */
        const l = G.toLocal(p, it);
        const onBorder = Math.abs(Math.abs(l.x) - it.w / 2) <= tol * 2 ||
                         Math.abs(Math.abs(l.y) - it.h / 2) <= tol * 2;
        const onTitle = l.y < -it.h / 2 + 1 && Math.abs(l.x) < it.w / 2;
        return onBorder || onTitle;
      }
      case 'wall':
        return G.distToPolyline(p, it.points) <= it.thickness / 2 + tol;
      case 'label': {
        const b = M.bounds(doc, it);
        return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
      }
      case 'route': {
        const pts = M.routePath(doc, it);
        return pts.length > 1 && G.distToPolyline(p, pts) <= it.width / 2 + tol * 1.5;
      }
      default:
        return false;
    }
  };

  /* Topmost machine or zone under a point — used when docking routes. */
  M.hostAt = (doc, p, tol) => {
    const pad = tol || 0;
    for (let i = doc.items.length - 1; i >= 0; i--) {
      const it = doc.items[i];
      if (it.type === 'machine' && !it.hidden && G.pointInRect(p, it, pad)) return it;
    }
    return null;
  };

  /* ---------- transforms ---------- */

  M.move = (it, dx, dy) => {
    if (it.type === 'wall') {
      it.points.forEach((p) => { p.x += dx; p.y += dy; });
    } else if (it.type === 'route') {
      (it.waypoints || []).forEach((p) => { p.x += dx; p.y += dy; });
      if (!it.from.item) { it.from.x += dx; it.from.y += dy; }
      if (!it.to.item) { it.to.x += dx; it.to.y += dy; }
    } else {
      it.x += dx; it.y += dy;
    }
  };

  M.clone = (it) => JSON.parse(JSON.stringify(it));

  /* Deep-copy a set of items, keeping internal route links intact. */
  M.copyGroup = (doc, ids) => {
    const idSet = new Set(ids);
    const map = new Map();
    const copies = [];
    for (const it of doc.items) {
      if (!idSet.has(it.id)) continue;
      const c = M.clone(it);
      c.id = M.uid();
      map.set(it.id, c.id);
      copies.push(c);
    }
    for (const c of copies) {
      if (c.type !== 'route') continue;
      if (c.from.item) {
        if (map.has(c.from.item)) c.from = { item: map.get(c.from.item) };
        else c.from = null;
      }
      if (c.to && c.to.item) {
        if (map.has(c.to.item)) c.to = { item: map.get(c.to.item) };
        else c.to = null;
      }
    }
    /* Drop routes whose endpoints did not come along. */
    return copies.filter((c) => c.type !== 'route' || (c.from && c.to));
  };

  /* ---------- serialisation ---------- */

  M.serialize = (doc) => JSON.stringify(doc, null, 2);

  M.deserialize = (text) => {
    const raw = typeof text === 'string' ? JSON.parse(text) : text;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
      throw new Error('Not a factory layout file');
    }
    const doc = M.newDoc();
    doc.name = typeof raw.name === 'string' ? raw.name : doc.name;
    doc.grid = Number(raw.grid) > 0 ? Number(raw.grid) : 1;

    if (Array.isArray(raw.types)) {
      for (const t of raw.types) {
        if (!t || typeof t !== 'object') continue;
        const type = M.type(str(t.name, 'Machine'), num(t.w, 2), num(t.h, 2), str(t.color, M.DEFAULT_TYPE_COLORS[0]), t.vehicle);
        if (typeof t.id === 'string' && t.id) type.id = t.id;
        doc.types.push(type);
      }
    }

    const seen = new Set();
    for (const it of raw.items) {
      const clean = M.sanitize(it, seen);
      if (clean) { doc.items.push(clean); seen.add(clean.id); }
    }
    /* Drop routes pointing at items that did not survive. */
    doc.items = doc.items.filter((it) => {
      if (it.type !== 'route') return true;
      const okEnd = (e) => e && (!e.item || seen.has(e.item));
      return okEnd(it.from) && okEnd(it.to);
    });

    if (!doc.types.length) deriveTypes(doc);

    const anim = M.anim(doc);
    if (raw.animation && typeof raw.animation === 'object') {
      anim.speed = Math.max(0.5, num(raw.animation.speed, 6));
      anim.loop = raw.animation.loop !== false;
      if (typeof raw.animation.driver === 'string' && seen.has(raw.animation.driver)) {
        anim.driver = raw.animation.driver;
      }
      if (Array.isArray(raw.animation.stops)) {
        for (const st of raw.animation.stops) {
          if (!st || typeof st !== 'object') continue;
          if (typeof st.item === 'string') {
            if (seen.has(st.item)) anim.stops.push(M.stop(st.item, num(st.dwell, 1)));
          } else if (Number.isFinite(Number(st.x)) && Number.isFinite(Number(st.y))) {
            anim.stops.push(M.stopAt(Number(st.x), Number(st.y), num(st.dwell, 0)));
          }
        }
      }
    }

    if (Array.isArray(raw.process)) {
      for (const st of raw.process) {
        if (!st || typeof st !== 'object') continue;
        const step = M.step(
          typeof st.title === 'string' ? st.title : '',
          typeof st.details === 'string' ? st.details : '',
          typeof st.link === 'string' && seen.has(st.link) ? st.link : null
        );
        if (typeof st.id === 'string' && st.id) step.id = st.id;
        doc.process.push(step);
      }
    }
    return doc;
  };

  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const str = (v, fallback) => (typeof v === 'string' ? v : fallback);

  /* Flags every item shares. Missing ones default to false, so files written
     before locking existed load unchanged. */
  const flags = (out, raw) => {
    out.locked = !!raw.locked;
    out.hidden = !!raw.hidden;
    return out;
  };

  M.sanitize = (it, seen) => {
    if (!it || typeof it !== 'object') return null;
    let id = str(it.id, '');
    if (!id || (seen && seen.has(id))) id = M.uid();
    switch (it.type) {
      case 'machine': {
        const base = M.machine(null, num(it.x, 0), num(it.y, 0),
          Math.max(0.2, num(it.w, 2)), Math.max(0.2, num(it.h, 2)));
        base.id = id;
        base.kind = typeof it.kind === 'string' && it.kind ? it.kind : null;
        base.rot = num(it.rot, 0);
        base.label = str(it.label, base.label);
        base.color = str(it.color, base.color);
        base.clearance = Math.max(0, num(it.clearance, 0));
        base.notes = str(it.notes, '');
        base.vehicle = !!it.vehicle;
        base.params = Array.isArray(it.params)
          ? it.params.filter((p) => p && typeof p === 'object')
              .map((p) => M.param(str(p.k, ''), str(p.v, '')))
              .filter((p) => p.k || p.v)
          : [];
        return flags(base, it);
      }
      case 'zone': {
        const z = M.zone(num(it.x, 0), num(it.y, 0), Math.max(0.5, num(it.w, 4)), Math.max(0.5, num(it.h, 4)), str(it.label, 'Zone'));
        z.id = id;
        z.rot = num(it.rot, 0);
        z.color = str(it.color, z.color);
        z.hatch = !!it.hatch;
        z.process = str(it.process, '');
        z.duration = Math.max(0, num(it.duration, 0));
        return flags(z, it);
      }
      case 'wall': {
        if (!Array.isArray(it.points) || it.points.length < 2) return null;
        const pts = it.points
          .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
          .map((p) => ({ x: Number(p.x), y: Number(p.y) }));
        if (pts.length < 2) return null;
        const w = M.wall(pts, Math.max(0.05, num(it.thickness, 0.25)));
        w.id = id;
        w.closed = !!it.closed;
        w.color = str(it.color, w.color);
        return flags(w, it);
      }
      case 'label': {
        const l = M.label(num(it.x, 0), num(it.y, 0), str(it.text, 'Label'));
        l.id = id;
        l.size = Math.max(0.2, num(it.size, 0.8));
        l.color = str(it.color, l.color);
        l.rot = num(it.rot, 0);
        return flags(l, it);
      }
      case 'route': {
        const end = (e) => {
          if (!e || typeof e !== 'object') return null;
          if (typeof e.item === 'string') return { item: e.item };
          if (Number.isFinite(Number(e.x)) && Number.isFinite(Number(e.y))) return { x: Number(e.x), y: Number(e.y) };
          return null;
        };
        const from = end(it.from), to = end(it.to);
        if (!from || !to) return null;
        const r = M.route(from, to, Array.isArray(it.waypoints) ? it.waypoints.filter((p) => p && Number.isFinite(Number(p.x))).map((p) => ({ x: Number(p.x), y: Number(p.y) })) : []);
        r.id = id;
        r.mode = it.mode === 'direct' ? 'direct' : 'ortho';
        r.color = str(it.color, r.color);
        r.width = Math.max(0.02, num(it.width, 0.16));
        r.dashed = !!it.dashed;
        r.arrows = ['end', 'both', 'none'].includes(it.arrows) ? it.arrows : 'end';
        r.label = str(it.label, '');
        return flags(r, it);
      }
      default:
        return null;
    }
  };

  /* Files written before machine types existed only carry a `kind` string per
     machine. Rebuild a palette from what those machines actually look like so
     nothing is lost on load. */
  function deriveTypes(doc) {
    const groups = new Map();
    for (const it of doc.items) {
      if (it.type !== 'machine' || !it.kind) continue;
      if (!groups.has(it.kind)) groups.set(it.kind, []);
      groups.get(it.kind).push(it);
    }
    for (const [kind, machines] of groups) {
      const first = machines[0];
      /* Prefer a label shared by the group, minus any trailing number. */
      const bases = machines.map((m) => (m.label || '').replace(/\s+\d+$/, '').trim()).filter(Boolean);
      const tally = {};
      let name = '', best = 0;
      for (const b of bases) {
        tally[b] = (tally[b] || 0) + 1;
        if (tally[b] > best) { best = tally[b]; name = b; }
      }
      const type = M.type(name || kind, first.w, first.h, first.color);
      type.id = kind;
      doc.types.push(type);
    }
  }

  /* ---------- animated run ---------- */

  /* The full journey as a list of legs. Each leg is the polyline from one stop
     to the next: the route between them when there is one, else a straight
     line, so an unrouted pair still animates. */
  M.stopPos = (doc, st) => {
    if (st.item) {
      const item = M.byId(doc, st.item);
      if (!item) return null;
      return M.isRect(item) ? G.rectCenter(item) : { x: item.x, y: item.y };
    }
    return { x: st.x, y: st.y };
  };

  M.animPath = (doc) => {
    const anim = M.anim(doc);
    const legs = [];
    const stops = [];
    for (const st of anim.stops) {
      const pos = M.stopPos(doc, st);
      if (!pos) continue;                       /* the item it pointed at is gone */
      stops.push({ st, item: st.item ? M.byId(doc, st.item) : null, pos: pos });
    }

    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      /* Two machines with a route between them travel along it; anything else,
         including hand-drawn points, goes straight. */
      const route = a.item && b.item && doc.items.find((it) => it.type === 'route' && !it.hidden &&
        ((it.from.item === a.item.id && it.to.item === b.item.id) ||
         (it.from.item === b.item.id && it.to.item === a.item.id)));

      let pts;
      if (route) {
        pts = M.routePath(doc, route);
        /* Walk the route the way this leg travels. */
        if (route.from.item === b.item.id) pts = pts.slice().reverse();
      } else {
        pts = [a.pos, b.pos];
      }
      if (pts.length > 1) legs.push({ pts, length: G.polylineLength(pts), viaRoute: !!route });
    }
    return { stops, legs };
  };

  /* Total run time in seconds: dwell at each stop plus travel between them. */
  M.animDuration = (doc, path) => {
    const anim = M.anim(doc);
    const speed = Math.max(0.5, anim.speed);
    let total = 0;
    for (const s of path.stops) total += s.st.dwell;
    for (const leg of path.legs) total += leg.length / speed;
    return total;
  };

  /* Where the token is at time t, and what it is doing. */
  M.animAt = (doc, path, t) => {
    const anim = M.anim(doc);
    const speed = Math.max(0.5, anim.speed);
    if (!path.stops.length) return null;

    let cursor = 0;
    for (let i = 0; i < path.stops.length; i++) {
      const stop = path.stops[i];
      const dwell = stop.st.dwell;

      if (t <= cursor + dwell) {
        /* Face the way the next leg leaves, so a vehicle sits parked correctly. */
        const leg = path.legs[i] || path.legs[i - 1];
        let angle = 0;
        if (leg) {
          const a = leg.pts[0], b = leg.pts[1];
          angle = Math.atan2(b.y - a.y, b.x - a.x);
        }
        return {
          x: stop.pos.x, y: stop.pos.y, angle: angle,
          stop: stop.item, index: i, working: dwell > 0,
          progress: dwell > 0 ? (t - cursor) / dwell : 1,
        };
      }
      cursor += dwell;

      const leg = path.legs[i];
      if (!leg) break;
      const travel = leg.length / speed;
      if (t <= cursor + travel) {
        const frac = travel > 0 ? (t - cursor) / travel : 1;
        const p = G.pointAlong(leg.pts, G.clamp(frac, 0, 1));
        return { x: p.x, y: p.y, angle: p.angle, stop: null, from: stop.item, to: path.stops[i + 1].item, index: i, working: false, progress: frac };
      }
      cursor += travel;
    }

    const last = path.stops[path.stops.length - 1];
    return { x: last.pos.x, y: last.pos.y, angle: 0, stop: last.item, index: path.stops.length - 1, working: false, progress: 1 };
  };

  M.vehicles = (doc) => doc.items.filter((it) => it.type === 'machine' && it.vehicle);

  /* Follow the routes out of a machine to propose a run order. */
  M.buildRunFromRoutes = (doc) => {
    const machines = doc.items.filter((it) => it.type === 'machine' && !it.hidden);
    if (!machines.length) return [];
    const routes = doc.items.filter((it) => it.type === 'route' && !it.hidden && it.from.item && it.to.item);

    const outgoing = new Map();
    const incoming = new Set();
    for (const r of routes) {
      if (!outgoing.has(r.from.item)) outgoing.set(r.from.item, []);
      outgoing.get(r.from.item).push(r.to.item);
      incoming.add(r.to.item);
    }

    /* Start where material enters: something with routes out and none in. */
    let startId = machines.find((m) => outgoing.has(m.id) && !incoming.has(m.id));
    if (!startId) startId = machines.find((m) => outgoing.has(m.id));
    if (!startId) return [];

    const order = [];
    const seenIds = new Set();
    let current = startId.id;
    while (current && !seenIds.has(current)) {
      seenIds.add(current);
      order.push(current);
      const next = (outgoing.get(current) || []).find((id) => !seenIds.has(id));
      current = next;
    }
    return order;
  };

  /* ---------- stats ---------- */

  M.stats = (doc) => {
    const s = {
      machines: 0, routes: 0, walls: 0, zones: 0, labels: 0,
      machineArea: 0, zoneArea: 0, wallLength: 0, routeLength: 0,
      byKind: {},
    };
    for (const it of doc.items) {
      switch (it.type) {
        case 'machine': {
          s.machines++;
          s.machineArea += it.w * it.h;
          const key = it.kind || '';
          s.byKind[key] = (s.byKind[key] || 0) + 1;
          break;
        }
        case 'zone':
          s.zones++;
          s.zoneArea += it.w * it.h;
          break;
        case 'wall':
          s.walls++;
          s.wallLength += G.polylineLength(it.closed ? it.points.concat([it.points[0]]) : it.points);
          break;
        case 'route':
          s.routes++;
          s.routeLength += M.routeLength(doc, it);
          break;
        case 'label':
          s.labels++;
          break;
      }
    }
    const b = M.docBounds(doc);
    s.footprint = b ? b.w * b.h : 0;
    s.extent = b;
    s.utilisation = s.footprint > 0 ? s.machineArea / s.footprint : 0;
    return s;
  };

  FB.model = M;
})(window.FB);
