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
(viewport, default 1000x700), `--theme dark|light`, `--window` (also capture
the whole window), `--eval "<js>"` (print the result of an expression in the
renderer), `--out <dir>` (default `.ui-probe/`).

The note under test becomes today's daily note, which is what the app opens.

## Output

For each fixture, in `.ui-probe/<fixture>/` (git-ignored):

- `editor@2x.png` - the editor, cropped.
- `window@2x.png` - the whole window, with `--window`.
- `report.json` - per rendered line: text (widgets shown as `[widget:class]`),
  box, `padding-left`, `text-indent`, nesting-guide columns, every widget's
  box, and `rowStarts`: where each visual row's first character lands, in px
  from the content edge. Plus the editor font, `ch` width, and line height.
- `report.txt` - the same as a compact table, one line per editor line.

`rowStarts` is the quickest way to see wrapping problems: a wrapped row that
starts further left than the first row isn't hanging-indented.

## Scripting interactions

`lib.mts` exports `launchProbe()` for anything beyond a static render - click
a checkbox, type, press keys, resize, then re-measure:

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
caused trouble. Add one for any new layout bug, using made-up content only
(this is a public repo - never real notes).
