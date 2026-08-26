/* Side panels: machine palette, contextual properties, layout stats. */
(function (FB) {
  'use strict';

  const M = FB.model;
  const G = FB.geom;
  const R = FB.render;

  const U = {};
  let state = null;
  let app = null;

  /* ---------- tiny DOM helper ---------- */
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of (kids || [])) if (kid) n.appendChild(kid);
    return n;
  }

  function row(labelText, control, extra) {
    return el('div', { class: extra ? 'row two' : 'row' },
      [el('label', { text: labelText }), control, extra]);
  }

  function numberInput(value, step, onInput, onCommit) {
    const inp = el('input', { type: 'number', step: step || 0.1, value: R.fmt(value) });
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) { onInput(v); app.invalidate(); }
    });
    inp.addEventListener('change', () => { onCommit ? onCommit() : app.commit(); U.refreshStats(); });
    return inp;
  }

  function textInput(value, onInput) {
    const inp = el('input', { type: 'text', value: value || '' });
    inp.addEventListener('input', () => { onInput(inp.value); app.invalidate(); });
    inp.addEventListener('change', () => app.commit());
    return inp;
  }

  function colorInput(value, onInput) {
    const inp = el('input', { type: 'color', value: value || '#4f9cf9' });
    inp.addEventListener('input', () => { onInput(inp.value); app.invalidate(); });
    inp.addEventListener('change', () => app.commit());
    return inp;
  }

  function selectInput(options, value, onChange) {
    const sel = el('select', {}, options.map(([v, t]) =>
      el('option', { value: v, text: t, selected: v === value })));
    sel.value = value;
    sel.addEventListener('change', () => { onChange(sel.value); app.commit(); });
    return sel;
  }

  function checkInput(labelText, checked, onChange) {
    const inp = el('input', { type: 'checkbox' });
    inp.checked = !!checked;
    inp.addEventListener('change', () => { onChange(inp.checked); app.commit(); });
    return el('label', { class: 'check' }, [inp, document.createTextNode(' ' + labelText)]);
  }

  function button(text, onClick, cls, title) {
    return el('button', { class: 'btn ' + (cls || ''), text, title: title || text, onclick: onClick });
  }

  /* ---------- init ---------- */

  U.init = (appState, appApi) => {
    state = appState;
    app = appApi;
    buildPalette();
  };

  /* ---------- palette ---------- */

  const PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg>';

  function buildPalette() {
    const host = document.getElementById('palette');
    host.innerHTML = '';
    const types = M.types(state.doc);

    if (!types.length) {
      host.appendChild(el('div', { class: 'pal-empty', html:
        '<b>No machine types yet</b>Use <b style="display:inline">+ New</b> to add the machines you actually have — ' +
        'name, footprint and colour. You can also draw a box with the Machine tool and save it as a type.' }));
      return;
    }

    for (const t of types) {
      const item = el('div', {
        class: 'pal-item' + (state.activeType === t.id ? ' active' : ''),
        'data-type': t.id,
        draggable: 'true',
        title: t.name + ' — default ' + R.fmt(t.w) + ' × ' + R.fmt(t.h) + ' m',
      }, [
        el('span', { class: 'pal-swatch' }),
        el('span', { class: 'pal-name', text: t.name }),
        el('span', { class: 'pal-size', text: R.fmt(t.w) + '×' + R.fmt(t.h) }),
        el('button', { class: 'pal-edit', html: PENCIL, title: 'Edit this type' }),
      ]);
      item.querySelector('.pal-swatch').style.background = t.color;

      item.querySelector('.pal-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        app.openTypeEditor(t.id);
      });
      item.addEventListener('click', () => {
        state.activeType = t.id;
        app.setTool('machine');
        U.refreshPalette();
        app.setHint('Drag a box, or click once for a ' + R.fmt(t.w) + ' × ' + R.fmt(t.h) + ' m ' + t.name);
      });
      item.addEventListener('dragstart', (e) => {
        state.activeType = t.id;
        U.refreshPalette();
        e.dataTransfer.setData('text/plain', t.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      host.appendChild(item);
    }
  }
  U.buildPalette = buildPalette;

  U.refreshPalette = () => buildPalette();

  /* ---------- properties ---------- */

  U.refreshProps = () => {
    const host = document.getElementById('props');
    host.innerHTML = '';
    const items = state.doc.items.filter((it) => state.selection.has(it.id));

    if (!items.length) {
      host.appendChild(el('div', { class: 'empty', text: 'Select something to edit it.' }));
      host.appendChild(el('p', { class: 'note', text: 'Tip: double-click a machine on the canvas to rename it, or select it and edit the Name field here.' }));
      return;
    }

    if (items.length > 1) {
      host.appendChild(el('div', { class: 'subhead', text: items.length + ' items selected' }));
      const machines = items.filter((it) => it.type === 'machine');
      if (machines.length > 1) host.appendChild(renameAllBlock(machines));
      host.appendChild(alignBlock());
      host.appendChild(commonActions(items));
      return;
    }

    const it = items[0];
    switch (it.type) {
      case 'machine': machineProps(host, it); break;
      case 'zone':    zoneProps(host, it); break;
      case 'wall':    wallProps(host, it); break;
      case 'label':   labelProps(host, it); break;
      case 'route':   routeProps(host, it); break;
    }
    host.appendChild(commonActions(items));
  };

  function machineProps(host, m) {
    host.appendChild(row('Name', textInput(m.label, (v) => { m.label = v; })));
    const types = M.types(state.doc);
    const typeOptions = [['', types.length ? '— no type —' : '— no types defined —']]
      .concat(types.map((t) => [t.id, t.name]));
    const typeSel = selectInput(typeOptions, m.kind || '', (v) => {
      const prev = M.typeById(state.doc, m.kind);
      m.kind = v || null;
      const next = M.typeById(state.doc, v);
      if (next) {
        m.color = next.color;
        /* Only rename when the label was just the old type's name. */
        if (!m.label || (prev && m.label === prev.name)) m.label = next.name;
      }
      U.refreshProps();
    });
    host.appendChild(row('Type', typeSel, button('Save as…', () => app.saveMachineAsType(m), '', 'Create a new type from this machine')));

    host.appendChild(row('Position', numberInput(m.x, 0.5, (v) => { m.x = v; }), numberInput(m.y, 0.5, (v) => { m.y = v; })));
    host.appendChild(row('Size (m)', numberInput(m.w, 0.5, (v) => { m.w = Math.max(0.2, v); }), numberInput(m.h, 0.5, (v) => { m.h = Math.max(0.2, v); })));

    const rotInp = numberInput(m.rot, 15, (v) => { m.rot = ((v % 360) + 360) % 360; });
    host.appendChild(row('Rotation', rotInp, button('+90°', () => {
      m.rot = ((m.rot + 90) % 360);
      rotInp.value = R.fmt(m.rot);
      app.commit();
    }, '', 'Rotate 90 degrees')));

    host.appendChild(row('Colour', colorInput(m.color, (v) => { m.color = v; })));
    host.appendChild(row('Clearance', numberInput(m.clearance, 0.25, (v) => { m.clearance = Math.max(0, v); })));
    host.appendChild(checkInput('Vehicle — can drive the run', m.vehicle, (v) => {
      m.vehicle = v;
      U.refreshStops();
    }));

    const notes = el('textarea', { rows: 2, placeholder: 'Notes, cycle time, operator…' });
    notes.value = m.notes || '';
    notes.addEventListener('input', () => { m.notes = notes.value; });
    notes.addEventListener('change', () => app.commit());
    host.appendChild(row('Notes', notes));

    const params = (m.params || []).filter((p) => p.k || p.v);
    host.appendChild(el('div', { class: 'btnrow' }, [
      button(params.length ? 'Details (' + params.length + ')' : 'Add details', () => {
        app.showPane('process');
        app.openFold('specs');
        FB.ui.focusSpec(m.id);
      }, '', 'Wash pressure, temperature, cycle time…'),
    ]));

    const links = M.routesFor(state.doc, m.id);
    host.appendChild(el('p', { class: 'note', text: 'Footprint ' + R.fmt(m.w * m.h) + ' m² · ' + links.length + ' route' + (links.length === 1 ? '' : 's') + ' attached' }));
  }

  function zoneProps(host, z) {
    host.appendChild(row('Name', textInput(z.label, (v) => { z.label = v; })));
    host.appendChild(row('Position', numberInput(z.x, 0.5, (v) => { z.x = v; }), numberInput(z.y, 0.5, (v) => { z.y = v; })));
    host.appendChild(row('Size (m)', numberInput(z.w, 0.5, (v) => { z.w = Math.max(0.5, v); }), numberInput(z.h, 0.5, (v) => { z.h = Math.max(0.5, v); })));
    host.appendChild(row('Colour', colorInput(z.color, (v) => { z.color = v; })));
    host.appendChild(checkInput('Hatched fill', z.hatch, (v) => { z.hatch = v; }));
    host.appendChild(row('Time (min)', numberInput(z.duration, 1, (v) => { z.duration = Math.max(0, v); })));
    host.appendChild(el('div', { class: 'btnrow' }, [
      button(z.process ? 'Edit process' : 'Describe process', () => {
        app.showPane('process');
        app.openFold('zones');
        FB.ui.focusZone(z.id);
      }, '', 'What happens in this zone, and when'),
    ]));
    host.appendChild(el('p', { class: 'note', text: 'Area ' + R.fmt(z.w * z.h) + ' m² · zones sit behind machines and only catch clicks on their border or title.' }));
  }

  function wallProps(host, w) {
    host.appendChild(row('Thickness', numberInput(w.thickness, 0.05, (v) => { w.thickness = Math.max(0.05, v); })));
    host.appendChild(row('Colour', colorInput(w.color, (v) => { w.color = v; })));
    host.appendChild(checkInput('Closed loop', w.closed, (v) => { w.closed = v; }));
    const pts = w.closed && w.points.length > 2 ? w.points.concat([w.points[0]]) : w.points;
    host.appendChild(el('p', { class: 'note', text: w.points.length + ' points · ' + R.fmt(G.polylineLength(pts)) + ' m total · double-click a segment to add a corner.' }));
  }

  function labelProps(host, l) {
    host.appendChild(row('Text', textInput(l.text, (v) => { l.text = v; })));
    host.appendChild(row('Position', numberInput(l.x, 0.5, (v) => { l.x = v; }), numberInput(l.y, 0.5, (v) => { l.y = v; })));
    host.appendChild(row('Size (m)', numberInput(l.size, 0.1, (v) => { l.size = Math.max(0.2, v); })));
    host.appendChild(row('Rotation', numberInput(l.rot, 15, (v) => { l.rot = v; })));
    host.appendChild(row('Colour', colorInput(l.color, (v) => { l.color = v; })));
  }

  function endName(end) {
    if (!end) return '—';
    if (end.item) {
      const host = M.byId(state.doc, end.item);
      return host ? (host.label || host.type) : 'missing';
    }
    return R.fmt(end.x) + ', ' + R.fmt(end.y);
  }

  function routeProps(host, r) {
    host.appendChild(row('Label', textInput(r.label, (v) => { r.label = v; })));
    host.appendChild(el('p', { class: 'note', text: 'From ' + endName(r.from) + '  →  ' + endName(r.to) }));
    host.appendChild(row('Path', selectInput([['ortho', 'Right angles'], ['direct', 'Straight']], r.mode, (v) => { r.mode = v; })));
    host.appendChild(row('Arrows', selectInput([['end', 'At the end'], ['both', 'Both ends'], ['none', 'None']], r.arrows, (v) => { r.arrows = v; })));
    host.appendChild(row('Colour', colorInput(r.color, (v) => { r.color = v; })));
    host.appendChild(row('Width', numberInput(r.width, 0.02, (v) => { r.width = Math.max(0.02, v); })));
    host.appendChild(checkInput('Dashed', r.dashed, (v) => { r.dashed = v; }));

    host.appendChild(el('div', { class: 'btnrow' }, [
      button('Reverse', () => {
        const f = r.from; r.from = r.to; r.to = f;
        r.waypoints.reverse();
        app.commit(); U.refreshProps();
      }, '', 'Swap the direction of flow'),
      button('Clear bends', () => { r.waypoints = []; app.commit(); U.refreshProps(); }, '', 'Remove all waypoints'),
    ]));

    host.appendChild(el('p', { class: 'note', text: R.fmt(M.routeLength(state.doc, r)) + ' m · ' + r.waypoints.length + ' bend' + (r.waypoints.length === 1 ? '' : 's') + ' · double-click the line to add one.' }));
  }

  /* Name a whole run of machines at once: "Press" -> Press 1 … Press N. */
  function renameAllBlock(machines) {
    const inp = el('input', { type: 'text', placeholder: 'e.g. Press' });
    const apply = () => {
      const base = inp.value.trim();
      if (!base) return;
      const ordered = machines.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
      ordered.forEach((m, i) => { m.label = base + ' ' + (i + 1); });
      app.commit();
      app.toast('Renamed ' + ordered.length + ' machines');
      U.refreshProps();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    return el('div', {}, [
      el('div', { class: 'subhead', text: 'Name all ' + machines.length + ' machines' }),
      el('div', { class: 'row' }, [inp, button('Apply', apply, 'primary')]),
      el('p', { class: 'note', text: 'Numbered left to right, top to bottom.' }),
    ]);
  }

  /* ---------- align / distribute ---------- */

  const ALIGN_ICONS = {
    left:   'M3 3v18M7 7h11v3H7zM7 14h7v3H7z',
    hcent:  'M12 3v18M6 7h12v3H6zM8 14h8v3H8z',
    right:  'M21 3v18M6 7h11v3H6zM10 14h7v3h-7z',
    top:    'M3 3h18M7 7h3v11H7zM14 7h3v7h-3z',
    vcent:  'M3 12h18M7 6h3v12H7zM14 8h3v8h-3z',
    bottom: 'M3 21h18M7 6h3v11H7zM14 10h3v7h-3z',
  };

  function alignBlock() {
    const mk = (key, title) =>
      el('button', {
        class: 'btn', title,
        onclick: () => app.align(key),
        html: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + ALIGN_ICONS[key] + '"/></svg>',
      });
    return el('div', {}, [
      el('div', { class: 'subhead', text: 'Align' }),
      el('div', { class: 'align-grid' }, [
        mk('left', 'Align left'), mk('hcent', 'Align horizontal centres'), mk('right', 'Align right'),
        mk('top', 'Align top'), mk('vcent', 'Align vertical centres'), mk('bottom', 'Align bottom'),
      ]),
      el('div', { class: 'subhead', text: 'Distribute' }),
      el('div', { class: 'btnrow' }, [
        button('Horizontally', () => app.distribute('x')),
        button('Vertically', () => app.distribute('y')),
      ]),
      el('div', { class: 'subhead', text: 'Connect' }),
      el('div', { class: 'btnrow' }, [
        button('Chain routes', () => app.chainSelection(), '', 'Wire the selected machines together in order'),
      ]),
    ]);
  }

  function commonActions(items) {
    const allLocked = items.every((it) => it.locked);
    return el('div', {}, [
      el('div', { class: 'subhead', text: 'Actions' }),
      el('div', { class: 'btnrow' }, [
        button('Duplicate', () => app.duplicate()),
        button('Forward', () => app.reorder(1), '', 'Bring forward (])'),
        button('Back', () => app.reorder(-1), '', 'Send backward ([)'),
        button(allLocked ? 'Unlock' : 'Lock', () => app.setLocked(items.map((i) => i.id), !allLocked), '',
          'A locked item cannot be selected or dragged on the canvas'),
        button('Delete', () => app.deleteSelection(), 'danger'),
      ]),
    ]);
  }

  /* ---------- stats ---------- */

  U.refreshStats = () => {
    const host = document.getElementById('stats');
    const s = M.stats(state.doc);
    host.innerHTML = '';

    const stat = (k, v) => el('div', { class: 'stat' }, [
      el('span', { text: k }), el('b', { text: v }),
    ]);

    host.appendChild(stat('Machines', String(s.machines)));
    host.appendChild(stat('Routes', s.routes + ' · ' + R.fmt(s.routeLength) + ' m'));
    host.appendChild(stat('Walls', s.walls + ' · ' + R.fmt(s.wallLength) + ' m'));
    host.appendChild(stat('Zones', s.zones + ' · ' + R.fmt(s.zoneArea) + ' m²'));
    host.appendChild(stat('Machine area', R.fmt(s.machineArea) + ' m²'));
    if (s.extent) {
      host.appendChild(stat('Extent', R.fmt(s.extent.w) + ' × ' + R.fmt(s.extent.h) + ' m'));
      host.appendChild(stat('Density', Math.round(s.utilisation * 100) + '%'));
    }

    const kinds = Object.keys(s.byKind).sort((a, b) => s.byKind[b] - s.byKind[a]);
    if (kinds.length) {
      const bars = el('div', { class: 'stat-bars' });
      const max = Math.max(...kinds.map((k) => s.byKind[k]));
      for (const k of kinds.slice(0, 8)) {
        const t = M.typeById(state.doc, k);
        const bar = el('div', { class: 'stat-bar' }, [
          el('span', { text: t ? t.name : 'Untyped' }),
          el('b', { text: String(s.byKind[k]) }),
        ]);
        const track = el('div', { class: 'track' });
        const fill = el('div', { class: 'fill' });
        fill.style.width = Math.round((s.byKind[k] / max) * 100) + '%';
        fill.style.background = t ? t.color : M.UNTYPED_COLOR;
        track.appendChild(fill);
        bar.appendChild(track);
        bars.appendChild(bar);
      }
      host.appendChild(bars);
    }
  };

  /* ---------- process steps ---------- */

  function iconBtn(glyph, title, onClick, cls) {
    const b = el('button', { title, text: glyph, class: cls || '' });
    b.addEventListener('click', onClick);
    return b;
  }

  function linkedName(doc, id) {
    const it = M.byId(doc, id);
    if (!it) return null;
    if (it.type === 'machine') return { name: it.label, color: it.color };
    if (it.type === 'zone') return { name: it.label, color: it.color };
    if (it.type === 'route') return { name: it.label || 'Route', color: it.color };
    if (it.type === 'label') return { name: it.text, color: it.color };
    return { name: it.type, color: '#64748b' };
  }

  U.refreshProcess = () => {
    const host = document.getElementById('stepList');
    if (!host) return;
    const doc = state.doc;
    const steps = doc.process || (doc.process = []);
    host.innerHTML = '';

    const count = document.getElementById('stepCount');
    if (count) count.textContent = steps.length === 0 ? 'no steps yet'
      : steps.length + (steps.length === 1 ? ' step' : ' steps');
    const badge = document.querySelector('.tab[data-pane="process"] .badge');
    if (badge) {
      badge.textContent = steps.length ? String(steps.length) : '';
      badge.classList.toggle('hidden', steps.length === 0);
    }

    if (!steps.length) {
      host.appendChild(el('div', { class: 'empty', html: 'No steps yet.<br>Use <b>+ Step</b> to start writing the process.' }));
      return;
    }

    steps.forEach((st, i) => host.appendChild(stepCard(st, i, steps)));
  };

  function stepCard(st, i, steps) {
    const doc = state.doc;
    const link = st.link ? linkedName(doc, st.link) : null;

    const num = el('span', {
      class: 'step-num' + (link ? ' has-link' : ''),
      text: String(i + 1),
      title: link ? 'Jump to ' + link.name : 'Step ' + (i + 1),
    });
    if (link) num.addEventListener('click', () => app.focusItem(st.link));

    const title = el('input', { class: 'step-title', type: 'text', placeholder: 'Step title' });
    title.value = st.title;
    title.addEventListener('input', () => { st.title = title.value; app.invalidate(); });
    title.addEventListener('change', () => app.commit());

    const details = el('textarea', { class: 'step-details', rows: 3, placeholder: 'What happens here — settings, times, tooling, who does it…' });
    details.value = st.details;
    details.addEventListener('input', () => { st.details = details.value; });
    details.addEventListener('change', () => app.commit());

    const tools = el('div', { class: 'step-tools' }, [
      iconBtn('↑', 'Move up', () => app.moveStep(i, -1)),
      iconBtn('↓', 'Move down', () => app.moveStep(i, 1)),
      iconBtn('⧉', 'Duplicate step', () => app.duplicateStep(i)),
      iconBtn('✕', 'Delete step', () => app.removeStep(i), 'del'),
    ]);
    tools.children[0].disabled = i === 0;
    tools.children[1].disabled = i === steps.length - 1;

    const linkBtn = el('button', { class: 'step-link' + (link ? ' is-linked' : '') });
    if (link) {
      const dot = el('span', { class: 'dot' });
      dot.style.background = link.color;
      linkBtn.appendChild(dot);
      linkBtn.appendChild(el('span', { class: 'name', text: link.name }));
      linkBtn.appendChild(el('span', { class: 'clear', text: '✕', title: 'Unlink' }));
      linkBtn.title = 'Click to select it on the layout';
      linkBtn.addEventListener('click', (e) => {
        if (e.target.classList.contains('clear')) app.linkStep(i, null);
        else app.focusItem(st.link);
      });
    } else {
      const sel = state.selection.size === 1 ? M.byId(doc, [...state.selection][0]) : null;
      linkBtn.appendChild(el('span', { class: 'name', text: sel ? 'Link to ' + (sel.label || sel.text || sel.type) : 'Link to… (select an item first)' }));
      linkBtn.disabled = !sel;
      linkBtn.title = 'Ties this step to an item on the layout';
      linkBtn.addEventListener('click', () => { if (sel) app.linkStep(i, sel.id); });
    }

    const card = el('div', { class: 'step' + (st.link && state.selection.has(st.link) ? ' linked-active' : '') }, [
      el('div', { class: 'step-head' }, [num, title]),
      details,
      el('div', { class: 'step-foot' }, [linkBtn, tools]),
    ]);
    card.dataset.id = st.id;
    return card;
  }

  /* Focus a freshly added step so the user can just start typing. */
  U.focusStep = (index) => {
    const cards = document.querySelectorAll('#stepList .step');
    const card = cards[index];
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    const input = card.querySelector('.step-title');
    if (input) { input.focus(); input.select(); }
  };

  /* ---------- machine details ---------- */

  function itemName(doc, it) {
    switch (it.type) {
      case 'machine': return it.label || 'Machine';
      case 'zone': return it.label || 'Zone';
      case 'label': return it.text || 'Text';
      case 'wall': return 'Wall · ' + it.points.length + ' pts';
      case 'route': {
        const nm = (e) => {
          if (!e) return '?';
          if (e.item) { const h = M.byId(doc, e.item); return h ? (h.label || h.text || h.type) : 'missing'; }
          return 'point';
        };
        return it.label || (nm(it.from) + ' → ' + nm(it.to));
      }
      default: return it.type;
    }
  }
  U.itemName = itemName;

  U.refreshSpecs = () => {
    const host = document.getElementById('specList');
    if (!host) return;
    host.innerHTML = '';
    const machines = state.doc.items.filter((it) => it.type === 'machine');

    const count = document.getElementById('specCount');
    if (count) {
      const withDetails = machines.filter((m) => (m.params || []).some((p) => p.k || p.v)).length;
      count.textContent = machines.length ? withDetails + ' of ' + machines.length + ' filled in' : '';
    }

    if (!machines.length) {
      host.appendChild(el('div', { class: 'spec-empty', text: 'No machines on the layout yet.' }));
      return;
    }
    for (const m of machines) host.appendChild(specCard(m));
  };

  function specCard(m) {
    if (!Array.isArray(m.params)) m.params = [];

    const dot = el('span', { class: 'spec-dot' });
    dot.style.background = m.color;

    const name = el('span', { class: 'spec-name', text: m.label || 'Machine', title: 'Select this machine' });
    name.addEventListener('click', () => app.focusItem(m.id));

    const rows = el('div', { class: 'spec-rows' });
    m.params.forEach((p, i) => rows.appendChild(specRow(m, p, i)));

    const add = el('button', { class: 'spec-add', text: '+ detail' });
    add.addEventListener('click', () => {
      m.params.push(M.param('', ''));
      app.commit();
      U.refreshSpecs();
      const card = document.querySelector('.spec-card[data-id="' + m.id + '"]');
      const inputs = card && card.querySelectorAll('.spec-row input.k');
      if (inputs && inputs.length) inputs[inputs.length - 1].focus();
    });

    const card = el('div', { class: 'spec-card' }, [
      el('div', { class: 'spec-head' }, [dot, name]),
      rows,
      add,
    ]);
    card.dataset.id = m.id;
    return card;
  }

  function specRow(m, p, i) {
    const k = el('input', { class: 'k', type: 'text', placeholder: 'Setting' });
    k.value = p.k;
    k.addEventListener('input', () => { p.k = k.value; app.invalidate(); });
    k.addEventListener('change', () => app.commit());

    const v = el('input', { type: 'text', placeholder: 'Value' });
    v.value = p.v;
    v.addEventListener('input', () => { p.v = v.value; app.invalidate(); });
    v.addEventListener('change', () => app.commit());

    const rm = el('button', { class: 'rm', text: '✕', title: 'Remove this detail' });
    rm.addEventListener('click', () => {
      m.params.splice(i, 1);
      app.commit();
      U.refreshSpecs();
    });

    return el('div', { class: 'spec-row' }, [k, v, rm]);
  }

  U.focusSpec = (machineId) => {
    U.refreshSpecs();
    const card = document.querySelector('.spec-card[data-id="' + machineId + '"]');
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    const input = card.querySelector('.spec-row input.k') || card.querySelector('.spec-add');
    if (input) input.focus();
  };

  /* ---------- zone process ---------- */

  U.refreshZones = () => {
    const host = document.getElementById('zoneList');
    if (!host) return;
    host.innerHTML = '';
    const zones = state.doc.items.filter((it) => it.type === 'zone');

    const total = zones.reduce((sum, z) => sum + (z.duration || 0), 0);
    const totalEl = document.getElementById('zoneTotal');
    if (totalEl) totalEl.textContent = total > 0 ? 'total ' + R.fmtTime(total) : (zones.length ? '' : '');

    if (!zones.length) {
      host.appendChild(el('div', { class: 'spec-empty', text: 'Draw a zone to describe what happens in it.' }));
      return;
    }
    for (const z of zones) host.appendChild(zoneCard(z));
  };

  function zoneCard(z) {
    const dot = el('span', { class: 'spec-dot' });
    dot.style.background = z.color;

    const name = el('span', { class: 'spec-name', text: z.label || 'Zone', title: 'Select this zone' });
    name.addEventListener('click', () => app.focusItem(z.id));

    const text = el('textarea', { rows: 3, placeholder: 'What happens here, and when — shifts, sequence, who runs it…' });
    text.value = z.process || '';
    text.addEventListener('input', () => { z.process = text.value; app.invalidate(); });
    text.addEventListener('change', () => app.commit());

    const time = el('input', { type: 'number', step: '1', min: '0' });
    time.value = R.fmt(z.duration || 0);
    time.addEventListener('input', () => {
      z.duration = Math.max(0, parseFloat(time.value) || 0);
      app.invalidate();
    });
    time.addEventListener('change', () => { app.commit(); U.refreshZones(); });

    const card = el('div', { class: 'zone-card' }, [
      el('div', { class: 'spec-head' }, [dot, name]),
      text,
      el('div', { class: 'zone-time' }, [
        time,
        el('span', { text: 'minutes to process' }),
      ]),
    ]);
    card.dataset.id = z.id;
    return card;
  }

  U.focusZone = (zoneId) => {
    U.refreshZones();
    const card = document.querySelector('.zone-card[data-id="' + zoneId + '"]');
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    const t = card.querySelector('textarea');
    if (t) t.focus();
  };

  /* ---------- layers ---------- */

  const EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l16 16"/><path d="M9.9 5.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.3 7.7A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4-.85"/></svg>';
  const LOCK_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const LOCK_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';

  const TYPE_LABEL = { machine: 'machine', zone: 'zone', wall: 'wall', route: 'route', label: 'text' };

  U.refreshLayers = () => {
    const host = document.getElementById('layerList');
    if (!host) return;
    host.innerHTML = '';
    const items = state.doc.items;

    const count = document.getElementById('layerCount');
    if (count) {
      const locked = items.filter((i) => i.locked).length;
      const hidden = items.filter((i) => i.hidden).length;
      const bits = [items.length + ' items'];
      if (locked) bits.push(locked + ' locked');
      if (hidden) bits.push(hidden + ' hidden');
      count.textContent = bits.join(' · ');
    }

    if (!items.length) {
      host.appendChild(el('div', { class: 'spec-empty', text: 'Nothing on the layout yet.' }));
      return;
    }

    /* Top of the stack first, matching what you see. */
    for (let i = items.length - 1; i >= 0; i--) host.appendChild(layerRow(items[i], i));
  };

  function layerRow(it, index) {
    const dot = el('span', { class: 'layer-dot' });
    dot.style.background = it.color || '#64748b';

    const eye = el('button', {
      class: 'layer-btn' + (it.hidden ? '' : ' on'),
      html: it.hidden ? EYE_OFF : EYE_ON,
      title: it.hidden ? 'Show' : 'Hide',
    });
    eye.addEventListener('click', (e) => { e.stopPropagation(); app.setHidden([it.id], !it.hidden); });

    const lock = el('button', {
      class: 'layer-btn' + (it.locked ? ' on' : ''),
      html: it.locked ? LOCK_ON : LOCK_OFF,
      title: it.locked ? 'Unlock' : 'Lock',
    });
    lock.addEventListener('click', (e) => { e.stopPropagation(); app.setLocked([it.id], !it.locked); });

    const up = el('button', { class: 'layer-btn', text: '↑', title: 'Bring forward' });
    up.addEventListener('click', (e) => { e.stopPropagation(); app.moveItem(it.id, 1); });
    const down = el('button', { class: 'layer-btn', text: '↓', title: 'Send backward' });
    down.addEventListener('click', (e) => { e.stopPropagation(); app.moveItem(it.id, -1); });
    up.disabled = index === state.doc.items.length - 1;
    down.disabled = index === 0;

    const row = el('div', {
      class: 'layer-row' + (state.selection.has(it.id) ? ' sel' : '') + (it.hidden ? ' off' : ''),
      title: it.locked ? 'Locked — unlock to edit it on the canvas' : 'Select',
    }, [
      dot,
      el('span', { class: 'layer-name', text: itemName(state.doc, it) }),
      el('span', { class: 'layer-kind', text: TYPE_LABEL[it.type] || it.type }),
      up, down, eye, lock,
    ]);
    row.addEventListener('click', () => {
      if (it.locked || it.hidden) { app.toast(it.locked ? 'That layer is locked' : 'That layer is hidden'); return; }
      app.focusItem(it.id);
    });
    return row;
  }

  /* ---------- animated run ---------- */

  U.refreshStops = () => {
    const host = document.getElementById('stopList');
    if (!host) return;
    host.innerHTML = '';
    const anim = M.anim(state.doc);

    if (!anim.stops.length) {
      host.appendChild(el('div', { class: 'spec-empty', html:
        'No run defined.<br>Use <b>Build from routes</b>, or select a machine and <b>Add selected</b>.' }));
      return;
    }

    anim.stops.forEach((st, i) => {
      const item = st.item ? M.byId(state.doc, st.item) : null;
      if (st.item && !item) return;

      const label = item ? itemName(state.doc, item)
        : 'Point ' + R.fmt(st.x) + ', ' + R.fmt(st.y);
      const name = el('span', {
        class: 'stop-name',
        text: label,
        title: item ? 'Select it' : 'A hand-placed point — drag it on the canvas',
      });
      if (item) name.addEventListener('click', () => app.focusItem(item.id));

      const dwell = el('input', { class: 'stop-dwell', type: 'number', step: '0.5', min: '0' });
      dwell.value = R.fmt(st.dwell);
      dwell.addEventListener('input', () => {
        st.dwell = Math.max(0, parseFloat(dwell.value) || 0);
        app.rebuildRun();
      });
      dwell.addEventListener('change', () => app.commit());

      const up = el('button', { class: 'layer-btn', text: '↑', title: 'Earlier' });
      up.addEventListener('click', () => app.moveStop(i, -1));
      const down = el('button', { class: 'layer-btn', text: '↓', title: 'Later' });
      down.addEventListener('click', () => app.moveStop(i, 1));
      const rm = el('button', { class: 'layer-btn', text: '✕', title: 'Remove from the run' });
      rm.addEventListener('click', () => app.removeStop(i));
      up.disabled = i === 0;
      down.disabled = i === anim.stops.length - 1;

      const row = el('div', { class: 'stop-row' }, [
        el('span', { class: 'stop-num', text: String(i + 1) }),
        name, dwell,
        el('span', { class: 'stop-unit', text: 's' }),
        up, down, rm,
      ]);
      row.dataset.index = i;
      host.appendChild(row);
    });
  };

  /* Light touch during playback — no DOM rebuild. */
  U.markCurrentStop = (index) => {
    document.querySelectorAll('#stopList .stop-row').forEach((r) => {
      r.classList.toggle('current', Number(r.dataset.index) === index);
    });
  };

  FB.ui = U;
})(window.FB);
