/**
 * Свои уровни из редактора: клеточное поле 15×13, клетка 6 ед.
 *   '.' трава   '#' дорога   'o' плита под подружку   'S' старт теней (1–2)   'H' домик
 * Уровень хранится строкой (код для обмена): base64url от компактного JSON.
 * Модуль без DOM — им же пользуется сервер (проверяет уровень, присланный хостом комнаты).
 */
import { isNick } from './nick.js';
import { Grid, CELL } from './grid.js';

export const EW = 15, EH = 13;
export const DIFFS = {
  easy: { name: 'Легко', hpK: 3, speed: 0.9 },
  mid:  { name: 'Средне', hpK: 5, speed: 1.0 },
  hard: { name: 'Трудно', hpK: 7.5, speed: 1.15 },
};
export const THEMES = {
  quay:   { name: 'Набережная', friends: ['mila', 'teya', 'niksha', 'iva'], enemy: 'dancer', sky: 0x8fd4e8, sea: 0x1f7fa8, land: 0x86a86a, shells: 150 },
  castle: { name: 'Замок', friends: ['castle'], enemy: 'dancer', sky: 0x9fd2e6, sea: 0x1d7aa0, land: 0x8fae6f, shells: 150 },
};

/** Кого можно выбрать защитниками уровня (замок — наравне со всеми). */
export const PICK_FRIENDS = ['mila', 'teya', 'niksha', 'iva', 'maskot', 'castle'];
export const DEFAULT_FRIENDS = ['mila', 'teya', 'niksha', 'iva', 'castle'];
export const GHOSTS = {
  none: { name: 'Без привидений', chance: 0 }, few: { name: 'Немного', chance: 0.25 },
  many: { name: 'Много', chance: 0.5 }, all: { name: 'Только привидения', chance: 1 },
};

/* ── автор: аккаунтов нет, поэтому это метка устройства. Править можно только своё, чужое — скопировать. ── */
const store = () => (typeof localStorage !== 'undefined' ? localStorage : null);
export function authorId() {
  const ls = store();
  if (!ls) return '';
  let id = ls.getItem('tg.author');
  if (!id) { id = Math.random().toString(36).slice(2, 10); ls.setItem('tg.author', id); }
  return id;
}
/** Ник автора для кода уровня — только из готовых слов (src/nick.js), иначе без имени. */
export function authorName() {
  try { const n = JSON.parse(store().getItem('tg.me') || '{}').name; return isNick(n) ? n : ''; } catch (e) { return ''; }
}
/** Свой ли уровень. У старых сохранённых автора нет: они созданы здесь, значит свои. У чужого кода без автора — unknown. */
export const isMine = (d) => !d.author || d.author === authorId();
/** Копия чужого уровня: автор теперь ты, правь как хочешь. */
export function copyDesign(d) {
  const { id, ...rest } = d;
  return { ...rest, author: authorId(), authorName: authorName(), from: d.authorName || '', name: `${String(d.name || 'Уровень').slice(0, 17)} (копия)` };
}

export const emptyCells = () => '.'.repeat(EW * EH);

/** Пример для пустого редактора: прямая дорожка слева направо и четыре плиты. */
export function sampleDesign() {
  const c = emptyCells().split('');
  const j = 6;
  for (let i = 1; i < EW - 1; i++) c[j * EW + i] = '#';
  c[j * EW + 1] = 'S';
  c[j * EW + EW - 2] = 'H';
  for (const i of [3, 6, 9, 12]) c[(j - 2) * EW + i] = 'o';
  return { v: 1, name: 'Мой уровень', cells: c.join(''), target: 8, diff: 'easy', theme: 'quay', friends: DEFAULT_FRIENDS.slice(), ghosts: 'few' };
}

/** Проверка и построение маршрутов: от каждого старта по дороге до домика (A* по клеткам). */
export function analyze(design) {
  const g = new Grid(EW, EH);
  const c = design.cells || '';
  const errors = [];
  if (c.length !== EW * EH) return { ok: false, errors: ['повреждённый уровень'], paths: [], spots: [] };
  const spawns = [], houses = [], spots = [];
  for (let k = 0; k < c.length; k++) {
    if (c[k] === 'S') spawns.push(k);
    if (c[k] === 'H') houses.push(k);
    if (c[k] === 'o') spots.push(k);
  }
  if (!spawns.length) errors.push('Поставь старт теней (S)');
  if (spawns.length > 2) errors.push('Стартов может быть не больше двух');
  if (houses.length !== 1) errors.push(houses.length ? 'Домик должен быть один' : 'Поставь домик (H)');
  if (spots.length < 2) errors.push('Нужно хотя бы 2 плиты под подружек');
  const road = (k) => c[k] === '#' || c[k] === 'S' || c[k] === 'H';
  const paths = [];
  if (houses.length === 1) {
    for (const s of spawns) {
      const cells = g.astar(s, houses[0], road);
      if (!cells) { errors.push('Нет дороги от старта до домика'); continue; }
      if (cells.length < 4) { errors.push('Дорога слишком короткая'); continue; }
      paths.push(g.polyline(cells));
    }
  }
  return { ok: !errors.length, errors, paths, spots: spots.map((k) => g.center(k)), grid: g };
}

/** Дизайн → уровень для игры (тот же формат, что в levels.js). */
export function toLevel(design, id = 'my') {
  const a = analyze(design);
  if (!a.ok) return null;
  const th = THEMES[design.theme] || THEMES.quay;
  const df = DIFFS[design.diff] || DIFFS.mid;
  // дорога заканчивается на клетке домика, а домик в игре стоит в 5 ед. за концом — укорачиваем на полклетки
  const paths = a.paths.map((p) => {
    const q = p.map((v) => v.slice());
    const n = q.length, A = q[n - 2], B = q[n - 1];
    const l = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    q[n - 1] = [B[0] - ((B[0] - A[0]) / l) * (CELL / 2 + 2), B[1] - ((B[1] - A[1]) / l) * (CELL / 2 + 2)];
    return q;
  });
  return {
    id, map: 'custom', name: String(design.name || 'Мой уровень').slice(0, 24), hint: 'Уровень из редактора.',
    path: paths[0], paths: paths.length > 1 ? paths : undefined, spotsList: a.spots, castleWide: design.theme === 'castle',
    enemy: th.enemy, friends: design.friends && design.friends.length ? design.friends : th.friends, shells: th.shells, target: Math.max(3, Math.min(25, design.target | 0 || 8)),
    speed: df.speed, hpK: df.hpK, ghosts: GHOSTS[design.ghosts] ? GHOSTS[design.ghosts].chance : design.theme === 'castle' ? 0.35 : 0.25,
    sky: th.sky, sea: th.sea, land: th.land, runner: true, design,
  };
}

/* ── код уровня для обмена ── */

const b64 = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'));
const unb64 = (s) => (typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary'));

/** Клетки сжимаем RLE: «.» × 40 → «40.» — код получается коротким (~100–200 символов). */
const rle = (s) => s.replace(/(.)\1{2,}/g, (m, ch) => m.length + ch);
const unrle = (s) => s.replace(/(\d+)(\D)/g, (m, n, ch) => ch.repeat(Math.min(EW * EH, Number(n))));

export function encode(design) {
  const j = JSON.stringify({ v: 1, n: design.name, c: rle(design.cells), t: design.target, d: design.diff, th: design.theme,
    f: design.friends && design.friends.length ? design.friends.join(',') : undefined, g: GHOSTS[design.ghosts] ? design.ghosts : undefined,
    a: design.author || undefined, an: design.authorName || undefined });
  return b64(unescape(encodeURIComponent(j))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode(code) {
  try {
    const s = String(code || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    if (s.length > 4000) return null;
    const j = JSON.parse(decodeURIComponent(escape(unb64(s))));
    const cells = unrle(String(j.c || ''));
    if (cells.length !== EW * EH || /[^.#oSH]/.test(cells)) return null;
    return { v: 1, name: String(j.n || 'Уровень').slice(0, 24), cells, target: Number(j.t) || 8,
             diff: DIFFS[j.d] ? j.d : 'mid', theme: THEMES[j.th] ? j.th : 'quay',
             // в старых кодах этих полей нет: защитники берутся из темы, привидения — как было
             friends: String(j.f || '').split(',').filter((x) => PICK_FRIENDS.includes(x)), ghosts: GHOSTS[j.g] ? j.g : undefined,
             author: typeof j.a === 'string' ? j.a.slice(0, 16) : undefined, authorName: typeof j.an === 'string' ? j.an.slice(0, 14) : undefined };
  } catch (e) {
    return null;
  }
}

/* ── «Мои уровни» в localStorage ── */

const KEY = 'tg.my.levels';
export const myLevels = {
  list() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } },
  save(design) {
    const all = this.list();
    const code = encode(design);
    const i = all.findIndex((x) => x.id === design.id);
    const item = { id: design.id || `m${Date.now().toString(36)}`, name: design.name, code, at: Date.now() };
    if (i >= 0) all[i] = item; else all.unshift(item);
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, 50)));
    return item;
  },
  remove(id) { localStorage.setItem(KEY, JSON.stringify(this.list().filter((x) => x.id !== id))); },
  get(id) { return this.list().find((x) => x.id === id) || null; },
  /** Сохранить копию чужого уровня как свой. */
  copyOf(d) { return this.save(copyDesign(d)); },
};
