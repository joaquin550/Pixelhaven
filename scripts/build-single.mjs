/**
 * Builds Pixel Haven as one self-contained .html file.
 *
 * Everything - the game, three.js, the stylesheet, the icons - ends up inline,
 * so the result runs from a file share, an email attachment, or any host that
 * will serve a single page. No directory structure to preserve, nothing to
 * fetch, and it still works with the network off.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const outDir = join(root, 'dist-single');
const outFile = join(outDir, 'pixel-haven.html');

console.log('building…');
execFileSync('npx', ['vite', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SINGLE_FILE: '1' },
});

let html = readFileSync(join(dist, 'index.html'), 'utf8');
const assets = readdirSync(join(dist, 'assets'));

// Inline the stylesheet.
for (const name of assets.filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(join(dist, 'assets', name), 'utf8');
  html = replaceAll(
    html,
    new RegExp(`\\s*<link[^>]*href="[^"]*${escapeRegExp(name)}"[^>]*>`, 'g'),
    `\n    <style>\n${css}\n    </style>`,
  );
}

// Inline the bundle. `type="module"` is kept: the code uses import.meta, and
// every modern browser that can run WebGL2 can run a module script.
for (const name of assets.filter((f) => f.endsWith('.js'))) {
  const js = readFileSync(join(dist, 'assets', name), 'utf8');
  html = replaceAll(
    html,
    new RegExp(`\\s*<script[^>]*src="[^"]*${escapeRegExp(name)}"[^>]*>\\s*</script>`, 'g'),
    `\n    <script type="module">\n${js}\n    </script>`,
  );
}

// Inline the icons as data URIs and drop the manifest, which has nothing to
// point at once the file is on its own.
for (const [pattern, file] of [
  [/<link rel="icon"[^>]*>/, 'favicon.png'],
  [/<link rel="apple-touch-icon"[^>]*>/, 'apple-touch-icon.png'],
]) {
  const data = readFileSync(join(root, 'public', 'icons', file)).toString('base64');
  const rel = file === 'favicon.png' ? 'icon' : 'apple-touch-icon';
  html = replaceAll(html, pattern, `<link rel="${rel}" href="data:image/png;base64,${data}" />`);
}
html = replaceAll(html, /\s*<link rel="manifest"[^>]*>/, '');

verify(html);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`wrote dist-single/pixel-haven.html (${kb} KB)`);

/**
 * Substitutes without letting `$` mean anything.
 *
 * This is the whole reason this helper exists. A *string* replacement passed
 * to String.replace treats `$&`, `$\``, `$'` and `$<` as references to parts of
 * the match, and a minified JavaScript bundle is full of those sequences. Used
 * naively, inlining the bundle splices the surrounding document back into
 * itself - which shipped a broken build once. A replacement *function* is
 * handed the text verbatim.
 */
function replaceAll(source, pattern, replacement) {
  return source.replace(pattern, () => replacement);
}

/**
 * Refuses to write a file that is not actually self-contained.
 *
 * Cheap, and it turns the failure mode above from "the page silently does not
 * boot on someone else's device" into "the build stops".
 */
function verify(output) {
  const problems = [];

  // Check the markup only. The bundle itself legitimately contains things
  // that look like markup - the icon helper builds SVG from a template
  // literal - so script bodies are stripped before looking.
  const markup = output.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>');

  const external = markup.match(/<(script|link)[^>]*(src|href)="(?!data:)[^"]*"/g) ?? [];
  for (const tag of external) problems.push(`still references something external: ${tag.slice(0, 90)}`);

  const scripts = (output.match(/<script\b/g) ?? []).length;
  if (scripts > 2) problems.push(`${scripts} script tags - the bundle was spliced in more than once`);

  if (/<svg[^>]*(width|height)="\$\{/.test(markup)) {
    problems.push('a `${...}` leaked into markup - a `$` substitution corrupted the output');
  }

  if (problems.length > 0) {
    console.error('build-single produced a broken file:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
