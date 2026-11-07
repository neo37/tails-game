#!/usr/bin/env node
/**
 * Проверка гонки в браузере: меню, полёт пальцами на экране телефона, тормоз, финиш и звёзды,
 * затем настоящая гонка двух игроков через комнату. Сервер должен быть запущен.
 *   node tools/e2e-race.mjs [URL]
 */
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const SHOTS = path.join(os.homedir(), 'tails-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/snap/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 180000 });
const errors = [];
async function phone(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 800, height: 360, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  const cdp = await page.createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
  return { page, touch, ctx };
}
const ready = (page) => page.waitForFunction(() => window.__race && document.getElementById('loading').classList.contains('done'), { timeout: 120000 });
const flying = (page) => page.waitForFunction(() => window.__race.state === 'go', { timeout: 60000 });

/* ── меню ── */
{
  const { page, ctx } = await phone('меню');
  await page.goto(`${BASE}/index.html`);
  check(await page.$('[data-map="race"]') !== null, 'в меню есть карта «Гонка»');
  check(await page.$('[data-map="quay"]') === null && await page.$('[data-map="castle"]') !== null, 'Набережной в главном меню нет, Замок есть');
  const fit = await page.$$eval('#maps a', (els) => els.every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 80; }));
  check(fit, 'все карточки карт в экране телефона');
  await page.screenshot({ path: path.join(SHOTS, 'race-menu.png') });
  await page.goto(`${BASE}/map.html?map=race`);
  const lv = await page.$$eval('#levels .lvl', (els) => els.map((e) => [e.tagName, e.getAttribute('href')]));
  check(lv.length === 11 && lv[0][1] === 'race.html?level=1' && lv[1][0] === 'DIV' && lv[10][1] === 'races.html', `10 трасс: новому игроку открыта первая, остальные по порядку (${lv.length})`);
  // кто уже играл до этой версии — у того открыто всё
  const ctx2 = await browser.createBrowserContext(), old = await ctx2.newPage();
  await old.goto(`${BASE}/style.css`);
  await old.evaluate(() => localStorage.setItem('tg.quay.stars.1', '2'));
  await old.goto(`${BASE}/map.html?map=race`);
  const lv2 = await old.$$eval('#levels .lvl', (els) => els.filter((e) => e.classList.contains('locked')).length);
  await old.goto(`${BASE}/map.html?map=castle`);
  const lv3 = await old.$$eval('#levels .lvl', (els) => els.filter((e) => e.classList.contains('locked')).length);
  check(lv2 === 0 && lv3 === 0 && await old.evaluate(() => localStorage.getItem('tg.allOpen')) === '1', 'тому, кто играл раньше, открыты все уровни');
  await ctx2.close();
  await ctx.close();
}

/* ── один против ботов ── */
{
  const { page, touch, ctx } = await phone('один');
  await page.goto(`${BASE}/race.html?level=1&debug`);
  await ready(page);
  check(await page.evaluate(() => window.__race.riders.size) === 4, 'на старте 4 персонажа: ты и 3 бота');
  await flying(page);
  check(true, 'обратный отсчёт закончился, летим');
  await sleep(1500);
  const v0 = await page.evaluate(() => window.__race.mine.p.v);
  check(v0 > 1 && v0 < 40, `разгон идёт плавно: через 1.5 с скорость ${v0.toFixed(0)} из 70`);

  // палец в любом месте левой части: летим вправо
  const p0 = await page.evaluate(() => window.__race.mine.p.x);
  await touch('touchStart', [[300, 200, 1]]);
  await touch('touchMove', [[345, 200, 1]]);
  await page.waitForFunction((x) => window.__race.mine.p.x > x + 1.5, { timeout: 5000 }, p0).catch(() => {});
  check(await page.evaluate((x) => window.__race.mine.p.x > x + 1.5, p0), 'палец вправо: персонаж смещается вправо');
  const roll = await page.evaluate(() => { const r = window.__race.mine; return r.roll; });
  check(roll > 0.05, `на вираже наклоняется как самолёт (крен ${roll.toFixed(2)})`);

  // тормоз вторым пальцем, пока первый рулит
  await page.evaluate(() => { const m = window.__race.mine.p; m.v = 60; });
  await touch('touchStart', [[345, 200, 1], [700, 300, 2]]);
  await sleep(600);
  const braking = await page.evaluate(() => [window.__race.mine.p.v, document.getElementById('brake-zone').classList.contains('on'), window.__race.joy.active]);
  check(braking[1] && braking[0] < 55 && braking[2], `тормоз вторым пальцем, руль не отпускается (скорость ${braking[0].toFixed(0)})`);
  await touch('touchEnd', []);
  await sleep(200);
  await page.screenshot({ path: path.join(SHOTS, 'race-fly.png') });

  // стреляем пальцем по боту впереди на той же линии
  {
    const target = await page.evaluate(() => {
      const R = window.__race, m = R.mine.p, bot = [...R.riders.values()].find((r) => !r.isMe);
      m.s = 150; m.x = 0; m.y = 0; m.v = 40; m.gun = 0; m.next = 0;
      bot.p.s = 185; bot.p.x = 0.3; bot.p.y = 0; bot.p.v = 40; bot.p.zap = 0; bot.p.next = 0; bot.skill.miss = 1;
      return bot.id;
    });
    const b = await page.$eval('#fire', (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await touch('touchStart', [[300, 200, 1]]);
    await touch('touchStart', [[300, 200, 1], [b[0], b[1], 2]]);
    await sleep(60);
    await touch('touchEnd', []);
    const fired = await page.evaluate(() => window.__race.shots.length > 0 || window.__race.mine.p.gun > 0);
    await page.waitForFunction((id) => window.__race.riders.get(id).p.zap > 0, { timeout: 4000 }, target).catch(() => {});
    const z = await page.evaluate((id) => window.__race.riders.get(id).p.zap, target);
    check(fired && z > 0, `кнопка «Огонь» вторым пальцем стреляет, бот впереди замедлен (${fired}, ${z.toFixed(2)})`);
    await page.screenshot({ path: path.join(SHOTS, 'race-shot.png') });
  }
  // грязевая бомба: держим «Огонь» — у ботов грязь и чёрные сферы, у себя зелёная, второй раз нельзя
  {
    await page.evaluate(() => { const R = window.__race; R.mine.p.gun = 0; for (const r of R.riders.values()) { r.p.mud = 0; if (!r.isMe) r.p.bombUsed = true; } });
    const has = await page.$eval('#fire', (e) => e.classList.contains('has-bomb'));
    const b = await page.$eval('#fire', (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await touch('touchStart', [[b[0], b[1], 3]]);
    await sleep(1100);
    const st = await page.evaluate(() => { const R = window.__race; return [R.mine.p.bombUsed, [...R.riders.values()].filter((r) => !r.isMe).every((r) => r.p.mud > 0), R.mine.p.mud || 0,
      [...R.riders.values()].map((r) => r.r.root.children.filter((c) => c.geometry && c.geometry.type === 'SphereGeometry').map((c) => c.material.color.getHexString())).flat()]; });
    await touch('touchEnd', []);
    await page.screenshot({ path: path.join(SHOTS, 'race-bomb.png') });
    check(has && st[0] && st[1] && st[2] === 0 && st[3].includes('39ff6a') && st[3].includes('050505'), `держишь «Огонь» — грязевая бомба: соперники в грязи, сферы ${[...new Set(st[3])].join(', ')}`);
    await page.evaluate(() => { for (const r of window.__race.riders.values()) r.p.mud = 0; });
    await touch('touchStart', [[b[0], b[1], 3]]); await sleep(1100); await touch('touchEnd', []);
    check(await page.evaluate(() => [...window.__race.riders.values()].filter((r) => !r.isMe).every((r) => !(r.p.mud > 0))) && !(await page.$eval('#fire', (e) => e.classList.contains('has-bomb'))), 'вторую бомбу на этой трассе бросить нельзя');
  }
  // боты стреляют сами
  {
    const ok = await page.evaluate(async () => {
      const R = window.__race, m = R.mine.p, bot = [...R.riders.values()].find((r) => !r.isMe);
      bot.aimT = 0; bot.p.s = m.s - 30; bot.p.x = m.x; bot.p.y = m.y; bot.p.gun = 0;
      await new Promise((r) => setTimeout(r, 300));
      return bot.p.gun > 0;
    });
    check(ok, 'бот стреляет, если ты впереди на его линии');
  }

  // врезаемся в первую преграду
  const hit = await page.evaluate(() => {
    const R = window.__race, m = R.mine.p, o = R.track.obstacles.find((q) => q.kind === 'gate' && q.s > m.s);
    m.next = R.track.obstacles.indexOf(o); m.s = o.s - 2; m.x = o.x + (o.x > 0 ? -9 : 9); m.y = 0; m.v = 60; m.safe = 0;
    return o.s;
  });
  await sleep(1500);
  const after = await page.evaluate(() => [window.__race.mine.p.v, window.__race.mine.p.s]);
  check(after[0] < 20 && after[1] <= hit, `преграда твёрдая: скорость ${after[0].toFixed(0)}, не пролетел сквозь неё`);

  // финиш: занимаем первое место и открываем следующую трассу
  await page.evaluate(() => { const R = window.__race, m = R.mine.p; m.next = R.track.obstacles.length; m.s = R.track.length - 20; m.v = 60; });
  await page.waitForSelector('#overlay.show', { timeout: 20000 });
  const fin = await page.evaluate(() => [document.getElementById('ov-title').textContent, document.getElementById('ov-stars').textContent, document.querySelectorAll('#ov-table .r').length,
    localStorage.getItem('tg.race.stars.1'), localStorage.getItem('tg.race.unlocked')]);
  check(/Первое/.test(fin[0]) && fin[2] === 4 && fin[3] === '3' && fin[4] === '2', `финиш: ${fin[0]}, таблица ${fin[2]}, звёзд ${fin[3]}, открыта трасса ${fin[4]}`);
  await page.screenshot({ path: path.join(SHOTS, 'race-finish.png') });
  // запись гонки: сохранилась на телефоне, повтор показывает тех же гонщиков в движении
  const rep = await page.evaluate(() => { const l = JSON.parse(localStorage.getItem('tg.replays') || '[]'); const r = l[0] && JSON.parse(localStorage.getItem('tg.replay.' + l[0].id)); return l[0] ? [l[0].id, l[0].place, r.riders.length, Object.values(r.frames)[0].d.length / 5, (localStorage.getItem('tg.replay.' + l[0].id) || '').length] : null; });
  check(rep && rep[1] === 1 && rep[2] === 4 && rep[3] > 20 && await page.$('#btn-replay') !== null, `гонка записана: место ${rep && rep[1]}, гонщиков ${rep && rep[2]}, кадров ${rep && rep[3]}, ${rep && Math.round(rep[4] / 1024)} КБ`);
  await page.$eval('#btn-replay', (a) => a.click());
  await page.waitForFunction(() => location.search.includes('replay=') && window.__race && document.getElementById('loading').classList.contains('done'), { timeout: 120000 });
  const q0 = await page.evaluate(() => [window.__race.playT, [...window.__race.riders.values()].map((r) => r.p.s)]);
  await sleep(1200);
  const q1 = await page.evaluate(() => [window.__race.playT, [...window.__race.riders.values()].map((r) => r.p.s), document.body.classList.contains('replay'), getComputedStyle(document.getElementById('fire')).display]);
  check(q1[0] > q0[0] + 0.5 && q1[1].some((s, i) => s > q0[1][i] + 1) && q1[2] && q1[3] === "none", `повтор идёт: время ${q0[0].toFixed(1)} → ${q1[0].toFixed(1)} с, корабли летят, кнопки «Огонь» нет`);
  await page.$eval('#rp-play', (b) => b.click());
  const t0 = await page.evaluate(() => window.__race.playT); await sleep(600);
  check(await page.evaluate((t) => Math.abs(window.__race.playT - t) < 0.01, t0), 'пауза останавливает повтор');
  await page.$eval('#rp-play', (b) => b.click());
  await page.screenshot({ path: path.join(SHOTS, 'race-replay.png') });
  await page.goto(`${BASE}/races.html#replays`);
  await page.waitForFunction(() => document.querySelector('#levels .lvl a.fill[href*="replay="]'), { timeout: 5000 }).catch(() => {});
  check(await page.$('#levels a.fill[href*="replay="]') !== null, 'запись видна во вкладке «📼 Записи»');
  await ctx.close();
}

/* ── два игрока через комнату ── */
{
  const a = await phone('Аня'), b = await phone('Боря');
  for (const [pl, n, c, h] of [[a, 'Смелая Лиса', '#ff6f91', 'ghost'], [b, 'Шустрый Ёж', '#8fd0ff', 'maskot']]) {
    await pl.page.goto(`${BASE}/index.html`);
    await pl.page.evaluate((n, c, h) => localStorage.setItem('tg.me', JSON.stringify({ name: n, color: c, emoji: '🦊', hero: h })), n, c, h);
  }
  await a.page.goto(`${BASE}/lobby.html?debug&map=race&level=1`);
  await a.page.waitForFunction(() => !document.getElementById('games').textContent.includes('Подключаемся'));
  await a.page.evaluate(() => document.getElementById('btn-create').click());
  await a.page.waitForFunction(() => /^[A-Z0-9]{4}$/.test(document.getElementById('room-code').textContent), { timeout: 10000 });
  const code = await a.page.$eval('#room-code', (e) => e.textContent);
  check(/Гонка/.test(await a.page.$eval('#room-where', (e) => e.textContent)), `комната гонки создана: ${code}`);
  await b.page.goto(`${BASE}/lobby.html?debug&join=${code}`);
  await a.page.waitForFunction(() => document.querySelectorAll('#room-players .p').length === 2, { timeout: 10000 });
  await a.page.evaluate(() => document.getElementById('btn-start').click());
  await a.page.waitForFunction(() => location.pathname.endsWith('race.html'), { timeout: 15000 });
  await b.page.waitForFunction(() => location.pathname.endsWith('race.html'), { timeout: 15000 });
  await Promise.all([ready(a.page), ready(b.page)]);
  await Promise.all([flying(a.page), flying(b.page)]);
  check(true, 'оба перешли на гонку и стартовали вместе');
  check(await a.page.evaluate(() => window.__race.riders.size === 2 && window.__race.isHost) && await b.page.evaluate(() => window.__race.riders.size === 2 && !window.__race.isHost), 'у каждого два персонажа, боты не добавлены');

  // персонаж Бори виден у Ани и движется
  await b.page.evaluate(() => { const m = window.__race.mine.p; m.next = window.__race.track.obstacles.length; m.s = 500; m.x = 3; m.v = 60; });
  await sleep(1500);
  const seen = await a.page.evaluate(() => [...window.__race.riders.values()].find((r) => !r.isMe).p.s);
  check(seen > 450, `Аня видит Борю на трассе (s=${seen.toFixed(0)})`);
  await a.page.evaluate(() => { const m = window.__race.mine.p; m.next = window.__race.track.obstacles.length; m.s = 500; m.v = 60; });
  await sleep(1500);
  const seen2 = await b.page.evaluate(() => [...window.__race.riders.values()].find((r) => !r.isMe).p.s);
  check(seen2 > 450, `Боря видит Аню на трассе (s=${seen2.toFixed(0)})`);
  await a.page.screenshot({ path: path.join(SHOTS, 'race-team.png') });

  // Боря первый, Аня вторая: у обоих один порядок
  await b.page.evaluate(() => { const R = window.__race; R.mine.p.s = R.track.length - 15; });
  await b.page.waitForSelector('#overlay.show', { timeout: 20000 });
  await sleep(1200);
  await a.page.evaluate(() => { const R = window.__race; R.mine.p.next = R.track.obstacles.length; R.mine.p.s = R.track.length - 15; R.mine.p.v = 60; });
  await a.page.waitForSelector('#overlay.show', { timeout: 20000 });
  await sleep(800);
  const titles = await Promise.all([a, b].map((x) => x.page.$eval('#ov-title', (e) => e.textContent)));
  const tb = await Promise.all([a, b].map((x) => x.page.$$eval('#ov-table .r .n', (els) => els.map((e) => e.textContent).join(' > '))));
  check(/Первое/.test(titles[1]) && /2/.test(titles[0]), `места: Боря «${titles[1]}», Аня «${titles[0]}»`);
  check(tb[0] === tb[1] && /Шустрый Ёж.*Смелая Лиса/.test(tb[0]), `таблица одна у обоих: ${tb[0]}`);
  await a.ctx.close(); await b.ctx.close();
}

check(errors.length === 0, `консоль без ошибок${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);
await browser.close();
process.exit(fails ? 1 : 0);
