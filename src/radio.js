/**
 * Радио гонок: mp3 из админки (/admin) играют по очереди, как радиостанция.
 * Трек грузится потоком (Range) прямо во время гонки, следующий подгружается заранее за ~25 с до конца.
 * Номер трека и место в нём помнятся между трассами (sessionStorage) — в ралли музыка не начинается заново.
 * Если треков нет или сервер недоступен — start() вернёт false, и играет встроенная музыка (audio.js).
 */
import { apiBase } from './net.js';
import { onAppLifecycle } from './audio.js';

const KEY = 'tg.radio';

export function createRadio({ onTitle, onFail } = {}) {
  let tracks = [], i = 0, cur = null, nextEl = null, on = true, started = false, wantPlay = false, fails = 0, dead = false,
    paused = false;
  const base = apiBase();
  const src = (t) => base + t.url;

  function el(t) {
    const a = new Audio();
    a.preload = 'auto';
    a.src = src(t);
    a.volume = 0.85;
    return a;
  }

  /** Отцепить и остановить элемент. Важно снять обработчики ДО очистки src: иначе очистка вызывает error →
   *  onerror запускал ещё один трек (двойной пропуск и два трека разом при переключении). */
  function drop(a) {
    if (!a) return;
    a.onended = a.onerror = a.ontimeupdate = a.onplaying = null;
    try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* */ }
  }

  function play() {
    if (!cur || !on || dead || paused) return;
    const p = cur.play();
    if (p && p.catch) p.catch(() => { wantPlay = true; });   // нет жеста — запустим по первому касанию
  }

  function load(index, at = 0) {
    i = ((index % tracks.length) + tracks.length) % tracks.length;
    const old = cur;
    cur = nextEl && nextEl.dataset.i === String(i) ? nextEl : el(tracks[i]);
    if (nextEl && nextEl !== cur) drop(nextEl);
    nextEl = null;
    drop(old);
    if (at > 0) {
      const seek = () => { try { cur.currentTime = at; } catch (e) { /* ещё не готов */ } };
      if (cur.readyState >= 1) seek(); else cur.addEventListener('loadedmetadata', seek, { once: true });
    }
    const me = cur;
    cur.onended = () => { if (cur === me) load(i + 1); };
    cur.onplaying = () => { fails = 0; };
    cur.onerror = () => {                                       // битый трек — дальше; все битые — встроенная музыка
      if (cur !== me) return;
      if (++fails >= Math.max(2, tracks.length)) {
        dead = true; drop(cur); cur = null;
        if (onFail) onFail();
        return;
      }
      setTimeout(() => { if (cur === me) load(i + 1); }, 800);
    };
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
    document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); cur && cur.pause(); } else if (!paused) play(); });
    onAppLifecycle(() => { paused = true; save(); cur && cur.pause(); }, () => { paused = false; if (!document.hidden) play(); });
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

  let lastNext = 0;
  function next() {                                   // частые нажатия на чип не листают по три трека за раз
    if (!started || dead || performance.now() - lastNext < 600) return;
    lastNext = performance.now();
    fails = 0;
    load(i + 1);
    save();
  }

  return { start, setOn, save, next, get active() { return started && !dead; } };
}
