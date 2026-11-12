#!/usr/bin/env node
/**
 * Проверка гонки без графики: трассы проходимы, разгон плавный, занос растёт со скоростью, боты разного уровня расходятся.
 *   node tools/race-test.mjs
 */
import { MAPS } from '../src/levels.js';
import { buildTrack, newRacer, stepRacer, botInput, TUBE_R, BODY_R, hits } from '../src/race-sim.js';

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };
const DT = 1 / 60;

function race(track, skill, lane = 0) {
  const p = newRacer(lane), inp = { x: 0, y: 0, brake: false };
  for (const o of track.obstacles) o.brokenTill = 0;   // разбитые прошлым заездом снова целы
  let t = 0, hit = 0, wall = 0, maxSlip = 0;
  while (!p.fin && t < 300) {
    botInput(p, track, t, skill, inp);
    for (const [e] of stepRacer(p, inp, track, t, DT, skill.vmaxK)) { if (e === 'crash') hit++; if (e === 'wall') wall++; }
    maxSlip = Math.max(maxSlip, p.slip);
    t += DT;
  }
  return { t, hit, wall, maxSlip, fin: p.fin };
}

for (const def of MAPS.race.levels) {
  const tr = buildTrack(def);
  console.log(`\n${def.id}. ${def.name}: длина ${def.length}, преград ${tr.obstacles.filter((o) => o.kind !== 'boost').length}, ускорителей ${tr.obstacles.filter((o) => o.kind === 'boost').length}`);

  // тоннель не задевает сам себя: витки дальше диаметра
  let minGap = Infinity;
  for (let i = 0; i < tr.n; i += 5) for (let j = i + 40; j < tr.n; j += 5) {
    const d = Math.hypot(tr.pos[i * 3] - tr.pos[j * 3], tr.pos[i * 3 + 1] - tr.pos[j * 3 + 1], tr.pos[i * 3 + 2] - tr.pos[j * 3 + 2]);
    if (d < minGap) minGap = d;
  }
  check(minGap > TUBE_R * 2 + 2, `витки не пересекаются (ближе всего ${minGap.toFixed(0)})`);

  // у каждой преграды есть свободное место для персонажа
  let blocked = 0;
  for (const o of tr.obstacles) {
    if (o.kind === 'boost') continue;
    let free = 0;
    for (let x = -TUBE_R; x <= TUBE_R; x += 1) for (let y = -TUBE_R; y <= TUBE_R; y += 1) {
      if (Math.hypot(x, y) <= TUBE_R - BODY_R && !hits(o, x, y, 0)) free++;
    }
    if (free < 12) blocked++;
  }
  check(blocked === 0, `у каждой преграды есть проход (без прохода: ${blocked})`);

  // аккуратный пилот проходит трассу почти без ударов
  const pro = race(tr, { miss: 0, vmaxK: 1, sloppy: 1, seed: 1 });
  check(pro.fin > 0 && pro.hit <= Math.max(2, tr.obstacles.length * 0.08), `аккуратный бот: ${pro.t.toFixed(1)} с, ударов ${pro.hit}, в стену ${pro.wall}, занос до ${(pro.maxSlip * 100).toFixed(0)}% силы руля`);
  check(pro.maxSlip < 1.25, 'даже на ускорителе занос можно перебороть почти всегда');
  const clumsy = race(tr, { miss: 0.45, vmaxK: 0.92, sloppy: 0.3, seed: 2 });
  // с ноября 2026 удар только замедляет (преграда рассыпается), поэтому отставание меньше, чем при отскоке
  check(clumsy.fin > 0 && clumsy.t > pro.t + 2, `неловкий бот тоже финиширует и отстаёт: ${clumsy.t.toFixed(1)} с, ударов ${clumsy.hit}`);

  // разгон плавный: за кадр скорость меняется мало, максимум примерно через 15–30 с
  {
    const p = newRacer(0), inp = { x: 0, y: 0, brake: false };
    const free = { ...tr, obstacles: [] };
    let jump = 0, t90 = 0, t = 0;
    while (t < 60 && !t90) {
      const v0 = p.v;
      stepRacer(p, inp, free, t, DT);
      p.x = p.y = p.vx = p.vy = 0;
      if (p.s > free.total - 100) p.s = 100;
      jump = Math.max(jump, p.v - v0);
      t += DT;
      if (p.v >= def.vmax * 0.9) t90 = t;
    }
    check(jump < def.vmax * 0.01 && t90 > 8 && t90 < 30, `разгон плавный: 90% скорости за ${t90.toFixed(1)} с, за кадр не больше ${(jump / def.vmax * 100).toFixed(2)}%`);
  }

  // чем быстрее, тем сильнее заносит: руль отпущен в одном и том же вираже
  {
    let best = 0;
    for (let i = 0; i < tr.n; i++) if (Math.hypot(tr.bend[i * 2], tr.bend[i * 2 + 1]) > Math.hypot(tr.bend[best * 2], tr.bend[best * 2 + 1])) best = i;
    const free = { ...tr, obstacles: [] };
    const blown = (v) => {
      const p = { ...newRacer(0), s: best * 2 - 20, x: 0, y: 0, v };
      const inp = { x: 0, y: 0, brake: false };
      for (let t = 0; t < 0.4; t += DT) { stepRacer(p, inp, free, t, DT); p.v = v; }
      return Math.hypot(p.x, p.y);
    };
    const [a, b, c] = [0.3, 0.6, 1].map((k) => blown(def.vmax * k));
    check(a < b && b < c && c > a * 4, `занос за 0.4 с без руля на 30/60/100% скорости: ${a.toFixed(1)} / ${b.toFixed(1)} / ${c.toFixed(1)}`);
  }
}
console.log(fails ? `\nошибок: ${fails}` : '\nошибок: 0');
process.exit(fails ? 1 : 0);
