/* Application shell: state, actions, keyboard, persistence, bootstrap. */
(function (FB) {
  'use strict';

  const G = FB.geom;
  const M = FB.model;
  const R = FB.render;
  const H = FB.history;

  const STORAGE_KEY = 'factory-layout-builder/v1';

  const state = {
    doc: M.newDoc(),
    cam: { x: -4, y: -4, zoom: 26 },
    tool: 'select',
    activeType: null,
    selection: new Set(),
    hover: null,
    drag: null,
    draft: null,
    marquee: null,
    measure: null,
    guides: [],
    cursorWorld: null,
    snap: true,
    snapGuides: true,
    showGrid: true,
    showLabels: true,
    showSpecs: false,
    showTimes: false,
    showRun: false,
    focusMode: false,
    play: { running: false, t: 0, path: null, duration: 0, at: null },
    stickyTool: false,
    spaceDown: false,
    wallThickness: 0.25,
    routeColor: '#f97316',
    clipboard: null,
  };

  const app = {};
  let canvas, wrap, dirty = true, saveTimer = null;

  /* ---------- render loop ---------- */

  app.invalidate = () => { dirty = true; };

  let lastFrame = 0;

  function frame(now) {
    const t = now || 0;
    const dt = lastFrame ? Math.min(0.25, (t - lastFrame) / 1000) : 0;
    lastFrame = t;

    const play = state.play;
    if (play.running && play.duration > 0) {
      play.t += dt;
      if (play.t >= play.duration) {
        if (M.anim(state.doc).loop) play.t = play.t % play.duration;
        else { play.t = play.duration; app.pauseRun(); }
      }
      updateRunReadout();
      dirty = true;
    }

    if (dirty) {
      dirty = false;
      R.draw(state);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- committing changes ---------- */

  app.commit = () => {
    H.commit(state.doc);
    app.rebuildRun();
    app.invalidate();
    FB.ui.refreshProps();
    FB.ui.refreshStats();
    scheduleSave();
  };

  app.refresh = () => {
    FB.ui.refreshProps();
    FB.ui.refreshStats();
    FB.ui.refreshProcess();
    FB.ui.refreshSpecs();
    FB.ui.refreshZones();
    FB.ui.refreshLayers();
    FB.ui.refreshStops();
    app.refreshStatus();
    app.invalidate();
  };

  app.refreshStatus = () => {
    const c = state.cursorWorld;
    document.getElementById('statCoords').textContent =
      c ? R.fmt(c.x) + ', ' + R.fmt(c.y) + ' m' : '—';
    document.getElementById('statTool').textContent = TOOL_NAMES[state.tool] || state.tool;

    const n = state.selection.size;
    let text = 'Nothing selected';
    if (n === 1) {
      const it = M.byId(state.doc, [...state.selection][0]);
      if (it) {
        text = describe(it);
      }
    } else if (n > 1) {
      text = n + ' items selected';
    }
    document.getElementById('statSel').textContent = text;
    document.getElementById('btnZoomReset').textContent = Math.round(state.cam.zoom / 0.26) + '%';
    document.getElementById('btnUndo').disabled = !H.canUndo();
    document.getElementById('btnRedo').disabled = !H.canRedo();
  };

  function describe(it) {
    switch (it.type) {
      case 'machine': return it.label + ' · ' + R.fmt(it.w) + ' × ' + R.fmt(it.h) + ' m';
      case 'zone': return 'Zone “' + it.label + '” · ' + R.fmt(it.w * it.h) + ' m²';
      case 'wall': return 'Wall · ' + it.points.length + ' points';
      case 'route': return 'Route · ' + R.fmt(M.routeLength(state.doc, it)) + ' m';
      case 'label': return 'Text “' + it.text + '”';
      default: return it.type;
    }
  }

  const TOOL_NAMES = {
    select: 'Select', machine: 'Machine', wall: 'Wall', room: 'Room',
    route: 'Route', zone: 'Zone', text: 'Text', measure: 'Measure', pan: 'Pan',
  };

  app.setHint = (text) => { document.getElementById('statHint').textContent = text || ''; };

  let toastTimer = null;
  app.toast = (msg) => {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
  };

  /* ---------- tools ---------- */

  app.setTool = (tool) => {
    if (state.draft) FB.tools.cancelDraft();
    state.tool = tool;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    canvas.style.cursor = tool === 'pan' ? 'grab' : 'default';
    const hints = {
      machine: (() => {
        const t = M.typeById(state.doc, state.activeType);
        return t ? 'Drag a box to place a ' + t.name
                 : 'Drag a box for an untyped machine — or define a type in the palette first';
      })(),
      wall: 'Click each corner · Enter or double-click to finish',
      room: 'Drag out a rectangular room of walls',
      route: 'Click the source machine, then the destination',
      zone: 'Drag out an area to name it',
      text: 'Click to drop a text label',
      measure: 'Drag to measure a distance',
    };
    app.setHint(hints[tool] || '');
    app.refreshStatus();
    app.invalidate();
  };

  /* ---------- selection actions ---------- */

  app.selectAll = () => {
    state.selection = new Set(state.doc.items.filter(M.pickable).map((it) => it.id));
    app.refresh();
  };

  app.deleteSelection = () => {
    if (!state.selection.size) return;
    const ids = new Set(state.selection);
    /* Routes lose their anchor when a machine goes, so they go too. */
    for (const id of [...ids]) {
      for (const r of M.routesFor(state.doc, id)) ids.add(r.id);
    }
    state.doc.items = state.doc.items.filter((it) => !ids.has(it.id));
    for (const st of (state.doc.process || [])) if (st.link && ids.has(st.link)) st.link = null;
    state.selection.clear();
    app.commit();
    app.refresh();
    app.toast('Deleted ' + ids.size + ' item' + (ids.size === 1 ? '' : 's'));
  };

  app.duplicate = (dx, dy) => {
    if (!state.selection.size) return;
    const copies = M.copyGroup(state.doc, [...state.selection]);
    if (!copies.length) return;
    const ox = dx === undefined ? state.doc.grid : dx;
    const oy = dy === undefined ? state.doc.grid : dy;
    copies.forEach((c) => M.move(c, ox, oy));
    state.doc.items.push(...copies);
    state.selection = new Set(copies.map((c) => c.id));
    app.commit();
    app.refresh();
  };

  app.copy = () => {
    if (!state.selection.size) return;
    state.clipboard = M.copyGroup(state.doc, [...state.selection]);
    app.toast('Copied ' + state.clipboard.length + ' item' + (state.clipboard.length === 1 ? '' : 's'));
  };

  app.paste = () => {
    if (!state.clipboard || !state.clipboard.length) return;
    /* Re-key so repeated pastes stay distinct. */
    const temp = { items: state.clipboard };
    const copies = M.copyGroup(temp, state.clipboard.map((c) => c.id));
    const target = state.cursorWorld;
    if (target) {
      const b = G.unionAABB(copies.map((c) => M.bounds(state.doc, c)));
      if (b) {
        const dx = G.snap(target.x - (b.x + b.w / 2), state.doc.grid);
        const dy = G.snap(target.y - (b.y + b.h / 2), state.doc.grid);
        copies.forEach((c) => M.move(c, dx, dy));
      }
    } else {
      copies.forEach((c) => M.move(c, state.doc.grid, state.doc.grid));
    }
    state.doc.items.push(...copies);
    state.selection = new Set(copies.map((c) => c.id));
    app.commit();
    app.refresh();
  };

  app.reorder = (dir) => {
    const ids = new Set(state.selection);
    if (!ids.size) return;
    const items = state.doc.items;
    if (dir > 0) {
      for (let i = items.length - 2; i >= 0; i--) {
        if (ids.has(items[i].id) && !ids.has(items[i + 1].id)) {
          [items[i], items[i + 1]] = [items[i + 1], items[i]];
        }
      }
    } else {
      for (let i = 1; i < items.length; i++) {
        if (ids.has(items[i].id) && !ids.has(items[i - 1].id)) {
          [items[i], items[i - 1]] = [items[i - 1], items[i]];
        }
      }
    }
    app.commit();
  };

  app.nudge = (dx, dy) => {
    if (!state.selection.size) return;
    for (const id of state.selection) {
      const it = M.byId(state.doc, id);
      if (it) M.move(it, dx, dy);
    }
    app.invalidate();
    FB.ui.refreshProps();
  };

  /* ---------- align / distribute / chain ---------- */

  function alignables() {
    return state.doc.items.filter((it) => state.selection.has(it.id) && M.bounds(state.doc, it));
  }

  app.align = (mode) => {
    const items = alignables();
    if (items.length < 2) return;
    const boxes = items.map((it) => ({ it, b: M.bounds(state.doc, it) }));
    const outer = G.unionAABB(boxes.map((x) => x.b));
    for (const { it, b } of boxes) {
      let dx = 0, dy = 0;
      switch (mode) {
        case 'left':   dx = outer.x - b.x; break;
        case 'right':  dx = (outer.x + outer.w) - (b.x + b.w); break;
        case 'hcent':  dx = (outer.x + outer.w / 2) - (b.x + b.w / 2); break;
        case 'top':    dy = outer.y - b.y; break;
        case 'bottom': dy = (outer.y + outer.h) - (b.y + b.h); break;
        case 'vcent':  dy = (outer.y + outer.h / 2) - (b.y + b.h / 2); break;
      }
      M.move(it, dx, dy);
    }
    app.commit();
  };

  app.distribute = (axis) => {
    const items = alignables();
    if (items.length < 3) { app.toast('Select at least three items'); return; }
    const boxes = items.map((it) => ({ it, b: M.bounds(state.doc, it) }));
    boxes.sort((p, q) => (axis === 'x' ? p.b.x - q.b.x : p.b.y - q.b.y));

    const first = boxes[0].b, last = boxes[boxes.length - 1].b;
    const span = axis === 'x'
      ? (last.x + last.w) - first.x
      : (last.y + last.h) - first.y;
    const used = boxes.reduce((sum, x) => sum + (axis === 'x' ? x.b.w : x.b.h), 0);
    const gap = (span - used) / (boxes.length - 1);

    let cursor = axis === 'x' ? first.x : first.y;
    for (const { it, b } of boxes) {
      if (axis === 'x') { M.move(it, cursor - b.x, 0); cursor += b.w + gap; }
      else { M.move(it, 0, cursor - b.y); cursor += b.h + gap; }
    }
    app.commit();
  };

  /* Wire the selected machines together, left-to-right / top-to-bottom. */
  app.chainSelection = () => {
    const machines = state.doc.items.filter((it) => it.type === 'machine' && state.selection.has(it.id));
    if (machines.length < 2) { app.toast('Select two or more machines'); return; }
    machines.sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const made = [];
    for (let i = 0; i < machines.length - 1; i++) {
      const r = M.route(M.endpointOn(machines[i].id), M.endpointOn(machines[i + 1].id));
      r.color = state.routeColor;
      made.push(r);
    }
    state.doc.items.push(...made);
    app.commit();
    app.toast('Added ' + made.length + ' route' + (made.length === 1 ? '' : 's'));
  };

  /* ---------- cascade ---------- */

  app.cascade = () => {
    const machines = state.doc.items.filter((it) => it.type === 'machine' && state.selection.has(it.id));
    if (!machines.length) { app.toast('Select at least one machine first'); return; }

    const count = G.clamp(parseInt(document.getElementById('cascCount').value, 10) || 1, 1, 200);
    const dir = document.getElementById('cascDir').value;
    const gap = parseFloat(document.getElementById('cascGap').value) || 0;
    const offset = parseFloat(document.getElementById('cascOffset').value) || 0;
    const connect = document.getElementById('cascConnect').checked;
    const doNumber = document.getElementById('cascNumber').checked;

    const created = [];
    for (const src of machines) {
      const bb = G.rectAABB(src);
      const stepX = dir === 'right' ? bb.w + gap : dir === 'left' ? -(bb.w + gap) : 0;
      const stepY = dir === 'down' ? bb.h + gap : dir === 'up' ? -(bb.h + gap) : 0;
      const perpX = stepX === 0 ? offset : 0;
      const perpY = stepY === 0 ? offset : 0;

      const base = (src.label || '').replace(/\s+\d+$/, '');
      if (doNumber) src.label = base + ' 1';

      const chain = [src];
      for (let i = 1; i <= count; i++) {
        const copy = M.clone(src);
        copy.id = M.uid();
        copy.x = src.x + stepX * i + perpX * i;
        copy.y = src.y + stepY * i + perpY * i;
        if (doNumber) copy.label = base + ' ' + (i + 1);
        state.doc.items.push(copy);
        created.push(copy);
        chain.push(copy);
      }

      if (connect) {
        for (let i = 0; i < chain.length - 1; i++) {
          const r = M.route(M.endpointOn(chain[i].id), M.endpointOn(chain[i + 1].id));
          r.color = state.routeColor;
          state.doc.items.push(r);
        }
      }
    }

    state.selection = new Set([...machines.map((m) => m.id), ...created.map((c) => c.id)]);
    app.commit();
    app.refresh();
    app.toast('Cascaded ' + created.length + ' machine' + (created.length === 1 ? '' : 's'));
  };

  /* ---------- layers ---------- */

  app.setLocked = (ids, locked) => {
    for (const id of ids) {
      const it = M.byId(state.doc, id);
      if (!it) continue;
      it.locked = locked;
      if (locked) state.selection.delete(id);
    }
    app.commit();
    app.refresh();
  };

  app.setHidden = (ids, hidden) => {
    for (const id of ids) {
      const it = M.byId(state.doc, id);
      if (!it) continue;
      it.hidden = hidden;
      if (hidden) state.selection.delete(id);
    }
    app.commit();
    app.refresh();
  };

  app.moveItem = (id, dir) => {
    const items = state.doc.items;
    const i = items.findIndex((it) => it.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    app.commit();
    app.refresh();
  };

  app.lockAll = (locked) => {
    for (const it of state.doc.items) it.locked = locked;
    if (locked) state.selection.clear();
    app.commit();
    app.refresh();
    app.toast(locked ? 'Every layer locked' : 'Every layer unlocked');
  };

  app.showAll = () => {
    let n = 0;
    for (const it of state.doc.items) if (it.hidden) { it.hidden = false; n++; }
    app.commit();
    app.refresh();
    app.toast(n ? n + ' layer' + (n === 1 ? '' : 's') + ' shown again' : 'Nothing was hidden');
  };

  /* ---------- animated run ---------- */

  app.rebuildRun = () => {
    const play = state.play;
    play.path = M.animPath(state.doc);
    play.duration = M.animDuration(state.doc, play.path);
    if (play.t > play.duration) play.t = 0;
    updateRunReadout();
  };

  function updateRunReadout() {
    const play = state.play;
    play.at = play.path && play.path.stops.length ? M.animAt(state.doc, play.path, play.t) : null;

    const time = document.getElementById('runTime');
    if (time) {
      time.textContent = play.duration > 0
        ? R.fmt(play.t) + ' / ' + R.fmt(play.duration) + ' s'
        : (play.path && play.path.stops.length ? 'no travel time' : 'no run yet');
    }
    const scrub = document.getElementById('runScrub');
    if (scrub && document.activeElement !== scrub) {
      scrub.value = play.duration > 0 ? Math.round((play.t / play.duration) * 1000) : 0;
    }
    if (play.at) FB.ui.markCurrentStop(play.at.stop ? play.at.index : -1);
  }

  app.playRun = () => {
    const play = state.play;
    if (!play.path || !play.path.stops.length) { app.toast('Add some stops to the run first'); return; }
    if (play.duration <= 0) { app.toast('Give the stops some work time, or space them out'); return; }
    play.running = true;
    setPlayButton();
    app.invalidate();
  };

  app.pauseRun = () => {
    state.play.running = false;
    setPlayButton();
    app.invalidate();
  };

  app.toggleRun = () => (state.play.running ? app.pauseRun() : app.playRun());

  app.restartRun = () => {
    state.play.t = 0;
    updateRunReadout();
    app.invalidate();
  };

  function setPlayButton() {
    const b = document.getElementById('btnPlay');
    if (b) b.textContent = state.play.running ? '❚❚ Pause' : '▶ Play';
  }

  app.buildRun = () => {
    const order = M.buildRunFromRoutes(state.doc);
    if (!order.length) { app.toast('No routes to follow — draw some first'); return; }
    const anim = M.anim(state.doc);
    anim.stops = order.map((id) => {
      const existing = anim.stops.find((st) => st.item === id);
      return M.stop(id, existing ? existing.dwell : 1);
    });
    state.play.t = 0;
    app.commit();
    app.refresh();
    app.toast('Run built from ' + order.length + ' stops');
  };

  app.addStop = () => {
    const anim = M.anim(state.doc);
    const picked = state.doc.items.filter((it) => state.selection.has(it.id) && (it.type === 'machine' || it.type === 'zone'));
    if (!picked.length) { app.toast('Select a machine or zone first'); return; }
    for (const it of picked) anim.stops.push(M.stop(it.id, 1));
    app.commit();
    app.refresh();
  };

  app.removeStop = (i) => {
    const anim = M.anim(state.doc);
    anim.stops.splice(i, 1);
    state.play.t = 0;
    app.commit();
    app.refresh();
  };

  app.moveStop = (i, dir) => {
    const anim = M.anim(state.doc);
    const j = i + dir;
    if (j < 0 || j >= anim.stops.length) return;
    [anim.stops[i], anim.stops[j]] = [anim.stops[j], anim.stops[i]];
    app.commit();
    app.refresh();
  };

  /* ---------- machine types ---------- */

  let editingType = null;

  app.openTypeEditor = (typeId) => {
    const t = M.typeById(state.doc, typeId);
    editingType = t ? t.id : null;

    document.getElementById('typeModalTitle').textContent = t ? 'Edit machine type' : 'New machine type';
    document.getElementById('typeName').value = t ? t.name : '';
    document.getElementById('typeW').value = t ? R.fmt(t.w) : '3';
    document.getElementById('typeH').value = t ? R.fmt(t.h) : '2';
    document.getElementById('typeColor').value = t ? t.color : M.nextTypeColor(state.doc);

    const used = t ? M.machinesOfType(state.doc, t.id).length : 0;
    const applyRow = document.getElementById('typeApplyRow');
    applyRow.classList.toggle('hidden', used === 0);
    document.getElementById('typeUseCount').textContent = String(used);
    document.getElementById('typeApply').checked = false;
    document.getElementById('btnTypeDelete').classList.toggle('hidden', !t);
    document.getElementById('typeNote').textContent = t && used
      ? 'Deleting this type leaves those ' + used + ' machines exactly as they are — they just stop being typed.'
      : 'Types are saved inside the layout, so a file always carries the machines it was drawn with.';

    document.getElementById('typeModal').classList.remove('hidden');
    const name = document.getElementById('typeName');
    setTimeout(() => { name.focus(); name.select(); }, 0);
  };

  app.closeTypeEditor = () => {
    document.getElementById('typeModal').classList.add('hidden');
    editingType = null;
  };

  app.saveType = () => {
    const name = document.getElementById('typeName').value.trim();
    const w = Math.max(0.2, parseFloat(document.getElementById('typeW').value) || 2);
    const h = Math.max(0.2, parseFloat(document.getElementById('typeH').value) || 2);
    const color = document.getElementById('typeColor').value;
    if (!name) { app.toast('Give the type a name'); document.getElementById('typeName').focus(); return; }

    const existing = M.typeById(state.doc, editingType);
    if (existing) {
      existing.name = name;
      existing.w = w;
      existing.h = h;
      existing.color = color;
      if (document.getElementById('typeApply').checked) {
        for (const m of M.machinesOfType(state.doc, existing.id)) {
          m.color = color;
          m.w = w;
          m.h = h;
        }
      }
      app.toast('Type updated');
    } else {
      const t = M.type(name, w, h, color);
      M.types(state.doc).push(t);
      state.activeType = t.id;
      app.toast('“' + name + '” added — pick it and drag a box');
    }

    app.closeTypeEditor();
    app.commit();
    FB.ui.buildPalette();
    app.refresh();
  };

  app.deleteType = () => {
    const t = M.typeById(state.doc, editingType);
    if (!t) return;
    const used = M.machinesOfType(state.doc, t.id);
    state.doc.types = M.types(state.doc).filter((x) => x.id !== t.id);
    /* The machines keep their own size, colour and name — only the link goes. */
    for (const m of used) m.kind = null;
    if (state.activeType === t.id) state.activeType = null;
    app.closeTypeEditor();
    app.commit();
    FB.ui.buildPalette();
    app.refresh();
    app.toast(used.length ? 'Type removed — ' + used.length + ' machines kept as they are' : 'Type removed');
  };

  /* Turn a box already on the floor into a reusable type. */
  app.saveMachineAsType = (m) => {
    const t = M.type(m.label || 'Machine', m.w, m.h, m.color);
    M.types(state.doc).push(t);
    m.kind = t.id;
    state.activeType = t.id;
    app.commit();
    FB.ui.buildPalette();
    app.refresh();
    app.toast('Saved “' + t.name + '” as a type');
  };

  /* ---------- process steps ---------- */

  function steps() {
    if (!Array.isArray(state.doc.process)) state.doc.process = [];
    return state.doc.process;
  }

  app.addStep = (fromSelection) => {
    const list = steps();
    const step = M.step();
    if (fromSelection && state.selection.size === 1) {
      const it = M.byId(state.doc, [...state.selection][0]);
      if (it) {
        step.link = it.id;
        step.title = it.label || it.text || '';
      }
    }
    list.push(step);
    app.commit();
    showPane('process');
    FB.ui.refreshProcess();
    FB.ui.focusStep(list.length - 1);
  };

  app.removeStep = (i) => {
    const list = steps();
    if (i < 0 || i >= list.length) return;
    list.splice(i, 1);
    app.commit();
    FB.ui.refreshProcess();
  };

  app.duplicateStep = (i) => {
    const list = steps();
    const src = list[i];
    if (!src) return;
    const copy = M.step(src.title, src.details, src.link);
    list.splice(i + 1, 0, copy);
    app.commit();
    FB.ui.refreshProcess();
    FB.ui.focusStep(i + 1);
  };

  app.moveStep = (i, dir) => {
    const list = steps();
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    app.commit();
    FB.ui.refreshProcess();
  };

  app.linkStep = (i, itemId) => {
    const st = steps()[i];
    if (!st) return;
    st.link = itemId;
    app.commit();
    FB.ui.refreshProcess();
  };

  /* Select an item and bring it into view without changing zoom. */
  app.focusItem = (id) => {
    const it = M.byId(state.doc, id);
    if (!it) return;
    const b = M.bounds(state.doc, it);
    state.selection = new Set([id]);
    if (b) {
      state.cam.x = b.x + b.w / 2 - R.width / 2 / state.cam.zoom;
      state.cam.y = b.y + b.h / 2 - (R.height - 26) / 2 / state.cam.zoom;
    }
    app.refresh();
  };

  app.exportSteps = () => {
    const list = steps();
    if (!list.length) { app.toast('No steps written yet'); return; }
    const lines = ['# ' + (state.doc.name || 'Factory layout') + ' — process', ''];
    list.forEach((st, i) => {
      const host = st.link ? M.byId(state.doc, st.link) : null;
      const where = host ? '  \n*At: ' + (host.label || host.text || host.type) + '*' : '';
      lines.push('## ' + (i + 1) + '. ' + (st.title || 'Untitled step') + where);
      lines.push('');
      if (st.details.trim()) { lines.push(st.details.trim()); lines.push(''); }
    });
    download(new Blob([lines.join('\n')], { type: 'text/markdown' }), slug(state.doc.name) + '-process.md');
    app.toast('Process exported');
  };

  const PANES = ['design', 'process', 'layers', 'play'];

  function showPane(name) {
    document.querySelectorAll('#sideTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
    for (const p of PANES) {
      const node = document.getElementById('pane' + p[0].toUpperCase() + p.slice(1));
      if (node) node.classList.toggle('hidden', p !== name);
    }
    /* Seeing the run's shape only matters while you are editing it. */
    state.showRun = name === 'play';
    if (state.focusMode) app.setFocusMode(false);
    app.invalidate();
  }
  app.showPane = showPane;

  app.openFold = (name) => {
    const fold = document.querySelector('.fold[data-fold="' + name + '"]');
    if (fold) fold.classList.add('open');
  };

  /* Resizing the canvas would otherwise slide the drawing sideways, so pin
     whatever is in the middle of the view. */
  function keepingCentre(fn) {
    const before = R.toWorld(state.cam, R.width / 2, R.height / 2);
    fn();
    setTimeout(() => {
      R.resize();
      const after = R.toWorld(state.cam, R.width / 2, R.height / 2);
      state.cam.x += before.x - after.x;
      state.cam.y += before.y - after.y;
      app.invalidate();
    }, 0);
  }
  app.keepingCentre = keepingCentre;

  app.setFocusMode = (on) => {
    keepingCentre(() => {
      state.focusMode = on;
      document.body.classList.toggle('focus', on);
      const btn = document.getElementById('btnFocus');
      if (btn) btn.classList.toggle('on', on);
    });
  };

  app.toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => app.toast('Full screen was blocked by the browser'));
    }
  };

  /* ---------- view ---------- */

  app.zoomBy = (factor, centerScreen) => {
    const c = centerScreen || { x: R.width / 2, y: R.height / 2 };
    const before = R.toWorld(state.cam, c.x, c.y);
    state.cam.zoom = G.clamp(state.cam.zoom * factor, 2, 400);
    const after = R.toWorld(state.cam, c.x, c.y);
    state.cam.x += before.x - after.x;
    state.cam.y += before.y - after.y;
    app.invalidate();
    app.refreshStatus();
  };

  app.zoomFit = () => {
    const b = M.docBounds(state.doc);
    if (!b || b.w === 0 && b.h === 0) {
      state.cam = { x: -4, y: -4, zoom: 26 };
    } else {
      const pad = 2;
      const zx = R.width / (b.w + pad * 2);
      const zy = (R.height - 26) / (b.h + pad * 2);
      state.cam.zoom = G.clamp(Math.min(zx, zy), 2, 200);
      state.cam.x = b.x + b.w / 2 - R.width / 2 / state.cam.zoom;
      state.cam.y = b.y + b.h / 2 - (R.height - 26) / 2 / state.cam.zoom;
    }
    app.invalidate();
    app.refreshStatus();
  };

  /* ---------- inline label editing ---------- */

  let editing = null;

  app.editLabel = (item) => {
    const inp = document.getElementById('inlineEditor');
    const text = item.type === 'label' ? item.text : item.label;
    const anchor = item.type === 'label'
      ? { x: item.x, y: item.y }
      : { x: item.x + item.w / 2, y: item.type === 'zone' ? item.y + 0.6 : item.y + item.h / 2 };
    const s = R.toScreen(state.cam, anchor.x, anchor.y);

    inp.value = text;
    inp.classList.remove('hidden');
    inp.style.left = Math.round(s.x - 70) + 'px';
    inp.style.top = Math.round(s.y - 13) + 'px';
    inp.style.width = '140px';
    editing = item.id;
    /* Focus after the browser has finished its own focus handling for the
       click that opened us, otherwise the editor is blurred immediately. */
    setTimeout(() => {
      if (editing !== item.id) return;
      inp.focus();
      inp.select();
    }, 0);
  };

  app.closeInlineEdit = (apply) => {
    const inp = document.getElementById('inlineEditor');
    if (!editing) return;
    const item = M.byId(state.doc, editing);
    editing = null;
    if (item && apply !== false) {
      const v = inp.value.trim();
      if (v) {
        if (item.type === 'label') item.text = v; else item.label = v;
        app.commit();
      }
    }
    inp.classList.add('hidden');
    inp.blur();
    app.invalidate();
  };

  /* ---------- persistence ---------- */

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, M.serialize(state.doc));
      } catch (err) {
        /* Quota or private mode — the file export is still available. */
      }
    }, 400);
  }

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return M.deserialize(raw);
    } catch (err) {
      return null;
    }
  }

  function setDoc(doc, message) {
    state.doc = doc;
    state.selection.clear();
    state.hover = null;
    state.draft = null;
    state.measure = null;
    document.getElementById('docName').value = doc.name;
    if (!Array.isArray(state.doc.process)) state.doc.process = [];
    if (!M.typeById(doc, state.activeType)) state.activeType = null;
    FB.ui.buildPalette();
    syncRunControls();
    state.play.running = false;
    state.play.t = 0;
    app.rebuildRun();
    setPlayButton();
    H.reset(doc);
    app.zoomFit();
    app.refresh();
    scheduleSave();
    if (message) app.toast(message);
  }
  app.setDoc = setDoc;

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function slug(name) {
    return (name || 'factory-layout').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'factory-layout';
  }

  app.saveFile = () => {
    download(new Blob([M.serialize(state.doc)], { type: 'application/json' }), slug(state.doc.name) + '.factory.json');
    app.toast('Layout downloaded');
  };

  app.exportPNG = () => {
    const off = R.exportPNG(state, 40, 2);
    if (!off) { app.toast('Nothing to export yet'); return; }
    off.toBlob((blob) => {
      download(blob, slug(state.doc.name) + '.png');
      app.toast('PNG exported');
    });
  };

  app.openFile = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setDoc(M.deserialize(String(reader.result)), 'Loaded ' + file.name);
      } catch (err) {
        app.toast('Could not read that file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  /* ---------- keyboard ---------- */

  const TOOL_KEYS = { v: 'select', m: 'machine', w: 'wall', r: 'room', e: 'route', z: 'zone', t: 'text', k: 'measure', h: 'pan' };

  function onKeyDown(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

    if (typing) {
      if (e.target.id === 'inlineEditor') {
        if (e.key === 'Enter') { e.preventDefault(); app.closeInlineEdit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); app.closeInlineEdit(false); }
      } else if (e.key === 'Escape') {
        e.target.blur();
      }
      return;
    }

    const mod = e.ctrlKey || e.metaKey;

    if (mod) {
      switch (e.key.toLowerCase()) {
        case 'z':
          e.preventDefault();
          e.shiftKey ? app.redo() : app.undo();
          return;
        case 'y': e.preventDefault(); app.redo(); return;
        case 'a': e.preventDefault(); app.selectAll(); return;
        case 'c': e.preventDefault(); app.copy(); return;
        case 'v': e.preventDefault(); app.paste(); return;
        case 'd': e.preventDefault(); app.duplicate(); return;
        case 's': e.preventDefault(); app.saveFile(); return;
        default: return;
      }
    }

    if (e.key === ' ') {
      state.spaceDown = true;
      canvas.style.cursor = 'grab';
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      if (state.draft) FB.tools.cancelDraft();
      else if (state.measure) { state.measure = null; app.invalidate(); }
      else { state.selection.clear(); app.refresh(); }
      return;
    }

    if (e.key === 'Enter') {
      if (FB.tools.commitDraft()) { e.preventDefault(); return; }
      if (state.selection.size === 1) {
        const it = M.byId(state.doc, [...state.selection][0]);
        if (it && (it.type === 'machine' || it.type === 'zone' || it.type === 'label')) {
          e.preventDefault();
          app.editLabel(it);
        }
      }
      return;
    }

    if (e.key === 'F2' && state.selection.size === 1) {
      const it = M.byId(state.doc, [...state.selection][0]);
      if (it && (it.type === 'machine' || it.type === 'zone' || it.type === 'label')) {
        e.preventDefault();
        app.editLabel(it);
        return;
      }
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      app.deleteSelection();
      return;
    }

    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? state.doc.grid : state.doc.grid / 5;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      app.nudge(d[0], d[1]);
      nudgeCommit();
      return;
    }

    if (e.key === '\\') { e.preventDefault(); app.setFocusMode(!state.focusMode); return; }
    if (e.key === 'p' || e.key === 'P') { app.toggleRun(); return; }
    if (e.key === '[') { app.reorder(-1); return; }
    if (e.key === ']') { app.reorder(1); return; }
    if (e.key === '?') { toggleHelp(true); return; }
    if (e.key === 'f' || e.key === 'F') { app.zoomFit(); return; }
    if (e.key === '+' || e.key === '=') { app.zoomBy(1.2); return; }
    if (e.key === '-' || e.key === '_') { app.zoomBy(1 / 1.2); return; }

    const tool = TOOL_KEYS[e.key.toLowerCase()];
    if (tool) app.setTool(tool);
  }

  let nudgeTimer = null;
  function nudgeCommit() {
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => app.commit(), 350);
  }

  function onKeyUp(e) {
    if (e.key === ' ') {
      state.spaceDown = false;
      canvas.style.cursor = state.tool === 'pan' ? 'grab' : 'default';
    }
  }

  app.undo = () => {
    const doc = H.undo();
    if (!doc) return;
    state.doc = doc;
    pruneSelection();
    afterDocSwap();
    document.getElementById('docName').value = doc.name;
    app.refresh();
    scheduleSave();
  };

  app.redo = () => {
    const doc = H.redo();
    if (!doc) return;
    state.doc = doc;
    pruneSelection();
    afterDocSwap();
    document.getElementById('docName').value = doc.name;
    app.refresh();
    scheduleSave();
  };

  function syncRunControls() {
    const anim = M.anim(state.doc);
    const speed = document.getElementById('runSpeed');
    if (speed) {
      speed.value = anim.speed;
      document.getElementById('runSpeedVal').textContent = R.fmt(anim.speed) + ' m/s';
    }
    const loop = document.getElementById('runLoop');
    if (loop) loop.checked = anim.loop !== false;
  }

  function afterDocSwap() {
    if (!M.typeById(state.doc, state.activeType)) state.activeType = null;
    FB.ui.buildPalette();
    syncRunControls();
    app.rebuildRun();
  }

  function pruneSelection() {
    const ids = new Set(state.doc.items.map((it) => it.id));
    for (const id of [...state.selection]) if (!ids.has(id)) state.selection.delete(id);
  }

  /* ---------- top bar wiring ---------- */

  function toggleHelp(show) {
    document.getElementById('helpModal').classList.toggle('hidden', !show);
  }

  function wireChrome() {
    document.getElementById('toolGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('.tool');
      if (btn) app.setTool(btn.dataset.tool);
    });

    document.getElementById('docName').addEventListener('input', (e) => {
      state.doc.name = e.target.value;
    });
    document.getElementById('docName').addEventListener('change', () => app.commit());

    document.getElementById('btnNew').addEventListener('click', () => {
      if (state.doc.items.length && !confirm('Start a new layout? Anything unsaved is lost.')) return;
      const fresh = M.newDoc();
      /* Carry the machine types over — they are the user's own library. */
      fresh.types = M.types(state.doc).map((t) => JSON.parse(JSON.stringify(t)));
      setDoc(fresh, 'New layout');
    });
    document.getElementById('btnOpen').addEventListener('click', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) app.openFile(f);
      e.target.value = '';
    });
    document.getElementById('btnSave').addEventListener('click', app.saveFile);
    document.getElementById('btnPng').addEventListener('click', app.exportPNG);
    document.getElementById('btnUndo').addEventListener('click', app.undo);
    document.getElementById('btnRedo').addEventListener('click', app.redo);

    document.getElementById('chkSticky').addEventListener('change', (e) => { state.stickyTool = e.target.checked; });
    document.getElementById('chkSpecs').addEventListener('change', (e) => { state.showSpecs = e.target.checked; app.invalidate(); });
    document.getElementById('chkTimes').addEventListener('change', (e) => { state.showTimes = e.target.checked; app.invalidate(); });

    document.getElementById('btnFocus').addEventListener('click', () => app.setFocusMode(!state.focusMode));
    document.getElementById('btnFullscreen').addEventListener('click', app.toggleFullscreen);

    document.querySelectorAll('.fold-head').forEach((head) => {
      head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
    });

    document.getElementById('btnLockAll').addEventListener('click', () => app.lockAll(true));
    document.getElementById('btnUnlockAll').addEventListener('click', () => app.lockAll(false));
    document.getElementById('btnShowAll').addEventListener('click', app.showAll);

    document.getElementById('btnPlay').addEventListener('click', app.toggleRun);
    document.getElementById('btnRestart').addEventListener('click', app.restartRun);
    document.getElementById('btnBuildRun').addEventListener('click', app.buildRun);
    document.getElementById('btnAddStop').addEventListener('click', app.addStop);
    document.getElementById('runScrub').addEventListener('input', (e) => {
      const play = state.play;
      if (play.duration > 0) {
        play.t = (Number(e.target.value) / 1000) * play.duration;
        updateRunReadout();
        app.invalidate();
      }
    });
    const speed = document.getElementById('runSpeed');
    speed.addEventListener('input', () => {
      M.anim(state.doc).speed = Number(speed.value);
      document.getElementById('runSpeedVal').textContent = speed.value + ' m/s';
      app.rebuildRun();
      app.invalidate();
    });
    speed.addEventListener('change', () => app.commit());
    document.getElementById('runLoop').addEventListener('change', (e) => {
      M.anim(state.doc).loop = e.target.checked;
      app.commit();
    });
    document.getElementById('chkGrid').addEventListener('change', (e) => { state.showGrid = e.target.checked; app.invalidate(); });
    document.getElementById('chkSnap').addEventListener('change', (e) => { state.snap = e.target.checked; });
    document.getElementById('chkLabels').addEventListener('change', (e) => { state.showLabels = e.target.checked; app.invalidate(); });

    document.getElementById('btnZoomIn').addEventListener('click', () => app.zoomBy(1.25));
    document.getElementById('btnZoomOut').addEventListener('click', () => app.zoomBy(1 / 1.25));
    document.getElementById('btnZoomReset').addEventListener('click', () => app.zoomBy(26 / state.cam.zoom));
    document.getElementById('btnFit').addEventListener('click', app.zoomFit);

    document.getElementById('sideTabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (tab) showPane(tab.dataset.pane);
    });
    document.getElementById('btnAddStep').addEventListener('click', () => app.addStep(false));
    document.getElementById('btnStepFromSel').addEventListener('click', () => app.addStep(true));
    document.getElementById('btnStepsMd').addEventListener('click', app.exportSteps);
    document.getElementById('btnWide').addEventListener('click', () => {
      const side = document.querySelector('.sidebar.right');
      const before = R.toWorld(state.cam, R.width / 2, R.height / 2);
      side.classList.toggle('wide');
      /* The canvas keeps its flex width, so re-measure after the transition. */
      setTimeout(() => {
        R.resize();
        const after = R.toWorld(state.cam, R.width / 2, R.height / 2);
        state.cam.x += before.x - after.x;
        state.cam.y += before.y - after.y;
        app.invalidate();
      }, 180);
    });

    document.getElementById('btnCascade').addEventListener('click', app.cascade);
    document.getElementById('btnSample').addEventListener('click', () => {
      if (state.doc.items.length && !confirm('Replace the current layout with the example?')) return;
      setDoc(FB.sample(), 'Example layout loaded');
    });

    document.getElementById('btnNewType').addEventListener('click', () => app.openTypeEditor(null));
    document.getElementById('btnTypeSave').addEventListener('click', app.saveType);
    document.getElementById('btnTypeDelete').addEventListener('click', app.deleteType);
    document.getElementById('btnTypeClose').addEventListener('click', app.closeTypeEditor);
    document.getElementById('typeModal').addEventListener('click', (e) => {
      if (e.target.id === 'typeModal') app.closeTypeEditor();
    });
    document.getElementById('typeModal').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); app.saveType(); }
      if (e.key === 'Escape') { e.preventDefault(); app.closeTypeEditor(); }
    });

    document.getElementById('btnHelp').addEventListener('click', () => toggleHelp(true));
    document.getElementById('btnHelpClose').addEventListener('click', () => toggleHelp(false));
    document.getElementById('helpModal').addEventListener('click', (e) => {
      if (e.target.id === 'helpModal') toggleHelp(false);
    });

    const inp = document.getElementById('inlineEditor');
    inp.addEventListener('blur', () => app.closeInlineEdit(true));

    /* Drag a palette entry straight onto the canvas. */
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      const typeId = e.dataTransfer.getData('text/plain');
      const t = M.typeById(state.doc, typeId);
      if (!t) return;
      const rect = canvas.getBoundingClientRect();
      const wp = R.toWorld(state.cam, e.clientX - rect.left, e.clientY - rect.top);
      const x = state.snap ? G.snap(wp.x - t.w / 2, state.doc.grid) : wp.x - t.w / 2;
      const y = state.snap ? G.snap(wp.y - t.h / 2, state.doc.grid) : wp.y - t.h / 2;
      const m = M.machine(t, x, y);
      m.label = FB.tools.nextName(t.name);
      state.doc.items.push(m);
      state.selection = new Set([m.id]);
      app.commit();
      app.refresh();
    });

    window.addEventListener('resize', () => { R.resize(); app.invalidate(); });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('beforeunload', () => {
      try { localStorage.setItem(STORAGE_KEY, M.serialize(state.doc)); } catch (err) { /* ignore */ }
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    canvas = document.getElementById('canvas');
    wrap = document.getElementById('canvasWrap');
    R.attach(canvas);
    FB.ui.init(state, app);
    FB.tools.init(canvas, state, app);
    H.onChange = () => app.refreshStatus();
    wireChrome();

    const stored = loadStored();
    setDoc(stored && stored.items.length ? stored : FB.sample());
    app.setTool('select');
    frame();
  }

  FB.app = app;
  FB.state = state;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.FB);
