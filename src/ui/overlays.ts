/**
 * Full-screen layers: the title card, the settings sheet, the welcome-back
 * summary, and transient toasts.
 *
 * The title card doubles as the audio unlock - iPadOS will not start an
 * AudioContext without a gesture, so "Begin" has to be a real button somebody
 * taps, and it may as well be the front door.
 */
import { Settings } from '../state/save';
import { el, onTap, setText, toggleClass } from './dom';
import { icon, iconSvg } from './icons';
import { UiHandlers } from './types';

export class Toasts {
  readonly root = el('div', { class: 'toasts' });

  show(title: string, body?: string, tone: 'good' | 'neutral' = 'neutral'): void {
    const node = el(
      'div',
      { class: `toast tone-${tone}` },
      el('strong', { text: title }),
      body ? el('span', { text: body }) : null,
    );
    this.root.append(node);
    // Two animation frames so the transition actually plays.
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('is-in')));
    window.setTimeout(() => {
      node.classList.remove('is-in');
      window.setTimeout(() => node.remove(), 400);
    }, 4200);
  }
}

export class TitleCard {
  readonly root: HTMLElement;
  private subtitle: HTMLElement;
  private beginLabel: HTMLElement;

  constructor(handlers: UiHandlers) {
    this.subtitle = el('p', {
      class: 'title-sub',
      text: 'You move the earth. They decide what to do about it.',
    });
    this.beginLabel = el('span', { text: 'Begin' });

    const begin = el('button', { class: 'title-button' }, this.beginLabel);
    onTap(begin, () => handlers.startGame());

    this.root = el(
      'div',
      { class: 'title-card' },
      el(
        'div',
        { class: 'title-inner' },
        el('div', { class: 'title-mark', html: iconSvg('home', 56) }),
        el('h1', { class: 'title-name', text: 'Pixel Haven' }),
        this.subtitle,
        begin,
        el(
          'div',
          { class: 'title-hints' },
          hint('One finger', 'turns the island'),
          hint('Two fingers', 'pinch to zoom, slide to pan'),
          hint('Tap a villager', 'to see what they are up to'),
          hint('Shape', 'raise and flatten ground; they build where they can'),
        ),
      ),
    );
  }

  setReturning(hasSave: boolean): void {
    setText(this.beginLabel, hasSave ? 'Continue' : 'Begin');
    setText(
      this.subtitle,
      hasSave
        ? 'Your haven carried on without you. Come and see.'
        : 'You move the earth. They decide what to do about it.',
    );
  }

  hide(): void {
    this.root.classList.add('is-hidden');
  }

  show(): void {
    this.root.classList.remove('is-hidden');
  }
}

export class AwayCard {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private details: HTMLElement;

  constructor(handlers: UiHandlers) {
    this.body = el('p', { class: 'away-body', text: '' });
    this.details = el('div', { class: 'away-details' });

    const dismiss = el('button', { class: 'panel-button is-primary' }, el('span', { text: 'Good' }));
    onTap(dismiss, () => {
      this.root.classList.remove('is-open');
      handlers.dismissIntro();
    });

    this.root = el(
      'div',
      { class: 'away-card' },
      el('h2', { text: 'While you were away' }),
      this.body,
      this.details,
      dismiss,
    );
  }

  present(summary: string, rows: { icon: string; text: string }[]): void {
    setText(this.body, summary);
    this.details.innerHTML = '';
    for (const row of rows) {
      this.details.append(el('div', { class: 'away-row' }, icon(row.icon, 16), el('span', { text: row.text })));
    }
    this.root.classList.add('is-open');
  }
}

export class SettingsSheet {
  readonly root: HTMLElement;
  private rows = new Map<string, HTMLInputElement>();
  private toggles = new Map<string, HTMLElement>();
  private seedInput: HTMLInputElement;

  constructor(private handlers: UiHandlers) {
    const close = el('button', { class: 'icon-button', html: iconSvg('close', 16), 'aria-label': 'Close' });
    onTap(close, () => this.hide());

    const sliders = el(
      'div',
      { class: 'settings-group' },
      this.slider('master', 'Overall volume'),
      this.slider('music', 'Music'),
      this.slider('ambience', 'Ambience'),
      this.slider('sfx', 'Effects'),
    );

    const switches = el(
      'div',
      { class: 'settings-group' },
      this.toggle('muted', 'Mute everything'),
      this.toggle('shadows', 'Shadows'),
      this.toggle('weather', 'Weather effects'),
      this.toggle('showBubbles', 'Thought bubbles'),
    );

    this.seedInput = el('input', {
      class: 'seed-input',
      type: 'text',
      placeholder: 'island seed',
      spellcheck: false,
      autocapitalize: 'off',
      autocomplete: 'off',
    }) as HTMLInputElement;

    const newWorld = el('button', { class: 'panel-button' }, icon('leaf', 16), el('span', { text: 'New island' }));
    onTap(newWorld, () => {
      const seed = this.seedInput.value.trim() || randomSeed();
      this.hide();
      this.handlers.newWorld(seed);
    });

    const reset = el('button', { class: 'panel-button is-danger' }, el('span', { text: 'Abandon this haven' }));
    onTap(reset, () => {
      if (reset.dataset.armed === 'yes') {
        this.hide();
        this.handlers.resetHaven();
        return;
      }
      reset.dataset.armed = 'yes';
      reset.textContent = 'Tap again to confirm';
      window.setTimeout(() => {
        reset.dataset.armed = 'no';
        reset.textContent = 'Abandon this haven';
      }, 4000);
    });

    this.root = el(
      'div',
      { class: 'sheet' },
      el(
        'div',
        { class: 'sheet-inner' },
        el('div', { class: 'sheet-head' }, el('h2', { text: 'Settings' }), close),
        sliders,
        switches,
        el(
          'div',
          { class: 'settings-group' },
          el('label', { class: 'settings-label', text: 'Start a different island' }),
          el('div', { class: 'seed-row' }, this.seedInput, newWorld),
          el('p', {
            class: 'settings-note',
            text: 'The same seed always grows the same island. Leave it blank for a surprise.',
          }),
          reset,
        ),
        el(
          'div',
          { class: 'settings-group about' },
          el('p', {
            text: 'Pixel Haven runs entirely on your device. Add it to your Home Screen to play it full screen and offline.',
          }),
        ),
      ),
    );
    this.hide();
  }

  private slider(key: keyof Settings, label: string): HTMLElement {
    const input = el('input', {
      class: 'slider',
      type: 'range',
      min: '0',
      max: '100',
      value: '80',
    }) as HTMLInputElement;
    input.addEventListener('input', () => {
      this.handlers.changeSetting(key, (Number(input.value) / 100) as never);
    });
    this.rows.set(key, input);
    return el('div', { class: 'settings-row' }, el('label', { class: 'settings-label', text: label }), input);
  }

  private toggle(key: keyof Settings, label: string): HTMLElement {
    const knob = el('span', { class: 'switch-knob' });
    const button = el('button', { class: 'switch' }, knob);
    onTap(button, () => {
      const next = !button.classList.contains('is-on');
      this.handlers.changeSetting(key, next as never);
    });
    this.toggles.set(key, button);
    return el('div', { class: 'settings-row' }, el('label', { class: 'settings-label', text: label }), button);
  }

  sync(settings: Settings): void {
    for (const [key, input] of this.rows) {
      const value = Math.round((settings[key as keyof Settings] as number) * 100);
      if (document.activeElement !== input) input.value = String(value);
    }
    for (const [key, button] of this.toggles) {
      toggleClass(button, 'is-on', Boolean(settings[key as keyof Settings]));
    }
  }

  show(): void {
    this.root.classList.add('is-open');
  }

  hide(): void {
    this.root.classList.remove('is-open');
  }

  get isOpen(): boolean {
    return this.root.classList.contains('is-open');
  }
}

function hint(key: string, text: string): HTMLElement {
  return el('div', { class: 'title-hint' }, el('strong', { text: key }), el('span', { text }));
}

export function randomSeed(): string {
  const words = ['moss', 'ember', 'harbour', 'fern', 'kettle', 'lantern', 'willow', 'quarry', 'tide', 'birch'];
  const a = words[Math.floor(Math.random() * words.length)];
  const b = words[Math.floor(Math.random() * words.length)];
  return `${a}-${b}-${Math.floor(Math.random() * 900 + 100)}`;
}
