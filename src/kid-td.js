/**
 * «Хвосты» — башенная защита для детей 4–8 лет: графика, ввод, звук.
 * Логика боя — в sim.js. Здесь три режима:
 *   solo   — sim крутится прямо тут;
 *   host   — sim крутится тут и ~12 раз в секунду рассылается снимок остальным;
 *   client — sim не крутится: рисуем снимки хоста, действия отправляем ему.
 * Рисование одинаковое во всех режимах: из «вида» (view) — того, что сейчас на поле.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { touchCamera, instantPress, thumbZone } from './touch-camera.js';
import { audio } from './audio.js';
import { mapById, resolveLevel, spotsOf, houseOf, pathsOf, progress, teamLevel } from './levels.js';
import { HERO, Sim, FRIENDS, FRIEND_KEYS, Path, mazeState, starsFor, towerStats, START_TAILS, DANCE_LEN } from './sim.js';
import { Net, me as myProfile } from './net.js';
import { myLevels } from './custom.js';
import { Runner, Joystick, loadRunnerModel, makeLabel, HEROES, ghostKit } from './runner.js';

const $ = (id) => document.getElementById(id);
const rnd = (a, b) => a + Math.random() * (b - a);
const qs = new URLSearchParams(location.search);
const DEBUG = qs.has('debug');

/* ─────────────────── модели ─────────────────── */

const MODELS = {
  dancer: {
    url: 'models/tiny-dancer.opt.glb', height: 6.4,
    clips: { idle: 'Walking', walk: 'Walking', run: 'Running', dance: 'Running', attack: 'Running' },
    idleSpeed: 0.35,
  },
  maskot: {
    url: 'models/maskot.web.glb', height: 6.8,
    clips: { idle: 'Stylish_Walk_inplace', walk: 'Walking', run: 'Running',
             dance: 'All_Night_Dance', attack: 'Fast_Lightning' },
    idleSpeed: 0.7,
  },
  castle: { stages: [1, 2, 3, 4].map((n) => `assets/castle/stage${n}.glb`) },
};

/* ─────────────────── кто мы и где играем ─────────────────── */

const ROOM = (qs.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const profile = myProfile();
let net = null, room = null, myId = 1, isHost = !ROOM;
let level = null;

function failPage(text) {
  $('load-text').textContent = text;
  $('loading').insertAdjacentHTML('beforeend', '<a class="huge ghost" href="index.html" style="margin-top:12px">🏠 Домой</a>');
  throw new Error(text);
}

if (ROOM) {
  $('load-text').textContent = `Входим в командную игру ${ROOM}…`;
  net = new Net();
  await net.connect({ name: profile.name || 'Игрок', color: profile.color, emoji: profile.emoji });
  myId = net.id;
  room = await new Promise((resolve) => {
    const t = setTimeout(() => failPage(`Не получилось войти в игру ${ROOM}`), 8000);
    const onRoom = (m) => { if (m.room.code === ROOM && !room) { clearTimeout(t); resolve(m.room); } };
    net.on('room', onRoom);
    net.on('error', (m) => { if (!room) { clearTimeout(t); failPage(m.msg); } });
    net.send({ t: 'join', code: ROOM });
  });
  level = resolveLevel(room.map, room.level, room.lv);
  isHost = room.host === myId;
  if (!level) failPage('Этот уровень не открывается');
  // название чужого уровня из редактора — свободный текст: остальным игрокам его не показываем
  if (level.map === 'custom' && !isHost) level = { ...level, name: 'Свой уровень' };
} else {
  const my = qs.get('my') && myLevels.get(qs.get('my'));
  level = resolveLevel(my ? 'custom' : qs.get('map') || (qs.get('level') === 'castle' ? 'castle' : 'quay'),
                       qs.get('level') || 1, my ? my.code : qs.get('code'));
  if (!level) failPage('Уровень не открывается — проверь код');
}
const TEAM = !!ROOM;
const customBack = qs.get('from') === 'editor' ? 'editor.html' : 'map.html?map=custom';
if (TEAM) level = teamLevel(level);
const MAP = level.map === 'custom' ? { id: 'custom', name: 'Мои уровни', levels: [] } : mapById(level.map);
document.title = `Хвосты — ${level.name}`;
try { localStorage.setItem('tails.choice', level.map); } catch (e) { /* */ }

const SPOTS2 = spotsOf(level);                       // [[x,z(,можно строить)]]
const SPOTS = SPOTS2.map(([x, z]) => new THREE.Vector3(x, 0, z));
const PATHS = pathsOf(level).map((p) => p.map(([x, z]) => new THREE.Vector3(x, 0, z)));
const SIMPATHS = pathsOf(level).map((p) => new Path(p));
const MAZE = !!level.maze;
const FRIEND_IDS = level.friends;
const CASTLE = FRIEND_IDS.includes('castle');
const RUNNER_ON = level.map !== 'quay' || TEAM || qs.has('runner');   // в командной игре персонажи бегают на всех картах
if (CASTLE) $('load-text').textContent = 'Носим камни для замка…';

/* ─────────────────── сцена ─────────────────── */

const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: DEBUG });
} catch (err) {   // нет WebGL: иначе экран загрузки остаётся навсегда
  failPage('Это устройство не смогло запустить 3D-графику :( / This device could not start 3D graphics');
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(level.sky);
scene.fog = new THREE.Fog(level.sky, 120, 300);

const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 400);
camera.position.set(0, 38, 40);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 14;
controls.maxDistance = 90;
controls.maxPolarAngle = Math.PI * 0.45;
const touchCam = touchCamera(canvas, camera, controls, { left: $('spin-left'), right: $('spin-right') });

scene.add(new THREE.HemisphereLight(0xdff4ff, 0x6f8a63, 1.1));
const sun = new THREE.DirectionalLight(0xfff4d8, 2.2);
sun.position.set(20, 34, 16);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.top = sun.shadow.camera.right = 60;
sun.shadow.camera.bottom = sun.shadow.camera.left = -60;
sun.shadow.camera.far = 120;
sun.shadow.bias = -0.0015;
sun.shadow.normalBias = 0.03;
scene.add(sun);

const allPts = [...PATHS.flat(), ...SPOTS];
const LAND_R = Math.max(46, ...allPts.map((p) => Math.hypot(p.x, p.z) + 7));

const sea = new THREE.Mesh(new THREE.PlaneGeometry(500, 500),
  new THREE.MeshStandardMaterial({ color: level.sea, roughness: 0.35, metalness: 0.1 }));
sea.rotation.x = -Math.PI / 2;
sea.position.y = -0.6;
scene.add(sea);

const land = new THREE.Mesh(new THREE.CircleGeometry(LAND_R, 72),
  new THREE.MeshStandardMaterial({ color: level.land, roughness: 1 }));
land.rotation.x = -Math.PI / 2;
land.receiveShadow = true;
scene.add(land);

const stoneMat = new THREE.MeshStandardMaterial({ color: 0xe3d7c0, roughness: 0.95 });
const LANE_TINT = [0xe3d7c0, 0xf0d2c4, 0xcfe0c8, 0xd8d0ea];
PATHS.forEach((P, li) => {
  const mat = PATHS.length > 1 ? new THREE.MeshStandardMaterial({ color: LANE_TINT[li % 4], roughness: 0.95 }) : stoneMat;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const road = new THREE.Mesh(new THREE.BoxGeometry(a.distanceTo(b) + 6.2, 0.4, 6.2), mat);
    road.position.copy(a).lerp(b, 0.5).setY(0.05 + li * 0.003);
    road.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    road.receiveShadow = true;
    scene.add(road);
  }
});

// домик (общий для всех дорожек) и калитки у стартов
const house = new THREE.Group();
const walls = new THREE.Mesh(new THREE.BoxGeometry(10, 7, 10), new THREE.MeshStandardMaterial({ color: 0xf6efe2, roughness: 0.9 }));
walls.position.y = 3.5;
const roof = new THREE.Mesh(new THREE.ConeGeometry(8.8, 4.8, 4), new THREE.MeshStandardMaterial({ color: 0xd9663f, roughness: 0.8 }));
roof.position.y = 9.4;
roof.rotation.y = Math.PI / 4;
house.add(walls, roof);
house.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
const HOUSE = houseOf(level);
house.position.set(HOUSE[0], 0, HOUSE[1]);
if (MAZE) house.scale.setScalar(0.62);
scene.add(house);

const gateMat = new THREE.MeshStandardMaterial({ color: 0x3a3550, roughness: 0.7 });
const gateAt = (p, toward) => {
  const g = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.5, 10, 24, Math.PI), gateMat);
  g.position.copy(p).setY(0.3);
  g.rotation.y = Math.atan2(toward.z - p.z, toward.x - p.x);
  g.castShadow = true;
  scene.add(g);
};
for (const P of PATHS) gateAt(P[0], P[1]);

/* ── «Открытое поле»: клетки, камни и подсветка текущего маршрута ── */

let mz = null;
const routeDots = new THREE.Group();
scene.add(routeDots);
if (MAZE) {
  mz = mazeState(level, new Set());
  const g = new THREE.Mesh(new THREE.BoxGeometry(level.maze.w * 6 + 2, 0.3, level.maze.h * 6 + 2),
    new THREE.MeshStandardMaterial({ color: 0xd9ccb0, roughness: 1 }));
  g.position.y = 0.02;
  g.receiveShadow = true;
  scene.add(g);
  for (const k of mz.rocks) {
    const [x, z] = mz.grid.center(k);
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(2.6), new THREE.MeshStandardMaterial({ color: 0x9a9488, roughness: 1 }));
    r.position.set(x, 1.6, z);
    r.castShadow = true;
    scene.add(r);
  }
  for (const s of mz.spawns) {
    const [x, z] = mz.grid.center(s);
    gateAt(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 0, z + 1));
  }
}
const dotGeo = new THREE.SphereGeometry(0.45, 8, 6);
const dotMat = new THREE.MeshBasicMaterial({ color: 0xff8fb0, transparent: true, opacity: 0.8 });
function redrawRoute(towers) {
  if (!MAZE) return;
  mz = mazeState(level, new Set(towers.keys()));
  routeDots.clear();
  for (const r of mz.routes) {
    if (!r) continue;
    for (const k of r) {
      const [x, z] = mz.grid.center(k);
      const d = new THREE.Mesh(dotGeo, dotMat);
      d.position.set(x, 0.5, z);
      routeDots.add(d);
    }
  }
}

// зелень — не на дороге, не на плитах
const isTreeFree = (p) => !PATHS.some((P) => P.some((w) => w.distanceTo(p) < 8))
  && !SPOTS.some((s) => s.distanceTo(p) < (CASTLE ? 9 : 6)) && p.distanceTo(house.position) > 8
  && (!MAZE || Math.abs(p.x) > level.maze.w * 3 + 3 || Math.abs(p.z) > level.maze.h * 3 + 3);
for (let i = 0; i < 46; i++) {
  const ang = Math.random() * Math.PI * 2, r = rnd(10, LAND_R - 1);
  const p = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
  if (!isTreeFree(p)) continue;
  const t = new THREE.Group();
  if (Math.random() < 0.55) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(rnd(1, 1.7), rnd(5.5, 9), 7), new THREE.MeshStandardMaterial({ color: 0x2f5d3f, roughness: 1 }));
    c.position.y = 4;
    t.add(c);
  } else {
    const b = new THREE.Mesh(new THREE.SphereGeometry(rnd(1.4, 2.4), 10, 8),
      new THREE.MeshStandardMaterial({ color: Math.random() < 0.5 ? 0xff8fb0 : 0xffd447, roughness: 1 }));
    b.position.y = 1.9;
    t.add(b);
  }
  t.position.copy(p);
  t.traverse((o) => { o.castShadow = true; });
  scene.add(t);
}

// площадки (в лабиринте — квадратные клетки)
const spotMeshes = SPOTS.map((p, i) => {
  if (SPOTS2[i][2] === 0) return null;
  const disc = MAZE
    ? new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.36, 5.6),
      new THREE.MeshStandardMaterial({ color: 0xf3e6c8, roughness: 0.9, emissive: 0x2a2410, emissiveIntensity: 0.25 }))
    : new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 0.5, 22),
      new THREE.MeshStandardMaterial({ color: 0xf3e6c8, roughness: 0.9, emissive: 0x2a2410, emissiveIntensity: 0.4 }));
  disc.position.copy(p).setY(0.2);
  disc.receiveShadow = true;
  disc.userData.spotIndex = i;
  scene.add(disc);
  if (!MAZE) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.9, 0.16, 8, 30),
      new THREE.MeshBasicMaterial({ color: 0xffd447, transparent: true, opacity: 0.75 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(p).setY(0.55);
    scene.add(ring);
    disc.userData.ring = ring;
  }
  return disc;
});
const pickable = spotMeshes.filter(Boolean);

const rangeRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.04, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
rangeRing.rotation.x = -Math.PI / 2;
rangeRing.visible = false;
scene.add(rangeRing);

/* ─────────────────── персонажи ─────────────────── */

const loaded = {};

class Actor {
  constructor(kind, { tint = 0xffffff, scale = 1, clip = 'idle', dark = false } = {}) {
    const src = loaded[kind];
    this.kind = kind;
    this.def = MODELS[kind];
    this.root = new THREE.Group();
    this.model = cloneSkinned(src.gltf.scene);
    this.model.scale.setScalar(src.scale * scale);
    this.root.add(this.model);
    this.hips = null;
    this.model.traverse((o) => {
      if (o.isBone && !this.hips && /hips/i.test(o.name)) this.hips = o;
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = !dark;
      o.frustumCulled = false;
      o.material = o.material.clone();
      o.material.color = new THREE.Color(tint);
      if (dark) { o.material.emissive = new THREE.Color(0x140a26); o.material.emissiveIntensity = 0.55; }
    });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const c of src.gltf.animations) this.actions[c.name] = this.mixer.clipAction(c);
    this.current = null;
    this._v = new THREE.Vector3();
    this.play(clip, clip === 'idle' ? this.def.idleSpeed : 1, 0);
  }

  play(semantic, timeScale = 1, fade = 0.22) {
    const name = this.def.clips[semantic] || semantic;
    const a = this.actions[name] || Object.values(this.actions)[0];
    if (!a) return;
    a.reset();
    a.setEffectiveTimeScale(timeScale);
    a.setEffectiveWeight(1);
    a.play();
    if (fade > 0) a.fadeIn(fade);
    if (this.current && this.current !== a) { fade > 0 ? this.current.fadeOut(fade) : this.current.stop(); }
    this.current = a;
  }

  setSpeed(t) { if (this.current) this.current.setEffectiveTimeScale(t); }

  update(dt) {
    this.mixer.update(dt);
    if (this.hips) {
      this.hips.updateWorldMatrix(true, false);
      this._v.setFromMatrixPosition(this.hips.matrixWorld);
      this.root.worldToLocal(this._v);
      this.model.position.x -= this._v.x;
      this.model.position.z -= this._v.z;
    }
  }
}

const castleStages = [];
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

class CastleActor {
  constructor() {
    this.root = new THREE.Group();
    this.def = { idleSpeed: 1, clips: {} };
    this.stage = 0;
    this.model = null;
    this.old = [];
    this.grow = 1;
    this.yaw = 0;
    this.aimYaw = 0;
    this.setStage(1);
  }

  setStage(n) {
    n = Math.max(1, Math.min(castleStages.length, n));
    if (n === this.stage) { this.grow = 0.55; return; }
    if (this.model) this.old.push({ obj: this.model, t: 0 });
    this.stage = n;
    this.model = castleStages[n - 1].clone();
    this.model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.ballista = this.model.getObjectByName('ballista');
    if (this.ballista) this.ballista.rotation.y = this.yaw;
    this.root.add(this.model);
    this.grow = 0;
    this.update(0);
  }

  play() {}
  setSpeed() {}

  aim(target) {
    const b = this.ballista;
    if (!b) return;
    b.getWorldPosition(this._p || (this._p = new THREE.Vector3()));
    this.aimYaw = Math.atan2(target.x - this._p.x, target.z - this._p.z);
  }

  muzzle(out) {
    if (this.ballista) return this.ballista.getWorldPosition(out).setY(out.y + 1.35);
    return out.copy(this.root.position).setY(4);
  }

  update(dt) {
    if (this.grow < 1) {
      this.grow = Math.min(1, this.grow + dt / 0.7);
      const k = easeOutBack(this.grow);
      this.model.scale.set(0.85 + 0.15 * k, Math.max(0.02, k), 0.85 + 0.15 * k);
    }
    for (let i = this.old.length - 1; i >= 0; i--) {
      const o = this.old[i];
      o.t += dt / 0.35;
      o.obj.scale.set(1 + 0.05 * o.t, Math.max(0.01, 1 - o.t), 1 + 0.05 * o.t);
      if (o.t >= 1) { this.root.remove(o.obj); this.old.splice(i, 1); }
    }
    if (this.ballista) {
      let d = this.aimYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 8);
      this.ballista.rotation.y = this.yaw;
    }
  }
}

/* привидения — весёлые, не страшные */
class GhostActor {
  constructor(scale = 1) {
    const k = ghostKit;
    this.root = new THREE.Group();
    this.def = { idleSpeed: 1, clips: {} };
    this.model = new THREE.Group();
    this.model.scale.setScalar(scale);
    this.root.add(this.model);
    const hue = [0xeaf6ff, 0xdff0ff, 0xf1ecff][Math.floor(Math.random() * 3)];
    this.mat = new THREE.MeshStandardMaterial({ color: hue, emissive: 0x9fd8ff, emissiveIntensity: 0.35,
      roughness: 0.5, transparent: true, opacity: 0.65, depthWrite: false });
    this.base = rnd(0.58, 0.7);
    this.model.add(new THREE.Mesh(k.body, this.mat));
    this.face = new THREE.Group();
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(k.eye, k.dark);
      e.position.set(s * 0.5, 3.55, 1.28);
      e.scale.set(1, 1.15, 0.5);
      const h = new THREE.Mesh(k.shine, k.white);
      h.position.set(s * 0.5 + 0.09, 3.68, 1.43);
      const c = new THREE.Mesh(k.cheek, k.blush);
      c.position.set(s * 0.9, 3.05, 1.2);
      c.rotation.y = s * 0.55;
      const a = new THREE.Mesh(k.arm, this.mat);
      a.position.set(s * 1.55, 2.6, 0.3);
      a.scale.set(0.8, 0.55, 0.7);
      this.face.add(e, h, c, a);
    }
    const m = new THREE.Mesh(k.mouth, k.dark);
    m.position.set(0, 2.95, 1.42);
    this.face.add(m);
    this.model.add(this.face);
    this.blobMat = new THREE.MeshBasicMaterial({ color: 0x24304a, transparent: true, opacity: 0.22, depthWrite: false });
    this.blob = new THREE.Mesh(k.blob, this.blobMat);
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.32;
    this.blob.scale.setScalar(scale);
    this.root.add(this.blob);
    this.time = Math.random() * 10;
    this.rate = 1;
    this.flash = 0;
    this.fade = 1;
  }

  play() {}
  setSpeed(t) { this.rate = t; }
  hit() { this.flash = 1; }

  update(dt) {
    this.time += dt * (0.6 + 0.4 * this.rate);
    const t = this.time;
    this.model.position.y = 1.1 + Math.sin(t * 2.4) * 0.45;
    const cam = Math.atan2(camera.position.x - this.root.position.x, camera.position.z - this.root.position.z);
    this._q = this._q || new THREE.Quaternion();
    this._e = this._e || new THREE.Euler(0, 0, 0, 'YXZ');
    this._e.set(0.08 + Math.sin(t * 2.4 + 1) * 0.05, cam, Math.sin(t * 1.7) * 0.09);
    this.model.quaternion.copy(this.root.quaternion).invert().multiply(this._q.setFromEuler(this._e));
    this.blob.scale.setScalar(this.model.scale.x * (1 - Math.sin(t * 2.4) * 0.12));
    this.flash = Math.max(0, this.flash - dt * 4);
    const flicker = Math.sin(t * 5.3) * 0.04 + Math.sin(t * 13.1) * 0.02;
    this.mat.opacity = (this.base + flicker - this.flash * 0.3) * this.fade;
    this.mat.emissiveIntensity = 0.35 + this.flash * 0.8;
  }

  vanish(dt) {
    this.fade = Math.max(0, this.fade - dt / 0.6);
    this.update(dt);
    const g = 1 + (1 - this.fade) * 0.5;
    this.model.scale.setScalar(this.model.userData.s0 * g);
    this.model.position.y += (1 - this.fade) * 2.5;
    this.face.visible = this.fade > 0.35;
    this.blobMat.opacity = 0.22 * this.fade;
    return this.fade <= 0;
  }
}

/* ─────────────────── эффекты ─────────────────── */

const fx = { balls: [], drops: [], vanishing: [] };

function puff(pos, scale = 1) {
  for (let i = 0; i < 7; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(rnd(0.5, 0.9) * scale, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xf4f9ff, transparent: true, opacity: 0.7, depthWrite: false }));
    const a = (i / 7) * Math.PI * 2;
    m.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * 0.8, rnd(2.5, 4.2) * scale, Math.sin(a) * 0.8));
    scene.add(m);
    fx.vanishing.push({ puff: m, life: 0, vx: Math.cos(a) * 1.6, vz: Math.sin(a) * 1.6 });
  }
}

function sparks(pos, n = 4, color = 0xffd447) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color }));
    m.position.copy(pos).add(new THREE.Vector3(rnd(-0.6, 0.6), rnd(1, 2), rnd(-0.6, 0.6)));
    scene.add(m);
    fx.drops.push({ mesh: m, life: 0.9, vy: rnd(1.5, 3) });
  }
}

function makeBar() {
  const g = new THREE.Group();
  const back = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.42), new THREE.MeshBasicMaterial({ color: 0x2a1c3a }));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.42), new THREE.MeshBasicMaterial({ color: 0xff6f91 }));
  fill.position.z = 0.01;
  g.add(back, fill);
  g.userData.fill = fill;
  return g;
}

/* ─────────────────── «вид»: что сейчас на поле ─────────────────── */

/**
 * view — общий формат для рисования (одиночная игра, хост и клиент):
 *   players: Map id → { id, shells, active, x, z, ry, run, name, color, emoji, built, kills }
 *   towers:  Map spot → { id, owner, level }
 *   enemies: Map id → { pi, d, x, z, hp, maxHp, speed, slow, ghost, big, scale }
 */
const view = { players: new Map(), towers: new Map(), enemies: new Map(), wave: 0, tails: START_TAILS,
               over: false, won: false, running: false, danceLeft: 0, danceReadyIn: 0, queue: 0, time: 0 };
let sim = null;
let lastSnap = null, lastSnapAt = 0;
const roster = new Map();     // из комнаты: id → {name,color,emoji,online}

function viewFromSim() {
  view.players = sim.players;
  view.towers = sim.towers;
  view.wave = sim.wave; view.tails = sim.tails; view.over = sim.over; view.won = sim.won; view.running = sim.running;
  view.danceLeft = Math.max(0, sim.danceUntil - sim.time); view.danceReadyIn = Math.max(0, sim.danceReady - sim.time);
  view.queue = sim.queue.length; view.time = sim.time;
  const seen = new Set();
  for (const e of sim.enemies) { seen.add(e.id); view.enemies.set(e.id, e); }
  for (const id of view.enemies.keys()) if (!seen.has(id)) view.enemies.delete(id);
}

/** Клиент: снимок хоста → вид. Положение теней дальше «доезжает» само между снимками. */
function viewFromSnap(s) {
  const players = new Map();
  for (const [id, shells, active, built, kills, x, z, ry, run, idle, , lives, downLeft, , grow] of s.p) {
    const r = roster.get(id) || {};
    players.set(id, { id, shells, active: !!active, built, kills, x, z, ry, run, idle: !!idle, lives: lives ?? 0, down: downLeft > 0, grow: grow || 1,
                      name: r.name || '', color: r.color || '#ffd447', emoji: r.emoji || '🦊' });
  }
  view.players = players;
  const towers = new Map();
  for (const [spot, fi, lvl, owner] of s.tw) towers.set(spot, { id: FRIEND_KEYS[fi], owner, level: lvl });
  view.towers = towers;
  view.wave = s.w; view.tails = s.h; view.over = s.o > 0; view.won = s.o === 2; view.running = !!s.r;
  view.danceLeft = s.du; view.danceReadyIn = s.dr; view.queue = s.q.reduce((n, r) => n + r[0], 0); view.time = s.t;
  const seen = new Set();
  for (const [id, pi, a, b, hp, maxHp, sp, slow, fl] of s.e) {
    seen.add(id);
    let e = view.enemies.get(id);
    if (!e) {
      e = { id, pi, d: pi >= 0 ? a : 0, x: pi < 0 ? a : 0, z: pi < 0 ? b : 0, ghost: !!(fl & 1), big: !!(fl & 2), scale: fl & 2 ? 1.9 : 1 };
      if (pi >= 0) SIMPATHS[pi].at(e.d, e);
      view.enemies.set(id, e);
    }
    e.hp = hp; e.maxHp = maxHp; e.speed = sp / 100; e.slow = slow;
    if (pi >= 0) { e.td = a; if (Math.abs(e.td - e.d) > 2.5) e.d = e.td; }   // сильно разошлись (кадры тормозят) — прыжком
    else { e.tx = a; e.tz = b; if (Math.hypot(a - e.x, b - e.z) > 2.5) { e.x = a; e.z = b; } }
  }
  for (const id of view.enemies.keys()) if (!seen.has(id)) view.enemies.delete(id);
}

/** Клиент: между снимками тени идут сами (предсказание) и плавно подтягиваются к снимку. */
function advanceClient(dt) {
  const dancing = view.danceLeft > 0;
  view.danceLeft = Math.max(0, view.danceLeft - dt);
  view.danceReadyIn = Math.max(0, view.danceReadyIn - dt);
  for (const e of view.enemies.values()) {
    if (e.pi >= 0) {
      const k = (dancing ? 0.5 : 1) * (e.slow > 0 ? 0.45 : 1);
      e.slow = Math.max(0, e.slow - dt);
      e.td += e.speed * k * dt;
      e.d += e.speed * k * dt;
      e.d += (e.td - e.d) * Math.min(1, dt * 6);
      SIMPATHS[e.pi].at(e.d, e);
    } else {
      const f = Math.min(1, dt * 10);
      e.x += (e.tx - e.x) * f; e.z += (e.tz - e.z) * f;
    }
  }
}

/* ─────────────────── рисование из вида ─────────────────── */

const towerActors = new Map();   // spot → { actor, id, level, owner, extras }
const enemyActors = new Map();   // id → { actor, bar }

function ownerColor(pid) {
  const p = roster.get(pid) || view.players.get(pid);
  return p ? p.color : '#ffd447';
}
function ownerName(pid) {
  const p = roster.get(pid) || view.players.get(pid);
  return p ? `${p.emoji} ${p.name || 'Игрок'}` : 'Игрок';
}

function syncTowers() {
  for (const [spot, t] of view.towers) {
    let ta = towerActors.get(spot);
    if (ta && ta.id !== t.id) { removeTowerActor(spot, ta); ta = null; }
    if (!ta) {
      const f = FRIENDS[t.id];
      const actor = f.model === 'castle' ? new CastleActor() : new Actor(f.model, { tint: f.tint, clip: 'idle' });
      actor.root.position.copy(SPOTS[spot]).setY(0.4);
      actor.root.userData.spotIndex = spot;
      scene.add(actor.root);
      ta = { actor, id: t.id, level: 1, owner: t.owner, extras: [] };
      if (TEAM) {     // чья подружка: цветное кольцо на плите и значок над головой
        const ring = new THREE.Mesh(new THREE.TorusGeometry(MAZE ? 2.5 : 3.0, 0.32, 8, 30),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(ownerColor(t.owner)) }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(SPOTS[spot]).setY(0.6);
        scene.add(ring);
        const badge = makeLabel(ownerName(t.owner), ownerColor(t.owner), 0.8);
        badge.position.copy(SPOTS[spot]).setY(f.model === 'castle' ? 13 : 9);
        scene.add(badge);
        ta.extras.push(ring, badge);
      }
      towerActors.set(spot, ta);
      const sm = spotMeshes[spot];
      if (sm && sm.userData.ring) sm.userData.ring.visible = false;
    }
    if (ta.level !== t.level) {
      ta.level = t.level;
      if (ta.actor.setStage) ta.actor.setStage(t.level);
      else ta.actor.root.scale.setScalar(1 + (t.level - 1) * 0.12);
    }
  }
  for (const [spot, ta] of towerActors) if (!view.towers.has(spot)) removeTowerActor(spot, ta);
}
function removeTowerActor(spot, ta) {
  scene.remove(ta.actor.root);
  for (const x of ta.extras) scene.remove(x);
  towerActors.delete(spot);
  const sm = spotMeshes[spot];
  if (sm && sm.userData.ring) sm.userData.ring.visible = true;
}

const tmp = new THREE.Vector3();
function syncEnemies(dt) {
  for (const e of view.enemies.values()) {
    let ea = enemyActors.get(e.id);
    if (!ea) {
      const a = e.ghost ? new GhostActor(0.95 * e.scale)
        : new Actor(level.enemy, { tint: 0x6a5f8a, scale: 0.92 * e.scale, clip: 'run', dark: true });
      const bar = makeBar();
      bar.position.y = (e.ghost ? 6.6 : 7.2) * e.scale + 1.0;
      a.root.add(bar);
      a.root.position.set(e.x, 0, e.z);
      scene.add(a.root);
      ea = { actor: a, bar };
      enemyActors.set(e.id, ea);
    }
    const r = ea.actor.root;
    const mx = e.x - r.position.x, mzv = e.z - r.position.z;
    if (mx * mx + mzv * mzv > 1e-6) r.lookAt(tmp.set(e.x + mx * 10, r.position.y, e.z + mzv * 10));
    r.position.set(e.x, 0, e.z);
    const slowK = (view.danceLeft > 0 ? 0.5 : 1) * (e.slow > 0 ? 0.45 : 1);
    ea.actor.setSpeed(Math.max(0.35, slowK));
    ea.actor.update(dt);
    ea.bar.quaternion.copy(camera.quaternion);
    const k = Math.max(0, e.hp / e.maxHp);
    ea.bar.userData.fill.scale.x = Math.max(0.001, k);
    ea.bar.userData.fill.position.x = -(1 - k) * 1.7;
  }
  for (const [id, ea] of enemyActors) {
    if (view.enemies.has(id)) continue;
    removeEnemyActor(ea);
    enemyActors.delete(id);
  }
}

function removeEnemyActor(ea) {
  if (ea.actor instanceof GhostActor) {
    ea.bar.visible = false;
    ea.actor.model.userData.s0 = ea.actor.model.scale.x;
    fx.vanishing.push({ ghost: ea.actor });
    puff(ea.actor.root.position, ea.actor.model.scale.x);
  } else {
    scene.remove(ea.actor.root);
  }
}

/* ─────────────────── голос и подсказки ─────────────────── */

let voiceOn = localStorage.getItem('tails.voice') !== 'off';
let ruVoice = null;
const synth = typeof window !== 'undefined' && window.speechSynthesis && window.SpeechSynthesisUtterance ? window.speechSynthesis : null;
const pickVoice = () => { try { ruVoice = synth ? synth.getVoices().find((v) => v.lang.startsWith('ru')) || null : null; } catch (e) { ruVoice = null; } };
pickVoice();
if (synth) synth.onvoiceschanged = pickVoice;
function say(text) {
  if (!voiceOn || !text || !synth) return;
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (ruVoice) u.voice = ruVoice;
    u.lang = 'ru-RU'; u.pitch = 1.3; u.rate = 1.05;
    synth.speak(u);
  } catch (e) { /* голос недоступен */ }
}

function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const myPlayer = () => view.players.get(myId);
const myShells = () => (myPlayer() ? myPlayer().shells : 0);

function drawHud() {
  $('tails').textContent = '🎀'.repeat(Math.max(0, view.tails)) + '·'.repeat(Math.max(0, START_TAILS - view.tails));
  $('shells').textContent = myShells();
  if (RUNNER_ON && myPlayer()) {
    const pl = myPlayer();
    $('lives').textContent = pl.down ? '💤' : pl.lives;
    $('lives-box').classList.toggle('low', pl.down || pl.lives <= 3);
    if (profile.hero === 'ghost') {
      const cost = HERO.growCost[(pl.grow || 1) - 1];
      $('btn-grow').textContent = cost === undefined ? '👻 Самый большой' : `👻 Подрасти 🐚 ${cost}`;
      $('btn-grow').disabled = cost === undefined || pl.shells < cost;
    }
  }
  $('wave-num').textContent = view.wave || '—';
  $('wave-place').textContent = view.wave
    ? `${level.name} · до конца ${Math.max(0, level.target - view.wave)}`
    : `${level.name} · жми «Волна!»`;
  $('best').textContent = progress.best(level.map, level.id);
  $('btn-dance').disabled = view.danceReadyIn > 0;
  if (TEAM) {
    const rows = [`<div class="code">Игра <b>${ROOM}</b></div>`];
    const ids = new Set([...roster.keys(), ...view.players.keys()]);
    for (const id of ids) {
      const p = view.players.get(id), r = roster.get(id) || p;
      if (!r || (p && !p.active && !roster.has(id))) continue;
      const online = roster.has(id) && roster.get(id).online;
      const host = room && room.host === id;
      rows.push(`<div class="pl${id === myId ? ' me' : ''}${online ? '' : ' off'}" style="--c:${r.color}" data-id="${id}">
        <span class="dot"></span><b>${r.emoji} ${escapeHtml(r.name || 'Игрок')}</b>${host ? ' <i title="ведёт игру">👑</i>' : ''}
        ${p && p.idle ? '<i title="отошёл: волны рассчитаны на тех, кто играет">💤</i>' : ''}<span class="sh">🐚 ${p ? p.shells : '—'}${RUNNER_ON && p ? ` ❤️ ${p.lives}` : ''}</span></div>`);
    }
    $('team').innerHTML = rows.join('');
  }
}

/* ─────────────────── действия ─────────────────── */

let actN = 0;
function doAct(a) {
  if (sim) {
    const r = sim.act(myId, a);
    if (!r.ok && r.err) toast(r.err);
    afterSimEvents();
    return r.ok;
  }
  net.send({ t: 'act', a, n: ++actN });
  return true;
}

/* ─────────────────── меню постройки ─────────────────── */

let pickedSpot = -1;
const towerUpCost = (t) => towerStats(t.id, t.level).upCost;
const towerSpent = (t) => towerStats(t.id, t.level).spent;

function showBuild(spotIndex) {
  pickedSpot = spotIndex;
  const host = $('build');
  host.innerHTML = '';
  const tower = view.towers.get(spotIndex);
  const shells = myShells();
  if (tower && tower.owner !== myId) {
    const info = document.createElement('div');
    info.className = 'friend info';
    info.innerHTML = `<span class="face">${FRIENDS[tower.id].emoji}</span><b>${FRIENDS[tower.id].name}</b><span class="price">${escapeHtml(ownerName(tower.owner))}</span>`;
    host.append(info);
    // подружку друга можно растить на свои ракушки; подружку ушедшего — ещё и отправить домой
    const upCost = towerUpCost(tower);
    const up = document.createElement('button');
    up.className = 'friend';
    up.dataset.act = 'up';
    up.innerHTML = `<span class="face">⬆️</span><b>Помочь расти</b><span class="price">🐚 ${upCost}</span>`;
    up.disabled = shells < upCost;
    up.onclick = () => { if (doAct({ k: 'up', s: spotIndex })) setTimeout(() => { if (pickedSpot === spotIndex) showBuild(spotIndex); }, 250); };
    host.append(up);
    const ow = view.players.get(tower.owner);
    if (!ow || !ow.active) {
      host.append(sellButton(spotIndex, tower));
    }
  } else if (tower) {
    const upCost = towerUpCost(tower);
    const up = document.createElement('button');
    up.className = 'friend';
    up.dataset.act = 'up';
    up.innerHTML = `<span class="face">⬆️</span><b>Подрасти</b><span class="price">🐚 ${upCost}</span>`;
    up.disabled = shells < upCost;
    up.onclick = () => { if (doAct({ k: 'up', s: spotIndex })) setTimeout(() => { if (pickedSpot === spotIndex) showBuild(spotIndex); }, 250); };
    host.append(up, sellButton(spotIndex, tower));
  } else {
    for (const id of FRIEND_IDS) {
      const f = FRIENDS[id];
      const b = document.createElement('button');
      b.className = 'friend';
      b.dataset.friend = id;
      b.innerHTML = `<span class="face">${f.emoji}</span><b>${f.name}</b><span class="price">🐚 ${f.cost}</span>`;
      b.disabled = shells < f.cost;
      b.onclick = () => { doAct({ k: 'build', s: spotIndex, f: id }); hideBuild(); };
      host.append(b);
    }
  }
  host.classList.add('show');
}

/** Продажа в два нажатия: первое спрашивает, второе продаёт. Если не подтвердить за 3 секунды, кнопка вернётся. */
function sellButton(spotIndex, tower) {
  const price = Math.round(towerSpent(tower) / 2);
  const b = document.createElement('button');
  b.className = 'friend sell';
  b.dataset.act = 'sell';
  const idle = `<span class="face">💰</span><b>Продать</b><span class="price">🐚 +${price}</span>`;
  b.innerHTML = idle;
  let armed = 0;
  b.onclick = () => {
    if (!armed) {
      b.classList.add('confirm');
      b.innerHTML = `<span class="face">❓</span><b>Точно продать?</b><span class="price">🐚 +${price}</span>`;
      armed = setTimeout(() => { armed = 0; b.classList.remove('confirm'); b.innerHTML = idle; }, 3000);
      return;
    }
    clearTimeout(armed);
    doAct({ k: 'sell', s: spotIndex });
    hideBuild();
  };
  return b;
}

const hideBuild = () => { pickedSpot = -1; $('build').classList.remove('show'); highlight(-1); };

function highlight(index) {
  spotMeshes.forEach((d, i) => {
    if (!d) return;
    const on = i === index;
    d.material.emissiveIntensity = on ? 1.4 : MAZE ? 0.25 : 0.4;
    d.scale.setScalar(on ? 1.08 : 1);
    if (d.userData.ring) d.userData.ring.material.opacity = on ? 1 : 0.75;
  });
  const t = view.towers.get(index);
  const r = t ? towerStats(t.id, t.level).range : (FRIEND_IDS.length ? FRIENDS[FRIEND_IDS[0]].range : 0);
  if (index < 0 || !r) { rangeRing.visible = false; return; }
  rangeRing.visible = true;
  rangeRing.scale.setScalar(r);
  rangeRing.position.copy(SPOTS[index]).setY(0.5);
}

/* ─────────────────── события боя → эффекты, голос, подсказки ─────────────────── */

const posOfEnemy = (id) => { const ea = enemyActors.get(id); return ea ? ea.actor.root.position : null; };

function handleEvents(events) {
  for (const ev of events) {
    switch (ev[0]) {
      case 'b': {
        audio.sfx('build');
        const t = view.towers.get(ev[1]);
        const f = t && FRIENDS[t.id];
        if (MAZE) redrawRoute(view.towers);
        if (!f) break;
        if (ev[2] === myId) { say(`${f.name} на месте!`); toast(`${f.emoji} ${f.name} ${f.model === 'castle' ? 'встал' : 'встала'} на плиту`); runner && runner.build(); }
        else toast(`${ownerName(ev[2])} поставил(а): ${f.emoji} ${f.name}`, 1800);
        break;
      }
      case 'u': {
        audio.sfx('grow');
        const ta = towerActors.get(ev[1]);
        const t = view.towers.get(ev[1]);
        if (ta) sparks(ta.actor.root.position, 8);
        if (ev[2] === myId && t) {
          if (FRIENDS[t.id].model === 'castle') {
            const words = ['', 'Башня!', 'Выросла стена!', 'Появился мост!', 'Настоящая крепость!'];
            say(t.level <= 4 ? words[t.level] : 'Замок стал сильнее!');
            toast(`🏰 Замок — ${t.level <= 4 ? 'стадия ' + t.level : 'уровень ' + t.level}`);
          } else { say('Подросла!'); toast(`${FRIENDS[t.id].name} — уровень ${t.level}`); }
          runner && runner.build();
        }
        break;
      }
      case 's': if (MAZE) redrawRoute(view.towers); break;
      case 'f': {
        const ta = towerActors.get(ev[1]);
        const target = enemyActors.get(ev[2]);
        if (!ta || !target) break;
        audio.sfx('shoot');
        const tp = target.actor.root.position;
        if (ta.actor.aim) ta.actor.aim(tp);
        else ta.actor.root.lookAt(tmp.copy(tp).setY(ta.actor.root.position.y));
        ta.actor.play('attack', 1.4, 0.12);
        clearTimeout(ta.back);
        ta.back = setTimeout(() => ta.actor.play('idle', ta.actor.def.idleSpeed, 0.2), 600);
        const owner = view.towers.get(ev[1])?.owner;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10),
          new THREE.MeshBasicMaterial({ color: TEAM ? new THREE.Color(ownerColor(owner)) : FRIENDS[ta.id].tint }));
        if (ta.actor.muzzle) ta.actor.muzzle(ball.position); else ball.position.copy(ta.actor.root.position).setY(3.6);
        scene.add(ball);
        fx.balls.push({ mesh: ball, target: ev[2] });
        break;
      }
      case 'k': {
        const p = posOfEnemy(ev[1]);
        const big = !!ev[6];
        if (p) sparks(p, big ? 26 : ev[3] ? 8 : 3, ev[3] ? 0xff6f91 : 0xffd447);
        if (big) { audio.sfx('bigdown'); kick('shake', 500); say('Большая тень побеждена!'); }
        if (ev[3]) {                                // убил персонаж: жизни и серия
          audio.sfx('kill');
          if (ev[2] === myId) {
            if (p) floatText(p, `+${ev[3]} ❤️`, '#ff6f91', 1.25);
            if (ev[5] >= 2) { audio.sfx('combo', ev[5]); showCombo(ev[5]); }
          }
        } else {                                    // убила башня: ракушки всем
          audio.sfx('pop');
          audio.sfx('shell');
          if (p && ev[4]) floatText(p, `+${ev[4]} 🐚`, '#ffd447');
        }
        break;
      }
      case 'm': {                                   // удар персонажа
        const p = posOfEnemy(ev[1]);
        if (p) sparks(p, 5, 0xffffff);
        audio.sfx('hit');
        if (ev[2] === myId) { kick('punch', 140); if (runner) runner.build(); } else if (others.has(ev[2])) others.get(ev[2]).build();
        break;
      }
      case 'h':                                     // монстр ударил персонажа
        if (ev[1] === myId) {
          audio.sfx('hurt');
          hideCombo();
          if (runner) floatText(runner.root.position, 'Ой! −❤️', '#ff4d4d');
          document.body.classList.add('hurt');
          setTimeout(() => document.body.classList.remove('hurt'), 260);
          if (runner) sparks(runner.root.position, 5, 0xff4d4d);
        }
        break;
      case 'o':                                     // жизни кончились
        if (ev[1] === myId) {
          audio.sfx('ko');
          if (runner) { runner.stop(); runner.cheer(false); }
          say('Ой, устала! Надо отдохнуть.');
          toast(`💤 Жизни кончились. Отдых ${ev[2]} с — башни пока работают сами`, 4000);
        }
        break;
      case 'r':                                     // вернулся
        if (ev[1] === myId && runner) { audio.sfx('revive'); runner.stop(); runner.endShot(); placeAtHome(); toast('❤️ Снова в строю!', 1600); }
        break;
      case 'P': {                                   // удар по союзнику
        audio.sfx('hit');
        const vp = ev[2] === myId ? runner : others.get(ev[2]);
        if (vp) { sparks(vp.root.position, ev[5] ? 16 : 6, 0xff4d4d); if (ev[4]) floatText(vp.root.position, `−${ev[4]} 🐚`, '#ff6f91'); }
        if (ev[1] === myId) { kick('punch', 140); if (runner) runner.build(); toast(`🥊 ${ownerName(ev[2])}${ev[5] ? ' в нокауте' : ''}: +${ev[4]} 🐚`, 1800); }
        else if (others.has(ev[1])) others.get(ev[1]).build();
        if (ev[2] === myId) { audio.sfx('hurt'); hideCombo(); kick('hurt', 260); toast(`🥊 ${ownerName(ev[1])} ударил тебя и забрал ${ev[4]} 🐚`, 2200); }
        break;
      }
      case 'G':                                     // призрак подрос
        if (ev[1] === myId) { audio.sfx('grow'); if (runner) sparks(runner.root.position, 12, 0xbfe6ff); toast(`👻 Призрак подрос! Стадия ${ev[2]} из ${HERO.growCost.length + 1}`, 1800); say('Расту!'); }
        break;
      case 'i':                                     // кто-то отошёл или вернулся
        if (ev[1] !== myId && TEAM) toast(ev[2] ? `💤 ${ownerName(ev[1])} отошёл — волны станут меньше, половина ракушек у вас` : `👋 ${ownerName(ev[1])} вернулся`, 3000);
        break;
      case 'l':
        audio.sfx('leak');
        kick('shake', 500);
        say(ev[2] > 0 ? 'Ой! Хвостик утащили!' : 'Хвостики кончились!');
        if (ev[2] > 0) toast(`🎀 Хвостик утащили. Осталось ${ev[2]}`);
        break;
      case 'w':
        if (level.map !== 'custom') progress.setBest(level.map, level.id, ev[1]);
        say(`Волна ${ev[1]}!`);
        audio.music(true);
        audio.setLevel(ev[2] ? 2 : 1);
        audio.sfx(ev[2] ? 'bigwave' : 'wave');
        toast(`🌊 Волна ${ev[1]}${ev[2] ? ' — большая тень!' : ''}`);
        break;
      case 'c':
        toast(`✨ Волна ${ev[1]} прошла! Ракушек +${ev[2]}`);
        audio.setLevel(0);
        audio.sfx('clear');
        say('Молодец!');
        break;
      case 'd':
        audio.sfx('dance');
        for (const ta of towerActors.values()) ta.actor.play('dance', 1.3, 0.15);
        setTimeout(() => { for (const ta of towerActors.values()) ta.actor.play('idle', ta.actor.def.idleSpeed, 0.3); }, DANCE_LEN * 1000);
        runner && runner.dance(DANCE_LEN);
        say('Танцуем!');
        toast(`💃 ${TEAM && ev[1] !== myId ? ownerName(ev[1]) + ': ' : ''}все танцуют — тени засмотрелись и замедлились!`);
        break;
      case 'j': if (TEAM && ev[1] !== myId && view.wave > 0) toast(`${ownerName(ev[1])} с нами!`); break;
      case 'x': if (TEAM) toast(`${ownerName(ev[1])} ушёл(ла)`, 2000); break;
      case 'e': finish(!!ev[1], ev[2]); break;
      default:
    }
  }
}

/* ── сочность: короткие всплески, подписи над монстрами, серия, салют ── */
function kick(cls, ms) {
  document.body.classList.remove(cls);
  void document.body.offsetWidth;
  document.body.classList.add(cls);
  setTimeout(() => document.body.classList.remove(cls), ms);
}
const floats = [];
function floatText(pos, text, color = '#ffd447', scale = 1) {
  if (floats.length >= 14) { const f = floats.shift(); scene.remove(f.sp); f.sp.material.map.dispose(); f.sp.material.dispose(); }
  const sp = makeLabel(text, color, scale);
  sp.position.set(pos.x + rnd(-0.8, 0.8), 7.5, pos.z + rnd(-0.5, 0.5));
  scene.add(sp);
  floats.push({ sp, life: 1 });
}
function updateFloats(dt) {
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i];
    f.life -= dt / 1.15;
    f.sp.position.y += dt * 4;
    f.sp.material.opacity = Math.min(1, f.life * 2.2);
    if (f.life <= 0) { scene.remove(f.sp); f.sp.material.map.dispose(); f.sp.material.dispose(); floats.splice(i, 1); }
  }
}
let comboT = 0;
function showCombo(n) {
  const el = $('combo');
  el.hidden = false;
  el.textContent = `🔥 ×${n}${n >= HERO.combo3 ? ' · жизни ×3' : n >= HERO.combo2 ? ' · жизни ×2' : ''}`;
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  clearTimeout(comboT);
  comboT = setTimeout(hideCombo, HERO.comboWindow * 1000);
}
function hideCombo() { clearTimeout(comboT); $('combo').hidden = true; }
function confetti() {
  const colors = [0xffd447, 0xff6f91, 0x8fd0ff, 0x9be37a, 0xc7b0ff, 0xffa45c];
  const at = new THREE.Vector3();
  for (let i = 0; i < 7; i++) {
    setTimeout(() => {
      at.copy(house.position).add(new THREE.Vector3(rnd(-16, 16), rnd(2, 9), rnd(-14, 14)));
      sparks(at, 16, colors[i % colors.length]);
    }, i * 220);
  }
}

let snapEvents = [];
function afterSimEvents() {
  const ev = sim.takeEvents();
  if (!ev.length) return;
  viewFromSim();
  syncTowers();
  handleEvents(ev);
  if (TEAM && isHost) snapEvents.push(...ev.filter((e) => e[0] !== 'j' || true));
}

/* ─────────────────── конец уровня ─────────────────── */

let finished = false;
function finish(won, tails) {
  if (finished) return;
  finished = true;
  const stars = won ? starsFor(tails) : 0;
  audio.music(false);
  audio.sfx(won ? 'win' : 'lose');
  if (won) confetti();
  const custom = level.map === 'custom';
  const next = custom ? null : MAP.levels.find((l) => l.id === level.id + 1);
  if (won && !custom) { progress.unlock(level.map, level.id + 1); progress.setStars(level.map, level.id, stars); }
  if (TEAM && isHost) net.send({ t: 'end', won });
  if (runner) runner.cheer(won);

  $('ov-title').textContent = won ? (TEAM ? '🏆 Команда выстояла!' : '🏆 Уровень пройден!') : 'Тени утащили хвостики';
  $('ov-stars').textContent = won ? '⭐'.repeat(stars) + '☆'.repeat(3 - stars) : '';
  $('ov-text').textContent = won
    ? (next ? `${level.name} — наша. Открылось новое место: ${next.name}.` : `${level.name} выстоял! Можно держать волны дальше.`)
    : `${TEAM ? 'Команда продержалась' : 'Ты продержалась'} ${view.wave} волн на месте «${level.name}».`;

  const row = $('ov-buttons');
  row.innerHTML = '';
  const link = (text, href, cls = 'huge ghost') => { const a = document.createElement('a'); a.className = cls; a.href = href; a.textContent = text; row.append(a); return a; };
  if (TEAM) {
    link('👫 В лобби', 'lobby.html', 'huge').addEventListener('click', () => net.send({ t: 'leave' }));
  } else {
    if (won && next) link(`▶ Дальше: ${next.name}`, `play.html?map=${level.map}&level=${next.id}`, 'huge');
    const more = document.createElement('button');
    more.className = 'huge ghost';
    more.textContent = won ? '🌊 Ещё волны здесь' : '↻ Ещё раз';
    more.onclick = () => { if (won) { finished = false; $('overlay').classList.remove('show'); doAct({ k: 'more' }); } else location.reload(); };
    row.append(more);
  }
  link('🏠 Домой', custom ? customBack : `map.html?map=${level.map}`);
  // сначала дать порадоваться салюту, потом итоги
  setTimeout(() => $('overlay').classList.add('show'), won ? 1500 : 0);
  say(won ? 'Ура! Уровень пройден!' : 'Ничего страшного! Попробуем ещё раз!');
}

/* ─────────────────── бегающий персонаж ─────────────────── */

let runner = null;                    // свой
const others = new Map();             // id → Runner (у других игроков)
let follow = true;
const joy = new Joystick($('joy'));
const keys = new Set();
const isTyping = () => document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _dir = new THREE.Vector3();

function updateRunners(dt) {
  if (!RUNNER_ON || !runner) return;
  // ввод: WASD/стрелки или экранный джойстик → направление относительно камеры
  let ix = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  let iy = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  let mag = Math.min(1, Math.hypot(ix, iy));
  if (joy.active) { ix = joy.x; iy = joy.y; mag = Math.min(1, Math.hypot(ix, iy)); }
  _fwd.copy(controls.target).sub(camera.position).setY(0).normalize();
  _right.set(-_fwd.z, 0, _fwd.x);
  _dir.set(0, 0, 0).addScaledVector(_fwd, iy).addScaledVector(_right, ix);
  if (_dir.lengthSq() > 1e-4) _dir.normalize();
  if (myPlayer() && myPlayer().down) { mag = 0; _dir.set(0, 0, 0); }   // отдыхает
  runner.move(_dir, mag, dt, LAND_R - 2);
  if (myPlayer()) runner.setGrow(myPlayer().grow);
  if (runner.air && !runner.wasAir) audio.sfx(runner.hopK > 1.15 ? 'hop' : 'jump', runner.hopK);
  runner.wasAir = runner.air;
  const hopK = runner.hopK;
  $('hop').hidden = hopK < 1.15;
  if (hopK >= 1.15) $('hop').textContent = `🐇 ×${hopK.toFixed(1)}`;
  if (follow && (mag > 0 || runner.following)) {
    runner.following = mag > 0 || controls.target.distanceTo(tmp.set(runner.root.position.x, 0, runner.root.position.z)) > 0.5;
    const p = runner.root.position;
    const k = Math.min(1, dt * 3);
    const nx = controls.target.x + (p.x - controls.target.x) * k, nz = controls.target.z + (p.z - controls.target.z) * k;
    camera.position.x += nx - controls.target.x; camera.position.z += nz - controls.target.z;
    controls.target.x = nx; controls.target.z = nz;
  }
  // своя позиция — хосту ~10 раз в секунду
  runner.sendT = (runner.sendT || 0) - dt;
  if (runner.sendT <= 0 && (sim || net)) {
    runner.sendT = 0.1;
    const p = runner.root.position;
    const a = { k: 'pos', x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, r: Math.round(runner.yaw * 100) / 100, v: runner.speedK > 0.05 ? 1 : 0, g: runner.ghost ? 1 : 0 };
    const last = runner.lastSent;
    if (!last || last.x !== a.x || last.z !== a.z || last.r !== a.r || last.v !== a.v) {
      runner.lastSent = a;
      if (sim) sim.act(myId, a); else net.send({ t: 'act', a });
    }
  }
  // чужие персонажи: интерполяция к последней известной точке
  if (!TEAM) return;
  for (const [id, p] of view.players) {
    if (id === myId || !p.active) continue;
    let o = others.get(id);
    if (!o) {
      const r = roster.get(id) || p;
      o = new Runner(scene, { color: r.color, name: `${r.emoji} ${r.name || 'Игрок'}`, hero: r.hero, tint: r.tint });
      o.root.position.set(p.x, 0, p.z);
      others.set(id, o);
    }
    o.follow(p.x, p.z, p.ry, p.run, dt);
    o.setGrow(p.grow || 1);
  }
  for (const [id, o] of others) {
    const p = view.players.get(id);
    if (!p || !p.active) { o.dispose(); others.delete(id); }
  }
}

/** Ближайшая к персонажу плита (для «E — строить тут»). */
function nearestSpot() {
  if (!runner) return -1;
  let best = -1, bd = MAZE ? 4.5 : 7.5;
  SPOTS.forEach((s, i) => {
    if (!spotMeshes[i]) return;
    const d = Math.hypot(s.x - runner.root.position.x, s.z - runner.root.position.z);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/* ─────────────────── ввод ─────────────────── */

const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
canvas.addEventListener('pointerup', (e) => {
  if (touchCam.isTap(e)) pickAt(e.clientX, e.clientY);    // иначе это был поворот камеры
});
function pickAt(cx, cy) {
  const r = canvas.getBoundingClientRect();
  mouse.x = ((cx - r.left) / r.width) * 2 - 1;
  mouse.y = -((cy - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(mouse, camera);
  const castles = [...towerActors.values()].filter((t) => t.actor.setStage).map((t) => t.actor.root);
  const hit = ray.intersectObjects([...pickable, ...castles], true)[0];
  let o = hit && hit.object;
  while (o && o.userData.spotIndex === undefined) o = o.parent;
  if (o) { highlight(o.userData.spotIndex); showBuild(o.userData.spotIndex); } else hideBuild();
}

$('btn-wave').onclick = () => doAct({ k: 'wave' });
$('btn-dance').onclick = () => { if (view.danceReadyIn <= 0) doAct({ k: 'dance' }); };
$('btn-voice').onclick = () => {
  voiceOn = !voiceOn;
  localStorage.setItem('tails.voice', voiceOn ? 'on' : 'off');
  $('btn-voice').textContent = voiceOn ? '🔊' : '🔇';
  audio.setOn(voiceOn);
  if (!voiceOn && synth) { try { synth.cancel(); } catch (e) { /* */ } }
};
$('btn-voice').textContent = voiceOn ? '🔊' : '🔇';
$('btn-home').href = TEAM ? 'lobby.html' : level.map === 'custom' ? customBack : `map.html?map=${level.map}`;
$('btn-home').addEventListener('click', () => { if (net) net.send({ t: 'leave' }); });
$('btn-cam').hidden = !RUNNER_ON;
$('btn-cam').onclick = () => {
  follow = !follow;
  $('btn-cam').textContent = follow ? '🗺' : '🏃';
  $('btn-cam').title = follow ? 'Общий вид' : 'Камера за мной';
  controls.enablePan = !follow;
  if (!follow) fitCamera(); else if (runner) runner.following = true;
};
if (RUNNER_ON) controls.enablePan = false;       // камера за персонажем: два пальца только приближают, а не утаскивают её
$('btn-jump').hidden = !RUNNER_ON;
const tryJump = () => { if (runner && !(myPlayer() && myPlayer().down)) runner.jump(); };
$('btn-jump').onclick = tryJump;
$('btn-hit').hidden = !RUNNER_ON;
$('btn-pvp').hidden = !(RUNNER_ON && room && room.ff);
$('btn-pvp').onclick = () => { if (runner) doAct({ k: 'pvp' }); };
if (room && room.ff) setTimeout(() => toast('🥊 Friendly fire: можно бить союзников и отбирать их ракушки!', 5000), 1500);
$('btn-grow').hidden = !RUNNER_ON || profile.hero !== 'ghost';
$('btn-grow').onclick = () => doAct({ k: 'grow' });
$('lives-box').hidden = !RUNNER_ON;
const strike = () => { if (runner) doAct({ k: 'hit', air: runner.air ? 1 : 0 }); };
$('btn-hit').onclick = strike;
$('btn-here').hidden = !RUNNER_ON;
$('btn-here').onclick = () => { const s = nearestSpot(); if (s >= 0) { highlight(s); showBuild(s); } else toast('Подбеги к плите поближе'); };
instantPress($('big-buttons'));
instantPress($('build'));
thumbZone(canvas, $('big-buttons'), { near: [$('btn-jump'), $('btn-hit'), $('btn-here')], onTap: pickAt });
if (RUNNER_ON) joy.floatIn(canvas, (x, y) => x < innerWidth * 0.4 && y > innerHeight * 0.4, pickAt);
if (TEAM) document.body.classList.add('team');
audio.setOn(voiceOn);
for (const n of ['pointerdown', 'keydown']) addEventListener(n, () => audio.unlock(), { capture: true });
audio.music(true);
if (RUNNER_ON) document.body.classList.add('runner-on');

addEventListener('keydown', (e) => {
  if (isTyping()) return;
  if (RUNNER_ON && /^(KeyW|KeyA|KeyS|KeyD|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(e.code)) { keys.add(e.code); e.preventDefault(); return; }
  if (e.code === 'Space') { e.preventDefault(); if (RUNNER_ON) tryJump(); else doAct({ k: 'wave' }); }
  if ((e.code === 'KeyQ' || e.code === 'KeyR') && RUNNER_ON && !e.repeat) strike();
  if (e.code === 'KeyX' && room && room.ff && !e.repeat && runner) doAct({ k: 'pvp' });
  if (e.code === 'KeyG' && RUNNER_ON && !e.repeat && profile.hero === 'ghost') doAct({ k: 'grow' });
  if (e.code === 'Enter' || e.code === 'KeyV') doAct({ k: 'wave' });
  if (e.code === 'KeyF' || (!RUNNER_ON && e.code === 'KeyD')) $('btn-dance').click();
  if (e.code === 'KeyE' && RUNNER_ON) $('btn-here').click();
  if (e.code === 'KeyC' && RUNNER_ON) $('btn-cam').click();
  if (e.code === 'Escape') hideBuild();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

/* ─────────────────── командная игра: сеть ─────────────────── */

const SNAP_EVERY = 1 / 12;
let snapT = 0;

function rosterFrom(r) {
  roster.clear();
  for (const p of r.players) roster.set(p.id, p);
}

/** Хост: состав комнаты → игроки в симуляции (пришёл — получил ракушки, ушёл — его подружки остаются). */
function hostSyncRoster() {
  for (const p of roster.values()) {
    const sp = sim.players.get(p.id);
    if (!sp || !sp.active) sim.addPlayer({ id: p.id, name: p.name, color: p.color, emoji: p.emoji });
  }
  for (const sp of sim.players.values()) if (sp.active && !roster.has(sp.id)) sim.removePlayer(sp.id);
  afterSimEvents();
}

function becomeHost() {
  isHost = true;
  const players = [...roster.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, emoji: p.emoji }));
  if (lastSnap) {
    sim = Sim.fromSnapshot(level, SPOTS2, lastSnap, players);
    sim.ff = !!(room && room.ff);
    hostSyncRoster();
    toast('👑 Ведущий ушёл — теперь игру ведёшь ты. Играем дальше!', 4000);
  } else {
    sim = new Sim(level, { players, spots: SPOTS2 });
    sim.ff = !!(room && room.ff);
  }
  $('wait-host').classList.remove('show');
  viewFromSim();
}

if (TEAM) {
  rosterFrom(room);
  net.on('room', (m) => {
    if (m.room.code !== ROOM) return;
    room = m.room;
    rosterFrom(room);
    if (room.host === myId && !isHost) becomeHost();
    else if (isHost && sim) hostSyncRoster();
    drawHud();
  });
  net.on('act', (m) => {
    if (!isHost || !sim) return;
    const r = sim.act(m.from, m.a);
    if (!r.ok && r.err) net.send({ t: 'res', to: m.from, r, n: m.n });
    if (!r.quiet) afterSimEvents();
  });
  net.on('res', (m) => { if (m.r && m.r.err) toast(m.r.err); });
  net.on('snap', (m) => {
    if (isHost) return;
    lastSnap = m.s;
    lastSnapAt = performance.now();
    $('wait-host').classList.remove('show');
    viewFromSnap(m.s);
    if (!ready) return;              // модели ещё грузятся — нарисуем, когда загрузятся
    syncTowers();
    handleEvents(m.s.ev || []);
  });
  net.on('closed', (m) => { $('wait-host').classList.remove('show'); toast(m.msg, 6000); setTimeout(() => { location.href = 'lobby.html'; }, 2500); });
  net.on('kicked', (m) => toast(m.msg, 6000));
  net.on('down', () => toast('Связь пропала — переподключаемся…', 2000));
  net.on('welcome', () => net.send({ t: 'join', code: ROOM }));
  // закрытая вкладка/перезагрузка — не «ушёл»: сервер ждёт 8 с (вдруг вернётся), потом передаёт ведущего
}

function hostBroadcast(dt) {
  snapT -= dt;
  if (snapT > 0) return;
  snapT = SNAP_EVERY;
  const s = sim.snapshot();
  s.ev = snapEvents;
  snapEvents = [];
  lastSnap = s;
  net.send({ t: 'snap', s });
}

/* ─────────────────── цикл ─────────────────── */

const clock = new THREE.Clock();
const STEP = 1 / 30;
let acc = 0, hudT = 0;

/**
 * Симуляция идёт по своему таймеру, а не по кадрам: у ведущего вкладка может уйти в фон
 * (там requestAnimationFrame замирает) — игра у остальных при этом не должна вставать.
 */
let simLast = performance.now();
function simPump() {
  if (!sim) { simLast = performance.now(); return; }
  const now = performance.now();
  const dt = Math.min((now - simLast) / 1000, 1.5);
  simLast = now;
  acc += dt;
  while (acc >= STEP) { sim.step(STEP); acc -= STEP; afterSimEvents(); }
  viewFromSim();
  if (TEAM && isHost) hostBroadcast(dt);
}
setInterval(simPump, 33);

let ready = false;
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (sim) {
    simPump();
  } else if (TEAM) {
    advanceClient(dt);
    if (lastSnapAt && performance.now() - lastSnapAt > 2500 && !view.over) $('wait-host').classList.add('show');
  }
  syncTowers();
  syncEnemies(dt);
  for (const ta of towerActors.values()) ta.actor.update(dt);
  updateRunners(dt);
  updateFloats(dt);
  if (runner) runner.update(dt);
  for (const o of others.values()) o.update(dt);

  for (let i = fx.balls.length - 1; i >= 0; i--) {
    const b = fx.balls[i];
    const ea = enemyActors.get(b.target);
    if (!ea) { scene.remove(b.mesh); fx.balls.splice(i, 1); continue; }
    const to = tmp.copy(ea.actor.root.position).setY(3);
    const d = b.mesh.position.distanceTo(to);
    if (d < 1.6) { if (ea.actor.hit) ea.actor.hit(); scene.remove(b.mesh); fx.balls.splice(i, 1); }
    else b.mesh.position.lerp(to, Math.min(1, (30 * dt) / d));
  }
  for (let i = fx.vanishing.length - 1; i >= 0; i--) {
    const v = fx.vanishing[i];
    if (v.ghost) {
      if (v.ghost.vanish(dt)) { scene.remove(v.ghost.root); v.ghost.mat.dispose(); v.ghost.blobMat.dispose(); fx.vanishing.splice(i, 1); }
    } else {
      v.life += dt / 0.8;
      v.puff.scale.setScalar(1 + v.life * 1.4);
      v.puff.position.x += v.vx * dt; v.puff.position.z += v.vz * dt; v.puff.position.y += 1.2 * dt;
      v.puff.material.opacity = 0.7 * (1 - v.life);
      if (v.life >= 1) { scene.remove(v.puff); v.puff.geometry.dispose(); v.puff.material.dispose(); fx.vanishing.splice(i, 1); }
    }
  }
  for (let i = fx.drops.length - 1; i >= 0; i--) {
    const d = fx.drops[i];
    d.life -= dt;
    d.mesh.position.y += d.vy * dt;
    d.vy -= 6 * dt;
    if (d.life <= 0) { scene.remove(d.mesh); fx.drops.splice(i, 1); }
  }

  hudT -= dt;
  if (hudT <= 0) { hudT = 0.2; drawHud(); if (pickedSpot >= 0) refreshBuildButtons(); }

  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  controls.update();
  renderer.render(scene, camera);
}

function refreshBuildButtons() {
  const shells = myShells();
  for (const b of $('build').querySelectorAll('button[data-friend]')) b.disabled = shells < FRIENDS[b.dataset.friend].cost;
  const up = $('build').querySelector('button[data-act=up]');
  const t = view.towers.get(pickedSpot);
  if (up && t) up.disabled = shells < towerUpCost(t);
}

/* ─────────────────── старт ─────────────────── */

function fitCamera() {
  const box = new THREE.Box3();
  for (const p of [...allPts, house.position]) box.expandByPoint(p);
  if (MAZE) {
    box.expandByPoint(new THREE.Vector3(-level.maze.w * 3, 0, -level.maze.h * 3));
    box.expandByPoint(new THREE.Vector3(level.maze.w * 3, 0, level.maze.h * 3));
  }
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const aspect = Math.max(0.6, canvas.clientWidth / Math.max(1, canvas.clientHeight));
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const dist = Math.max(size.z * 0.62 / half, size.x * 0.62 / (half * aspect)) + 14;
  controls.target.copy(c);
  camera.position.set(c.x, dist * 0.66, c.z + dist * 0.75);
  controls.maxDistance = dist * 1.8;
  scene.fog.near = dist * 1.2;
  scene.fog.far = dist * 2.8;
  return dist;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const need = [...new Set([level.enemy, ...FRIEND_IDS.map((id) => FRIENDS[id].model)])];
const jobs = [];
for (const kind of need) {
  if (MODELS[kind].stages) MODELS[kind].stages.forEach((url, i) => jobs.push({ url, ok: (gltf) => { castleStages[i] = gltf.scene; } }));
  else {
    jobs.push({ url: MODELS[kind].url, ok: (gltf) => {
      const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
      loaded[kind] = { gltf, scale: MODELS[kind].height / Math.max(0.001, size.y) };
    } });
  }
}
const loadOne = (url) => new Promise((ok, bad) => loader.load(url, ok, (e) => {
  if (e.lengthComputable) $('load-bar').style.width = Math.round((e.loaded / e.total) * 100) + '%';
}, bad));

try {
  await Promise.all([...jobs.map((j) => loadOne(j.url).then(j.ok)), ...(RUNNER_ON ? (TEAM ? Object.keys(HEROES) : [profile.hero]).map((h) => loadRunnerModel(loader, h)) : [])]);
} catch (err) {
  console.error(err);
  failPage('Не получилось загрузить модель :(');
}
begin();

/** Встаём рядом с домиком, каждый игрок — чуть в стороне. */
function placeAtHome() {
  const toC = Math.hypot(HOUSE[0], HOUSE[1]) > 1 ? [-HOUSE[0], -HOUSE[1]] : [0, 1];
  const l = Math.hypot(...toC);
  runner.root.position.set(HOUSE[0] + (toC[0] / l) * 9 + ((myId % 4) - 1.5) * 2.5, 0, HOUSE[1] + (toC[1] / l) * 9 + 3);
}

function begin() {
  $('loading').classList.add('done');
  ready = true;
  const dist = fitCamera();
  if (RUNNER_ON) {
    runner = new Runner(scene, { color: profile.color, name: TEAM ? `${profile.emoji} ${profile.name || 'Я'}` : '', me: true, hero: profile.hero, tint: profile.tint });
    placeAtHome();
    camera.position.sub(controls.target).multiplyScalar(Math.min(1, 60 / dist)).add(controls.target);
    runner.following = true;
  }
  if (!TEAM) {
    myId = 1;
    sim = new Sim(level, { players: [{ id: 1, name: profile.name, color: profile.color, emoji: profile.emoji }], spots: SPOTS2 });
    viewFromSim();
  } else if (isHost) {
    sim = new Sim(level, { players: [...roster.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, emoji: p.emoji })), spots: SPOTS2 });
    sim.ff = !!(room && room.ff);
    viewFromSim();
  } else {
    lastSnapAt = performance.now();
    if (lastSnap) syncTowers();
  }
  if (MAZE) redrawRoute(view.towers);
  drawHud();
  toast(`${level.name}: ${level.hint}${TEAM ? ` · Игра ${ROOM}` : ''}`, 6000);
  say(level.speech || `${level.name}. Ставь подружек на плиты!`);
  tick();
  if (DEBUG) {
    window.__td = { joy, view, get sim() { return sim; }, doAct, showBuild, SPOTS, spotMeshes, camera, controls, level,
      get isHost() { return isHost; }, get myId() { return myId; }, get runner() { return runner; }, touchCam, audio, scene, house, get loader() { return loader; }, floatText, others, keys, pickAt,
      net, roster, get lastSnap() { return lastSnap; }, nearestSpot, towerActors, enemyActors, renderer };
  }
}
