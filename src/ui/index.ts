/** Assembles every interface layer and routes state into it once per frame. */
import { Settings } from '../state/save';
import { Hud } from './hud';
import { ShapeBar } from './shapeBar';
import { Inspector } from './inspector';
import { AwayCard, SettingsSheet, TitleCard, Toasts } from './overlays';
import { el } from './dom';
import { UiHandlers, UiState } from './types';

export class GameUI {
  readonly root: HTMLElement;
  readonly hud: Hud;
  readonly shapeBar: ShapeBar;
  readonly inspector: Inspector;
  readonly toasts = new Toasts();
  readonly title: TitleCard;
  readonly away: AwayCard;
  readonly settings: SettingsSheet;

  constructor(handlers: UiHandlers) {
    this.settings = new SettingsSheet(handlers);
    this.hud = new Hud(handlers, () => this.settings.show());
    this.shapeBar = new ShapeBar(handlers);
    this.inspector = new Inspector(handlers);
    this.title = new TitleCard(handlers);
    this.away = new AwayCard(handlers);

    this.root = el(
      'div',
      { class: 'ui-layer' },
      this.hud.root,
      this.inspector.root,
      this.shapeBar.root,
      this.toasts.root,
      this.away.root,
      this.settings.root,
      this.title.root,
    );
  }

  update(state: UiState): void {
    this.hud.update(state);
    this.shapeBar.update(state);
    this.inspector.update(state);
  }

  syncSettings(settings: Settings): void {
    this.settings.sync(settings);
  }

  mount(parent: HTMLElement): void {
    parent.append(this.root);
  }
}

export type { UiHandlers, UiState } from './types';
