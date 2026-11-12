/**
 * Осколки в гонке: разбитая преграда и корабли при столкновении разлетаются на куски.
 * Физика в координатах тоннеля (s вдоль оси, x и y в сечении): у каждого куска скорость, вращение, тяжесть вниз
 * по сечению, сопротивление воздуха и отскок от стенок тоннеля с потерей скорости и трением. Через CRASH.ghost
 * секунд куски тают — ровно тогда же у корабля кончается «призрачность».
 */
import * as THREE from 'three';
import { radiusAt, worldAt, hits, CRASH } from './race-sim.js';

const GRAVITY = 22, DRAG = 0.55, BOUNCE = 0.45, FRICTION = 0.75, MAX = 260;
const geos = [new THREE.TetrahedronGeometry(1), new THREE.BoxGeometry(1, 0.55, 0.3), new THREE.OctahedronGeometry(0.8)];
const _a = [0, 0, 0], _q = new THREE.Quaternion(), _ax = new THREE.Vector3();
const rnd = (a, b) => a + Math.random() * (b - a);

export class Debris {
  constructor(scene) {
    this.scene = scene;
    this.pieces = [];
  }

  piece(track, s, x, y, vs, vx, vy, size, color) {
    if (this.pieces.length >= MAX) this.kill(0);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, flatShading: true, transparent: true, opacity: 1, emissive: color, emissiveIntensity: 0.25 });
    const m = new THREE.Mesh(geos[Math.floor(Math.random() * geos.length)], mat);
    m.scale.setScalar(size);
    m.quaternion.setFromEuler(new THREE.Euler(rnd(0, 6.3), rnd(0, 6.3), rnd(0, 6.3)));
    this.scene.add(m);
    this.pieces.push({ m, track, s, x, y, vs, vx, vy, size, life: rnd(CRASH.ghost - 0.25, CRASH.ghost),
      axis: new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize(), w: rnd(4, 14) });
  }

  /** Преграда разбилась: куски там, где она была, разлетаются от точки удара (hx, hy) и летят вперёд вместе с кораблём. */
  obstacle(track, o, t, hx, hy, shipV, color) {
    let made = 0;
    const R = radiusAt(track, o.s);
    for (let g = 0; g < 400 && made < 34; g++) {
      const q = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (R - 0.6);
      const x = Math.cos(q) * d, y = Math.sin(q) * d;
      if (!hits(o, x, y, t)) continue;             // кусок только из самой преграды
      const dx = x - hx, dy = y - hy, l = Math.hypot(dx, dy) || 1, near = Math.max(0.25, 1 - l / (R * 1.4));
      const kick = rnd(6, 16) * near + rnd(1, 4);
      // вдоль тоннеля куски летят почти вместе с кораблём: иначе отстают и проносятся сквозь камеру
      this.piece(track, o.s + rnd(-0.4, 0.4), x, y, shipV * rnd(0.75, 1.05) + rnd(-2, 4),
        (dx / l) * kick + rnd(-2, 2), (dy / l) * kick + rnd(-2, 2) + 3, rnd(0.45, 1.25), color);
      made++;
    }
  }

  /** Корабль задели: от корпуса во все стороны летят его осколки. */
  ship(track, p, color) {
    for (let i = 0; i < 14; i++) {
      const q = Math.random() * Math.PI * 2, k = rnd(5, 13);
      this.piece(track, p.s + rnd(-0.8, 0.8), p.x + Math.cos(q) * 0.6, p.y + Math.sin(q) * 0.6,
        p.v * rnd(0.5, 0.95) + rnd(-3, 3), Math.cos(q) * k + p.vx * 0.3, Math.sin(q) * k + p.vy * 0.3 + 2, rnd(0.25, 0.6), color);
    }
  }

  /** cam — камера: кусок, оказавшийся у самого объектива, гаснет, чтобы не закрывать полэкрана. */
  step(dt, cam) {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const d = this.pieces[i];
      d.life -= dt;
      if (d.life <= 0) { this.kill(i); continue; }
      // полёт: тяжесть вниз по сечению и сопротивление воздуха
      d.vy -= GRAVITY * dt;
      const drag = 1 - Math.min(0.9, DRAG * dt);
      d.vx *= drag; d.vy *= drag; d.vs *= 1 - Math.min(0.9, DRAG * 0.6 * dt);
      d.x += d.vx * dt; d.y += d.vy * dt; d.s += d.vs * dt;
      // стенка тоннеля: отражаем скорость по нормали, вдоль стенки — трение, вращение затухает
      const lim = radiusAt(d.track, d.s) - d.size * 0.6, r = Math.hypot(d.x, d.y);
      if (r > lim) {
        const nx = d.x / r, ny = d.y / r, vn = d.vx * nx + d.vy * ny;
        d.x = nx * lim; d.y = ny * lim;
        if (vn > 0) {
          d.vx -= nx * vn * (1 + BOUNCE); d.vy -= ny * vn * (1 + BOUNCE);
          d.vx *= FRICTION; d.vy *= FRICTION; d.vs *= FRICTION;
          d.w *= 0.7;
        }
      }
      worldAt(d.track, d.s, d.x, d.y, _a);
      d.m.position.set(_a[0], _a[1], _a[2]);
      d.m.quaternion.premultiply(_q.setFromAxisAngle(_ax.copy(d.axis), d.w * dt));
      // последние полсекунды тает и уменьшается
      const fade = Math.min(1, d.life / 0.5);
      const near = cam ? Math.min(1, Math.max(0, (d.m.position.distanceTo(cam.position) - 2.5) / 5)) : 1;
      d.m.material.opacity = fade * near;
      d.m.visible = near > 0.02;
      d.m.scale.setScalar(d.size * (0.4 + 0.6 * fade));
    }
  }

  kill(i) {
    const d = this.pieces[i];
    this.scene.remove(d.m);
    d.m.material.dispose();
    this.pieces.splice(i, 1);
  }

  get count() { return this.pieces.length; }
}
