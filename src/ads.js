/**
 * Реклама с наградой: только в Android-приложении (мост window.TailsAds из MainActivity), в браузере кнопки нет.
 * Досмотрел ролик — +10 ⭐ (points.adReward), не больше 5 роликов в день.
 */
import { points, AD_PTS, ADS_PER_DAY } from './points.js';

export const adsAvailable = () => !!(window.TailsAds && typeof window.TailsAds.show === 'function');
export const adReady = () => { try { return adsAvailable() && window.TailsAds.ready(); } catch (e) { return false; } };
export const adsLeftToday = () => Math.max(0, ADS_PER_DAY - points.adsToday());

/** Показать ролик; true — досмотрен и ⭐ начислены. */
export function watchAd() {
  return new Promise((resolve) => {
    if (!adsAvailable() || adsLeftToday() <= 0) { resolve(false); return; }
    window.__adDone = (ok) => { window.__adDone = null; resolve(ok ? points.adReward() > 0 : false); };
    try { window.TailsAds.show(); } catch (e) { window.__adDone = null; resolve(false); }
  });
}

/** Кнопка «📺 +10 ⭐» в элементе host; onGot — перерисовать баланс. Ролик ещё не загрузился — кнопка ждёт. */
export function adButton(host, onGot, toast) {
  if (!adsAvailable()) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ad-btn';
  const draw = () => {
    const left = adsLeftToday();
    b.disabled = left <= 0 || !adReady();
    b.textContent = left <= 0 ? '📺 На сегодня всё' : adReady() ? `📺 Реклама: +${AD_PTS} ⭐ (${left})` : '📺 Реклама загружается…';
  };
  b.onclick = async () => {
    b.disabled = true;
    const ok = await watchAd();
    toast(ok ? `📺 +${AD_PTS} ⭐ за рекламу!` : 'Ролик не досмотрен — звёзды не начислены');
    onGot();
    draw();
  };
  host.appendChild(b);
  draw();
  setInterval(draw, 2000);
}
