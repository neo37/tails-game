/**
 * Мастерская корабля: форма, раскраска, крылья, след и эмблема. Форма и цвет кольца — бесплатно,
 * остальное — ачивки за ⭐ баллы (src/points.js). Надетое сохраняется в профиле и видно другим в гонке.
 */
import * as THREE from 'three';
import { me, saveMe, SHIP_IDS } from './net.js';
import { SHIPS, shipIcon, makeShip } from './ships.js';
import { SHOP, SLOTS, points, itemById } from './points.js';
import { adButton } from './ads.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const profile = me();
const kit = { ...profile.kit };
function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ── сцена: корабль крутится и покачивается ── */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: qs.has('debug') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
camera.position.set(0, 4.2, 10.5);
camera.lookAt(0, 0.4, 0);
scene.add(new THREE.HemisphereLight(0xdff4ff, 0x30204a, 2));
const sun = new THREE.DirectionalLight(0xfff4d8, 2.4);
sun.position.set(4, 8, 6);
scene.add(sun);
let ship = null;
function draw() {
  if (ship) scene.remove(ship);
  ship = makeShip(profile.ship, profile.color, 0xffffff, kit);
  scene.add(ship);
}

/* ── витрина ── */
const NAMES = { paint: '🎨 Раскраска', wings: '🪽 Крылья', trail: '🔥 След двигателя', emblem: '🏷️ Эмблема', badge: '🏅 Значок рядом с именем' };
function render() {
  $('bal').textContent = `⭐ ${points.balance()}`;
  const bal = points.balance();
  let html = `<h3>🚀 Форма</h3><div class="items" data-slot="ship">${SHIP_IDS.map((id) => `<button type="button" data-id="${id}" class="${profile.ship === id ? 'on' : ''}">${shipIcon(id, profile.color)}<span>${SHIPS[id].name}</span></button>`).join('')}</div>`;
  for (const slot of SLOTS) {
    html += `<h3>${NAMES[slot]}</h3><div class="items" data-slot="${slot}"><button type="button" data-id="" class="${kit[slot] ? '' : 'on'}"><b>✖</b><span>Без</span></button>`;
    for (const it of SHOP.filter((x) => x.kind === slot)) {
      const own = points.owns(it.id);
      html += `<button type="button" data-id="${it.id}" class="${kit[slot] === it.id ? 'on' : ''}${own ? '' : ' locked'}${!own && bal < it.price ? ' cant' : ''}" title="${it.name}">
        <b>${it.icon}</b><span>${it.name}</span>${own ? '' : `<span class="price">🔒 ⭐${it.price}</span>`}</button>`;
    }
    html += '</div>';
  }
  $('shop').innerHTML = html;
}
$('shop').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  const slot = b.parentElement.dataset.slot, id = b.dataset.id;
  if (slot === 'ship') { profile.ship = id; $('stage-hint').textContent = `Форма: ${SHIPS[id].name}`; }
  else if (!id) delete kit[slot];
  else if (points.owns(id)) kit[slot] = id;
  else {
    const it = itemById(id);
    if (points.balance() < it.price) { toast(`Нужно ⭐${it.price}, а у тебя ⭐${points.balance()}. Заработай в «🏆 Редакторе с заданиями»!`, 3200); return; }
    if (!confirm(`Купить «${it.name}» за ⭐${it.price}?`)) return;
    points.buy(id);
    kit[slot] = id;
    toast(`🎉 Новая ачивка: ${it.icon} ${it.name}!`, 2500);
  }
  profile.kit = { ...kit };
  saveMe(profile);
  render();
  draw();
});

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  const dt = Math.min(clock.getDelta(), 0.1);
  if (ship) { ship.rotation.y += dt * 0.6; ship.position.y = Math.sin(performance.now() / 700) * 0.15; ship.userData.tick?.(dt); }
  renderer.render(scene, camera);
}
render();
draw();
tick();
adButton(document.querySelector('.wallet'), render, toast);
if (qs.has('debug')) window.__ship = { profile, kit, points, render, get ship() { return ship; } };
