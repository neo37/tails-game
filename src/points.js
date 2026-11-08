/**
 * Баллы ⭐ и ачивки для корабля. Баллы дают задания «Редактора с заданиями» (race-editor.html?quest=1)
 * и минуты, когда в нём что-то строишь. Тратятся в «Мастерской корабля» (ship.html).
 * Всё хранится на телефоне (localStorage), как и остальной прогресс. Ещё +10 ⭐ даёт ролик с наградой (src/ads.js), только в приложении.
 */
import { analyze, BLOCKS, T, xyzOf } from './race-design.js';
import { itemById } from './shop.js';
export { SHOP, SLOTS, itemById, kitString, parseKit } from './shop.js';

const KEY = 'tg.points';
const load = () => { try { return { balance: 0, earned: 0, done: [], owned: [], minutes: {}, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { return { balance: 0, earned: 0, done: [], owned: [], minutes: {} }; } };
const store = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* без памяти */ } };

/** Задания: каждое даёт баллы один раз. check(a, design) — по разбору трассы; без check — выполняется событием. */
export const TASKS = [
  { id: 'ready', icon: '🏁', name: 'Собери готовую трассу: старт, дорога, финиш', pts: 10, check: (a) => a.ok },
  { id: 'km1', icon: '📏', name: 'Трасса длиннее 1 км', pts: 15, check: (a) => a.ok && a.length >= 1000 },
  { id: 'kinds3', icon: '🧱', name: 'Поставь 3 разные преграды', pts: 15, check: (a, d) => new Set([...d.blocks.values()].filter((t) => BLOCKS[t].kind && t !== T.boost)).size >= 3 },
  { id: 'boost2', icon: '⚡', name: 'Поставь 2 ускорителя', pts: 10, check: (a, d) => [...d.blocks.values()].filter((t) => t === T.boost).length >= 2 },
  { id: 'fork', icon: '🔀', name: 'Сделай развилку: два пути до финиша', pts: 20, check: (a) => a.ok && a.routes.length >= 2 },
  { id: 'high', icon: '🗼', name: 'Подними трассу на 5 этажей', pts: 15, check: (a, d) => [...d.blocks.keys()].some((k) => xyzOf(k)[1] >= 5) },
  { id: 'fly', icon: '🚀', name: 'Пролети свою трассу до финиша', pts: 25 },
  { id: 'share', icon: '🌍', name: 'Покажи трассу всем', pts: 20 },
  { id: 'km3', icon: '🛣️', name: 'Трасса длиннее 3 км', pts: 30, check: (a) => a.ok && a.length >= 3000 },
  { id: 'routes4', icon: '🧭', name: 'Четыре разных пути до финиша', pts: 30, check: (a) => a.ok && a.routes.length >= 4 },
];
export const MINUTE_PTS = 1, MINUTES_PER_DAY = 30;
export const AD_PTS = 10, ADS_PER_DAY = 5;          // реклама с наградой (src/ads.js), только в приложении

export const points = {
  state: load,
  balance: () => load().balance,
  isDone: (id) => load().done.includes(id),
  owns: (id) => load().owned.includes(id),
  /** Засчитать задание (один раз). Возвращает баллы или 0. */
  complete(id) {
    const s = load(), t = TASKS.find((x) => x.id === id);
    if (!t || s.done.includes(id)) return 0;
    s.done.push(id); s.balance += t.pts; s.earned += t.pts;
    store(s);
    return t.pts;
  },
  /** Задания, которые выполнены этой трассой и ещё не засчитаны. */
  checkDesign(design) {
    const a = analyze(design), got = [];
    for (const t of TASKS) if (t.check && !this.isDone(t.id) && t.check(a, design)) got.push([t, this.complete(t.id)]);
    return got;
  },
  /** Минута в редакторе с заданиями (если в эту минуту что-то строил): +1, не больше 30 в день. */
  minute() {
    const s = load(), day = new Date().toISOString().slice(0, 10);
    for (const d of Object.keys(s.minutes)) if (d !== day) delete s.minutes[d];
    if ((s.minutes[day] || 0) >= MINUTES_PER_DAY) return 0;
    s.minutes[day] = (s.minutes[day] || 0) + 1; s.balance += MINUTE_PTS; s.earned += MINUTE_PTS;
    store(s);
    return MINUTE_PTS;
  },
  minutesToday: () => load().minutes[new Date().toISOString().slice(0, 10)] || 0,
  adsToday: () => (load().ads || {})[new Date().toISOString().slice(0, 10)] || 0,
  /** Досмотренный ролик: +10 ⭐, не больше 5 в день. */
  adReward() {
    const s = load(), day = new Date().toISOString().slice(0, 10);
    s.ads = { [day]: (s.ads || {})[day] || 0 };
    if (s.ads[day] >= ADS_PER_DAY) return 0;
    s.ads[day]++; s.balance += AD_PTS; s.earned += AD_PTS;
    store(s);
    return AD_PTS;
  },
  /** Купить ачивку: хватает баллов — списываем и она твоя навсегда. */
  buy(id) {
    const s = load(), it = itemById(id);
    if (!it || s.owned.includes(id) || s.balance < it.price) return false;
    s.balance -= it.price; s.owned.push(id);
    store(s);
    return true;
  },
};
