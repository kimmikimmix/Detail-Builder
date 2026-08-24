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
    activeKind: 'cnc',
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

  function frame() {
    if (dirty) {
      dirty = false;
      R.draw(state);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- committing changes ---------- */

  app.commit = () => {
    H.commit(state.doc);
    app.invalidate();
    FB.ui.refreshProps();
    FB.ui.refreshStats();
    scheduleSave();
  };

  app.refresh = () => {
    FB.ui.refreshProps();
    FB.ui.refreshStats();
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
      machine: 'Drag a box to place a ' + M.KINDS[state.activeKind].name,
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
    state.selection = new Set(state.doc.items.map((it) => it.id));
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
    document.getElementById('docName').value = doc.name;
    app.refresh();
    scheduleSave();
  };

  app.redo = () => {
    const doc = H.redo();
    if (!doc) return;
    state.doc = doc;
    pruneSelection();
    document.getElementById('docName').value = doc.name;
    app.refresh();
    scheduleSave();
  };

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
      setDoc(M.newDoc(), 'New layout');
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
    document.getElementById('chkGrid').addEventListener('change', (e) => { state.showGrid = e.target.checked; app.invalidate(); });
    document.getElementById('chkSnap').addEventListener('change', (e) => { state.snap = e.target.checked; });
    document.getElementById('chkLabels').addEventListener('change', (e) => { state.showLabels = e.target.checked; app.invalidate(); });

    document.getElementById('btnZoomIn').addEventListener('click', () => app.zoomBy(1.25));
    document.getElementById('btnZoomOut').addEventListener('click', () => app.zoomBy(1 / 1.25));
    document.getElementById('btnZoomReset').addEventListener('click', () => app.zoomBy(26 / state.cam.zoom));
    document.getElementById('btnFit').addEventListener('click', app.zoomFit);

    document.getElementById('btnCascade').addEventListener('click', app.cascade);
    document.getElementById('btnSample').addEventListener('click', () => {
      if (state.doc.items.length && !confirm('Replace the current layout with the example?')) return;
      setDoc(FB.sample(), 'Example layout loaded');
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
      const kind = e.dataTransfer.getData('text/plain');
      if (!M.KINDS[kind]) return;
      const rect = canvas.getBoundingClientRect();
      const wp = R.toWorld(state.cam, e.clientX - rect.left, e.clientY - rect.top);
      const k = M.KINDS[kind];
      const x = state.snap ? G.snap(wp.x - k.w / 2, state.doc.grid) : wp.x - k.w / 2;
      const y = state.snap ? G.snap(wp.y - k.h / 2, state.doc.grid) : wp.y - k.h / 2;
      const m = M.machine(kind, x, y);
      m.label = FB.tools.nextName(k.name);
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
