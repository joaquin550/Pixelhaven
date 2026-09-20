/** The contract between the game loop and the interface. */
import type { ClockSnapshot } from '../core/time';
import type { BlueprintDef } from '../build/blueprints';
import type { Haven, Miracle } from '../sim/haven';
import type { Villager } from '../sim/villager';
import type { Settings } from '../state/save';

export type InteractionMode = 'watch' | 'build' | 'direct';

export interface UiState {
  haven: Haven;
  clock: ClockSnapshot;
  selected: Villager | null;
  mode: InteractionMode;
  activeBlueprint: BlueprintDef | null;
  speed: number;
  settings: Settings;
  fps: number;
}

export interface UiHandlers {
  selectBlueprint(def: BlueprintDef | null): void;
  castMiracle(miracle: Miracle): void;
  setSpeed(speed: number): void;
  changeSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  deselect(): void;
  armSend(): void;
  focusSelected(): void;
  newWorld(seed: string): void;
  resetHaven(): void;
  dismissIntro(): void;
  startGame(): void;
}
