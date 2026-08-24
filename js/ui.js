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

  function buildPalette() {
    const host = document.getElementById('palette');
    host.innerHTML = '';
    for (const key of Object.keys(M.KINDS)) {
      const k = M.KINDS[key];
      const item = el('div', {
        class: 'pal-item' + (state.activeKind === key ? ' active' : ''),
        'data-kind': key,
        draggable: 'true',
        title: k.name + ' — default ' + k.w + ' × ' + k.h + ' m',
      }, [
        el('span', { class: 'pal-swatch' }),
        el('span', { class: 'pal-name', text: k.name }),
        el('span', { class: 'pal-size', text: k.w + '×' + k.h }),
      ]);
      item.querySelector('.pal-swatch').style.background = k.color;

      item.addEventListener('click', () => {
        state.activeKind = key;
        app.setTool('machine');
        U.refreshPalette();
        app.setHint('Drag a box on the canvas, or click once for a ' + k.w + ' × ' + k.h + ' m ' + k.name);
      });
      item.addEventListener('dragstart', (e) => {
        state.activeKind = key;
        U.refreshPalette();
        e.dataTransfer.setData('text/plain', key);
        e.dataTransfer.effectAllowed = 'copy';
      });
      host.appendChild(item);
    }
  }
  U.buildPalette = buildPalette;

  U.refreshPalette = () => {
    document.querySelectorAll('.pal-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.kind === state.activeKind);
    });
  };

  /* ---------- properties ---------- */

  U.refreshProps = () => {
    const host = document.getElementById('props');
    host.innerHTML = '';
    const items = state.doc.items.filter((it) => state.selection.has(it.id));

    if (!items.length) {
      host.appendChild(el('div', { class: 'empty', text: 'Select something to edit it.' }));
      host.appendChild(el('p', { class: 'note', text: 'Tip: pick a machine from the palette and drag a box on the canvas.' }));
      return;
    }

    if (items.length > 1) {
      host.appendChild(el('div', { class: 'subhead', text: items.length + ' items selected' }));
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
    host.appendChild(row('Type', selectInput(
      Object.keys(M.KINDS).map((k) => [k, M.KINDS[k].name]), m.kind,
      (v) => {
        m.kind = v;
        const k = M.KINDS[v];
        if (m.color !== k.color) m.color = k.color;
        if (!m.label || Object.values(M.KINDS).some((kk) => kk.name === m.label)) m.label = k.name;
        U.refreshProps();
      })));

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

    const notes = el('textarea', { rows: 2, placeholder: 'Notes, cycle time, operator…' });
    notes.value = m.notes || '';
    notes.addEventListener('input', () => { m.notes = notes.value; });
    notes.addEventListener('change', () => app.commit());
    host.appendChild(row('Notes', notes));

    const links = M.routesFor(state.doc, m.id);
    host.appendChild(el('p', { class: 'note', text: 'Footprint ' + R.fmt(m.w * m.h) + ' m² · ' + links.length + ' route' + (links.length === 1 ? '' : 's') + ' attached' }));
  }

  function zoneProps(host, z) {
    host.appendChild(row('Name', textInput(z.label, (v) => { z.label = v; })));
    host.appendChild(row('Position', numberInput(z.x, 0.5, (v) => { z.x = v; }), numberInput(z.y, 0.5, (v) => { z.y = v; })));
    host.appendChild(row('Size (m)', numberInput(z.w, 0.5, (v) => { z.w = Math.max(0.5, v); }), numberInput(z.h, 0.5, (v) => { z.h = Math.max(0.5, v); })));
    host.appendChild(row('Colour', colorInput(z.color, (v) => { z.color = v; })));
    host.appendChild(checkInput('Hatched fill', z.hatch, (v) => { z.hatch = v; }));
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
    return el('div', {}, [
      el('div', { class: 'subhead', text: 'Actions' }),
      el('div', { class: 'btnrow' }, [
        button('Duplicate', () => app.duplicate()),
        button('Forward', () => app.reorder(1), '', 'Bring forward (])'),
        button('Back', () => app.reorder(-1), '', 'Send backward ([)'),
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
        const bar = el('div', { class: 'stat-bar' }, [
          el('span', { text: M.KINDS[k].name }),
          el('b', { text: String(s.byKind[k]) }),
        ]);
        const track = el('div', { class: 'track' });
        const fill = el('div', { class: 'fill' });
        fill.style.width = Math.round((s.byKind[k] / max) * 100) + '%';
        fill.style.background = M.KINDS[k].color;
        track.appendChild(fill);
        bar.appendChild(track);
        bars.appendChild(bar);
      }
      host.appendChild(bars);
    }
  };

  FB.ui = U;
})(window.FB);
