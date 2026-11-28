# UI probe

Renders notes in a hidden copy of Phosphor Notes and saves what the editor
actually drew - screenshots plus every line's geometry and styles - so editor
layout problems (task widgets, wrapping, hanging indents, nesting guides) can
be investigated and verified without poking around in DevTools by hand.

Each run uses a **fresh temporary profile** (`--user-data-dir`) and a **fixture
vault**, so it never touches your real settings or notes, and runs alongside a
copy of the app you already have open. The window is never shown
(`PHOSPHOR_HEADLESS=1`). Uses only the app's own Electron and Node 24.

## Running it

```sh
npm run ui:probe -- --build                 # build, then render every fixture
npm run ui:probe -- outliner-tasks           # one bundled fixture (uses the existing build)
npm run ui:probe -- path/to/note.md --scale 1 --width 700 --window
```

Options: `--build` (run `electron-vite build` first - needed after changing app
code), `--scale <n>` (device scale, default 2 = Retina), `--width`/`--height`
(viewport, default 1000x700), `--theme dark|light`, `--font-size <px>` and
`--line-height <n>` (the editor settings; default 16 and 1.5, the app's
defaults), `--set <setting>=<value>` (any other setting, e.g.
`--set showLineNumbers=true`; repeatable), `--window` (also capture
the whole window), `--cursor <line>` (click at the end of that rendered line
first, so it shows raw markdown as it does while you edit it), `--run "<js>"`
(run JS in the renderer before the screenshots, e.g. to open another view:
`--run "document.querySelector('[title^=Tasks]').click()" --window`),
`--eval "<js>"` (print the result of an expression in the renderer, after the
screenshots), `--out <dir>` (default `.ui-probe/`).

The vault also gets the task files in `fixtures/_tasks`, so the Tasks tab and
the daily-note task rollup have something to show.

The note under test becomes today's daily note, which is what the app opens.

## Output

For each fixture, in `.ui-probe/<fixture>/` (git-ignored):

- `editor@2x.png` - the editor, cropped.
- `window@2x.png` - the whole window, with `--window`.
- `report.json` - per rendered line: text (widgets shown as `[widget:class]`),
  box, `padding-left`, `text-indent`, nesting-guide columns, `rowStarts` (where
  each visual row's first character lands) and `rowBaselines`, and for every
  widget its box, its painted **ink** box (measured from the screenshot's
  pixels - for an icon, the drawing rather than its font box) and how far the
  ink's centre is from the cap-height middle of its text row. Plus the editor
  font, column width, cap height and x-height, and any `overlaps`.
- `report.txt` - the same as a compact table.

Reading `report.txt`:

- x positions are in **character columns** (`c`) from the line's left edge -
  `1c` is one character including the editor's letter-spacing, so a dash
  written at column 8 of the source shows as `8c`.
- `rows start at [14c, 14c]`: a wrapped row starting left of the first row's
  text isn't hanging-indented.
- `checkbox ... dy=-2px`: the checkbox is drawn 2px above the middle of the
  capital letters (negative = too high).
- `!!` lines flag problems: a widget overlapping text or another widget, a
  widget sticking out of its line, a line that isn't a whole number of rows
  tall (something made it taller), or an editor wider than the window.

## Scripting interactions

`lib.mts` exports `launchProbe()` for anything beyond a static render - click
a checkbox, type, press keys, move the cursor (`placeCursorOnLine`), resize,
then re-measure:

```ts
import { launchProbe, formatReport } from './scripts/ui-probe/lib.mts';

const probe = await launchProbe({ repo: process.cwd(), note: '- [ ] Task\n' });
await probe.click('.cm-task-checkbox');
await probe.settle();
console.log(formatReport(await probe.editorReport()));
await probe.screenshot('.ui-probe/after-click.png');
await probe.close();
```

Run it with `node my-script.mts`.

## Fixtures

`fixtures/*.md` hold generic sample notes covering the layouts that have
caused trouble. `fixtures/_assets/` is copied into every run's vault as its
`_assets` folder, so `![[embeds]]` resolve: generated test images (a wide
and a small PNG) and a one-page PDF. Add one for any new layout bug, using made-up content only
(this is a public repo - never real notes).
