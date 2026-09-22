/**
 * Sound, generated rather than loaded.
 *
 * Every note and every bird is synthesised with Web Audio, so the game ships
 * with no audio files at all and the soundtrack never loops audibly - it is a
 * slow generative pad over a wandering pentatonic, and it will happily play for
 * hours without repeating itself.
 *
 * The mix is driven by the camera: pulled back you hear wind, water and the
 * pad; pushed in among the houses the birds, crickets, fire and chatter fade
 * up. That is the "zoom-level sound effects" line in the brief, taken at its
 * word.
 */
import { clamp01 } from '../core/mathx';

export type SfxName =
  | 'select'
  | 'place'
  | 'cancel'
  | 'complete'
  | 'chop'
  | 'mine'
  | 'miracle'
  | 'arrive'
  | 'tick';

/** A warm pentatonic. Everything in the score is drawn from these degrees. */
const SCALE = [0, 2, 4, 7, 9];
const ROOT = 220; // A3

/** Chord roots, in scale degrees, cycling slowly. */
const PROGRESSION = [0, 5, 3, 4, 0, 2, 5, 3];

const noteFreq = (semitones: number): number => ROOT * Math.pow(2, semitones / 12);
const degreeToSemitone = (degree: number): number => {
  const octave = Math.floor(degree / SCALE.length);
  return SCALE[((degree % SCALE.length) + SCALE.length) % SCALE.length] + octave * 12;
};

export interface AudioMixState {
  /** 0 = wide shot, 1 = right down among the villagers. */
  zoom: number;
  /** 0 = night, 1 = day. */
  daylight: number;
  /** True when there is a lit hearth near the camera. */
  nearFire: boolean;
  /** Number of villagers currently chatting nearby. */
  chatter: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicGain!: GainNode;
  private ambienceGain!: GainNode;
  private sfxGain!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;

  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private waveGain!: GainNode;
  private waveFilter!: BiquadFilterNode;
  private fireGain!: GainNode;
  private noiseBuffer!: AudioBuffer;

  private schedulerId: number | null = null;
  private nextNoteTime = 0;
  private beat = 0;
  private started = false;
  private mix: AudioMixState = { zoom: 0.4, daylight: 1, nearFire: false, chatter: 0 };

  private settings = { master: 0.8, music: 0.62, ambience: 0.75, sfx: 0.85, muted: false };
  private birdTimer = 2;
  private chatterTimer = 3;

  get isRunning(): boolean {
    return this.started && this.ctx?.state === 'running';
  }

  /**
   * Must be called from a user gesture. iPadOS will not let an AudioContext
   * start any other way.
   */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.build();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.started) {
      this.started = true;
      this.nextNoteTime = this.ctx.currentTime + 0.1;
      this.schedulerId = window.setInterval(() => this.schedule(), 90);
    }
    this.applyVolumes();
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.applyVolumes();
  }

  get muted(): boolean {
    return this.settings.muted;
  }

  setVolume(kind: 'master' | 'music' | 'ambience' | 'sfx', value: number): void {
    this.settings[kind] = clamp01(value);
    this.applyVolumes();
  }

  getVolume(kind: 'master' | 'music' | 'ambience' | 'sfx'): number {
    return this.settings[kind];
  }

  /* --------------------------------------------------------------- graph */

  private build(): void {
    const ctx = this.ctx!;

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.master;
    this.master.connect(ctx.destination);

    // A soft limiter keeps a busy haven from clipping.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 18;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.2;
    limiter.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = createImpulse(ctx, 2.6, 2.4);
    this.reverb.connect(limiter);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.32;
    this.reverbSend.connect(this.reverb);

    this.musicGain = ctx.createGain();
    this.musicGain.connect(limiter);
    this.musicGain.connect(this.reverbSend);

    this.ambienceGain = ctx.createGain();
    this.ambienceGain.connect(limiter);

    this.sfxGain = ctx.createGain();
    this.sfxGain.connect(limiter);
    const sfxSend = ctx.createGain();
    sfxSend.gain.value = 0.22;
    this.sfxGain.connect(sfxSend);
    sfxSend.connect(this.reverb);

    this.noiseBuffer = createNoiseBuffer(ctx, 4);
    this.buildAmbience();
    this.applyVolumes();
  }

  /** Three looping noise beds: wind, surf, and a fire that fades in near one. */
  private buildAmbience(): void {
    const ctx = this.ctx!;

    const makeBed = (
      filterType: BiquadFilterType,
      frequency: number,
      q: number,
      gain: number,
    ): { gain: GainNode; filter: BiquadFilterNode } => {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const node = ctx.createGain();
      node.gain.value = gain;
      source.connect(filter);
      filter.connect(node);
      node.connect(this.ambienceGain);
      source.start();
      return { gain: node, filter };
    };

    const wind = makeBed('bandpass', 520, 0.7, 0.05);
    this.windGain = wind.gain;
    this.windFilter = wind.filter;

    const waves = makeBed('lowpass', 420, 0.8, 0.07);
    this.waveGain = waves.gain;
    this.waveFilter = waves.filter;

    const fire = makeBed('bandpass', 1300, 1.4, 0);
    this.fireGain = fire.gain;
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const m = this.settings.muted ? 0 : 1;
    this.master.gain.value = this.settings.master * m;
    this.musicGain.gain.value = this.settings.music * 0.5;
    this.ambienceGain.gain.value = this.settings.ambience * 0.9;
    this.sfxGain.gain.value = this.settings.sfx;
  }

  /* ----------------------------------------------------------------- mix */

  /** Called every frame with the current camera and world state. */
  update(dt: number, state: AudioMixState): void {
    this.mix = state;
    if (!this.ctx || !this.started) return;
    const now = this.ctx.currentTime;
    const zoom = clamp01(state.zoom);

    // Wind and surf dominate the wide shot; detail sounds belong up close.
    rampTo(this.windGain.gain, 0.02 + (1 - zoom) * 0.055, now, 0.6);
    rampTo(this.windFilter.frequency, 420 + (1 - zoom) * 260, now, 1.2);
    rampTo(this.waveGain.gain, 0.03 + (1 - zoom) * 0.07, now, 0.6);
    rampTo(this.waveFilter.frequency, 300 + Math.sin(now * 0.12) * 120, now, 1.5);
    rampTo(this.fireGain.gain, state.nearFire ? 0.016 + zoom * 0.05 : 0, now, 0.8);

    // Birdsong by day, crickets after dark, both only when you are close.
    this.birdTimer -= dt;
    if (this.birdTimer <= 0 && zoom > 0.25) {
      this.birdTimer = 1.4 + Math.random() * 4.5;
      if (state.daylight > 0.3) this.bird(zoom);
      else if (Math.random() < 0.6) this.cricket(zoom);
    }

    this.chatterTimer -= dt;
    if (this.chatterTimer <= 0) {
      this.chatterTimer = 2.2 + Math.random() * 3.5;
      if (state.chatter > 0 && zoom > 0.35 && Math.random() < 0.55) this.chatter(zoom);
    }
  }

  /* -------------------------------------------------------------- score */

  /** Look-ahead scheduler: queues notes slightly before they are due. */
  private schedule(): void {
    if (!this.ctx || this.settings.muted) return;
    const ctx = this.ctx;
    const secondsPerBeat = 1.15; // a shade under 55 bpm - unhurried

    while (this.nextNoteTime < ctx.currentTime + 0.7) {
      this.playBeat(this.beat, this.nextNoteTime, secondsPerBeat);
      this.nextNoteTime += secondsPerBeat;
      this.beat++;
    }
  }

  private playBeat(beat: number, time: number, secondsPerBeat: number): void {
    const chordIndex = Math.floor(beat / 8) % PROGRESSION.length;
    const chordRoot = PROGRESSION[chordIndex];
    const zoom = clamp01(this.mix.zoom);
    const night = 1 - clamp01(this.mix.daylight);

    // Pad: a new chord every eight beats, held and slowly opening.
    if (beat % 8 === 0) {
      const duration = secondsPerBeat * 8.4;
      for (const offset of [0, 2, 4]) {
        this.pad(noteFreq(degreeToSemitone(chordRoot + offset)), time, duration, 0.055);
      }
      // A low root underneath, an octave down.
      this.pad(noteFreq(degreeToSemitone(chordRoot) - 12), time, duration, 0.05);
    }

    // Plucked melody: sparse, and sparser at night.
    const melodyChance = 0.28 + zoom * 0.3 - night * 0.12;
    if (beat % 2 === 0 && Math.random() < melodyChance) {
      const degree = chordRoot + [0, 2, 4, 5, 7][Math.floor(Math.random() * 5)];
      this.pluck(noteFreq(degreeToSemitone(degree) + 12), time, 0.09 + zoom * 0.05);
    }

    // The occasional grace note an octave up, to keep it from settling.
    if (beat % 16 === 7 && Math.random() < 0.5) {
      this.pluck(noteFreq(degreeToSemitone(chordRoot + 7) + 24), time + secondsPerBeat * 0.5, 0.045);
    }
  }

  private pad(frequency: number, time: number, duration: number, level: number): void {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(level, time + 1.6);
    gain.gain.setValueAtTime(level, time + duration - 2.0);
    gain.gain.linearRampToValueAtTime(0, time + duration);
    gain.connect(this.musicGain);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(420, time);
    filter.frequency.linearRampToValueAtTime(1500, time + duration * 0.55);
    filter.frequency.linearRampToValueAtTime(600, time + duration);
    filter.Q.value = 0.6;
    filter.connect(gain);

    // Two slightly detuned voices give the pad its warmth.
    for (const detune of [-5, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.1);
    }
  }

  private pluck(frequency: number, time: number, level: number): void {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.5);
    gain.connect(this.musicGain);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, time);
    filter.frequency.exponentialRampToValueAtTime(700, time + 1.1);
    filter.connect(gain);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = frequency;
    osc.connect(filter);
    osc.start(time);
    osc.stop(time + 1.6);
  }

  /* ---------------------------------------------------------- ambience */

  private bird(zoom: number): void {
    const ctx = this.ctx!;
    const time = ctx.currentTime + 0.02;
    const base = 1800 + Math.random() * 1400;
    const notes = 2 + Math.floor(Math.random() * 3);

    for (let i = 0; i < notes; i++) {
      const start = time + i * (0.07 + Math.random() * 0.06);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const gain = ctx.createGain();
      const level = 0.025 * zoom;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(level, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
      osc.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.35), start);
      osc.frequency.exponentialRampToValueAtTime(base * (1.1 + Math.random() * 0.5), start + 0.1);
      osc.connect(gain);
      gain.connect(this.ambienceGain);
      osc.start(start);
      osc.stop(start + 0.16);
    }
  }

  private cricket(zoom: number): void {
    const ctx = this.ctx!;
    const time = ctx.currentTime + 0.02;
    for (let i = 0; i < 4; i++) {
      const start = time + i * 0.085;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 4200 + Math.random() * 400;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.008 * zoom, start + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.04);
      osc.connect(gain);
      gain.connect(this.ambienceGain);
      osc.start(start);
      osc.stop(start + 0.06);
    }
  }

  /** Wordless murmur - two or three filtered blips, like distant talking. */
  private chatter(zoom: number): void {
    const ctx = this.ctx!;
    const time = ctx.currentTime + 0.02;
    const syllables = 2 + Math.floor(Math.random() * 3);
    const pitch = 160 + Math.random() * 120;

    for (let i = 0; i < syllables; i++) {
      const start = time + i * (0.11 + Math.random() * 0.05);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(pitch * (0.9 + Math.random() * 0.3), start);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 750 + Math.random() * 500;
      filter.Q.value = 4;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.02 * zoom, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.ambienceGain);
      osc.start(start);
      osc.stop(start + 0.13);
    }
  }

  /* --------------------------------------------------------------- sfx */

  play(name: SfxName): void {
    if (!this.ctx || !this.started || this.settings.muted) return;
    const ctx = this.ctx;
    const time = ctx.currentTime + 0.01;

    switch (name) {
      case 'select':
        this.blip(880, time, 0.07, 'sine', 0.09);
        break;
      case 'place':
        this.blip(520, time, 0.09, 'triangle', 0.12);
        this.blip(780, time + 0.06, 0.08, 'triangle', 0.08);
        break;
      case 'cancel':
        this.blip(420, time, 0.1, 'sine', 0.09);
        this.blip(300, time + 0.05, 0.12, 'sine', 0.07);
        break;
      case 'complete':
        // A small rising figure - the one moment of fanfare in the game.
        [0, 4, 7, 12].forEach((step, i) => {
          this.blip(noteFreq(step + 12), time + i * 0.09, 0.3, 'triangle', 0.1);
        });
        break;
      case 'chop':
        this.thud(time, 190, 0.16);
        break;
      case 'mine':
        this.thud(time, 130, 0.2);
        this.noiseBurst(time, 2400, 0.06, 0.05);
        break;
      case 'miracle':
        [0, 5, 9, 12, 16].forEach((step, i) => {
          this.blip(noteFreq(step + 24), time + i * 0.07, 0.5, 'sine', 0.055);
        });
        break;
      case 'arrive':
        [0, 7, 12].forEach((step, i) => this.blip(noteFreq(step), time + i * 0.12, 0.35, 'triangle', 0.08));
        break;
      case 'tick':
        this.blip(1200, time, 0.035, 'square', 0.03);
        break;
    }
  }

  private blip(
    frequency: number,
    time: number,
    duration: number,
    type: OscillatorType,
    level: number,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  private thud(time: number, frequency: number, duration: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, time);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.4, time + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  private noiseBurst(time: number, frequency: number, duration: number, level: number): void {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxGain);
    source.start(time, Math.random() * 2, duration + 0.05);
  }

  dispose(): void {
    if (this.schedulerId !== null) window.clearInterval(this.schedulerId);
    this.schedulerId = null;
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}

function rampTo(param: AudioParam, value: number, now: number, seconds: number): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, Math.max(0.01, seconds / 3));
}

/** Noise-burst impulse response - a small, soft room. */
function createImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  // Brown-ish noise: gentler on the ear than white for a background bed.
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}
