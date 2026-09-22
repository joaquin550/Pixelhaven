/** The contract between the game loop and the interface. */
import type { ClockSnapshot } from '../core/time';
import type { SculptTool } from '../world/sculpt';
import type { Haven, Miracle } from '../sim/haven';
import type { Villager } from '../sim/villager';
import type { Settings } from '../state/save';

export type InteractionMode = 'watch' | 'sculpt' | 'direct';

export interface UiState {
  haven: Haven;
  clock: ClockSnapshot;
  selected: Villager | null;
  mode: InteractionMode;
  activeTool: SculptTool | null;
  brushRadius: number;
  /** Favor a single stroke of the armed tool would cost. */
  strokeCost: number;
  speed: number;
  settings: Settings;
  fps: number;
}

export interface UiHandlers {
  selectTool(tool: SculptTool | null): void;
  setBrush(radius: number): void;
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
