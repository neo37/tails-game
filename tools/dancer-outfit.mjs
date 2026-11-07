/**
 * Брюки для модели «Танцовщица» (models/tiny-dancer.opt.glb и assets/characters/tiny-dancer.glb).
 * У модели одна сетка и одна текстура-атлас из мелких кусков, поэтому одежду рисуем не руками, а по высоте:
 * в исходной позе (T-поза, руки на уровне плеч) всё между краем футболки и тапками — бёдра и ноги.
 *
 *   node tools/dancer-outfit.mjs mask OUT.pgm [низ=0.13] [верх=0.556] [сзади выше на=0.016]
 *     — карта текстуры 1024×1024: 0 — пусто, 1 — другое, 2 — брюки, 3 — пояс, 4 — край штанин
 *       (низ/верх — доли высоты модели от пола; сзади футболка короче, поэтому пояс там выше)
 *   python3 tools/dancer-outfit.py mask.pgm IN.webp OUT.webp — перекрашивает (нужны numpy и Pillow)
 *   node tools/dancer-outfit.mjs inject NEW.webp — кладёт текстуру в обе модели; из бегущей модели
 *     заодно убираются неиспользуемые клипы ползания
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readFileSync, writeFileSync } from 'fs';

const TOWER = 'models/tiny-dancer.opt.glb', RUNNER = 'assets/characters/tiny-dancer.glb';
const DROP_CLIPS = ['Crawl', 'Crawl_All_Fours', 'Get_Down_And_Up'];
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const [cmd, arg, lo = '0.13', hi = '0.556', back = '0.016'] = process.argv.slice(2);

if (cmd === 'mask') {
  const doc = await io.read(TOWER);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const pos = prim.getAttribute('POSITION'), uv = prim.getAttribute('TEXCOORD_0'), idx = prim.getIndices();
  const [min, max] = [pos.getMinNormalized([]), pos.getMaxNormalized([])];
  console.log('bbox', min.map((x) => x.toFixed(3)), max.map((x) => x.toFixed(3)));
  const H = max[1] - min[1], yLo = Number(lo), yHi = Number(hi), yBack = Number(back);
  const S = 1024, mask = new Uint8Array(S * S);
  const p = [], z = [], t = [], a = [], b = [];
  for (let i = 0; i < idx.getCount(); i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = idx.getScalar(i + k);
      pos.getElement(v, a); uv.getElement(v, b);
      p[k] = (a[1] - min[1]) / H; z[k] = a[2]; t[k] = [b[0] * S, b[1] * S];
    }
    // растеризация треугольника в пикселях текстуры, высота — барицентрически
    const x0 = Math.max(0, Math.floor(Math.min(t[0][0], t[1][0], t[2][0])) - 1), x1 = Math.min(S - 1, Math.ceil(Math.max(t[0][0], t[1][0], t[2][0])) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(t[0][1], t[1][1], t[2][1])) - 1), y1 = Math.min(S - 1, Math.ceil(Math.max(t[0][1], t[1][1], t[2][1])) + 1);
    const d = (t[1][1] - t[2][1]) * (t[0][0] - t[2][0]) + (t[2][0] - t[1][0]) * (t[0][1] - t[2][1]);
    if (Math.abs(d) < 1e-9) continue;
    // высоты треугольника к каждой стороне (в пикселях): берём пиксели не дальше 0.7 px от треугольника,
    // чтобы края кусков атласа тоже стали брюками и на швах не светились полоски кожи
    const len = (i, j) => Math.hypot(t[i][0] - t[j][0], t[i][1] - t[j][1]) || 1e-9;
    const alt = [Math.abs(d) / len(1, 2), Math.abs(d) / len(2, 0), Math.abs(d) / len(0, 1)];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((t[1][1] - t[2][1]) * (px - t[2][0]) + (t[2][0] - t[1][0]) * (py - t[2][1])) / d;
      const w1 = ((t[2][1] - t[0][1]) * (px - t[2][0]) + (t[0][0] - t[2][0]) * (py - t[2][1])) / d;
      const w2 = 1 - w0 - w1;
      if (w0 * alt[0] < -0.7 || w1 * alt[1] < -0.7 || w2 * alt[2] < -0.7) continue;
      const h = w0 * p[0] + w1 * p[1] + w2 * p[2], zz = w0 * z[0] + w1 * z[1] + w2 * z[2];
      const top = yHi + yBack * Math.min(1, Math.max(0, -zz / 0.08));     // модель смотрит в +Z, спина — в −Z
      let m = 1;
      if (h >= yLo && h <= top) m = h > top - 0.012 ? 3 : h < yLo + 0.008 ? 4 : 2;
      const o = y * S + x;
      if (m >= 2 || mask[o] === 0) mask[o] = m;
    }
  }
  writeFileSync(arg, Buffer.concat([Buffer.from(`P5\n${S} ${S}\n255\n`), Buffer.from(mask)]));
  console.log('pants px', mask.filter((m) => m >= 2).length, 'covered px', mask.filter((m) => m > 0).length);
} else if (cmd === 'inject') {
  const img = readFileSync(arg);
  for (const f of [TOWER, RUNNER]) {
    const doc = await io.read(f);
    const root = doc.getRoot();
    root.listTextures()[0].setImage(img).setMimeType('image/webp');
    if (f === RUNNER) for (const an of root.listAnimations()) if (DROP_CLIPS.includes(an.getName())) {
      for (const s of an.listSamplers()) { s.getInput()?.dispose(); s.getOutput()?.dispose(); s.dispose(); }
      for (const c of an.listChannels()) c.dispose();
      an.dispose();
    }
    await io.write(f, doc);
    console.log(f, readFileSync(f).length, 'bytes; clips:', root.listAnimations().map((x) => x.getName()).join(', '));
  }
} else {
  console.log('node tools/dancer-outfit.mjs mask OUT.pgm [низ] [верх] | inject NEW.webp');
}
