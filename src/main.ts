/**
 * Pixel Haven - entry point.
 *
 * Owns the loop, the input state machine, and the lifecycle: load or create a
 * haven, catch it up on the time you were away, run it, save it when the tab
 * goes to sleep.
 */
import './styles.css';
import { Vector2 } from 'three';
import { Haven, Miracle } from './sim/haven';
import { Villager } from './sim/villager';
import { SculptTool, sculpt, strokeFootprint } from './world/sculpt';
import { GameScene } from './render/scene';
import { AudioEngine } from './audio/engine';
import { GameUI } from './ui';
import { randomSeed } from './ui/overlays';
import { InteractionMode, UiHandlers, UiState } from './ui/types';
import {
  Settings,
  applyOfflineProgress,
  clearSave,
  deserializeHaven,
  loadFromStorage,
  loadSettings,
  saveSettings,
  saveToStorage,
} from './state/save';

const AUTOSAVE_INTERVAL = 20;
/** Favor spent per cell of ground actually moved. */
const FAVOR_PER_CELL = 0.06;
/** Seconds between strokes while a finger is held down. */
const STROKE_INTERVAL = 0.14;
/** Largest simulation step we will take in one frame, to survive a stall. */
const MAX_FRAME_DT = 0.25;

class Game {
  private canvas: HTMLCanvasElement;
  private haven!: Haven;
  private scene!: GameScene;
  private audio = new AudioEngine();
  private ui!: GameUI;
  private settings: Settings;

  private mode: InteractionMode = 'watch';
  private activeTool: SculptTool | null = null;
  private brushRadius = 2;
  private selectedId: number | null = null;
  /** Strokes are rate-limited so a drag carves at a readable pace. */
  private strokeCooldown = 0;

  private running = false;
  private started = false;
  private lastFrame = 0;
  private autosaveTimer = AUTOSAVE_INTERVAL;
  private fps = 60;
  private pendingAway: { summary: string; rows: { icon: string; text: string }[] } | null = null;

  constructor(canvas: HTMLCanvasElement, uiHost: HTMLElement) {
    this.canvas = canvas;
    this.settings = loadSettings();
    // Quitting while paused should not mean opening to a frozen island.
    if (this.settings.speed <= 0) this.settings.speed = 1;
    this.ui = new GameUI(this.handlers());
    this.ui.mount(uiHost);
    this.ui.syncSettings(this.settings);

    this.bootWorld();
    this.wireLifecycle();
  }

  /* --------------------------------------------------------------- boot */

  private bootWorld(): void {
    const saved = loadFromStorage();
    if (saved) {
      try {
        this.haven = deserializeHaven(saved);
        const report = applyOfflineProgress(this.haven, saved.savedAt);
        if (report) {
          this.pendingAway = {
            summary: report.summary,
            rows: [
              { icon: 'wood', text: `+${report.gained.wood} wood` },
              { icon: 'stone', text: `+${report.gained.stone} stone` },
              { icon: 'food', text: `+${report.gained.food} food` },
              ...(report.newVillagers > 0
                ? [{ icon: 'people', text: `${report.newVillagers} new villagers` }]
                : []),
              ...(report.structuresFinished > 0
                ? [{ icon: 'hammer', text: `${report.structuresFinished} buildings finished` }]
                : []),
            ],
          };
        }
      } catch (error) {
        console.warn('Save could not be read; starting fresh.', error);
        this.haven = new Haven(randomSeed());
      }
    } else {
      this.haven = new Haven(randomSeed());
    }

    this.ui.title.setReturning(saved !== null);
    this.createScene();
    this.listenToHaven();
  }

  private createScene(): void {
    this.scene?.dispose();
    this.scene = new GameScene(this.canvas, this.haven, {
      onTap: (event) => this.handleTap(event.ndc),
      onDoubleTap: (event) => this.handleDoubleTap(event.ndc),
      onDragStart: () => this.ui.shapeBar.collapse(),
      // With a tool armed a single finger carves: press, drag across the
      // ground, lift. Two fingers still move the camera, so you can line up a
      // view without putting the tool down.
      onPlacementMove: (event) => this.paint(event.ndc),
      onPlacementCommit: (event) => this.paint(event.ndc, true),
    });
    this.scene.rig.setPlacementMode(this.activeTool !== null);
    this.scene.setQuality({
      shadows: this.settings.shadows,
      weather: this.settings.weather,
      bubbles: this.settings.showBubbles,
    });
    this.scene.resize();
  }

  private listenToHaven(): void {
    this.haven.events.on('structureComplete', () => {
      this.audio.play('complete');
    });
    this.haven.events.on('milestone', ({ title, body }) => {
      this.ui.toasts.show(title, body, 'good');
    });
    this.haven.events.on('villagerAdded', (villager) => {
      if (this.started) this.audio.play('arrive');
      void villager;
    });
  }

  /* --------------------------------------------------------------- loop */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    const rawDt = Math.min((now - this.lastFrame) / 1000, MAX_FRAME_DT);
    this.lastFrame = now;
    if (rawDt <= 0) return;

    this.fps += (1 / Math.max(rawDt, 0.0001) - this.fps) * 0.08;

    if (this.strokeCooldown > 0) this.strokeCooldown = Math.max(0, this.strokeCooldown - rawDt);

    const simDt = this.started ? rawDt * this.settings.speed : 0;
    if (simDt > 0) {
      this.haven.update(simDt);
      this.autosaveTimer -= rawDt;
      if (this.autosaveTimer <= 0) {
        this.autosaveTimer = AUTOSAVE_INTERVAL;
        saveToStorage(this.haven);
      }
    }

    const clock = this.haven.clock.snapshot();
    this.scene.render(rawDt, clock, this.selectedId);
    this.updateAudio(rawDt, clock.daylight);
    this.ui.update(this.uiState(clock));
  };

  private uiState(clock: ReturnType<Haven['clock']['snapshot']>): UiState {
    return {
      haven: this.haven,
      clock,
      selected: this.selected,
      mode: this.mode,
      activeTool: this.activeTool,
      brushRadius: this.brushRadius,
      strokeCost: this.strokeCost,
      speed: this.settings.speed,
      settings: this.settings,
      fps: this.fps,
    };
  }

  /** Debug accessors used by the console handle and the end-to-end tests. */
  get world(): Haven {
    return this.haven;
  }

  get view(): GameScene {
    return this.scene;
  }

  selectVillager(id: number | null): void {
    this.selectedId = id;
  }

  sculptAt(tool: SculptTool, x: number, z: number, radius: number): number {
    const result = sculpt(this.haven.terrain, this.haven.props, tool, x, z, radius);
    if (result.changed > 0) this.haven.nav.rebuild();
    return result.changed;
  }

  private get selected(): Villager | null {
    if (this.selectedId === null) return null;
    return this.haven.villagerById(this.selectedId) ?? null;
  }

  private updateAudio(dt: number, daylight: number): void {
    const focus = this.scene.rig.focusPoint;
    let nearFire = false;
    for (const structure of this.haven.structures.completedOfType('hearth')) {
      if (Math.hypot(structure.x - focus.x, structure.z - focus.z) < 22) nearFire = true;
    }
    let chatter = 0;
    for (const villager of this.haven.villagers) {
      if (villager.anim === 'chat' && villager.distanceTo(focus.x, focus.z) < 26) chatter++;
    }
    this.audio.update(dt, { zoom: this.scene.rig.zoomLevel, daylight, nearFire, chatter });
  }

  /* -------------------------------------------------------------- input */

  /** Favor a single stroke of the armed brush would cost. */
  private get strokeCost(): number {
    return strokeFootprint(this.brushRadius) * FAVOR_PER_CELL;
  }

  private handleTap(ndc: Vector2): void {
    // Sculpting runs through the rig's press-drag path, not through taps.
    if (this.mode === 'direct' && this.selected) {
      const hit = this.scene.pickGround(ndc);
      if (hit && this.haven.orderTo(this.selected, hit.x, hit.z)) {
        this.audio.play('select');
        this.haven.log(`You pointed ${this.selected.name.split(' ')[0]} somewhere new.`);
      } else {
        this.audio.play('cancel');
      }
      this.mode = 'watch';
      return;
    }

    const villagerId = this.scene.pickVillager(ndc);
    if (villagerId !== null) {
      this.selectedId = villagerId;
      this.audio.play('select');
      return;
    }
    if (this.selectedId !== null) this.selectedId = null;
  }

  private handleDoubleTap(ndc: Vector2): void {
    const villagerId = this.scene.pickVillager(ndc);
    if (villagerId !== null) {
      const villager = this.haven.villagerById(villagerId);
      if (villager) {
        this.selectedId = villagerId;
        this.scene.rig.focusOn(villager.x, villager.z, 16);
        this.audio.play('select');
        return;
      }
    }
    const hit = this.scene.pickGround(ndc);
    if (hit) this.scene.rig.focusOn(hit.x, hit.z, Math.max(14, this.scene.rig.cameraDistance * 0.55));
  }

  /**
   * One stroke of the armed tool, under the finger.
   *
   * Rate-limited rather than applied per pointer event: a drag should carve at
   * a pace you can watch and stop, not gouge a canyon in one flick.
   */
  private paint(ndc: Vector2, final = false): void {
    if (!this.activeTool) {
      this.scene.hideBrush();
      return;
    }

    const hit = this.scene.pickGround(ndc);
    if (!hit) {
      this.scene.hideBrush();
      return;
    }

    const cost = this.strokeCost;
    const affordable = this.haven.favor >= cost;
    this.scene.showBrush(hit.x, hit.z, this.brushRadius, affordable);

    if (!affordable) {
      if (final) {
        this.audio.play('cancel');
        this.ui.toasts.show('Not enough Favor', 'Favor comes from a contented village.');
      }
      return;
    }
    if (this.strokeCooldown > 0 && !final) return;
    this.strokeCooldown = STROKE_INTERVAL;

    const result = sculpt(
      this.haven.terrain,
      this.haven.props,
      this.activeTool,
      hit.x,
      hit.z,
      this.brushRadius,
    );

    if (result.changed === 0) {
      if (result.blocked > 0 && final) {
        this.ui.toasts.show('Something is built there', 'You cannot move ground out from under a house.');
        this.audio.play('cancel');
      }
      return;
    }

    // Charged by the cell actually moved, so a stroke that half-hits a cliff
    // edge costs half as much.
    this.haven.favor = Math.max(0, this.haven.favor - result.changed * FAVOR_PER_CELL);
    this.haven.nav.rebuild();
    this.audio.play(this.activeTool === 'raise' ? 'place' : 'chop');

    // Whatever came out of the ground is worth keeping.
    let salvaged = 0;
    for (const [resource, amount] of Object.entries(result.salvaged) as ['wood', number][]) {
      if (amount > 0) salvaged += this.haven.store(resource, amount);
    }

    if (result.propsLost > 0) {
      const what = result.propsLost === 1 ? 'Something' : `${result.propsLost} things`;
      this.haven.log(
        salvaged > 0
          ? `${what} came out of the ground. They salvaged ${Math.round(salvaged)} from it.`
          : `${what} came out of the ground as it shifted.`,
        'neutral',
      );
    }
  }

  /* ----------------------------------------------------------- handlers */

  private handlers(): UiHandlers {
    return {
      selectTool: (tool) => {
        this.activeTool = tool;
        this.mode = tool ? 'sculpt' : 'watch';
        this.scene?.rig.setPlacementMode(tool !== null);
        if (tool) {
          this.selectedId = null;
          this.audio.play('tick');
        } else {
          this.scene?.hideBrush();
        }
      },
      setBrush: (radius) => {
        this.brushRadius = radius;
        this.audio.play('tick');
      },
      castMiracle: (miracle: Miracle) => {
        const target = miracle.targeted ? this.selected ?? undefined : undefined;
        if (miracle.targeted && !target) {
          this.ui.toasts.show('Pick someone first', 'Tap a villager, then try again.');
          return;
        }
        if (this.haven.castMiracle(miracle, target)) {
          this.audio.play('miracle');
        } else {
          this.audio.play('cancel');
          this.ui.toasts.show('Not enough Favor', `${miracle.name} costs ${miracle.cost}.`);
        }
      },
      setSpeed: (speed) => {
        this.settings.speed = speed;
        saveSettings(this.settings);
        this.audio.play('tick');
      },
      changeSetting: (key, value) => {
        (this.settings[key] as unknown) = value;
        saveSettings(this.settings);
        this.applySettings();
        this.ui.syncSettings(this.settings);
      },
      deselect: () => {
        this.selectedId = null;
        this.mode = this.activeTool ? 'sculpt' : 'watch';
        this.scene.rig.setPlacementMode(this.activeTool !== null);
      },
      armSend: () => {
        if (!this.selected) return;
        this.mode = this.mode === 'direct' ? 'watch' : 'direct';
        this.activeTool = null;
        this.scene.rig.setPlacementMode(false);
        this.scene.hideBrush();
        this.audio.play('tick');
      },
      focusSelected: () => {
        const villager = this.selected;
        if (!villager) return;
        this.scene.rig.focusOn(villager.x, villager.z, 15);
      },
      newWorld: (seed) => this.replaceWorld(new Haven(seed)),
      resetHaven: () => {
        clearSave();
        this.replaceWorld(new Haven(randomSeed()));
      },
      dismissIntro: () => {
        /* Away card closes itself; nothing else to do. */
      },
      startGame: () => void this.begin(),
    };
  }

  private async begin(): Promise<void> {
    this.ui.title.hide();
    this.started = true;
    const firstTime = !this.settings.hasPlayed;
    this.settings.hasPlayed = true;
    saveSettings(this.settings);

    await this.audio.unlock();
    this.applySettings();

    if (this.pendingAway) {
      this.ui.away.present(this.pendingAway.summary, this.pendingAway.rows);
      this.pendingAway = null;
    } else if (firstTime) {
      // Two lines, once, and then never again.
      this.ui.toasts.show('Welcome to the haven', 'Tap anyone to see what they are up to.');
      window.setTimeout(
        () => this.ui.toasts.show('They manage on their own', 'Build when you feel like it. Nothing here is urgent.'),
        5200,
      );
    }
  }

  private replaceWorld(haven: Haven): void {
    saveToStorage(this.haven);
    this.haven = haven;
    this.selectedId = null;
    this.activeTool = null;
    this.mode = 'watch';
    this.createScene();
    this.listenToHaven();
    this.ui.shapeBar.collapse();
    saveToStorage(this.haven);
    this.ui.toasts.show('A new island', `Seed: ${haven.seed}`);
  }

  private applySettings(): void {
    this.audio.setMuted(this.settings.muted);
    this.audio.setVolume('master', this.settings.master);
    this.audio.setVolume('music', this.settings.music);
    this.audio.setVolume('ambience', this.settings.ambience);
    this.audio.setVolume('sfx', this.settings.sfx);
    this.scene.setQuality({
      shadows: this.settings.shadows,
      weather: this.settings.weather,
      bubbles: this.settings.showBubbles,
    });
  }

  /* ----------------------------------------------------------- lifecycle */

  private wireLifecycle(): void {
    const resize = () => this.scene.resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => window.setTimeout(resize, 250));

    // Track the finger while a blueprint is armed so the ghost follows it.
    this.canvas.addEventListener(
      'pointermove',
      (event) => {
        if (this.mode !== 'sculpt') return;
        const rect = this.canvas.getBoundingClientRect();
        this.paint(
          new Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
          ),
        );
      },
      { passive: true },
    );

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        saveToStorage(this.haven);
        this.audio.suspend();
      } else {
        this.lastFrame = performance.now();
        this.audio.resume();
      }
    });

    window.addEventListener('pagehide', () => saveToStorage(this.haven));
    window.addEventListener('beforeunload', () => saveToStorage(this.haven));

    // Keyboard shortcuts, for playing on a desktop while developing.
    window.addEventListener('keydown', (event) => {
      if (event.key === ' ') {
        this.settings.speed = this.settings.speed === 0 ? 1 : 0;
        saveSettings(this.settings);
      } else if (event.key === 'Escape') {
        this.selectedId = null;
        this.activeTool = null;
        this.mode = 'watch';
        this.scene.rig.setPlacementMode(false);
        this.scene.hideBrush();
      } else if (event.key >= '1' && event.key <= '4') {
        this.settings.speed = [0, 1, 2, 4][Number(event.key) - 1];
        saveSettings(this.settings);
      }
    });
  }
}

/* ------------------------------------------------------------- bootstrap */

function boot(): void {
  const app = document.getElementById('app');
  const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
  if (!app || !canvas) throw new Error('Pixel Haven could not find its mount points');

  const game = new Game(canvas, app);
  game.start();

  // Tells the inline boot message in index.html that it can go.
  window.dispatchEvent(new Event('pixelhaven:ready'));

  // Debug handle. Handy from the Safari inspector, and it is what the
  // end-to-end tests drive the game through.
  (window as unknown as { pixelHaven: unknown }).pixelHaven = {
    get haven() {
      return game.world;
    },
    get scene() {
      return game.view;
    },
    select: (id: number | null) => game.selectVillager(id),
    sculpt: (tool: SculptTool, x: number, z: number, radius = 2) =>
      game.sculptAt(tool, x, z, radius),
  };

  // Safari on iPad still fires a synthetic double-tap zoom unless we say no.
  document.addEventListener('gesturestart', (event) => event.preventDefault());
  document.addEventListener('dblclick', (event) => event.preventDefault());

  registerServiceWorker();
}

declare const __SINGLE_FILE__: boolean;

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;
  // A standalone single-file build has no sw.js sitting next to it, and
  // nothing to cache that is not already in the page.
  if (typeof __SINGLE_FILE__ !== 'undefined' && __SINGLE_FILE__) return;
  // Inside the native shell the whole game is already on the device, and
  // WKWebView serves it from capacitor://, where service workers do not run.
  if ((window as unknown as { Capacitor?: unknown }).Capacitor) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error) => console.warn('Offline mode unavailable', error));
  });
}

boot();

