/**
 * Конструктор трасс: летаешь над полем и ставишь блоки — поток от старта до финиша станет тоннелем (race-design.js).
 * Пальцы: слева джойстик, справа поворот камеры, короткое нажатие ставит блок туда, куда нажал.
 * Мышь: левая кнопка — поставить, правая — убрать, потянуть — поворот; WASD, пробел и Shift — полёт, цифры и колесо — выбор блока.
 */
import * as THREE from 'three';
import { Joystick } from './runner.js';
import { instantPress } from './touch-camera.js';
import { apiBase } from './net.js';
import { points, TASKS, MINUTES_PER_DAY } from './points.js';
import { adButton } from './ads.js';
import { W, H, CELL, MAX_BLOCKS, BLOCKS, T, DIFFS, keyOf, xyzOf, inField, newDesign, encode, decode, analyze, autoComplete, autoFork, trackName, myRaces } from './race-design.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ── «Редактор с заданиями» (?quest=1): за задания и минуты стройки — ⭐ баллы на ачивки корабля. Реклама — позже. ── */
const QUEST = qs.has('quest');
let builtThisMinute = false;
function drawQuest() {
  if (!QUEST) return;
  const done = TASKS.filter((t) => points.isDone(t.id)).length;
  $('quest-bal').textContent = `⭐${points.balance()}`;
  $('quest-n').textContent = `· ${done}/${TASKS.length}`;
  $('quest-list').innerHTML = TASKS.map((t) => `<div class="t${points.isDone(t.id) ? ' done' : ''}"><span>${points.isDone(t.id) ? '✅' : t.icon}</span><span>${t.name}</span><span class="p">+${t.pts}</span></div>`).join('')
    + `<div class="t"><span>⏱️</span><span>Минута стройки: сегодня ${points.minutesToday()}/${MINUTES_PER_DAY}</span><span class="p">+1</span></div>`
    + '<a class="shop" href="ship.html">🛠 Мастерская корабля</a>';
}
function questCheck() {
  if (!QUEST || borrowed) return;       // за чужую трассу или пример баллы не даём — только за свою
  for (const [t, got] of points.checkDesign(design)) if (got) toast(`${t.icon} Задание выполнено: +${got} ⭐`, 2200);
  drawQuest();
}
if (QUEST) {
  $('quest').hidden = false;
  adButton($('quest'), () => drawQuest(), (t) => toast(t, 2000));
  setTimeout(() => { if (borrowed) toast('🏆 Задания засчитываются только на своей трассе — начни новую: 🏠 → «＋ Новая»', 4000); }, 600);
  $('quest-head').onclick = () => $('quest').classList.toggle('open');
  setInterval(() => {
    if (!builtThisMinute || document.hidden) return;
    builtThisMinute = false;
    if (points.minute()) { toast('⏱️ +1 ⭐ за минуту стройки', 1400); drawQuest(); }
  }, 60000);
}

/* ── что открываем ── */
let design = null, saveId = null;
if (qs.get('edit')) { const it = myRaces.get(qs.get('edit')); if (it) { design = decode(it.code); saveId = it.id; } }
if (!design && qs.get('code')) design = decode(qs.get('code'));   // чужая трасса или пример: правится копия, оригинал не меняется
if (!design) {
  design = newDesign();
  design.blocks.set(keyOf(16, 0, 4), T.start);     // в старом поле 32×32: короткая трасса читается и версией 1.7
}
const blocks = design.blocks;
const borrowed = !!qs.get('code') && !qs.get('edit') || !!(saveId && myRaces.get(saveId)?.copy);

/* ── пиксельные текстуры блоков: своя космическая палитра ── */
function pixelCanvas(paint) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  let a = 12345;
  const noise = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
  const shade = (col, k) => { const n = parseInt(col.slice(1), 16), f = (v) => Math.max(0, Math.min(255, Math.round(v * k))); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; };
  const base = (col, edge) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const border = x === 0 || y === 0 || x === 15 || y === 15;
      px(x, y, border ? edge : shade(col, 0.88 + noise() * 0.24));
    }
  };
  paint({ g, px, base, shade, noise });
  return c;
}
const PAINT = {
  path({ base, px }) { base('#2f6fb4', '#173a66'); for (let i = 3; i < 13; i += 3) { px(i, 7, '#7fe0ff'); px(i, 8, '#7fe0ff'); } },
  start({ base, g }) { base('#2fa85c', '#135c2f'); g.fillStyle = '#d8ffe0'; g.fillRect(6, 4, 2, 8); for (let i = 0; i < 4; i++) g.fillRect(8 + i, 5 + i, 1, 7 - i * 2 > 0 ? 7 - i * 2 : 1); },
  finish({ g, px }) { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? '#f4f4ff' : '#17182e'); g.strokeStyle = '#ffd447'; g.strokeRect(0.5, 0.5, 15, 15); },
  gate({ base, g }) { base('#b83254', '#6e1630'); g.strokeStyle = '#8dffb0'; g.lineWidth = 2; g.strokeRect(4, 4, 8, 8); },
  half({ base, g }) { base('#c96a22', '#713606'); g.fillStyle = '#ffd9a8'; for (let y = 3; y < 15; y += 4) g.fillRect(0, y, 16, 1); g.fillRect(5, 3, 1, 4); g.fillRect(11, 7, 1, 4); },
  bar({ base, g }) { base('#3b3d58', '#1e1f33'); g.fillStyle = '#ffc23c'; g.fillRect(1, 6, 14, 4); g.fillStyle = '#b86a00'; g.fillRect(7, 5, 2, 6); },
  rocks({ base, px, noise }) { base('#7a6e62', '#453d35'); for (let i = 0; i < 26; i++) px(1 + Math.floor(noise() * 14), 1 + Math.floor(noise() * 14), noise() < 0.5 ? '#a89a8c' : '#544a40'); },
  boost({ base, g }) { base('#7a5a00', '#4a3600'); g.fillStyle = '#ffe14a'; for (const [x, y, w] of [[8, 2, 3], [7, 4, 3], [6, 6, 4], [5, 8, 6], [7, 10, 2], [6, 12, 2]]) g.fillRect(x, y, w, 2); },
  fork({ base, g }) { base('#6a3dc4', '#371c78'); g.fillStyle = '#eadcff'; g.fillRect(3, 7, 5, 2); g.fillRect(7, 3, 2, 10); g.fillRect(7, 3, 6, 2); g.fillRect(7, 11, 6, 2); },
};
const CANVAS = BLOCKS.map((b) => pixelCanvas(PAINT[b.id]));

/* ── сцена ── */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: qs.has('debug') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07081f);
const camera = new THREE.PerspectiveCamera(66, 1, 1, 4000);
camera.rotation.order = 'YXZ';
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x3a2f5a, 2.1));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.5);
sun.position.set(0.5, 1, 0.3);
scene.add(sun);
{
  const n = 1800, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * 6.283, r = Math.sqrt(1 - u * u);
    p.set([r * Math.cos(a) * 1800, u * 1800, r * Math.sin(a) * 1800], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 2, sizeAttenuation: false, depthWrite: false }));
  stars.position.set((W * CELL) / 2, 0, (W * CELL) / 2);
  scene.add(stars);
}
/* пол: плиты космической станции, на него ставят первый блок */
{
  const c = pixelCanvas(({ base, px }) => { base('#1a2146', '#2e3a78'); px(1, 1, '#5e6ec0'); px(14, 1, '#5e6ec0'); px(1, 14, '#5e6ec0'); px(14, 14, '#5e6ec0'); });
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(W, W);
  tex.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * CELL, W * CELL), new THREE.MeshBasicMaterial({ map: tex }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(((W - 1) * CELL) / 2, -CELL / 2 - 0.1, ((W - 1) * CELL) / 2);
  scene.add(floor);
}
/* блоки: по слою на каждый вид */
const boxGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
const layers = BLOCKS.map((_, i) => {
  const tex = new THREE.CanvasTexture(CANVAS[i]);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ map: tex }), MAX_BLOCKS);
  m.count = 0;
  m.frustumCulled = false;
  m.setColorAt(0, new THREE.Color(1, 1, 1));
  scene.add(m);
  return m;
});
const routeLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xfff27a, depthTest: false, transparent: true, opacity: 0.85 }));
routeLine.renderOrder = 5;
scene.add(routeLine);
const cursor = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(CELL + 0.6, CELL + 0.6, CELL + 0.6)), new THREE.LineBasicMaterial({ color: 0xffffff }));
cursor.visible = false;
scene.add(cursor);

/* ── инструменты: последний слот убирает ── */
const ERASE = BLOCKS.length;
const TIPS = ['Дорога: нажми на блок или на пол рядом', 'Старт: нажми на блок дороги', 'Финиш: нажми на блок дороги',
  'Ворота: нажми на блок дороги — он станет воротами', 'Стена: нажми на блок дороги — он станет стеной', 'Вертушка: нажми на блок дороги — она встанет в нём',
  'Камни: нажми на блок дороги — он станет камнями', 'Ускоритель: нажми на блок дороги — он станет ускорителем',
  'Развилка: поставь там, где ветки расходятся, и там, где сходятся', 'Убрать: нажми на блок'];
let tool = T.path;
function setTool(i) {
  tool = i;
  [...$('hotbar').children].forEach((b, n) => b.classList.toggle('on', n === i));
  $('tip').textContent = TIPS[i];
}
BLOCKS.forEach((b, i) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = b.name;
  btn.setAttribute('aria-label', b.name);
  btn.style.backgroundImage = `url(${CANVAS[i].toDataURL()})`;
  btn.onclick = () => setTool(i);
  $('hotbar').appendChild(btn);
});
{
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '🧹';
  btn.title = 'Убрать';
  btn.setAttribute('aria-label', 'Убрать');
  btn.onclick = () => setTool(ERASE);
  $('hotbar').appendChild(btn);
}
instantPress($('hotbar'));
instantPress($('top'));

/* ── правка блоков ── */
const undoStack = [];
let analysis = null;
const mat = new THREE.Matrix4(), DIM = new THREE.Color(0.42, 0.42, 0.5), LIT = new THREE.Color(1, 1, 1);
function refresh(changed = true) {
  analysis = analyze(design);
  const n = BLOCKS.map(() => 0);
  for (const [k, t] of blocks) {
    const [x, y, z] = xyzOf(k), m = layers[t];
    mat.makeTranslation(x * CELL, y * CELL, z * CELL);
    m.setMatrixAt(n[t], mat);
    m.setColorAt(n[t], !analysis.routes.length || analysis.used.has(k) ? LIT : DIM);   // тупики тусклые: в трассу не войдут
    n[t]++;
  }
  layers.forEach((m, i) => { m.count = n[i]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  const seg = [], seen = new Set();
  for (const r of analysis.routes) for (let i = 1; i < r.chain.length; i++) {
    const id = `${r.chain[i - 1]}:${r.chain[i]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    seg.push(...xyzOf(r.chain[i - 1]).map((v) => v * CELL), ...xyzOf(r.chain[i]).map((v) => v * CELL));
  }
  routeLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  const st = $('status');
  st.classList.toggle('bad', !analysis.ok);
  if (analysis.ok) st.textContent = `✅ Готова: ${analysis.length} м${analysis.routes.length > 1 ? `, путей ${analysis.routes.length}` : ''}`;
  else st.textContent = analysis.errors[0];
  fixOps = analysis.ok ? null : autoComplete(design);
  forkOps = analysis.ok ? null : autoFork(design);
  $('btn-fix').hidden = !fixOps;
  $('btn-fixfork').hidden = !forkOps;
  $('btn-name').textContent = trackName(design);
  $('btn-diff').textContent = DIFFS[design.d].name;
  if (changed) { published = false; builtThisMinute = true; if (saveTimer === null) saveTimer = setTimeout(save, 300); questCheck(); }
}
let saveTimer = null, published = false, fixOps = null, forkOps = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!blocks.size) return;
  saveId = myRaces.save(saveId, design, borrowed).id;
}
addEventListener('pagehide', () => { if (saveTimer !== null) save(); });

function setBlock(k, t, ops) {
  const had = blocks.has(k) ? blocks.get(k) : -1;
  if (had === t) return;
  ops.push([k, had]);
  if (t < 0) blocks.delete(k); else blocks.set(k, t);
}
function apply(hit, erase = false) {
  if (!hit) return;
  const ops = [];
  if (erase || tool === ERASE) {
    if (hit.block === null) return;
    setBlock(hit.block, -1, ops);
  } else {
    let k = hit.block;
    const replacing = tool !== T.path && k !== null;   // преграда, старт и финиш встают вместо блока, дорога — рядом с ним
    // преграда — это кусок тоннеля: сверху на блок её не ставят, а старт, финиш и развилку она бы сломала
    if (replacing && BLOCKS[tool].kind && [T.start, T.finish, T.fork].includes(blocks.get(k))) {
      toast(`${BLOCKS[tool].icon} Ставь на синий блок дороги: ${BLOCKS[blocks.get(k)].name.toLowerCase()} заменять нельзя`, 2600);
      return;
    }
    if (!replacing) {
      if (!hit.next || !inField(...hit.next)) { toast('Здесь край поля'); return; }
      k = keyOf(...hit.next);
      if (blocks.has(k)) return;
      if (blocks.size >= MAX_BLOCKS) { toast(`Больше ${MAX_BLOCKS} блоков нельзя`); return; }
    }
    if (tool === T.start || tool === T.finish) for (const [q, t] of blocks) if (t === tool && q !== k) setBlock(q, T.path, ops);   // старый становится дорогой
    setBlock(k, tool, ops);
  }
  if (!ops.length) return;
  undoStack.push(ops);
  if (undoStack.length > 300) undoStack.shift();
  refresh();
  const b = BLOCKS[tool];
  if (b && b.kind && ops.length === 1 && ops[0][1] >= 0) toast(`${b.icon} Здесь теперь ${b.name.toLowerCase()}`, 1200);
}
function undo() {
  const ops = undoStack.pop();
  if (!ops) return;
  for (const [k, was] of ops.reverse()) { if (was < 0) blocks.delete(k); else blocks.set(k, was); }
  refresh();
}
$('btn-undo').onclick = undo;
$('btn-save').onclick = () => {
  if (!blocks.size) { toast('Пока нечего сохранять'); return; }
  save();
  toast('💾 Сохранено в «Мои трассы»');
};
function build(list, what) {
  if (!list) return;
  if (blocks.size + list.length > MAX_BLOCKS) { toast(`Больше ${MAX_BLOCKS} блоков нельзя`); return; }
  const ops = [];
  for (const [k, t] of list) setBlock(k, t, ops);
  undoStack.push(ops);
  refresh();
  toast(`${what} ${ops.length} ${ops.length < 5 ? 'блока' : 'блоков'}. Не нравится — нажми ↩️`, 2600);
}
$('btn-fix').onclick = () => build(fixOps, '🪄 Достроил');
$('btn-fixfork').onclick = () => build(forkOps, '🔀 Достроил с развилкой:');
$('btn-name').onclick = () => { design.a = Math.floor(Math.random() * 16); design.b = Math.floor(Math.random() * 16); refresh(); };
$('btn-diff').onclick = () => { const ids = Object.keys(DIFFS); design.d = ids[(ids.indexOf(design.d) + 1) % ids.length]; refresh(); };
$('btn-fly').onclick = () => {
  if (!analysis.ok) { toast(analysis.errors[0]); return; }
  save();
  location.href = `race.html?code=${encodeURIComponent(encode(design))}&edit=${encodeURIComponent(saveId)}${QUEST ? '&quest=1' : ''}${qs.has('debug') ? '&debug' : ''}`;
};
$('btn-team').onclick = () => {
  if (!analysis.ok) { toast(analysis.errors[0]); return; }
  save();
  location.href = `lobby.html?map=track&code=${encodeURIComponent(encode(design))}${qs.has('debug') ? '&debug' : ''}`;
};
$('btn-pub').onclick = async () => {
  if (!analysis.ok) { toast(analysis.errors[0]); return; }
  if (published) { toast('Эта трасса уже у всех'); return; }
  const b = $('btn-pub');
  b.disabled = true;
  try {
    const r = await fetch(`${apiBase()}api/tracks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: encode(design) });
    const j = await r.json();
    if (r.ok) {
      published = true;
      const got = QUEST ? points.complete('share') : 0;
      toast(got ? `🌍 Трассу видят все! Задание: +${got} ⭐` : '🌍 Теперь эту трассу видят все игроки!', 3000);
      drawQuest();
    }
    else toast(j.error || 'Не получилось');
  } catch (e) { toast('Нет связи с сервером'); }
  b.disabled = false;
};

/* ── луч из точки экрана в поле блоков ── */
const ndc = new THREE.Vector2(), ray = new THREE.Raycaster();
function pickAt(cx, cy) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  const g = [o.x / CELL + 0.5, o.y / CELL + 0.5, o.z / CELL + 0.5];
  let c = g.map(Math.floor);
  const stepV = [Math.sign(d.x), Math.sign(d.y), Math.sign(d.z)];
  const dv = [d.x, d.y, d.z];
  const tMax = [0, 1, 2].map((i) => (dv[i] === 0 ? Infinity : ((stepV[i] > 0 ? c[i] + 1 : c[i]) - g[i]) / dv[i]));
  const tDelta = [0, 1, 2].map((i) => (dv[i] === 0 ? Infinity : Math.abs(1 / dv[i])));
  let prev = null;
  for (let n = 0; n < 200; n++) {
    if (c[1] < 0) {                       // пол
      if (c[0] >= 0 && c[0] < W && c[2] >= 0 && c[2] < W) return { block: null, next: [c[0], 0, c[2]] };
      if (stepV[1] <= 0) return null;
    }
    if (inField(...c) && blocks.has(keyOf(...c))) return { block: keyOf(...c), next: prev };
    prev = c.slice();
    const i = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    c[i] += stepV[i];
    tMax[i] += tDelta[i];
  }
  return null;
}

/* ── камера и полёт ── */
let yaw = Math.PI, pitch = -0.8;       // поле впереди и внизу
{
  // вся трасса в кадре: отступаем назад и вверх по её размеру
  const ks = [...blocks.keys()].map(xyzOf);
  const span = (i) => [Math.min(...ks.map((q) => q[i])), Math.max(...ks.map((q) => q[i]))];
  const [x0, x1] = span(0), [z0, z1] = span(2), [, y1] = span(1);
  const size = Math.max(x1 - x0, z1 - z0, 8);
  camera.position.set(((x0 + x1) / 2) * CELL, (y1 + 3 + size * 0.62) * CELL, (z0 - 2 - size * 0.75) * CELL);
}
const joy = new Joystick($('joy'));
const onTap = (x, y) => apply(pickAt(x, y));
joy.floatIn(canvas, (x) => x < innerWidth * 0.3, onTap);
const fingers = new Map();
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now(), moved: false, btn: e.button, type: e.pointerType });
});
canvas.addEventListener('pointermove', (e) => {
  const f = fingers.get(e.pointerId);
  if (!f) {
    if (e.pointerType === 'mouse') { const h = pickAt(e.clientX, e.clientY); hover(h); }
    return;
  }
  if (Math.hypot(e.clientX - f.x0, e.clientY - f.y0) > (f.type === 'mouse' ? 6 : 14)) f.moved = true;
  if (f.moved) {
    const k = (f.type === 'mouse' ? 0.005 : 0.0065);
    yaw -= (e.clientX - f.x) * k;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - (e.clientY - f.y) * k));
  }
  f.x = e.clientX; f.y = e.clientY;
});
const lift = (e) => {
  const f = fingers.get(e.pointerId);
  if (!f) return;
  fingers.delete(e.pointerId);
  if (e.type !== 'pointerup' || f.moved) return;
  if (f.type === 'mouse') apply(pickAt(e.clientX, e.clientY), f.btn === 2);
  else if (performance.now() - f.t < 500) onTap(e.clientX, e.clientY);
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);
function hover(h) {
  cursor.visible = !!h;
  if (!h) return;
  const replacing = h.block !== null && (tool !== T.path);
  const c = replacing ? xyzOf(h.block) : h.next;
  if (!c) { cursor.visible = false; return; }
  cursor.position.set(c[0] * CELL, c[1] * CELL, c[2] * CELL);
}

const keys = new Set();
let climb = 0;
addEventListener('keydown', (e) => {
  if (/^(KeyW|KeyA|KeyS|KeyD|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|ShiftLeft|ShiftRight)$/.test(e.code)) { keys.add(e.code); e.preventDefault(); }
  if (/^Digit[1-9]$/.test(e.code)) setTool(Number(e.code[5]) - 1);
  if (e.code === 'Digit0') setTool(ERASE);
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('wheel', (e) => setTool((tool + (e.deltaY > 0 ? 1 : -1) + ERASE + 1) % (ERASE + 1)), { passive: true });
for (const [id, d] of [['btn-up', 1], ['btn-down', -1]]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); climb = d; el.classList.add('on'); });
  for (const n of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(n, () => { if (climb === d) climb = 0; el.classList.remove('on'); });
}

const SPEED = 150;
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  let mxv = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  let mzv = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  if (joy.active) { mxv = joy.x; mzv = joy.y; }
  const mv = climb + (keys.has('Space') ? 1 : 0) - (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  camera.position.x += (-sy * mzv + cy * mxv) * SPEED * dt;
  camera.position.z += (-cy * mzv - sy * mxv) * SPEED * dt;
  camera.position.y += mv * SPEED * dt;
  const pad = CELL * 6;
  camera.position.x = Math.max(-pad, Math.min(W * CELL + pad, camera.position.x));
  camera.position.z = Math.max(-pad, Math.min(W * CELL + pad, camera.position.z));
  camera.position.y = Math.max(0, Math.min((H + 8) * CELL, camera.position.y));
  camera.rotation.set(pitch, yaw, 0);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
}
refresh(false);
drawQuest();
setTool(T.path);
tick();
if (qs.has('debug')) window.__ed = { design, blocks, camera, pickAt, setTool, undo, T, xyzOf, keyOf, get analysis() { return analysis; }, get saveId() { return saveId; }, points, look(y, p) { yaw = y; pitch = p; },
  put(k, t) { if (t < 0) blocks.delete(k); else blocks.set(k, t); refresh(); } };
