#!/usr/bin/env node
/**
 * Проверка командной игры в headless Chromium (4 отдельных профиля = 4 игрока):
 *   создать игру → войти по коду → войти из списка → старт → постройки разными игроками →
 *   персонажи бегают → волна → синхронизация → опоздавший → уход хоста → игра продолжается.
 * Сервер должен быть запущен: npm start (по умолчанию http://127.0.0.1:8795).
 *   node tools/e2e.mjs [--base URL] [--map castle --level 1] [--custom КОД] [--shots ~/tails-shots]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('--base', 'http://127.0.0.1:8795');
const MAP = opt('--map', 'castle'), LEVEL = opt('--level', '1'), CUSTOM = opt('--custom', '');
const SHOTS = opt('--shots', path.join(os.homedir(), 'tails-shots'));
const TAG = opt('--tag', CUSTOM ? 'custom' : `${MAP}${LEVEL}`);
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/snap/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1100,700'],
  protocolTimeout: 120000,
});
const errors = [];
async function player(name, color, emoji) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: pageerror ${e.message}`));
  await page.goto(`${BASE}/index.html`);
  await page.evaluate((n, c, e) => localStorage.setItem('tg.me', JSON.stringify({ name: n, color: c, emoji: e })), name, color, emoji);
  return { name, page, ctx };
}
const shot = (p, n) => p.page.screenshot({ path: path.join(SHOTS, `e2e-${TAG}-${n}.png`) });
const td = (p, fn, ...a) => p.page.evaluate(fn, ...a);
async function waitFor(p, fn, ms = 30000, ...a) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await p.page.evaluate(fn, ...a)) return true; } catch (e) { /* страница ещё грузится */ }
    await sleep(250);
  }
  return false;
}

const A = await player('Аня', '#ff6f91', '🦊');
const B = await player('Боря', '#8fd0ff', '🐬');
const C = await player('Ваня', '#9be37a', '🐢');
const D = await player('Галя', '#c7b0ff', '🦄');

/* ── лобби: создать, по коду, из списка ── */
const lobbyUrl = CUSTOM ? `${BASE}/lobby.html?debug&map=custom&code=${CUSTOM}` : `${BASE}/lobby.html?debug&map=${MAP}&level=${LEVEL}`;
await A.page.goto(lobbyUrl);
await waitFor(A, () => !document.getElementById('games').textContent.includes('Подключаемся'));
await A.page.click('#btn-create');
await waitFor(A, () => /^[A-Z0-9]{4}$/.test(document.getElementById('room-code').textContent));
const code = await A.page.$eval('#room-code', (e) => e.textContent);
check(/^[A-Z0-9]{4}$/.test(code) && !/[01OI]/.test(code), `хост создал игру, код ${code} (без 0/O/1/I)`);
await shot(A, '01-host-room');

await B.page.goto(`${BASE}/lobby.html?debug`);
await waitFor(B, () => !document.getElementById('games').textContent.includes('Подключаемся'));
await B.page.type('#join-code', code.toLowerCase());
await B.page.click('#btn-join');
check(await waitFor(B, () => !document.getElementById('room-panel').hidden), 'Боря вошёл по коду (в нижнем регистре)');

await C.page.goto(`${BASE}/lobby.html?debug`);
check(await waitFor(C, (c) => !!document.querySelector(`[data-join="${c}"]`), 10000, code), 'игра видна в списке открытых');
const listText = await C.page.$eval('#games', (e) => e.innerText);
console.log('   список:', listText.replace(/\s+/g, ' ').trim());
await shot(C, '02-list');
await C.page.click(`[data-join="${code}"]`);
check(await waitFor(C, () => document.querySelectorAll('#room-players .p').length === 3), 'Ваня вошёл из списка, в комнате трое');
await shot(A, '03-room-3');

/* ── старт ── */
await A.page.click('#btn-start');
for (const p of [A, B, C]) {
  check(await waitFor(p, () => location.pathname.endsWith('play.html'), 15000), `${p.name}: перешёл в игру`);
}
for (const p of [A, B, C]) check(await waitFor(p, () => window.__td && document.getElementById('loading').classList.contains('done'), 150000), `${p.name}: сцена загрузилась`);
const hostFlags = await Promise.all([A, B, C].map((p) => td(p, () => window.__td.isHost)));
check(hostFlags.filter(Boolean).length === 1, `ведущий ровно один (${hostFlags})`);
const hostIdx = hostFlags.indexOf(true);
const H = [A, B, C][hostIdx];
const others = [A, B, C].filter((_, i) => i !== hostIdx);

/* ── постройки разными игроками ── */
await sleep(1500);
const spotsN = await td(H, () => window.__td.SPOTS.length);
// свободные плиты по близости к дороге (в лабиринте — к текущему маршруту теней)
const freeSpots = await td(H, () => {
  const t = window.__td, sim = t.sim;
  const pts = sim.maze ? sim.mz.routes.flat().map((k) => sim.mz.grid.center(k)) : sim.paths.flatMap((p) => p.p.map((q) => [q.x, q.z]));
  const dist = (i) => Math.min(...pts.map(([x, z]) => Math.hypot(x - t.SPOTS[i].x, z - t.SPOTS[i].z)));
  const free = t.spotMeshes.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
  // в лабиринте не ставим прямо на маршрут (чтобы не упереться в «нельзя перекрывать»)
  return free.map((i) => [i, dist(i)]).filter(([, d]) => !sim.maze || d > 3).sort((x, y) => x[1] - y[1]).map(([i]) => i);
});
const friend = await td(H, () => window.__td.level.friends[0]);
const plan = [[A, freeSpots[0]], [C, freeSpots[2]]];   // Боря строит честным кликом мышью (ниже)
for (const [p, s] of plan) await td(p, (s, f) => window.__td.doAct({ k: 'build', s, f }), s, friend);
// ещё одну — честным кликом мышью по плите: общий вид, свободная плита ближе всего к центру экрана
await td(B, () => { document.getElementById('btn-cam').click(); });
await sleep(800);
const [clickSpot, sxy2] = await td(B, (busy) => {
  const t = window.__td, r = document.getElementById('scene').getBoundingClientRect();
  let best = null;
  t.spotMeshes.forEach((m, i) => {
    if (!m || busy.includes(i) || t.view.towers.has(i)) return;
    if (busy.some((b) => t.SPOTS[b].distanceTo(t.SPOTS[i]) < 9)) return;     // замки большие — не рядом с ними
    const v = t.SPOTS[i].clone().setY(0.4).project(t.camera);
    const xy = [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    const d = Math.hypot(xy[0] - r.width / 2, xy[1] - r.height * 0.55);
    if (!best || d < best[2]) best = [i, xy, d];
  });
  return best;
}, freeSpots.slice(0, 3));
freeSpots.splice(freeSpots.indexOf(clickSpot), 1);
freeSpots.splice(3, 0, clickSpot);
await B.page.mouse.click(sxy2[0], sxy2[1]);
await sleep(300);
const menuShown = await td(B, () => document.getElementById('build').classList.contains('show') && !!document.querySelector('#build button[data-friend]'));
check(menuShown, `клик мышью по пустой плите открыл меню подружек (${await td(B, () => document.getElementById('build').innerText.replace(/\s+/g, ' '))})`);
await shot(B, '04-build-menu');
if (menuShown) await B.page.click('#build button[data-friend]:not([disabled])').catch(() => {});
await sleep(1200);
const towersBy = await Promise.all([A, B, C].map((p) => td(p, () => [...window.__td.view.towers.entries()].map(([s, t]) => `${s}:${t.owner}`).sort().join(','))));
console.log('   подружки (плита:владелец):', towersBy);
check(towersBy.every((t) => t === towersBy[0]) && towersBy[0].split(',').length >= 3, 'у всех одинаковые подружки (одна поставлена кликом мышью)');
const owners = new Set(towersBy[0].split(',').map((x) => x.split(':')[1]));
check(owners.size === 3, `подружки принадлежат трём разным игрокам (${[...owners]})`);
// дальше каждый тратит свои ракушки, как ребёнок: ещё подружки у дороги
let next = 5;
for (const p of [A, B, C]) for (let k = 0; k < 2; k++) await td(p, (s, f) => window.__td.doAct({ k: 'build', s, f }), freeSpots[next++], friend);
await sleep(800);
// попытка построить на занятой плите — хост отказывает
await td(C, (s, f) => window.__td.doAct({ k: 'build', s, f }), freeSpots[0], friend);
check(await waitFor(C, () => /занята/.test(document.getElementById('toast').textContent), 3000), 'хост отклонил постройку на занятой плите (подсказка у игрока)');

/* ── персонажи бегают ── */
const runnersOn = await td(B, () => !!window.__td.runner);
if (runnersOn) {
  const before = await td(H, (id) => { const p = window.__td.view.players.get(id); return [p.x, p.z]; }, await td(B, () => window.__td.myId));
  await B.page.bringToFront();   // фоновые вкладки не рисуют кадры — бегать можно только в активной
  await td(B, () => { window.__td.runner.root.position.set(0, 0, 0); });
  await sleep(500);
  const start = await td(B, () => window.__td.runner.root.position.toArray());
  const f0 = await td(B, () => window.__td.renderer?.info.render.frame || 0);
  await td(B, () => { window.__td.keys.add('KeyW'); window.__td.keys.add('KeyD'); });
  // держим, пока не пробежит 4 ед.: на 4 вкладках с программной отрисовкой кадров мало, а шаг за кадр ограничен 0,1 с
  await B.page.waitForFunction((s) => { const p = window.__td.runner.root.position; return Math.hypot(p.x - s[0], p.z - s[2]) > 4.5; }, { timeout: 30000 }, start).catch(() => {});
  console.log('   кадров за 4 с у Бори:', (await td(B, () => window.__td.renderer?.info.render.frame || 0)) - f0, '(swiftshader на 4 вкладки — медленно)');
  await td(B, () => { window.__td.keys.clear(); });
  await sleep(600);
  const bId = await td(B, () => window.__td.myId);
  const after = await td(H, (id) => { const p = window.__td.view.players.get(id); return [p.x, p.z]; }, bId);
  const own = await td(B, () => window.__td.runner.root.position.toArray());
  const seenBy = await Promise.all(others.concat([H]).filter((p) => p !== B).map((p) => td(p, (id) => { const o = window.__td.others.get(id); return o ? o.root.position.toArray() : null; }, bId)));
  console.log('   Боря: был', before, 'стал (у хоста)', after, 'у себя', own.map((v) => v.toFixed(1)), 'видят другие', JSON.stringify(seenBy));
  check(Math.hypot(own[0] - start[0], own[2] - start[2]) > 4 && Math.hypot(after[0] - own[0], after[1] - own[2]) < 0.5, `персонаж Бори пробежал ${Math.hypot(own[0] - start[0], own[2] - start[2]).toFixed(1)} ед., хост знает новую позицию`);
  check(seenBy.every((p) => p && Math.hypot(p[0] - own[0], p[2] - own[2]) < 1.5), 'другие видят персонажа Бори там же (±1.5)');
  await shot(B, '05-runner');
}

/* ── волна ── */
await td(A, () => window.__td.doAct({ k: 'wave' }));
check(await waitFor(H, () => window.__td.view.wave === 1 && window.__td.view.enemies.size > 0, 10000), 'волна 1 пошла');
await sleep(2500);
await shot(A, '06-wave-A');
await shot(C, '06-wave-C');
// синхронизация теней: одни и те же id и близкие позиции у хоста и клиента
const sync = await Promise.all([H, ...others].map((p) => td(p, () => [...window.__td.view.enemies.values()].map((e) => [e.id, Math.round(e.x), Math.round(e.z)]))));
const hostIds = new Set(sync[0].map((e) => e[0]));
const drift = Math.max(0, ...sync.slice(1).flatMap((list) => list.filter((e) => hostIds.has(e[0])).map((e) => {
  const h = sync[0].find((q) => q[0] === e[0]);
  return Math.hypot(h[1] - e[1], h[2] - e[2]);
})));
check(sync.slice(1).every((l) => l.length >= sync[0].length - 1 && l.length <= sync[0].length + 1), `тени у всех одни и те же (${sync.map((l) => l.length)})`);
check(drift < 4, `расхождение позиций теней хост↔клиенты ${drift.toFixed(1)} ед. (< 4)`);

/* ── опоздавший: входит по коду, когда игра уже идёт ── */
await D.page.goto(`${BASE}/lobby.html?debug&join=${code}`);
check(await waitFor(D, () => location.pathname.endsWith('play.html'), 15000), 'Галя вошла по коду в идущую игру');
check(await waitFor(D, () => window.__td && document.getElementById('loading').classList.contains('done'), 150000), 'Галя: сцена загрузилась');
check(await waitFor(H, () => window.__td.view.players.size === 4 && [...window.__td.view.players.values()].every((p) => p.active), 10000), 'у хоста четверо игроков');
const dShells = await td(D, () => window.__td.view.players.get(window.__td.myId)?.shells);
check(dShells > 0, `у Гали свои ракушки (${dShells})`);
await td(D, (s, f) => window.__td.doAct({ k: 'build', s, f }), freeSpots[4], friend);
const dBuilt = await waitFor(H, (s) => window.__td.view.towers.has(s) || window.__td.view.over, 5000, freeSpots[4]);
check(dBuilt, `Галя построила подружку${dBuilt ? '' : ` (плита ${freeSpots[4]}, подсказка: «${await td(D, () => document.getElementById('toast').textContent)}», занято: ${await td(H, () => [...window.__td.view.towers.keys()])})`}`);
// пятый — лишний
const E = await player('Лишний', '#ffa45c', '🐝');
await E.page.goto(`${BASE}/lobby.html`);
await waitFor(E, () => !document.getElementById('games').textContent.includes('Подключаемся'));
await E.page.type('#join-code', code);
await E.page.click('#btn-join');
check(await waitFor(E, () => /четверо/.test(document.getElementById('err').textContent), 5000), 'пятого игрока не пускают («уже четверо»)');
await E.ctx.close();

/* ── волна проходит до конца ── */
check(await waitFor(H, () => window.__td.view.wave >= 2 || (window.__td.view.wave === 1 && !window.__td.view.running), 120000), 'волна 1 пройдена');
let tailsAll = [];
for (let i = 0; i < 10; i++) {      // снимки приходят ~12 раз/с — читаем, пока у всех не совпадёт (или 10 попыток)
  tailsAll = await Promise.all([A, B, C, D].map((p) => td(p, () => [window.__td.view.wave, window.__td.view.tails])));
  if (tailsAll.every((t) => t[1] === tailsAll[0][1])) break;
  await sleep(300);
}
console.log('   волна/хвостики у всех:', JSON.stringify(tailsAll));
check(tailsAll.every((t) => t[1] === tailsAll[0][1]), 'хвостики у всех одинаковые');
await shot(D, '07-four-players');

/* ── уход хоста ── */
const hostId = await td(H, () => window.__td.myId);
await H.page.close();
const rest = [A, B, C, D].filter((p) => p !== H);
let newHost = null;
for (let i = 0; i < 60 && !newHost; i++) {
  for (const p of rest) if (await td(p, () => window.__td.isHost)) newHost = p;
  await sleep(250);
}
check(!!newHost, `хост ушёл — ведущим стал ${newHost && newHost.name}`);
if (newHost) {
  const w0 = await td(newHost, () => [window.__td.view.time, window.__td.view.towers.size, window.__td.view.players.get(window.__td.myId).shells]);
  await td(newHost, () => window.__td.doAct({ k: 'wave' }));
  await sleep(4000);
  const w1 = await td(newHost, () => [window.__td.view.time, window.__td.view.towers.size, window.__td.view.wave]);
  check(w1[0] > w0[0] + 2 && w1[1] === w0[1], `игра продолжается у нового ведущего (время ${w0[0].toFixed(1)}→${w1[0].toFixed(1)}, подружки сохранились: ${w1[1]})`);
  const cl = rest.find((p) => p !== newHost);
  const seen = await td(cl, () => [window.__td.view.time, window.__td.view.wave]);
  check(Math.abs(seen[0] - w1[0]) < 3, `клиенты получают снимки нового ведущего (время ${seen[0].toFixed(1)})`);
  const left = await td(newHost, (id) => window.__td.view.players.get(id)?.active, hostId);
  check(left === false, 'ушедший ведущий отмечен как ушедший, его подружки остались');
  await shot(newHost, '08-new-host');
}

/* ── итог ── */
const errs = errors.filter((e) => !/favicon/.test(e));
check(errs.length === 0, `консоль без ошибок${errs.length ? ': ' + errs.slice(0, 5).join(' | ') : ''}`);
await browser.close();
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВсё прошло.');
process.exit(fails ? 1 : 0);
