/**
 * Открытый мир: свободный полёт корабля без графики (проверка: tools/world-test.mjs).
 * В гонке корабль на рельсе (s вдоль оси трубы, x и y в сечении) — здесь наоборот: своя точка в мире,
 * своя скорость и свой базис (nose вперёд, up вверх, right вправо). Поворот — рысканье и тангаж;
 * крен только для вида. Скорость догоняет направление носа, поэтому на вираже немного проносит,
 * но потерять себя нельзя: up всё время подтягивается к мировому верху.
 *
 * Трассы стоят в мире по слотам из хеша своего кода (layout): каталог у всех один — и мир у всех один,
 * синхронизировать нечего. Влетел в воронку старта — дальше считает race-sim.js.
 */
export const WORLD_R = 6200;              // радиус шара мира
export const SHIP_R = 1.6;
export const GATE_R = 26;                 // воронка старта шире трубы: малышу нужно попасть
export const FLY = {
  vmax: 120, accel: 0.5,                  // разгон: доля оставшейся до максимума скорости в секунду
  brake: 70, vmin: 14,                    // до соседней трассы ≈ 9 с: медленнее — скучно лететь
  turn: 1.25,                             // рад/с рысканья и тангажа на полном отклонении
  slip: 3.4,                              // как быстро скорость догоняет нос (меньше — сильнее проносит)
  level: 1.2,                             // возврат «верха» к мировому
  bank: 4,                                // как быстро корабль кладётся в вираж (вид)
};

/* ── вектора ── */
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export function norm(a) {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Повернуть v вокруг единичной оси k на угол th (формула Родрига). */
export function rot(v, k, th) {
  const c = Math.cos(th), s = Math.sin(th), x = cross(k, v), d = dot(k, v) * (1 - c);
  return [v[0] * c + x[0] * s + k[0] * d, v[1] * c + x[1] * s + k[1] * d, v[2] * c + x[2] * s + k[2] * d];
}

/* ── расстановка трасс по миру ── */
const GX = 13, GY = 5, STEP = 1100;       // решётка слотов 13 × 5 × 13, между центрами 1100 (≈ 9 с полёта)
export const SPAWN_GAP = 360;             // ближе этого к спавну трассы не ставим: иначе влетишь в старт сразу
/** Слоты внутри шара мира, по возрастанию удалённости от спавна: место для трассы есть всегда, пока их хватает. */
export const SLOT_POS = (() => {
  const all = [];
  for (let n = 0; n < GX * GY * GX; n++) {
    const i = n % GX, j = Math.floor(n / (GX * GX)) % GY, k = Math.floor(n / GX) % GX;
    const p = [(i - (GX - 1) / 2) * STEP, (j - (GY - 1) / 2) * STEP * 1.2, (k - (GX - 1) / 2) * STEP];
    const d = len(p);
    if (d > WORLD_R - 400 || d < SPAWN_GAP) continue;
    all.push(p);
  }
  return all.sort((a, b) => len(a) - len(b));
})();
export const SLOTS = SLOT_POS.length;
/**
 * Сколько чужих трасс в мире. Меньше трети слотов — чтобы цепочки занятых слотов были короткими:
 * тогда новая трасса почти никогда не сдвигает уже стоящие, и ребёнок находит свою там, где оставил.
 * Остальной каталог — в списке (races.html); в мире видны самые свежие.
 */
export const WORLD_MAX = 120;
export function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/**
 * Куда встанет каждая трасса. ids — коды или id трасс в порядке каталога (сервер отдаёт свежие первыми):
 * порядок сохраняем, поэтому при переполнении слотов в мир попадают свежие трассы, а не те, чей код раньше
 * по алфавиту. Каталог у всех один — и мир один; место трассы считается из хеша её кода, а не из номера в списке,
 * так что новая трасса не сдвигает остальные. Два хеша в один слот — второй едет в следующий свободный.
 * first — свои трассы: им слоты у спавна, чтобы ребёнок сразу нашёл своё.
 * Трасс больше, чем слотов, — лишние остаются только в списке (races.html); сколько встало, видно по out.size.
 */
export function layout(ids, first = []) {
  const taken = new Set(), out = new Map();
  const mine = [...new Set(first.map(String))];
  const rest = [...new Set([...ids].map(String))].filter((x) => !mine.includes(x)).slice(0, WORLD_MAX);
  let near = 0;
  for (const id of mine) {                                         // свои — в ближайшие свободные слоты
    while (near < SLOTS && taken.has(near)) near++;
    if (near >= SLOTS) break;
    taken.add(near);
    out.set(id, placeAt(id, near));
  }
  for (const id of rest) {
    const h = hash32(id);
    let n = h % SLOTS, g = 0;
    while (g < SLOTS && taken.has(n)) { n = (n + 1) % SLOTS; g++; }
    if (g >= SLOTS) break;                                         // слотов больше нет
    taken.add(n);
    out.set(id, placeAt(id, n));
  }
  return out;
}

/** Воронка трассы id в слоте n: направление горловины тоже из хеша, поэтому мир выглядит живым. */
function placeAt(id, n) {
  const h = hash32(id);
  const a = (((h >>> 8) & 0xff) / 0x100) * Math.PI * 2;            // куда смотрит горловина
  const tilt = ((((h >>> 20) & 0xff) / 0x100) - 0.5) * 0.5;        // наклон горловины, ±0.25 рад
  const nose = norm([Math.sin(a) * Math.cos(tilt), Math.sin(tilt), Math.cos(a) * Math.cos(tilt)]);
  return gateOf(SLOT_POS[n], nose, GATE_R);
}

/** Воронка: точка, направление внутрь трубы и оси сечения. */
export function gateOf(pos, nose, r = GATE_R) {
  const n = norm(nose);
  let up = [0, 1, 0];
  if (Math.abs(dot(n, up)) > 0.97) up = [0, 0, 1];
  const right = norm(cross(up, n));
  return { pos: [...pos], nose: n, right, up: cross(n, right), r };
}

/* ── пилот ── */
export function newPilot(pos = [0, 0, 0], nose = [0, 0, 1]) {
  const g = gateOf(pos, nose);
  return { p: [...pos], nose: g.nose, right: g.right, up: g.up, vel: [0, 0, 0], v: 0, bank: 0, edge: 0 };
}

/**
 * Один шаг. input: { x, y, brake } в [-1, 1]: x — рысканье (вправо), y — тангаж (нос вверх).
 * Возвращает события: ['enter', id, { x, y, v }] | ['edge'].
 */
export function stepPilot(q, input, gates, dt) {
  const ev = [];
  const steerX = Math.max(-1, Math.min(1, input.x || 0)), steerY = Math.max(-1, Math.min(1, input.y || 0));
  if (input.brake) q.v = Math.max(FLY.vmin, q.v - FLY.brake * dt);
  else q.v += (FLY.vmax - q.v) * FLY.accel * dt + (q.v < FLY.vmax * 0.1 ? 8 * dt : 0);

  // рысканье вокруг своего верха, тангаж вокруг своего правого
  if (steerX) { const th = -steerX * FLY.turn * dt; q.nose = rot(q.nose, q.up, th); q.right = rot(q.right, q.up, th); }
  if (steerY) { const th = steerY * FLY.turn * dt; q.nose = rot(q.nose, q.right, th); q.up = rot(q.up, q.right, th); }
  // базис держим ортонормированным, иначе за минуту полёта он расползётся
  q.nose = norm(q.nose);
  q.right = norm(cross(q.up, q.nose));
  q.up = cross(q.nose, q.right);
  // «верх» подтягивается к мировому: кверху ногами малыш не окажется
  const w = [0, 1, 0], d = dot(q.nose, w);
  if (Math.abs(d) < 0.96) {
    const want = norm([w[0] - q.nose[0] * d, w[1] - q.nose[1] * d, w[2] - q.nose[2] * d]);
    const c = Math.max(-1, Math.min(1, dot(q.up, want)));
    const th = Math.min(Math.acos(c), FLY.level * dt);
    if (th > 1e-4) {
      const s = dot(cross(q.up, want), q.nose) >= 0 ? 1 : -1;
      q.up = norm(rot(q.up, q.nose, th * s));
      q.right = norm(cross(q.up, q.nose));
    }
  }
  q.bank += (-steerX - q.bank) * Math.min(1, FLY.bank * dt);

  // скорость догоняет нос: на вираже немного проносит наружу
  const want = [q.nose[0] * q.v, q.nose[1] * q.v, q.nose[2] * q.v], k = Math.min(1, FLY.slip * dt);
  for (let i = 0; i < 3; i++) q.vel[i] += (want[i] - q.vel[i]) * k;
  const p0 = [...q.p];
  for (let i = 0; i < 3; i++) q.p[i] += q.vel[i] * dt;

  // край мира: дальше не пускает, скорость гасится
  const r = len(q.p);
  q.edge = Math.max(0, q.edge - dt);
  if (r > WORLD_R) {
    const n = [q.p[0] / r, q.p[1] / r, q.p[2] / r], out = dot(q.vel, n);
    for (let i = 0; i < 3; i++) { q.p[i] = n[i] * WORLD_R; if (out > 0) q.vel[i] -= n[i] * out; }
    q.v *= 0.7;
    if (q.edge <= 0) { ev.push(['edge']); q.edge = 1.2; }
  }

  const hit = crossed(p0, q.p, q.vel, gates);
  if (hit) ev.push(['enter', hit.id, hit]);
  return ev;
}

/**
 * Пересёк ли отрезок p0→p1 плоскость какой-нибудь воронки, двигаясь внутрь, и попал ли в её круг.
 * Возвращает { id, x, y, v } — готовое начальное состояние для race-sim (x и y в сечении трубы).
 */
export function crossed(p0, p1, vel, gates) {
  for (const [id, g] of gates) {
    const d0 = (p0[0] - g.pos[0]) * g.nose[0] + (p0[1] - g.pos[1]) * g.nose[1] + (p0[2] - g.pos[2]) * g.nose[2];
    const d1 = (p1[0] - g.pos[0]) * g.nose[0] + (p1[1] - g.pos[1]) * g.nose[1] + (p1[2] - g.pos[2]) * g.nose[2];
    if (!(d0 <= 0 && d1 > 0)) continue;
    const t = d0 === d1 ? 0 : -d0 / (d1 - d0);
    const h = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
    const l = [h[0] - g.pos[0], h[1] - g.pos[1], h[2] - g.pos[2]];
    const x = dot(l, g.right), y = dot(l, g.up);
    if (Math.hypot(x, y) > g.r - SHIP_R) continue;
    const v = dot(vel, g.nose);
    if (v <= 0) continue;
    return { id, x, y, v, gate: g };
  }
  return null;
}

/** Ближайшая воронка: { id, gate, dist, ahead } — ahead < 0, если она уже за спиной. */
export function nearest(q, gates) {
  let best = null;
  for (const [id, g] of gates) {
    const d = [g.pos[0] - q.p[0], g.pos[1] - q.p[1], g.pos[2] - q.p[2]], dist = len(d);
    if (!best || dist < best.dist) best = { id, gate: g, dist, ahead: dot(d, q.nose) };
  }
  return best;
}
