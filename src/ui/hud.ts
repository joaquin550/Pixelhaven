/**
 * The top bar: what you have, what time it is, and how fast it is passing.
 *
 * Deliberately sparse. This is a game about looking at the island, so the HUD
 * stays out of the middle of the screen and out of the way of your thumbs.
 */
import { formatCount } from '../core/mathx';
import { SEASON_LABEL, formatClock } from '../core/time';
import { el, onTap, setText, toggleClass } from './dom';
import { icon, iconSvg } from './icons';
import { UiHandlers, UiState } from './types';

const SPEEDS = [0, 1, 2, 4];

export class Hud {
  readonly root: HTMLElement;

  private woodValue: HTMLElement;
  private stoneValue: HTMLElement;
  private foodValue: HTMLElement;
  private toolsValue: HTMLElement;
  private toolsStat: HTMLElement;
  private favorValue: HTMLElement;
  private favorRate: HTMLElement;
  private capacityBar: HTMLElement;
  private capacityText: HTMLElement;
  private dayText: HTMLElement;
  private clockText: HTMLElement;
  private seasonIcon: HTMLElement;
  private popText: HTMLElement;
  private moodText: HTMLElement;
  private speedButtons: HTMLElement[] = [];
  private ticker: HTMLElement;
  private lastLogId = -1;

  constructor(handlers: UiHandlers, onOpenMenu: () => void) {
    this.woodValue = el('span', { class: 'stat-value', text: '0' });
    this.stoneValue = el('span', { class: 'stat-value', text: '0' });
    this.foodValue = el('span', { class: 'stat-value', text: '0' });
    this.toolsValue = el('span', { class: 'stat-value', text: '0' });
    this.favorValue = el('span', { class: 'stat-value', text: '0' });
    this.favorRate = el('span', { class: 'stat-rate', text: '' });

    this.capacityBar = el('div', { class: 'capacity-fill' });
    this.capacityText = el('span', { class: 'capacity-text', text: '' });

    const resources = el(
      'div',
      { class: 'hud-resources' },
      stat('wood', this.woodValue, 'Wood'),
      stat('stone', this.stoneValue, 'Stone'),
      stat('food', this.foodValue, 'Food'),
      (this.toolsStat = stat('tools', this.toolsValue, 'Tools')),
      el('div', { class: 'stat stat-favor', title: 'Favor' }, icon('favor', 18), this.favorValue, this.favorRate),
      el(
        'div',
        { class: 'capacity', title: 'Storehouse capacity' },
        el('div', { class: 'capacity-track' }, this.capacityBar),
        this.capacityText,
      ),
    );

    this.dayText = el('span', { class: 'clock-day', text: 'Day 1' });
    this.clockText = el('span', { class: 'clock-time', text: '00:00' });
    this.seasonIcon = el('span', { class: 'clock-season' });
    this.popText = el('span', { class: 'meta-value', text: '0' });
    this.moodText = el('span', { class: 'meta-value', text: '0%' });

    for (const speed of SPEEDS) {
      const label = speed === 0 ? iconSvg('pause', 14) : speed === 1 ? iconSvg('play', 14) : `${speed}x`;
      const button = el('button', {
        class: 'speed-button',
        html: label,
        'aria-label': speed === 0 ? 'Pause' : `${speed} times speed`,
      });
      onTap(button, () => handlers.setSpeed(speed));
      this.speedButtons.push(button);
    }

    const menuButton = el('button', { class: 'icon-button', html: iconSvg('gear', 20), 'aria-label': 'Menu' });
    onTap(menuButton, onOpenMenu);

    const meta = el(
      'div',
      { class: 'hud-meta' },
      el(
        'div',
        { class: 'clock-block' },
        this.seasonIcon,
        el('div', { class: 'clock-lines' }, this.dayText, this.clockText),
      ),
      el('div', { class: 'meta-chip', title: 'Villagers' }, icon('people', 16), this.popText),
      el('div', { class: 'meta-chip', title: 'Average mood' }, icon('heart', 16), this.moodText),
      el('div', { class: 'speed-group' }, ...this.speedButtons),
      menuButton,
    );

    this.ticker = el('div', { class: 'hud-ticker' });

    this.root = el('div', { class: 'hud' }, el('div', { class: 'hud-row' }, resources, meta), this.ticker);
  }

  update(state: UiState): void {
    const { haven, clock } = state;

    setText(this.woodValue, formatCount(haven.resources.wood));
    setText(this.stoneValue, formatCount(haven.resources.stone));
    setText(this.foodValue, formatCount(haven.resources.food));
    setText(this.toolsValue, formatCount(haven.resources.tools || 0));
    // The tools slot only appears once there is a workshop to make them in.
    const makesTools =
      (haven.resources.tools || 0) > 0 || haven.structures.completedOfType('workshop').length > 0;
    toggleClass(this.toolsStat, 'is-hidden', !makesTools);
    setText(this.favorValue, formatCount(haven.favor));
    setText(this.favorRate, `+${haven.favorRate.toFixed(1)}/m`);

    const used = haven.totalStored;
    const fraction = Math.min(1, used / Math.max(1, haven.capacity));
    this.capacityBar.style.width = `${(fraction * 100).toFixed(1)}%`;
    toggleClass(this.capacityBar, 'is-full', fraction > 0.92);
    setText(this.capacityText, `${Math.round(used)}/${haven.capacity}`);

    setText(this.dayText, `Day ${clock.day} · ${SEASON_LABEL[clock.season]}`);
    setText(this.clockText, formatClock(clock));
    const wantedIcon = clock.daylight > 0.35 ? 'sun' : 'moon';
    if (this.seasonIcon.dataset.icon !== wantedIcon) {
      this.seasonIcon.dataset.icon = wantedIcon;
      this.seasonIcon.innerHTML = iconSvg(wantedIcon, 22);
    }

    setText(this.popText, String(haven.villagers.length));
    setText(this.moodText, `${Math.round(haven.averageMood)}%`);

    for (let i = 0; i < SPEEDS.length; i++) {
      toggleClass(this.speedButtons[i], 'is-active', state.speed === SPEEDS[i]);
    }

    this.updateTicker(state);
  }

  /** Shows the three most recent events, fading the older ones out. */
  private updateTicker(state: UiState): void {
    const recent = state.haven.logs.slice(-3);
    const newest = recent[recent.length - 1];
    if (newest && newest.id !== this.lastLogId) {
      this.lastLogId = newest.id;
      this.ticker.innerHTML = '';
      for (const entry of recent) {
        this.ticker.append(el('div', { class: `ticker-line tone-${entry.tone}`, text: entry.message }));
      }
    }

    // Fade the whole ticker out when nothing has happened for a while.
    if (newest) {
      const opacity = Math.max(0, 1 - Math.max(0, newest.age - 9) / 4);
      this.ticker.style.opacity = String(opacity);
    }
  }
}

function stat(iconName: string, value: HTMLElement, label: string): HTMLElement {
  return el('div', { class: 'stat', title: label }, icon(iconName, 18), value);
}
