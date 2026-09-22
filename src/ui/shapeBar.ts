/**
 * The bottom bar: the shape of the land, and Favor.
 *
 * There is deliberately no build menu. The player does not place buildings -
 * they move earth, and the village reads the result and decides for itself.
 * So the primary drawer holds three earth-moving tools and a brush size, and
 * the only other thing on the bar is the Favor the village's contentment earns.
 */
import { formatCount } from '../core/mathx';
import { MIRACLES, Miracle } from '../sim/haven';
import type { SculptTool } from '../world/sculpt';
import { el, onTap, setText, toggleClass } from './dom';
import { icon, iconSvg } from './icons';
import { UiHandlers, UiState } from './types';

interface ToolDef {
  id: SculptTool;
  name: string;
  blurb: string;
  glyph: string;
}

const TOOLS: ToolDef[] = [
  {
    id: 'raise',
    name: 'Raise',
    blurb: 'Pull the ground up a voxel. Build a ridge, or lift a seabed into an island.',
    glyph: 'raise',
  },
  {
    id: 'lower',
    name: 'Lower',
    blurb: 'Press it down. Go below the tideline and the sea comes in.',
    glyph: 'lower',
  },
  {
    id: 'level',
    name: 'Flatten',
    blurb: 'Even the ground out. Flat land is the only invitation they understand.',
    glyph: 'level',
  },
];

const BRUSHES: { radius: number; label: string }[] = [
  { radius: 1, label: 'Small' },
  { radius: 2, label: 'Medium' },
  { radius: 3, label: 'Wide' },
];

export class ShapeBar {
  readonly root: HTMLElement;

  private drawer: HTMLElement;
  private miraclePanel: HTMLElement;
  private shapeToggle: HTMLElement;
  private miracleToggle: HTMLElement;
  private hint: HTMLElement;
  private toolCards: { def: ToolDef; node: HTMLElement }[] = [];
  private brushButtons: { radius: number; node: HTMLElement }[] = [];
  private miracleButtons: { miracle: Miracle; node: HTMLElement; cost: HTMLElement }[] = [];

  private openPanel: 'none' | 'shape' | 'miracles' = 'none';
  private armed = false;

  constructor(private handlers: UiHandlers) {
    const toolRow = el('div', { class: 'card-row' });
    for (const def of TOOLS) {
      const node = el(
        'button',
        { class: 'card' },
        icon(def.glyph, 26),
        el('span', { class: 'card-name', text: def.name }),
        el('span', { class: 'card-blurb', text: def.blurb }),
      );
      onTap(node, () => this.handlers.selectTool(def.id));
      this.toolCards.push({ def, node });
      toolRow.append(node);
    }

    const brushRow = el('div', { class: 'brush-row' }, el('span', { class: 'brush-label', text: 'Brush' }));
    for (const brush of BRUSHES) {
      const node = el('button', { class: 'brush-button', text: brush.label });
      onTap(node, () => this.handlers.setBrush(brush.radius));
      this.brushButtons.push({ radius: brush.radius, node });
      brushRow.append(node);
    }

    const close = el('button', { class: 'icon-button drawer-close', html: iconSvg('close', 16), 'aria-label': 'Close' });
    onTap(close, () => this.setPanel('none'));

    this.drawer = el(
      'div',
      { class: 'drawer' },
      el(
        'div',
        { class: 'drawer-head' },
        el('span', { class: 'drawer-title', text: 'Shape the land' }),
        brushRow,
        close,
      ),
      toolRow,
    );

    this.hint = el('div', { class: 'build-hint' });

    this.shapeToggle = el('button', { class: 'fab', 'aria-label': 'Shape' }, icon('raise', 20), el('span', { text: 'Shape' }));
    onTap(this.shapeToggle, () => {
      // Once a tool is armed the button's job is to put it down again.
      if (this.armed) {
        this.handlers.selectTool(null);
        this.setPanel('none');
        return;
      }
      this.setPanel(this.openPanel === 'shape' ? 'none' : 'shape');
    });

    this.miracleToggle = el('button', { class: 'fab', 'aria-label': 'Favor' }, icon('favor', 20), el('span', { text: 'Favor' }));
    onTap(this.miracleToggle, () => this.setPanel(this.openPanel === 'miracles' ? 'none' : 'miracles'));

    const miracleRow = el('div', { class: 'card-row' });
    for (const miracle of MIRACLES) {
      const cost = el('span', { class: 'card-cost', text: `${miracle.cost} favor` });
      const node = el(
        'button',
        { class: 'card' },
        icon(miracle.glyph, 26),
        el('span', { class: 'card-name', text: miracle.name }),
        cost,
        el('span', { class: 'card-blurb', text: miracle.blurb }),
      );
      onTap(node, () => this.handlers.castMiracle(miracle));
      this.miracleButtons.push({ miracle, node, cost });
      miracleRow.append(node);
    }

    const miracleClose = el('button', { class: 'icon-button drawer-close', html: iconSvg('close', 16), 'aria-label': 'Close' });
    onTap(miracleClose, () => this.setPanel('none'));

    this.miraclePanel = el(
      'div',
      { class: 'drawer' },
      el('div', { class: 'drawer-head' }, el('span', { class: 'drawer-title', text: 'Favor' }), miracleClose),
      miracleRow,
    );

    this.root = el(
      'div',
      { class: 'build-bar' },
      this.hint,
      this.drawer,
      this.miraclePanel,
      el('div', { class: 'fab-row' }, this.shapeToggle, this.miracleToggle),
    );

    this.setPanel('none');
  }

  /** Slides the drawers away without putting the tool down. */
  collapse(): void {
    this.setPanel('none', false);
  }

  private setPanel(panel: 'none' | 'shape' | 'miracles', clearSelection = true): void {
    this.openPanel = panel;
    toggleClass(this.drawer, 'is-open', panel === 'shape');
    toggleClass(this.miraclePanel, 'is-open', panel === 'miracles');
    toggleClass(this.miracleToggle, 'is-active', panel === 'miracles');
    if (clearSelection && panel !== 'shape') this.handlers.selectTool(null);
  }

  update(state: UiState): void {
    const { haven } = state;
    this.armed = state.activeTool !== null;
    toggleClass(this.shapeToggle, 'is-active', this.armed || this.openPanel === 'shape');

    for (const card of this.toolCards) {
      toggleClass(card.node, 'is-selected', state.activeTool === card.def.id);
    }
    for (const brush of this.brushButtons) {
      toggleClass(brush.node, 'is-active', state.brushRadius === brush.radius);
    }

    for (const entry of this.miracleButtons) {
      const affordable = haven.favor >= entry.miracle.cost;
      const needsTarget = entry.miracle.targeted && !state.selected;
      toggleClass(entry.node, 'is-locked', !affordable || needsTarget);
      setText(entry.cost, needsTarget ? 'Pick a villager first' : `${formatCount(entry.miracle.cost)} favor`);
      toggleClass(entry.cost, 'is-short', !affordable);
    }

    if (state.mode === 'sculpt' && state.activeTool) {
      const tool = TOOLS.find((t) => t.id === state.activeTool)!;
      const cost = state.strokeCost.toFixed(1);
      setText(
        this.hint,
        haven.favor < state.strokeCost
          ? `Not enough Favor to ${tool.name.toLowerCase()} — it costs ${cost} a stroke.`
          : `Press and drag to ${tool.name.toLowerCase()}. ${cost} Favor a stroke. Two fingers move the view.`,
      );
      toggleClass(this.hint, 'is-visible', true);
    } else if (state.mode === 'direct') {
      setText(this.hint, 'Tap anywhere to send them there.');
      toggleClass(this.hint, 'is-visible', true);
    } else {
      toggleClass(this.hint, 'is-visible', false);
    }
  }
}
