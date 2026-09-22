# Pixel Haven

A 2.5D idle life simulator. Pixel-art villagers build and live on a procedurally
generated voxel island while you watch over them. Nothing in it needs you —
which is the point.

Built to be played on an iPad: it runs in Safari, installs to the Home Screen,
and works offline.

![the haven](public/icons/icon-512.png)

## What it is

You do not place buildings. You move earth.

Villagers decide everything for themselves: what to chop, what to plant, who to
talk to, when to go to bed, and what the village needs built next. What you
control is the island they are standing on. Flatten a shelf on the hillside and
they will eventually settle it, because flat dry ground is the only invitation
they understand. Raise a ridge and they will not cross it — they can scramble
down a cliff but only climb a single voxel, so a wall you pull out of the
ground is a wall in one direction. Scoop a hollow below the waterline and the
sea comes in, and in time somebody builds a dock on it.

Nothing is ever ordered. The land is the instruction.

- **The island.** 96×96 voxel columns generated from a seed: a warped radial
  coastline, a carved meandering river, beaches, cliffs, and a ridge of
  mountains. Trees, boulders and bushes sit *off* the grid, at their own
  positions, rotations and scales, so a blocky island never reads as graph paper.
- **The land is the only lever.** Three earth-moving tools and a brush size,
  paid for in Favor, which a contented village earns faster than a miserable
  one. Heaving ground uproots whatever was rooted in it, and the timber and
  stone go to the stockpile, so reshaping is also clearing.
- **The villagers.** Two traits each out of eighteen, four needs, real
  friendships, and a utility-scored state machine covering idle, work and
  social behaviour. A Lazy villager still gets it done, with more naps on the way.
- **They get better.** Every job has a proficiency that grows with practice
  and slows as it rises, so after a few weeks the haven has a forester, a
  mason and a builder that nobody assigned. Skill pays out in speed, in yield,
  and in what they choose to do next.
- **The paths are not designed.** Every step wears the ground a little, wear
  fades, and routes that get walked often enough turn into trails that are
  quicker to cross and cheaper to route along. Desire paths appear between the
  storehouse and the woods because that is where people walk, and the grass
  grows back over the ones they abandon.
- **Tools.** The Workshop turns wood and stone into them; the Longhouse and
  the Shrine need them; and a stocked toolshed makes everyone quicker at
  everything, up to a point.
- **The seasons.** Spring blossom, summer fireflies, autumn turning the oaks
  orange, snow settling on every upward-facing surface in winter. All of it is
  cosmetic by design: Pixel Haven never punishes you for looking away.
- **The sound.** Entirely synthesised at runtime — a slow generative pentatonic
  pad that never loops, plus wind, surf, birdsong, crickets, fire and village
  chatter that fade up as you push the camera in.

## Playing it on an iPad

**Option 1 — from your computer, over your home Wi-Fi**

```bash
npm install
npm run dev
```

Vite prints a `Network:` address like `http://192.168.1.24:5173`. Open that in
Safari on the iPad. Both devices need to be on the same network.

**Option 2 — deploy it, then add it to the Home Screen**

```bash
npm run build     # outputs a static site to dist/
```

`dist/` is plain static files with relative paths, so it will run on anything
that serves files.

**GitHub Pages** is the setup this repo is wired for.
`.github/workflows/deploy.yml` builds and publishes on every push. Two
one-time settings:

1. **Settings → General → Danger Zone → Change visibility → Make public.**
   Pages is free on public repositories and needs a paid plan on private ones.
2. **Settings → Pages → Source: GitHub Actions.** A workflow's token is not
   allowed to switch this on for you.

The next push then publishes to `https://<user>.github.io/<repo>/`.

**One file, no hosting at all**

```bash
npm run build:single    # -> dist-single/pixel-haven.html
```

Everything — the game, three.js, the stylesheet, the icons — inlined into a
single ~650 KB `.html` with no external requests. Put it anywhere that serves
one page, keep it in a file share, or mail it to yourself.

If you would rather not make the repository public:

- **Netlify Drop** (`app.netlify.com/drop`) — drag the `dist` folder or a zip of
  it onto the page. No account, no config, instant URL, but it does not update
  itself when the code changes.
- **Netlify, Vercel or Cloudflare Pages connected to the repo** — all three
  build private repositories on their free tiers, and all three redeploy on
  push. Build command `npm run build`, publish directory `dist`.

Once it is on a URL, open it in Safari and tap **Share → Add to Home Screen**.
It then launches full screen with no browser chrome, keeps its save, and runs
with no network connection.

## Controls

| Gesture | What it does |
| --- | --- |
| One finger, drag | Turn the island |
| Two fingers, pinch | Zoom in and out |
| Two fingers, slide | Pan across the island |
| Two fingers, twist | Spin the view |
| Tap a villager | See who they are and what they are doing |
| Double-tap | Focus and push in on that spot |
| **Shape** → a tool, then press and drag | Raise, lower or flatten the ground |
| **Favor** | Spend what the haven's good mood earns you |

On a desktop: left-drag orbits, the scroll wheel zooms, `space` pauses, `1`–`4`
set the speed, `Escape` cancels.

## How it fits together

```
src/
  core/        seeded RNG, Perlin noise, maths, the world clock, an event bus
  world/       the height field, sculpting, footfall, props, A* navigation
  sim/         villagers, traits, the brain, the planner that decides what to
               build, and Haven — the simulation root
  build/       blueprint definitions and the structures they become
  render/      terrain mesher, water, instanced props, buildings, sprites,
               trails, smoke, ground detail, sky and weather, the touch
               camera, and the scene that drives them
  audio/       the whole soundtrack, synthesised
  ui/          HUD, build drawer, inspector, overlays, pixel icons
  state/       save, load, and offline catch-up
```

A few decisions worth knowing about:

- **Terrain is a height field, not a voxel volume.** There are no overhangs, so
  one integer height plus one material per column describes the world exactly.
  The mesher emits one top quad per column and a side quad wherever a neighbour
  sits lower — roughly a tenth of the triangles a full voxel mesher would, which
  is the difference between 60fps and a slideshow on a tablet.
- **Seasons are a shader uniform.** Baking autumn into vertex colours would mean
  re-meshing the island every time the palette shifted. Instead each vertex
  carries a two-component "how much does this surface care about the weather"
  weight, and a whole year passes as a uniform update per frame.
- **The simulation is headless.** `Haven` has no reference to three.js, which is
  why the entire game can be tested in Node, and why offline catch-up can replay
  eight hours in under a second.
- **A save is a seed plus deltas.** The island regenerates from its seed; the
  save file carries the terrain edits, the props villagers felled or planted,
  the buildings and the people. It all fits in localStorage.
- **The island is meshed in chunks.** Sculpting is a continuous gesture, and a
  full re-mesh is about 25ms — a visible hitch every time the ground moves. Only
  the chunks an edit touched are rebuilt, and a per-frame budget spreads a big
  stroke over a few frames instead of dropping one.
- **Trails are decals, not terrain.** Baking wear into the height field would
  mean re-meshing the island every time a patch of grass darkened. Flat decals
  laid just above the ground cost an instance matrix each and can fade in
  continuously, so a path arrives as grass thinning rather than a pop.
- **Nothing is downloaded at runtime.** Every sprite, icon, texture and note of
  music is generated in code. There are no asset files to miss.

## Development

```bash
npm install
npm run dev          # dev server, reachable on your local network
npm run build        # typecheck, then build to dist/
npm run build:single # one self-contained dist-single/pixel-haven.html
npm run preview      # serve the built site
npm test             # unit and integration tests (Node, no browser)
npm run typecheck
```

Browser smoke test — boots the built game in headless Chromium, plays it, and
fails on any console error, villager lost at sea, or save that does not survive
a reload:

```bash
npm run build
npx playwright install chromium   # once
npm run test:e2e
```

There is a debug handle on `window.pixelHaven` (`.haven`, `.scene`, `.select()`,
`.place()`), which is handy from the Safari inspector and is what the smoke test
drives the game through.

Icons are generated rather than drawn: `node scripts/make-icons.mjs` rewrites
`public/icons/` from a pixel grid in the script.

## Licence

MIT.
