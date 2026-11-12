#!/usr/bin/env node
/**
 * Удары в гонке (headless Chromium): преграда рассыпается на куски, корабль мигает и пролетает сквозь,
 * куски пропадают, преграда собирается; два корабля сталкиваются — оба мигают, от обоих летят осколки.
 * Сервер: PORT=8795 node server/index.js. Запуск: node tools/e2e-crash.mjs [http://127.0.0.1:8795]
 */
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const SHOTS = path.join(os.homedir(), 'tails-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 915, height: 412, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/race.html?level=3&debug`);
await page.waitForFunction(() => window.__race && document.getElementById('loading').classList.contains('done'), { timeout: 120000 });
await page.waitForFunction(() => window.__race.state === 'go', { timeout: 60000 });
await sleep(1500);

// боты на время проверки стоят на месте: их удары и осколки не мешают счёту
await page.evaluate(() => {
  const R = window.__race;
  window.__bots = [];
  for (const r of R.riders.values()) if (r.skill) { window.__bots.push([r, r.skill]); r.skill = null; r.p.s = 1; r.p.x = -9; r.p.y = -9; }
});
await sleep(300);
// корабль прямо перед преградой, в сплошном месте; скорость берём в тот кадр, когда случился удар
const before = { kind: '' };
const crash = await page.evaluate(async () => {
  const R = window.__race, p = R.mine.p, tr = R.track;
  const { hits } = await import('/src/race-sim.js');
  const idx = tr.obstacles.findIndex((o, i) => i >= p.next && ['gate', 'half', 'bar', 'rocks'].includes(o.kind) && o.s > p.s + 10);
  const o = tr.obstacles[idx];
  window.__target = { idx, kind: o.kind };
  for (let g = 0; g < 4000; g++) {
    const q = Math.random() * 6.28, d = Math.random() * 9, x = Math.cos(q) * d, y = Math.sin(q) * d;
    if (hits(o, x, y, R.raceT) && hits(o, x, y, R.raceT + 0.15)) { p.x = x; p.y = y; break; }
  }
  p.next = idx; p.s = o.s - 1.5; p.vx = p.vy = 0; p.ghost = 0; p.v = R.track.def.vmax * 0.8;   // на высокой скорости разгон почти не мешает замеру
  const v0 = p.v;
  const v = await new Promise((done) => { const f = () => (p.ghost > 0 ? done(p.v) : requestAnimationFrame(f)); f(); });
  for (const d of R.debris.pieces) d.first = true;   // осколки этого удара
  for (const q of tr.obstacles) if (q !== o) q.brokenTill = 1e9;   // дальше пусто: новые удары не путают проверку
  return { kind: o.kind, v0, v, ghost: p.ghost, broken: (o.brokenTill || 0) > R.raceT, hidden: o.mesh ? !o.mesh.visible : null, pieces: R.debris.count };
});
before.kind = crash.kind;
check(crash.broken && crash.hidden, `преграда (${before.kind}) рассыпалась и исчезла`);
check(crash.pieces >= 15, `осколков в воздухе: ${crash.pieces}`);
check(crash.ghost > 0, 'корабль стал призраком');
check(crash.v < crash.v0 * 0.75 && crash.v > crash.v0 * 0.5, `корабль замедлился немного: ${crash.v0.toFixed(0)} → ${crash.v.toFixed(0)}`);
await page.screenshot({ path: path.join(SHOTS, 'crash-1-shatter.png') });
// мигание: корпус то виден, то нет, и полупрозрачный
const blink = await page.evaluate(async () => {
  const me = window.__race.mine, seen = new Set();
  for (let i = 0; i < 12; i++) { seen.add(me.body.visible); await new Promise((f) => setTimeout(f, 45)); }
  let op = 1; me.body.traverse((m) => { if (m.isMesh && m.material && m.material.opacity < op) op = m.material.opacity; });
  return { both: seen.size === 2, op };
});
check(blink.both && blink.op < 0.6, `мигает и полупрозрачный (прозрачность ${blink.op.toFixed(2)})`);
await sleep(700);
await page.screenshot({ path: path.join(SHOTS, 'crash-2-flight.png') });
const mid = await page.evaluate(() => window.__race.debris.pieces.filter((d) => d.first).length);
await sleep(1600);
const gone = await page.evaluate(() => ({ pieces: window.__race.debris.pieces.filter((d) => d.first).length, ghost: window.__race.mine.p.ghost, visible: window.__race.mine.body.visible }));
check(gone.pieces === 0, 'осколки этого удара пропали');
check(gone.ghost === 0 && gone.visible, 'корабль снова обычный, когда осколков нет');
await sleep(3200);
const back = await page.evaluate(() => { const o = window.__race.track.obstacles[window.__target.idx]; return o.mesh.visible && !window.__race.broken.has(o); });
check(back, 'преграда собралась обратно');

// столкновение с ботом
const bumpRes = await page.evaluate(async () => {
  const R = window.__race, me = R.mine, [bot, skill] = window.__bots[0];
  bot.skill = skill;
  let calls = 0;
  const orig = R.debris.ship.bind(R.debris);
  R.debris.ship = (...a) => { calls++; return orig(...a); };
  me.p.ghost = 0; bot.p.ghost = 0;
  bot.p.s = me.p.s + 0.4; bot.p.x = me.p.x + 0.5; bot.p.y = me.p.y; bot.p.route = me.p.route; bot.p.next = me.p.next; bot.p.v = me.p.v;
  await new Promise((f) => setTimeout(f, 200));
  return { me: me.p.ghost > 0, bot: bot.p.ghost > 0, calls, apart: Math.hypot(me.p.x - bot.p.x, me.p.y - bot.p.y) };
});
check(bumpRes.me && bumpRes.bot, 'столкнулись: оба корабля мигают');
check(bumpRes.calls === 2, `осколки разлетелись от обоих кораблей (${bumpRes.calls} раза по 14)`);
check(bumpRes.apart > 0.6, `корабли расталкивает: ${bumpRes.apart.toFixed(1)}`);
await page.screenshot({ path: path.join(SHOTS, 'crash-3-ships.png') });
check(errors.length === 0, 'ошибок JS нет ' + errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`\nошибок: ${fails}`);
process.exit(fails ? 1 : 0);
