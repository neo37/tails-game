#!/usr/bin/env node
/**
 * Конструктор трасс в браузере настоящими касаниями: постройка блоков, развилка, полёт по своей трассе,
 * публикация и видимость у другого игрока, жалоба. Сервер должен быть запущен с пустым DATA_DIR.
 *   node tools/e2e-race-editor.mjs [URL]
 */
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EXAMPLES, encode, trackName } from '../src/race-design.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const SHOTS = path.join(os.homedir(), 'tails-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/snap/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 180000 });
const errors = [];
async function phone(name, width = 800, height = 360) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/400|403/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  const cdp = await page.createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
  const tap = async (x, y) => { await touch('touchStart', [[x, y, 1]]); await sleep(40); await touch('touchEnd', []); await sleep(40); };
  return { page, touch, tap, ctx };
}

/* ── строим пальцем ── */
{
  const { page, touch, tap, ctx } = await phone('строитель');
  await page.goto(`${BASE}/race-editor.html?debug`);
  await page.waitForFunction(() => window.__ed);
  const ed = (fn, ...a) => page.evaluate(fn, ...a);
  check(await ed(() => __ed.blocks.size) === 1, 'новая трасса начинается со старта');
  const fit = await ed(() => [...document.querySelectorAll('#hotbar button, #top > *:not(.grow), #status')].every((e) => { const r = e.getBoundingClientRect(); return !r.width || (r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight); }));
  check(fit, 'панель блоков и кнопки в экране телефона');
  const big = await ed(() => [...document.querySelectorAll('#hotbar button')].every((e) => e.getBoundingClientRect().width >= 38));
  check(big, 'кнопки блоков не меньше 38 пикселей');
  // смотрим сверху вниз, нажимаем в центр экрана: луч падает на пол
  await ed(() => { __ed.look(Math.PI, -1.2); });
  await sleep(150);
  const before = await ed(() => __ed.blocks.size);
  await tap(500, 150);
  check(await ed(() => __ed.blocks.size) === before + 1, 'нажатие на пол ставит блок');
  // поворот камеры не ставит блок
  const y0 = await ed(() => __ed.camera.rotation.y);
  await touch('touchStart', [[500, 150, 1]]); await touch('touchMove', [[600, 160, 1]]); await sleep(50); await touch('touchEnd', []); await sleep(60);
  check(await ed(() => __ed.blocks.size) === before + 1 && await ed((y) => __ed.camera.rotation.y !== y, y0) === true, 'движение пальцем поворачивает камеру и блока не ставит');
  await ed((y) => { __ed.look(Math.PI, -1.2); }, y0);
  await sleep(100);
  await ed(() => __ed.undo());
  check(await ed(() => __ed.blocks.size) === before, 'шаг назад убирает блок');
  // джойстик левым пальцем двигает камеру, и вторым пальцем можно ставить
  const z0 = await ed(() => __ed.camera.position.z);
  await touch('touchStart', [[120, 200, 1]]); await touch('touchMove', [[120, 150, 1]]);
  await sleep(400);
  const moved = await ed((z) => Math.abs(__ed.camera.position.z - z) > 5, z0);
  await touch('touchStart', [[120, 150, 1], [500, 150, 2]]); await sleep(30);
  const stillFlying = await ed(() => document.getElementById('joy').querySelector('i').style.transform !== '');
  await touch('touchEnd', []); await sleep(80);
  const twoFinger = await ed(() => __ed.blocks.size);
  check(moved && stillFlying && twoFinger === before + 1, `летим джойстиком и одновременно ставим блок вторым пальцем (${twoFinger - before})`);
  await ed(() => __ed.undo());

  // «Достроить»: от старта до финиша одним нажатием, и шаг назад всё убирает
  const fixShown = await ed(() => !document.getElementById('btn-fix').hidden);
  const n0 = await ed(() => __ed.blocks.size);
  await page.$eval('#btn-fix', (b) => b.click());
  const fixed = await ed(() => [__ed.analysis.ok, __ed.blocks.size]);
  check(fixShown && fixed[0] && fixed[1] > n0 && await ed(() => document.getElementById('btn-fix').hidden), `«Достроить» доводит трассу до финиша (+${fixed[1] - n0} блоков)`);
  await page.screenshot({ path: path.join(SHOTS, 'editor-fixed.png') });
  await ed(() => __ed.undo());
  check(await ed(() => __ed.blocks.size) === n0, 'шаг назад отменяет достройку целиком');
  // «Достроить с развилкой»: два пути до финиша
  const forkShown = await ed(() => !document.getElementById('btn-fixfork').hidden);
  await page.$eval('#btn-fixfork', (b) => b.click());
  const fk = await ed(() => [__ed.analysis.ok, __ed.analysis.routes.length]);
  check(forkShown && fk[0] && fk[1] === 2, `«Достроить с развилкой» строит трассу с двумя путями (${fk})`);
  await page.screenshot({ path: path.join(SHOTS, 'editor-fixfork.png') });
  await ed(() => __ed.undo());
  // сохранить кнопкой
  await ed(() => localStorage.removeItem('tg.my.races'));
  await page.$eval('#btn-save', (b) => b.click());
  check(await ed(() => JSON.parse(localStorage.getItem('tg.my.races') || '[]').length === 1 && /Сохранено/.test(document.getElementById('toast').textContent)), 'кнопка 💾 сохраняет трассу в «Мои»');

  // выбор блока по панели касанием
  await page.$eval('#hotbar', (h) => h.scrollIntoView());
  const slot = await page.$$eval('#hotbar button', (b) => { const r = b[8].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await tap(slot[0], slot[1]);
  check(/Развилка/.test(await page.$eval('#tip', (e) => e.textContent)), 'выбрана развилка');

  // ошибка, если нет финиша: лететь нельзя, остаётся на месте
  await page.$eval('#btn-fly', (b) => b.click());
  await sleep(100);
  check(page.url().includes('race-editor') && /финиш|блоков/i.test(await page.$eval('#status', (e) => e.textContent)), 'без финиша лететь нельзя, подсказка видна');
  await page.screenshot({ path: path.join(SHOTS, 'editor-new.png') });
  await ctx.close();
}

/* ── собираем трассу с развилкой блоками, летим по ней и сохраняем ── */
{
  const { page, ctx } = await phone('развилка');
  const ex = encode(EXAMPLES[1]);
  await page.goto(`${BASE}/race-editor.html?debug&code=${encodeURIComponent(ex)}`);
  await page.waitForFunction(() => window.__ed);
  await sleep(600);
  const a = await page.evaluate(() => [__ed.analysis.ok, __ed.analysis.routes.length]);
  check(a[0] && a[1] === 4, `пример с развилками открывается: путей ${a[1]}`);
  await page.screenshot({ path: path.join(SHOTS, 'editor-example.png') });
  // копия примера: правка сохраняется как своя
  await page.evaluate(() => { const k = __ed.keyOf(0, 0, 0); __ed.setTool(0); });
  await page.evaluate(() => document.getElementById('btn-diff').click());
  await sleep(450);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tg.my.races') || '[]').length);
  check(saved === 1, 'правка примера сохранилась как своя копия');
  await page.$eval('#btn-fly', (b) => b.click());
  await page.waitForFunction(() => location.pathname.endsWith('race.html') && window.__race && document.getElementById('loading').classList.contains('done'), { timeout: 120000 });
  await page.waitForFunction(() => window.__race.state === 'go', { timeout: 30000 });
  check(await page.evaluate(() => window.__race.riders.size) === 4 && await page.evaluate(() => window.__race.course.routes.length) === 4, 'летим по своей трассе с ботами, 4 пути');
  // перед развилкой: смотрим, как тоннель делится
  await page.waitForFunction(() => document.getElementById('count').hidden, { timeout: 10000 });
  const fork = await page.evaluate(() => { const R = __race, m = R.mine.p, f = R.track.forks[0]; m.next = R.track.obstacles.findIndex((o) => o.s > f.s - 40); if (m.next < 0) m.next = R.track.obstacles.length; m.s = f.s - 60; m.x = 0; m.y = 0; m.v = 30; return f.s; });
  await sleep(700);
  await page.screenshot({ path: path.join(SHOTS, 'editor-fork-ahead.png') });
  const opts = await page.evaluate(() => __race.track.forks[0].opts);
  check(opts.length === 2, `впереди развилка на ${opts.length} ветки`);
  await page.waitForFunction((s) => __race.mine.p.s > s + 5 || __race.mine.p.nf > 0, { timeout: 20000 }, fork);
  check(await page.evaluate(() => __race.mine.p.nf >= 1), 'развилку прошли, ветка выбрана');
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'editor-fork-after.png') });
  // до финиша
  await page.evaluate(() => { const R = __race, m = R.mine.p; m.next = R.track.obstacles.length; m.nf = R.track.forks.length; m.s = R.track.length - 15; m.v = 60; });
  await page.waitForSelector('#overlay.show', { timeout: 20000 });
  const links = await page.$$eval('#ov-buttons a', (a) => a.map((x) => x.getAttribute('href')));
  check(links.some((h) => h.startsWith('race-editor.html?edit=')), 'после финиша кнопка «В редактор» ведёт к своей трассе');
  await page.screenshot({ path: path.join(SHOTS, 'editor-finish.png') });
  await ctx.close();
}

/* ── публикация: трассу видит другой игрок ── */
{
  const a = await phone('автор'), b = await phone('другой');
  const code = encode(EXAMPLES[0]), name = trackName(EXAMPLES[0]);
  await a.page.goto(`${BASE}/race-editor.html?debug&code=${encodeURIComponent(code)}`);
  await a.page.waitForFunction(() => window.__ed);
  await a.page.$eval('#btn-pub', (x) => x.click());
  await a.page.waitForFunction(() => /все/i.test(document.getElementById('toast').textContent), { timeout: 8000 });
  check(true, 'автор опубликовал трассу');
  await b.page.goto(`${BASE}/races.html?debug`);
  await b.page.waitForFunction((n) => document.getElementById('levels').textContent.includes(n), { timeout: 8000 }, name);
  check(true, `другой игрок видит её: «${name}»`);
  await b.page.screenshot({ path: path.join(SHOTS, 'races-all.png') });
  const href = await b.page.$eval('#levels .fill', (x) => x.getAttribute('href'));
  check(href.includes('race.html?code='), 'её можно запустить');
  // чужой список: кнопка делает копию, а не правит оригинал
  check((await b.page.$eval('#levels .edit', (x) => x.getAttribute('href'))).includes('race-editor.html?code='), 'чужую трассу можно только скопировать');
  // свободного текста в каталоге нет: подделка кода отвергается, неготовая трасса — тоже
  const bad = await b.page.evaluate(async () => [(await fetch('api/tracks', { method: 'POST', body: 'r1AAA' })).status, (await fetch('api/tracks', { method: 'POST', body: '<script>alert(1)</script>' })).status]);
  check(bad[0] === 400 && bad[1] === 400, `неготовые и поддельные трассы сервер не берёт (${bad})`);
  // жалоба: убирает у пожаловавшегося, три разных устройства скрывают у всех
  b.page.on('dialog', (d) => d.accept());
  await b.page.$eval('[data-report]', (x) => x.click());
  await sleep(250);
  check(!(await b.page.$eval('#levels', (x) => x.textContent)).includes(name), 'после жалобы трасса пропала у пожаловавшегося');
  const before = await a.page.evaluate(async () => (await (await fetch('api/tracks')).json()).tracks.length);
  const id = await a.page.evaluate(async () => (await (await fetch('api/tracks')).json()).tracks[0].id);
  for (const device of ['x1', 'x2']) await a.page.evaluate(async (id, device) => { await fetch('api/tracks/report', { method: 'POST', body: JSON.stringify({ id, device }) }); }, id, device);
  const after = await a.page.evaluate(async () => (await (await fetch('api/tracks')).json()).tracks.length);
  check(before === 1 && after === 0, `три жалобы скрывают трассу у всех (${before} → ${after})`);
  await a.ctx.close(); await b.ctx.close();
}

/* ── с друзьями на своей трассе: из конструктора в лобби, двое в комнате, ветки видны друг у друга ── */
{
  const a = await phone('Аня'), b = await phone('Боря');
  for (const [pl, n, c] of [[a, 'Смелая Лиса', '#ff6f91'], [b, 'Шустрый Ёж', '#8fd0ff']]) {
    await pl.page.goto(`${BASE}/index.html`);
    await pl.page.evaluate((n, c) => localStorage.setItem('tg.me', JSON.stringify({ name: n, color: c, emoji: '🦊', hero: 'ghost' })), n, c);
  }
  await a.page.goto(`${BASE}/race-editor.html?debug&code=${encodeURIComponent(encode(EXAMPLES[1]))}`);
  await a.page.waitForFunction(() => window.__ed);
  await a.page.$eval('#btn-team', (x) => x.click());
  await a.page.waitForFunction(() => location.pathname.endsWith('lobby.html') && document.getElementById('map').value === 'track', { timeout: 10000 });
  await a.page.waitForFunction(() => !document.getElementById('games').textContent.includes('Подключаемся'));
  await a.page.evaluate(() => document.getElementById('btn-create').click());
  await a.page.waitForFunction(() => /^[A-Z0-9]{4}$/.test(document.getElementById('room-code').textContent), { timeout: 10000 });
  const code = await a.page.$eval('#room-code', (e) => e.textContent);
  check(/Своя трасса/.test(await a.page.$eval('#room-where', (e) => e.textContent)), `комната на своей трассе создана: ${code}`);
  await b.page.goto(`${BASE}/lobby.html?debug&join=${code}`);
  await a.page.waitForFunction(() => document.querySelectorAll('#room-players .p').length === 2, { timeout: 10000 });
  await a.page.evaluate(() => document.getElementById('btn-start').click());
  for (const x of [a, b]) await x.page.waitForFunction(() => location.pathname.endsWith('race.html') && window.__race && window.__race.state === 'go', { timeout: 120000 });
  const routes = await Promise.all([a, b].map((x) => x.page.evaluate(() => [window.__race.course.routes.length, window.__race.riders.size])));
  check(routes.every(([r, n]) => r === 4 && n === 2), `оба летят по одной трассе с развилками, без ботов (${JSON.stringify(routes)})`);
  // Боря уходит на другую ветку — Аня видит его там
  const want = await b.page.evaluate(() => { const R = __race, m = R.mine.p, f = R.track.forks[0], o = f.opts.find((q) => q.route !== 0) || f.opts[1];
    m.route = o.route; m.nf = 1; m.s = f.s + 60; m.next = R.track.obstacles.findIndex((q) => q.s > m.s); if (m.next < 0) m.next = R.track.obstacles.length; m.v = 30; return o.route; });
  await a.page.waitForFunction((w) => [...__race.riders.values()].some((r) => !r.isMe && r.p.route === w), { timeout: 8000 }, want).catch(() => {});
  check(await a.page.evaluate((w) => [...__race.riders.values()].some((r) => !r.isMe && r.p.route === w), want), `Аня видит Борю на его ветке (${want})`);
  // выстрел Ани долетает до Бори через сервер
  await a.page.evaluate(() => { const R = __race, m = R.mine.p; m.gun = 0; R.shoot(R.mine); });
  await b.page.waitForFunction(() => __race.shots.length > 0, { timeout: 5000 }).catch(() => {});
  check(await b.page.evaluate(() => __race.shots.length > 0), 'выстрел другого игрока виден в комнате');
  await a.ctx.close(); await b.ctx.close();
}

/* ── автосохранение в редакторе карт защиты ── */
{
  const { page, ctx } = await phone('карты');
  await page.goto(`${BASE}/editor.html?debug&new=1`);
  await page.waitForSelector('#name');
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('tg.my.levels') || '[]').length);
  await sleep(1500);
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('tg.my.levels') || '[]').length) === before, 'просто открыть редактор — ничего не сохраняется');
  // пример дорожки рабочий: меняем название, через секунду он сам в «Моих уровнях»
  await page.evaluate(() => localStorage.removeItem('tg.editor.draft'));
  await page.goto(`${BASE}/editor.html?debug`);
  await page.waitForFunction(() => document.getElementById('name').value !== '');   // скрипт редактора уже подписался на правки
  await page.evaluate(() => { const n = document.getElementById('name'); n.value = 'Автосохранение'; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('tg.my.levels') || '[]').some((x) => x.name === 'Автосохранение'), { timeout: 5000 }).catch(() => {});
  const saved = await page.evaluate(() => [JSON.parse(localStorage.getItem('tg.my.levels') || '[]').filter((x) => x.name === 'Автосохранение').length, document.getElementById('btn-save').textContent]);
  check(saved[0] === 1 && /Сохранено/.test(saved[1]), `правка сама сохранилась в «Мои уровни» (${saved})`);
  await page.evaluate(() => { const n = document.getElementById('name'); n.value = 'Автосохранение 2'; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(1600);
  const list = await page.evaluate(() => JSON.parse(localStorage.getItem('tg.my.levels') || '[]').map((x) => x.name));
  check(list.includes('Автосохранение 2') && !list.includes('Автосохранение'), `повторная правка обновляет тот же уровень, а не плодит копии (${list.join(', ')})`);
  // недоделанный уровень — тоже сохраняется, черновиком, и открывается в редакторе, а не в игре
  await page.evaluate(() => localStorage.removeItem('tg.editor.draft'));
  await page.goto(`${BASE}/editor.html?debug&new=1`);
  await page.waitForFunction(() => document.getElementById('name').value !== '');
  await page.evaluate(() => { const n = document.getElementById('name'); n.value = 'Недоделанный'; n.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('tg.my.levels') || '[]').some((x) => x.name === 'Недоделанный'), { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('tg.my.levels') || '[]').some((x) => x.name === 'Недоделанный')), 'недоделанный уровень сохранился черновиком');
  await page.goto(`${BASE}/map.html?map=custom`);
  const card = await page.$$eval('#levels .lvl.mine-lvl', (els) => els.map((e) => [e.textContent.replace(/\s+/g, ' '), e.querySelector('.fill').getAttribute('href')]).find(([t]) => t.includes('Недоделанный')));
  check(card && /Черновик/.test(card[0]) && card[1].startsWith('editor.html?edit='), `в «Моих уровнях» он помечен черновиком и ведёт в редактор (${card && card[1]})`);
  await page.goto(`${BASE}/lobby.html`);
  await page.waitForSelector('#map');
  const opts = await page.evaluate(() => { const m = document.getElementById('map'); if (![...m.options].some((o) => o.value === 'custom')) return []; m.value = 'custom'; m.dispatchEvent(new Event('change')); return [...document.getElementById('level').options].map((o) => o.textContent); });
  check(!opts.some((t) => t.includes('Недоделанный')), 'черновик не предлагается для командной игры');
  await ctx.close();
}

/* ── список, вкладки ── */
{
  const { page, ctx } = await phone('список');
  await page.goto(`${BASE}/races.html`);
  await page.$eval('[data-tab="samples"]', (b) => b.click());
  await page.waitForFunction((n) => document.querySelectorAll('#levels .lvl').length === n, {}, EXAMPLES.length);
  check(true, `${EXAMPLES.length} примеров трасс в списке`);
  await page.screenshot({ path: path.join(SHOTS, 'races-samples.png') });
  await ctx.close();
}
check(errors.length === 0, `консоль без ошибок${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);
await browser.close();
process.exit(fails ? 1 : 0);
