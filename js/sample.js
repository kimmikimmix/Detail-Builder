/* An example layout so the canvas is never empty on a first visit. */
(function (FB) {
  'use strict';

  const M = FB.model;

  FB.sample = function sample() {
    const doc = M.newDoc();
    doc.name = 'Example Plant — Line A';
    const add = (it) => { doc.items.push(it); return it; };

    /* --- zones --- */
    const zone = (x, y, w, h, label, color) => {
      const z = M.zone(x, y, w, h, label);
      z.color = color;
      return add(z);
    };
    zone(1, 1, 11, 26, 'Receiving & Raw Storage', '#64748b');
    zone(14, 1, 16, 12, 'Machining Cell', '#4f9cf9');
    zone(14, 15, 16, 12, 'Assembly', '#10b981');
    zone(32, 1, 15, 26, 'Finishing & Shipping', '#f59e0b');

    /* --- building shell --- */
    const shell = M.wall([
      { x: 0, y: 0 }, { x: 48, y: 0 }, { x: 48, y: 28 }, { x: 0, y: 28 },
    ], 0.35);
    shell.closed = true;
    add(shell);

    /* Interior wall with a doorway between the warehouse and the shop floor. */
    add(M.wall([{ x: 13, y: 0 }, { x: 13, y: 10 }], 0.25));
    add(M.wall([{ x: 13, y: 16 }, { x: 13, y: 28 }], 0.25));
    add(M.wall([{ x: 31, y: 0 }, { x: 31, y: 9 }], 0.25));
    add(M.wall([{ x: 31, y: 15 }, { x: 31, y: 28 }], 0.25));

    /* --- machines --- */
    const mk = (kind, x, y, label, opts) => {
      const m = M.machine(kind, x, y);
      if (label) m.label = label;
      Object.assign(m, opts || {});
      return add(m);
    };

    const receiving = mk('dock', 2, 2, 'Receiving Dock');
    const rack1 = mk('rack', 2.5, 7, 'Raw Rack 1');
    const rack2 = mk('rack', 2.5, 9.5, 'Raw Rack 2');
    const rack3 = mk('rack', 2.5, 12, 'Raw Rack 3');
    const buffer = mk('buffer', 3, 17, 'Raw WIP Buffer');

    const cnc1 = mk('cnc', 15, 3, 'CNC 1');
    const cnc2 = mk('cnc', 19.5, 3, 'CNC 2');
    const cnc3 = mk('cnc', 24, 3, 'CNC 3');
    const lathe = mk('lathe', 15, 8, 'Lathe 1');
    const press = mk('press', 19.5, 8, 'Press 1');
    const robot = mk('robot', 24, 8, 'Robot Cell', { clearance: 0.75 });

    const conveyor = mk('conveyor', 16, 13.6, 'Transfer Conveyor', { w: 11 });

    const asm1 = mk('assembly', 16, 17, 'Assembly 1');
    const asm2 = mk('assembly', 16, 20, 'Assembly 2');
    const asm3 = mk('assembly', 16, 23, 'Assembly 3');
    const qc = mk('qc', 24, 17, 'QC Station');

    const paint = mk('paint', 34, 3, 'Paint Booth');
    const oven = mk('oven', 34, 9, 'Cure Oven');
    const packing = mk('packing', 34, 14, 'Packing');
    const fg1 = mk('rack', 34, 18, 'Finished Goods 1');
    const fg2 = mk('rack', 34, 20.5, 'Finished Goods 2');
    const shipping = mk('dock', 42, 23, 'Shipping Dock');

    mk('office', 44, 2, 'Line Office');
    mk('utility', 44, 6, 'Panel A');

    /* --- material flow --- */
    const link = (a, b, label, color, waypoints) => {
      const r = M.route(M.endpointOn(a.id), M.endpointOn(b.id), waypoints);
      if (label) r.label = label;
      if (color) r.color = color;
      return add(r);
    };

    /* Racks feed the buffer down the aisle at x = 10 rather than straight
       through each other. */
    link(receiving, rack1, 'inbound');
    link(rack1, buffer, '', '', [{ x: 9.6, y: 8.6 }, { x: 9.6, y: 17.4 }]);
    link(rack2, buffer, '', '', [{ x: 10.1, y: 11.1 }, { x: 10.1, y: 18 }]);
    link(rack3, buffer, '', '', [{ x: 10.6, y: 13.6 }, { x: 10.6, y: 18.6 }]);
    link(buffer, cnc1, 'to machining', '', [{ x: 13.5, y: 13 }]);
    link(cnc1, cnc2);
    link(cnc2, cnc3);
    link(cnc3, robot);
    link(lathe, robot);
    link(press, robot);
    link(robot, conveyor);
    link(conveyor, asm1, 'to assembly', '#10b981');
    link(asm1, asm2, '', '#10b981');
    link(asm2, asm3, '', '#10b981');
    link(asm3, qc, '', '#10b981');
    link(qc, paint, 'to finishing', '#8b5cf6', [{ x: 31.5, y: 12 }]);
    link(paint, oven, '', '#8b5cf6');
    link(oven, packing, '', '#8b5cf6');
    link(packing, fg1, '', '#8b5cf6');
    link(fg1, shipping, 'outbound', '#0ea5e9');
    link(fg2, shipping, '', '#0ea5e9');

    /* --- annotations --- */
    const text = (x, y, str, size) => {
      const l = M.label(x, y, str);
      if (size) l.size = size;
      return add(l);
    };
    text(24, -1.2, 'EXAMPLE PLANT — LINE A   ·   48 × 28 m', 1.1);
    text(11.6, 14.8, 'DOORWAY', 0.5);
    text(29.4, 13.8, 'DOORWAY', 0.5);

    return doc;
  };
})(window.FB);
