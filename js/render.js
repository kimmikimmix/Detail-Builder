/* Canvas renderer. Everything is drawn in world units and transformed by the
   camera at draw time, so hit testing can stay in world space. */
(function (FB) {
  'use strict';

  const G = FB.geom;
  const M = FB.model;

  const R = {
    canvas: null,
    ctx: null,
    dpr: 1,
    width: 0,
    height: 0,
  };

  const C = {
    paper:      '#eef1f5',
    gridMinor:  '#dde3ec',
    gridMajor:  '#c9d2e0',
    axis:       '#b3c0d4',
    accent:     '#2b7de0',
    accentSoft: 'rgba(43,125,224,.14)',
    wall:       '#3f4756',
    wallEdge:   '#2a303c',
    text:       '#1f2937',
    textDim:    '#64748b',
    handle:     '#ffffff',
    guide:      '#f43f5e',
  };

  R.attach = (canvas) => {
    R.canvas = canvas;
    R.ctx = canvas.getContext('2d');
    R.resize();
  };

  R.resize = () => {
    const rect = R.canvas.getBoundingClientRect();
    R.dpr = window.devicePixelRatio || 1;
    R.width = Math.max(1, Math.round(rect.width));
    R.height = Math.max(1, Math.round(rect.height));
    R.canvas.width = Math.round(R.width * R.dpr);
    R.canvas.height = Math.round(R.height * R.dpr);
  };

  /* ---------- camera ---------- */

  R.toScreen = (cam, x, y) => ({ x: (x - cam.x) * cam.zoom, y: (y - cam.y) * cam.zoom });
  R.toWorld = (cam, x, y) => ({ x: x / cam.zoom + cam.x, y: y / cam.zoom + cam.y });

  R.viewBounds = (cam) => ({
    x: cam.x,
    y: cam.y,
    w: R.width / cam.zoom,
    h: R.height / cam.zoom,
  });

  /* ---------- main ---------- */

  R.draw = (state) => {
    const ctx = R.ctx;
    const cam = state.cam;
    const doc = state.doc;

    ctx.save();
    ctx.scale(R.dpr, R.dpr);
    ctx.clearRect(0, 0, R.width, R.height);
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, R.width, R.height);

    if (state.showGrid) drawGrid(ctx, cam, doc.grid);

    ctx.save();
    ctx.translate(-cam.x * cam.zoom, -cam.y * cam.zoom);
    ctx.scale(cam.zoom, cam.zoom);

    const view = G.padAABB(R.viewBounds(cam), 4);
    const selected = state.selection;

    /* Painted in type order so machines sit above zones and under routes. */
    for (const it of doc.items) if (it.type === 'zone') drawItem(ctx, state, it, view);
    for (const it of doc.items) if (it.type === 'wall') drawItem(ctx, state, it, view);
    for (const it of doc.items) if (it.type === 'machine') drawItem(ctx, state, it, view);
    for (const it of doc.items) if (it.type === 'route') drawItem(ctx, state, it, view);
    for (const it of doc.items) if (it.type === 'label') drawItem(ctx, state, it, view);

    drawDraft(ctx, state);
    ctx.restore();

    /* Screen-space overlays. */
    for (const id of selected) {
      const it = M.byId(doc, id);
      if (it) drawSelection(ctx, state, it, selected.size === 1);
    }
    if (state.hover && !selected.has(state.hover)) {
      const it = M.byId(doc, state.hover);
      if (it) drawHoverOutline(ctx, state, it);
    }
    drawGuides(ctx, state);
    drawMarquee(ctx, state);
    drawMeasure(ctx, state);
    drawScaleBar(ctx, state);

    ctx.restore();
  };

  /* ---------- grid ---------- */

  function drawGrid(ctx, cam, step) {
    const view = R.viewBounds(cam);
    const px = step * cam.zoom;
    ctx.save();
    ctx.lineWidth = 1;

    if (px >= 7) {
      ctx.strokeStyle = C.gridMinor;
      ctx.beginPath();
      for (let x = Math.floor(view.x / step) * step; x < view.x + view.w; x += step) {
        const sx = Math.round((x - cam.x) * cam.zoom) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, R.height);
      }
      for (let y = Math.floor(view.y / step) * step; y < view.y + view.h; y += step) {
        const sy = Math.round((y - cam.y) * cam.zoom) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(R.width, sy);
      }
      ctx.stroke();
    }

    const major = step * 5;
    if (major * cam.zoom >= 7) {
      ctx.strokeStyle = C.gridMajor;
      ctx.beginPath();
      for (let x = Math.floor(view.x / major) * major; x < view.x + view.w; x += major) {
        const sx = Math.round((x - cam.x) * cam.zoom) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, R.height);
      }
      for (let y = Math.floor(view.y / major) * major; y < view.y + view.h; y += major) {
        const sy = Math.round((y - cam.y) * cam.zoom) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(R.width, sy);
      }
      ctx.stroke();
    }

    /* Origin cross. */
    const o = R.toScreen(cam, 0, 0);
    if (o.x > -50 && o.x < R.width + 50 && o.y > -50 && o.y < R.height + 50) {
      ctx.strokeStyle = C.axis;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(o.x - 9, o.y); ctx.lineTo(o.x + 9, o.y);
      ctx.moveTo(o.x, o.y - 9); ctx.lineTo(o.x, o.y + 9);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- items ---------- */

  function drawItem(ctx, state, it, view) {
    const b = M.bounds(state.doc, it);
    if (b && !G.aabbOverlap(b, view)) return;
    switch (it.type) {
      case 'machine': drawMachine(ctx, state, it); break;
      case 'zone':    drawZone(ctx, state, it); break;
      case 'wall':    drawWall(ctx, state, it); break;
      case 'route':   drawRoute(ctx, state, it); break;
      case 'label':   drawLabel(ctx, state, it); break;
    }
  }

  function withRotation(ctx, it, fn) {
    const c = G.rectCenter(it);
    ctx.save();
    if (it.rot) {
      ctx.translate(c.x, c.y);
      ctx.rotate(G.rad(it.rot));
      ctx.translate(-c.x, -c.y);
    }
    fn();
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawMachine(ctx, state, m) {
    const zoom = state.cam.zoom;
    drawStepBadge(ctx, state, m);
    withRotation(ctx, m, () => {
      if (m.clearance > 0) {
        ctx.save();
        ctx.setLineDash([0.3, 0.25]);
        ctx.lineWidth = 1 / zoom;
        ctx.strokeStyle = hexA(m.color, 0.55);
        ctx.fillStyle = hexA(m.color, 0.07);
        roundRect(ctx, m.x - m.clearance, m.y - m.clearance, m.w + m.clearance * 2, m.h + m.clearance * 2, 0.2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      roundRect(ctx, m.x, m.y, m.w, m.h, Math.min(0.18, m.w / 6, m.h / 6));
      ctx.fillStyle = hexA(m.color, 0.24);
      ctx.fill();
      ctx.lineWidth = 2 / zoom;
      ctx.strokeStyle = m.color;
      ctx.stroke();

      /* Corner tick so orientation is readable once rotated. */
      ctx.beginPath();
      ctx.moveTo(m.x, m.y + Math.min(0.5, m.h / 3));
      ctx.lineTo(m.x, m.y);
      ctx.lineTo(m.x + Math.min(0.5, m.w / 3), m.y);
      ctx.lineWidth = 3.5 / zoom;
      ctx.strokeStyle = m.color;
      ctx.stroke();

      if (!state.showLabels) return;
      const fit = Math.min(m.w, m.h) * zoom;
      if (fit < 16) return;

      const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
      const type = M.typeById(state.doc, m.kind);
      let fontPx = G.clamp(Math.min(m.h * zoom * 0.3, m.w * zoom * 0.16), 8, 15);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1 / zoom, 1 / zoom);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const maxW = m.w * zoom - 8;
      const raw = m.label || (type ? type.name : 'Machine');
      /* Shrink before truncating so short boxes still read. */
      const setFont = (px) => { ctx.font = '600 ' + px.toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif'; };
      setFont(fontPx);
      while (fontPx > 7.5 && ctx.measureText(raw).width > maxW) { fontPx -= 0.5; setFont(fontPx); }
      ctx.fillStyle = C.text;
      const line = ellipsize(ctx, raw, maxW);
      const showSub = m.h * zoom > 34;
      ctx.fillText(line, 0, showSub ? -fontPx * 0.55 : 0);

      if (showSub) {
        /* Name the type too, but only when it adds something the label doesn't. */
        const prefix = type && type.name !== raw ? type.name + ' · ' : '';
        ctx.font = (fontPx * 0.72).toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = C.textDim;
        ctx.fillText(ellipsize(ctx, prefix + fmt(m.w) + '×' + fmt(m.h) + ' m', maxW), 0, fontPx * 0.62);
      }
      ctx.restore();
    });
  }

  /* Machines named in the written process carry their step numbers. */
  function drawStepBadge(ctx, state, m) {
    if (!state.showLabels) return;
    const nums = M.stepsFor(state.doc, m.id);
    if (!nums.length) return;
    const zoom = state.cam.zoom;
    if (zoom < 8) return;

    const text = nums.length > 2 ? nums[0] + '+' : nums.join(',');
    const corner = G.rectCorners(m)[1];

    ctx.save();
    ctx.translate(corner.x, corner.y);
    ctx.scale(1 / zoom, 1 / zoom);
    ctx.font = '700 10px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = Math.max(15, ctx.measureText(text).width + 9);
    roundRect(ctx, -w / 2, -7.5, w, 15, 7.5);
    ctx.fillStyle = C.accent;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 0, 0.5);
    ctx.restore();
  }

  function drawZone(ctx, state, z) {
    const zoom = state.cam.zoom;
    withRotation(ctx, z, () => {
      ctx.save();
      ctx.fillStyle = hexA(z.color, 0.09);
      roundRect(ctx, z.x, z.y, z.w, z.h, 0.25);
      ctx.fill();

      if (z.hatch) {
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = hexA(z.color, 0.22);
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        const stepH = 0.8;
        for (let d = -z.h; d < z.w + z.h; d += stepH) {
          ctx.moveTo(z.x + d, z.y);
          ctx.lineTo(z.x + d - z.h, z.y + z.h);
        }
        ctx.stroke();
        ctx.restore();
      }

      ctx.setLineDash([0.5 , 0.35]);
      ctx.lineWidth = 2 / zoom;
      ctx.strokeStyle = hexA(z.color, 0.85);
      roundRect(ctx, z.x, z.y, z.w, z.h, 0.25);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      if (!state.showLabels || z.w * zoom < 40) return;
      ctx.save();
      ctx.translate(z.x + 0.35, z.y + 0.35);
      ctx.scale(1 / zoom, 1 / zoom);
      const fontPx = G.clamp(zoom * 0.36, 9, 14);
      ctx.font = '700 ' + fontPx.toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'top';
      const text = (z.label || 'Zone').toUpperCase();
      const w = ctx.measureText(text).width;
      ctx.fillStyle = hexA(z.color, 0.9);
      roundRect(ctx, -2, -1, w + 10, fontPx + 6, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(text, 3, 2);
      ctx.restore();
    });
  }

  function wallPoints(w) {
    return w.closed && w.points.length > 2 ? w.points.concat([w.points[0]]) : w.points;
  }

  function drawWall(ctx, state, w) {
    const pts = wallPoints(w);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);

    ctx.strokeStyle = C.wallEdge;
    ctx.lineWidth = w.thickness + 0.06;
    ctx.stroke();
    ctx.strokeStyle = w.color || C.wall;
    ctx.lineWidth = w.thickness;
    ctx.stroke();
    ctx.restore();
  }

  function drawRoute(ctx, state, r) {
    const pts = M.routePath(state.doc, r);
    if (pts.length < 2) return;
    const zoom = state.cam.zoom;
    const radius = Math.min(0.45, r.width * 3);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = r.color;
    ctx.lineWidth = r.width;
    if (r.dashed) ctx.setLineDash([r.width * 3, r.width * 2.4]);

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.arcTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, radius);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
    ctx.setLineDash([]);

    const head = Math.max(r.width * 3.2, 0.28);
    if (r.arrows === 'end' || r.arrows === 'both') {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      arrowHead(ctx, b, Math.atan2(b.y - a.y, b.x - a.x), head, r.color);
    }
    if (r.arrows === 'both') {
      const a = pts[1], b = pts[0];
      arrowHead(ctx, b, Math.atan2(b.y - a.y, b.x - a.x), head, r.color);
    }

    /* Direction pip halfway along so long runs stay readable. */
    if (r.arrows !== 'none' && G.polylineLength(pts) > 3) {
      const mid = G.pointAlong(pts, 0.5);
      arrowHead(ctx, mid, mid.angle, head * 0.8, r.color);
    }

    if (r.label && state.showLabels && zoom > 12) {
      const mid = G.pointAlong(pts, 0.5);
      ctx.save();
      ctx.translate(mid.x, mid.y - 0.35);
      ctx.scale(1 / zoom, 1 / zoom);
      const fontPx = G.clamp(zoom * 0.3, 9, 12);
      ctx.font = '600 ' + fontPx.toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(r.label).width;
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      roundRect(ctx, -tw / 2 - 5, -fontPx * 0.8, tw + 10, fontPx * 1.6, 4);
      ctx.fill();
      ctx.strokeStyle = hexA(r.color, 0.6);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.fillText(r.label, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function arrowHead(ctx, p, angle, size, color) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, size * 0.55);
    ctx.lineTo(-size * 0.72, 0);
    ctx.lineTo(-size, -size * 0.55);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function drawLabel(ctx, state, l) {
    const zoom = state.cam.zoom;
    ctx.save();
    ctx.translate(l.x, l.y);
    if (l.rot) ctx.rotate(G.rad(l.rot));
    ctx.scale(1 / zoom, 1 / zoom);
    const fontPx = Math.max(6, l.size * zoom);
    ctx.font = '600 ' + fontPx.toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, 0, 0);
    ctx.restore();
  }

  /* ---------- in-progress drawing ---------- */

  function drawDraft(ctx, state) {
    const d = state.draft;
    if (!d) return;
    const zoom = state.cam.zoom;
    ctx.save();
    ctx.strokeStyle = C.accent;
    ctx.fillStyle = C.accentSoft;
    ctx.lineWidth = 1.5 / zoom;

    if (d.kind === 'rect' && d.rect) {
      ctx.setLineDash([0.4, 0.3]);
      ctx.fillRect(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
      ctx.strokeRect(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
      ctx.setLineDash([]);
      dimText(ctx, state, d.rect);
    } else if (d.kind === 'wall' && d.points && d.points.length) {
      const pts = d.cursor ? d.points.concat([d.cursor]) : d.points;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = hexA(C.wall, 0.65);
      ctx.lineWidth = d.thickness || 0.25;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
      for (const p of d.points) dot(ctx, p, 3 / zoom, C.accent);
      if (d.cursor && d.points.length) {
        const a = d.points[d.points.length - 1];
        lengthText(ctx, state, a, d.cursor);
      }
    } else if (d.kind === 'route' && d.nodes && d.nodes.length) {
      const pts = d.cursor ? d.nodes.concat([d.cursor]) : d.nodes;
      ctx.save();
      ctx.setLineDash([0.35, 0.25]);
      ctx.strokeStyle = d.color || '#f97316';
      ctx.lineWidth = 0.14;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
      for (const p of d.nodes) dot(ctx, p, 3 / zoom, d.color || '#f97316');
    }
    ctx.restore();
  }

  function dot(ctx, p, r, color) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = r * 0.6;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }

  function screenText(ctx, state, wx, wy, text, opts) {
    const o = opts || {};
    const zoom = state.cam.zoom;
    ctx.save();
    ctx.translate(wx, wy);
    ctx.scale(1 / zoom, 1 / zoom);
    ctx.font = '600 11px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = o.align || 'center';
    ctx.textBaseline = o.baseline || 'middle';
    const w = ctx.measureText(text).width;
    const bx = o.align === 'left' ? -4 : -w / 2 - 5;
    ctx.fillStyle = o.bg || 'rgba(31,41,55,.9)';
    roundRect(ctx, bx, -8, w + 10, 16, 4);
    ctx.fill();
    ctx.fillStyle = o.fg || '#fff';
    ctx.fillText(text, o.align === 'left' ? 1 : 0, 0.5);
    ctx.restore();
  }

  function dimText(ctx, state, r) {
    screenText(ctx, state, r.x + r.w / 2, r.y - 0.4, fmt(r.w) + ' × ' + fmt(r.h) + ' m');
  }

  function lengthText(ctx, state, a, b) {
    const d = G.dist(a.x, a.y, b.x, b.y);
    screenText(ctx, state, (a.x + b.x) / 2, (a.y + b.y) / 2 - 0.5, fmt(d) + ' m');
  }

  /* ---------- selection & handles ---------- */

  const HANDLE_DIRS = [
    ['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1],
    ['e', 1, 0], ['se', 1, 1], ['s', 0, 1],
    ['sw', -1, 1], ['w', -1, 0],
  ];

  /* Handles in screen coordinates for the given item. */
  R.handlesFor = (state, it) => {
    const cam = state.cam;
    const out = [];
    if (M.isRect(it)) {
      const c = G.rectCenter(it);
      const a = G.rad(it.rot || 0);
      for (const [name, hx, hy] of HANDLE_DIRS) {
        const w = G.rotate(c.x + (hx * it.w) / 2, c.y + (hy * it.h) / 2, c.x, c.y, a);
        const s = R.toScreen(cam, w.x, w.y);
        out.push({ name, kind: 'resize', x: s.x, y: s.y, dir: [hx, hy] });
      }
      const top = G.rotate(c.x, c.y - it.h / 2, c.x, c.y, a);
      const ts = R.toScreen(cam, top.x, top.y);
      const nx = Math.sin(a), ny = -Math.cos(a);
      out.push({ name: 'rotate', kind: 'rotate', x: ts.x + nx * 22, y: ts.y + ny * 22 });
    } else if (it.type === 'wall') {
      it.points.forEach((p, i) => {
        const s = R.toScreen(cam, p.x, p.y);
        out.push({ name: 'v' + i, kind: 'vertex', index: i, x: s.x, y: s.y });
      });
    } else if (it.type === 'route') {
      (it.waypoints || []).forEach((p, i) => {
        const s = R.toScreen(cam, p.x, p.y);
        out.push({ name: 'w' + i, kind: 'waypoint', index: i, x: s.x, y: s.y });
      });
      ['from', 'to'].forEach((end) => {
        const e = it[end];
        if (e && !e.item) {
          const s = R.toScreen(cam, e.x, e.y);
          out.push({ name: end, kind: 'endpoint', end, x: s.x, y: s.y });
        }
      });
    } else if (it.type === 'label') {
      const s = R.toScreen(cam, it.x, it.y);
      out.push({ name: 'move', kind: 'move', x: s.x, y: s.y });
    }
    return out;
  };

  function drawSelection(ctx, state, it, single) {
    const cam = state.cam;
    ctx.save();
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.5;

    if (M.isRect(it)) {
      const pts = G.rectCorners(it).map((p) => R.toScreen(cam, p.x, p.y));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
    } else {
      const b = M.bounds(state.doc, it);
      if (b) {
        const p0 = R.toScreen(cam, b.x, b.y);
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(p0.x - 3, p0.y - 3, b.w * cam.zoom + 6, b.h * cam.zoom + 6);
        ctx.setLineDash([]);
      }
    }

    if (single) {
      for (const h of R.handlesFor(state, it)) {
        if (h.kind === 'rotate') {
          const c = G.rectCenter(it);
          const a = G.rad(it.rot || 0);
          const top = G.rotate(c.x, c.y - it.h / 2, c.x, c.y, a);
          const ts = R.toScreen(cam, top.x, top.y);
          ctx.beginPath();
          ctx.moveTo(ts.x, ts.y);
          ctx.lineTo(h.x, h.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(h.x, h.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = C.accent;
          ctx.fill();
        } else {
          const s = h.kind === 'vertex' || h.kind === 'waypoint' || h.kind === 'endpoint' ? 4.5 : 4;
          ctx.beginPath();
          ctx.rect(h.x - s, h.y - s, s * 2, s * 2);
          ctx.fillStyle = C.handle;
          ctx.fill();
          ctx.strokeStyle = C.accent;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      if (M.isRect(it)) {
        const b = G.rectAABB(it);
        const s = R.toScreen(cam, b.x + b.w / 2, b.y + b.h);
        badge(ctx, s.x, s.y + 18, fmt(it.w) + ' × ' + fmt(it.h) + ' m' + (it.rot ? '  ∠' + Math.round(it.rot) + '°' : ''));
      } else if (it.type === 'route') {
        const pts = M.routePath(state.doc, it);
        if (pts.length > 1) {
          const mid = G.pointAlong(pts, 0.5);
          const s = R.toScreen(cam, mid.x, mid.y);
          badge(ctx, s.x, s.y + 20, fmt(G.polylineLength(pts)) + ' m');
        }
      } else if (it.type === 'wall') {
        const len = G.polylineLength(wallPoints(it));
        const b = M.bounds(state.doc, it);
        const s = R.toScreen(cam, b.x + b.w / 2, b.y + b.h);
        badge(ctx, s.x, s.y + 18, fmt(len) + ' m of wall');
      }
    }
    ctx.restore();
  }

  function drawHoverOutline(ctx, state, it) {
    const cam = state.cam;
    ctx.save();
    ctx.strokeStyle = 'rgba(43,125,224,.5)';
    ctx.lineWidth = 1.5;
    if (M.isRect(it)) {
      const pts = G.rectCorners(it).map((p) => R.toScreen(cam, p.x, p.y));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
    } else {
      const b = M.bounds(state.doc, it);
      if (b) {
        const p0 = R.toScreen(cam, b.x, b.y);
        ctx.strokeRect(p0.x - 2, p0.y - 2, b.w * cam.zoom + 4, b.h * cam.zoom + 4);
      }
    }
    ctx.restore();
  }

  function badge(ctx, x, y, text) {
    ctx.save();
    ctx.font = '600 11px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(31,41,55,.9)';
    roundRect(ctx, x - w / 2 - 6, y - 9, w + 12, 18, 5);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }

  function drawGuides(ctx, state) {
    if (!state.guides || !state.guides.length) return;
    ctx.save();
    ctx.strokeStyle = C.guide;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    for (const g of state.guides) {
      ctx.beginPath();
      if (g.axis === 'x') {
        const s = R.toScreen(state.cam, g.value, 0);
        ctx.moveTo(Math.round(s.x) + 0.5, 0);
        ctx.lineTo(Math.round(s.x) + 0.5, R.height);
      } else {
        const s = R.toScreen(state.cam, 0, g.value);
        ctx.moveTo(0, Math.round(s.y) + 0.5);
        ctx.lineTo(R.width, Math.round(s.y) + 0.5);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMarquee(ctx, state) {
    const m = state.marquee;
    if (!m) return;
    const a = R.toScreen(state.cam, m.x, m.y);
    ctx.save();
    ctx.fillStyle = 'rgba(43,125,224,.12)';
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(a.x, a.y, m.w * state.cam.zoom, m.h * state.cam.zoom);
    ctx.strokeRect(a.x, a.y, m.w * state.cam.zoom, m.h * state.cam.zoom);
    ctx.restore();
  }

  function drawMeasure(ctx, state) {
    const m = state.measure;
    if (!m || !m.b) return;
    const a = R.toScreen(state.cam, m.a.x, m.a.y);
    const b = R.toScreen(state.cam, m.b.x, m.b.y);
    ctx.save();
    ctx.strokeStyle = C.guide;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = C.guide;
      ctx.fill();
    }
    const d = G.dist(m.a.x, m.a.y, m.b.x, m.b.y);
    const dx = Math.abs(m.b.x - m.a.x), dy = Math.abs(m.b.y - m.a.y);
    badge(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2 - 16,
      fmt(d) + ' m   (Δx ' + fmt(dx) + ', Δy ' + fmt(dy) + ')');
    ctx.restore();
  }

  function drawScaleBar(ctx, state) {
    const zoom = state.cam.zoom;
    const targetPx = 110;
    const nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    let unit = nice[nice.length - 1];
    for (const n of nice) { if (n * zoom >= targetPx * 0.6) { unit = n; break; } }
    const px = unit * zoom;
    const x = 14, y = R.height - 40;
    ctx.save();
    ctx.strokeStyle = 'rgba(31,41,55,.65)';
    ctx.fillStyle = 'rgba(31,41,55,.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5);
    ctx.stroke();
    ctx.font = '600 10.5px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(unit + ' m', x + px + 6, y + 2);
    ctx.restore();
  }

  /* ---------- utils ---------- */

  function fmt(v) {
    const r = Math.round(v * 100) / 100;
    return Number.isInteger(r) ? String(r) : r.toFixed(Math.abs(r) < 10 ? 2 : 1).replace(/0$/, '').replace(/\.$/, '');
  }
  R.fmt = fmt;

  function ellipsize(ctx, text, maxW) {
    if (maxW <= 0) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  function hexA(hex, alpha) {
    if (!hex || hex[0] !== '#') return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }
  R.hexA = hexA;

  /* Render the document to an offscreen canvas for PNG export. */
  R.exportPNG = (state, scale, padding) => {
    const doc = state.doc;
    const b = M.docBounds(doc);
    if (!b) return null;
    const pad = padding === undefined ? 2 : padding;
    const zoom = (scale || 40);
    const w = Math.min(8000, Math.max(64, Math.round((b.w + pad * 2) * zoom)));
    const h = Math.min(8000, Math.max(64, Math.round((b.h + pad * 2) * zoom)));

    const off = document.createElement('canvas');
    off.width = w; off.height = h;

    const prev = { canvas: R.canvas, ctx: R.ctx, dpr: R.dpr, width: R.width, height: R.height };
    R.canvas = off;
    R.ctx = off.getContext('2d');
    R.dpr = 1;
    R.width = w;
    R.height = h;

    R.draw({
      doc,
      cam: { x: b.x - pad, y: b.y - pad, zoom },
      selection: new Set(),
      hover: null,
      showGrid: state.showGrid,
      showLabels: state.showLabels,
      draft: null,
      guides: [],
      marquee: null,
      measure: null,
    });

    R.canvas = prev.canvas; R.ctx = prev.ctx; R.dpr = prev.dpr; R.width = prev.width; R.height = prev.height;
    return off;
  };

  FB.render = R;
})(window.FB);
