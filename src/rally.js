/**
 * Ралли: 12 трасс подряд без меню между ними. Финишировал — через пару секунд следующая трасса,
 * отсчёт стартует сам. После 12-й — итог (общее время, места) и новый круг ралли с другими трассами.
 * Состояние — sessionStorage 'tg.rally' (живёт, пока открыта вкладка/приложение).
 */
import { MAPS } from './levels.js';

export const RALLY_LEN = 12;
const KEY = 'tg.rally';
// первый круг — от лёгких к трудным, с расширяющимися трубами; дальше — каждый круг свой набор
const FIRST = [1, 11, 12, 15, 4, 13, 17, 20, 23, 19, 27, 30];

function pick(round) {
  if (round === 0) return FIRST;
  const ids = MAPS.race.levels.map((l) => l.id);
  let a = (round * 2654435761) >>> 0;
  const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sh = ids.slice().sort(() => rnd() - 0.5).slice(0, RALLY_LEN);
  const vmax = (id) => MAPS.race.levels.find((l) => l.id === id).vmax;
  return sh.sort((x, y) => vmax(x) - vmax(y));      // внутри круга — от медленных к быстрым
}

export function rallyState(fresh) {
  let st = null;
  if (!fresh) try { st = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { /* */ }
  if (!st || !Array.isArray(st.tracks)) st = { round: 0, step: 0, tracks: pick(0), times: [], places: [] };
  return st;
}
export function rallySave(st) { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* */ } }
export function rallyLevel(st) { return MAPS.race.levels.find((l) => l.id === st.tracks[st.step]) || MAPS.race.levels[0]; }

/** Записать финиш текущей трассы; вернуть адрес следующей (или null — ралли закончено). */
export function rallyFinish(st, time, place) {
  st.times[st.step] = time;
  st.places[st.step] = place;
  rallySave(st);
  return st.step + 1 < st.tracks.length ? 'race.html?rally=1&step=' + (st.step + 1) : null;
}
export function rallyNextRound(st) {
  const round = (st.round || 0) + 1;
  const next = { round, step: 0, tracks: pick(round), times: [], places: [] };
  rallySave(next);
  return 'race.html?rally=1&step=0&cont=1';   // cont — не сбрасывать на первый круг
}
