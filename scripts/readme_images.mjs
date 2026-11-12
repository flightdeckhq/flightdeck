#!/usr/bin/env node
// Takes the README's images from a throwaway Flightdeck that
// scripts/demo_seed.py filled with invented agents. Never point it at a
// Flightdeck with real data: what it photographs is published.
//
// The whole procedure, from the repository root:
//
//   1. Build the binary with the dashboard in it:   make build-flightdeck
//   2. Start it on an empty data dir, on a port of its own:
//        FLIGHTDECK_RATE_LIMIT_PER_MINUTE=100000 bin/flightdeck \
//          --listen 127.0.0.1:4610 --data-dir "$(mktemp -d)"
//   3. Seed it and keep the open runs emitting:
//        python3 scripts/demo_seed.py --server http://127.0.0.1:4610 --live 300
//   4. A minute after the seed prints "runs left open" (the markers of
//      the seeded history have then left the fleet view's window):
//        node scripts/readme_images.mjs --server http://127.0.0.1:4610 \
//          --out assets/readme --video /tmp/fleet-video
//   5. Turn the recording into the GIF (any ffmpeg; two passes so the
//      palette is the recording's own):
//        ffmpeg -ss 3 -t 9 -i /tmp/fleet-video/fleet.webm -vf "fps=10,scale=800:-1:flags=lanczos,palettegen=max_colors=80:stats_mode=full" palette.png
//        ffmpeg -ss 3 -t 9 -i /tmp/fleet-video/fleet.webm -i palette.png -lavfi "fps=10,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" assets/readme/fleet-live.gif
//      (-ss 3 skips the page loading. Nine seconds at ten frames a
//      second, 800 pixels wide and 80 colours keep it near 2.5 MB: the
//      timeline scrolls, so every frame differs from the last.)
//   6. Shrink the stills to 256 colours (pngquant --strip, or
//      Pillow's quantize with no dithering, then oxipng), and look at
//      every image before committing it: no real name, no empty state,
//      nothing cut off, both themes legible.
//
// What it writes into --out, each in a light and a dark variant:
//   fleet-{light,dark}.png          the fleet view, the README's hero
//   tile-timeline-{light,dark}.png  a detail of the fleet timeline
//   tile-agents-{light,dark}.png    the agents table, tokens to cost
//   tile-policies-{light,dark}.png  the MCP rules of one agent
// and, with --video, <dir>/fleet.webm: the fleet view in the dark theme,
// loading and then twelve seconds of events arriving.
//
// Playwright comes from the dashboard's node_modules (--dashboard, by
// default the dashboard/ beside this script's directory), so nothing
// is installed for this script alone.
//
// It refuses a server on port 4000 unless --allow-default-port is
// given, and any server whose fleet is not the seeded one.
import { createRequire } from 'node:module';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The port a Flightdeck with real data usually listens on.
const DEFAULT_PORT = '4000';

// The token a loopback flightdeck accepts, used for the fleet check.
const DEV_TOKEN = 'tok_dev';

// Every agent name the seed creates. A fleet with any other name in it
// is not the seeded one, and is not photographed.
const SEEDED_AGENTS = new Set([
  'support-triage', 'code-review', 'invoice-extractor', 'research-assistant',
  'sql-analyst', 'alex@dev-laptop', 'onboarding-bot',
]);

// The stills are taken at twice the CSS size so they stay sharp on a
// high-density screen; the viewport is a common laptop's.
const VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 2;

// The three tiles share one shape, so they line up in the README's row.
const TILE_ASPECT = 2;
const TILE_WIDTH = 1100;

// Where the fleet view's timeline begins: right of the sidebar, below
// the range and filter bars, at the time axis. The tile's viewport is
// as wide as the sidebar and the tile together, so the tile runs to
// the page's right edge and ends on the "now" line.
const TIMELINE_ORIGIN = { x: 240, y: 128 };
const TIMELINE_VIEWPORT = { width: TIMELINE_ORIGIN.x + TILE_WIDTH, height: VIEWPORT.height };

// The policies page laid out at the tile's own width, so no column is
// cut; its content starts below the navigation bar.
const POLICIES_ORIGIN = { x: 0, y: 52 };
const POLICIES_VIEWPORT = { width: TILE_WIDTH, height: VIEWPORT.height };

// The agents table needs this much width to show its cost column,
// which is where its tile ends.
const AGENTS_VIEWPORT = { width: 1660, height: 900 };
const AGENTS_LAST_COLUMN = 'COST (7D)';

// How long a page gets to settle after its network goes quiet: the
// fleet view animates new events in, and the sparklines draw late.
const SETTLE_MS = 2500;

// The recording: long enough to see events arrive on every row, short
// enough to stay a small GIF.
const VIDEO_SECONDS = 12;

const THEME_STORAGE_KEY = 'flightdeck-theme';
const THEMES = ['light', 'dark'];

const { values: args } = parseArgs({
  options: {
    server: { type: 'string' },
    out: { type: 'string' },
    dashboard: { type: 'string' },
    video: { type: 'string' },
    'allow-default-port': { type: 'boolean', default: false },
  },
});

function fail(message) {
  console.error(`readme-images: ${message}`);
  process.exit(2);
}

if (!args.server || !args.out) {
  fail('usage: node scripts/readme_images.mjs --server http://127.0.0.1:4610 --out assets/readme [--video DIR] [--dashboard DIR]');
}
const server = args.server.replace(/\/+$/, '');
if (new URL(server).port === DEFAULT_PORT && !args['allow-default-port']) {
  fail(`${server} is on port ${DEFAULT_PORT}, where a Flightdeck with real data usually listens; photograph a throwaway one (see this script's header)`);
}

// The fleet must be the seeded one, all of it and nothing else.
const fleetResponse = await fetch(`${server}/api/v1/fleet?per_page=100`, {
  headers: { Authorization: `Bearer ${DEV_TOKEN}` },
}).catch((error) => fail(`cannot reach ${server}: ${error.message}`));
if (!fleetResponse.ok) fail(`${server}/api/v1/fleet answered ${fleetResponse.status}`);
const fleet = await fleetResponse.json();
const names = new Set(fleet.agents.map((agent) => agent.agent_name));
const strangers = [...names].filter((name) => !SEEDED_AGENTS.has(name));
if (strangers.length > 0) {
  fail(`${server} has agents the seed did not create (${strangers.length}); it is not a throwaway instance`);
}
if (names.size < SEEDED_AGENTS.size) {
  fail(`${server} has ${names.size} of the ${SEEDED_AGENTS.size} seeded agents; run scripts/demo_seed.py first`);
}
const active = fleet.agents.filter((agent) => agent.state === 'active').length;
if (active === 0) {
  fail('no agent is active: run scripts/demo_seed.py with --live so the fleet view has events arriving');
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(args.dashboard ?? path.join(scriptDir, '..', 'dashboard'));
const require = createRequire(path.join(dashboardDir, 'package.json'));
const { chromium } = require('playwright');

const outDir = path.resolve(args.out);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', headless: true });

// A page in one theme. The dashboard keeps its theme in localStorage,
// so it is set before the first script of the page runs.
async function open(theme, options = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: theme,
    ...options,
  });
  await context.addInitScript(
    ([key, value]) => { window.localStorage.setItem(key, value); },
    [THEME_STORAGE_KEY, theme],
  );
  const page = await context.newPage();
  return { context, page };
}

async function settle(page, url) {
  await page.goto(`${server}${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(SETTLE_MS);
}

function tileClip(x, y) {
  return { x, y, width: TILE_WIDTH, height: Math.round(TILE_WIDTH / TILE_ASPECT) };
}

for (const theme of THEMES) {
  const { context, page } = await open(theme);

  // The hero: the fleet view with events arriving.
  await settle(page, '/');
  await page.screenshot({ path: path.join(outDir, `fleet-${theme}.png`) });

  // The timeline detail: from the timeline's left edge, below the
  // filter bar, so it holds the agent rows and their events.
  await page.setViewportSize(TIMELINE_VIEWPORT);
  await settle(page, '/');
  await page.screenshot({
    path: path.join(outDir, `tile-timeline-${theme}.png`),
    clip: tileClip(TIMELINE_ORIGIN.x, TIMELINE_ORIGIN.y),
  });

  // The MCP rules of the research assistant: an allowed server and a
  // denied one.
  await page.setViewportSize(POLICIES_VIEWPORT);
  await settle(page, '/policies');
  await page.getByText('MCP Protection', { exact: true }).click();
  await page.getByText('Global', { exact: true }).first().click();
  await page.getByText('research-assistant', { exact: true }).first().click();
  await page.getByText('scratch-fs', { exact: true }).first().waitFor();
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({
    path: path.join(outDir, `tile-policies-${theme}.png`),
    clip: tileClip(POLICIES_ORIGIN.x, POLICIES_ORIGIN.y),
  });

  // The agents table, from its first column to the end of the cost
  // column.
  await page.setViewportSize(AGENTS_VIEWPORT);
  await settle(page, '/agents');
  const table = await page.locator('table').first().boundingBox();
  const lastColumn = await page
    .locator('th', { hasText: AGENTS_LAST_COLUMN })
    .first()
    .boundingBox();
  const width = Math.round(lastColumn.x + lastColumn.width - table.x);
  await page.screenshot({
    path: path.join(outDir, `tile-agents-${theme}.png`),
    clip: { x: table.x, y: table.y, width, height: Math.round(width / TILE_ASPECT) },
  });

  await context.close();
}

if (args.video) {
  const videoDir = path.resolve(args.video);
  await mkdir(videoDir, { recursive: true });
  const { context, page } = await open('dark', {
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  await settle(page, '/');
  await page.waitForTimeout(VIDEO_SECONDS * 1000);
  const video = page.video();
  await context.close();
  const target = path.join(videoDir, 'fleet.webm');
  await rm(target, { force: true });
  await rename(await video.path(), target);
  console.log(`recorded ${target}`);
}

await browser.close();
console.log(`wrote the stills to ${outDir}`);
