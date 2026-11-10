/**
 * Своя трасса из блоков: поле 64×24×64, один блок — кусок тоннеля 28 ед.
 * Код «r1» — старое поле 32×16×32 (его читает версия 1.7), «r2» — большое; трасса, что влезает в старое поле, пишется как r1.
 * Блоки соединяются гранями. Поток идёт от старта: дорога и преграды ведут вперёд, а блок «развилка» разводит
 * трассу на ветки и снова сводит их. Без графики — этим же модулем сервер проверяет присланные трассы.
 *
 * Названия только из готовых слов и без автора: общий каталог виден всем детям, свободного текста в нём нет.
 */
import { buildTrack, fillObstacle, rng, sample } from './race-sim.js';

export const W = 64, H = 24, CELL = 28, MAX_BLOCKS = 1200, MIN_BLOCKS = 8, MAX_ROUTES = 16;
const W1 = 32, H1 = 16, MAX1 = 600;      // поле и предел кода r1
export const BLOCKS = [
  { id: 'path', name: 'Дорога', icon: '🟦' },
  { id: 'start', name: 'Старт', icon: '🟢' },
  { id: 'finish', name: 'Финиш', icon: '🏁' },
  { id: 'gate', name: 'Ворота', icon: '⭕', kind: 'gate' },
  { id: 'half', name: 'Стена', icon: '🧱', kind: 'half' },
  { id: 'bar', name: 'Вертушка', icon: '➖', kind: 'bar' },
  { id: 'rocks', name: 'Камни', icon: '🪨', kind: 'rocks' },
  { id: 'boost', name: 'Ускоритель', icon: '⚡', kind: 'boost' },
  { id: 'fork', name: 'Развилка', icon: '🔀' },
  { id: 'fan', name: 'Попутный ветер', icon: '🌬️', kind: 'fan' },
  { id: 'fanb', name: 'Встречный ветер', icon: '🌀', kind: 'fanb' },
];
export const T = Object.fromEntries(BLOCKS.map((b, i) => [b.id, i]));
export const DIFFS = {
  easy: { name: 'Легко', vmax: 70, drift: 0.5, hole: 6.2, bots: [[0.28, 0.84, 0.55], [0.38, 0.78, 0.4], [0.48, 0.74, 0.3]] },
  mid: { name: 'Средне', vmax: 85, drift: 0.65, hole: 5.4, bots: [[0.2, 0.92, 0.7], [0.3, 0.87, 0.5], [0.42, 0.82, 0.4]] },
  hard: { name: 'Трудно', vmax: 100, drift: 0.8, hole: 4.8, bots: [[0.12, 0.97, 0.85], [0.25, 0.92, 0.6], [0.35, 0.87, 0.5]] },
};
const DIFF_IDS = Object.keys(DIFFS);
const WORD_A = ['Звёздная', 'Лунная', 'Крутая', 'Быстрая', 'Кометная', 'Хитрая', 'Весёлая', 'Огненная', 'Ледяная', 'Тайная', 'Дальняя', 'Золотая', 'Радужная', 'Тихая', 'Шальная', 'Смелая'];
const WORD_B = ['петля', 'горка', 'трасса', 'дорога', 'спираль', 'орбита', 'змейка', 'галактика', 'тропа', 'туманность', 'дуга', 'карусель', 'река', 'лестница', 'лента', 'ракета'];
export const trackName = (d) => `${WORD_A[d.a & 15]} ${WORD_B[d.b & 15]}`;

export const keyOf = (x, y, z) => x + z * W + y * W * W;
export const xyzOf = (k) => [k % W, Math.floor(k / (W * W)), Math.floor(k / W) % W];
export const inField = (x, y, z) => x >= 0 && x < W && z >= 0 && z < W && y >= 0 && y < H;

export const newDesign = () => ({ a: Math.floor(Math.random() * 16), b: Math.floor(Math.random() * 16), d: 'easy', blocks: new Map() });

/* ── код трассы: «r1»/«r2», название, сложность и по 3 (r1) или 4 (r2) знака на блок ── */
const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function encode(d) {
  const list = [...d.blocks].map(([k, t]) => [xyzOf(k), t]);
  const small = list.length <= MAX1 && list.every(([[x, y, z]]) => x < W1 && z < W1 && y < H1);
  const vals = list.map(([[x, y, z], t]) => (small ? x + z * W1 + y * W1 * W1 : keyOf(x, y, z)) * 16 + t).sort((p, q) => p - q);
  let s = `r${small ? 1 : 2}${ABC[d.a & 15]}${ABC[d.b & 15]}${ABC[Math.max(0, DIFF_IDS.indexOf(d.d))]}`;
  for (const v of vals) s += (small ? '' : ABC[(v >> 18) & 63]) + ABC[(v >> 12) & 63] + ABC[(v >> 6) & 63] + ABC[v & 63];
  return s;
}
export function decode(code) {
  const s = String(code || '').trim(), ver = s.slice(0, 2), n = ver === 'r1' ? 3 : ver === 'r2' ? 4 : 0;
  if (!n || s.length < 5 || (s.length - 5) % n || s.length > 5 + MAX_BLOCKS * n) return null;
  const nums = [];
  for (let i = 2; i < s.length; i++) { const c = ABC.indexOf(s[i]); if (c < 0) return null; nums.push(c); }
  const [a, b, di] = nums;
  if (a > 15 || b > 15 || di >= DIFF_IDS.length) return null;
  const blocks = new Map();
  for (let i = 3; i < nums.length; i += n) {
    let v = 0;
    for (let j = 0; j < n; j++) v = v * 64 + nums[i + j];
    const t = v & 15, q = Math.floor(v / 16);
    const [x, y, z] = n === 3 ? [q % W1, Math.floor(q / (W1 * W1)), Math.floor(q / W1) % W1] : [q % W, Math.floor(q / (W * W)), Math.floor(q / W) % W];
    if (t >= BLOCKS.length || !inField(x, y, z)) return null;
    const k = keyOf(x, y, z);
    if (blocks.has(k)) return null;
    blocks.set(k, t);
  }
  return { a, b, d: DIFF_IDS[di], blocks };
}

/* ── разбор: от старта к финишу ── */
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
const step = (k, d) => { const [x, y, z] = xyzOf(k), q = DIRS[d]; return inField(x + q[0], y + q[1], z + q[2]) ? keyOf(x + q[0], y + q[1], z + q[2]) : -1; };

/**
 * Поток идёт от узла (старт, развилка) блоками дороги до следующего узла. На дороге выбор всегда один: прямо, если можно,
 * поэтому змейка из соседних рядов не срезается. Тупики в трассу не входят, в редакторе они тусклые.
 */
export function analyze(design) {
  const b = design.blocks, errors = [];
  const of = (t) => [...b].filter(([, v]) => v === t).map(([k]) => k);
  const starts = of(T.start), finishes = of(T.finish);
  if (starts.length !== 1) errors.push(starts.length ? 'Старт должен быть один' : 'Поставь старт 🟢');
  if (finishes.length !== 1) errors.push(finishes.length ? 'Финиш должен быть один' : 'Поставь финиш 🏁');
  if (errors.length) return { ok: false, errors, routes: [], used: new Set() };

  const S = starts[0], F = finishes[0];
  const isNode = (k) => { const t = b.get(k); return t === T.start || t === T.finish || t === T.fork; };
  const claimed = new Set();
  const edges = [];                       // { from, to, path: [ключи дороги] }
  const walk = (from, first, dir) => {
    const seen = new Set(), path = [];
    const go = (k, d) => {
      seen.add(k); path.push(k);
      const order = [d, ...DIRS.map((_, i) => i).filter((i) => i !== d)];
      for (const nodesOnly of [true, false]) {       // сперва прямо, потом узел сбоку, потом поворот
        for (const i of order) {
          const n = step(k, i);
          if (n < 0 || !b.has(n)) continue;
          if (isNode(n)) { if (n !== from && n !== S && (i === d || nodesOnly)) return n; continue; }
          if (nodesOnly && i !== d) continue;
          if (claimed.has(n) || seen.has(n)) continue;
          const end = go(n, i);
          if (end !== null) return end;
        }
      }
      path.pop();
      return null;
    };
    const to = go(first, dir);
    return to === null ? null : { from, to, path };
  };
  const queue = [S], done = new Set();
  while (queue.length) {
    const from = queue.shift();
    if (done.has(from) || from === F) continue;
    done.add(from);
    for (let i = 0; i < DIRS.length; i++) {
      const n = step(from, i);
      if (n < 0 || !b.has(n)) continue;
      let e = null;
      if (isNode(n)) { if (n !== S && !edges.some((q) => q.from === n && q.to === from)) e = { from, to: n, path: [] }; }
      else if (!claimed.has(n)) e = walk(from, n, i);
      if (!e) continue;
      for (const k of e.path) claimed.add(k);
      edges.push(e);
      queue.push(e.to);
      if (from === S) break;              // от старта дорога одна
    }
  }

  // все пути от старта до финиша
  const paths = [];
  let tooMany = false;
  const visit = (node, list, nodes) => {
    if (tooMany) return;
    if (node === F) { if (paths.length >= MAX_ROUTES) tooMany = true; else paths.push(list.slice()); return; }
    for (const e of edges) {
      if (e.from !== node || nodes.has(e.to)) continue;
      nodes.add(e.to); list.push(e);
      visit(e.to, list, nodes);
      list.pop(); nodes.delete(e.to);
    }
  };
  visit(S, [], new Set([S]));
  if (tooMany) return { ok: false, errors: [`Слишком много развилок: больше ${MAX_ROUTES} путей`], routes: [], used: new Set() };
  if (!paths.length) return { ok: false, errors: ['Дорога не доходит от старта до финиша'], routes: [], used: new Set() };

  const routes = paths.map((list) => {
    const chain = [S], at = [];
    for (const e of list) { at.push(chain.length - 1); chain.push(...e.path, e.to); }
    return { edges: list, chain, at };    // at[k] — индекс узла, из которого вышло ребро k
  });
  const used = new Set(routes.flatMap((r) => r.chain));
  const shortest = Math.min(...routes.map((r) => r.chain.length));
  if (shortest < MIN_BLOCKS) errors.push(`Трасса слишком короткая: нужно хотя бы ${MIN_BLOCKS} блоков`);
  return { ok: !errors.length, errors, routes, used, length: Math.max(...routes.map((r) => r.chain.length)) * CELL };
}

/* ── «Достроить»: дорога от конца построенного к финишу, а если финиша нет — несколько блоков вперёд и финиш ── */

/** Список [ключ, тип] новых блоков или null, если достроить нельзя (тогда кнопки нет). */
export function autoComplete(design) {
  const b = design.blocks;
  const starts = [...b].filter(([, t]) => t === T.start).map(([k]) => k);
  const fins = [...b].filter(([, t]) => t === T.finish).map(([k]) => k);
  if (starts.length !== 1 || fins.length > 1) return null;
  const S = starts[0], F = fins[0];
  const near = (k) => DIRS.map((_, i) => step(k, i)).filter((n) => n >= 0);
  // от старта по блокам: самый дальний блок — конец построенной дороги
  const dist = new Map([[S, 0]]), from = new Map(), q = [S];
  while (q.length) {
    const k = q.shift();
    for (const n of near(k)) if (b.has(n) && !dist.has(n)) { dist.set(n, dist.get(k) + 1); from.set(n, k); q.push(n); }
  }
  if (F !== undefined && dist.has(F)) return null;          // финиш уже связан: не хватает чего-то другого
  let tip = S;
  for (const [k, d] of dist) if (d > dist.get(tip)) tip = k;
  const free = (k, ok) => !b.has(k) && near(k).every((n) => !b.has(n) || ok(n));
  const ops = [];
  if (F !== undefined) {
    const goal = new Set([F]);
    for (let g = [F]; g.length;) { const k = g.pop(); for (const n of near(k)) if (b.has(n) && !goal.has(n) && !dist.has(n)) { goal.add(n); g.push(n); } }
    // сперва дорога, которая не касается чужих блоков; не вышло — любая
    for (const strict of [true, false]) {
      const ok = (n) => !strict || n === tip || goal.has(n);
      const prev = new Map(), open = [];
      for (const n of near(tip)) if (free(n, ok)) { prev.set(n, -1); open.push(n); }
      let end = -1;
      while (open.length && end < 0) {
        const k = open.shift();
        if (near(k).some((n) => goal.has(n))) { end = k; break; }
        for (const n of near(k)) if (!prev.has(n) && free(n, ok)) { prev.set(n, k); open.push(n); }
      }
      if (end < 0) continue;
      for (let k = end; k >= 0; k = prev.get(k)) ops.push([k, T.path]);
      return ops.reverse();
    }
    return null;
  }
  // финиша нет: продолжаем прямо, у края или препятствия поворачиваем, последний блок — финиш
  const [tx, ty, tz] = xyzOf(tip), base = from.has(tip) ? xyzOf(from.get(tip)) : [tx, ty, tz - 1];
  let dir = DIRS.findIndex((d) => d[0] === tx - base[0] && d[1] === ty - base[1] && d[2] === tz - base[2]);
  if (dir < 0 || dir > 3) dir = 2;
  const want = Math.max(4, MIN_BLOCKS + 4 - (dist.get(tip) + 1));
  const used = new Set([tip]);
  let k = tip;
  for (let i = 0; i < want; i++) {
    const order = [dir, ...[0, 1, 2, 3].filter((d) => d !== dir)];
    const n = order.map((d) => [d, step(k, d)]).find(([, c]) => c >= 0 && free(c, (m) => used.has(m) || m === k) && !used.has(c));
    if (!n) break;
    [dir, k] = n;
    used.add(k);
    ops.push([k, T.path]);
  }
  if (!ops.length) return null;
  ops[ops.length - 1][1] = T.finish;
  return ops;
}

/**
 * «Достроить с развилкой»: от конца дороги — развилка, прямая ветка с ускорителем и петля сбоку с воротами,
 * ветки сходятся во второй развилке, дальше несколько блоков и финиш. Только если финиша ещё нет. Иначе null.
 */
export function autoFork(design) {
  const b = design.blocks;
  const starts = [...b].filter(([, t]) => t === T.start).map(([k]) => k);
  if (starts.length !== 1 || [...b.values()].includes(T.finish)) return null;
  const S = starts[0], near = (k) => DIRS.map((_, i) => step(k, i)).filter((n) => n >= 0);
  const dist = new Map([[S, 0]]), from = new Map(), q = [S];
  while (q.length) { const k = q.shift(); for (const n of near(k)) if (b.has(n) && !dist.has(n)) { dist.set(n, dist.get(k) + 1); from.set(n, k); q.push(n); } }
  let tip = S;
  for (const [k, d] of dist) if (d > dist.get(tip)) tip = k;
  const [tx, ty, tz] = xyzOf(tip), base = from.has(tip) ? xyzOf(from.get(tip)) : [tx, ty, tz - 1];
  const d0 = [tx - base[0], 0, tz - base[2]];
  if (!d0[0] && !d0[2]) d0[2] = 1;
  const L = 6;
  const turns = [d0, [d0[2], 0, -d0[0]], [-d0[2], 0, d0[0]], [-d0[0], 0, -d0[2]]];
  for (const d of turns) for (const sd of [[d[2], 0, -d[0]], [-d[2], 0, d[0]]]) {
    const at = (base0, k, s) => [base0[0] + d[0] * k + sd[0] * s, ty, base0[2] + d[2] * k + sd[2] * s];
    const F = [tx + d[0], ty, tz + d[2]];
    const cells = [[F, T.fork]];
    for (let k = 1; k < L; k++) cells.push([at(F, k, 0), k === 3 ? T.boost : T.path]);              // прямо
    for (let s = 1; s <= 3; s++) cells.push([at(F, 0, s), T.path]);                                 // петля сбоку
    for (let k = 1; k <= L; k++) cells.push([at(F, k, 3), k === 3 ? T.gate : T.path]);
    for (let s = 2; s >= 1; s--) cells.push([at(F, L, s), T.path]);
    cells.push([at(F, L, 0), T.fork]);
    for (let k = L + 1; k <= L + 4; k++) cells.push([at(F, k, 0), k === L + 4 ? T.finish : T.path]);
    if (!cells.every(([c]) => inField(...c))) continue;
    const keys = new Set(cells.map(([c]) => keyOf(...c)));
    // клетки свободны и не касаются чужих блоков (кроме конца дороги у первой развилки)
    if ([...keys].some((k) => b.has(k) || near(k).some((n) => b.has(n) && !keys.has(n) && !(n === tip && k === keyOf(...F))))) continue;
    const ops = cells.map(([c, t]) => [keyOf(...c), t]);
    const test = new Map(b); for (const [k, t] of ops) test.set(k, t);
    const a = analyze({ ...design, blocks: test });
    if (a.ok && a.routes.length >= 2) return ops;
  }
  return null;
}

/* ── трасса для гонки ── */

/** Ось по блокам: сглаженная кубическим B-сплайном, поэтому лесенка становится подъёмом, а угол — виражом. */
function axisOf(chain) {
  const P = chain.map((k) => xyzOf(k).map((v) => v * CELL));
  const dir = (a, b) => { const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d) || 1; return d.map((v) => (v / l) * CELL); };
  const d0 = dir(P[0], P[1]), d1 = dir(P[P.length - 2], P[P.length - 1]), last = P[P.length - 1];
  const cps = [3, 2, 1].map((m) => P[0].map((v, c) => v - d0[c] * m)).concat(P, [1, 2, 3, 4, 5, 6, 7, 8].map((m) => last.map((v, c) => v + d1[c] * m)));
  const N = 10, pts = [], arc = [0], arcAt = new Float64Array(cps.length);
  for (let i = 1; i < cps.length - 2; i++) {
    for (let q = 0; q < N; q++) {
      const t = q / N, t2 = t * t, t3 = t2 * t;
      const w = [(1 - 3 * t + 3 * t2 - t3) / 6, (4 - 6 * t2 + 3 * t3) / 6, (1 + 3 * t + 3 * t2 - 3 * t3) / 6, t3 / 6];
      const p = [0, 1, 2].map((c) => w[0] * cps[i - 1][c] + w[1] * cps[i][c] + w[2] * cps[i + 1][c] + w[3] * cps[i + 2][c]);
      if (pts.length) { const o = pts[pts.length - 1]; arc.push(arc[arc.length - 1] + Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2])); }
      pts.push(p);
      if (q === 0) arcAt[i] = arc[arc.length - 1];
    }
  }
  const curve = (u) => {
    const end = pts.length - 1;
    if (u >= arc[end]) { const a = pts[end - 1], b = pts[end], l = arc[end] - arc[end - 1] || 1, f = (u - arc[end]) / l; return [0, 1, 2].map((c) => b[c] + (b[c] - a[c]) * f); }
    let lo = 0, hi = end;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arc[m] <= u) lo = m; else hi = m; }
    const f = (u - arc[lo]) / (arc[hi] - arc[lo] || 1);
    return [0, 1, 2].map((c) => pts[lo][c] + (pts[hi][c] - pts[lo][c]) * f);
  };
  return { curve, sAt: (j) => arcAt[j + 3], P };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Повернуть преграду в оси сечения другой ветки: после слияния оси веток могут отличаться на постоянный угол. */
function turned(o, th) {
  const c = Math.cos(th), s = Math.sin(th), r = (q) => { const { x, y } = q; q.x = x * c - y * s; q.y = x * s + y * c; };
  const n = { ...o };
  if (o.a !== undefined) n.a = o.a + th;
  if (o.x !== undefined) r(n);
  if (o.rocks) n.rocks = o.rocks.map((k) => { const q = { ...k }; r(q); return q; });
  return n;
}

/** Готовая трасса: routes — по одной на каждый путь, draw — преграды, каждая один раз, для рисования. */
export function buildCourse(design) {
  const a = analyze(design);
  if (!a.ok) return null;
  const df = DIFFS[design.d] || DIFFS.easy;
  const code = encode(design);
  let seed = 7;
  for (let i = 0; i < code.length; i++) seed = (Math.imul(seed, 31) + code.charCodeAt(i)) >>> 0;
  const base = { custom: true, id: 'my', name: trackName(design), seed, vmax: df.vmax, drift: df.drift, hole: df.hole, bots: df.bots };
  const first = new Map(), draw = [], axes = [];
  const routes = a.routes.map((rt) => {
    const ax = axisOf(rt.chain);
    axes.push(ax);
    const obstacles = [];
    rt.chain.forEach((k, j) => {
      const kind = BLOCKS[design.blocks.get(k)].kind;
      if (!kind) return;
      const r = rng((seed ^ Math.imul(k + 1, 2654435761)) >>> 0);
      obstacles.push(fillObstacle({ kind, s: ax.sAt(j), key: k }, r() * Math.PI * 2, r, df.hole));
    });
    return buildTrack({ ...base, length: ax.sAt(rt.chain.length - 1), curve: ax.curve, obstacles });
  });
  // одну и ту же преграду на разных ветках приводим к общему положению в мире
  const f0 = [0, 0, 0], f1 = [0, 0, 0];
  routes.forEach((tr, ri) => {
    tr.obstacles = tr.obstacles.map((o) => {
      const was = first.get(o.key);
      if (!was) { first.set(o.key, { o, tr }); draw.push({ track: tr, o }); return o; }
      sample(was.tr, was.o.s, was.tr.right, f0);
      const c = dot(f0, sample(tr, o.s, tr.right, f1)), s = dot(f0, sample(tr, o.s, tr.up, f1));
      return { ...turned(was.o, Math.atan2(s, c)), s: o.s };
    });
    tr.chain = a.routes[ri].chain;
  });
  // развилки: общая часть двух путей совпадает до блока перед развилкой, там и выбирается ветка
  a.routes.forEach((rt, ri) => {
    rt.edges.forEach((e, k) => {
      const same = a.routes.map((q, i) => [q, i]).filter(([q]) => rt.edges.slice(0, k).every((x, n) => q.edges[n] === x) && q.edges[k]);
      const nexts = [...new Set(same.map(([q]) => q.edges[k]))];
      if (nexts.length < 2) return;
      const f = rt.at[k], fp = axes[ri].P[f], s = axes[ri].sAt(Math.max(0, f - 1)), tr = routes[ri];
      const R = sample(tr, s, tr.right, [0, 0, 0]), U = sample(tr, s, tr.up, [0, 0, 0]);
      const opts = nexts.map((x) => {
        const route = x === e ? ri : same.find(([q]) => q.edges[k] === x)[1];
        const P = axes[route].P, to = P[Math.min(f + 3, P.length - 1)], d = [to[0] - fp[0], to[1] - fp[1], to[2] - fp[2]];
        return { route, dx: dot(d, R), dy: dot(d, U) };
      });
      tr.forks.push({ s, opts });
    });
  });
  // какие куски труб уже нарисованы другим путём
  const cells = new Map(), near = (x, y, z) => {
    const h = 6, cx = Math.floor(x / h), cy = Math.floor(y / h), cz = Math.floor(z / h);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) {
      for (const q of cells.get(`${cx + i},${cy + j},${cz + l}`) || []) if (Math.hypot(q[0] - x, q[1] - y, q[2] - z) < 3.5) return true;
    }
    return false;
  };
  for (const tr of routes) {
    tr.drawn = new Uint8Array(tr.n);
    const fresh = [];
    for (let i = 0; i < tr.n; i++) {
      const p = [tr.pos[i * 3], tr.pos[i * 3 + 1], tr.pos[i * 3 + 2]];
      if (near(...p)) continue;
      tr.drawn[i] = 1;
      fresh.push(p);
    }
    for (const p of fresh) { const c = `${Math.floor(p[0] / 6)},${Math.floor(p[1] / 6)},${Math.floor(p[2] / 6)}`; (cells.get(c) || cells.set(c, []).get(c)).push(p); }
  }
  return { def: { ...base, length: routes[0].length }, routes, draw };
}

/* ── примеры ── */

/** Трасса «по шагам»: E W N S U D с числом — шаги; s f g h b r o x — тип текущего блока; @имя запомнить, >имя вернуться. */
function sketch(a, b, d, from, script) {
  const blocks = new Map(), marks = {};
  const TYPES = { s: T.start, f: T.finish, g: T.gate, h: T.half, b: T.bar, r: T.rocks, o: T.boost, x: T.fork, w: T.fan, v: T.fanb };
  const MOVE = { E: [1, 0, 0], W: [-1, 0, 0], N: [0, 0, 1], S: [0, 0, -1], U: [0, 1, 0], D: [0, -1, 0] };
  let c = from.slice();
  blocks.set(keyOf(...c), T.path);
  for (const t of script.trim().split(/\s+/)) {
    if (t[0] === '@') marks[t.slice(1)] = c.slice();
    else if (t[0] === '>') c = marks[t.slice(1)].slice();
    else if (MOVE[t[0]]) {
      for (let i = Number(t.slice(1) || 1); i > 0; i--) {
        c = c.map((v, q) => v + MOVE[t[0]][q]);
        const k = keyOf(...c);
        if (!blocks.has(k)) blocks.set(k, T.path);
      }
    } else blocks.set(keyOf(...c), TYPES[t]);
  }
  return { a, b, d, blocks };
}
export const EXAMPLES = [
  sketch(1, 1, 'easy', [6, 0, 4], 's E5 g E5 o E4 N5 h N5 U2 W6 r W6 N6 g E12 o E2 f'),
  sketch(5, 0, 'mid', [4, 0, 4], 's E4 h E3 x @a E3 b E2 g E3 x @m >a N4 E4 o E4 S4 >m E4 N6 g N2 U2 W6 x @c W3 r W3 x @d >c U3 W3 o W3 D3 >d N6 o W4 f'),
  sketch(2, 4, 'hard', [10, 0, 10], 's E8 g N8 r W8 h S7 U2 S E8 b N4 x @a N4 W4 g W4 x @b >a E2 N6 W6 o W6 S2 E2 >b U2 S8 E8 b N8 W4 o W f'),
  // лестница вверх: три этажа, на каждом своя преграда
  sketch(9, 6, 'mid', [4, 0, 4], 's E10 g E2 N10 r N2 U3 W12 h W2 S6 o S2 U3 E14 b E2 N4 f'),
  // тройная развилка: прямо с ускорителем, вверх по кругу через вертушку или вниз через камни
  sketch(4, 9, 'mid', [2, 0, 10], 's E5 h E1 x @a E3 o E5 x @m >a N4 E4 b E4 S4 >a S4 E4 r E4 N4 >m E5 g E4 f'),
  // горки: вверх-вниз, как в аквапарке
  sketch(12, 15, 'hard', [2, 0, 16], 's E3 U4 E3 o D4 E3 U4 b E3 D4 r E3 U3 E3 g D3 E3 f'),
  // мост: трасса пролетает над собой
  sketch(13, 3, 'easy', [4, 0, 4], 's E12 g N12 r W6 U2 S14 o S2 W6 f'),
  // длинная лента для новичков
  sketch(6, 14, 'easy', [2, 0, 2], 's E8 g E10 o E8 N3 W8 h W10 r W8 N3 E8 b E10 g E8 N3 W12 o W12 f'),
];

/* ── свои трассы на устройстве ── */
const KEY = 'tg.my.races';
export const myRaces = {
  list() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } },
  save(id, design, copy = false) {
    const all = this.list(), was = all.find((x) => x.id === id);
    const item = { id: id || `t${Date.now().toString(36)}`, code: encode(design), at: Date.now(), ...(copy || was?.copy ? { copy: true } : {}) };
    const i = all.findIndex((x) => x.id === item.id);
    if (i >= 0) all[i] = item; else all.unshift(item);
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, 50)));
    return item;
  },
  remove(id) { localStorage.setItem(KEY, JSON.stringify(this.list().filter((x) => x.id !== id))); },
  get(id) { return this.list().find((x) => x.id === id) || null; },
};
