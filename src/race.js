/**
 * Гонка в космическом тоннеле: графика, ввод, боты и комнаты. Физика и трасса — race-sim.js.
 * В комнате каждый считает своего персонажа сам и шлёт позицию ведущему, ведущий рассылает снимок всем:
 * сервер не меняется (те же act и snap), а отклик у своего персонажа мгновенный.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Runner, Joystick, loadRunnerModel } from './runner.js';
import { Net, me as myProfile, COLORS } from './net.js';
import { MAPS, progress } from './levels.js';
import { audio } from './audio.js';
import { TUBE_R, radiusAt, buildTrack, sample, barAngle, newRacer, stepRacer, botInput, routeOf, fire, stepShot, shotHits, zap, botAims, worldAt, SHOT, mudBomb, BOMB } from './race-sim.js';
import { buildCourse, decode as decodeTrack, W as FIELD, CELL as FIELD_CELL } from './race-design.js';
import { makeShip, addFlames } from './ships.js';
import { parseKit, kitString, itemById } from './shop.js';
import { replays } from './replays.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const profile = myProfile();

function failPage(text) {
  $('load-text').textContent = text;
  $('loading').insertAdjacentHTML('beforeend', '<a class="huge ghost" href="index.html" style="margin-top:12px">🏠 Домой</a>');
  throw new Error(text);
}
function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ── повтор записанной гонки (src/replays.js): та же трасса, гонщики летят по записанным координатам ── */
const replay = qs.get('replay') ? replays.get(qs.get('replay')) : null;
if (qs.get('replay') && !replay) failPage('Эта запись не найдена');
if (replay) document.body.classList.add('replay');

/* ── комната или одиночная гонка ── */
const ROOM = replay ? '' : (qs.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
let net = null, room = null, myId = 1, isHost = !ROOM;
let def = null;
if (ROOM) {
  $('load-text').textContent = `Входим в гонку ${ROOM}…`;
  net = new Net();
  await net.connect({ name: profile.name || 'Игрок', color: profile.color, emoji: profile.emoji, hero: profile.hero, tint: profile.tint, ship: profile.ship, kit: kitString(profile.kit) });
  myId = net.id;
  room = await new Promise((resolve) => {
    const t = setTimeout(() => failPage(`Не получилось войти в гонку ${ROOM}`), 8000);
    net.on('room', (m) => { if (m.room.code === ROOM && !room) { clearTimeout(t); resolve(m.room); } });
    net.on('error', (m) => { if (!room) { clearTimeout(t); failPage(m.msg); } });
    net.send({ t: 'join', code: ROOM });
  });
  isHost = room.host === myId;
  if (room.map !== 'track') {
    def = MAPS.race.levels.find((l) => l.id === room.level);
    if (!def) failPage('Эта трасса не открывается');
  }
  $('btn-home').href = 'lobby.html';
  $('btn-home').addEventListener('click', () => net.send({ t: 'leave' }));
} else if (!(replay ? replay.src.code : qs.get('code'))) {
  def = MAPS.race.levels.find((l) => l.id === Number(replay ? replay.src.level : qs.get('level'))) || MAPS.race.levels[0];
}
// своя трасса из блоков (race-design.js): несколько путей; у готовых трасс путь один
let course;
if (def) course = { routes: [buildTrack(def)] };
else {
  const design = decodeTrack(ROOM ? room.lv : replay ? replay.src.code : qs.get('code'));
  course = design && buildCourse(design);
  if (!course) failPage('Эта трасса не открывается');
  def = course.def;
  if (!ROOM) $('btn-home').href = 'races.html';
}
const track = course.routes[0];
const draws = course.draw || track.obstacles.map((o) => ({ track, o }));

/* ── сцена ── */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: qs.has('debug') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05061a);
scene.fog = new THREE.FogExp2(0x05061a, 0.0032);
const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4200);
scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x30204a, 1.5));
const sun = new THREE.DirectionalLight(0xfff2d8, 2.4);
sun.position.set(0.5, 1, -0.6);
scene.add(sun);

const rnd = (() => { let a = def.seed * 977; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
const v3 = (arr, i) => new THREE.Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);

/* небо летит вместе с камерой: звёзды и туманности бесконечно далеко */
const sky = new THREE.Group();
scene.add(sky);
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
  sky.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false })));
  const blob = document.createElement('canvas');
  blob.width = blob.height = 128;
  const ctx = blob.getContext('2d'), gr = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, '#ffffffcc'); gr.addColorStop(0.45, '#ffffff33'); gr.addColorStop(1, '#ffffff00');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(blob);
  for (const [color, x, y, z, s] of [[0x7a3dff, 700, 240, -1000, 1300], [0xff3d9a, -900, -160, -800, 1100], [0x25c4ff, 300, -700, -1000, 1000], [0x5c6cff, -500, 600, 800, 1200], [0xff7a3d, 900, -300, 700, 900]]) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity: 0.26, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
    sp.position.set(x, y, z); sp.scale.setScalar(s);
    sky.add(sp);
  }
}

/* планеты вдоль трассы */
{
  const COLORS_P = [0xe08a4f, 0x4fa8e0, 0xc06fe0, 0x7fd48a, 0xe0c84f];
  const mid = (f) => v3(track.pos, Math.floor((track.n - 1) * f));
  for (let i = 0; i < 6; i++) {
    let c = mid((i + 0.5) / 6), a = rnd() * 6.283, d = 190 + rnd() * 170;
    const r = 28 + rnd() * 48;
    if (def.custom) {         // своя трасса вьётся как угодно: планеты за пределами поля, чтобы тоннель в них не упёрся
      const half = (FIELD * FIELD_CELL) / 2;
      c = new THREE.Vector3(half, half * 0.3, half);
      a = (i / 6) * 6.283;
      d = half * 1.5 + 190 + rnd() * 170;
    }
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 20), new THREE.MeshStandardMaterial({ color: COLORS_P[i % 5], roughness: 0.85, fog: false }));
    m.position.set(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, c.z + (rnd() - 0.5) * 120);
    scene.add(m);
    if (i % 2 === 0) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.35, r * 1.95, 48), new THREE.MeshBasicMaterial({ color: 0xf4e3c0, transparent: true, opacity: 0.5, side: THREE.DoubleSide, fog: false, depthWrite: false }));
      ring.position.copy(m.position);
      ring.rotation.set(1.2 + rnd() * 0.5, rnd(), rnd());
      scene.add(ring);
    }
  }
  if (def.id === 3) {        // в конце трассы — чёрная дыра
    const c = v3(track.pos, track.n - 1).add(new THREE.Vector3(0, 0, 340));
    const hole = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 22), new THREE.MeshBasicMaterial({ color: 0x000000, fog: false }));
    hole.position.copy(c);
    const disc = new THREE.Mesh(new THREE.RingGeometry(135, 300, 72), new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.55, side: THREE.DoubleSide, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    disc.position.copy(c);
    disc.rotation.set(1.25, 0.3, 0);
    scene.add(hole, disc);
  }
}

/* тоннель: прозрачная труба, рёбра и светящиеся полосы. Общие куски разных путей рисуются один раз (drawn). */
for (const route of course.routes) {
  const track = route, drawn = route.drawn;
  const shown = (i) => !drawn || drawn[Math.min(i, route.n - 1)] || drawn[Math.min(i + 3, route.n - 1)];
  const SEG = 28, STEP = 3, rings = Math.floor((track.n - 1) / STEP) + 1;
  const pos = new Float32Array(rings * (SEG + 1) * 3), col = new Float32Array(rings * (SEG + 1) * 3), idx = [];
  const lines = [], lineCol = [], bandPos = [], bandCol = [], bandIdx = [];
  const color = new THREE.Color();
  const hue = (f) => 0.53 + 0.34 * f;              // от голубого к малиновому
  const at = (i, a, out) => {
    const j = i * 3, R = track.rad ? track.rad[Math.min(i, track.n - 1)] : TUBE_R, c = Math.cos(a) * R, s = Math.sin(a) * R;   // радиус меняется по длине
    out[0] = track.pos[j] + track.right[j] * c + track.up[j] * s;
    out[1] = track.pos[j + 1] + track.right[j + 1] * c + track.up[j + 1] * s;
    out[2] = track.pos[j + 2] + track.right[j + 2] * c + track.up[j + 2] * s;
    return out;
  };
  const a0 = [0, 0, 0], a1 = [0, 0, 0];
  for (let r = 0; r < rings; r++) {
    const i = r * STEP, f = r / rings;
    color.setHSL(hue(f), 0.9, 0.55);
    for (let k = 0; k <= SEG; k++) {
      at(i, (k / SEG) * Math.PI * 2, a0);
      pos.set(a0, (r * (SEG + 1) + k) * 3);
      col.set([color.r, color.g, color.b], (r * (SEG + 1) + k) * 3);
      if (r < rings - 1 && k < SEG && shown(i)) {
        const a = r * (SEG + 1) + k, b = a + SEG + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    if (r % 6 === 0 && r < rings - 1 && shown(i)) {             // ребро: светящаяся полоса, видна и вблизи, и издалека
      color.setHSL(hue(f), 1, 0.62);
      for (let k = 0; k < SEG; k++) {
        const q0 = (k / SEG) * 6.2832, q1 = ((k + 1) / SEG) * 6.2832, b0 = bandPos.length / 3;
        bandPos.push(...at(i, q0, a0), ...at(i, q1, a1), ...at(i + 1, q0, a0), ...at(i + 1, q1, a1));
        for (let q = 0; q < 4; q++) bandCol.push(color.r, color.g, color.b);
        bandIdx.push(b0, b0 + 2, b0 + 1, b0 + 1, b0 + 2, b0 + 3);
      }
    }
    if (r < rings - 1 && shown(i)) {                // продольные полосы
      color.setHSL(hue(f) + 0.08, 1, 0.62);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * 6.2832;
        lines.push(...at(i, a, a0), ...at(i + STEP, a, a1));
        for (let q = 0; q < 2; q++) lineCol.push(color.r, color.g, color.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false })));
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(bandPos, 3));
  bg.setAttribute('color', new THREE.Float32BufferAttribute(bandCol, 3));
  bg.setIndex(bandIdx);
  scene.add(new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })));
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  lg.setAttribute('color', new THREE.Float32BufferAttribute(lineCol, 3));
  scene.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false })));
}

/** Плоскость сечения в точке s: x вправо, y вверх. */
function planeAt(s, track = course.routes[0]) {
  const g = new THREE.Group();
  const P = sample(track, s, track.pos, [0, 0, 0]), T = sample(track, s, track.tan, [0, 0, 0]), U = sample(track, s, track.up, [0, 0, 0]), R = sample(track, s, track.right, [0, 0, 0]);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...R), new THREE.Vector3(...U), new THREE.Vector3(-T[0], -T[1], -T[2]));
  g.quaternion.setFromRotationMatrix(m);
  g.position.set(...P);
  scene.add(g);
  return g;
}

/* преграды */
const spinners = [], tumblers = [], fans = [];
/** Вентилятор на всё сечение тоннеля: рама, лопасти и бегущие стрелки по направлению ветра. w = +1 попутный, −1 встречный. */
function makeFan(w) {
  const col = w > 0 ? 0x5ff0ff : 0xff6a3c;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.TorusGeometry(TUBE_R - 0.4, 0.45, 10, 64), new THREE.MeshStandardMaterial({ color: 0xdfe8ff, metalness: 0.6, roughness: 0.35 })));
  g.add(new THREE.Mesh(new THREE.CircleGeometry(TUBE_R - 0.4, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false })));
  const blades = new THREE.Group();
  const bladeMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(TUBE_R * 0.92, 2.6), bladeMat);
    b.position.x = TUBE_R * 0.46; b.rotation.x = 0.5;
    const arm = new THREE.Group(); arm.rotation.z = (i * Math.PI) / 2; arm.add(b); blades.add(arm);
  }
  blades.add(new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1, 20).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.3 })));
  g.add(blades);
  // стрелки: летят вперёд (попутный) или навстречу (встречный)
  const arrows = new THREE.Group();
  const sh = new THREE.Shape(); sh.moveTo(-1.4, 0); sh.lineTo(1.4, 0); sh.lineTo(0, 2.2 * w); sh.closePath();
  const am = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2, m = new THREE.Mesh(new THREE.ShapeGeometry(sh), am);
    m.position.set(Math.cos(a) * 7.5, Math.sin(a) * 7.5, 0); m.rotation.x = -Math.PI / 2;   // острие смотрит по ветру (вперёд по тоннелю — это −z плоскости)
    arrows.add(m);
  }
  g.add(arrows);
  fans.push({ blades, arrows, w });
  return g;
}
let windChip = 0;
function windFx(w) {
  audio.sfx(w > 0 ? 'hop' : 'hurt', w > 0 ? 1.2 : 0.4);
  if (performance.now() - windChip > 1500) { windChip = performance.now(); toast(w > 0 ? '🌬️ Попутный ветер — быстрее!' : '🌀 Встречный ветер — тормозит!', 900); }
  if (w < 0) camS.shake = Math.max(camS.shake, 0.15);
}
{
  const wall = (c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false });
  const edge = new THREE.MeshBasicMaterial({ color: 0x8dffb0 });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x9a8a7c, roughness: 1, flatShading: true });
  const barMat = new THREE.MeshStandardMaterial({ color: 0xffc23c, emissive: 0xb86a00, emissiveIntensity: 0.7, roughness: 0.5 });
  const boostMat = new THREE.MeshBasicMaterial({ color: 0xffe14a });
  for (const { track: route, o } of draws) {
    const g = planeAt(o.s, route);
    if (o.k && o.k !== 1) g.scale.set(o.k, o.k, 1);   // в широкой части преграда растянута на всё сечение
    if (o.kind === 'gate') {
      const sh = new THREE.Shape();
      sh.absarc(0, 0, TUBE_R, 0, Math.PI * 2);
      const h = new THREE.Path();
      h.absarc(o.x, o.y, o.hole, 0, Math.PI * 2, true);
      sh.holes.push(h);
      g.add(new THREE.Mesh(new THREE.ShapeGeometry(sh, 40), wall(0xff3d6e)));
      const t = new THREE.Mesh(new THREE.TorusGeometry(o.hole, 0.28, 8, 40), edge);
      t.position.set(o.x, o.y, 0);
      g.add(t);
    } else if (o.kind === 'half') {
      const th = Math.acos(o.d / TUBE_R), sh = new THREE.Shape();
      sh.absarc(0, 0, TUBE_R, o.a - th, o.a + th);
      sh.closePath();
      g.add(new THREE.Mesh(new THREE.ShapeGeometry(sh, 30), wall(0xff8a2e)));
    } else if (o.kind === 'bar') {
      const hub = new THREE.Group();
      hub.add(new THREE.Mesh(new THREE.BoxGeometry(TUBE_R * 2, o.hw * 2, 0.9), barMat));
      hub.rotation.z = o.a;
      g.add(hub);
      spinners.push({ o, hub });
    } else if (o.kind === 'rocks') {
      for (const k of o.rocks) {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(k.r, 1), rockMat);
        m.position.set(k.x, k.y, 0);
        g.add(m);
        tumblers.push(m);
      }
    } else if (o.kind === 'fan' || o.kind === 'fanb') {
      g.add(makeFan(o.w || (o.kind === 'fan' ? 1 : -1)));
    } else if (o.kind === 'boost') {
      const t = new THREE.Mesh(new THREE.TorusGeometry(o.hole, 0.32, 8, 32), boostMat);
      t.position.set(o.x, o.y, 0);
      g.add(t);
      const c = new THREE.Mesh(new THREE.CircleGeometry(o.hole, 28), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
      c.position.set(o.x, o.y, 0);
      g.add(c);
    }
  }
  // финиш: шахматная арка
  const fin = planeAt(track.length);
  { const kf = radiusAt(track, track.length) / TUBE_R; if (kf !== 1) fin.scale.set(kf, kf, 1); }
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const x = cv.getContext('2d');
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { x.fillStyle = (i + j) % 2 ? '#ffffff' : '#111122'; x.fillRect(i * 16, j * 16, 16, 16); }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  fin.add(new THREE.Mesh(new THREE.CircleGeometry(TUBE_R, 40), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false })));
  fin.add(new THREE.Mesh(new THREE.TorusGeometry(TUBE_R, 0.5, 10, 64), new THREE.MeshBasicMaterial({ color: 0xffffff })));
}

/* ── персонажи ── */
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const loaded = new Set();
async function ensureHero(hero) {
  if (hero === 'ghost' || loaded.has(hero)) return;
  loaded.add(hero);
  try { await loadRunnerModel(loader, hero); } catch (e) { console.error(e); }
}
/** Гонщик: треугольный корабль, выбранный в профиле, в цвете игрока; из сопел бьют реактивные струи. */
class Rider {
  constructor({ id, color, name, hero, tint, ship, kit = {}, isMe, racer, skill }) {
    const badge = itemById(kit.badge);
    if (badge && !isMe) name = `${name} ${badge.icon}`;          // значок-ачивка рядом с именем
    this.id = id; this.color = color; this.name = name; this.isMe = isMe; this.emoji = name; this.ship = ship; this.kit = kit;
    this.p = racer; this.skill = skill;
    this.r = new Runner(scene, { color, name: isMe ? '' : name, me: isMe, hero: loaded.has(hero) || hero === 'ghost' ? hero : 'maskot', tint });
    const r = this.r;
    r.ring.visible = false;
    r.mixer.stopAllAction();
    r.walk = r.run = null;
    r.body.visible = false;
    const body = makeShip(ship, color, isMe ? 0xffffff : color, kit);
    r.root.add(body);
    this.flame = addFlames(body, color, kit);
    this.roll = 0; this.pitch = 0; this.yaw = 0;
    this.px = 0; this.py = 0; this.pz = 0;
    // чужой: цель из снимка
    this.net = null;
  }

  /** Поставить в мир по (s, x, y) и наклонить по боковой скорости. */
  place(s, x, y, vx, vy, v, dt) {
    const track = routeOf(course, this.p);
    const P = sample(track, s, track.pos, this._a ||= [0, 0, 0]), T = sample(track, s, track.tan, this._b ||= [0, 0, 0]);
    const U = sample(track, s, track.up, this._c ||= [0, 0, 0]), R = sample(track, s, track.right, this._d ||= [0, 0, 0]);
    const root = this.r.root;
    root.position.set(P[0] + R[0] * x + U[0] * y, P[1] + R[1] * x + U[1] * y, P[2] + R[2] * x + U[2] * y);
    _x.set(-R[0], -R[1], -R[2]); _y.set(U[0], U[1], U[2]); _z.set(T[0], T[1], T[2]);
    _m.makeBasis(_x, _y, _z);
    root.quaternion.setFromRotationMatrix(_m);
    const k = Math.min(1, dt * 7);
    this.roll += (Math.max(-1.1, Math.min(1.1, vx * 0.055)) - this.roll) * k;
    this.pitch += (Math.max(-0.7, Math.min(0.7, -vy * 0.03)) - this.pitch) * k;
    this.yaw += (Math.max(-0.5, Math.min(0.5, -vx * 0.018)) - this.yaw) * k;
    root.rotateY(this.yaw);
    root.rotateX(this.pitch);
    root.rotateZ(this.roll);
    this.flame.set(0.5 + (v / def.vmax) * 2.2 * (0.85 + Math.random() * 0.3));
    this.r.update(dt);
    if (this.r.label) this.r.label.position.y = 2.8;   // имя сразу над рубкой
  }
}
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();

/* ── состояние гонки ── */
const riders = new Map();             // id → Rider
let mine = null;
let state = 'load';                   // load → wait → count → go → done
let goAt = 0;                         // performance.now() старта
let raceT = 0;
const finished = [];                  // порядок финиша: [{ id, t }]
const roster = (id) => (room ? room.players.find((p) => p.id === id) : null);

const BOT_TIER = def.vmax < 82 ? 1 : def.vmax < 96 ? 2 : 3;
const BOTS = def.bots || {
  1: [[0.28, 0.84, 0.55], [0.38, 0.78, 0.4], [0.48, 0.74, 0.3]],
  2: [[0.2, 0.92, 0.7], [0.3, 0.87, 0.5], [0.42, 0.82, 0.4]],
  3: [[0.12, 0.97, 0.85], [0.25, 0.92, 0.6], [0.35, 0.87, 0.5]],
}[def.id <= 3 ? def.id : BOT_TIER] || [];
const BOT_LOOK = [
  { name: '🤖 Комета', color: '#ff6f91', hero: 'maskot', tint: '#ff9dbb', ship: 'arrow' },
  { name: '👾 Астра', color: '#8fd0ff', hero: 'ghost', tint: '#8fd0ff', ship: 'delta' },
  { name: '🛸 Метеор', color: '#9be37a', hero: 'ghost', tint: '#9be37a', ship: 'wedge' },
];

await ensureHero(profile.hero);
await ensureHero('maskot');
$('load-bar').style.width = '60%';
if (ROOM) for (const p of room.players) await ensureHero(p.hero);
else await ensureHero('maskot');
$('load-bar').style.width = '100%';

function addMe() {
  const lane = ROOM ? Math.max(0, room.players.findIndex((p) => p.id === myId)) : 0;
  const rider = new Rider({ id: myId, color: profile.color, name: `${profile.emoji} ${profile.name || 'Ты'}`, hero: profile.hero, tint: profile.tint, ship: profile.ship, kit: profile.kit, isMe: true, racer: newRacer(lane) });
  riders.set(myId, rider);
  mine = rider;
}
if (replay) {                           // гонщики из записи: летят по координатам, без физики
  for (const rr of replay.riders) {
    const r = new Rider({ id: rr.id, color: rr.color, name: rr.name, ship: rr.ship, kit: parseKit(rr.kit), isMe: !!rr.me, racer: newRacer(0) });
    r.play = replay.frames[rr.id];
    riders.set(rr.id, r);
    if (rr.me) mine = r;
  }
  mine ||= riders.values().next().value;
  myId = mine.id;
} else addMe();
if (!ROOM && !replay) {
  BOTS.forEach(([miss, vmaxK, sloppy], i) => {
    const l = BOT_LOOK[i];
    riders.set(-(i + 1), new Rider({ id: -(i + 1), color: l.color, name: l.name, hero: l.hero, tint: l.tint, ship: l.ship, racer: newRacer(i + 1), skill: { miss, vmaxK, sloppy, seed: i + 3 } }));
  });
}
function syncRoster() {
  if (!room) return;
  for (const p of room.players) {
    if (p.id === myId) continue;
    if (!riders.has(p.id)) {
      const lane = room.players.indexOf(p);
      const rider = new Rider({ id: p.id, color: p.color, name: `${p.emoji} ${p.name}`, hero: p.hero, tint: p.tint, ship: p.ship, kit: parseKit(p.kit), racer: newRacer(lane) });
      rider.net = { s: rider.p.s, x: rider.p.x, y: rider.p.y, v: 0 };
      riders.set(p.id, rider);
    }
  }
  for (const [id, r] of riders) {
    if (id !== myId && !room.players.some((p) => p.id === id)) { r.r.dispose(); riders.delete(id); }
  }
  $('place-of').textContent = riders.size;
}
syncRoster();

/* ── выстрелы: каждый считает свои заряды и попадания по тем, кем управляет сам (своему персонажу и ботам) ── */
const shots = [];
const shotGeo = new THREE.CylinderGeometry(0.22, 0.22, 3.2, 8);
shotGeo.rotateX(Math.PI / 2);
const sparkGeo = new THREE.IcosahedronGeometry(0.7, 1);
const sparks = [];
let shotSeq = 0;
const seenShots = new Set();
const relay = [];                       // ведущий пересылает заряды всем через снимок
function spawnShot(sh, color) {
  sh.mesh = new THREE.Mesh(shotGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35) }));
  scene.add(sh.mesh);
  shots.push(sh);
  if (recorder) recorder.shots.push([+raceT.toFixed(2), Math.round(sh.s), +sh.x.toFixed(1), +sh.y.toFixed(1), sh.route, sh.owner, Math.round(sh.v)]);
}
function spark(sh, color) {
  const tr = routeOf(course, { route: sh.route });
  const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.position.set(...worldAt(tr, sh.s, sh.x, sh.y));
  m.life = 0.35;
  scene.add(m);
  sparks.push(m);
}
function shoot(rider) {
  if (replay) return false;              // в повторе выстрелы только из записи
  const sh = fire(rider.p, rider.id);
  if (!sh) return false;
  sh.id = `${myId}.${++shotSeq}`;
  seenShots.add(sh.id);
  spawnShot(sh, rider.color);
  if (rider.isMe) {
    audio.sfx('hop', 2.2);
    if (net) {
      const m = { k: 'shot', id: sh.id, s: Math.round(sh.s), x: +sh.x.toFixed(1), y: +sh.y.toFixed(1), v: Math.round(sh.v), r: sh.route };
      if (isHost) relay.push({ ...m, from: myId, at: performance.now() }); else net.send({ t: 'act', a: m });
    }
  }
  return true;
}
function remoteShot(m, from) {
  if (from === myId || seenShots.has(m.id) || ![m.s, m.x, m.y, m.v, m.r].every(Number.isFinite)) return;
  if (!course.routes[m.r]) return;
  seenShots.add(m.id);
  const r = riders.get(from);
  spawnShot({ owner: from, route: m.r, s: m.s, x: m.x, y: m.y, v: m.v, t: 0, dead: null, id: m.id }, r ? r.color : '#ffffff');
}
/* ── грязевая бомба: вокруг запустившего ярко-зелёная сфера, вокруг остальных — чёрная полупрозрачная ── */
const bombGeo = new THREE.SphereGeometry(4.2, 22, 14);
const bombFx = [];
const relayBombs = [];
function bomb(rider) {
  if (replay || state !== 'go' || !rider || rider.p.bombUsed || rider.p.fin) return false;
  rider.p.bombUsed = true;
  const id = `${myId}.b${++shotSeq}`;
  applyBomb(rider.id, id);
  if (rider.isMe && net) {
    if (isHost) relayBombs.push({ id, from: myId, at: performance.now() }); else net.send({ t: 'act', a: { k: 'bomb', id } });
  }
  return true;
}
/** Взрыв от гонщика from: замедляем тех, кем управляем сами (себя и ботов), сферы рисуем у всех. visual — только картинка (повтор). */
function applyBomb(from, id, visual = false) {
  if (seenShots.has(id) && !visual) return;
  seenShots.add(id);
  const who = riders.get(from);
  if (who) who.p.bombUsed = true;
  for (const r of riders.values()) {
    const own = r.id === from;
    const m = new THREE.Mesh(bombGeo, new THREE.MeshBasicMaterial(own
      ? { color: 0x39ff6a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }
      : { color: 0x050505, transparent: true, opacity: 0.55, depthWrite: false }));
    m.scale.setScalar(0.1);
    r.r.root.add(m);
    bombFx.push({ m, t: 0, life: own ? 1.2 : BOMB.mud });
    if (!own && !visual && (r.isMe || r.skill)) mudBomb(r.p);
  }
  if (recorder) recorder.bombs.push([+raceT.toFixed(2), from]);
  if (visual) return;
  audio.sfx('hurt', 0.6); audio.sfx('hit', 0.5);
  if (from === myId) toast('💣 Грязевая бомба! Все соперники в грязи', 1600);
  else { toast(`💣 ${who ? who.name : 'Кто-то'} взорвал грязевую бомбу!`, 1800); camS.shake = 0.45; }
}
function drawBombs(dt) {
  for (let i = bombFx.length - 1; i >= 0; i--) {
    const f = bombFx[i];
    f.t += dt;
    f.m.scale.setScalar(Math.min(1.15, 0.1 + f.t * 3));
    f.m.material.opacity = 0.55 * Math.min(1, (f.life - f.t) / 0.6);
    if (f.t >= f.life) { f.m.parent?.remove(f.m); f.m.material.dispose(); bombFx.splice(i, 1); }
  }
}

function stepShots(dt) {
  for (const sh of shots) {
    if (sh.dead) continue;
    stepShot(sh, course, raceT, dt);
    if (sh.dead === 'wall') { spark(sh, '#ffffff'); continue; }
    for (const r of riders.values()) {
      if (r.id === sh.owner || r.p.fin || !shotHits(sh, r.p, course)) continue;
      sh.dead = 'hit';
      spark(sh, '#ffd447');
      if (r.isMe || r.skill) {             // по своим — замедление, по чужим игрокам — у них самих
        if ((r.p.zap || 0) <= 0) {
          zap(r.p);
          if (r.isMe) { audio.sfx('hurt'); camS.shake = 0.4; toast('💥 В тебя попали — замедление!', 1100); }
        }
      }
      if (sh.owner === myId) { audio.sfx('hit'); toast('🎯 Попал!', 700); }
      break;
    }
  }
  for (let i = shots.length - 1; i >= 0; i--) if (shots[i].dead) { scene.remove(shots[i].mesh); shots[i].mesh.material.dispose(); shots.splice(i, 1); }
}
function drawShots(dt) {
  const a = [0, 0, 0], b = [0, 0, 0];
  for (const sh of shots) {
    const tr = routeOf(course, { route: sh.route });
    worldAt(tr, sh.s, sh.x, sh.y, a);
    worldAt(tr, sh.s + 2, sh.x, sh.y, b);
    sh.mesh.position.set(...a);
    sh.mesh.lookAt(b[0], b[1], b[2]);
  }
  drawBombs(dt);
  for (let i = sparks.length - 1; i >= 0; i--) {
    const m = sparks[i];
    m.life -= dt;
    m.scale.setScalar(1 + (0.35 - m.life) * 3.5);
    m.material.opacity = Math.max(0, m.life / 0.35);
    if (m.life <= 0) { scene.remove(m); m.material.dispose(); sparks.splice(i, 1); }
  }
}

/* ── ввод ── */
const joy = new Joystick($('joy'));
joy.floatIn(canvas, () => true, () => {});
const keys = new Set();
let brakeHold = false;
addEventListener('keydown', (e) => {
  if (/^(KeyW|KeyA|KeyS|KeyD|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|ShiftLeft|ShiftRight)$/.test(e.code)) { keys.add(e.code); e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
{
  const z = $('brake-zone');
  const set = (v) => { brakeHold = v; z.classList.toggle('on', v); };
  z.addEventListener('pointerdown', (e) => { e.preventDefault(); z.setPointerCapture(e.pointerId); set(true); });
  for (const n of ['pointerup', 'pointercancel', 'lostpointercapture']) z.addEventListener(n, () => set(false));
}
// стрельбы и бомб в гонке больше нет (1.13.0): вместо них на трассах свои вентиляторы
const input = { x: 0, y: 0, brake: false };
function readInput() {
  input.x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  input.y = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  if (joy.active) { input.x = joy.x; input.y = joy.y; }
  input.brake = brakeHold || keys.has('Space') || keys.has('ShiftLeft') || keys.has('ShiftRight');
}
let voiceOn = localStorage.getItem('tails.voice') !== 'off';
$('btn-voice').textContent = voiceOn ? '🔊' : '🔇';
$('btn-voice').onclick = () => {
  voiceOn = !voiceOn;
  localStorage.setItem('tails.voice', voiceOn ? 'on' : 'off');
  $('btn-voice').textContent = voiceOn ? '🔊' : '🔇';
  audio.setOn(voiceOn);
};
audio.setOn(voiceOn);
for (const n of ['pointerdown', 'keydown']) addEventListener(n, () => audio.unlock(), { capture: true });
audio.music(true);

/* ── сеть ── */
const ready = new Set();
let hostSince = performance.now(), sendT = 0;
function startCount(ms) {
  if (state === 'go' || state === 'done' || state === 'count') return;
  state = 'count';
  $('wait-host').classList.remove('show');
  goAt = performance.now() + ms;
}
function hostTick() {
  if (state === 'wait') {
    const online = room.players.filter((p) => p.online);
    if (online.every((p) => p.id === myId || ready.has(p.id)) || performance.now() - hostSince > 15000) startCount(3200);
  }
  const left = goAt ? Math.max(0, Math.round(goAt - performance.now())) : -1;
  const pl = [...riders.values()].map((r) => {
    const q = r.isMe ? r.p : r.net;
    return [r.id, Math.round(q.s), +q.x.toFixed(1), +q.y.toFixed(1), Math.round(q.v), q.route || 0];
  });
  const now = performance.now();
  while (relay.length && now - relay[0].at > 1200) relay.shift();
  while (relayBombs.length && now - relayBombs[0].at > 3000) relayBombs.shift();
  net.send({ t: 'snap', s: { left, pl, fin: finished, sh: relay.map(({ at, ...m }) => m), bm: relayBombs.map(({ at, ...m }) => m) } });
  // все на связи долетели — комната закрыта для новых
  if (!hostTick.over && finished.length && room.players.filter((p) => p.online).every((p) => finished.some((f) => f.id === p.id))) {
    hostTick.over = true;
    net.send({ t: 'end' });
  }
}
function markFinish(id, t) {
  if (finished.some((f) => f.id === id)) return;
  finished.push({ id, t });
  finished.sort((a, b) => a.t - b.t);
}
if (net) {
  net.on('room', (m) => {
    if (m.room.code !== ROOM) return;
    room = m.room;
    syncRoster();
    for (const p of room.players) ensureHero(p.hero);
    if (room.host === myId && !isHost) { isHost = true; hostSince = performance.now(); toast('Теперь ты ведёшь гонку'); }
  });
  net.on('act', (m) => {
    const a = m.a || {};
    if (a.k === 'rdy') ready.add(m.from);
    if (a.k === 'pos') {
      const r = riders.get(m.from);
      if (r && r.net && [a.s, a.x, a.y, a.v].every(Number.isFinite)) Object.assign(r.net, { s: a.s, x: a.x, y: a.y, v: a.v, route: course.routes[a.r] ? a.r : 0 });
    }
    if (a.k === 'fin' && Number.isFinite(a.t)) markFinish(m.from, a.t);
    if (a.k === 'bomb' && typeof a.id === 'string' && a.id.length < 24 && !riders.get(m.from)?.p.bombUsed) {
      applyBomb(m.from, a.id);
      if (isHost) relayBombs.push({ id: a.id, from: m.from, at: performance.now() });
    }
    if (a.k === 'shot' && typeof a.id === 'string' && a.id.length < 24) {
      remoteShot(a, m.from);
      if (isHost) relay.push({ k: 'shot', id: a.id, s: a.s, x: a.x, y: a.y, v: a.v, r: a.r, from: m.from, at: performance.now() });
    }
  });
  net.on('snap', (m) => {
    const s = m.s || {};
    if (s.left >= 0 && (state === 'wait' || state === 'load')) startCount(s.left);
    for (const [id, ss, x, y, v, route] of s.pl || []) {
      const r = riders.get(id);
      if (r && r.net) Object.assign(r.net, { s: ss, x, y, v, route: course.routes[route] ? route : 0 });
    }
    for (const f of s.fin || []) markFinish(f.id, f.t);
    for (const sh of s.sh || []) if (sh && typeof sh.id === 'string') remoteShot(sh, sh.from);
    for (const b of s.bm || []) if (b && typeof b.id === 'string' && b.from !== myId) applyBomb(b.from, b.id);
  });
  net.on('closed', (m) => { toast(m.msg, 6000); setTimeout(() => { location.href = 'lobby.html'; }, 2500); });
  net.on('kicked', (m) => toast(m.msg, 6000));
  net.on('down', () => toast('Связь пропала — переподключаемся…', 2000));
  net.on('welcome', () => net.send({ t: 'join', code: ROOM }));
}

/* ── запись гонки: 10 раз в секунду s, x, y, ветка и скорость каждого (целыми, в десятых) ── */
const REC_DT = 0.1;
const recorder = replay ? null : { id: `g${Date.now().toString(36)}`, at: Date.now(), next: 0, frames: {}, shots: [], bombs: [] };
function recordTick() {
  if (!recorder || !(state === 'go' || state === 'done') || raceT > 600) return;
  while (raceT >= recorder.next) {
    const i = Math.round(recorder.next / REC_DT);
    for (const r of riders.values()) {
      const f = (recorder.frames[r.id] ||= { start: i, d: [] }), p = r.p;
      if (f.start + f.d.length / 5 !== i) continue;            // гонщик пропал и вернулся — дальше не пишем
      f.d.push(Math.round(p.s * 10), Math.round(p.x * 10), Math.round(p.y * 10), p.route || 0, Math.round(p.v));
    }
    recorder.next += REC_DT;
  }
}
function saveReplay() {
  if (!recorder || raceT < 3) return;
  const me = finished.find((f) => f.id === myId);
  replays.save({
    v: 1, id: recorder.id, at: recorder.at, dt: REC_DT, name: def.name || 'Гонка',
    src: ROOM ? (room.map === 'track' ? { code: room.lv } : { level: room.level }) : def.custom ? { code: qs.get('code') } : { level: def.id },
    place: me ? finished.indexOf(me) + 1 : 0, time: me ? +me.t.toFixed(1) : 0,
    riders: [...riders.values()].filter((r) => recorder.frames[r.id]).map((r) => ({ id: r.id, name: r.isMe ? `${profile.emoji} ${profile.name || 'Ты'}` : r.name, color: r.color, ship: r.ship, kit: kitString(r.kit), me: r.isMe })),
    frames: recorder.frames, shots: recorder.shots, bombs: recorder.bombs, fin: finished.map((f) => ({ id: f.id, t: +f.t.toFixed(2) })),
  });
}
addEventListener('pagehide', saveReplay);

/* ── повтор: положение по записи с плавной подстановкой между кадрами ── */
let playT = 0, playSpeed = 1, playPaused = false, playShot = 0, playBomb = 0, playEnd = 0, playDone = false;
if (replay) {
  for (const f of Object.values(replay.frames)) playEnd = Math.max(playEnd, (f.start + f.d.length / 5 - 1) * replay.dt);
  const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  $('replay-bar').hidden = false;
  $('rp-play').onclick = () => { if (playDone) restartReplay(); else playPaused = !playPaused; $('rp-play').textContent = playPaused ? '▶' : '⏸'; };
  $('rp-speed').onclick = () => { playSpeed = playSpeed === 1 ? 2 : playSpeed === 2 ? 0.5 : 1; $('rp-speed').textContent = `×${playSpeed}`; };
  $('rp-cam').onclick = () => {
    const list = [...riders.values()], r = list[(list.indexOf(mine) + 1) % list.length];
    mine = r; myId = r.id; lookReady = false;
    toast(`👁 Смотрим за: ${r.name || 'тобой'}`, 1200);
  };
  $('rp-time').dataset.end = fmtT(playEnd);
  replayTick.fmtT = fmtT;
}
function restartReplay() {
  playT = 0; playShot = 0; playBomb = 0; playDone = false; finished.length = 0;
  for (const sh of shots) sh.dead = 'gone';
  $('overlay').classList.remove('show');
  $('rp-play').textContent = '⏸';
}
function replayTick(dt) {
  if (!playPaused && !playDone) playT = Math.min(playEnd, playT + dt * playSpeed);
  raceT = playT;
  const k = playT / replay.dt;
  for (const r of riders.values()) {
    const f = r.play;
    if (!f) continue;
    const n = f.d.length / 5, j = Math.max(0, Math.min(n - 1, k - f.start)), i = Math.min(n - 2, Math.floor(j)), t = Math.max(0, Math.min(1, j - i));
    const at = (q, c) => f.d[q * 5 + c];
    const i1 = Math.max(0, i + 1 < n ? i + 1 : i), p = r.p;
    const route = at(i1, 3);
    if (at(Math.max(0, i), 3) !== route) { p.route = t < 0.5 ? at(Math.max(0, i), 3) : route; } else p.route = route;
    const lerp = (c) => (at(Math.max(0, i), c) * (1 - t) + at(i1, c) * t);
    const ox = p.x, oy = p.y;
    p.s = lerp(0) / 10; p.x = lerp(1) / 10; p.y = lerp(2) / 10; p.v = lerp(4);
    p.vx = (p.x - ox) / Math.max(dt, 1e-3); p.vy = (p.y - oy) / Math.max(dt, 1e-3);
  }
  while (playShot < replay.shots.length && replay.shots[playShot][0] <= playT) {
    const [, s, x, y, route, owner, v] = replay.shots[playShot++];
    const r = riders.get(owner);
    if (course.routes[route]) spawnShot({ owner, route, s, x, y, v, t: 0, dead: null }, r ? r.color : '#ffffff');
  }
  const bl = replay.bombs || [];
  while (playBomb < bl.length && bl[playBomb][0] <= playT) { applyBomb(bl[playBomb][1], `rp${playBomb}`, true); playBomb++; }
  if (!playPaused) stepShots(dt * playSpeed);
  for (const f of replay.fin) if (f.t <= playT) markFinish(f.id, f.t);
  $('rp-time').textContent = `${replayTick.fmtT(playT)} / ${$('rp-time').dataset.end}`;
  if (playT >= playEnd && !playDone) {
    playDone = true;
    $('rp-play').textContent = '🔁';
    $('ov-title').textContent = '📼 Конец записи';
    $('ov-stars').textContent = '';
    drawTable();
    $('ov-buttons').innerHTML = `<button class="huge" type="button" id="rp-again">🔁 Сначала</button><a class="huge ghost" href="races.html#replays">📼 Записи</a>`;
    $('rp-again').onclick = restartReplay;
    $('overlay').classList.add('show');
  }
}

/* ── финиш ── */
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;
function showFinish() {
  if (state === 'done') return;
  state = 'done';
  const place = finished.findIndex((f) => f.id === myId) + 1;
  const stars = place === 1 ? 3 : place === 2 ? 2 : 1;
  if (!ROOM && !def.custom) {
    progress.setStars('race', def.id, stars);
    progress.unlock('race', def.id + 1);
    progress.setBest('race', def.id, Math.round(10000 / (finished.find((f) => f.id === myId)?.t || 1e9)));
  }
  audio.sfx(place === 1 ? 'win' : 'clear');
  if (qs.has('quest') && def.custom) import('./points.js').then(({ points }) => { const got = points.complete('fly'); if (got) toast(`🚀 Задание выполнено: +${got} ⭐`, 2600); });
  saveReplay();
  setTimeout(saveReplay, 6000);          // ещё немного: в запись попадут и те, кто финиширует следом
  $('ov-title').textContent = place === 1 ? '🏆 Первое место!' : `🏁 Место: ${place}`;
  $('ov-stars').textContent = ROOM || def.custom ? '' : '⭐'.repeat(stars);
  drawTable();
  const nextOk = !ROOM && MAPS.race.levels.some((l) => l.id === def.id + 1);
  $('ov-buttons').innerHTML = ROOM
    ? '<a class="huge" href="lobby.html">👫 В лобби</a>'
    : def.custom ? `<a class="huge" href="${esc(location.pathname.split('/').pop() + location.search)}">🔁 Ещё раз</a>${qs.get('edit') ? `<a class="huge rose" href="race-editor.html?edit=${encodeURIComponent(qs.get('edit'))}${qs.has('quest') ? '&quest=1' : ''}">🧱 В редактор</a>` : `<a class="huge rose" href="race-editor.html?code=${encodeURIComponent(qs.get('code'))}${qs.has('quest') ? '&quest=1' : ''}">🧱 Поменять</a>`}<a class="huge ghost" href="races.html">Трассы</a>`
    : `<a class="huge" href="race.html?level=${def.id}">🔁 Ещё раз</a>${nextOk ? `<a class="huge rose" href="race.html?level=${def.id + 1}">🚀 Следующая</a>` : ''}<a class="huge ghost" href="map.html?map=race">Трассы</a>`;
  if (recorder) $('ov-buttons').insertAdjacentHTML('beforeend', `<a class="huge ghost" href="race.html?replay=${recorder.id}${qs.has('debug') ? '&debug' : ''}" id="btn-replay">📼 Повтор</a>`);
  $('btn-replay')?.addEventListener('click', saveReplay);
  $('overlay').classList.add('show');
}
function drawTable() {
  const rows = [...riders.values()].map((r) => ({ r, f: finished.find((x) => x.id === r.id) }))
    .sort((a, b) => (a.f && b.f ? a.f.t - b.f.t : a.f ? -1 : b.f ? 1 : b.r.p.s - a.r.p.s));
  $('ov-table').innerHTML = rows.map(({ r, f }, i) => `<div class="r${r.isMe ? ' me' : ''}" style="--c:${esc(r.color)}"><b>${i + 1}</b><span class="d"></span><span class="n">${esc(r.name)}</span><span>${f ? fmt(f.t) : 'летит…'}</span></div>`).join('');
}

/* ── кадр ── */
const camS = { x: 0, y: 3, shake: 0 };
const dots = new Map();
const clock = new THREE.Clock();
const a3 = [0, 0, 0], b3 = [0, 0, 0], c3 = [0, 0, 0], d3 = [0, 0, 0];
const up = new THREE.Vector3(), look = new THREE.Vector3(), look2 = new THREE.Vector3();
let lookReady = false;
let wasCount = '';

function onEvents(ev) {
  for (const [e] of ev) {
    if (e === 'hit') { audio.sfx('hurt'); camS.shake = 0.5; toast('Ой! Врезался', 900); document.body.classList.add('hurt'); setTimeout(() => document.body.classList.remove('hurt'), 220); }
    if (e === 'wall') { audio.sfx('hit'); camS.shake = Math.max(camS.shake, 0.22); }
    if (e === 'boost') { audio.sfx('hop', 1.4); toast('🚀 Ускорение!', 700); }
    if (e === 'fork') audio.sfx('jump');
    if (e === 'wind') windFx(ev.find((q) => q[0] === 'wind')[1]);
    if (e === 'fin') {
      markFinish(myId, mine.p.fin);
      if (net && !isHost) net.send({ t: 'act', a: { k: 'fin', t: +mine.p.fin.toFixed(2) } });
      setTimeout(showFinish, 900);
    }
  }
}

function step(dt) {
  raceT += dt;
  readInput();
  const n = Math.max(1, Math.ceil(dt / (1 / 60)));
  for (let i = 0; i < n; i++) {
    const h = dt / n;
    if (mine.p.fin) { input.x = 0; input.y = 0; input.brake = true; }
    onEvents(stepRacer(mine.p, input, course, raceT, h));
    for (const r of riders.values()) {
      if (!r.skill) continue;
      botInput(r.p, course, raceT, r.skill, r.inp ||= { x: 0, y: 0, brake: false });
      const ev = stepRacer(r.p, r.inp, course, raceT, h, r.skill.vmaxK);
      if (ev.some(([e]) => e === 'fin')) markFinish(r.id, r.p.fin);
    }
    stepShots(h);
  }
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (audio.ctx) audio.schedule();
  if (state === 'count') {
    const left = (goAt - performance.now()) / 1000;
    const label = left > 2 ? '3' : left > 1 ? '2' : left > 0 ? '1' : 'ЛЕТИМ!';
    if (label !== wasCount) { wasCount = label; $('count').textContent = label; $('count').hidden = false; audio.sfx(left > 0 ? 'jump' : 'wave'); }
    if (left <= 0) { state = 'go'; raceT = 0; setTimeout(() => { $('count').hidden = true; }, 700); }
  }
  if (replay) replayTick(dt);
  else if (state === 'go' || state === 'done') step(dt);
  if (state === 'wait' && !ROOM && !replay) startCount(3200);
  recordTick();

  // чужие догоняют снимок и продолжают лететь по скорости, пока нет нового
  for (const r of riders.values()) {
    if (!r.net || replay) continue;
    const q = r.net, p = r.p, f = Math.min(1, dt * 7);
    const vx = (q.x - p.x) * f / Math.max(dt, 1e-3), vy = (q.y - p.y) * f / Math.max(dt, 1e-3);
    p.s += (q.s - p.s) * f; p.x += (q.x - p.x) * f; p.y += (q.y - p.y) * f;
    q.s += q.v * dt; p.v = q.v; p.vx = vx; p.vy = vy;
    if ((p.route || 0) !== (q.route || 0)) { p.route = q.route; p.s = q.s; p.x = q.x; p.y = q.y; }   // перешёл на другую ветку
  }
  for (const r of riders.values()) r.place(r.p.s, r.p.x, r.p.y, r.p.vx, r.p.vy, r.p.v, dt);
  drawShots(dt);
  const sp = mine.p, spTrack = routeOf(course, sp);
  const nextFork = spTrack.forks[sp.nf || 0];
  if (nextFork && !sp.forkTold && nextFork.s - sp.s < Math.max(70, sp.v * 1.6)) { sp.forkTold = true; toast('🔀 Развилка: рули в нужную сторону!', 1800); setTimeout(() => { sp.forkTold = false; }, 3000); }
  for (const s of spinners) s.hub.rotation.z = barAngle(s.o, raceT);
  for (const m of tumblers) { m.rotation.x += dt * 0.6; m.rotation.y += dt * 0.4; }
  for (const f of fans) { f.blades.rotation.z += dt * 7 * f.w; f.arrows.position.z = -(((raceT * 9 * f.w) % 6 + 6) % 6 - 3); }

  // камера за спиной: чуть отстаёт в сечении, поэтому занос виден
  const k = Math.min(1, dt * 6);
  camS.x += (sp.x * 0.62 - camS.x) * k;
  camS.y += (sp.y * 0.62 + 3 - camS.y) * k;
  camS.shake = Math.max(0, camS.shake - dt * 1.6);
  const cs = Math.max(0, sp.s - 11);
  sample(spTrack, cs, spTrack.pos, a3); sample(spTrack, cs, spTrack.right, b3); sample(spTrack, cs, spTrack.up, c3);
  const sx = camS.shake ? (Math.random() - 0.5) * camS.shake * 2 : 0, sy = camS.shake ? (Math.random() - 0.5) * camS.shake * 2 : 0;
  camera.position.set(a3[0] + b3[0] * (camS.x + sx) + c3[0] * (camS.y + sy), a3[1] + b3[1] * (camS.x + sx) + c3[1] * (camS.y + sy), a3[2] + b3[2] * (camS.x + sx) + c3[2] * (camS.y + sy));
  up.set(c3[0], c3[1], c3[2]);
  camera.up.copy(up);
  const ls = sp.s + 24;
  sample(spTrack, ls, spTrack.pos, d3); sample(spTrack, ls, spTrack.right, b3); sample(spTrack, ls, spTrack.up, c3);
  look2.set(d3[0] + b3[0] * sp.x * 0.5 + c3[0] * sp.y * 0.5, d3[1] + b3[1] * sp.x * 0.5 + c3[1] * sp.y * 0.5, d3[2] + b3[2] * sp.x * 0.5 + c3[2] * sp.y * 0.5);
  // на развилке точка взгляда перескакивает на выбранную ветку: камера доворачивает плавно
  if (course.routes.length > 1 && lookReady) look.lerp(look2, Math.min(1, dt * 7)); else look.copy(look2);
  lookReady = true;
  camera.lookAt(look);
  const kv = Math.min(1.3, sp.v / def.vmax);
  const fov = 58 + 26 * kv * kv;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
  if (window.__raceCam) window.__raceCam(camera);      // своя камера для ролика (tools/race-ad.mjs)
  sky.position.copy(camera.position);

  // панель
  $('speed-num').textContent = Math.round(sp.v * 10);
  $('speed-fill').style.width = `${Math.min(100, (sp.v / def.vmax) * 100)}%`;
  $('drift-chip').hidden = !(sp.slip > 0.42 && state === 'go');
  $('clock').textContent = replay ? fmt(playT) : state === 'go' || state === 'done' ? fmt(mine.p.fin || raceT) : '0:00';
  const order = [...riders.values()].sort((a, b) => {
    const fa = finished.findIndex((x) => x.id === a.id), fb = finished.findIndex((x) => x.id === b.id);
    if (fa >= 0 && fb >= 0) return fa - fb;
    if (fa >= 0) return -1;
    if (fb >= 0) return 1;
    return b.p.s / routeOf(course, b.p).length - a.p.s / routeOf(course, a.p).length;
  });
  $('place').textContent = order.findIndex((r) => r.id === myId) + 1;
  for (const r of riders.values()) {
    let d = dots.get(r.id);
    if (!d) {
      d = document.createElement('i');
      d.className = `dot${r.isMe ? ' me' : ''}`;
      d.style.setProperty('--c', r.color);
      $('track-bar').appendChild(d);
      dots.set(r.id, d);
    }
    d.style.left = `${Math.min(100, (r.p.s / routeOf(course, r.p).length) * 100)}%`;
  }
  for (const [id, d] of dots) if (!riders.has(id)) { d.remove(); dots.delete(id); }
  if ($('overlay').classList.contains('show')) drawTable();

  // отправка позиции ~10 раз в секунду
  if (net) {
    sendT -= dt;
    if (sendT <= 0) {
      sendT = 0.1;
      if (isHost) hostTick();
      else if (state === 'go' || state === 'done') net.send({ t: 'act', a: { k: 'pos', s: Math.round(sp.s), x: +sp.x.toFixed(1), y: +sp.y.toFixed(1), v: Math.round(sp.v), r: sp.route || 0 } });
      else if (state === 'wait') net.send({ t: 'act', a: { k: 'rdy' } });
    }
  }

  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
}

state = replay ? 'go' : 'wait';
if (ROOM) $('wait-host').classList.add('show');
$('loading').classList.add('done');
$('place-of').textContent = riders.size;
tick();
if (replay) toast(`📼 Повтор: ${replay.name}`, 2500);
else {
  toast(matchMedia('(pointer: coarse)').matches ? 'Лети пальцем слева, справа — тормоз. 🌬️ попутный ветер разгоняет, 🌀 встречный тормозит!' : 'WASD или стрелки — лететь, пробел — тормоз. 🌬️ попутный ветер разгоняет, 🌀 встречный тормозит!', 3500);
}
if (qs.has('debug')) window.__race = { riders, get mine() { return mine; }, get state() { return state; }, get track() { return routeOf(course, mine.p); }, course, finished, joy, camera, get raceT() { return raceT; }, get isHost() { return isHost; }, shots, shoot, bomb,
  saveReplay, get recorder() { return recorder; }, get playT() { return playT; }, replay };
