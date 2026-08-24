# Factory Layout Builder

A browser-based tool for drawing factory floor layouts: drag out machines, wire
them together with material-flow routes, cascade a machine into a whole line,
and enclose it all with walls and zones.

No build step, no dependencies, no server. Grab the single-file build
`factory-layout-builder.html` and double-click it, or open `index.html` from a
full checkout.

![The builder with the example plant loaded](docs/screenshot.png)

## Running it

**One file, nothing else needed** — download `factory-layout-builder.html` and
double-click it. Everything (styles, scripts, the example plant) is inlined.

**From the repo** — `index.html` loads `css/` and `js/` from alongside it, so
keep the whole folder together:

```
git clone https://github.com/kimmikimmix/Detail-Builder.git
cd Detail-Builder
git checkout claude/factory-layout-builder-1kqv53
open index.html          # macOS — or just double-click the file
```

> Saving `index.html` on its own (right-click → Save as, or downloading the
> single file from GitHub) gives you an unstyled page of plain text and
> buttons: the browser can't find `css/style.css` or the `js/` files. Use the
> standalone file above, or keep the folder intact.

Any static server works too, e.g. `npx http-server -p 8080 .`

After editing anything under `css/` or `js/`, regenerate the standalone file:

```
node tools/build-standalone.js
```

## What you can draw

| Item | How |
| --- | --- |
| **Machine** | Pick a type in the palette, then drag a box on the canvas — or click once for the default size, or drag the palette entry straight onto the canvas. |
| **Route** | Click the source machine then the destination, or just drag from one to the other. Click empty space mid-route to add a bend. Routes stay attached when you move the machines. |
| **Wall** | Click each corner and press <kbd>Enter</kbd> (or double-click) to finish. Drag for a single straight run. Hold <kbd>Shift</kbd> to lock to 45°. |
| **Room** | Drag a rectangle to get four walls at once. |
| **Zone** | Drag out a named area (machining cell, warehouse, assembly). Zones sit behind everything and only catch clicks on their border or title, so machines inside stay grabbable. |
| **Text** | Click to drop an annotation. |
| **Measure** | Drag to read a distance, plus its Δx / Δy. |

Sixteen machine types ship in the palette — CNC, lathe, press, injection
molder, robot cell, assembly station, conveyor, oven, paint booth, QC, packing,
storage rack, WIP buffer, loading dock, office and utility panel — each with a
sensible default footprint in metres. Any machine can be resized, rotated, and
recoloured, and given a clearance halo for the space it needs around it.

### Cascading

Select one or more machines, then use the **Cascade** panel: choose a copy
count, a direction, the gap between copies and an optional perpendicular
stagger. Tick *Connect with routes* and the copies come out already wired in
sequence; tick *Number the copies* and they are named `CNC 1`, `CNC 2`, … It is
the fastest way to lay down a production line or a bank of identical cells.

**Chain routes** (shown when several machines are selected) does the same
wiring for machines you placed by hand, in left-to-right order.

### Everything is in metres

The grid is 1 m with a heavier line every 5 m, and there is a scale bar in the
corner. Sizes, route lengths, wall runs, zone areas and floor density are all
reported in the Layout stats panel as you build.

## Keyboard

| | |
| --- | --- |
| <kbd>V</kbd> <kbd>M</kbd> <kbd>W</kbd> <kbd>R</kbd> <kbd>E</kbd> <kbd>Z</kbd> <kbd>T</kbd> <kbd>K</kbd> <kbd>H</kbd> | Select, Machine, Wall, Room, routE, Zone, Text, measure (K), Hand/pan |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>V</kbd> / <kbd>D</kbd> / <kbd>A</kbd> | Copy, paste (at the cursor), duplicate, select all |
| <kbd>Delete</kbd> | Delete the selection — routes attached to a deleted machine go with it |
| <kbd>Enter</kbd> | Finish a wall or route · rename the selected item |
| <kbd>Esc</kbd> | Cancel the current drawing, or clear the selection |
| Arrows | Nudge by ⅕ grid, or a full grid step with <kbd>Shift</kbd> |
| <kbd>[</kbd> / <kbd>]</kbd> | Send backward / bring forward |
| <kbd>F</kbd> | Zoom to fit |
| <kbd>Shift</kbd>+click | Add to / remove from the selection |
| <kbd>Alt</kbd>+drag | Ignore grid snapping for this drag |
| <kbd>Space</kbd>+drag, or middle-drag | Pan · scroll wheel zooms at the cursor |

Double-click a machine, zone or label to rename it in place. Double-click a
route or a wall to add a bend or a corner where you clicked.

## Saving

The layout autosaves to `localStorage`, so a reload picks up where you left
off. **Save** downloads a portable `*.factory.json`, **Open** reads one back,
and **PNG** exports the whole floor as an image. **Example** loads a worked
48 × 28 m plant if you want something to poke at.

## Project layout

```
index.html                     markup and panel scaffolding
factory-layout-builder.html    generated single-file build (do not edit)
tools/build-standalone.js      inlines everything into that file
css/style.css                  all styling
js/geometry.js                 vector maths — rotation, hit tests, polylines
js/model.js                    the document: item factories, route paths, (de)serialisation
js/history.js                  snapshot undo/redo
js/render.js                   canvas drawing and PNG export
js/tools.js                    pointer interaction for every tool
js/sample.js                   the example plant
js/ui.js                       palette, properties panel, stats
js/app.js                      state, actions, keyboard, persistence, bootstrap
```

Plain ES5-compatible scripts sharing a `window.FB` namespace — deliberately no
modules, so the page works straight off the filesystem.

## File format

A layout is a JSON document of positioned items:

```json
{
  "version": 1,
  "name": "Example Plant — Line A",
  "grid": 1,
  "items": [
    { "id": "i1", "type": "machine", "kind": "cnc", "x": 15, "y": 3,
      "w": 3, "h": 2, "rot": 0, "label": "CNC 1", "color": "#3b82f6" },
    { "id": "i2", "type": "wall", "points": [{"x":0,"y":0},{"x":48,"y":0}],
      "thickness": 0.35, "closed": false },
    { "id": "i3", "type": "route", "from": {"item":"i1"}, "to": {"x":20,"y":9},
      "waypoints": [], "mode": "ortho", "arrows": "end" }
  ]
}
```

Route endpoints are either `{"item": "<id>"}` — docked to a machine and
recalculated whenever it moves — or a fixed `{"x": …, "y": …}` point. Unknown
or malformed items are dropped on load rather than breaking the file.
