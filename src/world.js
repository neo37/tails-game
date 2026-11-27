/**
 * Открытый космос: летаешь своим кораблём среди трасс, которые построили игроки.
 * Физика полёта и расстановка — world-sim.js; трассы берём из того же каталога, что и races.html,
 * место каждой считается из хеша её кода, поэтому мир у всех одинаковый и синхронизировать нечего.
 * Влетел в кольцо старта — открывается гонка по этой трассе (race.html?code=…&from=world).
 */
import * as THREE from 'three';
import { Joystick } from './runner.js';
import { me as myProfile, apiBase } from './net.js';
import { makeShip, addFlames } from './ships.js';
import { decode, trackName, DIFFS, EXAMPLES, encode, myRaces } from './race-design.js';
import { TUBE_R } from './race-sim.js';
import { FLY, WORLD_R, GATE_R, layout, newPilot, stepPilot, nearest, len, dot, norm, cross } from './world-sim.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const profile = myProfile();

function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ── каталог трасс ──
   Сервер отдаёт свежие первыми — этот порядок и уходит в layout: при переполнении слотов
   в мире оказываются новые трассы, а не те, чей код раньше по алфавиту. Нет сети — летаем по примерам. */
async function catalog() {
  const out = [];
  const seen = new Set();
  const add = (code) => {
    const s = String(code || '');
    if (!s || seen.has(s)) return;
    const design = decode(s);
    if (!design) return;
    seen.add(s);
    out.push({ code: s, design, name: trackName(design), diff: design.d });
  };
  try {
    const ac = new AbortController();                 // AbortSignal.timeout есть не во всех WebView
    const bell = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(`${apiBase()}api/tracks`, { signal: ac.signal });
    const j = await r.json();
    clearTimeout(bell);
    for (const t of j.tracks || []) add(t.code);
  } catch (e) {
    toast('Космос без сети: летаем по трассам-примерам');
  }
  if (!out.length) for (const d of EXAMPLES) add(encode(d));
  return out;
}

const mineCodes = myRaces.list().map((x) => x.code).filter((c) => decode(c));
const tracks = await catalog();
for (const c of mineCodes) if (!tracks.some((t) => t.code === c)) {
  const design = decode(c);
  tracks.push({ code: c, design, name: trackName(design), diff: design.d, mine: true });
}
for (const t of tracks) if (mineCodes.includes(t.code)) t.mine = true;

const gates = layout(tracks.map((t) => t.code), mineCodes);
const byCode = new Map(tracks.map((t) => [t.code, t]));
$('found').textContent = String(gates.size);
$('load-bar').style.width = '40%';

/* ── сцена ── */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04051a);
const camera = new THREE.PerspectiveCamera(62, 1, 0.4, 24000);
scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x30204a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(0.4, 1, 0.7);
scene.add(sun);

const rnd = (() => { let a = 20261127; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();

/* небо летит вместе с камерой: звёзды и туманности бесконечно далеко */
const sky = new THREE.Group();
scene.add(sky);
const blobTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d'), gr = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, '#ffffffcc'); gr.addColorStop(0.45, '#ffffff33'); gr.addColorStop(1, '#ffffff00');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
{
  const n = 2600, p = new Float32Array(n * 3), c = new Float32Array(n * 3), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, a = rnd() * 6.283, r = Math.sqrt(1 - u * u);
    p.set([r * Math.cos(a) * 1500, u * 1500, r * Math.sin(a) * 1500], i * 3);
    col.setHSL(0.55 + rnd() * 0.15, 0.6, 0.72 + rnd() * 0.28);
    c.set([col.r, col.g, col.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  sky.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, depthWrite: false })));
  for (const [color, x, y, z, s] of [[0x7a3dff, 700, 240, -1000, 1300], [0xff3d9a, -900, -160, -800, 1100], [0x25c4ff, 300, -700, -1000, 1000], [0x5c6cff, -500, 600, 800, 1200], [0xff7a3d, 900, -300, 700, 900]]) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTex, color, transparent: true, opacity: 0.26, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.position.set(x, y, z); sp.scale.setScalar(s);
    sky.add(sp);
  }
}

/* край мира: сетка-сфера зажигается, только когда до края близко — иначе она висит поперёк всего неба */
const edgeNet = new THREE.Mesh(
  new THREE.SphereGeometry(WORLD_R, 36, 24),
  new THREE.MeshBasicMaterial({ color: 0x3a6cff, wireframe: true, transparent: true, opacity: 0, depthWrite: false }),
);
edgeNet.visible = false;
scene.add(edgeNet);

/* ── воронки старта ── */
const DIFF_COLOR = { easy: 0x5cff7a, mid: 0xffd84d, hard: 0xff5c7a };
const ringGeo = new THREE.TorusGeometry(GATE_R, 1.6, 8, 40);
const taperGeo = new THREE.CylinderGeometry(TUBE_R, GATE_R, 70, 24, 1, true);
taperGeo.rotateX(-Math.PI / 2);                     // ось по +Z: от горловины внутрь
taperGeo.translate(0, 0, 35);
const stubGeo = new THREE.CylinderGeometry(TUBE_R, TUBE_R, 220, 20, 1, true);
stubGeo.rotateX(-Math.PI / 2);
stubGeo.translate(0, 0, 70 + 110);
const mats = {}, glows = {};
for (const [d, c] of Object.entries(DIFF_COLOR)) {
  mats[d] = {
    ring: new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.8, roughness: 0.4 }),
    tube: new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.25, roughness: 0.6, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
  };
  glows[d] = new THREE.SpriteMaterial({ map: blobTex, color: c, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending });
}
const mineRing = new THREE.MeshStandardMaterial({ color: 0x9cf6ff, emissive: 0x9cf6ff, emissiveIntensity: 1.1, roughness: 0.3 });
const gateNodes = [];
const _m4 = new THREE.Matrix4();
for (const [code, g] of gates) {
  const t = byCode.get(code);
  const d = (t && DIFF_COLOR[t.diff]) ? t.diff : 'easy';
  const node = new THREE.Group();
  node.position.set(...g.pos);
  _m4.makeBasis(new THREE.Vector3(...g.right), new THREE.Vector3(...g.up), new THREE.Vector3(...g.nose));
  node.quaternion.setFromRotationMatrix(_m4);
  node.add(new THREE.Mesh(ringGeo, t && t.mine ? mineRing : mats[d].ring));
  node.add(new THREE.Mesh(taperGeo, mats[d].tube));
  node.add(new THREE.Mesh(stubGeo, mats[d].tube));
  const glow = new THREE.Sprite(glows[d]);
  glow.scale.setScalar(150);
  node.add(glow);
  scene.add(node);
  gateNodes.push({ code, node, gate: g, ring: node.children[0] });
}
$('load-bar').style.width = '75%';

/* ── свой корабль ── */
const ship = makeShip(profile.ship, profile.color, 0xffffff, profile.kit);
const flames = addFlames(ship, profile.color, profile.kit);
ship.scale.setScalar(1.6);
scene.add(ship);

const pilot = newPilot([0, 0, 0], [0, 0, 1]);

/* ── ввод ── */
const keys = new Set();
addEventListener('keydown', (e) => { keys.add(e.code); if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault(); });
addEventListener('keyup', (e) => keys.delete(e.code));
const joy = new Joystick($('joy'));
let brakeTouch = false;
const bz = $('brake-zone');
bz.addEventListener('pointerdown', (e) => { brakeTouch = true; bz.classList.add('on'); bz.setPointerCapture(e.pointerId); e.preventDefault(); });
for (const ev of ['pointerup', 'pointercancel']) bz.addEventListener(ev, () => { brakeTouch = false; bz.classList.remove('on'); });

const input = { x: 0, y: 0, brake: false };
function readInput() {
  let x = 0, y = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) x -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) y += 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) y -= 1;
  if (joy.active) { x = joy.x; y = joy.y; }
  input.x = x; input.y = y;
  input.brake = brakeTouch || keys.has('Space') || keys.has('ShiftLeft');
  return input;
}

/* ── влёт в трассу ── */
let leaving = false;
function enterTrack(code) {
  if (leaving) return;
  leaving = true;
  const t = byCode.get(code);
  toast(`Влетаем: ${t ? t.name : 'трасса'}!`);
  // скорость влёта в гонку пока не переносится: гонка начинается своим отсчётом
  setTimeout(() => { location.href = `race.html?code=${encodeURIComponent(code)}&from=world`; }, 420);
}

/* ── подсказка о ближайшей трассе ── */
const card = $('near-card'), arrow = $('near-arrow'), chip = $('enter-chip');
let hudAt = 0;
function hud(dt) {
  $('speed-num').textContent = String(Math.round(pilot.v));
  $('speed-fill').style.width = `${Math.min(100, (pilot.v / FLY.vmax) * 100)}%`;
  if ((hudAt += dt) < 0.12) return;
  hudAt = 0;
  const n = nearest(pilot, gates);
  if (!n) { card.hidden = true; chip.hidden = true; return; }
  const t = byCode.get(n.id);
  card.hidden = false;
  $('near-name').textContent = t ? `${t.mine ? '🛠 ' : ''}${t.name}` : 'Трасса';
  const df = t && DIFFS[t.diff];
  $('near-sub').textContent = `${df ? df.name : ''} · ${Math.round(n.dist)} ед.`;
  // стрелка в экранных осях корабля: куда довернуть, чтобы трасса оказалась перед носом
  const d = [n.gate.pos[0] - pilot.p[0], n.gate.pos[1] - pilot.p[1], n.gate.pos[2] - pilot.p[2]];
  const ax = dot(d, pilot.right), ay = dot(d, pilot.up);
  arrow.style.transform = `rotate(${(Math.atan2(ax, ay) * 180) / Math.PI}deg)`;
  // кольцо близко и впереди — зовём влетать
  const toward = n.ahead > 0 && Math.abs(dot(norm(d), pilot.nose)) > 0.9;
  chip.hidden = !(n.dist < 420 && toward);
}

/* ── кадр ── */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _look = new THREE.Vector3();
let last = performance.now(), t0 = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t0 += dt;

  for (const [e, id] of stepPilot(pilot, readInput(), gates, dt)) {
    if (e === 'enter') enterTrack(id);
    else if (e === 'edge') toast('Дальше космос кончился — поворачивай!');
  }

  // корабль: базис пилота, крен только для вида
  const bank = pilot.bank * 0.7;
  const cb = Math.cos(bank), sb = Math.sin(bank);
  const right = [pilot.right[0] * cb + pilot.up[0] * sb, pilot.right[1] * cb + pilot.up[1] * sb, pilot.right[2] * cb + pilot.up[2] * sb];
  const up = cross(pilot.nose, right);
  ship.position.set(...pilot.p);
  _m4.makeBasis(_a.set(...right), _b.set(...up), _c.set(...pilot.nose));
  ship.quaternion.setFromRotationMatrix(_m4);
  flames.set(0.6 + (pilot.v / FLY.vmax) * 2.2);

  // камера сзади и чуть выше, с запасом на скорость
  const back = 26 + (pilot.v / FLY.vmax) * 10;
  camera.position.set(
    pilot.p[0] - pilot.nose[0] * back + up[0] * 8,
    pilot.p[1] - pilot.nose[1] * back + up[1] * 8,
    pilot.p[2] - pilot.nose[2] * back + up[2] * 8,
  );
  camera.up.set(up[0], up[1], up[2]);
  camera.lookAt(_look.set(pilot.p[0] + pilot.nose[0] * 60, pilot.p[1] + pilot.nose[1] * 60, pilot.p[2] + pilot.nose[2] * 60));
  sky.position.copy(camera.position);

  // кольца медленно крутятся, чтобы их было видно издалека
  for (const g of gateNodes) g.ring.rotation.z = t0 * 0.6;

  // сетка края: проступает в последних 1500 единицах
  const edge = Math.max(0, (len(pilot.p) - (WORLD_R - 1500)) / 1500);
  edgeNet.visible = edge > 0.01;
  if (edgeNet.visible) edgeNet.material.opacity = Math.min(0.3, edge * 0.3);

  const secs = Math.floor(t0);
  $('clock').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  hud(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ?debug — доступ к пилоту и трассам: так проверяют влёт, не подлетая к кольцу руками
if (qs.has('debug')) window.__world = { pilot, gates, tracks, byCode, FLY };

$('load-bar').style.width = '100%';
$('loading').classList.add('done');
setTimeout(() => { $('loading').hidden = true; }, 500);
toast(gates.size > 1 ? `В космосе ${gates.size} трасс. Лети к ближайшему кольцу!` : 'Лети к кольцу — это старт трассы!', 3400);
requestAnimationFrame(frame);
