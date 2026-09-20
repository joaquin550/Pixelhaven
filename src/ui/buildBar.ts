/**
 * The bottom bar: blueprints to place, and miracles to spend Favor on.
 *
 * Two drawers that slide up from the bottom edge, sized for thumbs (every
 * target is comfortably over 44pt) and anchored inside the safe area so the
 * home indicator never eats a button.
 */
import { formatCount } from '../core/mathx';
import { BLUEPRINTS, BlueprintCategory, BlueprintDef, ResourceKind, blueprintCostText } from '../build/blueprints';
import { MIRACLES, Miracle } from '../sim/haven';
import { el, onTap, setText, toggleClass } from './dom';
import { icon, iconSvg } from './icons';
import { UiHandlers, UiState } from './types';

const CATEGORIES: { id: BlueprintCategory; label: string }[] = [
  { id: 'home', label: 'Homes' },
  { id: 'food', label: 'Food' },
  { id: 'craft', label: 'Work' },
  { id: 'comfort', label: 'Comfort' },
  { id: 'paths', label: 'Paths' },
];

interface BlueprintCard {
  def: BlueprintDef;
  node: HTMLElement;
  costNode: HTMLElement;
  lockNode: HTMLElement;
}

export class BuildBar {
  readonly root: HTMLElement;

  private drawer: HTMLElement;
  private cardsHost: HTMLElement;
  private cards: BlueprintCard[] = [];
  private categoryButtons = new Map<BlueprintCategory, HTMLElement>();
  private miracleButtons: { miracle: Miracle; node: HTMLElement; cost: HTMLElement }[] = [];
  private buildToggle: HTMLElement;
  private miracleToggle: HTMLElement;
  private miraclePanel: HTMLElement;
  private hint: HTMLElement;

  private activeCategory: BlueprintCategory = 'home';
  private openPanel: 'none' | 'build' | 'miracles' = 'none';
  /** Mirrors whether a blueprint is currently armed for placement. */
  private armed = false;

  constructor(private handlers: UiHandlers) {
    this.cardsHost = el('div', { class: 'card-row' });

    const tabs = el('div', { class: 'category-tabs' });
    for (const category of CATEGORIES) {
      const button = el('button', { class: 'category-tab', text: category.label });
      onTap(button, () => {
        this.activeCategory = category.id;
        this.renderCards();
      });
      this.categoryButtons.set(category.id, button);
      tabs.append(button);
    }

    const closeButton = el('button', { class: 'icon-button drawer-close', html: iconSvg('close', 16), 'aria-label': 'Close' });
    onTap(closeButton, () => this.setPanel('none'));

    this.drawer = el(
      'div',
      { class: 'drawer' },
      el('div', { class: 'drawer-head' }, tabs, closeButton),
      this.cardsHost,
    );

    this.hint = el('div', { class: 'build-hint' });

    this.buildToggle = el(
      'button',
      { class: 'fab', 'aria-label': 'Build' },
      icon('hammer', 20),
      el('span', { text: 'Build' }),
    );
    onTap(this.buildToggle, () => {
      // While something is armed the button means "stop placing", because the
      // drawer has already slid away and that is the only thing left to do.
      if (this.armed) {
        this.handlers.selectBlueprint(null);
        this.setPanel('none');
        return;
      }
      this.setPanel(this.openPanel === 'build' ? 'none' : 'build');
    });

    this.miracleToggle = el(
      'button',
      { class: 'fab', 'aria-label': 'Favor' },
      icon('favor', 20),
      el('span', { text: 'Favor' }),
    );
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
      el(
        'div',
        { class: 'drawer-head' },
        el('span', { class: 'drawer-title', text: 'Favor' }),
        miracleClose,
      ),
      miracleRow,
    );

    this.root = el(
      'div',
      { class: 'build-bar' },
      this.hint,
      this.drawer,
      this.miraclePanel,
      el('div', { class: 'fab-row' }, this.buildToggle, this.miracleToggle),
    );

    this.renderCards();
    this.setPanel('none');
  }

  /**
   * Slides the drawers away while leaving whatever is armed armed.
   *
   * Called the moment a finger touches the world, so the drawer gets out of
   * the way of the thing you are about to place instead of cancelling it.
   */
  collapse(): void {
    this.setPanel('none', false);
  }

  private setPanel(panel: 'none' | 'build' | 'miracles', clearSelection = true): void {
    this.openPanel = panel;
    toggleClass(this.drawer, 'is-open', panel === 'build');
    toggleClass(this.miraclePanel, 'is-open', panel === 'miracles');
    toggleClass(this.buildToggle, 'is-active', panel === 'build');
    toggleClass(this.miracleToggle, 'is-active', panel === 'miracles');
    if (clearSelection && panel !== 'build') this.handlers.selectBlueprint(null);
  }

  private renderCards(): void {
    this.cardsHost.innerHTML = '';
    this.cards = [];

    for (const button of this.categoryButtons.values()) button.classList.remove('is-active');
    this.categoryButtons.get(this.activeCategory)?.classList.add('is-active');

    for (const def of BLUEPRINTS.filter((b) => b.category === this.activeCategory)) {
      const costNode = el('span', { class: 'card-cost', text: blueprintCostText(def) });
      const lockNode = el('span', { class: 'card-lock' });
      const node = el(
        'button',
        { class: 'card' },
        icon(def.glyph, 26),
        el('span', { class: 'card-name', text: def.name }),
        costNode,
        el('span', { class: 'card-blurb', text: def.blurb }),
        lockNode,
      );
      onTap(node, () => {
        if (node.classList.contains('is-locked')) return;
        this.handlers.selectBlueprint(def);
      });
      this.cardsHost.append(node);
      this.cards.push({ def, node, costNode, lockNode });
    }
  }

  update(state: UiState): void {
    const { haven } = state;
    this.armed = state.activeBlueprint !== null;
    toggleClass(this.buildToggle, 'is-active', this.armed || this.openPanel === 'build');

    for (const card of this.cards) {
      const locked = (card.def.requiresPopulation ?? 0) > haven.villagers.length;
      toggleClass(card.node, 'is-locked', locked);
      toggleClass(card.node, 'is-selected', state.activeBlueprint?.id === card.def.id);
      setText(card.lockNode, locked ? `Needs ${card.def.requiresPopulation} villagers` : '');

      // Cost is shown as "have / need" so it is obvious what is missing.
      const parts: string[] = [];
      let affordable = true;
      for (const [resource, amount] of Object.entries(card.def.cost) as [ResourceKind, number][]) {
        const have = Math.floor(haven.resources[resource]);
        if (have < amount) affordable = false;
        parts.push(`${amount} ${resource}`);
      }
      setText(card.costNode, parts.join(' · ') || 'free');
      toggleClass(card.costNode, 'is-short', !affordable);
    }

    for (const entry of this.miracleButtons) {
      const affordable = haven.favor >= entry.miracle.cost;
      const needsTarget = entry.miracle.targeted && !state.selected;
      toggleClass(entry.node, 'is-locked', !affordable || needsTarget);
      setText(
        entry.cost,
        needsTarget ? 'Pick a villager first' : `${formatCount(entry.miracle.cost)} favor`,
      );
      toggleClass(entry.cost, 'is-short', !affordable);
    }

    // Contextual hint line above the buttons.
    if (state.mode === 'build' && state.activeBlueprint) {
      setText(
        this.hint,
        `Press and slide to aim the ${state.activeBlueprint.name}, lift to place. Two fingers move the view.`,
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
