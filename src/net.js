/**
 * Связь с сервером командной игры: одно WebSocket-соединение на вкладку.
 * Токен игрока живёт в sessionStorage — при переходе «лобби → игра» и при обрыве связи
 * сервер узнаёт того же игрока и возвращает его место в комнате.
 */
import { parseKit, kitString } from './shop.js';
import { isNick, randomNick, safeName, ANON } from './nick.js';

export const COLORS = ['#ffd447', '#ff6f91', '#8fd0ff', '#9be37a', '#c7b0ff', '#ffa45c'];
export const EMOJIS = ['🦊', '🐱', '🐬', '🐢', '🦄', '🐝', '🐙', '🐸', '🐼', '🦁', '🐵', '🐧', '🦉', '🦖', '🐰', '🐯'];
export const HERO_IDS = ['maskot', 'ghost'];          // Танцовщицу (Tiny Dancer) игроку больше не предлагаем
export const SHIP_IDS = ['wedge', 'arrow', 'delta'];          // корабль в гонке (src/ships.js)
export const TINTS = ['', '#ff9dbb', '#8fd0ff', '#9be37a', '#ffe07a', '#c7b0ff', '#ffa45c', '#8b8fa8'];   // цвет поверх текстуры, '' — как есть

/** Ник — только из готовых слов (src/nick.js). Старое имя, набранное вручную, один раз заменяется случайным ником. */
export function me() {
  let m = {};
  try { m = JSON.parse(localStorage.getItem('tg.me') || '{}'); } catch (e) { /* */ }
  const fresh = !isNick(m.name);
  const p = {
    name: fresh ? randomNick() : m.name,
    color: COLORS.includes(m.color) ? m.color : COLORS[0],
    emoji: EMOJIS.includes(m.emoji) ? m.emoji : EMOJIS[0],
    hero: HERO_IDS.includes(m.hero) ? m.hero : HERO_IDS[0],
    tint: TINTS.includes(m.tint) ? m.tint : '',
    ship: SHIP_IDS.includes(m.ship) ? m.ship : SHIP_IDS[0],
    kit: parseKit(kitString(m.kit || {})),     // надетые ачивки корабля (src/shop.js)
  };
  if (fresh) saveMe(p);
  return p;
}
export function saveMe(m) { try { localStorage.setItem('tg.me', JSON.stringify(m)); } catch (e) { /* */ } }

/* Чужие игроки, как их показываем: ник — только из готовых слов, значок — только из списка. */
export const safeEmoji = (e) => (EMOJIS.includes(e) ? e : EMOJIS[0]);
/** Подпись «🦊 Смелая Лиса» из списка открытых игр. */
export const safeLabel = (s) => {
  const m = /^(\S+) (.+)$/u.exec(String(s || ''));
  return m ? `${safeEmoji(m[1])} ${safeName(m[2])}` : ANON;
};
/** Комната с сервера: имена и значки игроков, ведущий в списке игр, название чужого своего уровня (свободный текст). */
function cleanRoom(r) {
  if (!r || typeof r !== 'object') return;
  if (Array.isArray(r.players)) for (const p of r.players) { p.name = safeName(p.name); p.emoji = safeEmoji(p.emoji); }
  if (typeof r.host === 'string') r.host = safeLabel(r.host);
  if (r.map === 'custom') r.levelName = '';
}

/** Игра открыта в приложении: Android — страницы с appassets.androidplatform.net, iOS — со своей схемы tails://app/. */
const inApp = () => location.host.endsWith('androidplatform.net') || location.protocol === 'tails:';

/** Адрес HTTP-сервера игры: в приложении — spacecode.business, в браузере — рядом со страницей. */
export const apiBase = () => (inApp() ? 'https://spacecode.business/tails/play/' : location.pathname.replace(/[^/]*$/, ''));

const tokenKey = 'tg.token';
const getToken = () => { try { return sessionStorage.getItem(tokenKey) || ''; } catch (e) { return ''; } };
const setToken = (t) => { try { sessionStorage.setItem(tokenKey, t); } catch (e) { /* */ } };

export class Net {
  constructor() {
    this.handlers = {};
    this.id = 0;
    this.queue = [];
    this.closedByUs = false;
    this.retry = 0;
    this.open = false;
  }

  on(t, fn) { (this.handlers[t] ||= []).push(fn); return this; }
  emit(t, m) { for (const fn of this.handlers[t] || []) fn(m); }

  connect(profile) {
    this.profile = profile;
    // сервер командной игры: в приложении (Android и iOS) — spacecode.business/tails/play,
    // в браузере — рядом со страницей (/ws на корне или /tails/play/ws за nginx)
    const dir = location.pathname.replace(/[^/]*$/, '');
    const url = window.TAILS_WS || (inApp() ? 'wss://spacecode.business/tails/play/ws'
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${dir}ws`);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.retry = 0;
      const k = this.profile.kit;
      ws.send(JSON.stringify({ t: 'hello', token: getToken(), ...this.profile, kit: typeof k === 'string' ? k : kitString(k || {}) }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      // эту же вкладку-игрока открыли заново (например, лобби → игра): старое соединение не переподключаем,
      // иначе два соединения выбивали бы друг друга по кругу
      if (m.t === 'kicked') this.closedByUs = true;
      if (m.t === 'room') cleanRoom(m.room);
      if (m.t === 'rooms' && Array.isArray(m.rooms)) m.rooms.forEach(cleanRoom);
      if (m.t === 'welcome') {
        this.id = m.id;
        setToken(m.token);
        const q = this.queue; this.queue = [];
        for (const x of q) ws.send(x);
      }
      this.emit(m.t, m);
    };
    ws.onclose = () => {
      this.open = false;
      this.emit('down', {});
      if (this.closedByUs) return;
      const wait = Math.min(5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(this.profile), wait);
    };
    return new Promise((resolve) => { const h = () => resolve(this); this.on('welcome', h); });
  }

  send(m) {
    const s = JSON.stringify(m);
    if (this.ws && this.ws.readyState === 1 && this.id) this.ws.send(s);
    // пока переподключаемся — действия копим (построить/подрасти не должны теряться), позицию и снимки — нет
    else if (m.t !== 'snap' && !(m.t === 'act' && m.a && m.a.k === 'pos') && this.queue.length < 50) this.queue.push(s);
  }

  close() { this.closedByUs = true; try { this.ws.close(); } catch (e) { /* */ } }
}
