#!/usr/bin/env node
/**
 * Проверка открытого мира без графики: полёт управляемый, мир у всех одинаковый,
 * влёт в воронку даёт корректное начальное состояние для гонки.
 *   node tools/world-test.mjs
 */
import { FLY, WORLD_R, GATE_R, SHIP_R, SLOTS, SLOT_POS, SPAWN_GAP, WORLD_MAX, layout, gateOf, newPilot, stepPilot, nearest, crossed, len, dot, norm, cross } from '../src/world-sim.js';
import { TUBE_R, BODY_R, START_S } from '../src/race-sim.js';

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };
const DT = 1 / 60;
const NO_GATES = new Map();

function fly(q, input, secs, gates = NO_GATES) {
  const ev = [];
  for (let t = 0; t < secs; t += DT) ev.push(...stepPilot(q, input, gates, DT));
  return ev;
}

/* ── разгон и тормоз ── */
{
  const q = newPilot();
  fly(q, { x: 0, y: 0 }, 1);
  const v1 = q.v;
  fly(q, { x: 0, y: 0 }, 29);
  console.log(`\nразгон: за 1 с ${v1.toFixed(1)}, за 30 с ${q.v.toFixed(1)} из ${FLY.vmax}`);
  check(v1 > 6 && v1 < FLY.vmax * 0.5, 'за первую секунду трогается, но не выходит на максимум');
  check(q.v > FLY.vmax * 0.97, 'за 30 с выходит почти на максимум');
  check(Math.abs(len(q.vel) - q.v) < 0.5, 'вектор скорости совпадает с её величиной на прямой');

  fly(q, { x: 0, y: 0, brake: true }, 2);
  check(q.v < FLY.vmax * 0.5, `тормоз сбрасывает скорость (${q.v.toFixed(1)})`);
  fly(q, { x: 0, y: 0, brake: true }, 10);
  check(q.v >= FLY.vmin - 0.01, `ниже ${FLY.vmin} не падает (${q.v.toFixed(1)})`);
}

/* ── базис остаётся ортонормированным, кверху ногами не переворачивает ── */
{
  const q = newPilot();
  fly(q, { x: 1, y: 0.6 }, 40);
  const e = [Math.abs(len(q.nose) - 1), Math.abs(len(q.up) - 1), Math.abs(len(q.right) - 1),
    Math.abs(dot(q.nose, q.up)), Math.abs(dot(q.nose, q.right)), Math.abs(dot(q.up, q.right))];
  console.log(`\nбазис после 40 с виража: худшая ошибка ${Math.max(...e).toExponential(1)}`);
  check(Math.max(...e) < 1e-6, 'nose/up/right единичные и взаимно перпендикулярные');
  check(dot(q.up, [0, 1, 0]) > 0.3, `«верх» смотрит вверх (${dot(q.up, [0, 1, 0]).toFixed(2)})`);
  check(Math.abs(q.bank) > 0.5, `в вираже корабль положен на крыло (${q.bank.toFixed(2)})`);
}

/* ── руль действительно поворачивает, и на вираже проносит ── */
{
  const q = newPilot();
  fly(q, { x: 0, y: 0 }, 20);
  const n0 = [...q.nose];
  fly(q, { x: 1, y: 0 }, 1);
  const turned = Math.acos(Math.max(-1, Math.min(1, dot(n0, q.nose))));
  console.log(`\nза 1 с полного руля нос повернулся на ${(turned * 57.3).toFixed(0)}°`);
  check(turned > 0.5 && turned < FLY.turn * 1.2, 'поворот близок к FLY.turn, не мгновенный');
  const slip = Math.acos(Math.max(-1, Math.min(1, dot(norm(q.vel), q.nose))));
  check(slip > 0.05, `скорость отстаёт от носа — проносит (${(slip * 57.3).toFixed(0)}°)`);
}

/* ── край мира ── */
{
  const q = newPilot([0, 0, WORLD_R - 300]);
  const ev = fly(q, { x: 0, y: 0 }, 30);
  console.log(`\nкрай мира: |p| = ${len(q.p).toFixed(0)} при радиусе ${WORLD_R}`);
  check(len(q.p) <= WORLD_R + 0.5, 'за шар мира не вылетает');
  check(ev.some(([e]) => e === 'edge'), 'о край сообщает событием');
}

/* ── расстановка трасс ── */
{
  const ids = Array.from({ length: 300 }, (_, i) => `r2Track${i}`);
  const a = layout(ids), b = layout(ids);
  console.log(`\nрасстановка: слотов ${SLOTS}, в мире не больше ${WORLD_MAX} чужих трасс, встало ${a.size}`);
  check(SLOTS > WORLD_MAX * 3, 'слотов втрое больше, чем трасс в мире — цепочки занятых слотов короткие');
  check(a.size === WORLD_MAX, 'в мир попадают самые свежие трассы каталога');
  const moved2 = (one) => {
    const n = layout([one, ...ids]);
    let m = 0;
    for (const [id, g] of a) { const h = n.get(id); if (h && len([g.pos[0] - h.pos[0], g.pos[1] - h.pos[1], g.pos[2] - h.pos[2]]) > 1e-9) m++; }
    return m;
  };
  let same = true;
  for (const [id, g] of a) { const h = b.get(id); if (!h || len([g.pos[0] - h.pos[0], g.pos[1] - h.pos[1], g.pos[2] - h.pos[2]]) > 1e-9) same = false; }
  check(same, 'один каталог — один мир');
  // место трассы берётся из хеша её кода, а не из номера в каталоге: новая почти никого не сдвигает
  const shifts = Array.from({ length: 40 }, (_, k) => moved2(`r2New${k}`));
  const worst = Math.max(...shifts), avg = shifts.reduce((s, x) => s + x, 0) / shifts.length;
  console.log(`новая трасса сдвигает старых: худший случай ${worst}, в среднем ${avg.toFixed(2)}`);
  check(worst <= 2, 'новая трасса сдвигает не больше двух уже стоящих');

  let minGap = Infinity;
  const list = [...a.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const d = len([list[i].pos[0] - list[j].pos[0], list[i].pos[1] - list[j].pos[1], list[i].pos[2] - list[j].pos[2]]);
    if (d < minGap) minGap = d;
  }
  console.log(`ближайшие трассы в ${minGap.toFixed(0)} ед. — это ${(minGap / FLY.vmax).toFixed(0)} с полёта`);
  check(minGap > GATE_R * 4, 'трассы не налезают друг на друга');
  check(minGap / FLY.vmax < 20, 'до соседней трассы лететь меньше 20 с');
  check(list.every((g) => len(g.pos) < WORLD_R - 300), 'все воронки внутри мира');
  check(list.every((g) => len(g.pos) >= SPAWN_GAP), 'у самого спавна трасс нет');
  check(list.every((g) => Math.abs(len(g.nose) - 1) < 1e-9 && Math.abs(dot(g.nose, g.right)) < 1e-9 && Math.abs(dot(g.nose, g.up)) < 1e-9), 'базис воронки ортонормирован');
  check(SLOT_POS.length === SLOTS && len(SLOT_POS[0]) <= len(SLOT_POS[SLOTS - 1]), 'слоты отсортированы от спавна');

  // свои трассы — у спавна, чтобы ребёнок сразу нашёл своё
  const mineFirst = layout(ids, ['r2Track7', 'r2Track42']);
  const dMine = ['r2Track7', 'r2Track42'].map((id) => len(mineFirst.get(id).pos));
  const dOther = [...mineFirst].filter(([id]) => !['r2Track7', 'r2Track42'].includes(id)).map(([, g]) => len(g.pos));
  console.log(`свои трассы в ${dMine.map((d) => d.toFixed(0)).join(' и ')} ед. от спавна, ближайшая чужая в ${Math.min(...dOther).toFixed(0)}`);
  check(Math.max(...dMine) <= Math.min(...dOther), 'свои трассы ближе всех чужих');
  check(mineFirst.size === a.size + 2, 'свои трассы добавляются к миру, а не вытесняют чужие');
}

/* ── влёт в воронку ── */
{
  const g = gateOf([0, 0, 600], [0, 0, 1]);
  const gates = new Map([['one', g]]);

  // летим прямо в середину
  const q = newPilot([0, 0, 0], [0, 0, 1]);
  const ev = fly(q, { x: 0, y: 0 }, 30, gates);
  const enter = ev.find(([e]) => e === 'enter');
  check(!!enter, 'влетел в воронку, когда летел прямо на неё');
  if (enter) {
    const st = enter[2];
    console.log(`\nвлёт: x = ${st.x.toFixed(2)}, y = ${st.y.toFixed(2)}, v = ${st.v.toFixed(1)}`);
    check(Math.hypot(st.x, st.y) < TUBE_R - BODY_R, `точка входа помещается в трубу (${Math.hypot(st.x, st.y).toFixed(2)} < ${(TUBE_R - BODY_R).toFixed(2)})`);
    check(st.v > FLY.vmax * 0.5, 'скорость влёта посчитана (в гонку она пока не переносится: там свой отсчёт)');
    check(st.id === 'one', 'событие называет трассу');
  }

  // мимо: летим в стороне от горловины
  const past = newPilot([GATE_R * 3, 0, 0], [0, 0, 1]);
  check(!fly(past, { x: 0, y: 0 }, 20, gates).some(([e]) => e === 'enter'), 'мимо воронки не засчитывается');

  // с обратной стороны: вылетать через старт нельзя
  const back = newPilot([0, 0, 1200], [0, 0, -1]);
  check(!fly(back, { x: 0, y: 0 }, 20, gates).some(([e]) => e === 'enter'), 'сзади в старт не влетишь');

  // крупный шаг времени: на 20 fps и полной скорости воронку не проскакиваем
  const fast = newPilot([0, 0, 0], [0, 0, 1]);
  fast.v = FLY.vmax; fast.vel = [0, 0, FLY.vmax];
  let got = false;
  for (let t = 0; t < 30 && !got; t += 1 / 20) got = stepPilot(fast, { x: 0, y: 0 }, gates, 1 / 20).some(([e]) => e === 'enter');
  check(got, 'на 20 кадрах в секунду воронка не проскакивается');

  // граница круга: по касательной к краю — не влёт
  const edge = newPilot([GATE_R - SHIP_R * 0.5, 0, 0], [0, 0, 1]);
  check(!fly(edge, { x: 0, y: 0 }, 20, gates).some(([e]) => e === 'enter'), 'по самому краю горловины не влетает');
}

/* ── ближайшая воронка для подсказки ── */
{
  const gates = layout(['r2A', 'r2B', 'r2C', 'r2D']);
  const q = newPilot([0, 0, 0], [0, 0, 1]);
  const n = nearest(q, gates);
  check(!!n && n.dist > 0, `ближайшая трасса найдена (${n.id}, ${n.dist.toFixed(0)} ед.)`);
  const far = [...gates.values()].map((g) => len([g.pos[0] - q.p[0], g.pos[1] - q.p[1], g.pos[2] - q.p[2]]));
  check(Math.abs(n.dist - Math.min(...far)) < 1e-9, 'она действительно ближайшая');
}

/* ── влёт переносится в гонку: START_S даёт запас до первой преграды ── */
check(START_S > 0, `в гонке старт в ${START_S} ед. от начала трубы — есть куда влетать`);

console.log(fails ? `\n${fails} проверок не прошло` : '\nвсё в порядке');
process.exit(fails ? 1 : 0);
