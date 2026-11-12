#!/usr/bin/env node
/** Трассы из блоков без графики: код, развилки и слияния, змейка, примеры, боты не пролетают сквозь преграды. node tools/race-design-test.mjs */
import { EXAMPLES, analyze, autoComplete, autoFork, buildCourse, decode, encode, keyOf, trackName, T, DIFFS, CELL } from '../src/race-design.js';
import { newRacer, stepRacer, botInput, hits, routeOf, fire, stepShot, shotHits, zap, botAims, mudBomb, TUBE_R, BODY_R } from '../src/race-sim.js';

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };
const DT = 1 / 60;
const line = (blocks, from, d, n, t = T.path) => { let c = from; for (let i = 0; i < n; i++) { c = [c[0] + d[0], c[1] + d[1], c[2] + d[2]]; blocks.set(keyOf(...c), t); } return c; };

/* код */
for (const d of EXAMPLES) {
  const back = decode(encode(d));
  check(back && encode(back) === encode(d) && back.d === d.d && trackName(back) === trackName(d), `код туда и обратно: ${trackName(d)} (${encode(d).length} знаков)`);
}
{
  const big = new Map([[keyOf(50, 20, 60), T.start]]); line(big, [50, 20, 60], [-1, 0, 0], 40);
  const c = encode({ a: 1, b: 2, d: 'hard', blocks: big }), back = decode(c);
  check(c.startsWith('r2') && back && back.blocks.size === big.size && back.blocks.get(keyOf(50, 20, 60)) === T.start && encode(back) === c, `большое поле 64×24×64: код r2 туда и обратно (${c.length} знаков)`);
  check(encode(EXAMPLES[0]).startsWith('r1'), 'трасса из старого поля пишется по-старому (r1): её читает версия 1.7');
}
check(decode('r1AAA' + '!!!') === null && decode('zzz') === null && decode('r1AAAA') === null && decode('') === null, 'испорченный код не принимается');

/* змейка из соседних рядов не срезается */
{
  const b = new Map(); b.set(keyOf(1, 0, 1), T.start);
  let c = line(b, [1, 0, 1], [1, 0, 0], 8); c = line(b, c, [0, 0, 1], 1); c = line(b, c, [-1, 0, 0], 8);
  c = line(b, c, [0, 0, 1], 1); c = line(b, c, [1, 0, 0], 7); b.set(keyOf(...c), T.finish);
  const a = analyze({ blocks: b });
  check(a.ok && a.routes.length === 1 && a.routes[0].chain.length === b.size, `змейка пройдена целиком: ${a.routes[0]?.chain.length} из ${b.size}`);
}
/* развилка и слияние, тупик */
{
  const b = new Map(); b.set(keyOf(1, 0, 5), T.start);
  let c = line(b, [1, 0, 5], [1, 0, 0], 4); b.set(keyOf(...c), T.fork); const f = c;
  let u = line(b, f, [0, 0, 1], 3); u = line(b, u, [1, 0, 0], 6); u = line(b, u, [0, 0, -1], 2);
  let l = line(b, f, [1, 0, 0], 6); b.set(keyOf(...l), T.fork);
  b.set(keyOf(l[0], 0, l[2] + 1), T.path); // u приходит сюда: (11,0,6)
  let e = line(b, l, [1, 0, 0], 4); b.set(keyOf(...e), T.finish);
  line(b, [3, 0, 5], [0, 0, -1], 3);        // тупик
  const a = analyze({ blocks: b });
  check(a.ok && a.routes.length === 2, `развилка даёт два пути: ${a.routes.length} (${a.errors})`);
  check(!a.used.has(keyOf(3, 0, 2)), 'тупик в трассу не входит');
  const noF = new Map(b); noF.delete(keyOf(...e));
  check(!analyze({ blocks: noF }).ok, 'без финиша трасса не готова');
  const cut = new Map(b); cut.delete(keyOf(13, 0, 5));
  check(/не доходит/.test(analyze({ blocks: cut }).errors[0]), 'разрыв перед финишем показывается');
  const short = new Map(); short.set(keyOf(0, 0, 0), T.start); short.set(keyOf(1, 0, 0), T.finish);
  check(/короткая/.test(analyze({ blocks: short }).errors[0]), 'слишком короткая показывается');
}

/* примеры: проходимы, боты не пролетают преграды, ветки совпадают в общей части */
for (const d of EXAMPLES) {
  const a = analyze(d), course = buildCourse(d);
  check(a.ok && a.used.size === d.blocks.size, `${trackName(d)}: ${d.blocks.size} блоков, все в трассе, путей ${a.routes.length} (${a.errors})`);
  if (!course) continue;
  for (const tr of course.routes) if (!tr.pos.every(Number.isFinite) || !tr.up.every(Number.isFinite)) check(false, 'ось без NaN');
  // преграды одной ветки совпадают с другой в мировых координатах
  let worst = 0;
  const seen = new Map();
  for (const tr of course.routes) for (const o of tr.obstacles) {
    if (o.x === undefined) continue;
    const i = Math.floor(o.s / 2) * 3, p = [0, 1, 2].map((c) => tr.pos[i + c] + tr.right[i + c] * o.x + tr.up[i + c] * o.y);
    const was = seen.get(o.key);
    if (was) worst = Math.max(worst, Math.hypot(p[0] - was[0], p[1] - was[1], p[2] - was[2])); else seen.set(o.key, p);
  }
  check(worst < 3, `преграда на всех путях в одном месте (расхождение ${worst.toFixed(1)})`);
  const taken = new Set();
  const skills = DIFFS[d.d].bots.map(([miss, vmaxK, sloppy], i) => ({ miss, vmaxK, sloppy, seed: i + 3 }));
  skills.push({ miss: 0, vmaxK: 1, sloppy: 1, seed: 1 }, { miss: 0.6, vmaxK: 0.8, sloppy: 0.2, seed: 4 }, { miss: 0.3, vmaxK: 0.9, sloppy: 0.5, seed: 8 });
  for (const sk of skills) {
    const p = newRacer(sk.seed & 3), inp = { x: 0, y: 0, brake: false };
    for (const rt of course.routes) for (const o of rt.obstacles) o.brokenTill = 0;   // разбитые прошлым ботом снова целы
    let t = 0, through = 0, hit = 0;
    while (!p.fin && t < 600) {
      botInput(p, course, t, sk, inp);
      const was = p.next, wasTr = routeOf(course, p);
      const ghost = (p.ghost || 0) > 0;
      for (const [e] of stepRacer(p, inp, course, t, DT, sk.vmaxK)) if (e === 'crash') hit++;
      const tr = routeOf(course, p);
      // с ноября 2026 удар разбивает преграду и делает корабль призраком: сквозь неё можно. Нельзя — сквозь целую без удара.
      for (let i = was; i < p.next; i++) {
        const o = tr.obstacles[i];
        if (o.kind === 'boost' || ghost || (p.ghost || 0) > 0 || (o.brokenTill || 0) > t) continue;
        if (hits(o, p.x, p.y, t)) through++;
      }
      if (wasTr !== tr && p.s > tr.length) through++;
      t += DT;
    }
    taken.add(p.route || 0);
    check(p.fin > 0 && through === 0, `бот (ошибается ${sk.miss}): ${p.fin ? p.fin.toFixed(1) + ' с' : 'НЕ ДОЛЕТЕЛ'}, ударов ${hit}, сквозь преграды ${through}, путь ${p.route || 0}`);
  }
  if (course.routes.length > 1) check(taken.size > 1, `боты разъехались по разным веткам: ${[...taken].join(', ')}`);
}

/* игрок выбирает ветку рулём */
{
  const course = buildCourse(EXAMPLES[1]);
  const pos = (route) => course.routes[route].forks[0];
  const f = pos(0);
  const results = f.opts.map((q) => {
    const p = { ...newRacer(0), s: f.s - 1, x: 0, y: 0, v: 40, next: 0 };
    stepRacer(p, { x: Math.sign(q.dx) * (Math.abs(q.dx) > 1 ? 1 : 0), y: Math.sign(q.dy) * (Math.abs(q.dy) > 1 ? 1 : 0), brake: false }, course, 0, DT);
    return [p.route || 0, q.route];
  });
  const lateral = f.opts.filter((q) => Math.hypot(q.dx, q.dy) > 1);
  check(lateral.length > 0 && results.filter(([got, want]) => got === want).length >= lateral.length, `руль выбирает ветку: ${JSON.stringify(results)}`);
}
/* «Достроить» */
{
  const fill = (b) => { const ops = autoComplete({ blocks: b }); if (!ops) return [null, null]; const c = new Map(b); for (const [k, t] of ops) c.set(k, t); return [ops, analyze({ blocks: c })]; };
  // только старт и пара блоков: достраивает до финиша
  const b1 = new Map(); b1.set(keyOf(5, 0, 5), T.start); line(b1, [5, 0, 5], [1, 0, 0], 2);
  const [o1, a1] = fill(b1);
  check(o1 && a1.ok && o1[o1.length - 1][1] === T.finish, `без финиша: дорога продолжена и поставлен финиш (${o1?.length} блоков, ${a1?.errors})`);
  // у края поля поворачивает
  const b2 = new Map(); b2.set(keyOf(29, 0, 3), T.start); line(b2, [29, 0, 3], [1, 0, 0], 2);
  const [o2, a2] = fill(b2);
  check(o2 && a2.ok, `у края поля поворачивает (${a2?.errors})`);
  // разрыв: дорога и финиш есть, между ними дыра
  const b3 = new Map(); b3.set(keyOf(2, 0, 2), T.start); let c = line(b3, [2, 0, 2], [1, 0, 0], 6);
  let e = line(b3, [12, 0, 6], [1, 0, 0], 4); b3.set(keyOf(...e), T.finish);
  const [o3, a3] = fill(b3);
  check(o3 && a3.ok, `разрыв соединён: ${o3?.length} блоков, путь ${a3?.routes[0]?.chain.length}`);
  // с развилкой: два пути, трасса готова, боты долетают
  {
    const b5 = new Map(); b5.set(keyOf(8, 0, 4), T.start); line(b5, [8, 0, 4], [0, 0, 1], 3);
    const ops = autoFork({ blocks: b5 }), c = new Map(b5); for (const [k, t] of ops || []) c.set(k, t);
    const a5 = analyze({ blocks: c });
    check(ops && a5.ok && a5.routes.length === 2 && a5.used.size === c.size, `«Достроить с развилкой»: ${ops?.length} блоков, путей ${a5.routes.length}`);
    const course = buildCourse({ a: 0, b: 0, d: 'easy', blocks: c });
    const p = newRacer(0), inp = { x: 0, y: 0, brake: false };
    for (let t = 0; t < 120 && !p.fin; t += DT) { botInput(p, course, t, { miss: 0, vmaxK: 1, sloppy: 1, seed: 1 }, inp); stepRacer(p, inp, course, t, DT); }
    check(p.fin > 0, `по достроенной с развилкой трассе бот долетает (${p.fin.toFixed(1)} с)`);
    check(autoFork(EXAMPLES[0]) === null, 'если финиш уже есть — кнопки «с развилкой» нет');
  }
  // готовая трасса — кнопки нет
  check(autoComplete(EXAMPLES[0]) === null, 'у готовой трассы «Достроить» нет');
}

/* выстрелы */
{
  const course = buildCourse(EXAMPLES[0]), tr = course.routes[0];
  const a = { ...newRacer(0), s: 100, x: 0, y: 0, v: 50, next: 0 }, b = { ...newRacer(1), s: 140, x: 0.5, y: 0, v: 50, next: 0 };
  while (a.next < tr.obstacles.length && tr.obstacles[a.next].s < a.s) a.next++;
  b.next = a.next;
  const free = { ...course, routes: [{ ...tr, obstacles: [] }] };
  const sh = fire(a, 'a');
  check(sh && fire(a, 'a') === null, 'выстрел есть, второй сразу нельзя: оружие остывает');
  let hit = false;
  for (let t = 0; t < 2 && !sh.dead && !hit; t += 1 / 60) { stepShot(sh, free, t, 1 / 60); stepRacer(b, { x: 0, y: 0, brake: false }, free, t, 1 / 60); if (shotHits(sh, b, free)) hit = true; }
  const v0 = b.v; zap(b);
  check(hit && b.v < v0 * 0.7, `заряд догоняет того, кто впереди на линии, попадание замедляет (${v0.toFixed(0)} → ${b.v.toFixed(0)})`);
  const c2 = { ...newRacer(1), s: 140, x: 7, y: 0, v: 50, next: b.next };
  const sh2 = fire({ ...a, gun: 0 }, 'a');
  let miss = true;
  for (let t = 0; t < 2 && !sh2.dead; t += 1 / 60) { stepShot(sh2, free, t, 1 / 60); if (shotHits(sh2, c2, free)) miss = false; }
  check(miss, 'мимо того, кто в стороне');
  // преграда гасит заряд
  const o = tr.obstacles.find((q) => q.kind === 'half');
  const sh3 = { route: 0, s: o.s - 10, x: Math.cos(o.a) * 6, y: Math.sin(o.a) * 6, v: 150, t: 0, dead: null };
  for (let t = 0; t < 1 && !sh3.dead; t += 1 / 60) stepShot(sh3, course, t, 1 / 60);
  check(sh3.dead === 'wall', 'стена останавливает заряд');
  // грязь: скорость падает и 2,5 с не поднимается выше половины, потом разгон как обычно
  {
    const p = { ...newRacer(0), s: 100, v: 80, next: 99 }, fr = { ...course, routes: [{ ...tr, obstacles: [] }] }, vm = tr.def.vmax;
    mudBomb(p);
    let maxIn = 0;
    for (let t = 0; t < 2.4; t += 1 / 60) { stepRacer(p, { x: 0, y: 0, brake: false }, fr, t, 1 / 60); maxIn = Math.max(maxIn, p.v); p.x = p.y = 0; }
    for (let t = 0; t < 8; t += 1 / 60) { stepRacer(p, { x: 0, y: 0, brake: false }, fr, t, 1 / 60); p.x = p.y = 0; }
    check(maxIn <= 80 * 0.6 + 0.5 && p.v > vm * 0.6, `грязевая бомба: в грязи не быстрее ${maxIn.toFixed(0)}, потом разгон до ${p.v.toFixed(0)}`);
  }
  check(botAims({ s: 100, x: 0, y: 0 }, [{ s: 160, x: 1, y: 0 }]) && !botAims({ s: 100, x: 0, y: 0 }, [{ s: 160, x: 6, y: 0 }]), 'бот целится только в того, кто на линии впереди');
}
/* вентиляторы: попутный разгоняет выше максимума, встречный тормозит; бот пролетает трассу с ветром; код читается */
{
  const mk = (t) => { const b = new Map(); b.set(keyOf(1, 0, 1), T.start); let c = line(b, [1, 0, 1], [1, 0, 0], 3); c = line(b, c, [1, 0, 0], 1, t); c = line(b, c, [1, 0, 0], 12); b.set(keyOf(c[0] + 1, 0, 1), T.finish); return { a: 3, b: 4, d: 'easy', blocks: b }; };
  const fly = (t, at) => {
    const course = buildCourse(mk(t)), p = newRacer(0), inp = { x: 0, y: 0, brake: false };
    let tt = 0, vmax = 0, vmin = 1e9, wind = 0;
    const fanS = at ?? course.routes[0].obstacles.find((o) => o.kind === 'fan' || o.kind === 'fanb')?.s ?? -1;
    while (!p.fin && tt < 120) {
      tt += DT;
      for (const [e, w] of stepRacer(p, inp, course, tt, DT)) if (e === 'wind') wind = w;
      if (fanS > 0 && p.s > fanS && p.s < fanS + 60) { vmax = Math.max(vmax, p.v); vmin = Math.min(vmin, p.v); }
    }
    return { fin: p.fin, vmax, vmin, wind, top: course.routes[0].def.vmax, fanS };
  };
  const tail = fly(T.fan), head = fly(T.fanb), plain = fly(T.path, tail.fanS);
  check(tail.wind === 1 && tail.vmax > tail.top * 1.05, `попутный ветер: ${tail.vmax.toFixed(0)} при максимуме ${tail.top}`);
  check(head.wind === -1 && head.vmin < plain.vmin * 0.8, `встречный ветер: падение до ${head.vmin.toFixed(0)} (без ветра ${plain.vmin.toFixed(0)})`);
  check(tail.fin && head.fin && tail.fin < plain.fin && head.fin > plain.fin, `время: попутный ${tail.fin.toFixed(1)} < без ветра ${plain.fin.toFixed(1)} < встречный ${head.fin.toFixed(1)}`);
  const d = mk(T.fanb), back = decode(encode(d));
  check(back && back.blocks.get(keyOf(5, 0, 1)) === T.fanb, 'вентилятор сохраняется в коде трассы');
  const course = buildCourse(mk(T.fan)), bp = newRacer(1), bi = { x: 0, y: 0, brake: false };
  let bt = 0; while (!bp.fin && bt < 150) { bt += DT; botInput(bp, course, bt, { miss: 0.3, vmaxK: 0.85, sloppy: 0.5, seed: 3 }, bi); stepRacer(bp, bi, course, bt, DT, 0.85); }
  check(bp.fin > 0, `бот долетает через вентилятор: ${bp.fin.toFixed(1)} с`);
}
console.log(fails ? `\nошибок: ${fails}` : '\nошибок: 0');
process.exit(fails ? 1 : 0);
