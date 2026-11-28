/**
 * UI probe CLI. Renders fixture notes in a hidden copy of the app and saves,
 * per fixture, under .ui-probe/<fixture>/:
 *   editor@<scale>x.png   the editor, cropped
 *   window@<scale>x.png   the whole window (with --window)
 *   report.json / report.txt   every rendered line's geometry and styles
 *
 *   npm run ui:probe -- [fixtures...] [--build] [--scale 2] [--width 1000] [--height 700]
 *                       [--theme dark|light] [--window] [--cursor <line>] [--eval "<js>"]
 *                       [--out .ui-probe]
 *
 * Fixtures are names in scripts/ui-probe/fixtures (without .md) or paths to
 * Markdown files; with none given, every bundled fixture is rendered. See
 * scripts/ui-probe/README.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchProbe, buildApp, formatReport } from './lib.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const fixturesDir = path.join(here, 'fixtures');

interface Args {
  fixtures: string[];
  build: boolean;
  window: boolean;
  scale: number;
  width: number;
  height: number;
  theme: string;
  evalExpr?: string;
  cursor?: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    fixtures: [],
    build: false,
    window: false,
    scale: 2,
    width: 1000,
    height: 700,
    theme: 'dark',
    out: path.join(repo, '.ui-probe')
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--build') args.build = true;
    else if (a === '--window') args.window = true;
    else if (a === '--scale') args.scale = Number(value());
    else if (a === '--width') args.width = Number(value());
    else if (a === '--height') args.height = Number(value());
    else if (a === '--theme') args.theme = value();
    else if (a === '--eval') args.evalExpr = value();
    else if (a === '--cursor') args.cursor = Number(value());
    else if (a === '--out') args.out = path.resolve(value());
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else args.fixtures.push(a);
  }
  return args;
}

function resolveFixture(name: string): { label: string; file: string } {
  const bundled = path.join(fixturesDir, name.endsWith('.md') ? name : `${name}.md`);
  if (fs.existsSync(bundled)) return { label: path.basename(bundled, '.md'), file: bundled };
  if (fs.existsSync(name)) return { label: path.basename(name, '.md'), file: path.resolve(name) };
  throw new Error(`No fixture "${name}" (looked in ${fixturesDir} and as a path)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.build) buildApp(repo);

  const names =
    args.fixtures.length > 0
      ? args.fixtures
      : fs
          .readdirSync(fixturesDir)
          .filter((f) => f.endsWith('.md'))
          .sort();

  for (const name of names) {
    const { label, file } = resolveFixture(name);
    const outDir = path.join(args.out, label);
    fs.rmSync(outDir, { recursive: true, force: true });

    const probe = await launchProbe({
      repo,
      note: fs.readFileSync(file, 'utf8'),
      width: args.width,
      height: args.height,
      scale: args.scale,
      settings: { theme: args.theme }
    });
    try {
      // Put the cursor at the end of a rendered line (1-based, as in the report):
      // that line then shows its raw markdown instead of widgets.
      if (args.cursor) await probe.placeCursorOnLine(args.cursor);
      const shots = [await probe.screenshot(path.join(outDir, `editor@${args.scale}x.png`))];
      if (args.window) {
        shots.push(
          await probe.screenshot(path.join(outDir, `window@${args.scale}x.png`), 'window')
        );
      }
      const report = await probe.editorReport();
      fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
      const text = formatReport(report);
      fs.writeFileSync(path.join(outDir, 'report.txt'), text + '\n');

      console.log(`\n== ${label} (${path.relative(repo, file)})`);
      for (const s of shots) console.log(`screenshot: ${path.relative(repo, s)}`);
      console.log(text);
      if (args.evalExpr) {
        console.log('eval:', JSON.stringify(await probe.evaluate(args.evalExpr), null, 2));
      }
    } finally {
      await probe.close();
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
