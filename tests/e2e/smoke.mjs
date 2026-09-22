/**
 * Browser smoke test.
 *
 * Boots the built game in headless Chromium, plays a few minutes of it, and
 * fails on any console error, unhandled rejection or WebGL problem. It catches
 * the class of bug unit tests never will: a shader that will not compile, a
 * geometry wound inside out, a tap handler wired to nothing.
 *
 *   npm run build
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(fileURLToPath(new URL('../../', import.meta.url)), 'dist');
const PORT = Number(process.env.PORT ?? 4319);

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

const failures = [];
let browser;

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  // An iPad Pro in landscape, which is what this was built for.
  const page = await browser.newPage({ viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2 });

  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const tap = async (selector, x = 10, y = 10) => {
    const node = page.locator(selector).first();
    await node.dispatchEvent('pointerdown', { clientX: x, clientY: y });
    await node.dispatchEvent('pointerup', { clientX: x, clientY: y });
  };

  await tap('.title-button', 600, 500);
  await page.waitForTimeout(2500);

  const handle = await page.evaluate(() => typeof window.pixelHaven);
  assert(handle === 'object', 'debug handle is missing, so the game never booted');

  // Sculpt the way a player would: open the drawer, pick a tool, press and
  // drag across the ground, lift.
  await page.evaluate(() => {
    // Enough to build with, but well under capacity - a full storehouse
    // legitimately stops everybody gathering.
    window.pixelHaven.haven.resources = { wood: 80, stone: 40, food: 60, tools: 0 };
    const origin = window.pixelHaven.haven.origin;
    window.pixelHaven.scene.rig.focusOn(origin.x, origin.z, 26);
  });
  // Wait for the camera to actually arrive. It eases towards its target one
  // rendered frame at a time, and a software-GL CI runner renders few of them,
  // so a fixed sleep here is a coin flip.
  await page
    .waitForFunction(() => window.pixelHaven.scene.rig.cameraDistance < 30, null, { timeout: 30000 })
    .catch(() => {});

  await page.evaluate(() => {
    // Plenty of Favor, so the stroke is not refused for being unaffordable.
    window.pixelHaven.haven.favor = 500;
  });
  await tap('.fab', 540, 800);
  await page.waitForTimeout(500);
  await tap('.card', 300, 700);
  await page.waitForTimeout(400);

  const heightsBefore = await page.evaluate(() =>
    Array.from(window.pixelHaven.haven.terrain.heights),
  );

  // Drag across the middle of the view. Wherever that lands on the island,
  // the ground should move.
  await page.mouse.move(560, 400);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.move(640, 440, { steps: 10 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(500);

  const moved = await page.evaluate((before) => {
    const now = window.pixelHaven.haven.terrain.heights;
    let count = 0;
    for (let i = 0; i < now.length; i++) if (now[i] !== before[i]) count++;
    return count;
  }, heightsBefore);
  assert(moved > 0, 'dragging the raise tool across the island moved no ground');

  // Run at speed until somebody has completed a full fell-it-and-carry-it-home
  // cycle. Polling rather than sleeping: the simulation advances per rendered
  // frame, so how much world time a wall-clock second buys depends on the
  // machine.
  await page.keyboard.press('4');
  await page
    .waitForFunction(() => window.pixelHaven.haven.stats.resourcesGathered > 0, null, {
      timeout: 120000,
    })
    .catch(() => {});

  const health = await page.evaluate(() => {
    const haven = window.pixelHaven.haven;
    return {
      day: haven.clock.day,
      villagers: haven.villagers.length,
      offMap: haven.villagers.filter((v) => !Number.isFinite(v.x) || !Number.isFinite(v.z)).length,
      // Standing inside a footprint you just had built around you is fine -
      // they walk straight back out. Standing in the sea is not.
      inSea: haven.villagers.filter((v) => !haven.terrain.isLand(v.cellX, v.cellZ)).length,
      gathered: haven.stats.resourcesGathered,
      structures: haven.structures.structures.length,
    };
  });
  assert(health.offMap === 0, 'a villager left the world');
  assert(health.inSea === 0, 'a villager ended up somewhere unwalkable');
  assert(health.gathered > 0, 'nobody gathered anything');
  assert(health.structures > 0, 'the village never decided to build anything of its own');

  // Selecting somebody should open the inspector.
  await page.evaluate(() => window.pixelHaven.select(window.pixelHaven.haven.villagers[0].id));
  await page.waitForTimeout(500);
  const inspectorOpen = await page.locator('.inspector.is-open').count();
  assert(inspectorOpen === 1, 'the inspector did not open for a selected villager');

  // A save should survive a reload.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const reloaded = await page.evaluate(() => ({
    structures: window.pixelHaven.haven.structures.structures.length,
    villagers: window.pixelHaven.haven.villagers.length,
  }));
  assert(reloaded.structures > 0, 'the save lost its buildings');
  assert(reloaded.villagers > 0, 'the save lost its villagers');

  console.log('smoke: ok', JSON.stringify({ ...health, reloaded }));
} finally {
  await browser?.close();
  server.close();
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

if (failures.length > 0) {
  console.error('smoke: FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
