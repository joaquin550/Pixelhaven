/**
 * The villager panel.
 *
 * This is where the game stops being a screensaver. Tapping somebody gives you
 * their name, their two traits, what they are doing and why, who they like, and
 * the two things you can actually do about it: send them somewhere, or feed
 * them. Everything reads as a sentence about a person, not a stat block.
 */
import { formatDuration } from '../core/mathx';
import { TRAIT_BY_ID, VOCATION_LABEL } from '../sim/traits';
import { Villager } from '../sim/villager';
import { MIRACLES } from '../sim/haven';
import { createPortraitCanvas } from '../render/spriteFactory';
import { el, onTap, setText, toggleClass } from './dom';
import { icon, iconSvg } from './icons';
import { UiHandlers, UiState } from './types';

export class Inspector {
  readonly root: HTMLElement;

  private portrait: HTMLElement;
  private nameNode: HTMLElement;
  private roleNode: HTMLElement;
  private taskNode: HTMLElement;
  private traitHost: HTMLElement;
  private needsHost: HTMLElement;
  private bonds: HTMLElement;
  private storyNode: HTMLElement;
  private sendButton: HTMLElement;
  private feedButton: HTMLElement;
  private focusButton: HTMLElement;
  private needBars = new Map<string, { fill: HTMLElement; label: HTMLElement }>();
  private currentId = -1;

  constructor(private handlers: UiHandlers) {
    this.portrait = el('div', { class: 'inspector-portrait' });
    this.nameNode = el('h2', { class: 'inspector-name', text: '' });
    this.roleNode = el('span', { class: 'inspector-role', text: '' });
    this.taskNode = el('div', { class: 'inspector-task', text: '' });
    this.traitHost = el('div', { class: 'trait-row' });
    this.needsHost = el('div', { class: 'needs' });
    this.bonds = el('div', { class: 'bonds' });
    this.storyNode = el('div', { class: 'inspector-story' });

    for (const [key, label] of [
      ['energy', 'Rested'],
      ['food', 'Fed'],
      ['social', 'Company'],
      ['mood', 'Spirits'],
    ] as const) {
      const fill = el('div', { class: `need-fill need-${key}` });
      const value = el('span', { class: 'need-value', text: '' });
      this.needsHost.append(
        el(
          'div',
          { class: 'need' },
          el('span', { class: 'need-label', text: label }),
          el('div', { class: 'need-track' }, fill),
          value,
        ),
      );
      this.needBars.set(key, { fill, label: value });
    }

    this.sendButton = el('button', { class: 'panel-button' }, icon('path', 16), el('span', { text: 'Send here' }));
    onTap(this.sendButton, () => this.handlers.armSend());

    const meal = MIRACLES.find((m) => m.id === 'meal')!;
    this.feedButton = el('button', { class: 'panel-button' }, icon('meal', 16), el('span', { text: 'Warm meal' }));
    onTap(this.feedButton, () => this.handlers.castMiracle(meal));

    this.focusButton = el('button', { class: 'panel-button' }, icon('people', 16), el('span', { text: 'Follow' }));
    onTap(this.focusButton, () => this.handlers.focusSelected());

    const close = el('button', { class: 'icon-button', html: iconSvg('close', 16), 'aria-label': 'Close' });
    onTap(close, () => this.handlers.deselect());

    this.root = el(
      'aside',
      { class: 'inspector' },
      el(
        'div',
        { class: 'inspector-head' },
        this.portrait,
        el('div', { class: 'inspector-titles' }, this.nameNode, this.roleNode),
        close,
      ),
      this.taskNode,
      this.traitHost,
      this.needsHost,
      this.bonds,
      this.storyNode,
      el('div', { class: 'panel-actions' }, this.sendButton, this.feedButton, this.focusButton),
    );
  }

  update(state: UiState): void {
    const villager = state.selected;
    toggleClass(this.root, 'is-open', villager !== null);
    if (!villager) {
      this.currentId = -1;
      return;
    }

    if (villager.id !== this.currentId) {
      this.currentId = villager.id;
      this.renderStatic(villager);
    }

    setText(this.taskNode, describeTask(villager));
    this.setNeed('energy', villager.energy);
    this.setNeed('food', 100 - villager.hunger);
    this.setNeed('social', 100 - villager.lonely);
    this.setNeed('mood', villager.mood);

    const meal = MIRACLES.find((m) => m.id === 'meal')!;
    toggleClass(this.feedButton, 'is-locked', state.haven.favor < meal.cost);
    toggleClass(this.sendButton, 'is-active', state.mode === 'direct');

    this.renderBonds(state, villager);
    setText(this.storyNode, describeStory(villager));
  }

  private renderStatic(villager: Villager): void {
    this.portrait.innerHTML = '';
    this.portrait.append(createPortraitCanvas(villager.look, 2));
    setText(this.nameNode, villager.name);
    const days = Math.floor(villager.age) + 1;
    setText(
      this.roleNode,
      `${VOCATION_LABEL[villager.vocation]} · ${days} ${days === 1 ? 'day' : 'days'} here`,
    );

    this.traitHost.innerHTML = '';
    for (const traitId of villager.traits) {
      const trait = TRAIT_BY_ID.get(traitId);
      if (!trait) continue;
      this.traitHost.append(
        el(
          'div',
          { class: 'trait', title: trait.blurb },
          el('span', { class: 'trait-name', text: trait.name }),
          el('span', { class: 'trait-blurb', text: trait.blurb }),
        ),
      );
    }
  }

  private setNeed(key: string, value: number): void {
    const bar = this.needBars.get(key);
    if (!bar) return;
    const clamped = Math.max(0, Math.min(100, value));
    bar.fill.style.width = `${clamped.toFixed(0)}%`;
    toggleClass(bar.fill, 'is-low', clamped < 28);
    setText(bar.label, `${Math.round(clamped)}`);
  }

  private renderBonds(state: UiState, villager: Villager): void {
    const friends = Array.from(villager.friendships.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    this.bonds.innerHTML = '';
    if (friends.length === 0) {
      this.bonds.append(el('div', { class: 'bond-empty', text: 'Has not really got to know anyone yet.' }));
      return;
    }

    for (const [id, value] of friends) {
      const other = state.haven.villagerById(id);
      if (!other) continue;
      this.bonds.append(
        el(
          'div',
          { class: 'bond' },
          icon(value > 55 ? 'heart' : 'people', 14),
          el('span', { class: 'bond-name', text: other.name.split(' ')[0] }),
          el('span', { class: 'bond-level', text: bondLabel(value) }),
        ),
      );
    }
  }
}

function bondLabel(value: number): string {
  if (value > 78) return 'inseparable';
  if (value > 55) return 'close';
  if (value > 30) return 'friendly';
  return 'acquainted';
}

function describeTask(villager: Villager): string {
  if (villager.task) {
    if (villager.task.phase === 'travel') return `On the way · ${villager.task.label}`;
    if (villager.task.phase === 'deliver' && villager.carry) {
      return `Carrying ${villager.carry.amount} ${villager.carry.resource} back`;
    }
    return villager.task.label;
  }
  if (villager.idleFor > 4) return 'Deciding what to do next';
  return 'Having a look around';
}

/** One sentence of colour, drawn from what they have actually done. */
function describeStory(villager: Villager): string {
  const bits: string[] = [];
  if (villager.stats.gathered > 0) bits.push(`brought in ${Math.round(villager.stats.gathered)} loads`);
  if (villager.stats.built > 6) bits.push(`put ${formatDuration(villager.stats.built)} into building`);
  if (villager.stats.chats > 0) bits.push(`had ${villager.stats.chats} good conversations`);
  if (villager.homeId === 0) bits.push('still has nowhere to sleep');
  if (bits.length === 0) return 'Only just arrived.';
  return `So far: ${bits.join(', ')}.`;
}
