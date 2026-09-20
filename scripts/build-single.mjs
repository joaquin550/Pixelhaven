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
  html = html.replace(
    new RegExp(`\\s*<link[^>]*href="[^"]*${escapeRegExp(name)}"[^>]*>`, 'g'),
    `\n    <style>\n${css}\n    </style>`,
  );
}

// Inline the bundle. `type="module"` is kept: the code uses import.meta, and
// every modern browser that can run WebGL2 can run a module script.
for (const name of assets.filter((f) => f.endsWith('.js'))) {
  const js = readFileSync(join(dist, 'assets', name), 'utf8');
  html = html.replace(
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
  html = html.replace(pattern, `<link rel="${rel}" href="data:image/png;base64,${data}" />`);
}
html = html.replace(/\s*<link rel="manifest"[^>]*>/, '');

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`wrote dist-single/pixel-haven.html (${kb} KB)`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
