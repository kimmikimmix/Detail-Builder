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
    ctx.fillStyle = state.background || C.paper;
    ctx.fillRect(0, 0, R.width, R.height);

    if (state.showGrid) drawGrid(ctx, cam, doc.grid);

    ctx.save();
    ctx.translate(-cam.x * cam.zoom, -cam.y * cam.zoom);
    ctx.scale(cam.zoom, cam.zoom);

    const view = G.padAABB(R.viewBounds(cam), 4);
    const selected = state.selection;
    labelRects = [];

    /* Painted in list order, so the Layers list is the truth about what covers
       what and sending something to the top actually puts it there. */
    for (const it of doc.items) drawItem(ctx, state, it, view);

    if (state.showSpecs) {
      for (const it of doc.items) if (it.type === 'machine' && !it.hidden) drawSpecs(ctx, state, it);
    }
    if (state.showTimes) {
      for (const it of doc.items) if (it.type === 'zone' && !it.hidden) drawZoneInfo(ctx, state, it);
    }

    drawRun(ctx, state);
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

  /* The vehicle assigned to the run rides it instead of sitting where it was
     parked — drawn transformed, so the document is never touched. */
  function driverPose(state, m) {
    const play = state.play;
    if (!play || !play.at || !play.driverId || play.driverId !== m.id) return null;
    /* Parked until the run actually starts, so the layout reads normally and
       Restart brings the vehicle home. */
    if (!play.running && play.t <= 0) return null;
    return play.at;
  }
  R.driverPose = driverPose;

  function drawItem(ctx, state, it, view) {
    if (it.hidden) return;

    const pose = it.type === 'machine' ? driverPose(state, it) : null;
    if (pose) {
      const c = G.rectCenter(it);
      const riding = Object.assign({}, it, { rot: 0 });
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.rotate(pose.angle || 0);
      ctx.translate(-c.x, -c.y);
      drawMachine(ctx, state, riding);
      ctx.restore();
      return;
    }

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

      const radius = m.vehicle
        ? Math.min(m.w, m.h) / 3
        : Math.min(0.18, m.w / 6, m.h / 6);
      roundRect(ctx, m.x, m.y, m.w, m.h, radius);
      ctx.fillStyle = hexA(m.color, 0.24);
      ctx.fill();
      ctx.lineWidth = 2 / zoom;
      ctx.strokeStyle = m.color;
      if (m.vehicle) ctx.setLineDash([0.35, 0.22]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (m.vehicle) {
        /* A chevron pointing along the vehicle's own forward axis. */
        const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
        const nose = Math.min(m.w * 0.3, m.h * 0.35);
        ctx.beginPath();
        ctx.moveTo(cx + m.w / 2 - nose * 1.4, cy - nose * 0.7);
        ctx.lineTo(cx + m.w / 2 - nose * 0.35, cy);
        ctx.lineTo(cx + m.w / 2 - nose * 1.4, cy + nose * 0.7);
        ctx.lineWidth = 2.4 / zoom;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = m.color;
        ctx.stroke();
      } else {
        /* Corner tick so orientation is readable once rotated. */
        ctx.beginPath();
        ctx.moveTo(m.x, m.y + Math.min(0.5, m.h / 3));
        ctx.lineTo(m.x, m.y);
        ctx.lineTo(m.x + Math.min(0.5, m.w / 3), m.y);
        ctx.lineWidth = 3.5 / zoom;
        ctx.strokeStyle = m.color;
        ctx.stroke();
      }

      if (!state.showLabels) return;
      /* Below this the box is a dot — a label would be noise. */
      if (Math.min(m.w, m.h) * zoom < 9) return;

      const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
      const type = M.typeById(state.doc, m.kind);
      const raw = m.label || (type ? type.name : 'Machine');
      const maxW = m.w * zoom - 8;

      const setFont = (px) => { ctx.font = '600 ' + px.toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif'; };

      /* Shrink to fit before giving up on putting the name inside the box. */
      let fontPx = G.clamp(Math.min(m.h * zoom * 0.3, m.w * zoom * 0.16), 8, 15);
      ctx.save();
      setFont(fontPx);
      while (fontPx > MIN_LABEL_PX && ctx.measureText(raw).width > maxW) { fontPx -= 0.5; setFont(fontPx); }
      const fitsInside = m.h * zoom >= MIN_LABEL_PX * 1.7 && ctx.measureText(raw).width <= maxW;
      ctx.restore();

      if (!fitsInside) {
        /* A truncated name is no name at all, so put it outside instead. */
        drawOutsideLabel(ctx, state, m, raw);
        return;
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1 / zoom, 1 / zoom);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      setFont(fontPx);
      ctx.fillStyle = C.text;
      const showSub = m.h * zoom > 34;
      ctx.fillText(raw, 0, showSub ? -fontPx * 0.55 : 0);

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

  const MIN_LABEL_PX = 7.5;
  /* An outside label is only worth drawing when the box is big enough to name. */
  const MIN_OUTSIDE_BOX_PX = 26;

  /* Screen-space rectangles already taken by outside labels this frame, so
     names never pile on top of each other when the view is zoomed out. */
  let labelRects = [];

  function claimLabelRect(r) {
    for (const o of labelRects) {
      if (r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y) return false;
    }
    labelRects.push(r);
    return true;
  }

  /* A name for a machine too small to hold it: a chip just outside the box,
     above when a details card is already sitting underneath. */
  function drawOutsideLabel(ctx, state, m, text) {
    const zoom = state.cam.zoom;
    const b = G.rectAABB(m);
    if (Math.max(b.w, b.h) * zoom < MIN_OUTSIDE_BOX_PX) return;

    const hasCard = state.showSpecs && (m.params || []).some((p) => p.k || p.v);
    const above = hasCard;
    const y = above ? -12 : 12;

    ctx.save();
    ctx.font = '600 10px Inter, "Segoe UI", system-ui, sans-serif';
    const w = ctx.measureText(text).width;
    ctx.restore();

    /* Claim the space first — a name that would land on another one is
       dropped rather than drawn over it. */
    const anchor = R.toScreen(state.cam, b.x + b.w / 2, above ? b.y : b.y + b.h);
    if (!claimLabelRect({ x: anchor.x - w / 2 - 4, y: anchor.y + y - 7, w: w + 8, h: 14 })) return;

    ctx.save();
    ctx.translate(b.x + b.w / 2, above ? b.y : b.y + b.h);
    ctx.scale(1 / zoom, 1 / zoom);
    ctx.font = '600 10px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    roundRect(ctx, -w / 2 - 4, y - 7, w + 8, 14, 3);
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fill();
    ctx.strokeStyle = hexA(m.color, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();

    /* A short leader so the name is clearly tied to its box. */
    ctx.beginPath();
    ctx.moveTo(0, above ? -5 : 5);
    ctx.lineTo(0, above ? 0 : 0);
    ctx.strokeStyle = hexA(m.color, 0.55);
    ctx.stroke();

    ctx.fillStyle = C.text;
    ctx.fillText(text, 0, y);
    ctx.restore();
  }

  /* Machines named in the written process carry their step numbers. */
  function drawStepBadge(ctx, state, m) {
    if (!state.showLabels || driverPose(state, m)) return;
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

  /* Machine parameters — wash pressure, temperature and the like — as a card
     tucked under the machine. */
  function drawSpecs(ctx, state, m) {
    const params = (m.params || []).filter((p) => p.k || p.v);
    if (!params.length || driverPose(state, m)) return;
    const zoom = state.cam.zoom;
    if (zoom < 11) return;

    const b = G.rectAABB(m);
    const lineH = 12;
    const padX = 6, padY = 5;

    ctx.save();
    ctx.translate(b.x + b.w / 2, b.y + b.h);
    ctx.scale(1 / zoom, 1 / zoom);
    ctx.font = '10px Inter, "Segoe UI", system-ui, sans-serif';

    let wide = 0;
    const rows = params.slice(0, 6).map((p) => {
      const k = p.k ? p.k + ':' : '';
      ctx.font = '600 10px Inter, "Segoe UI", system-ui, sans-serif';
      const kw = ctx.measureText(k).width;
      ctx.font = '10px Inter, "Segoe UI", system-ui, sans-serif';
      const vw = ctx.measureText(p.v).width;
      wide = Math.max(wide, kw + vw + 5);
      return { k, v: p.v, kw };
    });
    const more = params.length - rows.length;
    if (more > 0) wide = Math.max(wide, 60);

    const w = wide + padX * 2;
    const h = rows.length * lineH + (more > 0 ? lineH : 0) + padY * 2;

    roundRect(ctx, -w / 2, 6, w, h, 5);
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    ctx.fill();
    ctx.strokeStyle = hexA(m.color, 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let y = 6 + padY + lineH / 2;
    for (const r of rows) {
      ctx.font = '600 10px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = C.textDim;
      ctx.fillText(r.k, -w / 2 + padX, y);
      ctx.font = '10px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = C.text;
      ctx.fillText(r.v, -w / 2 + padX + r.kw + 5, y);
      y += lineH;
    }
    if (more > 0) {
      ctx.font = 'italic 10px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = C.textDim;
      ctx.fillText('+' + more + ' more', -w / 2 + padX, y);
    }
    ctx.restore();
  }

  /* What a zone does and how long it takes. */
  function drawZoneInfo(ctx, state, z) {
    const zoom = state.cam.zoom;
    if (zoom < 9) return;
    if (!z.duration && !z.process) return;

    ctx.save();
    ctx.translate(z.x + z.w, z.y);
    ctx.scale(1 / zoom, 1 / zoom);
    ctx.textBaseline = 'middle';

    if (z.duration) {
      const text = '⏱ ' + fmtTime(z.duration);
      ctx.font = '700 11px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'right';
      const w = ctx.measureText(text).width + 14;
      roundRect(ctx, -w - 4, 4, w, 19, 9.5);
      ctx.fillStyle = hexA(z.color, 0.92);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(text, -11, 14);
    }

    if (z.process && z.w * zoom > 120) {
      const line = z.process.split('\n')[0];
      ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      const maxW = z.w * zoom - 24;
      const text = ellipsize(ctx, line, maxW);
      const w = ctx.measureText(text).width + 12;
      const x = -(z.w * zoom) + 4;
      roundRect(ctx, x, 27, w, 18, 4);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fill();
      ctx.strokeStyle = hexA(z.color, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.fillText(text, x + 6, 36.5);
    }
    ctx.restore();
  }

  function fmtTime(minutes) {
    if (minutes < 1) return Math.round(minutes * 60) + ' s';
    if (minutes < 60) return fmt(minutes) + ' min';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes - h * 60);
    return m ? h + ' h ' + m + ' min' : h + ' h';
  }
  R.fmtTime = fmtTime;

  /* ---------- the animated run ---------- */

  function drawRun(ctx, state) {
    const play = state.play;
    if (!play || !play.path) return;
    const path = play.path;
    if (!path.stops.length) return;
    const zoom = state.cam.zoom;

    if (state.showRun) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(79,156,249,.32)';
      ctx.lineWidth = 0.3;
      for (const leg of path.legs) {
        ctx.beginPath();
        ctx.moveTo(leg.pts[0].x, leg.pts[0].y);
        for (let i = 1; i < leg.pts.length; i++) ctx.lineTo(leg.pts[i].x, leg.pts[i].y);
        if (!leg.viaRoute) ctx.setLineDash([0.6, 0.4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      /* Number every stop so the order is readable while editing it. */
      path.stops.forEach((s, i) => {
        const c = s.pos;
        if (!s.item) {
          /* A loose point on a hand-drawn path. */
          ctx.save();
          ctx.beginPath();
          ctx.arc(c.x, c.y, 4 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = 2 / zoom;
          ctx.strokeStyle = '#4f9cf9';
          ctx.stroke();
          ctx.restore();
        }
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.scale(1 / zoom, 1 / zoom);
        ctx.beginPath();
        ctx.arc(0, -22, 10, 0, Math.PI * 2);
        ctx.fillStyle = '#4f9cf9';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = '700 11px Inter, "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), 0, -21.5);
        ctx.restore();
      });
      ctx.restore();
    }

    const at = play.at;
    if (!at) return;

    /* Ring the machine currently being worked on. */
    if (at.stop && M.isRect(at.stop)) {
      ctx.save();
      ctx.strokeStyle = '#4f9cf9';
      ctx.lineWidth = 3 / zoom;
      ctx.setLineDash([0.5, 0.35]);
      const pad = 0.3;
      roundRect(ctx, at.stop.x - pad, at.stop.y - pad, at.stop.w + pad * 2, at.stop.h + pad * 2, 0.3);
      ctx.stroke();
      ctx.restore();
    }

    /* When a vehicle is driving it is the marker. */
    if (play.driverId && M.byId(state.doc, play.driverId)) return;

    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(1 / zoom, 1 / zoom);

    if (at.working) {
      ctx.beginPath();
      ctx.arc(0, 0, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * G.clamp(at.progress, 0, 1));
      ctx.strokeStyle = 'rgba(79,156,249,.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = at.working ? '#f59e0b' : '#4f9cf9';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
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
    } else if (d.kind === 'run' && d.nodes && d.nodes.length) {
      const pts = d.cursor ? d.nodes.concat([d.cursor]) : d.nodes;
      ctx.save();
      ctx.setLineDash([0.5, 0.35]);
      ctx.strokeStyle = '#4f9cf9';
      ctx.lineWidth = 0.18;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
      d.nodes.forEach((p, i) => {
        dot(ctx, p, 4 / zoom, '#4f9cf9');
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(1 / zoom, 1 / zoom);
        ctx.font = '700 10px Inter, "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1f2937';
        ctx.fillText(String(i + 1), 0, -13);
        ctx.restore();
      });
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
  /* opts: { scale, padding, dpr, showGrid, showLabels, showSpecs, showTimes }.
     `dpr` supersamples: the drawing is composed at `scale` px per metre and the
     bitmap comes out that many times larger, so text keeps its size relative to
     the layout while the image stays sharp enough to print.
     Anything omitted falls back to what is on screen. A number in place of
     opts is read as the scale, keeping the older two-argument form working. */
  R.exportPNG = (state, opts, padding) => {
    const o = typeof opts === 'number' || opts === undefined
      ? { scale: opts, padding: padding }
      : opts;
    const pick = (key) => (o[key] === undefined ? state[key] : o[key]);

    const doc = state.doc;
    const b = M.docBounds(doc);
    if (!b) return null;
    const pad = o.padding === undefined ? 2 : o.padding;
    const zoom = (o.scale || 40);
    const dpr = Math.max(1, o.dpr || 1);
    const w = Math.min(8000, Math.max(64, Math.round((b.w + pad * 2) * zoom)));
    const h = Math.min(8000, Math.max(64, Math.round((b.h + pad * 2) * zoom)));

    const off = document.createElement('canvas');
    off.width = Math.min(16000, Math.round(w * dpr));
    off.height = Math.min(16000, Math.round(h * dpr));

    const prev = { canvas: R.canvas, ctx: R.ctx, dpr: R.dpr, width: R.width, height: R.height };
    R.canvas = off;
    R.ctx = off.getContext('2d');
    R.dpr = dpr;
    R.width = w;
    R.height = h;

    R.draw({
      doc,
      cam: { x: b.x - pad, y: b.y - pad, zoom },
      selection: new Set(),
      hover: null,
      background: o.background,
      showGrid: pick('showGrid'),
      showLabels: pick('showLabels'),
      showSpecs: pick('showSpecs'),
      showTimes: pick('showTimes'),
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
