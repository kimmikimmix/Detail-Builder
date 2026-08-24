/* Pointer interaction: every tool's press / move / release behaviour. */
(function (FB) {
  'use strict';

  const G = FB.geom;
  const M = FB.model;
  const R = FB.render;

  const T = {};
  let state = null;
  let canvas = null;
  let app = null;

  const HANDLE_R = 7;      /* screen px */
  const CLICK_SLOP = 4;    /* screen px before a click becomes a drag */
  const GUIDE_PX = 6;

  T.init = (canvasEl, appState, appApi) => {
    canvas = canvasEl;
    state = appState;
    app = appApi;

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('pointerleave', () => {
      state.cursorWorld = null;
      app.refreshStatus();
    });
  };

  /* ---------- helpers ---------- */

  function screenPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function worldPos(e) {
    const s = screenPos(e);
    return R.toWorld(state.cam, s.x, s.y);
  }

  function tolWorld(px) { return px / state.cam.zoom; }

  function snapVal(v, e) {
    if (!state.snap || (e && e.altKey)) return v;
    return G.snap(v, state.doc.grid);
  }

  function snapPoint(p, e) {
    return { x: snapVal(p.x, e), y: snapVal(p.y, e) };
  }

  function selectedItems() {
    return state.doc.items.filter((it) => state.selection.has(it.id));
  }

  function setSelection(ids) {
    state.selection = new Set(ids);
    app.refresh();
  }

  /* ---------- alignment guides ---------- */

  function collectGuideEdges(excludeIds) {
    const xs = [], ys = [];
    for (const it of state.doc.items) {
      if (excludeIds.has(it.id)) continue;
      if (!M.isRect(it) || it.rot) continue;
      xs.push(it.x, it.x + it.w / 2, it.x + it.w);
      ys.push(it.y, it.y + it.h / 2, it.y + it.h);
    }
    return { xs, ys };
  }

  /* Nudge a proposed delta so moving items line up with neighbours. */
  function applyGuides(box, dx, dy, excludeIds) {
    state.guides = [];
    if (!state.snapGuides) return { dx, dy };
    const { xs, ys } = collectGuideEdges(excludeIds);
    const tol = tolWorld(GUIDE_PX);
    const cand = {
      x: [box.x + dx, box.x + dx + box.w / 2, box.x + dx + box.w],
      y: [box.y + dy, box.y + dy + box.h / 2, box.y + dy + box.h],
    };
    let bestX = null, bestY = null;
    for (const v of cand.x) {
      for (const g of xs) {
        const d = g - v;
        if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, g };
      }
    }
    for (const v of cand.y) {
      for (const g of ys) {
        const d = g - v;
        if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, g };
      }
    }
    if (bestX) { dx += bestX.d; state.guides.push({ axis: 'x', value: bestX.g }); }
    if (bestY) { dy += bestY.d; state.guides.push({ axis: 'y', value: bestY.g }); }
    return { dx, dy };
  }

  /* ---------- pointer down ---------- */

  function onDown(e) {
    if (e.button === 2) {           /* right button cancels in-progress work */
      if (state.draft) { cancelDraft(); e.preventDefault(); }
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    app.closeInlineEdit();

    const sp = screenPos(e);
    const wp = worldPos(e);

    if (e.button === 1 || state.tool === 'pan' || state.spaceDown) {
      state.drag = { type: 'pan', startScreen: sp, startCam: { x: state.cam.x, y: state.cam.y } };
      canvas.style.cursor = 'grabbing';
      return;
    }

    switch (state.tool) {
      case 'select':  downSelect(e, sp, wp); break;
      case 'machine': downRect(e, wp, 'machine'); break;
      case 'zone':    downRect(e, wp, 'zone'); break;
      case 'room':    downRect(e, wp, 'room'); break;
      case 'wall':    downWall(e, wp); break;
      case 'route':   downRoute(e, wp); break;
      case 'text':    downText(e, wp); break;
      case 'measure': downMeasure(e, wp); break;
    }
    app.invalidate();
  }

  function downSelect(e, sp, wp) {
    /* Handles of a single selected item take priority. */
    if (state.selection.size === 1) {
      const it = M.byId(state.doc, [...state.selection][0]);
      if (it) {
        const h = handleAt(it, sp);
        if (h) { startHandleDrag(it, h, wp, e); return; }
      }
    }

    const hit = M.hitTest(state.doc, wp, tolWorld(5));
    if (hit) {
      if (e.shiftKey) {
        if (state.selection.has(hit.id)) state.selection.delete(hit.id);
        else state.selection.add(hit.id);
        app.refresh();
        return;
      }
      if (!state.selection.has(hit.id)) setSelection([hit.id]);

      const items = selectedItems();
      state.drag = {
        type: 'move',
        startWorld: wp,
        moved: false,
        startScreen: sp,
        origins: items.map((it) => ({ id: it.id, snap: M.clone(it) })),
        box: G.unionAABB(items.map((it) => M.bounds(state.doc, it))),
      };
      return;
    }

    if (!e.shiftKey) setSelection([]);
    state.drag = { type: 'marquee', startWorld: wp, keep: new Set(state.selection) };
  }

  function handleAt(it, sp) {
    const hs = R.handlesFor(state, it);
    for (const h of hs) {
      if (Math.abs(h.x - sp.x) <= HANDLE_R && Math.abs(h.y - sp.y) <= HANDLE_R) return h;
    }
    return null;
  }

  function startHandleDrag(it, h, wp, e) {
    if (h.kind === 'resize') {
      state.drag = { type: 'resize', id: it.id, dir: h.dir, orig: M.clone(it), startWorld: wp };
    } else if (h.kind === 'rotate') {
      const c = G.rectCenter(it);
      state.drag = {
        type: 'rotate', id: it.id, orig: M.clone(it), center: c,
        startAngle: Math.atan2(wp.y - c.y, wp.x - c.x),
      };
    } else if (h.kind === 'vertex') {
      state.drag = { type: 'vertex', id: it.id, index: h.index, orig: M.clone(it) };
    } else if (h.kind === 'waypoint') {
      state.drag = { type: 'waypoint', id: it.id, index: h.index, orig: M.clone(it) };
    } else if (h.kind === 'endpoint') {
      state.drag = { type: 'endpoint', id: it.id, end: h.end, orig: M.clone(it) };
    } else if (h.kind === 'move') {
      state.drag = {
        type: 'move', startWorld: wp, moved: false,
        origins: [{ id: it.id, snap: M.clone(it) }],
        box: M.bounds(state.doc, it),
      };
    }
  }

  function downRect(e, wp, mode) {
    const p = snapPoint(wp, e);
    state.draft = { kind: 'rect', mode, start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 } };
    state.drag = { type: 'draftRect' };
  }

  function downWall(e, wp) {
    const p = snapPoint(wp, e);
    if (!state.draft || state.draft.kind !== 'wall') {
      state.draft = { kind: 'wall', points: [p], cursor: p, thickness: state.wallThickness };
    } else {
      const pts = state.draft.points;
      const last = pts[pts.length - 1];
      const q = e.shiftKey ? snapPoint(G.constrain45(last, wp), e) : p;
      if (G.dist(last.x, last.y, q.x, q.y) > 1e-6) pts.push(q);
    }
    state.drag = { type: 'wallPress', startScreen: screenPos(e) };
    app.setHint('Click for the next corner · Enter or double-click to finish · Esc to cancel');
  }

  function downRoute(e, wp) {
    const host = M.hostAt(state.doc, wp, tolWorld(4));
    if (!state.draft || state.draft.kind !== 'route') {
      const from = host ? M.endpointOn(host.id) : M.endpointAt(snapVal(wp.x, e), snapVal(wp.y, e));
      const anchor = host ? G.rectCenter(host) : { x: snapVal(wp.x, e), y: snapVal(wp.y, e) };
      state.draft = { kind: 'route', from, nodes: [anchor], waypoints: [], cursor: wp, color: state.routeColor };
      state.drag = { type: 'routePress', startScreen: screenPos(e) };
      app.setHint('Drag to the destination machine, or click it · click empty space to add a bend · Esc to cancel');
      return;
    }

    const d = state.draft;
    if (host && !(d.from.item === host.id && d.waypoints.length === 0)) {
      finishRoute(M.endpointOn(host.id));
      return;
    }
    const p = snapPoint(wp, e);
    d.waypoints.push(p);
    d.nodes.push(p);
    state.drag = { type: 'routePress', startScreen: screenPos(e) };
  }

  function downText(e, wp) {
    const l = M.label(snapVal(wp.x, e), snapVal(wp.y, e), 'Label');
    state.doc.items.push(l);
    setSelection([l.id]);
    app.commit();
    app.setTool('select');
    app.editLabel(l);
  }

  function downMeasure(e, wp) {
    const p = snapPoint(wp, e);
    state.measure = { a: p, b: null };
    state.drag = { type: 'measure' };
  }

  /* ---------- pointer move ---------- */

  function onMove(e) {
    const sp = screenPos(e);
    const wp = R.toWorld(state.cam, sp.x, sp.y);
    state.cursorWorld = wp;

    const d = state.drag;
    if (state.draft && (state.draft.kind === 'wall' || state.draft.kind === 'route')) {
      updateDraftCursor(e, wp);
    }

    if (!d) {
      if (state.tool === 'select' && !state.draft) {
        const hit = M.hitTest(state.doc, wp, tolWorld(5));
        const id = hit ? hit.id : null;
        if (id !== state.hover) { state.hover = id; app.invalidate(); }
        updateCursor(sp, hit);
      }
      app.refreshStatus();
      return;
    }

    switch (d.type) {
      case 'pan': {
        state.cam.x = d.startCam.x - (sp.x - d.startScreen.x) / state.cam.zoom;
        state.cam.y = d.startCam.y - (sp.y - d.startScreen.y) / state.cam.zoom;
        break;
      }
      case 'move': moveDrag(d, wp, sp, e); break;
      case 'resize': resizeDrag(d, wp, e); break;
      case 'rotate': rotateDrag(d, wp, e); break;
      case 'vertex': {
        const it = M.byId(state.doc, d.id);
        if (it) it.points[d.index] = snapPoint(wp, e);
        break;
      }
      case 'waypoint': {
        const it = M.byId(state.doc, d.id);
        if (it) it.waypoints[d.index] = snapPoint(wp, e);
        break;
      }
      case 'endpoint': {
        const it = M.byId(state.doc, d.id);
        if (it) {
          const host = M.hostAt(state.doc, wp, tolWorld(4));
          it[d.end] = host ? M.endpointOn(host.id) : M.endpointAt(snapVal(wp.x, e), snapVal(wp.y, e));
          state.hover = host ? host.id : null;
        }
        break;
      }
      case 'draftRect': {
        const dr = state.draft;
        let q = snapPoint(wp, e);
        if (e.shiftKey) {
          const side = Math.max(Math.abs(q.x - dr.start.x), Math.abs(q.y - dr.start.y));
          q = {
            x: dr.start.x + Math.sign(q.x - dr.start.x || 1) * side,
            y: dr.start.y + Math.sign(q.y - dr.start.y || 1) * side,
          };
        }
        dr.rect = G.normRect(dr.start.x, dr.start.y, q.x, q.y);
        break;
      }
      case 'marquee': {
        state.marquee = G.normRect(d.startWorld.x, d.startWorld.y, wp.x, wp.y);
        break;
      }
      case 'measure': {
        state.measure.b = e.shiftKey ? G.constrain45(state.measure.a, wp) : snapPoint(wp, e);
        break;
      }
    }
    app.invalidate();
    app.refreshStatus();
  }

  function updateDraftCursor(e, wp) {
    const d = state.draft;
    if (d.kind === 'wall') {
      const last = d.points[d.points.length - 1];
      d.cursor = e.shiftKey ? snapPoint(G.constrain45(last, wp), e) : snapPoint(wp, e);
    } else {
      const host = M.hostAt(state.doc, wp, tolWorld(4));
      d.cursor = host ? G.rectCenter(host) : snapPoint(wp, e);
      state.hover = host ? host.id : null;
    }
    app.invalidate();
  }

  function moveDrag(d, wp, sp, e) {
    /* Wait for a real drag before touching the document. */
    if (!d.moved && d.startScreen && G.dist(sp.x, sp.y, d.startScreen.x, d.startScreen.y) < CLICK_SLOP) return;
    d.moved = true;

    let dx = wp.x - d.startWorld.x;
    let dy = wp.y - d.startWorld.y;

    /* Snap using the first item's origin so the whole group stays coherent. */
    const anchor = d.origins[0].snap;
    if (state.snap && !e.altKey) {
      if (anchor.type === 'wall') {
        const p0 = anchor.points[0];
        dx = snapVal(p0.x + dx, e) - p0.x;
        dy = snapVal(p0.y + dy, e) - p0.y;
      } else if (anchor.type === 'route') {
        const p0 = anchor.waypoints[0] || (anchor.from.item ? null : anchor.from);
        if (p0) { dx = snapVal(p0.x + dx, e) - p0.x; dy = snapVal(p0.y + dy, e) - p0.y; }
      } else {
        dx = snapVal(anchor.x + dx, e) - anchor.x;
        dy = snapVal(anchor.y + dy, e) - anchor.y;
      }
    }

    if (d.box && !e.altKey) {
      const ids = new Set(d.origins.map((o) => o.id));
      const g = applyGuides(d.box, dx, dy, ids);
      dx = g.dx; dy = g.dy;
    } else {
      state.guides = [];
    }

    for (const o of d.origins) {
      const it = M.byId(state.doc, o.id);
      if (!it) continue;
      const fresh = M.clone(o.snap);
      M.move(fresh, dx, dy);
      Object.assign(it, fresh);
    }
  }

  function resizeDrag(d, wp, e) {
    const it = M.byId(state.doc, d.id);
    if (!it) return;
    const o = d.orig;
    const min = 0.2;
    const [hx, hy] = d.dir;

    let target = wp;
    if (!o.rot && state.snap && !e.altKey) target = snapPoint(wp, e);

    const lp = G.toLocal(target, o);
    let cxLocal = 0, cyLocal = 0;
    let w = o.w, h = o.h;

    if (hx !== 0) {
      const fixed = -hx * o.w / 2;
      let nw = Math.abs(lp.x - fixed);
      if (o.rot && state.snap && !e.altKey) nw = G.snap(nw, state.doc.grid);
      w = Math.max(min, nw);
      cxLocal = fixed + hx * w / 2;
    }
    if (hy !== 0) {
      const fixed = -hy * o.h / 2;
      let nh = Math.abs(lp.y - fixed);
      if (o.rot && state.snap && !e.altKey) nh = G.snap(nh, state.doc.grid);
      h = Math.max(min, nh);
      cyLocal = fixed + hy * h / 2;
    }

    if (e.shiftKey && hx !== 0 && hy !== 0) {
      const ratio = o.w / o.h;
      if (w / h > ratio) { w = h * ratio; cxLocal = -hx * o.w / 2 + hx * w / 2; }
      else { h = w / ratio; cyLocal = -hy * o.h / 2 + hy * h / 2; }
    }

    const centerWorld = G.fromLocal({ x: cxLocal, y: cyLocal }, o);
    it.w = w;
    it.h = h;
    it.x = centerWorld.x - w / 2;
    it.y = centerWorld.y - h / 2;
  }

  function rotateDrag(d, wp, e) {
    const it = M.byId(state.doc, d.id);
    if (!it) return;
    const a = Math.atan2(wp.y - d.center.y, wp.x - d.center.x);
    let deg = (d.orig.rot || 0) + G.deg(a - d.startAngle);
    if (!e.altKey) deg = Math.round(deg / 15) * 15;
    it.rot = ((deg % 360) + 360) % 360;
  }

  function updateCursor(sp, hit) {
    let cursor = 'default';
    if (state.selection.size === 1) {
      const it = M.byId(state.doc, [...state.selection][0]);
      const h = it && handleAt(it, sp);
      if (h) {
        if (h.kind === 'rotate') cursor = 'grab';
        else if (h.kind === 'resize') {
          const map = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
          cursor = map[h.name] || 'default';
        } else cursor = 'move';
      }
    }
    if (cursor === 'default' && hit) cursor = 'move';
    canvas.style.cursor = cursor;
  }

  /* ---------- pointer up ---------- */

  function onUp(e) {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    state.guides = [];
    if (canvas.hasPointerCapture && e.pointerId !== undefined) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    }
    canvas.style.cursor = state.tool === 'pan' ? 'grab' : 'default';

    switch (d.type) {
      case 'move':
        if (d.moved) app.commit();
        break;
      case 'resize':
      case 'rotate':
      case 'vertex':
      case 'waypoint':
      case 'endpoint':
        app.commit();
        break;
      case 'marquee': {
        const box = state.marquee;
        state.marquee = null;
        if (box && (box.w > 0.05 || box.h > 0.05)) {
          const picked = new Set(d.keep);
          for (const it of state.doc.items) {
            const b = M.bounds(state.doc, it);
            if (b && G.aabbOverlap(b, box)) picked.add(it.id);
          }
          setSelection([...picked]);
        }
        break;
      }
      case 'draftRect':
        finishRect(e);
        break;
      case 'measure':
        if (!state.measure || !state.measure.b) state.measure = null;
        break;
      case 'wallPress': {
        const dr = state.draft;
        if (dr && dr.kind === 'wall' && dr.points.length === 1 && dragged(d, e) && dr.cursor) {
          dr.points.push(dr.cursor);
          finishWall();
        }
        break;
      }
      case 'routePress': {
        const dr = state.draft;
        if (dr && dr.kind === 'route' && dragged(d, e)) {
          const host = M.hostAt(state.doc, worldPos(e), tolWorld(4));
          if (host && host.id !== (dr.from.item || null)) finishRoute(M.endpointOn(host.id));
        }
        break;
      }
    }
    app.invalidate();
    app.refresh();
  }

  /* Did the pointer travel far enough to count as a drag rather than a click? */
  function dragged(d, e) {
    if (!d.startScreen) return false;
    const sp = screenPos(e);
    return G.dist(sp.x, sp.y, d.startScreen.x, d.startScreen.y) > CLICK_SLOP;
  }

  function finishRect(e) {
    const d = state.draft;
    state.draft = null;
    if (!d || !d.rect) return;
    let { x, y, w, h } = d.rect;

    if (d.mode === 'machine') {
      const k = M.KINDS[state.activeKind] || M.KINDS.cnc;
      if (w < 0.3 || h < 0.3) { w = k.w; h = k.h; x = d.start.x - w / 2; y = d.start.y - h / 2; }
      const m = M.machine(state.activeKind, x, y, w, h);
      m.label = nextName(k.name);
      state.doc.items.push(m);
      setSelection([m.id]);
    } else if (d.mode === 'zone') {
      if (w < 0.5 || h < 0.5) { w = 8; h = 6; x = d.start.x; y = d.start.y; }
      const z = M.zone(x, y, w, h, nextName('Zone'));
      z.color = M.ZONE_COLORS[state.doc.items.filter((i) => i.type === 'zone').length % M.ZONE_COLORS.length];
      state.doc.items.unshift(z);      /* zones sit at the back */
      setSelection([z.id]);
    } else if (d.mode === 'room') {
      if (w < 0.5 || h < 0.5) { w = 12; h = 9; x = d.start.x; y = d.start.y; }
      const wall = M.wall([
        { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
      ], state.wallThickness);
      wall.closed = true;
      state.doc.items.push(wall);
      setSelection([wall.id]);
    }
    app.commit();
    if (!state.stickyTool) app.setTool('select');
  }

  /* Auto-numbered names: "CNC Machine", "CNC Machine 2", ... */
  function nextName(base) {
    const used = state.doc.items.filter((it) =>
      (it.label || '').replace(/\s+\d+$/, '') === base).length;
    return used === 0 ? base : base + ' ' + (used + 1);
  }
  T.nextName = nextName;

  /* ---------- finishing multi-click drafts ---------- */

  function finishWall() {
    const d = state.draft;
    state.draft = null;
    app.setHint('');
    if (!d || d.points.length < 2) { app.invalidate(); return; }
    const wall = M.wall(d.points, state.wallThickness);
    state.doc.items.push(wall);
    setSelection([wall.id]);
    app.commit();
    app.invalidate();
    if (!state.stickyTool) app.setTool('select');
  }

  function finishRoute(toEnd) {
    const d = state.draft;
    state.draft = null;
    app.setHint('');
    if (!d) return;
    const r = M.route(d.from, toEnd, d.waypoints);
    r.color = state.routeColor;
    state.doc.items.push(r);
    setSelection([r.id]);
    app.commit();
    app.invalidate();
    if (!state.stickyTool) app.setTool('select');
  }

  function cancelDraft() {
    state.draft = null;
    state.measure = null;
    app.setHint('');
    app.invalidate();
  }

  T.finishWall = finishWall;
  T.cancelDraft = cancelDraft;

  /* End an open draft the way Enter would. */
  T.commitDraft = () => {
    if (!state.draft) return false;
    if (state.draft.kind === 'wall') { finishWall(); return true; }
    if (state.draft.kind === 'route') {
      const d = state.draft;
      if (d.waypoints.length) {
        const last = d.waypoints[d.waypoints.length - 1];
        d.waypoints = d.waypoints.slice(0, -1);
        finishRoute(M.endpointAt(last.x, last.y));
      } else {
        cancelDraft();
      }
      return true;
    }
    return false;
  };

  /* ---------- other events ---------- */

  function onDblClick(e) {
    const wp = worldPos(e);
    if (state.draft && state.draft.kind === 'wall') { finishWall(); return; }

    const hit = M.hitTest(state.doc, wp, tolWorld(5));
    if (!hit) return;

    if (hit.type === 'machine' || hit.type === 'zone' || hit.type === 'label') {
      setSelection([hit.id]);
      app.editLabel(hit);
      return;
    }
    if (hit.type === 'route') {
      /* Add a bend where the user double-clicked. */
      const pts = M.routePath(state.doc, hit);
      let bestIdx = 0, best = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = G.distToSegment(wp, pts[i], pts[i + 1]);
        if (d < best) { best = d; bestIdx = i; }
      }
      const before = countWaypointsBefore(hit, pts, bestIdx);
      hit.waypoints.splice(before, 0, snapPoint(wp, e));
      setSelection([hit.id]);
      app.commit();
      return;
    }
    if (hit.type === 'wall') {
      let bestIdx = 0, best = Infinity;
      for (let i = 0; i < hit.points.length - 1; i++) {
        const d = G.distToSegment(wp, hit.points[i], hit.points[i + 1]);
        if (d < best) { best = d; bestIdx = i; }
      }
      hit.points.splice(bestIdx + 1, 0, snapPoint(wp, e));
      setSelection([hit.id]);
      app.commit();
    }
  }

  /* Map a rendered-path segment index back to a waypoint insertion index. */
  function countWaypointsBefore(route, pts, segIdx) {
    if (!route.waypoints.length) return 0;
    const target = pts[segIdx];
    let count = 0;
    for (const w of route.waypoints) {
      const idx = pts.findIndex((p) => Math.abs(p.x - w.x) < 1e-6 && Math.abs(p.y - w.y) < 1e-6);
      if (idx !== -1 && idx <= pts.indexOf(target)) count++;
    }
    return Math.min(count, route.waypoints.length);
  }

  function onWheel(e) {
    e.preventDefault();
    const sp = screenPos(e);
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      const before = R.toWorld(state.cam, sp.x, sp.y);
      const factor = Math.exp(-e.deltaY * 0.0015);
      state.cam.zoom = G.clamp(state.cam.zoom * factor, 2, 400);
      const after = R.toWorld(state.cam, sp.x, sp.y);
      state.cam.x += before.x - after.x;
      state.cam.y += before.y - after.y;
    } else {
      state.cam.x += e.deltaX / state.cam.zoom;
      state.cam.y += e.deltaY / state.cam.zoom;
    }
    app.invalidate();
    app.refreshStatus();
  }

  function onContextMenu(e) { e.preventDefault(); }

  FB.tools = T;
})(window.FB);
