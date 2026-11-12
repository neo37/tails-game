/**
 * Звук «Хвостов» целиком синтезируется в браузере: без файлов, без лицензий, работает без сети.
 * renderSfx и renderBar пишут в любой BaseAudioContext, поэтому те же звуки можно отрендерить в файл для рекламного ролика.
 */
const note = (m) => 440 * 2 ** ((m - 69) / 12);

function tone(ctx, dest, t, { type = 'sine', f0, f1 = f0, dur = 0.2, vol = 0.3, attack = 0.005 }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const noiseBuffers = new WeakMap();
function noise(ctx, dest, t, { dur = 0.15, vol = 0.3, freq = 2000, q = 0.8, type = 'bandpass', sweep = 0 }) {
  let buf = noiseBuffers.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buf);
  }
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = buf;
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(dest);
  s.start(t, Math.random() * 0.5, dur + 0.02);
}

const arp = (ctx, d, t, notes, step, opt) => notes.forEach((m, i) => tone(ctx, d, t + i * step, { f0: note(m), ...opt }));

/** Один звук. k — сила: скорость распрыжки, длина серии. */
export function renderSfx(ctx, name, t, d, k = 1) {
  switch (name) {
    case 'shoot': tone(ctx, d, t, { type: 'triangle', f0: 760, f1: 300, dur: 0.11, vol: 0.13 }); break;
    case 'pop':
      tone(ctx, d, t, { type: 'sine', f0: 520, f1: 1250, dur: 0.11, vol: 0.28 });
      noise(ctx, d, t, { dur: 0.09, vol: 0.14, freq: 2800 });
      break;
    case 'shell': arp(ctx, d, t, [84, 91], 0.055, { type: 'sine', dur: 0.14, vol: 0.14 }); break;
    case 'hit':
      noise(ctx, d, t, { dur: 0.12, vol: 0.55, freq: 1500, sweep: 300 });
      tone(ctx, d, t, { type: 'sine', f0: 190, f1: 60, dur: 0.16, vol: 0.55 });
      break;
    case 'kill':                                   // убил сам: звонко
      noise(ctx, d, t, { dur: 0.2, vol: 0.4, freq: 3200, sweep: 700 });
      arp(ctx, d, t, [76, 83, 88], 0.05, { type: 'square', dur: 0.14, vol: 0.13 });
      break;
    case 'combo': {                                // серия: чем длиннее, тем выше
      const base = 72 + Math.min(16, (k | 0) * 2);
      arp(ctx, d, t, [base, base + 4, base + 7, base + 12], 0.045, { type: 'square', dur: 0.12, vol: 0.12 });
      break;
    }
    case 'bigdown':                                // пала большая тень
      noise(ctx, d, t, { dur: 0.7, vol: 0.6, freq: 900, sweep: 80, type: 'lowpass' });
      tone(ctx, d, t, { type: 'sine', f0: 130, f1: 34, dur: 0.75, vol: 0.7 });
      arp(ctx, d, t + 0.12, [72, 76, 79, 84, 88], 0.07, { type: 'triangle', dur: 0.24, vol: 0.2 });
      break;
    case 'hurt':
      tone(ctx, d, t, { type: 'sawtooth', f0: 300, f1: 90, dur: 0.24, vol: 0.2 });
      noise(ctx, d, t, { dur: 0.1, vol: 0.28, freq: 800 });
      break;
    case 'ko': arp(ctx, d, t, [67, 63, 60, 55], 0.13, { type: 'triangle', dur: 0.3, vol: 0.24 }); break;
    case 'revive': arp(ctx, d, t, [60, 64, 67, 72], 0.07, { type: 'sine', dur: 0.22, vol: 0.22 }); break;
    case 'leak': arp(ctx, d, t, [70, 66], 0.14, { type: 'square', dur: 0.26, vol: 0.13 }); break;
    case 'build':
      noise(ctx, d, t, { dur: 0.14, vol: 0.3, freq: 500 });
      tone(ctx, d, t, { type: 'sine', f0: 170, f1: 80, dur: 0.15, vol: 0.4 });
      arp(ctx, d, t + 0.07, [79, 84], 0.07, { type: 'triangle', dur: 0.17, vol: 0.15 });
      break;
    case 'grow': arp(ctx, d, t, [60, 64, 67, 72, 76, 79], 0.055, { type: 'triangle', dur: 0.22, vol: 0.19 }); break;
    case 'wave':
      tone(ctx, d, t, { type: 'sawtooth', f0: 196, f1: 262, dur: 0.42, vol: 0.14, attack: 0.05 });
      tone(ctx, d, t, { type: 'sawtooth', f0: 262, f1: 349, dur: 0.42, vol: 0.1, attack: 0.05 });
      break;
    case 'bigwave':
      for (const i of [0, 0.34]) tone(ctx, d, t + i, { type: 'sawtooth', f0: 98, f1: 92, dur: 0.32, vol: 0.28, attack: 0.02 });
      noise(ctx, d, t, { dur: 0.6, vol: 0.2, freq: 240, type: 'lowpass' });
      break;
    case 'clear': arp(ctx, d, t, [72, 76, 79, 84], 0.08, { type: 'triangle', dur: 0.24, vol: 0.2 }); break;
    case 'dance': arp(ctx, d, t, [72, 75, 79, 82, 79, 75], 0.08, { type: 'square', dur: 0.12, vol: 0.09 }); break;
    case 'jump': tone(ctx, d, t, { type: 'sine', f0: 300, f1: 620, dur: 0.14, vol: 0.13 }); break;
    case 'hop': {                                  // распрыжка: выше с разгоном
      const f = 360 + (k - 1) * 340;
      tone(ctx, d, t, { type: 'triangle', f0: f, f1: f * 2, dur: 0.14, vol: 0.17 });
      noise(ctx, d, t, { dur: 0.12, vol: 0.08, freq: 3000, type: 'highpass' });
      break;
    }
    case 'win':
      arp(ctx, d, t, [60, 64, 67, 72, 76, 79, 84], 0.11, { type: 'triangle', dur: 0.4, vol: 0.22 });
      arp(ctx, d, t + 0.77, [72, 76, 79, 84], 0, { type: 'square', dur: 0.9, vol: 0.08 });
      noise(ctx, d, t + 0.77, { dur: 0.8, vol: 0.14, freq: 6000, type: 'highpass' });
      break;
    case 'lose': arp(ctx, d, t, [67, 66, 65, 64], 0.2, { type: 'triangle', dur: 0.5, vol: 0.2 }); break;
    default:
  }
}

/* ── музыка: четыре аккорда, бодрый ритм; level 0 — спокойно, 1 — волна, 2 — большая тень ── */
export const BAR = 60 / 124 * 4;
const CHORDS = [[48, 60, 64, 67], [45, 57, 60, 64], [41, 57, 60, 65], [43, 55, 59, 62]];
const LEAD = [0, 2, 3, 2, 1, 3, 2, 0, 3, 2, 1, 2, 0, 1, 3, 1];

export function renderBar(ctx, d, t, bar, level = 0) {
  const beat = BAR / 4, ch = CHORDS[bar % 4];
  for (let i = 0; i < 8; i++) {                    // бас
    if (level === 0 && i % 2) continue;
    tone(ctx, d, t + (i * beat) / 2, { type: 'triangle', f0: note(ch[0] - (i === 6 ? 5 : 0)), dur: 0.22, vol: 0.28 });
  }
  for (let i = 0; i < 8; i++) {                    // перебор
    const m = ch[1 + (LEAD[(bar * 3 + i) % 16] % 3)] + 12;
    tone(ctx, d, t + (i * beat) / 2, { type: 'square', f0: note(m), dur: 0.1, vol: level ? 0.075 : 0.05 });
  }
  if (level >= 1) {
    for (let i = 0; i < 4; i++) {
      tone(ctx, d, t + i * beat, { type: 'sine', f0: 130, f1: 44, dur: 0.14, vol: 0.5 });
      if (i % 2) noise(ctx, d, t + i * beat, { dur: 0.1, vol: 0.2, freq: 1900 });
    }
    for (let i = 0; i < 8; i++) noise(ctx, d, t + (i * beat) / 2, { dur: 0.03, vol: 0.06, freq: 8000, type: 'highpass' });
    if (bar % 2) arp(ctx, d, t + beat * 2, [ch[3] + 12, ch[2] + 12, ch[3] + 12, ch[1] + 24], beat / 2, { type: 'triangle', dur: 0.18, vol: 0.09 });
  }
  if (level >= 2) for (let i = 0; i < 4; i++) tone(ctx, d, t + i * beat, { type: 'sawtooth', f0: note(ch[0] - 12), dur: 0.2, vol: 0.13 });
}

const GAP = { shoot: 0.09, pop: 0.05, shell: 0.12, hit: 0.05, hurt: 0.12 };

/* Пауза/продолжение всего звука по сигналу Android-обёртки (сворачивание, звонок): MainActivity зовёт
   window.__appPause() / __appResume(). На вебе то же делает visibilitychange. */
const lifecycle = { pause: new Set(), resume: new Set() };
export function onAppLifecycle(pause, resume) { lifecycle.pause.add(pause); lifecycle.resume.add(resume); }
if (typeof window !== 'undefined') {
  window.__appPause = () => lifecycle.pause.forEach((f) => { try { f(); } catch (e) { /* */ } });
  window.__appResume = () => lifecycle.resume.forEach((f) => { try { f(); } catch (e) { /* */ } });
}   // частые звуки не сливаются в кашу

class GameAudio {
  constructor() { this.ctx = null; this.on = true; this.level = 0; this.bar = 0; this.next = 0; this.playing = false; this.last = {}; this.log = null; }

  /** Браузер разрешает звук только после нажатия. */
  unlock() {
    if (this.ctx || typeof AudioContext === 'undefined') { if (this.ctx?.state === 'suspended' && !document.hidden) this.ctx.resume(); return; }
    this.ctx = new AudioContext();
    this.master = this.ctx.createDynamicsCompressor();
    this.master.connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 0.8; this.sfxBus.connect(this.master);
    this.musicBus = this.newMusicBus();
    document.addEventListener('visibilitychange', () => { if (!this.ctx) return; if (document.hidden) this.ctx.suspend(); else this.ctx.resume(); });
    onAppLifecycle(() => this.ctx && this.ctx.suspend(), () => this.ctx && !document.hidden && this.ctx.resume());
    this.timer = setInterval(() => this.schedule(), 200);
  }

  sfx(name, k = 1) {
    if (this.log) this.log.push([performance.now() / 1000, name, k]);
    if (!this.on || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (GAP[name] && now - (this.last[name] || -1) < GAP[name]) return;
    this.last[name] = now;
    renderSfx(this.ctx, name, now, this.sfxBus, k);
  }

  newMusicBus() {
    const b = this.ctx.createGain();
    b.gain.value = this.on ? 0.32 : 0;
    b.connect(this.master);
    return b;
  }

  /** Музыка вкл/выкл. Повторное включение (каждая волна) не перезапускает такты — иначе они накладывались.
   *  Выключение сразу глушит уже запланированные на ~0,6 с вперёд ноты: старая шина плавно гаснет и отключается. */
  music(on) {
    if (on === this.playing) return;
    this.playing = on;
    if (!this.ctx) return;
    if (on) { this.next = 0; return; }
    const old = this.musicBus, t = this.ctx.currentTime;
    old.gain.cancelScheduledValues(t);
    old.gain.setValueAtTime(old.gain.value, t);
    old.gain.linearRampToValueAtTime(0, t + 0.08);
    setTimeout(() => { try { old.disconnect(); } catch (e) { /* */ } }, 200);
    this.musicBus = this.newMusicBus();
  }
  setLevel(n) { this.level = n; if (this.log) this.log.push([performance.now() / 1000, 'music', n]); }
  setOn(v) {
    this.on = v;
    if (!this.master) return;
    const t = this.ctx.currentTime, g = this.musicBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v ? 0.32 : 0, t + 0.06);   // без щелчка
    if (v) this.next = 0;                                 // включили звук — музыка с ближайшей доли, без «дыры»
  }

  schedule() {
    if (!this.playing || !this.on || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05;
    while (this.next < now + 0.6) { renderBar(this.ctx, this.musicBus, this.next, this.bar++, this.level); this.next += BAR; }
  }
}
export const audio = new GameAudio();
