/**
 * Редактор уровней: персонаж бегает по клеткам поля и ставит/убирает дорогу, плиты, старт, домик.
 * Уровень сразу проверяется (есть ли дорога от старта до домика — A* по клеткам дороги)
 * и сохраняется в «Мои уровни» (localStorage) или отдаётся кодом.
 */
import { isNick } from './nick.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { touchCamera } from './touch-camera.js';
import { EW, EH, DIFFS, THEMES, GHOSTS, PICK_FRIENDS, DEFAULT_FRIENDS, analyze, encode, decode, sampleDesign, emptyCells, myLevels, isMine, authorId, authorName, copyDesign } from './custom.js';
import { Grid } from './grid.js';
import { Runner, Joystick, loadRunnerModel } from './runner.js';
import { me } from './net.js';
import { FRIENDS } from './sim.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const grid = new Grid(EW, EH);
/** Телефон и планшет: поле целиком, один палец рисует, два — камера, настройки в выезжающей панели. */
const TOUCH = matchMedia('(pointer: coarse)').matches || qs.has('touch');
if (TOUCH) { document.body.classList.add('ed-touch'); document.body.classList.remove('runner-on'); }

/* ── уровень в работе (черновик переживает перезагрузку) ── */
let design = null;
try { design = JSON.parse(localStorage.getItem('tg.editor.draft') || 'null'); } catch (e) { /* */ }
if (qs.get('code')) { const d = decode(qs.get('code')); if (d) design = { ...d, author: d.author || 'unknown' }; }
if (qs.get('edit')) {                  // открыли из меню «Мои уровни»
  const it = myLevels.get(qs.get('edit'));
  const d = it && decode(it.code);
  if (d) design = { ...d, id: it.id };
}
if (qs.get('new')) design = { ...sampleDesign(), cells: emptyCells(), name: 'Новый уровень' };
if (!design || !design.cells || design.cells.length !== EW * EH) design = sampleDesign();
let cells = design.cells.split('');
let picked = design.friends && design.friends.length ? design.friends.slice() : (THEMES[design.theme] || THEMES.quay).friends.slice();
let ghostMode = GHOSTS[design.ghosts] ? design.ghosts : 'few';

/* ── сцена ── */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: qs.has('debug') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd2e6);
const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.45;
controls.minDistance = 20;
controls.maxDistance = 140;
const touchCam = touchCamera(canvas, camera, controls, { left: $('spin-left'), right: $('spin-right') });
camera.position.set(0, 70, 66);
if (TOUCH) controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN };
/** Камера почти сверху, ровно на такой высоте, чтобы всё поле поместилось в холст. */
function fitView() {
  const c = canvas.clientWidth / canvas.clientHeight;
  camera.aspect = c;
  camera.updateProjectionMatrix();
  const hx = (EW * 6) / 2 + 3, hz = (EH * 6) / 2 + 3, tilt = 0.32, v = new THREE.Vector3();
  const fits = (d) => {
    camera.position.set(0, d * Math.cos(tilt), d * Math.sin(tilt));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      v.set(sx * hx, 0, sz * hz).project(camera);
      if (Math.abs(v.x) > 0.98 || Math.abs(v.y) > 0.98) return false;
    }
    return true;
  };
  let lo = 20, hi = 600;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  fits(hi);
  controls.target.set(0, 0, 0);
  controls.maxDistance = hi * 1.3;
}
scene.add(new THREE.HemisphereLight(0xdff4ff, 0x6f8a63, 1.1));
const sun = new THREE.DirectionalLight(0xfff4d8, 2.2);
sun.position.set(20, 40, 16);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 120 });
scene.add(sun);
const sea = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardMaterial({ color: 0x1d7aa0, roughness: 0.4 }));
sea.rotation.x = -Math.PI / 2; sea.position.y = -0.6;
scene.add(sea);
const land = new THREE.Mesh(new THREE.BoxGeometry(EW * 6 + 8, 0.6, EH * 6 + 8), new THREE.MeshStandardMaterial({ color: 0x8fae6f, roughness: 1 }));
land.position.y = -0.3; land.receiveShadow = true;
scene.add(land);

const M = {
  grass: new THREE.MeshStandardMaterial({ color: 0x9cbb7c, roughness: 1 }),
  road: new THREE.MeshStandardMaterial({ color: 0xe3d7c0, roughness: 0.95 }),
  spot: new THREE.MeshStandardMaterial({ color: 0xf3e6c8, roughness: 0.9, emissive: 0x2a2410, emissiveIntensity: 0.4 }),
  ring: new THREE.MeshBasicMaterial({ color: 0xffd447 }),
  gate: new THREE.MeshStandardMaterial({ color: 0x3a3550, roughness: 0.7 }),
  walls: new THREE.MeshStandardMaterial({ color: 0xf6efe2, roughness: 0.9 }),
  roof: new THREE.MeshStandardMaterial({ color: 0xd9663f, roughness: 0.8 }),
  ghost: new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, emissive: 0xbfd8ff, emissiveIntensity: 0.5 }),
  eye: new THREE.MeshBasicMaterial({ color: 0x20304a }),
  stone: new THREE.MeshStandardMaterial({ color: 0xa3a6ad, roughness: 0.95 }),
  flag: new THREE.MeshStandardMaterial({ color: 0xc2453d, roughness: 0.8 }),
};
const G = {
  tile: new THREE.BoxGeometry(5.8, 0.2, 5.8), road: new THREE.BoxGeometry(6, 0.4, 6),
  spot: new THREE.CylinderGeometry(2.6, 2.8, 0.5, 22), ring: new THREE.TorusGeometry(2.4, 0.14, 8, 28),
  ghost: new THREE.SphereGeometry(1.1, 16, 12), eye: new THREE.SphereGeometry(0.17, 8, 6),
  mini: new THREE.CylinderGeometry(0.9, 1.1, 2.4, 8), miniRoof: new THREE.ConeGeometry(1.25, 1.2, 8),
  gate: new THREE.TorusGeometry(2.6, 0.45, 10, 24, Math.PI), walls: new THREE.BoxGeometry(5, 4, 5), roof: new THREE.ConeGeometry(4.6, 2.8, 4),
};
const tiles = [];      // трава-подложка (по ней кликают)
const things = [];     // что стоит на клетке
for (let k = 0; k < EW * EH; k++) {
  const [x, z] = grid.center(k);
  const t = new THREE.Mesh(G.tile, M.grass);
  t.position.set(x, 0.05, z);
  t.receiveShadow = true;
  t.userData.k = k;
  scene.add(t);
  tiles.push(t);
  things.push(null);
}
function makeThing(ch) {
  const g = new THREE.Group();
  if (ch === '#' || ch === 'S' || ch === 'H') { const r = new THREE.Mesh(G.road, M.road); r.position.y = 0.2; r.receiveShadow = true; g.add(r); }
  if (ch === 'o') {
    const s = new THREE.Mesh(G.spot, M.spot); s.position.y = 0.3; g.add(s);
    const r = new THREE.Mesh(G.ring, M.ring); r.rotation.x = -Math.PI / 2; r.position.y = 0.6; g.add(r);
    if (picked.includes('castle')) {       // на этой плите можно будет построить замок
      const t = new THREE.Mesh(G.mini, M.stone); t.position.y = 1.7; t.castShadow = true;
      const c = new THREE.Mesh(G.miniRoof, M.flag); c.position.y = 3.5; c.castShadow = true;
      g.add(t, c);
    }
  }
  if (ch === 'S') {
    const gt = new THREE.Mesh(G.gate, M.gate); gt.position.y = 0.4; gt.castShadow = true; g.add(gt);
    if (ghostMode !== 'none') {            // отсюда выйдут привидения
      const b = new THREE.Mesh(G.ghost, M.ghost); b.position.y = 2.1; b.scale.y = 1.25;
      const e1 = new THREE.Mesh(G.eye, M.eye), e2 = new THREE.Mesh(G.eye, M.eye);
      e1.position.set(-0.36, 2.4, 1); e2.position.set(0.36, 2.4, 1);
      g.add(b, e1, e2);
    }
  }
  if (ch === 'H') {
    const w = new THREE.Mesh(G.walls, M.walls); w.position.y = 2.4;
    const r = new THREE.Mesh(G.roof, M.roof); r.position.y = 5.8; r.rotation.y = Math.PI / 4;
    w.castShadow = r.castShadow = true;
    g.add(w, r);
  }
  return g;
}
function redrawCell(k) {
  if (things[k]) scene.remove(things[k]);
  things[k] = null;
  if (cells[k] === '.') return;
  const t = makeThing(cells[k]);
  const [x, z] = grid.center(k);
  t.position.set(x, 0, z);
  scene.add(t);
  things[k] = t;
}
for (let k = 0; k < EW * EH; k++) redrawCell(k);

// маршрут от старта до домика — розовые точки
const dots = new THREE.Group();
scene.add(dots);
const dotGeo = new THREE.SphereGeometry(0.5, 8, 6), dotMat = new THREE.MeshBasicMaterial({ color: 0xff6f91 });
// клетка под персонажем
const cursor = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.0, 4, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
cursor.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
cursor.position.y = 0.7;
scene.add(cursor);

/* ── инструменты ── */
let tool = 'road';
const TOOLS = { road: '#', spot: 'o', spawn: 'S', house: 'H', erase: '.' };
const NAMES = { '#': 'дорога', o: 'плита', S: 'старт', H: 'домик' };
$('tools').onclick = (e) => { const b = e.target.closest('button'); if (b && b.dataset.tool) setTool(b.dataset.tool); };
function setTool(t) {
  tool = t;
  for (const b of $('tools').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tool === t);
}

/* шаг назад: снимки клеток перед каждым нажатием или мазком */
const undo = [];
function snap() {
  const s = cells.join('');
  if (undo[undo.length - 1] !== s) undo.push(s);
  if (undo.length > 100) undo.shift();
  $('btn-undo').disabled = false;
}
function restore(s) {
  const was = cells;
  cells = s.split('');
  for (let k = 0; k < cells.length; k++) if (cells[k] !== was[k]) redrawCell(k);
  changed();
}
$('btn-undo').onclick = () => {
  if (readOnly) return;
  if (undo[undo.length - 1] === cells.join('')) undo.pop();
  if (undo.length) restore(undo.pop());
  $('btn-undo').disabled = !undo.length;
};

function apply(k, how = tool) {
  if (k < 0) return;
  if (readOnly) { toast('Это чужой уровень. Нажми «Копировать» и правь свою копию'); return; }
  snap();
  const ch = TOOLS[how];
  if (how === 'house') for (let i = 0; i < cells.length; i++) if (cells[i] === 'H' && i !== k) { cells[i] = '#'; redrawCell(i); }
  if (how === 'spawn' && cells[k] !== 'S') {
    const sp = cells.map((c, i) => (c === 'S' ? i : -1)).filter((i) => i >= 0);
    if (sp.length >= 2) { cells[sp[0]] = '#'; redrawCell(sp[0]); toast('Стартов может быть два — старый стал дорогой'); }
  }
  const was = cells[k];
  cells[k] = was === ch && how !== 'erase' && how !== 'road' ? '.' : ch;     // повторное нажатие — убрать
  redrawCell(k);
  if (runner) runner.build();
  changed();
  if (cells[k] !== was) toast(cells[k] === '.' ? `Убрано: ${NAMES[was] || 'трава'}` : `Поставлено: ${NAMES[cells[k]]}`, 1200);
}

/* ── проверка, сохранение, код ── */
function current() {
  if (readOnly) return design;
  return { ...design, author: design.author || authorId(), authorName: design.authorName || authorName(), name: $('name').value.trim() || 'Мой уровень', cells: cells.join(''), friends: picked.slice(), ghosts: ghostMode,
           target: Math.max(3, Math.min(25, Number($('target').value) || 8)), diff: $('diff').value, theme: $('theme').value };
}
let lastA = null, baseline = null, autoT = 0;
/** Автосохранение: любая правка своего уровня через секунду сама попадает в «Мои уровни»; недоделанный — как черновик. */
function autoSave() {
  if (readOnly || !lastA) return;
  const item = myLevels.save(current());
  design.id = item.id;
  baseline = encode(current());
  try { localStorage.setItem('tg.editor.draft', JSON.stringify(design)); } catch (e) { /* */ }
  renderMine();
  $('btn-save').textContent = lastA.ok ? '✓ Сохранено' : '✓ Черновик';
}
function changed() {
  design = current();
  try { localStorage.setItem('tg.editor.draft', JSON.stringify(design)); } catch (e) { /* */ }
  const a = analyze(design);
  lastA = a;
  const code = encode(design);
  if (baseline === null) baseline = code;          // только что открыли — это ещё не правка
  else if (code !== baseline) {
    $('btn-save').textContent = '💾 Сохранить';
    clearTimeout(autoT);
    if (!readOnly) autoT = setTimeout(autoSave, 1000);
  }
  dots.clear();
  for (const p of a.paths) {
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[i + 1];
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 3));
      for (let j = 0; j < n; j++) {
        const d = new THREE.Mesh(dotGeo, dotMat);
        d.position.set(x0 + ((x1 - x0) * j) / n, 0.9, z0 + ((z1 - z0) * j) / n);
        dots.add(d);
      }
    }
  }
  const st = $('status');
  st.className = a.ok ? 'ok' : 'bad';
  st.innerHTML = a.ok
    ? `✅ Можно играть! Дорожек: ${a.paths.length}, плит: ${a.spots.length}, можно строить: ${picked.map((id) => FRIENDS[id].emoji).join('')}${ghostMode === 'none' ? '' : ' · 👻'}.`
    : a.errors.map((e) => `• ${e}`).join('<br>');
  for (const id of ['btn-play', 'btn-team', 'btn-save', 'r-play']) $(id).disabled = !a.ok;
  $('r-save').disabled = !a.ok && !readOnly;
  $('st-mini').className = a.ok ? 'ok' : '';
  $('st-mini').textContent = a.ok ? `✅ Можно играть! Дорожек: ${a.paths.length}, плит: ${a.spots.length}` : `⚠️ ${a.errors[0]}`;
}

$('diff').innerHTML = Object.entries(DIFFS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
$('theme').innerHTML = Object.entries(THEMES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
$('name').value = design.name || 'Мой уровень';
$('target').value = design.target || 8;
$('diff').value = DIFFS[design.diff] ? design.diff : 'easy';
$('theme').value = THEMES[design.theme] ? design.theme : 'quay';
for (const id of ['name', 'target', 'diff', 'theme']) $(id).addEventListener('change', changed);
$('ghosts').innerHTML = Object.entries(GHOSTS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
$('ghosts').value = ghostMode;
$('ghosts').addEventListener('change', () => { ghostMode = $('ghosts').value; redrawAll(); changed(); });
function drawPick() {
  $('friends').innerHTML = PICK_FRIENDS.map((id) => `<button type="button" data-f="${id}" class="${picked.includes(id) ? 'on' : ''}" title="${FRIENDS[id].name}">${FRIENDS[id].emoji}<b>${FRIENDS[id].name}</b></button>`).join('');
}
$('friends').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.dataset.f;
  if (picked.includes(id) && picked.length === 1) { toast('Нужен хотя бы один защитник'); return; }
  picked = picked.includes(id) ? picked.filter((x) => x !== id) : PICK_FRIENDS.filter((x) => x === id || picked.includes(x));
  drawPick(); redrawAll(); changed();
};
drawPick();
function redrawAll() { for (let k = 0; k < EW * EH; k++) redrawCell(k); }

/** Чужой уровень только для просмотра и игры; менять можно свою копию. */
let readOnly = false;
function setReadOnly() {
  readOnly = !isMine(design);
  $('foreign').hidden = !readOnly;
  if (readOnly) $('foreign').textContent = `🔒 Уровень ${isNick(design.authorName) ? `игрока ${design.authorName}` : 'другого игрока'}. Менять можно только свою копию.`;
  $('btn-copy').hidden = !readOnly;
  $('btn-save').hidden = readOnly;
  for (const id of ['name', 'target', 'diff', 'theme', 'ghosts']) $(id).disabled = readOnly;
  $('friends').classList.toggle('off', readOnly);
  $('r-save').innerHTML = readOnly ? '📄<b>Копировать</b>' : '💾<b>Сохранить</b>';
  $('r-save').disabled = !readOnly && !(lastA && lastA.ok);
}
$('btn-copy').onclick = () => {
  const item = myLevels.copyOf(design);
  load({ ...decode(item.code), id: item.id });
  renderMine();
  toast(`📄 Теперь это твоя копия: ${item.name}`);
};

function save() {
  if (!lastA) return null;
  if (!lastA.ok) {                    // недоделанный уровень тоже не теряется: лежит черновиком
    if (!readOnly) { autoSave(); toast(`💾 Черновик сохранён. Чтобы играть: ${lastA.errors[0]}`, 3000); }
    return null;
  }
  const item = myLevels.save(current());
  design.id = item.id;
  changed();
  baseline = encode(current());
  $('btn-save').textContent = '✓ Сохранено';
  renderMine();
  toast(`💾 Сохранено в «Мои уровни»: ${item.name}`);
  return item;
}
$('btn-save').onclick = save;
$('btn-play').onclick = () => { const it = save(); if (it) location.href = `play.html?my=${it.id}&from=editor${qs.has('debug') ? '&debug' : ''}`; };
$('btn-team').onclick = () => { const it = save(); if (it) location.href = `lobby.html?map=custom&code=${encodeURIComponent(it.code)}${qs.has('debug') ? '&debug' : ''}`; };
$('btn-export').onclick = () => {
  const c = $('code');
  c.hidden = false;
  c.value = encode(current());
  c.select();
  const copied = () => toast('📋 Код скопирован — отправь его другу');
  const manual = () => { try { if (document.execCommand('copy')) { copied(); return; } } catch (e) { /* */ } toast('Код в поле — скопируй его'); };
  if (navigator.clipboard) navigator.clipboard.writeText(c.value).then(copied, manual); else manual();
};
$('btn-import').onclick = () => {
  const c = $('code');
  if (c.hidden || !c.value.trim()) { c.hidden = false; c.value = ''; c.focus(); toast('Вставь код в поле и нажми ещё раз'); return; }
  const d = decode(c.value);
  if (!d) { toast('Код не подходит'); return; }
  // код без автора — старый или чужой: считаем чужим
  if (!d.author) d.author = 'unknown';
  if (!isMine(d)) {
    const it = myLevels.save(d);
    load({ ...d, id: it.id });
    renderMine();
    toast(`📥 Чужой уровень «${d.name}» в твоём списке. Чтобы менять, нажми «Копировать»`, 4000);
    return;
  }
  load(d);
  toast(`📥 Загружен уровень «${d.name}»`);
};
$('btn-new').onclick = () => { load({ ...sampleDesign(), cells: emptyCells(), name: 'Новый уровень' }); toast('Чистое поле — рисуй!'); };

function load(d) {
  baseline = null;
  clearTimeout(autoT);
  design = { ...d };
  delete design.id;
  if (d.id) design.id = d.id;
  cells = d.cells.split('');
  undo.length = 0;
  $('btn-undo').disabled = true;
  picked = d.friends && d.friends.length ? d.friends.slice() : (THEMES[d.theme] || THEMES.quay).friends.slice();
  ghostMode = GHOSTS[d.ghosts] ? d.ghosts : d.theme === 'castle' ? 'many' : 'few';
  $('ghosts').value = ghostMode;
  drawPick();
  redrawAll();
  $('name').value = d.name; $('target').value = d.target; $('diff').value = d.diff; $('theme').value = d.theme;
  setReadOnly();
  changed();
}

/* панель справа на телефоне */
const drawer = (open) => { $('side').classList.toggle('open', open); $('scrim').classList.toggle('open', open); };
$('r-more').onclick = () => drawer(true);
$('side-close').onclick = () => drawer(false);
$('scrim').onclick = () => drawer(false);
$('r-fit').onclick = fitView;
$('r-play').onclick = () => $('btn-play').click();
$('r-save').onclick = () => (readOnly ? $('btn-copy').click() : save());

function renderMine() {
  const list = myLevels.list();
  $('mine').innerHTML = list.length ? list.map((x) => {
    const d = decode(x.code), mine = !d || isMine(d), ready = d && analyze(d).ok;
    return `<div class="it" data-id="${x.id}"><span>${mine ? '' : '🔒 '}${ready ? '' : '✏️ '}${x.name.replace(/[<>&]/g, '')}${ready ? '' : ' <small>(черновик)</small>'}</span>
    ${ready ? '<button data-a="play" title="Играть">▶</button>' : ''}<button data-a="edit" title="${mine ? 'Открыть' : 'Посмотреть'}">${mine ? '✏️' : '👁'}</button>${mine ? '' : '<button data-a="copy" title="Скопировать себе">📄</button>'}<button data-a="del" title="Удалить">🗑</button></div>`;
  }).join('')
    : '<div style="color:#9fc0d0;font-size:14px">Пока пусто. Нарисуй уровень и нажми «Сохранить».</div>';
}
$('mine').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.closest('.it').dataset.id;
  const it = myLevels.get(id);
  if (b.dataset.a === 'play') location.href = `play.html?my=${id}&from=editor`;
  if (b.dataset.a === 'edit' && it) { load({ ...decode(it.code), id }); toast(`Открыт «${it.name}»`); }
  if (b.dataset.a === 'copy' && it) { const c = myLevels.copyOf(decode(it.code)); load({ ...decode(c.code), id: c.id }); renderMine(); toast(`📄 Теперь это твоя копия: ${c.name}`); }
  if (b.dataset.a === 'del') { myLevels.remove(id); renderMine(); }
};
renderMine();
setReadOnly();
me();                                  // ник (src/nick.js) выдаётся при первом запуске — до того, как запомним исходный уровень, иначе он сочтётся правкой
baseline = encode(current());          // исходный уровень запоминаем сразу: правка до загрузки персонажа тоже сохранится

function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ── персонаж и ввод ── */
let runner = null;
const joy = new Joystick($('joy'));
const keys = new Set();
const typing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
const runnerCell = () => (runner ? grid.cellAt(runner.root.position.x, runner.root.position.z) : -1);

addEventListener('keydown', (e) => {
  if (typing()) return;
  if (/^(KeyW|KeyA|KeyS|KeyD|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(e.code)) { keys.add(e.code); e.preventDefault(); return; }
  if (e.code === 'Space') { e.preventDefault(); runner && runner.jump(); }
  if (e.code === 'KeyE' || e.code === 'Enter') apply(runnerCell());
  const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(e.code);
  if (n >= 0) setTool(Object.keys(TOOLS)[n]);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
$('btn-put').onclick = () => apply(runnerCell());
$('btn-jump').onclick = () => runner && runner.jump();

// клик/тап по клетке — тоже ставит (персонаж прибегает туда)
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
const cellUnder = (e) => {
  const r = canvas.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(tiles)[0];
  return hit ? hit.object.userData.k : -1;
};
canvas.addEventListener('pointerup', (e) => {
  if (!touchCam.isTap(e)) return;
  const k = cellUnder(e);
  if (k >= 0) { goTo = k; apply(k); }
});
let goTo = -1;

/* мазок одним пальцем: дорога ложится только на пустые клетки, «Убрать» стирает всё; второй палец — это уже камера */
let stroke = null, dirty = false;
const DRAGGABLE = { road: '.', erase: null };
function paintCell(k) {
  const was = cells[k];
  if (tool === 'road' ? was !== '.' : was === '.') return;
  cells[k] = TOOLS[tool];
  redrawCell(k);
  goTo = k;
  dirty = true;
}
function paintLine(a, b) {        // палец быстрый: клетки между двумя событиями не должны пропадать
  const [ai, aj] = [a % EW, Math.floor(a / EW)], [bi, bj] = [b % EW, Math.floor(b / EW)];
  const n = Math.max(Math.abs(bi - ai), Math.abs(bj - aj));
  let i = ai, j = aj;
  for (let s = 1; s <= n; s++) {
    const ni = Math.round(ai + ((bi - ai) * s) / n), nj = Math.round(aj + ((bj - aj) * s) / n);
    if (ni !== i && nj !== j) paintCell(j * EW + ni);      // без диагоналей: по ним дорога не считается связной
    i = ni; j = nj;
    paintCell(j * EW + i);
  }
}
if (TOUCH) {
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (stroke) {
      if (stroke.painted && performance.now() - stroke.t < 350) restore(stroke.before);   // это начинался щипок, а не мазок
      stroke = null;
      return;
    }
    stroke = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), last: -1, painted: false, before: cells.join('') };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stroke || e.pointerId !== stroke.id || !(tool in DRAGGABLE) || readOnly) return;
    if (!stroke.painted) {
      if (Math.hypot(e.clientX - stroke.x, e.clientY - stroke.y) < 12) return;
      const k0 = cellUnder({ clientX: stroke.x, clientY: stroke.y });
      stroke.painted = true;
      stroke.t = performance.now();
      snap();
      if (k0 >= 0) { paintCell(k0); stroke.last = k0; }
    }
    const k = cellUnder(e);
    if (k < 0 || k === stroke.last) return;
    if (stroke.last >= 0) paintLine(stroke.last, k); else paintCell(k);
    stroke.last = k;
  });
  const endStroke = (e) => { if (stroke && e.pointerId === stroke.id) setTimeout(() => { stroke = null; }, 0); };
  addEventListener('pointerup', endStroke);
  addEventListener('pointercancel', endStroke);
}

const fwd = new THREE.Vector3(), right = new THREE.Vector3(), dir = new THREE.Vector3();
const clock = new THREE.Clock();
const HALF_W = (EW * 6) / 2 + 2, HALF_H = (EH * 6) / 2 + 2;
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (dirty) { dirty = false; changed(); }
  if (runner) {
    let ix = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    let iy = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    let mag = Math.min(1, Math.hypot(ix, iy));
    if (joy.active) { ix = joy.x; iy = joy.y; mag = Math.min(1, Math.hypot(ix, iy)); }
    fwd.copy(controls.target).sub(camera.position).setY(0).normalize();
    right.set(-fwd.z, 0, fwd.x);
    dir.set(0, 0, 0).addScaledVector(fwd, iy).addScaledVector(right, ix);
    if (mag > 0) goTo = -1;
    if (goTo >= 0) {          // бежит к клетке, по которой ткнули
      const [gx, gz] = grid.center(goTo);
      dir.set(gx - runner.root.position.x, 0, gz - runner.root.position.z);
      const l = dir.length();
      mag = l > 0.6 ? Math.min(1, l / 6 + 0.3) : 0;
      if (!mag) goTo = -1;
    }
    if (dir.lengthSq() > 1e-4) dir.normalize();
    runner.move(dir, mag, dt, 1e9);
    const p = runner.root.position;
    p.x = Math.max(-HALF_W, Math.min(HALF_W, p.x));
    p.z = Math.max(-HALF_H, Math.min(HALF_H, p.z));
    runner.update(dt);
    const k = runnerCell();
    cursor.visible = k >= 0;
    if (k >= 0) { const [x, z] = grid.center(k); cursor.position.x = x; cursor.position.z = z; }
    // камера мягко следует за персонажем (на телефоне поле рисуют пальцем, и оно не должно уезжать)
    if (!TOUCH) {
    const tx = controls.target.x + (p.x * 0.6 - controls.target.x) * Math.min(1, dt * 2);
    const tz = controls.target.z + (p.z * 0.6 - controls.target.z) * Math.min(1, dt * 2);
    camera.position.x += tx - controls.target.x; camera.position.z += tz - controls.target.z;
    controls.target.x = tx; controls.target.z = tz;
    }
  }
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (TOUCH) fitView();
  }
  controls.update();
  renderer.render(scene, camera);
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
try {
  await loadRunnerModel(loader, me().hero);
} catch (e) {
  console.error(e);
}
$('loading').classList.add('done');
const prof = me();
runner = new Runner(scene, { color: prof.color, name: '', me: true, hero: prof.hero, tint: prof.tint });
runner.root.position.set(0, 0, 9);
changed();
tick();
toast(TOUCH ? 'Выбери слева, что ставить, и рисуй пальцем. Двумя пальцами можно приблизить поле.'
  : 'Бегай (WASD / стрелки / джойстик) и жми «Поставить» (E). Можно просто тыкать по клеткам.', 6000);
if (qs.has('debug')) window.__ed = { TOUCH, fitView, controls, get cells() { return cells; }, apply, setTool, runner, keys, grid, current, save, changed, get lastA() { return lastA; }, camera, renderer };
