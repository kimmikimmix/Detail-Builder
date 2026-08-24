/* Document model: item factories, geometry per item type, (de)serialisation. */
(function (FB) {
  'use strict';

  const G = FB.geom;
  const M = {};

  M.VERSION = 1;

  /* Machine catalogue. Sizes are in metres. */
  M.KINDS = {
    cnc:      { name: 'CNC Machine',      w: 3,   h: 2,   color: '#3b82f6', glyph: 'CNC' },
    lathe:    { name: 'Lathe',            w: 2.5, h: 1.5, color: '#0ea5e9', glyph: 'LTH' },
    press:    { name: 'Press',            w: 2,   h: 2,   color: '#6366f1', glyph: 'PRS' },
    molder:   { name: 'Injection Molder', w: 4,   h: 2,   color: '#8b5cf6', glyph: 'IMM' },
    robot:    { name: 'Robot Cell',       w: 3,   h: 3,   color: '#a855f7', glyph: 'RBT' },
    assembly: { name: 'Assembly Station', w: 3,   h: 1.5, color: '#10b981', glyph: 'ASM' },
    conveyor: { name: 'Conveyor',         w: 6,   h: 0.8, color: '#f59e0b', glyph: 'CNV' },
    oven:     { name: 'Oven / Furnace',   w: 4,   h: 2.5, color: '#ef4444', glyph: 'OVN' },
    paint:    { name: 'Paint Booth',      w: 5,   h: 4,   color: '#ec4899', glyph: 'PNT' },
    qc:       { name: 'QC / Inspection',  w: 2.5, h: 2,   color: '#14b8a6', glyph: 'QC'  },
    packing:  { name: 'Packing Station',  w: 3,   h: 2,   color: '#84cc16', glyph: 'PCK' },
    rack:     { name: 'Storage Rack',     w: 6,   h: 1.2, color: '#64748b', glyph: 'RCK' },
    buffer:   { name: 'WIP Buffer',       w: 2,   h: 2,   color: '#94a3b8', glyph: 'WIP' },
    dock:     { name: 'Loading Dock',     w: 4,   h: 3,   color: '#0f766e', glyph: 'DCK' },
    office:   { name: 'Office / Desk',    w: 2,   h: 1.5, color: '#78716c', glyph: 'OFF' },
    utility:  { name: 'Utility / Panel',  w: 1.5, h: 1,   color: '#475569', glyph: 'UTL' },
  };

  M.ZONE_COLORS = ['#4f9cf9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#64748b'];

  let seq = 0;
  M.uid = () => 'i' + (Date.now().toString(36).slice(-5)) + (seq++).toString(36) + Math.floor(Math.random() * 1296).toString(36);

  M.newDoc = () => ({
    version: M.VERSION,
    name: 'Untitled Factory',
    grid: 1,
    unit: 'm',
    items: [],
  });

  /* ---------- factories ---------- */

  M.machine = (kind, x, y, w, h) => {
    const k = M.KINDS[kind] || M.KINDS.cnc;
    return {
      id: M.uid(),
      type: 'machine',
      kind,
      x, y,
      w: w || k.w,
      h: h || k.h,
      rot: 0,
      label: k.name,
      color: k.color,
      clearance: 0,
      notes: '',
    };
  };

  M.wall = (points, thickness) => ({
    id: M.uid(),
    type: 'wall',
    points: points.map((p) => ({ x: p.x, y: p.y })),
    thickness: thickness || 0.25,
    closed: false,
    color: '#3f4756',
  });

  M.zone = (x, y, w, h, label) => ({
    id: M.uid(),
    type: 'zone',
    x, y, w, h,
    rot: 0,
    label: label || 'Zone',
    color: '#4f9cf9',
    hatch: false,
  });

  M.label = (x, y, text) => ({
    id: M.uid(),
    type: 'label',
    x, y,
    text: text || 'Label',
    size: 0.8,
    color: '#1f2937',
    rot: 0,
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
  M.hitTest = (doc, p, tol) => {
    for (let i = doc.items.length - 1; i >= 0; i--) {
      const it = doc.items[i];
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
      if (it.type === 'machine' && G.pointInRect(p, it, pad)) return it;
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
    return doc;
  };

  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const str = (v, fallback) => (typeof v === 'string' ? v : fallback);

  M.sanitize = (it, seen) => {
    if (!it || typeof it !== 'object') return null;
    let id = str(it.id, '');
    if (!id || (seen && seen.has(id))) id = M.uid();
    switch (it.type) {
      case 'machine': {
        const kind = M.KINDS[it.kind] ? it.kind : 'cnc';
        const base = M.machine(kind, num(it.x, 0), num(it.y, 0), Math.max(0.2, num(it.w, 0) || M.KINDS[kind].w), Math.max(0.2, num(it.h, 0) || M.KINDS[kind].h));
        base.id = id;
        base.rot = num(it.rot, 0);
        base.label = str(it.label, base.label);
        base.color = str(it.color, base.color);
        base.clearance = Math.max(0, num(it.clearance, 0));
        base.notes = str(it.notes, '');
        return base;
      }
      case 'zone': {
        const z = M.zone(num(it.x, 0), num(it.y, 0), Math.max(0.5, num(it.w, 4)), Math.max(0.5, num(it.h, 4)), str(it.label, 'Zone'));
        z.id = id;
        z.rot = num(it.rot, 0);
        z.color = str(it.color, z.color);
        z.hatch = !!it.hatch;
        return z;
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
        return w;
      }
      case 'label': {
        const l = M.label(num(it.x, 0), num(it.y, 0), str(it.text, 'Label'));
        l.id = id;
        l.size = Math.max(0.2, num(it.size, 0.8));
        l.color = str(it.color, l.color);
        l.rot = num(it.rot, 0);
        return l;
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
        return r;
      }
      default:
        return null;
    }
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
        case 'machine':
          s.machines++;
          s.machineArea += it.w * it.h;
          s.byKind[it.kind] = (s.byKind[it.kind] || 0) + 1;
          break;
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
