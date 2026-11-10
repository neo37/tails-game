/**
 * Радио для гонок: mp3 из админки играют по очереди, пока идёт гонка (и ралли подряд).
 *
 *   GET  /api/music                 — плейлист { tracks: [{ id, title, url }] } (url относительный: music/<файл>)
 *   GET  /music/<файл>.mp3          — сам трек, с Range: браузер подгружает его по кускам во время гонки
 *   GET  /admin                     — страница админки (Basic-авторизация: логин admin, пароль — ADMIN_PASS)
 *   POST /api/admin/music?title=…   — загрузить mp3 (тело — сам файл, до 30 МБ)
 *   POST /api/admin/music/order     — порядок: тело JSON [id, id, …]
 *   POST /api/admin/music/rename    — тело JSON { id, title }
 *   DELETE /api/admin/music?id=…    — удалить трек
 *
 * Пароль — переменная окружения ADMIN_PASS (или файл DATA_DIR/admin.pass). Нет пароля — админка выключена.
 * Файлы — DATA_DIR/music/, список — DATA_DIR/music.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_MP3 = 30 * 1024 * 1024, MAX_TRACKS = 200;

export function musicApi(DATA_DIR, ROOT) {
  const DIR = path.join(DATA_DIR, 'music');
  const LIST = path.join(DATA_DIR, 'music.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(LIST, 'utf8')); } catch { /* пока пусто */ }
  const save = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LIST + '.tmp', JSON.stringify(list, null, 1));
    fs.renameSync(LIST + '.tmp', LIST);
  };
  const pass = () => {
    if (process.env.ADMIN_PASS) return process.env.ADMIN_PASS;
    try { return fs.readFileSync(path.join(DATA_DIR, 'admin.pass'), 'utf8').trim(); } catch { return ''; }
  };
  const authed = (req) => {
    const p = pass();
    if (!p) return false;
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    const a = Buffer.from(rest.join(':')), b = Buffer.from(p);
    return u === 'admin' && a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const deny = (res) => {
    res.writeHead(pass() ? 401 : 503, { 'www-authenticate': 'Basic realm="tails-admin", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
    res.end(pass() ? 'нужен пароль' : 'админка выключена: задайте ADMIN_PASS');
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };
  const pub = () => ({ tracks: list.map((t) => ({ id: t.id, title: t.title, url: 'music/' + t.file })) });
  const readJson = (req, cb) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { if (b.length < 20000) b += c; });
    req.on('end', () => { try { cb(JSON.parse(b || 'null')); } catch { cb(null); } });
  };

  /** true — запрос обработан. */
  return function handle(req, res, url) {
    if (url === '/api/music' && req.method === 'GET') { json(res, 200, pub()); return true; }
    if (url === '/api/music' && req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' }); res.end(); return true;
    }
    const mm = /^\/music\/([\w-]+\.mp3)$/.exec(url);
    if (mm && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = path.join(DIR, mm[1]);
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
        const head = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=604800', 'access-control-allow-origin': '*' };
        const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (r) {
          let a = r[1] === '' ? st.size - Number(r[2]) : Number(r[1]);
          let b = r[1] !== '' && r[2] !== '' ? Number(r[2]) : st.size - 1;
          a = Math.max(0, a); b = Math.min(st.size - 1, b);
          if (a > b) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return; }
          res.writeHead(206, { ...head, 'content-range': `bytes ${a}-${b}/${st.size}`, 'content-length': b - a + 1 });
          if (req.method === 'HEAD') { res.end(); return; }
          fs.createReadStream(file, { start: a, end: b }).pipe(res);
        } else {
          res.writeHead(200, { ...head, 'content-length': st.size });
          if (req.method === 'HEAD') { res.end(); return; }
          fs.createReadStream(file).pipe(res);
        }
      });
      return true;
    }
    if (url === '/admin' || url === '/admin.html') {
      if (!authed(req)) { deny(res); return true; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      fs.createReadStream(path.join(ROOT, 'server', 'admin.html')).pipe(res);
      return true;
    }
    if (url.startsWith('/api/admin/')) {
      if (!authed(req)) { deny(res); return true; }
      const q = new URL(req.url, 'http://x').searchParams;
      if (url === '/api/admin/music' && req.method === 'POST') {
        if (list.length >= MAX_TRACKS) { json(res, 400, { error: 'слишком много треков' }); return true; }
        const id = crypto.randomBytes(6).toString('base64url').replace(/[^\w-]/g, 'x');
        const file = id + '.mp3';
        fs.mkdirSync(DIR, { recursive: true });
        const tmp = path.join(DIR, file + '.part');
        const out = fs.createWriteStream(tmp);
        let size = 0, bad = false, first = null;
        req.on('data', (c) => {
          if (bad) return;
          if (!first) first = c.subarray(0, 3);
          size += c.length;
          if (size > MAX_MP3) { bad = true; out.destroy(); fs.rm(tmp, () => {}); json(res, 413, { error: 'файл больше 30 МБ' }); req.destroy(); return; }
          out.write(c);
        });
        req.on('end', () => {
          if (bad) return;
          out.end(() => {
            // mp3: «ID3» или кадр 0xFFEx
            const ok = first && (first.toString('latin1') === 'ID3' || (first[0] === 0xff && (first[1] & 0xe0) === 0xe0));
            if (!ok || size < 1024) { fs.rm(tmp, () => {}); json(res, 400, { error: 'это не mp3' }); return; }
            fs.renameSync(tmp, path.join(DIR, file));
            const title = String(q.get('title') || 'Трек').replace(/\.mp3$/i, '').slice(0, 80);
            list.push({ id, title, file, size, at: new Date().toISOString() });
            save();
            json(res, 200, pub());
          });
        });
        return true;
      }
      if (url === '/api/admin/music' && req.method === 'DELETE') {
        const id = q.get('id');
        const t = list.find((x) => x.id === id);
        if (!t) { json(res, 404, { error: 'нет такого' }); return true; }
        list = list.filter((x) => x !== t);
        save();
        fs.rm(path.join(DIR, t.file), () => {});
        json(res, 200, pub());
        return true;
      }
      if (url === '/api/admin/music/order' && req.method === 'POST') {
        readJson(req, (ids) => {
          if (!Array.isArray(ids)) { json(res, 400, { error: 'нужен список' }); return; }
          const by = new Map(list.map((t) => [t.id, t]));
          const next = ids.map((i) => by.get(i)).filter(Boolean);
          for (const t of list) if (!next.includes(t)) next.push(t);
          list = next;
          save();
          json(res, 200, pub());
        });
        return true;
      }
      if (url === '/api/admin/music/rename' && req.method === 'POST') {
        readJson(req, (b) => {
          const t = b && list.find((x) => x.id === b.id);
          if (!t) { json(res, 404, { error: 'нет такого' }); return; }
          t.title = String(b.title || '').slice(0, 80) || t.title;
          save();
          json(res, 200, pub());
        });
        return true;
      }
      json(res, 404, { error: 'нет такого' });
      return true;
    }
    return false;
  };
}
