/**
 * Радио гонок: mp3 из админки (/admin) играют по очереди, как радиостанция.
 * Трек грузится потоком (Range) прямо во время гонки, следующий подгружается заранее за ~25 с до конца.
 * Номер трека и место в нём помнятся между трассами (sessionStorage) — в ралли музыка не начинается заново.
 * Если треков нет или сервер недоступен — start() вернёт false, и играет встроенная музыка (audio.js).
 */
import { apiBase } from './net.js';

const KEY = 'tg.radio';

export function createRadio({ onTitle } = {}) {
  let tracks = [], i = 0, cur = null, nextEl = null, on = true, started = false, wantPlay = false;
  const base = apiBase();
  const src = (t) => base + t.url;

  function el(t) {
    const a = new Audio();
    a.preload = 'auto';
    a.src = src(t);
    a.volume = 0.85;
    return a;
  }

  function play() {
    if (!cur || !on) return;
    const p = cur.play();
    if (p && p.catch) p.catch(() => { wantPlay = true; });   // нет жеста — запустим по первому касанию
  }

  function load(index, at = 0) {
    i = ((index % tracks.length) + tracks.length) % tracks.length;
    if (cur) { cur.pause(); cur.src = ''; }
    cur = nextEl && nextEl.dataset.i === String(i) ? nextEl : el(tracks[i]);
    nextEl = null;
    if (at > 0) {
      const seek = () => { try { cur.currentTime = at; } catch (e) { /* ещё не готов */ } };
      if (cur.readyState >= 1) seek(); else cur.addEventListener('loadedmetadata', seek, { once: true });
    }
    cur.onended = () => load(i + 1);
    cur.onerror = () => setTimeout(() => load(i + 1), 800);   // битый трек — дальше
    cur.ontimeupdate = () => {
      // заранее подгружаем следующий
      if (!nextEl && tracks.length > 1 && cur.duration && cur.duration - cur.currentTime < 25) {
        const j = (i + 1) % tracks.length;
        nextEl = el(tracks[j]);
        nextEl.dataset.i = String(j);
        nextEl.load();
      }
    };
    if (onTitle) onTitle(tracks[i].title, i + 1, tracks.length);
    play();
  }

  async function start() {
    try {
      const r = await fetch(base + 'api/music', { cache: 'no-store' });
      tracks = ((await r.json()).tracks || []).filter((t) => t && t.url);
    } catch (e) {
      tracks = [];
    }
    if (!tracks.length) return false;
    started = true;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { /* без памяти */ }
    const idx = saved ? tracks.findIndex((t) => t.id === saved.id) : -1;
    load(idx >= 0 ? idx : 0, idx >= 0 ? saved.t || 0 : 0);
    for (const n of ['pointerdown', 'keydown', 'touchstart']) addEventListener(n, () => { if (wantPlay) { wantPlay = false; play(); } }, { capture: true });
    addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); cur && cur.pause(); } else play(); });
    return true;
  }

  function save() {
    if (!cur || !tracks[i]) return;
    try { sessionStorage.setItem(KEY, JSON.stringify({ id: tracks[i].id, t: cur.currentTime || 0 })); } catch (e) { /* */ }
  }

  function setOn(v) {
    on = v;
    if (!cur) return;
    if (v) play(); else cur.pause();
  }

  return { start, setOn, save, next: () => started && load(i + 1), get active() { return started; } };
}
