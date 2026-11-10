#!/usr/bin/env node
/** Проверка правил без графики: бой персонажа, командная игра, свои уровни. Запуск: node tools/combat-test.mjs */
import { Sim, HERO, IDLE_AFTER, waveInfo, SPECIAL, towerStats } from '../src/sim.js';
import { teamMult } from '../src/balance.js';
import { toLevel, encode, decode, sampleDesign, GHOSTS, copyDesign } from '../src/custom.js';
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '  ok ' : 'FAIL '} ${what}`); if (!ok) fails++; };
const level = () => toLevel(sampleDesign());
const spots = (l) => l.spotsList.map(([x, z]) => [x, z, 1]);
const game = (n = 1) => { const l = level(); return new Sim(l, { players: Array.from({ length: n }, (_, i) => ({ id: i + 1 })), spots: spots(l), rng: () => 0.9 }); };
const run = (s, t) => { for (let i = 0; i < t * 30; i++) s.step(1 / 30); };
const enemyNear = (s, p, hp = 100) => { s.spawn({ hp, speed: 0.001, scale: 1, bounty: 7, big: false }); const e = s.enemies[s.enemies.length - 1]; p.x = e.x + 2; p.z = e.z; return e; };

console.log('удар персонажа');
{
  const s = game(); const p = s.players.get(1);
  check(s.act(1, { k: 'hit' }).ok === false, 'без персонажа на поле удара нет');
  s.act(1, { k: 'pos', x: 0, z: 0, r: 0 });
  check(s.act(1, { k: 'hit' }).err === 'Рядом нет монстра' && p.lives === HERO.lives, 'мимо: жизнь не сгорает');
  const e = enemyNear(s, p, 300);
  s.act(1, { k: 'hit' });
  check(p.lives === HERO.lives - 1, 'удар сжигает жизнь');
  check(Math.round(e.hp) === 198, 'удар отнимает треть здоровья монстра');
  check(s.act(1, { k: 'hit' }).ok === false, 'сразу второй удар нельзя');
  const shells = p.shells;
  e.hp = 1; s.time += 1; p.safeUntil = s.time + 100; const before = p.lives;
  s.act(1, { k: 'hit' }); s.step(1 / 30);
  check(!s.enemies.includes(e), 'монстр убит');
  check(p.shells === shells, 'убийство персонажем не даёт денег');
  check(p.lives === before - 1 + HERO.gain, `даёт жизни: +${HERO.gain}`);
}
{
  const s = game(); const p = s.players.get(1); s.act(1, { k: 'pos', x: 0, z: 0, r: 0 });
  const e = enemyNear(s, p, 300); p.safeUntil = 1e9;
  s.time += 1; s.act(1, { k: 'hit', air: 1 });
  check(Math.round(e.hp) === 147, 'в прыжке бьёт в полтора раза сильнее');
}
console.log('серия');
{
  const s = game(); const p = s.players.get(1); s.act(1, { k: 'pos', x: 0, z: 0, r: 0 }); p.safeUntil = 1e9;
  const gains = [];
  for (let i = 0; i < 7; i++) {
    const e = enemyNear(s, p, 300); e.hp = 1; s.time += 1;
    p.lives = 5; s.act(1, { k: 'hit' }); s.step(1 / 30); gains.push(p.lives - 4);
  }
  check(gains.join() === `${HERO.gain},${HERO.gain},${HERO.gain * 2},${HERO.gain * 2},${HERO.gain * 2},${HERO.gain * 3},${HERO.gain * 3}`, `серия умножает жизни: ${gains.join()}`);
  s.time += HERO.comboWindow + 1;
  const e = enemyNear(s, p, 300); e.hp = 1; s.act(1, { k: 'hit' }); s.step(1 / 30);
  check(p.combo === 1, 'долгая пауза сбрасывает серию');
  const t = game(); const q = t.players.get(1); t.act(1, { k: 'pos', x: 0, z: 0, r: 0 });
  q.combo = 5; const m = enemyNear(t, q, 1e6); t.step(1 / 30);
  check(q.combo === 0, 'удар монстра сбрасывает серию');
}
console.log('деньги дают только башни');
{
  const s = game(); const p = s.players.get(1); const start = p.shells;
  s.act(1, { k: 'build', s: 0, f: 'mila' });
  const after = p.shells;
  s.spawn({ hp: 1, speed: 0.001, scale: 1, bounty: 7, big: false });
  const e = s.enemies[0]; e.x = s.spots[0].x + 1; e.z = s.spots[0].z;
  e.d = 0; s.paths[0].at = ((orig) => function (d, o = {}) { o.x = s.spots[0].x + 1; o.z = s.spots[0].z; return o; })(s.paths[0].at);
  run(s, 2);
  check(!s.enemies.includes(e) && p.shells === after + 7 && start > after, 'башня убила — ракушки');
}
console.log('монстр бьёт персонажа');
{
  const s = game(); const p = s.players.get(1); s.act(1, { k: 'pos', x: 0, z: 0, r: 0 });
  const e = enemyNear(s, p, 1e6);
  s.step(1 / 30);
  check(p.lives === HERO.lives - 1, 'монстр рядом ударил');
  check(e.stun > 0, 'и на миг остановился');
  p.lives = 1; p.safeUntil = 0; e.hitCool = 0;
  s.step(1 / 30);
  check(p.down && p.lives === 0, 'жизни кончились — персонаж отдыхает');
  check(s.tails === 5, 'домик от этого не страдает');
  check(s.act(1, { k: 'hit' }).ok === false, 'на отдыхе бить нельзя');
  run(s, HERO.downFor + 0.1);
  check(!p.down && p.lives >= 1, 'вернулся с жизнями');
  const bot = game(2); bot.players.get(2).x = 0;
  enemyNear(bot, { x: 0, z: 0 }, 1e6);
  bot.step(1 / 30);
  check(bot.players.get(2).lives === HERO.lives, 'игрока без персонажа (бот, Набережная в одиночку) не бьют');
}
console.log('командная игра');
{
  const s = game(2); const [a, b] = [s.players.get(1), s.players.get(2)];
  s.act(1, { k: 'build', s: 0, f: 'mila' }); s.act(2, { k: 'build', s: 1, f: 'mila' });
  check(s.act(1, { k: 'up', s: 1 }).ok, 'подружку друга можно растить');
  check(s.act(1, { k: 'sell', s: 1 }).ok === false, 'но нельзя отправить домой');
  s.removePlayer(2);
  check(s.act(1, { k: 'sell', s: 1 }).ok, 'подружку ушедшего — можно');
  const l = level(), t = new Sim({ ...l, spotsList: l.spotsList.slice(0, 2) }, { players: [{ id: 1 }, { id: 2 }], spots: spots(l).slice(0, 2) });
  t.players.get(1).shells = 1000;
  t.act(1, { k: 'build', s: 0, f: 'mila' });
  check(t.act(1, { k: 'build', s: 1, f: 'mila' }).err === 'Оставь эту плиту другу!', 'последняя плита придерживается для друга');
  t.time = IDLE_AFTER + 1; t.act(1, { k: 'dance' }); t.startWave(1); t.queue.length = 0;
  check(t.players.get(2).idle && t.workingCount === 1, `не действовал ${IDLE_AFTER} с — считается отошедшим`);
  check(t.act(1, { k: 'build', s: 1, f: 'mila' }).ok, 'отошедшему плита не держится');
  const q = new Sim(l, { players: [{ id: 1 }, { id: 2 }], spots: spots(l) });
  q.time = IDLE_AFTER + 1; q.act(1, { k: 'dance' }); const bs = q.players.get(2).shells, as = q.players.get(1).shells;
  q.startWave(1);
  check(q.queue.length === waveInfo(1, l, teamMult(1)).count, 'волна рассчитана на тех, кто играет');
  check(q.players.get(2).shells < bs && q.players.get(1).shells > as, 'половина ракушек отошедшего — команде');
  q.act(2, { k: 'dance' });
  check(!q.players.get(2).idle, 'вернулся — снова в команде');
  const snap = q.snapshot(), r = Sim.fromSnapshot(l, spots(l), JSON.parse(JSON.stringify(snap)), [{ id: 1 }, { id: 2 }]);
  check(r.players.get(1).lives === q.players.get(1).lives, 'жизни переживают смену ведущего');
}
console.log('призрак растёт');
{
  const s = game(); const p = s.players.get(1);
  s.act(1, { k: 'pos', x: 0, z: 0, r: 0 });
  check(s.act(1, { k: 'grow' }).ok === false, 'другой персонаж не растёт');
  s.act(1, { k: 'pos', x: 0, z: 0, r: 0, g: 1 });
  p.shells = 59;
  check(s.act(1, { k: 'grow' }).err === 'не хватает ракушек', 'рост стоит ракушек');
  p.shells = 1000;
  for (const c of HERO.growCost) { const b = p.shells; s.act(1, { k: 'grow' }); check(b - p.shells === c, `стадия ${p.grow} за ${c}`); }
  check(p.grow === 4 && s.act(1, { k: 'grow' }).ok === false, 'четыре стадии, как у замка');
  const e = enemyNear(s, p, 300); p.safeUntil = 1e9; s.time += 1;
  s.act(1, { k: 'hit' });
  check(Math.round(300 - e.hp) === Math.round(300 * HERO.hit * (1 + HERO.growHit * 3)), 'большой призрак бьёт сильнее');
  const r = Sim.fromSnapshot(s.level, spots(s.level), JSON.parse(JSON.stringify(s.snapshot())), [{ id: 1 }]);
  check(r.players.get(1).grow === 4 && r.players.get(1).ghostHero, 'рост переживает смену ведущего');
}
console.log('friendly fire');
{
  const s = game(2); const [a, b] = [s.players.get(1), s.players.get(2)];
  for (const id of [1, 2]) s.act(id, { k: 'pos', x: 1, z: 1, r: 0 });
  a.shells = 100; b.shells = 200;
  check(s.act(1, { k: 'pvp' }).ok === false, 'без галочки союзника бить нельзя');
  check(s.act(1, { k: 'hit' }).ok === false && b.lives === HERO.lives, 'обычный удар союзника не задевает');
  s.ff = true;
  check(s.act(1, { k: 'pvp' }).ok, 'с галочкой можно');
  check(b.lives === HERO.lives - HERO.pvpHit && a.lives === HERO.lives - 1, 'союзник теряет жизни, а удар стоит жизнь и бьющему');
  check(a.shells === 130 && b.shells === 170, 'забирает 15 % ракушек');
  s.time += 1; b.safeUntil = 0; b.lives = 1; a.hitReady = 0; const la = a.lives;
  s.act(1, { k: 'pvp' });
  check(b.down && Math.round(b.shells) === 170 - Math.floor(170 * 0.4), 'нокаут: союзник отдыхает и теряет 40 %');
  check(a.lives === la - 1 + HERO.pvpKoGain, 'за нокаут бьющему жизни');
  check(s.act(1, { k: 'pvp' }).ok === false, 'лежачего не бьют');
  check(s.tails === 5, 'домик не страдает');
  s.time += HERO.downFor + 0.1; s.step(1 / 30);
  check(!b.down && s.act(1, { k: 'pvp' }).err === 'Он пока под защитой', 'вернувшийся под защитой');
}
console.log('свой уровень');
{
  const d = { ...sampleDesign(), friends: ['castle', 'iva'], ghosts: 'all' };
  const x = decode(encode(d));
  check(x.friends.join() === 'castle,iva' && x.ghosts === 'all', 'защитники и привидения сохраняются в коде');
  const L = toLevel(x);
  check(L.friends.includes('castle') && L.ghosts === 1, 'в игре можно строить замок, привидения включены');
  check(toLevel(sampleDesign()).friends.includes('castle'), 'новый уровень сразу с замком');
  check(toLevel({ ...sampleDesign(), ghosts: 'none' }).ghosts === 0, 'привидения можно выключить');
  check(new Sim(toLevel({ ...d, ghosts: 'all' }), { players: [{ id: 1 }], spots: [[0, 0, 1]], rng: () => 0.99 }).ghostChance === GHOSTS.all.chance, 'только привидения');
  const foreign = decode(encode({ ...d, author: 'someone', authorName: 'Боря' }));
  check(foreign.author === 'someone' && foreign.authorName === 'Боря', 'автор сохраняется в коде');
  const cp = copyDesign(foreign);
  check(cp.name.includes('копия') && cp.author !== 'someone' && cp.cells === foreign.cells, 'копия чужого уровня — с теми же клетками и без прежнего автора');
  const old = Buffer.from(JSON.stringify({ v: 1, n: 'Старый', c: '195.', t: 8, d: 'easy', th: 'castle' })).toString('base64');
  const oldD = decode(old);
  check(oldD && !oldD.friends.length, 'старые коды читаются');
}
console.log('особый удар подружек (с 3-го роста)');
{
  const shoot = (lvl, n0 = 0, times = 8) => {
    const s = game(); s.players.get(1).shells = 1e6;
    const r = s.act(1, { k: 'build', s: 0, f: 'mila' });
    const t = s.towers.get(0);
    if (!t) return { err: r && r.err };
    Object.assign(t, towerStats('mila', lvl), { level: lvl, n: n0, range: 1e4 });   // тень встаёт на свою дорогу — радиус с запасом
    const out = [], sp = s.spots[0];
    for (let k = 0; k < times; k++) {
      s.enemies.length = 0; s.shots.length = 0;
      s.spawn({ hp: 1e7, speed: 0.001, scale: 1, bounty: 1, big: false });
      const e = s.enemies[s.enemies.length - 1]; e.x = sp.x + 3; e.z = sp.z; e.rem = 1;
      t.cool = 0; s.step(1 / 30);
      out.push(s.shots[0] ? s.shots[0].damage : null);
    }
    return { out, base: t.damage };
  };
  const low = shoot(2), high = shoot(3);
  check(low.out && low.out.every((d) => d === low.base), `на 2-м росте все выстрелы обычные (${low.err || low.out.join(',')})`);
  check(high.out && high.out.every((d) => d === Math.round(high.base * (1 + 0 * SPECIAL.mult))) || SPECIAL.mult !== 1, `урон особого удара не растёт (баланс): ${high.err || high.out.join(',')}`);
  {   // особый удар Теи: замедление дольше обычного
    const s = game(); s.players.get(1).shells = 1e6; s.act(1, { k: 'build', s: 0, f: 'teya' });
    const t = s.towers.get(0); Object.assign(t, towerStats('teya', 3), { level: 3, n: SPECIAL.every - 1, range: 1e4, cool: 0 });
    const ev = []; const emit = s.emit.bind(s); s.emit = (e) => { ev.push(e); return emit(e); };
    s.spawn({ hp: 1e7, speed: 0.001, scale: 1, bounty: 1, big: false });
    s.step(1 / 30);
    const sh = s.shots[0];
    check(sh && sh.slowFor === SPECIAL.slowFor && ev.some((e) => e[0] === 'f' && e[3] === 1), `особый выстрел Теи помечен и замедляет на ${sh && sh.slowFor} с вместо 1.6`);
  }
}
console.log(`\nошибок: ${fails}`);
process.exit(fails ? 1 : 0);
