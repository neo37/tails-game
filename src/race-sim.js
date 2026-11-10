/**
 * Гонка в космическом тоннеле: трасса и физика без графики (проверка: tools/race-test.mjs).
 * Персонаж летит вперёд по оси тоннеля (s) и свободно смещается в его сечении (x вправо, y вверх).
 * Разгон плавный. Сцепление падает с квадратом скорости, а сила на вираже растёт с квадратом скорости:
 * чем быстрее летишь, тем сильнее заносит.
 */
export const TUBE_R = 12;                 // радиус тоннеля
export const BODY_R = 1.3;                // персонаж как круг в сечении
const DS = 2;                             // шаг точек оси
const PAD = 160;                          // хвост трассы за финишем
const ACCEL = 0.16;                       // разгон: доля оставшейся до максимума скорости в секунду
const BRAKE = 55;
const THRUST = 52;                        // ускорение от руля
const GRIP_SLOW = 7, GRIP_FAST = 1.15;    // сцепление на малой и на полной скорости
export const START_S = 30;
/** Вентиляторы: сколько секунд дует после прохода, сила и пределы скорости (доли vmax). */
export const WIND = { time: 1.6, push: 34, top: 1.35, low: 0.35 };

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Радиус тоннеля меняется по длине: def.widen = [во сколько раз шире в самом широком месте, длина волны].
 * У старта и финиша — обычный TUBE_R; в «экстремумах» — до widen[0] × TUBE_R (по умолчанию 3 диаметра).
 * Преграды масштабируются вместе с сечением (o.k), поэтому их не объехать по широкой части.
 */
export function radiusProfile(def, total, r) {
  const [max, wave] = def.widen || [3, 620];
  if (max <= 1) return () => TUBE_R;
  const ph = r() * 6.28, w = (2 * Math.PI) / wave, w2 = w * 0.37;
  return (u) => {
    const e = smooth(60, 260, u) * smooth(0, 220, def.length - u);   // у старта и у финиша — обычная труба
    // две волны: широкие залы и узкие горловины чередуются неравномерно
    const a = 0.5 + 0.5 * Math.sin(u * w + ph), b = 0.5 + 0.5 * Math.sin(u * w2 + ph * 1.7);
    const bulge = Math.pow(a, 2.2) * (0.55 + 0.45 * b);
    return TUBE_R * (1 + (max - 1) * e * bulge);
  };
}

/** Радиус тоннеля в точке s. */
export function radiusAt(track, s) {
  if (!track.rad) return TUBE_R;
  const f = Math.max(0, Math.min(track.n - 1.001, s / DS)), i = Math.floor(f), t = f - i;
  return track.rad[i] * (1 - t) + track.rad[i + 1] * t;
}

/**
 * def: { seed, length, vmax, drift, coil: [радиус, длина витка], sway, gap, kinds, hole, widen: [×, волна] }
 * Трасса из редактора (race-design.js) вместо coil задаёт curve(u) — точку оси по длине дуги — и готовые obstacles.
 */
export function buildTrack(def) {
  const r = rng(def.seed);
  const total = def.length + PAD;
  let center = def.curve;
  if (!center) {
    const [A, wave] = def.coil, w = (2 * Math.PI) / wave, ph = r() * 6.28;
    const sw = def.sway, sw1 = (2 * Math.PI) / (wave * 2.7), ph2 = r() * 6.28;
    // z растёт всегда: тоннель не может пересечь сам себя
    center = (u) => {
      const e = smooth(0, 220, u) * smooth(0, 200, total * 1.05 - u);
      const k = e * (0.6 + 0.4 * Math.sin(u * w * 0.31 + ph2));
      return [k * A * Math.sin(u * w + ph) + e * sw * Math.sin(u * sw1 + ph2),
              k * A * Math.cos(u * w + ph) + e * sw * Math.cos(u * sw1 * 0.7 + ph), u];
    };
  }
  const n = Math.ceil(total / DS) + 1;
  const pos = new Float32Array(n * 3);
  let u = 0, [px, py, pz] = center(0);
  pos.set([px, py, pz], 0);
  for (let i = 1; i < n; i++) {           // равномерно по длине дуги
    let left = DS;
    while (left > 1e-3) {
      const [x, y, z] = center(u + 0.2);
      const d = Math.hypot(x - px, y - py, z - pz);
      if (d >= left) { const f = left / d; px += (x - px) * f; py += (y - py) * f; pz += (z - pz) * f; u += 0.2 * f; left = 0; }
      else { px = x; py = y; pz = z; u += 0.2; left -= d; }
    }
    pos.set([px, py, pz], i * 3);
  }
  const tan = new Float32Array(n * 3), up = new Float32Array(n * 3), right = new Float32Array(n * 3);
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(pos[4] - pos[1]) > 0.98 * Math.hypot(pos[3] - pos[0], pos[4] - pos[1], pos[5] - pos[2])) { uy = 0; uz = 1; }   // старт вертикально вверх
  for (let i = 0; i < n; i++) {           // оси сечения переносятся без лишнего кручения
    const a = Math.max(0, i - 1) * 3, b = Math.min(n - 1, i + 1) * 3;
    let tx = pos[b] - pos[a], ty = pos[b + 1] - pos[a + 1], tz = pos[b + 2] - pos[a + 2];
    const l = Math.hypot(tx, ty, tz); tx /= l; ty /= l; tz /= l;
    const dot = ux * tx + uy * ty + uz * tz;
    ux -= dot * tx; uy -= dot * ty; uz -= dot * tz;
    const m = Math.hypot(ux, uy, uz); ux /= m; uy /= m; uz /= m;
    tan.set([tx, ty, tz], i * 3); up.set([ux, uy, uz], i * 3);
    right.set([ty * uz - tz * uy, tz * ux - tx * uz, tx * uy - ty * ux], i * 3);
  }
  // кривизна в осях сечения: куда тянет вираж
  const bend = new Float32Array(n * 2);
  let bendMax = 1e-4;
  const H = 4;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - H) * 3, b = Math.min(n - 1, i + H) * 3, len = ((b - a) / 3) * DS;
    const kx = (tan[b] - tan[a]) / len, ky = (tan[b + 1] - tan[a + 1]) / len, kz = (tan[b + 2] - tan[a + 2]) / len;
    const j = i * 3;
    bend[i * 2] = kx * right[j] + ky * right[j + 1] + kz * right[j + 2];
    bend[i * 2 + 1] = kx * up[j] + ky * up[j + 1] + kz * up[j + 2];
    bendMax = Math.max(bendMax, Math.hypot(bend[i * 2], bend[i * 2 + 1]));
  }
  // радиус по длине (свой генератор: не сдвигаем случайные числа преград у старых трасс)
  const rf = radiusProfile(def, total, rng((def.seed || 1) * 31 + 7));
  const rad = new Float32Array(n);
  for (let i = 0; i < n; i++) rad[i] = rf(i * DS);
  const track = { def, length: def.length, total, n, pos, tan, up, right, bend, rad,
    // на полной скорости в самом крутом месте сила заноса = drift × сила руля: удержаться можно, но трудно
    // на своей трассе кривизна ограничена: один крутой угол не должен убирать занос с остальной трассы (его проходят с тормозом)
    cf: (def.drift * THRUST) / ((def.curve ? Math.min(bendMax, 1 / 40) : bendMax) * def.vmax * def.vmax), obstacles: def.obstacles || makeObstacles(def, r), forks: [] };
  for (const o of track.obstacles) o.k = radiusAt(track, o.s) / TUBE_R;   // преграда растягивается вместе с сечением
  return track;
}

/** Заполнить преграду случайными параметрами: a — её угол в сечении. */
export function fillObstacle(o, a, r, hole) {
  const R = TUBE_R, kind = o.kind;
  if (kind === 'gate') {
    o.hole = hole;
    const off = r() * (R - hole - 1.2);
    o.x = Math.cos(a) * off; o.y = Math.sin(a) * off;
  } else if (kind === 'half') {
    o.a = a; o.d = -1;                 // закрыта половина сечения в сторону a
  } else if (kind === 'bar') {
    o.a = a; o.w = (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6); o.hw = 1.1;
  } else if (kind === 'rocks') {
    o.rocks = [];
    const cnt = 2 + Math.floor(r() * 3);
    for (let i = 0, g = 0; i < cnt && g < 40; g++) {
      const q = r() * 6.28, d = r() * (R - 3), rr = 2.6 + r() * 1.5;
      const x = Math.cos(q) * d, y = Math.sin(q) * d;
      if (o.rocks.every((k) => Math.hypot(k.x - x, k.y - y) > k.r + rr + 5.5)) { o.rocks.push({ x, y, r: rr }); i++; }
    }
  } else if (kind === 'boost') {
    const off = r() * (R - 5);
    o.x = Math.cos(a) * off; o.y = Math.sin(a) * off; o.hole = 3.2;
  } else if (kind === 'fan' || kind === 'fanb') {
    o.w = kind === 'fan' ? 1 : -1;     // вентилятор на всё сечение: +1 дует в спину, −1 навстречу
  }
  return o;
}

function makeObstacles(def, r) {
  const out = [], R = TUBE_R;
  let s = 280, since = 0;
  while (s < def.length - 180) {
    const kind = def.kinds[Math.floor(r() * def.kinds.length)];
    const a = r() * Math.PI * 2;
    const o = fillObstacle({ kind, s, i: out.length }, a, r, def.hole);
    out.push(o);
    since++;
    const step = def.gap * (0.85 + r() * 0.5);
    if (since >= 3) {                     // ускоритель между преградами
      since = 0;
      const off = r() * (R - 5);
      out.push({ kind: 'boost', s: s + step / 2, x: Math.cos(a + 2) * off, y: Math.sin(a + 2) * off, hole: 3.2, i: out.length });
    }
    s += step;
  }
  return out;
}

/** Точка на оси: индексы и доля для плавной выборки. */
export function sample(track, s, arr, out, stride = 3) {
  const f = Math.max(0, Math.min(track.n - 1.001, s / DS)), i = Math.floor(f), t = f - i;
  for (let c = 0; c < stride; c++) out[c] = arr[i * stride + c] * (1 - t) + arr[(i + 1) * stride + c] * t;
  return out;
}

export const barAngle = (o, t) => o.a + o.w * t;

/** Задета ли преграда в точке (x, y) сечения в момент t. */
export function hits(o, x, y, t) {
  const k = o.k || 1, br = (BODY_R * 0.55) / k;   // в широкой части тоннеля преграда растянута в k раз
  x /= k; y /= k;
  switch (o.kind) {
    case 'gate': return Math.hypot(x - o.x, y - o.y) > o.hole - br;
    case 'half': return x * Math.cos(o.a) + y * Math.sin(o.a) > o.d;
    case 'bar': { const b = barAngle(o, t); return Math.abs(-x * Math.sin(b) + y * Math.cos(b)) < o.hw + br; }
    case 'rocks': return o.rocks.some((q) => Math.hypot(x - q.x, y - q.y) < q.r + br);
    default: return false;
  }
}

/** Одна трасса или трасса с ветками: на какой ветке сейчас этот гонщик. */
export const routeOf = (course, p) => (course.routes ? course.routes[p.route || 0] : course);

export function newRacer(lane = 0) {
  const a = (lane / 4) * Math.PI * 2 + Math.PI / 4;
  return { s: START_S, x: Math.cos(a) * 4, y: Math.sin(a) * 4, vx: 0, vy: 0, v: 0, next: 0, stun: 0, safe: 0, scrape: 0, slip: 0, fin: 0 };
}

/**
 * Один шаг. input: { x, y, brake } в [-1, 1]; vmaxK — множитель скорости (боты).
 * Возвращает список событий: ['hit'] | ['boost'] | ['wall'] | ['wind', ±1].
 */
export function stepRacer(p, input, course, t, dt, vmaxK = 1) {
  const ev = [];
  let track = routeOf(course, p);
  const vmax = track.def.vmax * vmaxK * ((p.mud || 0) > 0 ? BOMB.cap : 1);
  // плавный разгон: чем ближе к максимуму, тем медленнее; после ускорителя лишнее так же плавно гаснет
  if (input.brake) p.v = Math.max(track.def.vmax * 0.18, p.v - BRAKE * dt);
  else p.v += (vmax - p.v) * ACCEL * dt + (p.v < vmax * 0.12 ? 6 * dt : 0);
  const k = Math.min(1.3, p.v / track.def.vmax), k2 = k * k;
  const grip = GRIP_SLOW + (GRIP_FAST - GRIP_SLOW) * Math.min(1, k2);
  const steer = p.stun > 0 ? 0 : 1;
  const b = [0, 0];
  sample(track, p.s, track.bend, b, 2);
  const cx = -b[0] * track.cf * p.v * p.v, cy = -b[1] * track.cf * p.v * p.v;  // наружу из виража
  p.vx += (input.x * THRUST * steer + cx - p.vx * grip) * dt;
  p.vy += (input.y * THRUST * steer + cy - p.vy * grip) * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.slip = Math.hypot(cx, cy) / THRUST;
  p.stun = Math.max(0, p.stun - dt);
  p.safe = Math.max(0, p.safe - dt);
  p.scrape = Math.max(0, p.scrape - dt);
  p.gun = Math.max(0, (p.gun || 0) - dt);
  p.zap = Math.max(0, (p.zap || 0) - dt);
  p.mud = Math.max(0, (p.mud || 0) - dt);
  // ветер от вентилятора: попутный разгоняет выше обычного максимума, встречный тормозит
  if ((p.wind || 0) > 0) {
    p.wind = Math.max(0, p.wind - dt);
    if (p.windK > 0) p.v = Math.min(track.def.vmax * WIND.top, p.v + WIND.push * dt);
    else p.v = Math.max(track.def.vmax * WIND.low, p.v - WIND.push * dt);
  }
  // стенка: скользим вдоль неё и теряем скорость
  const lim = radiusAt(track, p.s) - BODY_R, r = Math.hypot(p.x, p.y);
  if (r > lim) {
    const nx = p.x / r, ny = p.y / r, out = p.vx * nx + p.vy * ny;
    p.x = nx * lim; p.y = ny * lim;
    if (out > 0) { p.vx -= nx * out * 1.35; p.vy -= ny * out * 1.35; }
    p.v *= 1 - Math.min(0.5, dt * 0.55);
    if (p.scrape <= 0 && out > 6) ev.push(['wall']);
    p.scrape = 0.25;
  }
  p.s += p.v * dt;
  // развилка: общая часть веток одинакова, поэтому s, x, y и номер преграды остаются верными на новой ветке
  while ((p.nf || 0) < track.forks.length && track.forks[p.nf || 0].s <= p.s) {
    const nf = p.nf || 0, opts = track.forks[nf].opts;
    let best = opts[0];
    if (input.pick !== undefined) best = opts[(input.pick + nf * 7) % opts.length];   // бот выбирает заранее
    else {                                 // игрок: куда смещён и куда рулит
      let bs = -Infinity;
      for (const q of opts) {
        const score = (p.x + input.x * 6) * q.dx + (p.y + input.y * 6) * q.dy;
        if (score > bs) { bs = score; best = q; }
      }
    }
    p.nf = nf + 1;
    p.route = best.route;
    track = routeOf(course, p);
    ev.push(['fork']);
  }
  // пролетели плоскость преграды. Преграда твёрдая: пока не окажешься напротив прохода, дальше не пустит
  const obs = track.obstacles;
  while (p.next < obs.length && obs[p.next].s <= p.s) {
    const o = obs[p.next];
    if (o.kind === 'fan' || o.kind === 'fanb') {
      p.next++;
      p.wind = WIND.time; p.windK = o.w || (o.kind === 'fan' ? 1 : -1);
      ev.push(['wind', p.windK]);
      continue;
    }
    if (o.kind === 'boost') {
      p.next++;
      if (Math.hypot(p.x - o.x * (o.k || 1), p.y - o.y * (o.k || 1)) < o.hole * (o.k || 1)) { p.v = Math.min(track.def.vmax * 1.3, p.v * 1.14 + 6); ev.push(['boost']); }
      continue;
    }
    if (!hits(o, p.x, p.y, t)) { p.next++; continue; }
    if (p.safe <= 0) {                     // удар: отскок; пока прижат к преграде, удар не повторяется
      p.v = Math.min(p.v * 0.25, 12);
      p.stun = 0.2;
      p.safe = 1.1;
      p.s = o.s - 3;
      ev.push(['hit', o.kind]);
    } else {
      p.v = Math.min(p.v, 7);
      p.s = o.s - 0.5;
    }
    break;
  }
  if (!p.fin && p.s >= track.length) { p.fin = t; ev.push(['fin']); }
  if (p.s > track.total - 40) { p.s = track.total - 40; p.v = 0; }
  return ev;
}

/* ── выстрелы: заряд летит вдоль тоннеля быстрее стрелка, попадание замедляет, преграды заряд гасят ── */
export const SHOT = { speed: 95, life: 2.2, cool: 1.1, hitR: 2.6, slow: 0.6 };

/** Точка в мире по (s, x, y) на этой ветке. */
export function worldAt(track, s, x, y, out = [0, 0, 0]) {
  const P = sample(track, s, track.pos, _p), R = sample(track, s, track.right, _r), U = sample(track, s, track.up, _u);
  for (let c = 0; c < 3; c++) out[c] = P[c] + R[c] * x + U[c] * y;
  return out;
}
const _p = [0, 0, 0], _r = [0, 0, 0], _u = [0, 0, 0], _a = [0, 0, 0], _b = [0, 0, 0];

/** Выстрел, если оружие остыло: заряд появляется перед носом. */
export function fire(p, owner) {
  if (p.gun > 0 || p.fin) return null;
  p.gun = SHOT.cool;
  return { owner, route: p.route || 0, s: p.s + 3, x: p.x, y: p.y, v: p.v + SHOT.speed, t: 0, dead: null };
}

/** Полёт заряда: dead = 'wall' (в преграду) или 'gone' (улетел). */
export function stepShot(sh, course, t, dt) {
  const tr = routeOf(course, { route: sh.route }), s0 = sh.s;
  sh.s += sh.v * dt;
  sh.t += dt;
  for (const o of tr.obstacles) {
    if (o.s > s0 && o.s <= sh.s && o.kind !== 'boost' && hits(o, sh.x, sh.y, t)) { sh.s = o.s; sh.dead = 'wall'; return; }
  }
  if (sh.t > SHOT.life || sh.s > tr.length + 60) sh.dead = 'gone';
}

/** Задел ли заряд гонщика (сравниваем точки в мире: ветки могут отличаться, а место одно). */
export function shotHits(sh, p, course) {
  if (Math.abs(p.s - sh.s) > 40) {   // быстрый отсев: на одной ветке s почти совпадают
    if (!course.routes || (p.route || 0) === sh.route) return false;
  }
  worldAt(routeOf(course, { route: sh.route }), sh.s, sh.x, sh.y, _a);
  worldAt(routeOf(course, p), p.s, p.x, p.y, _b);
  return Math.hypot(_a[0] - _b[0], _a[1] - _b[1], _a[2] - _b[2]) < SHOT.hitR;
}

/** Попадание: скорость падает, а удар не повторяется сразу. */
export function zap(p) { p.v *= SHOT.slow; p.zap = 0.8; }

/* ── грязевая бомба: одна на трассу; всех остальных тормозит и 2,5 с не пускает выше половины скорости ── */
export const BOMB = { mud: 2.5, slow: 0.6, cap: 0.5 };
export function mudBomb(p) { p.v *= BOMB.slow; p.mud = BOMB.mud; }

/** Бот стреляет, если кто-то впереди почти на одной линии. */
export function botAims(p, others) {
  for (const q of others) {
    const ds = q.s - p.s;
    if (q !== p && !q.fin && ds > 8 && ds < 150 && (q.route || 0) === (p.route || 0) && Math.hypot(q.x - p.x, q.y - p.y) < 2.2) return true;
  }
  return false;
}

/** Куда лететь, чтобы пройти преграду. */
export function safePoint(o, t, x, y) {
  switch (o.kind) {
    case 'gate': case 'boost': return [o.x, o.y];
    case 'half': return [-Math.cos(o.a) * 6.5, -Math.sin(o.a) * 6.5];
    case 'bar': {
      const b = barAngle(o, t), s = -x * Math.sin(b) + y * Math.cos(b) >= 0 ? 1 : -1;
      return [-Math.sin(b) * 7.5 * s, Math.cos(b) * 7.5 * s];
    }
    case 'rocks': {
      let best = [0, 0], bd = -1;
      for (let i = 0; i < 25; i++) {
        const q = i < 8 ? (i / 8) * 6.28 : ((i - 8) / 17) * 6.28, d = i < 8 ? 4 : 8;
        const px = i === 24 ? 0 : Math.cos(q) * d, py = i === 24 ? 0 : Math.sin(q) * d;
        const c = Math.min(...o.rocks.map((k) => Math.hypot(px - k.x, py - k.y) - k.r)) - Math.hypot(px - x, py - y) * 0.03;
        if (c > bd) { bd = c; best = [px, py]; }
      }
      return best;
    }
    default: return [0, 0];
  }
}

/** Бот: летит к безопасной точке следующей преграды и гасит занос. skill: { miss, vmaxK, sloppy, seed } */
export function botInput(p, course, t, skill, out) {
  const track = routeOf(course, p), obs = track.obstacles;
  let o = obs[p.next];
  for (let j = p.next; o && (o.kind === 'fan' || o.kind === 'fanb'); ) o = obs[++j];   // через ветер летим как есть
  // ускоритель берём, только если следующая за ним преграда далеко
  if (o && o.kind === 'boost') {
    const after = obs[p.next + 1];
    if (skill.miss > 0.2 || (after && after.s - o.s < 40)) o = after;
  }
  let tx = 0, ty = 0;
  if (o && o.s - p.s < p.v * 1.5 + 30) {
    const mark = (o.s * 7919 + skill.seed * 104729) % 1000 / 1000;
    if (mark >= skill.miss || p.safe > 0 || p.v < 15) {   // зазевался — но после удара обязательно ищет проход
      const arrive = t + (o.s - p.s) / Math.max(p.v, 10);
      const k = o.k || 1;
      [tx, ty] = safePoint(o, arrive, p.x / k, p.y / k);
      tx *= k; ty *= k;
    }
  }
  const b = [0, 0];
  sample(track, p.s, track.bend, b, 2);
  const comp = (track.cf * p.v * p.v) / THRUST;
  out.x = Math.max(-1, Math.min(1, (tx - p.x) * 0.5 - p.vx * 0.09 + b[0] * comp * skill.sloppy));
  out.y = Math.max(-1, Math.min(1, (ty - p.y) * 0.5 - p.vy * 0.09 + b[1] * comp * skill.sloppy));
  out.brake = false;
  out.pick = skill.seed;
  return out;
}
