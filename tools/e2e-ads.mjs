#!/usr/bin/env node
/** Реклама за ⭐: в браузере кнопки нет; с мостом приложения (подставным) — досмотрел: +10, бросил: 0, не больше 5 в день. */
import puppeteer from 'puppeteer-core';
const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) fails++; };
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
let p = await b.newPage(); p.on('pageerror', (e) => errors.push(e.message));
await p.setViewport({ width: 800, height: 360, isMobile: true, hasTouch: true });
await p.goto(`${BASE}/ship.html`); await sleep(800);
check(await p.$('.ad-btn') === null, 'в браузере кнопки рекламы нет');
await p.close();
p = await b.newPage(); p.on('pageerror', (e) => errors.push(e.message));
await p.setViewport({ width: 800, height: 360, isMobile: true, hasTouch: true });
// подставной мост как в MainActivity: ролик досматривается, если __watch = true
await p.evaluateOnNewDocument(() => { window.__watch = true; window.TailsAds = { ready: () => true, show: () => setTimeout(() => window.__adDone && window.__adDone(window.__watch), 50) }; });
await p.goto(`${BASE}/ship.html?debug`); await p.waitForSelector('.ad-btn');
const bal = () => p.evaluate(() => window.__ship.points.balance());
const b0 = await bal();
await p.$eval('.ad-btn', (x) => x.click()); await sleep(300);
check(await bal() === b0 + 10, `досмотрел ролик — +10 ⭐ (${b0} → ${await bal()})`);
await p.evaluate(() => { window.__watch = false; }); await sleep(2100);
await p.$eval('.ad-btn', (x) => x.click()); await sleep(300);
check(await bal() === b0 + 10, 'закрыл раньше — звёзд не прибавилось');
await p.evaluate(() => { window.__watch = true; }); await sleep(2100);
for (let i = 0; i < 6; i++) { await p.evaluate(() => document.querySelector('.ad-btn').disabled || document.querySelector('.ad-btn').click()); await sleep(300); await sleep(2100); }
check(await bal() === b0 + 50 && /всё/.test(await p.$eval('.ad-btn', (x) => x.textContent)), `не больше 5 роликов в день: ⭐${await bal() - b0}, кнопка «${await p.$eval('.ad-btn', (x) => x.textContent)}»`);
await p.goto(`${BASE}/race-editor.html?quest=1&new=1`); await sleep(1500);
check(await p.$('#quest .ad-btn') !== null, 'кнопка рекламы есть и в панели заданий');
check(errors.length === 0, `консоль без ошибок${errors.length ? ': ' + errors.join(' | ') : ''}`);
await b.close();
process.exit(fails ? 1 : 0);
