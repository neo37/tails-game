#!/usr/bin/env node
/**
 * Проверка редактора: персонаж бегает по полю и ставит клетки → проверка пути → сохранить →
 * сыграть одному → код уровня (печатается в конце, для командной проверки: e2e.mjs --custom КОД).
 */
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const SHOTS = path.join(os.homedir(), 'tails-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };

const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror ' + e.message));

await page.goto(`${BASE}/editor.html?debug`);
await page.waitForFunction(() => window.__ed && document.getElementById('loading').classList.contains('done'), { timeout: 60000 });
await page.click('#btn-new');
await sleep(300);
check(await page.$eval('#status', (e) => e.className === 'bad'), `пустое поле — уровень не готов: «${await page.$eval('#status', (e) => e.innerText.replace(/\s+/g, ' '))}»`);

// персонаж бежит вправо клавишей D — проверяем, что он двигается и анимация идёт
const p0 = await page.evaluate(() => window.__ed.runner.root.position.toArray());
await page.keyboard.down('KeyD');
// держим, пока не пробежит 4 ед.: на программной отрисовке кадров мало, а шаг за кадр ограничен 0,1 с
await page.waitForFunction((p0) => { const p = window.__ed.runner.root.position; return Math.hypot(p.x - p0[0], p.z - p0[2]) > 4; }, { timeout: 20000 }, p0).catch(() => {});
await page.keyboard.up('KeyD');
await sleep(300);
const p1 = await page.evaluate(() => window.__ed.runner.root.position.toArray());
check(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 4, `персонаж пробежал ${Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(1)} ед. по клавише D`);
await page.screenshot({ path: path.join(SHOTS, 'editor-01-run.png') });

// рисуем уровень: дорога-«Г», старт, домик, плиты — персонаж встаёт на клетку и жмёт «Поставить»
const put = async (i, j, tool) => {
  await page.evaluate((i, j, tool) => {
    const ed = window.__ed;
    ed.setTool(tool);
    const [x, z] = ed.grid.center(ed.grid.idx(i, j));
    ed.runner.root.position.set(x, 0, z);
  }, i, j, tool);
  await page.click('#btn-put');
};
await put(1, 2, 'spawn');
for (let i = 2; i <= 10; i++) await put(i, 2, 'road');
for (let j = 3; j <= 9; j++) await put(10, j, 'road');
await put(10, 10, 'house');
check(await page.$eval('#status', (e) => e.className === 'bad'), 'без плит уровень ещё не готов');
for (const [i, j] of [[4, 4], [7, 4], [8, 7], [12, 5], [12, 8]]) await put(i, j, 'spot');
// второй старт — с другой стороны, дорога вливается в первую
await put(10, 0, 'spawn');
await put(10, 1, 'road');
await sleep(300);
const st = await page.$eval('#status', (e) => [e.className, e.innerText]);
check(st[0] === 'ok', `уровень проверен: ${st[1]}`);
// разрыв дороги ломает уровень, починка — чинит
await put(10, 6, 'erase');
check(await page.$eval('#status', (e) => /Нет дороги/.test(e.innerText)), 'разрыв дороги: «Нет дороги от старта до домика»');
await put(10, 6, 'road');
check(await page.$eval('#status', (e) => e.className === 'ok'), 'дорогу починили — снова можно играть');
await page.$eval('#name', (e) => { e.value = 'Тестовая Г'; e.dispatchEvent(new Event('change')); });
await page.select('#diff', 'easy');
await page.evaluate(() => { window.__ed.runner.jump(); });
await sleep(400);
await page.screenshot({ path: path.join(SHOTS, 'editor-02-level.png') });

// сохранить и код
await page.click('#btn-save');
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tg.my.levels') || '[]'));
check(saved.length >= 1 && saved[0].name === 'Тестовая Г', `сохранено в «Мои уровни» (${saved.length})`);
await page.click('#btn-export');
const code = await page.$eval('#code', (e) => e.value);
check(code.length > 20 && code.length < 400, `код уровня ${code.length} символов`);
// импорт кода в чистый редактор
await page.click('#btn-new');
await page.$eval('#code', (e, c) => { e.value = c; }, code);
await page.click('#btn-import');
await sleep(200);
check(await page.$eval('#name', (e) => e.value === 'Тестовая Г') && await page.$eval('#status', (e) => e.className === 'ok'), 'код вставлен обратно — уровень тот же');

// сыграть одному
await page.click('#btn-play');
await page.waitForFunction(() => window.__td && document.getElementById('loading').classList.contains('done'), { timeout: 60000 });
const lv = await page.evaluate(() => [window.__td.level.name, window.__td.level.paths ? window.__td.level.paths.length : 1, window.__td.SPOTS.length]);
check(lv[0] === 'Тестовая Г' && lv[1] === 2 && lv[2] === 5, `уровень открылся в игре: ${lv}`);
await page.evaluate(() => {
  for (const s of [0, 1, 2, 3]) window.__td.doAct({ k: 'build', s, f: 'mila' });
  window.__td.doAct({ k: 'wave' });
});
await sleep(6000);
const w = await page.evaluate(() => [window.__td.view.wave, window.__td.view.towers.size, window.__td.view.enemies.size]);
check(w[0] === 1 && w[1] >= 3, `волна идёт на своём уровне: волна ${w[0]}, подружек ${w[1]}, теней ${w[2]}`);
await page.evaluate(() => document.getElementById('btn-cam').click());
await sleep(800);
await page.screenshot({ path: path.join(SHOTS, 'editor-03-play.png') });

check(errors.length === 0, `консоль без ошибок${errors.length ? ': ' + errors.slice(0, 4).join(' | ') : ''}`);
console.log('CODE', code);
await browser.close();
process.exit(fails ? 1 : 0);
