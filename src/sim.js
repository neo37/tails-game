/**
 * Логика боя без графики: волны, тени, подружки, ракушки, хвостики.
 * Один и тот же код крутится:
 *   - в одиночной игре (браузер),
 *   - у хоста командной игры (он рассылает снимки остальным),
 *   - в симуляторе баланса (node tools/balance.mjs).
 * Здесь нет THREE и DOM — только числа на плоскости XZ.
 */
import { teamMult } from './balance.js';
import { Grid } from './grid.js';

/* ─────────────────── подружки ─────────────────── */

export const FRIENDS = {
  mila:   { name: 'Мила',   emoji: '🌼', model: 'dancer', tint: 0xffe08a, cost: 40,  range: 13, damage: 12, rate: 0.75 },
  teya:   { name: 'Тея',    emoji: '🐈', model: 'dancer', tint: 0xffb0c8, cost: 50,  range: 12, damage: 6,  rate: 0.9, slow: 0.5 },
  niksha: { name: 'Никша',  emoji: '🌊', model: 'dancer', tint: 0x8fd0ff, cost: 60,  range: 10, damage: 20, rate: 1.2, splash: 3 },
  iva:    { name: 'Ива',    emoji: '🔔', model: 'dancer', tint: 0xc7b0ff, cost: 80,  range: 18, damage: 34, rate: 1.8 },
  maskot: { name: 'Маскот', emoji: '⚡', model: 'maskot', tint: 0xffffff, cost: 110, range: 15, damage: 46, rate: 1.1 },
  castle: { name: 'Замок',  emoji: '🏰', model: 'castle', tint: 0xffd447, cost: 50,  range: 16, damage: 14, rate: 0.8 },
};
export const FRIEND_KEYS = Object.keys(FRIENDS);   // индекс в снимке ↔ id

/**
 * Характеристики подружки на уровне роста L (1, 2, …).
 * Рост: урон ×1.6, перезарядка ×0.9, дальность +2.5, следующий рост дороже ×1.8 (первый — 80 % цены).
 * В исходной игре было ×1.9 / ×0.85 / ×1.7: урон в секунду рос в 2.24 раза за ×1.7 ракушек, и к середине
 * уровня любая волна сгорала мгновенно (см. docs/BALANCE.md). Теперь урон/с на ракушку почти постоянный.
 */
export const GROW = { damage: 1.6, rate: 0.9, range: 2.5, cost: 1.8, first: 0.8 };
/**
 * Особый удар (1.14.0): с 3-го роста каждый 6-й выстрел подружки — особый: крупный искрящийся шар,
 * у Теи замедление держится дольше, у Никши брызги шире. Урон не растёт (mult 1): уровни настроены впритык,
 * и даже ×1.25 на каждый 6-й выстрел поднимал средний запас одиночной игры с 42 до 61 % (tools/balance.mjs).
 */
export const SPECIAL = { level: 3, every: 6, mult: 1, slowFor: 2, splashK: 1.2 };
export function towerStats(id, level) {
  const f = FRIENDS[id];
  let damage = f.damage, range = f.range, rate = f.rate, upCost = Math.round(f.cost * GROW.first), spent = f.cost;
  for (let l = 1; l < level; l++) {
    spent += upCost;
    damage = Math.round(damage * GROW.damage);
    range += GROW.range;
    rate *= GROW.rate;
    upCost = Math.round(upCost * GROW.cost);
  }
  return { damage, range, rate, upCost, spent, slow: f.slow || 0, splash: f.splash || 0 };
}

/* ─────────────────── волны ─────────────────── */

export const START_TAILS = 5;
export const HP_GROW = 1.2;           // рост здоровья теней от волны к волне (в уровне можно задать hpGrow)
export const WAVE_PAUSE = 4.5;          // секунд между волнами (авто-следующая)
export const SHOT_SPEED = 30;           // скорость снаряда, ед/с
export const DANCE_LEN = 5, DANCE_COOLDOWN = 22;
export const IDLE_AFTER = 30;           // секунд без действий — игрок считается отошедшим, волны рассчитаны на тех, кто играет
export const SHARE_PLATES_WAVES = 2;    // первые волны плита придерживается для друга, у которого ещё нет подружки

/**
 * Персонаж в бою. Смысл: тени можно убивать двумя способами, и у каждого своя цена.
 *   башня убила — ракушки всей команде;
 *   персонаж убил — ракушек нет, зато жизни ему (и удар сам стоит жизни, а тени бьют в ответ).
 * Удар отнимает долю здоровья тени: так он полезен на любой волне, а добить раненую башней выгоднее всего.
 */
export const HERO = { lives: 10, maxLives: 20, revive: 5, downFor: 8, reach: 5.5, cool: 0.6, monsterReach: 3.2, monsterCool: 1.5, safe: 0.8,
                      hit: 0.34, hitGhost: 0.25, hitBig: 0.08, airK: 1.5, gain: 4, gainGhost: 5, gainBig: 15,
                      // персонаж-призрак растёт за ракушки, как замок: с каждой стадией длиннее рука и сильнее удар, но он и заметнее для монстров
                      growCost: [60, 110, 200], growReach: 0.2, growHit: 0.25, growBig: 0.4,
                      // серия: убивай одного за другим, пока тебя не ударили: с третьего жизни ×2, с шестого ×3
                      comboWindow: 6, combo2: 3, combo3: 6,
                      // friendly fire (экспериментальная карта): удар по союзнику отбирает его ракушки, нокаут — ещё больше
                      pvpHit: 2, pvpSteal: 0.15, pvpKoSteal: 0.25, pvpKoGain: 3 };

/** Множитель здоровья теней для команды: свой у уровня (level.teamHp), иначе общий из TEAM. */
const TEAM_EASE = { 2: 1, 3: 0.92, 4: 0.86 };   // чем больше команда, тем труднее договориться: боты при подборе этого не знают
export const teamHp = (level, m) => (m.n > 1 && level.teamHp ? level.teamHp[m.n - 2] * TEAM_EASE[m.n] : m.hp);

/** Волна n на уровне level при множителях команды m (для одного игрока все множители = 1). */
export function waveInfo(n, level, m = teamMult(1)) {
  const baseCount = Math.min(3 + Math.floor(n * 0.9), 28);
  return {
    n,
    count: Math.max(1, Math.round(baseCount * m.count)),
    hp: Math.round(24 * Math.pow(level.hpGrow || HP_GROW, n - 1) * (level.speed || 1) * (level.hpK || 1) * teamHp(level, m)),
    speed: Math.min(2 + n * 0.03, 4.4) * (level.speed || 1),
    bounty: Math.max(1, Math.round((6 + Math.floor(n / 2)) * m.bounty)),
    bonus: Math.round((20 + n * 3) * m.bonus),
    gap: Math.max(0.4, 1.15 - n * 0.02) / Math.sqrt(m.count),   // больше теней — идут чуть плотнее
    big: n % 5 === 0,
  };
}

/** Звёзды за пройденный уровень: по оставшимся хвостикам. */
export const starsFor = (tails) => (tails >= 5 ? 3 : tails >= 3 ? 2 : tails >= 1 ? 1 : 0);

/* ─────────────────── маршрут ─────────────────── */

export class Path {
  constructor(points) {
    this.p = points.map(([x, z]) => ({ x, z }));
    this.cum = [0];
    for (let i = 1; i < this.p.length; i++) {
      const a = this.p[i - 1], b = this.p[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    this.length = this.cum[this.cum.length - 1];
  }

  /** Точка на расстоянии d от начала (+ направление сегмента). */
  at(d, out = {}) {
    d = Math.max(0, Math.min(this.length, d));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < d) i++;
    const a = this.p[i - 1], b = this.p[i];
    const seg = this.cum[i] - this.cum[i - 1] || 1;
    const t = (d - this.cum[i - 1]) / seg;
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.dx = (b.x - a.x) / seg;
    out.dz = (b.z - a.z) / seg;
    return out;
  }
}

/* ─────────────────── генератор случайных чисел (повторяемый для симулятора) ─────────────────── */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ─────────────────── «Открытое поле»: лабиринт из подружек ─────────────────── */

/**
 * Состояние лабиринта при занятых клетках blocked (Set индексов клеток):
 * поле расстояний до домика и маршруты A* от каждого старта (для подсветки дорожки).
 */
export function mazeState(level, blocked) {
  const m = level.maze;
  const grid = new Grid(m.w, m.h);
  const house = grid.idx(...m.house);
  const rocks = new Set((m.rocks || []).map(([i, j]) => grid.idx(i, j)));
  const passable = (k) => !blocked.has(k) && !rocks.has(k);
  const flow = grid.flow(house, passable);
  const spawns = m.spawns.map(([i, j]) => grid.idx(i, j));
  const routes = spawns.map((s) => grid.astar(s, house, passable));
  return { grid, house, rocks, spawns, flow, routes, ok: routes.every(Boolean) };
}

/** Плиты лабиринта: каждая клетка, кроме стартов, домика и камней (индекс плиты = индекс клетки). */
export function mazeSpots(level) {
  const st = mazeState(level, new Set());
  const out = [];
  for (let k = 0; k < st.grid.w * st.grid.h; k++) {
    const [x, z] = st.grid.center(k);
    out.push([x, z, st.spawns.includes(k) || k === st.house || st.rocks.has(k) ? 0 : 1]);
  }
  return out;
}

/* ─────────────────── бой ─────────────────── */

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

export class Sim {
  /**
   * @param level   уровень из levels.js (path|paths|maze, friends, shells, target, speed, ghosts, hpK)
   * @param opts.players  [{id, name, color, emoji}] — у одиночной игры один игрок id=1
   * @param opts.spots    [[x,z(,можно)], …] — плиты (уже рассчитанные: spotsOf(level))
   * @param opts.rng      () => [0,1)
   * @param opts.mult     (n) => множители (симулятор баланса подставляет свои)
   */
  constructor(level, { players = [{ id: 1 }], spots, rng = Math.random, ghostChance, mult } = {}) {
    this.level = level;
    this.multFn = mult || teamMult;
    this.maze = level.maze ? true : false;
    this.paths = this.maze ? [] : (level.paths || [level.path]).map((p) => new Path(p));
    this.path = this.paths[0];
    this.spots = spots.map(([x, z, ok]) => ({ x, z, ok: ok !== 0 }));
    this.rng = rng;
    this.ghostChance = ghostChance ?? level.ghosts ?? 0.25;
    this.time = 0;
    this.wave = 0;
    this.tails = START_TAILS;
    this.running = false;
    this.over = false;
    this.won = false;
    this.queue = [];
    this.spawnTimer = 0;
    this.gap = 1;
    this.nextWaveAt = -1;
    this.danceUntil = -1;
    this.danceReady = 0;
    this.enemies = [];
    this.towers = new Map();       // spot → { id, owner, level, cool, ...stats }
    this.shots = [];
    this.players = new Map();
    this.eid = 1;
    this.lane = 0;
    this.events = [];
    this.kills = 0;
    this.leaks = 0;
    this.teamSize = 0;
    this.ff = false;               // friendly fire: включает создатель экспериментальной игры
    if (this.maze) this.remaze();
    for (const p of players) this.addPlayer(p);
    // у тех, кто начал вместе, стартовые ракушки одинаковые — по размеру всей команды
    const start = Math.round(level.shells * this.multFn(Math.max(1, players.length)).shells);
    for (const p of this.players.values()) p.shells = start;
    this.events = [];
  }

  /** Сколько игроков сейчас в команде (ушедшие не считаются) → множители. */
  get activeCount() { let n = 0; for (const p of this.players.values()) if (p.active) n++; return Math.max(1, n); }
  /** Те, кто реально играет: от их числа зависят волны и доход. Иначе отвлёкшийся друг делает игру непроходимой. */
  get workingCount() { let n = 0; for (const p of this.players.values()) if (p.active && !p.idle) n++; return Math.max(1, n); }
  get mult() { return this.multFn(this.workingCount); }

  /** Перед волной: кто не действовал IDLE_AFTER секунд — отошёл. Если отошли все, считаем, что играют все. */
  updateIdle() {
    const team = [...this.players.values()].filter((p) => p.active);
    const away = team.filter((p) => this.time - p.lastAct > IDLE_AFTER);
    for (const p of team) {
      const idle = away.length < team.length && away.includes(p);
      if (idle && !p.idle) this.emit(['i', p.id, 1]);
      p.idle = idle;
    }
    // половина ракушек отошедшего — тем, кто играет (вернётся — останется с другой половиной и снова будет получать доход)
    const workers = team.filter((p) => !p.idle);
    for (const p of team) {
      if (!p.idle || !workers.length) continue;
      const part = Math.floor(p.shells / 2 / workers.length);
      for (const w of workers) { w.shells += part; p.shells -= part; }
    }
  }
  towersOf(pid) { let n = 0; for (const t of this.towers.values()) if (t.owner === pid) n++; return n; }

  addPlayer({ id, name = '', color = '#ffd447', emoji = '🦊' }) {
    const old = this.players.get(id);
    if (old) { old.active = true; Object.assign(old, { name, color, emoji }); return old; }
    let n = 1; for (const p of this.players.values()) if (p.active) n++;
    const p = { id, name, color, emoji, active: true, shells: Math.round(this.level.shells * this.multFn(n).shells),
                built: 0, kills: 0, x: 0, z: 0, ry: 0, run: 0, lastAct: this.time, idle: false,
                hero: false, ghostHero: false, grow: 1, combo: 0, comboUntil: 0, lives: HERO.lives, down: false, upAt: 0, hitReady: 0, safeUntil: 0 };
    // опоздавший получает ещё и половину бонусов уже пройденных волн — чтобы было на что строить
    if (this.wave > 0) for (let w = 1; w <= this.wave; w++) p.shells += Math.round(waveInfo(w, this.level, this.multFn(n)).bonus * 0.5);
    this.players.set(id, p);
    this.teamSize = Math.max(this.teamSize, this.activeCount);
    this.emit(['j', id]);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p && p.active) { p.active = false; this.emit(['x', id]); }
  }

  emit(ev) { this.events.push(ev); }
  takeEvents() { const e = this.events; this.events = []; return e; }

  /* ── лабиринт ── */

  blockedSet(extra = -1) {
    const b = new Set(this.towers.keys());
    if (extra >= 0) b.add(extra);
    return b;
  }

  remaze() {
    this.mz = mazeState(this.level, this.blockedSet());
    for (const e of this.enemies) if (e.pi < 0 && (this.towers.has(e.tk) || this.mz.flow[e.tk] < 0)) e.tk = this.nextCell(this.mz.grid.cellAt(e.x, e.z));
  }

  /** Можно ли занять клетку k, не перекрыв дорогу никому (ни стартам, ни уже идущим теням). */
  mazeFree(k) {
    const st = mazeState(this.level, this.blockedSet(k));
    if (!st.ok) return 'Так тени не пройдут — нельзя закрывать дорогу!';
    for (const e of this.enemies) {
      if (e.tk === k || Math.hypot(e.x - this.spots[k].x, e.z - this.spots[k].z) < 4.5) return 'Тут сейчас идёт тень';
      if (st.flow[e.tk] < 0) return 'Так тень окажется в ловушке';
    }
    return null;
  }

  nextCell(k) {
    const { grid, flow, house } = this.mz;
    if (k === house) return house;
    let best = -1, bd = Infinity;
    for (const n of grid.neighbors(k)) {
      const d = flow[n];
      if (d >= 0 && d < bd) { bd = d; best = n; }
    }
    return best >= 0 ? best : k;
  }

  /* ── действия игроков (хост проверяет всё сам: клиент мог прислать что угодно) ── */

  act(pid, a) {
    const p = this.players.get(pid);
    if (!p || !p.active || !a || typeof a !== 'object') return { ok: false, err: 'кто это?' };
    if (a.k === 'pos') {                       // бегающий персонаж: только запоминаем, без событий
      if ([a.x, a.z, a.r].every(Number.isFinite)) {
        p.x = Math.max(-70, Math.min(70, a.x)); p.z = Math.max(-70, Math.min(70, a.z)); p.ry = a.r; p.run = a.v ? 1 : 0; p.hero = true; if (a.g) p.ghostHero = true;
      }
      return { ok: true, quiet: true };
    }
    p.lastAct = this.time;
    if (p.idle) { p.idle = false; this.emit(['i', pid, 0]); }
    if (this.over && a.k !== 'more') return { ok: false, err: 'игра закончилась' };
    const spot = Number.isInteger(a.s) && a.s >= 0 && a.s < this.spots.length ? a.s : -1;
    switch (a.k) {
      case 'build': {
        const f = FRIENDS[a.f];
        if (spot < 0 || !this.spots[spot].ok || !f || !this.level.friends.includes(a.f)) return { ok: false, err: 'нельзя' };
        if (this.towers.has(spot)) return { ok: false, err: 'плита занята' };
        if (p.shells < f.cost) return { ok: false, err: 'не хватает ракушек' };
        if (this.maze) { const why = this.mazeFree(spot); if (why) return { ok: false, err: why }; }
        else if (this.wave <= SHARE_PLATES_WAVES && this.towersOf(pid) > 0) {
          let waiting = 0, free = 0;
          for (const o of this.players.values()) if (o.id !== pid && o.active && !o.idle && !this.towersOf(o.id)) waiting++;
          this.spots.forEach((sp, i) => { if (sp.ok && !this.towers.has(i)) free++; });
          if (free <= waiting) return { ok: false, err: 'Оставь эту плиту другу!' };
        }
        p.shells -= f.cost;
        p.built++;
        this.towers.set(spot, { id: a.f, owner: pid, level: 1, cool: 0, ...towerStats(a.f, 1) });
        if (this.maze) this.remaze();
        this.emit(['b', spot, pid]);
        return { ok: true };
      }
      case 'up': {
        const t = this.towers.get(spot);
        if (!t) return { ok: false, err: 'плита пустая' };      // растить можно любую подружку команды: ракушки не лежат без дела
        if (p.shells < t.upCost) return { ok: false, err: 'не хватает ракушек' };
        p.shells -= t.upCost;
        Object.assign(t, towerStats(t.id, t.level + 1), { level: t.level + 1 });
        this.emit(['u', spot, pid]);
        return { ok: true };
      }
      case 'sell': {
        const t = this.towers.get(spot);
        if (!t) return { ok: false, err: 'плита пустая' };
        if (t.owner !== pid && this.players.get(t.owner)?.active) return { ok: false, err: 'это подружка друга' };   // ушедшего — можно
        p.shells += Math.round(t.spent / 2);
        this.towers.delete(spot);
        if (this.maze) this.remaze();
        this.emit(['s', spot, pid]);
        return { ok: true };
      }
      case 'hit': return this.strike(p, !!a.air);
      case 'pvp': return this.strikeAlly(p);
      case 'grow': {
        if (!p.ghostHero) return { ok: false, err: 'Расти может только призрак' };
        const cost = HERO.growCost[p.grow - 1];
        if (cost === undefined) return { ok: false, err: 'Призрак уже самый большой' };
        if (p.shells < cost) return { ok: false, err: 'не хватает ракушек' };
        p.shells -= cost;
        p.grow++;
        this.emit(['G', pid, p.grow]);
        return { ok: true };
      }
      case 'wave':
        if (this.queue.length) return { ok: false, err: 'Волна ещё идёт!' };
        this.startWave(pid);
        return { ok: true };
      case 'dance':
        if (this.time < this.danceReady) return { ok: false, err: 'Ещё отдыхают' };
        this.danceUntil = this.time + DANCE_LEN;
        this.danceReady = this.time + DANCE_COOLDOWN;
        this.emit(['d', pid]);
        return { ok: true };
      case 'more':
        if (!this.over || !this.won) return { ok: false };
        this.over = false;
        this.startWave(pid);
        return { ok: true };
      default:
        return { ok: false, err: '?' };
    }
  }

  /** Удар персонажа: по ближайшей тени в досягаемости, стоит одну жизнь. В прыжке бьёт сильнее. */
  strike(p, air) {
    if (!p.hero || p.down) return { ok: false, quiet: true };
    if (this.time < p.hitReady) return { ok: false, quiet: true };
    let target = null, best = HERO.reach * (1 + HERO.growReach * (p.grow - 1));
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d <= best) { best = d; target = e; }
    }
    if (!target) return { ok: false, err: 'Рядом нет монстра' };
    p.hitReady = this.time + HERO.cool;
    p.lives--;
    const part = target.big ? HERO.hitBig : target.ghost ? HERO.hitGhost : HERO.hit;
    target.hp -= target.maxHp * part * (air ? HERO.airK : 1) * (1 + HERO.growHit * (p.grow - 1));
    target.heroBy = p.id;
    target.lastBy = p.id;
    this.emit(['m', target.id, p.id, p.lives]);
    return { ok: true };
  }

  /** Friendly fire: удар по ближайшему союзнику. Отдельное действие, чтобы по другу нельзя было попасть случайно. */
  strikeAlly(p) {
    if (!this.ff) return { ok: false, err: 'В этой игре нельзя бить союзников' };
    if (!p.hero || p.down || this.time < p.hitReady) return { ok: false, quiet: true };
    let v = null, best = HERO.reach * (1 + HERO.growReach * (p.grow - 1));
    for (const o of this.players.values()) {
      if (o === p || !o.active || !o.hero || o.down) continue;
      const d = Math.hypot(o.x - p.x, o.z - p.z);
      if (d <= best) { best = d; v = o; }
    }
    if (!v) return { ok: false, err: 'Рядом нет союзника' };
    if (this.time < v.safeUntil) return { ok: false, err: 'Он пока под защитой' };
    p.hitReady = this.time + HERO.cool;
    p.lives--;
    v.lives -= HERO.pvpHit;
    v.combo = 0;
    v.safeUntil = this.time + HERO.safe;
    const ko = v.lives <= 0;
    const stolen = Math.floor(v.shells * (ko ? HERO.pvpSteal + HERO.pvpKoSteal : HERO.pvpSteal));
    v.shells -= stolen;
    p.shells += stolen;
    if (ko) p.lives = Math.min(HERO.maxLives, p.lives + HERO.pvpKoGain);
    this.emit(['P', p.id, v.id, Math.max(0, v.lives), stolen, ko ? 1 : 0]);
    this.heroesFall();
    return { ok: true };
  }

  /** Тени бьют персонажа, оказавшегося рядом, и на миг останавливаются — за это время по ним работают башни. */
  monstersAttack(dt) {
    for (const p of this.players.values()) {
      if (p.down && this.time >= p.upAt) {
        p.down = false; p.lives = HERO.revive; p.safeUntil = this.time + HERO.safe * 3;
        this.emit(['r', p.id]);
      }
    }
    for (const e of this.enemies) {
      if (e.stun > 0) e.stun -= dt;
      if (e.hitCool > 0) { e.hitCool -= dt; continue; }
      for (const p of this.players.values()) {
        if (!p.active || !p.hero || p.down || this.time < p.safeUntil) continue;
        if (Math.hypot(e.x - p.x, e.z - p.z) > HERO.monsterReach + HERO.growBig * (p.grow - 1)) continue;
        p.lives -= e.big ? 3 : 1;
        p.combo = 0;
        p.safeUntil = this.time + HERO.safe;
        e.hitCool = HERO.monsterCool;
        e.stun = 0.35;
        this.emit(['h', p.id, Math.max(0, p.lives), e.id]);
        break;
      }
    }
  }

  /** Жизни кончились — персонаж отдыхает и возвращается к домику. Домик от этого не страдает. */
  heroesFall() {
    for (const p of this.players.values()) {
      if (p.hero && !p.down && p.lives <= 0) {
        p.lives = 0; p.down = true; p.upAt = this.time + HERO.downFor;
        this.emit(['o', p.id, HERO.downFor]);
      }
    }
  }

  startWave(by = 0) {
    if (this.over || this.queue.length) return;
    this.updateIdle();
    this.wave++;
    const w = waveInfo(this.wave, this.level, this.mult);
    const lanes = this.maze ? this.level.maze.spawns.length : this.paths.length;
    // на уровнях с несколькими дорожками каждая получает свою долю теней (не меньше, чем было бы на одной)
    const count = lanes > 1 ? Math.max(w.count, Math.round(w.count * (this.level.laneK || 1))) : w.count;
    this.queue = Array.from({ length: count }, (_, i) => {
      const big = w.big && i === 0;
      return { hp: Math.round(w.hp * (big ? 6 : 1)), speed: w.speed * (big ? 0.6 : 1),
               scale: big ? 1.9 : 1, bounty: w.bounty * (big ? 5 : 1), big };
    });
    this.gap = w.gap / (lanes > 1 ? Math.sqrt(lanes) : 1);
    this.spawnTimer = 0;
    this.running = true;
    this.nextWaveAt = -1;
    this.emit(['w', this.wave, w.big ? 1 : 0, by]);
  }

  spawn(c) {
    const ghost = this.rng() < this.ghostChance;
    const e = { id: this.eid++, pi: 0, d: 0, x: 0, z: 0, rem: 0, tk: -1, hp: c.hp, maxHp: c.hp, speed: c.speed,
                bounty: c.bounty, slow: 0, scale: c.scale, big: c.big, ghost };
    if (this.maze) {
      const sp = this.mz.spawns[this.lane++ % this.mz.spawns.length];
      [e.x, e.z] = this.mz.grid.center(sp);
      e.pi = -1;
      e.tk = this.nextCell(sp);
    } else {
      e.pi = this.lane++ % this.paths.length;
      this.paths[e.pi].at(0, e);
      e.rem = this.paths[e.pi].length;
    }
    this.enemies.push(e);
  }

  /** Шаг тени по лабиринту: от центра клетки к центру соседней с меньшим расстоянием до домика. */
  mazeMove(e, step) {
    const { grid, flow, house } = this.mz;
    for (let guard = 0; step > 1e-6 && guard < 8; guard++) {
      const [tx, tz] = grid.center(e.tk);
      const dx = tx - e.x, dz = tz - e.z, dd = Math.hypot(dx, dz);
      if (dd <= step) {
        e.x = tx; e.z = tz; step -= dd;
        if (e.tk === house) return true;
        e.tk = this.nextCell(e.tk);
      } else {
        e.x += (dx / dd) * step; e.z += (dz / dd) * step; step = 0;
        e.dx = dx / dd; e.dz = dz / dd;
      }
    }
    const [tx, tz] = grid.center(e.tk);
    e.rem = Math.max(0, flow[e.tk]) * grid.cell + Math.hypot(tx - e.x, tz - e.z);
    return false;
  }

  /** Шаг симуляции; dt — секунды (хост вызывает фиксированными шагами 1/30). */
  step(dt) {
    this.time += dt;
    if (this.over) return;
    if (this.nextWaveAt >= 0 && this.time >= this.nextWaveAt) this.startWave(0);

    if (this.queue.length) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) { this.spawn(this.queue.shift()); this.spawnTimer = this.gap; }
    }

    const dancing = this.time < this.danceUntil;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const k = (dancing ? 0.5 : 1) * (e.slow > 0 ? 0.45 : 1) * (e.stun > 0 ? 0 : 1);
      if (e.slow > 0) e.slow -= dt;
      const step = e.speed * k * dt;
      if (e.pi < 0) {
        if (this.mazeMove(e, step)) { this.leak(e, i); if (this.over) return; }
        continue;
      }
      const path = this.paths[e.pi];
      e.d += step;
      if (e.d >= path.length) { this.leak(e, i); if (this.over) return; continue; }
      path.at(e.d, e);
      e.rem = path.length - e.d;
    }

    this.monstersAttack(dt);

    for (const [spot, t] of this.towers) {
      t.cool -= dt;
      if (t.cool > 0) continue;
      const s = this.spots[spot];
      let target = null;
      for (const e of this.enemies) {     // бьём ту тень, что ближе всех к домику
        if (Math.hypot(e.x - s.x, e.z - s.z) <= t.range && (!target || e.rem < target.rem)) target = e;
      }
      if (target) {
        t.n = (t.n || 0) + 1;
        const power = t.level >= SPECIAL.level && t.n % SPECIAL.every === 0;
        this.shots.push({ x: s.x, y: 3.6, z: s.z, target, damage: power ? Math.round(t.damage * SPECIAL.mult) : t.damage, slow: t.slow,
          slowFor: power ? SPECIAL.slowFor : 1.6, splash: power && t.splash ? t.splash * SPECIAL.splashK : t.splash, owner: t.owner });
        t.cool = t.rate;
        this.emit(power ? ['f', spot, target.id, 1] : ['f', spot, target.id]);
      }
    }

    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const e = s.target;
      if (e.hp <= 0 || !this.enemies.includes(e)) { this.shots.splice(i, 1); continue; }
      const dx = e.x - s.x, dy = 3 - s.y, dz = e.z - s.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1.6) {
        e.hp -= s.damage;
        e.lastBy = s.owner;
        e.heroBy = 0;                  // добила башня — награда ракушками
        if (s.slow) e.slow = Math.max(e.slow || 0, s.slowFor || 1.6);
        if (s.splash) {
          for (const o of this.enemies) {
            if (o !== e && Math.hypot(o.x - e.x, o.z - e.z) < s.splash * 1.6) { o.hp -= s.damage * 0.5; o.lastBy = s.owner; o.heroBy = 0; }
          }
        }
        this.shots.splice(i, 1);
      } else {
        const k = Math.min(1, (SHOT_SPEED * dt) / d);
        s.x += dx * k; s.y += dy * k; s.z += dz * k;
      }
    }

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.hp > 0) continue;
      this.enemies.splice(i, 1);
      this.kills++;
      const hero = e.heroBy ? this.players.get(e.heroBy) : null;
      let gain = 0;
      if (hero) {                      // убил персонаж: ракушек нет, зато жизни
        gain = e.big ? HERO.gainBig : e.ghost ? HERO.gainGhost : HERO.gain;
        hero.combo = this.time <= hero.comboUntil ? hero.combo + 1 : 1;
        hero.comboUntil = this.time + HERO.comboWindow;
        gain *= hero.combo >= HERO.combo3 ? 3 : hero.combo >= HERO.combo2 ? 2 : 1;
        if (!hero.down) hero.lives = Math.min(HERO.maxLives, hero.lives + gain);
      } else {
        // награда за тень от башни — каждому игроку команды (делимся, а не соревнуемся)
        for (const p of this.players.values()) if (p.active && !p.idle) p.shells += e.bounty;
      }
      const killer = this.players.get(e.lastBy);
      if (killer) killer.kills++;
      this.emit(['k', e.id, e.lastBy || 0, gain, hero ? 0 : e.bounty, hero ? hero.combo : 0, e.big ? 1 : 0]);
    }
    this.heroesFall();

    if (this.running && !this.queue.length && !this.enemies.length) {
      this.running = false;
      const bonus = waveInfo(this.wave, this.level, this.mult).bonus;
      for (const p of this.players.values()) if (p.active && !p.idle) p.shells += bonus;
      if (this.wave >= this.level.target) this.finish(true);
      else { this.nextWaveAt = this.time + WAVE_PAUSE; this.emit(['c', this.wave, bonus]); }
    }
  }

  leak(e, i) {
    this.enemies.splice(i, 1);
    this.tails--;
    this.leaks++;
    this.emit(['l', e.id, this.tails]);
    if (this.tails <= 0) this.finish(false);
  }

  finish(won) {
    this.over = true;
    this.running = false;
    this.won = won;
    this.queue = [];
    this.nextWaveAt = -1;
    this.emit(['e', won ? 1 : 0, this.tails]);
  }

  /* ─────────────────── снимок для сети ─────────────────── */

  /**
   * Компактный снимок полного состояния (массивы вместо объектов, округление):
   * из него клиент рисует, а новый хост — продолжает игру.
   */
  snapshot() {
    const q = [];
    for (const c of this.queue) {
      const last = q[q.length - 1];
      const row = [1, c.hp, Math.round(c.speed * 100), Math.round(c.scale * 100), c.bounty, c.big ? 1 : 0];
      if (last && last.slice(1).every((v, i) => v === row[i + 1])) last[0]++;
      else q.push(row);
    }
    const tw = [];
    for (const [s, t] of this.towers) tw.push([s, FRIEND_KEYS.indexOf(t.id), t.level, t.owner, r1(Math.max(0, t.cool))]);
    return {
      t: r1(this.time), w: this.wave, h: this.tails, r: this.running ? 1 : 0, o: this.over ? (this.won ? 2 : 1) : 0,
      st: r1(this.spawnTimer), g: r2(this.gap), nw: this.nextWaveAt < 0 ? -1 : r1(this.nextWaveAt - this.time),
      du: r1(Math.max(0, this.danceUntil - this.time)), dr: r1(Math.max(0, this.danceReady - this.time)),
      ts: this.teamSize, k: this.kills, lk: this.leaks, ln: this.lane,
      p: [...this.players.values()].map((p) => [p.id, p.shells, p.active ? 1 : 0, p.built, p.kills, r1(p.x), r1(p.z), r2(p.ry), p.run, p.idle ? 1 : 0, r1(this.time - p.lastAct), p.lives, p.down ? r1(p.upAt - this.time) : 0, p.hero ? 1 : 0, p.grow, p.ghostHero ? 1 : 0]),
      tw,
      // тень: [id, дорожка (-1 — лабиринт), d|x, z, hp, maxHp, скорость×100, замедление, флаги, награда]
      e: this.enemies.map((e) => [e.id, e.pi, r1(e.pi < 0 ? e.x : e.d), e.pi < 0 ? r1(e.z) : 0, Math.round(e.hp), e.maxHp,
                                  Math.round(e.speed * 100), r1(Math.max(0, e.slow)), (e.ghost ? 1 : 0) | (e.big ? 2 : 0), e.bounty]),
      q,
    };
  }

  /** Восстановить игру из снимка (новый хост после ухода старого). players — актуальный состав комнаты. */
  static fromSnapshot(level, spots, s, players, rng) {
    const sim = new Sim(level, { players: [], spots, rng });
    sim.events = [];
    sim.time = s.t; sim.wave = s.w; sim.tails = s.h; sim.running = !!s.r; sim.over = s.o > 0; sim.won = s.o === 2;
    sim.spawnTimer = s.st; sim.gap = s.g; sim.nextWaveAt = s.nw < 0 ? -1 : s.t + s.nw;
    sim.danceUntil = s.t + s.du; sim.danceReady = s.t + s.dr; sim.teamSize = s.ts || 1;
    sim.kills = s.k || 0; sim.leaks = s.lk || 0; sim.lane = s.ln || 0;
    const info = new Map(players.map((p) => [p.id, p]));
    for (const [id, shells, active, built, kills, x, z, ry, , idle, away, lives, downLeft, hero, grow, ghostHero] of s.p) {
      const pi = info.get(id) || {};
      sim.players.set(id, { id, shells, active: !!active && info.has(id), built, kills, x: x || 0, z: z || 0, ry: ry || 0, run: 0, idle: !!idle, lastAct: s.t - (away || 0),
                            hero: !!hero, ghostHero: !!ghostHero, grow: grow || 1, lives: lives ?? HERO.lives, down: downLeft > 0, upAt: s.t + (downLeft || 0), hitReady: 0, safeUntil: 0,
                            name: pi.name || '', color: pi.color || '#ffd447', emoji: pi.emoji || '🦊' });
    }
    for (const [spot, fi, lvl, owner, cool] of s.tw) {
      const id = FRIEND_KEYS[fi];
      sim.towers.set(spot, { id, owner, level: lvl, cool, ...towerStats(id, lvl) });
    }
    if (sim.maze) sim.remaze();
    for (const [id, pi, a, b, hp, maxHp, sp, slow, fl, bounty] of s.e) {
      const e = { id, pi, d: 0, x: 0, z: 0, rem: 0, tk: -1, hp, maxHp, speed: sp / 100, slow, ghost: !!(fl & 1), big: !!(fl & 2),
                  scale: fl & 2 ? 1.9 : 1, bounty };
      if (pi < 0) { e.x = a; e.z = b; e.tk = sim.nextCell(sim.mz.grid.cellAt(a, b)); }
      else { e.d = a; (sim.paths[pi] || sim.path).at(a, e); e.rem = (sim.paths[pi] || sim.path).length - a; }
      sim.enemies.push(e);
      sim.eid = Math.max(sim.eid, id + 1);
    }
    for (const [n, hp, sp, sc, bounty, big] of s.q) {
      for (let i = 0; i < n; i++) sim.queue.push({ hp, speed: sp / 100, scale: sc / 100, bounty, big: !!big });
    }
    return sim;
  }
}
