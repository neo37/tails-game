/**
 * Сервер «Хвостов»: статика игры + комнаты командной игры (WebSocket /ws) на одном порту.
 *
 *   PORT=8795 HOST=127.0.0.1 node server/index.js
 *
 * Модель — хост-авторитарная: игру считает браузер хоста (src/sim.js), сервер только
 * ведёт комнаты и пересылает сообщения:
 *   клиент → act  → хосту (с подписью «от кого», подделать нельзя)
 *   хост   → snap → всем остальным в комнате
 * Ушёл хост — хостом становится следующий по очереди входа, он продолжает игру со своего
 * последнего снимка. Никого не осталось — комната удаляется.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAPS } from '../src/levels.js';
import { isNick } from '../src/nick.js';
import { EMOJIS } from '../src/net.js';
import { decode, toLevel } from '../src/custom.js';
import { decode as decodeTrack, analyze as analyzeTrack, encode as encodeTrack, trackName } from '../src/race-design.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8795);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PLAYERS = 4;
const MAX_ROOMS = 300;
const GRACE_MS = 8000;          // столько ждём вернувшегося после обрыва
const NAV_GRACE_MS = 30000;     // после «Играем!» все переходят из лобби в игру — ждём дольше
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // без 0/O и 1/I
const log = (...a) => { if (!process.env.QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); };

/* ─────────────────── общие трассы из блоков ─────────────────── */

// Каталог без авторов и свободного текста: код трассы и номер. Жалобы считаются с разных устройств, три жалобы скрывают трассу.
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.data');
const TRACKS_FILE = path.join(DATA_DIR, 'tracks.json');
const MAX_TRACKS = 2000, MAX_PUBLISH_PER_HOUR = 60, HIDE_AT = 3;
let tracks = [];
try { tracks = JSON.parse(fs.readFileSync(TRACKS_FILE, 'utf8')); } catch { /* каталог ещё пуст */ }
const publishes = [];
let saving = false, saveAgain = false;
function saveTracks() {
  if (saving) { saveAgain = true; return; }
  saving = true;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${TRACKS_FILE}.tmp`;
  fs.writeFile(tmp, JSON.stringify(tracks), (err) => {
    const done = () => { saving = false; if (saveAgain) { saveAgain = false; saveTracks(); } };
    if (err) { console.error(err); done(); return; }
    fs.rename(tmp, TRACKS_FILE, (e) => { if (e) console.error(e); done(); });
  });
}
const trackId = (code) => crypto.createHash('sha256').update(code).digest('base64url').slice(0, 12);
function json(res, code, body) {
  // страницы приложения открываются с appassets.androidplatform.net, поэтому нужен CORS
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function readBody(req, limit, cb) {
  let body = '', over = false;
  req.setEncoding('utf8');
  req.on('data', (c) => { if (over) return; body += c; if (body.length > limit) { over = true; cb(null); } });
  req.on('end', () => { if (!over) cb(body); });
}
function tracksApi(req, res, url) {
  if (req.method === 'GET' && url === '/api/tracks') {
    json(res, 200, { tracks: tracks.filter((t) => !t.hidden).slice(0, 300).map(({ id, code, at }) => ({ id, code, at })) });
    return true;
  }
  if (req.method === 'POST' && url === '/api/tracks') {
    readBody(req, 6000, (body) => {
      const d = body === null ? null : decodeTrack(body);
      if (!d || !analyzeTrack(d).ok) { json(res, 400, { error: 'Трасса не готова' }); return; }
      const code = encodeTrack(d), id = trackId(code), had = tracks.find((t) => t.id === id);
      if (had) { json(res, had.hidden ? 403 : 200, had.hidden ? { error: 'Эту трассу скрыли' } : { id }); return; }
      const hour = Date.now() - 3600000;
      while (publishes.length && publishes[0] < hour) publishes.shift();
      if (publishes.length >= MAX_PUBLISH_PER_HOUR) { json(res, 429, { error: 'Слишком много новых трасс, попробуй позже' }); return; }
      publishes.push(Date.now());
      tracks.unshift({ id, code, at: Date.now(), reports: [] });
      tracks.length = Math.min(tracks.length, MAX_TRACKS);
      saveTracks();
      json(res, 200, { id });
    });
    return true;
  }
  if (req.method === 'POST' && url === '/api/tracks/report') {
    readBody(req, 200, (body) => {
      let m = null;
      try { m = JSON.parse(body); } catch { /* */ }
      const t = m && tracks.find((x) => x.id === m.id), who = m && String(m.device || '').slice(0, 16);
      if (!t || !who) { json(res, 400, { error: 'Нет такой трассы' }); return; }
      if (!t.reports.includes(who)) t.reports.push(who);
      if (t.reports.length >= HIDE_AT) t.hidden = true;
      saveTracks();
      json(res, 200, { ok: true });
    });
    return true;
  }
  return false;
}

/* ─────────────────── статика ─────────────────── */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};
const PUBLIC = /^\/(?:[\w-]+\.(?:html|css)|favicon\.ico|(?:src|assets|models|vendor)\/[\w./-]+)$/;

function serveStatic(req, res) {
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { url = '/'; }
  if (url === '/') url = '/index.html';
  if (url === '/api/rooms') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(roomList()));
    return;
  }
  if (url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (url.startsWith('/api/tracks') && tracksApi(req, res, url)) return;
  const file = path.join(ROOT, url);
  if (!PUBLIC.test(url) || url.includes('..') || !file.startsWith(ROOT + path.sep)) { res.writeHead(404); res.end('нет такого'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('нет такого'); return; }
    const ext = path.extname(file).toLowerCase();
    const heavy = /\.(glb|jpg|png|webp)$/.test(ext) || url.startsWith('/vendor/');
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': st.size,
      'cache-control': heavy ? 'public, max-age=86400' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(serveStatic);

/* ─────────────────── игроки и комнаты ─────────────────── */

let nextPid = 1;
const people = new Map();      // token → { id, name, color, emoji, ws, room, timer }
const rooms = new Map();       // code → room
const listeners = new Set();   // кто смотрит список открытых игр

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, n);
const COLOR = /^#[0-9a-f]{6}$/i;

function newCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let k = 0; k < 4; k++) c += CODE_ABC[crypto.randomInt(CODE_ABC.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };

function roomView(r) {
  return {
    code: r.code, map: r.map, level: r.level, lv: r.lv, levelName: r.levelName, pub: r.pub, ff: !!r.ff, status: r.status, host: r.host,
    players: r.order.map((tok) => {
      const p = people.get(tok);
      return { id: p.id, name: p.name, color: p.color, emoji: p.emoji, hero: p.hero, tint: p.tint, ship: p.ship, kit: p.kit, online: !!p.ws };
    }),
  };
}

function roomList() {
  const out = [];
  for (const r of rooms.values()) {
    if (!r.pub || r.status === 'over') continue;
    const host = [...r.order].map((t) => people.get(t)).find((p) => p.id === r.host);
    out.push({ code: r.code, map: r.map, level: r.level, levelName: r.levelName, n: r.order.length, max: MAX_PLAYERS,
               status: r.status === 'play' ? 'play' : 'wait', host: host ? `${host.emoji} ${host.name}` : '' });
  }
  return out.sort((a, b) => (a.status === b.status ? a.code.localeCompare(b.code) : a.status === 'wait' ? -1 : 1));
}

let listTimer = null;
function pushList() {        // не чаще раза в 300 мс — список меняется пачками
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const msg = JSON.stringify({ t: 'rooms', rooms: roomList() });
    for (const ws of listeners) send(ws, msg);
  }, 300);
}

function broadcastRoom(r) {
  const msg = JSON.stringify({ t: 'room', room: roomView(r) });
  for (const tok of r.order) send(people.get(tok).ws, msg);
  if (r.pub) pushList();
}

function leaveRoom(p, why = 'leave') {
  const r = rooms.get(p.room);
  p.room = null;
  clearTimeout(p.timer);
  if (!r) return;
  r.order = r.order.filter((t) => t !== p.token);
  log(`room ${r.code}: ${p.name}#${p.id} ушёл (${why}), осталось ${r.order.length}`);
  if (!r.order.length) { rooms.delete(r.code); log(`room ${r.code}: закрыта`); pushList(); return; }
  if (r.host === p.id) {
    // хост — следующему по очереди, кто на связи (если на связи никого — первому в очереди)
    const next = r.order.map((t) => people.get(t)).find((q) => q.ws) || people.get(r.order[0]);
    r.host = next.id;
    log(`room ${r.code}: новый хост ${next.name}#${next.id}`);
  }
  broadcastRoom(r);
}

function joinRoom(p, r) {
  if (p.room && p.room !== r.code) leaveRoom(p, 'switch');
  if (!r.order.includes(p.token)) {
    if (r.order.length >= MAX_PLAYERS) return 'В этой игре уже четверо';
    if (r.status === 'over') return 'Эта игра уже закончилась';
    r.order.push(p.token);
  }
  p.room = r.code;
  clearTimeout(p.timer);
  broadcastRoom(r);
  return null;
}

/* ─────────────────── WebSocket ─────────────────── */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  let me = null;
  let bucket = 60, last = Date.now();     // не больше ~40 сообщений в секунду с одного соединения
  ws.missed = 0;
  ws.on('pong', () => { ws.missed = 0; });
  ws.on('message', () => { ws.missed = 0; });   // любое сообщение — тоже признак жизни

  ws.on('message', (buf) => {
    const now = Date.now();
    bucket = Math.min(60, bucket + ((now - last) / 1000) * 40);
    last = now;
    if (--bucket < 0) return;
    let m;
    try { m = JSON.parse(buf); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      const token = typeof m.token === 'string' && /^[\w-]{16,64}$/.test(m.token) ? m.token : crypto.randomUUID();
      me = people.get(token);
      if (!me) { me = { token, id: nextPid++, room: null, ws: null, timer: null }; people.set(token, me); }
      if (me.ws && me.ws !== ws) { send(me.ws, { t: 'kicked', msg: 'Открыто в другой вкладке' }); me.ws.close(4000); }
      me.ws = ws;
      me.name = isNick(m.name) ? m.name : 'Игрок';     // ник только из готовых слов (src/nick.js); старые версии могли прислать любой текст
      me.color = COLOR.test(m.color) ? m.color : '#ffd447';
      me.emoji = EMOJIS.includes(m.emoji) ? m.emoji : '🦊';
      me.hero = ['maskot', 'ghost'].includes(m.hero) ? m.hero : 'maskot';   // старые версии могли прислать dancer
      me.tint = COLOR.test(m.tint) ? m.tint : '';
      me.ship = ['wedge', 'arrow', 'delta'].includes(m.ship) ? m.ship : 'wedge';
      me.kit = typeof m.kit === 'string' && /^[a-z0-9,-]{0,90}$/.test(m.kit) ? m.kit : '';   // ачивки корабля: только id из каталога
      clearTimeout(me.timer);
      send(ws, { t: 'welcome', id: me.id, token });
      const r = rooms.get(me.room);
      if (r) broadcastRoom(r);   // вернулся после обрыва/перехода между страницами — снова «на связи»
      return;
    }
    if (!me) return;
    const r = rooms.get(me.room);

    switch (m.t) {
      case 'list':
        listeners.add(ws);
        send(ws, { t: 'rooms', rooms: roomList() });
        break;
      case 'unlist':
        listeners.delete(ws);
        break;
      case 'create': {
        let map = MAPS[m.map], level = map && map.levels.find((l) => l.id === Number(m.level)), lv = '';
        if (m.map === 'custom') {          // свой уровень из редактора: хост присылает код, проверяем его здесь
          const d = typeof m.lv === 'string' && m.lv.length < 3000 ? decode(m.lv) : null;
          level = d && toLevel(d);
          if (level) { map = { id: 'custom' }; lv = m.lv; }
        }
        if (m.map === 'track') {           // своя трасса гонки из конструктора: проверяем так же, как при публикации
          const d = typeof m.lv === 'string' && m.lv.length < 6000 ? decodeTrack(m.lv) : null;
          if (d && analyzeTrack(d).ok) { level = { id: 0, name: trackName(d) }; map = { id: 'track' }; lv = encodeTrack(d); }
        }
        if (!level) { send(ws, { t: 'error', msg: 'Нет такого уровня' }); break; }
        if (rooms.size >= MAX_ROOMS) { send(ws, { t: 'error', msg: 'Сервер занят, попробуй позже' }); break; }
        const code = newCode();
        if (me.room) leaveRoom(me, 'create');
        const room = { code, map: map.id, level: level.id, lv, levelName: level.name, pub: !!m.pub, ff: map.id === 'lab' && !!m.ff, status: 'wait', host: me.id, order: [], created: Date.now(), navUntil: 0 };
        rooms.set(code, room);
        log(`room ${code}: создал ${me.name}#${me.id} (${map.id}/${level.id}, ${room.pub ? 'открытая' : 'по коду'})`);
        joinRoom(me, room);
        break;
      }
      case 'join': {
        const code = clean(m.code, 4).toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { t: 'error', msg: `Игры с кодом ${code || '…'} нет` }); break; }
        const err = joinRoom(me, room);
        if (err) send(ws, { t: 'error', msg: err });
        else log(`room ${code}: вошёл ${me.name}#${me.id} (${room.order.length}/${MAX_PLAYERS})`);
        break;
      }
      case 'leave':
        if (r) leaveRoom(me, 'leave');
        send(ws, { t: 'left' });
        break;
      case 'start':
        if (!r || r.host !== me.id || r.status !== 'wait') break;
        r.status = 'play';
        r.navUntil = Date.now() + NAV_GRACE_MS;
        log(`room ${r.code}: старт, игроков ${r.order.length}`);
        broadcastRoom(r);
        for (const tok of r.order) send(people.get(tok).ws, { t: 'start' });
        break;
      case 'act': {          // действие игрока → хосту
        if (!r || r.status !== 'play') break;
        const host = r.order.map((t) => people.get(t)).find((p) => p.id === r.host);
        send(host && host.ws, { t: 'act', from: me.id, a: m.a, n: m.n });
        break;
      }
      case 'res': {          // хост → одному игроку: ответ на действие
        if (!r || r.host !== me.id) break;
        const to = r.order.map((t) => people.get(t)).find((p) => p.id === m.to);
        send(to && to.ws, { t: 'res', r: m.r, n: m.n });
        break;
      }
      case 'snap': {         // хост → всем остальным
        if (!r || r.host !== me.id) break;
        const msg = JSON.stringify({ t: 'snap', s: m.s });
        for (const tok of r.order) if (tok !== me.token) send(people.get(tok).ws, msg);
        break;
      }
      case 'end':            // хост сообщает: игра закончилась — из списка открытых убираем
        if (r && r.host === me.id) { r.status = 'over'; broadcastRoom(r); pushList(); }
        break;
      case 'abort':          // новому хосту не из чего продолжать — закрываем комнату для всех
        if (r && r.host === me.id) {
          for (const tok of r.order) { const p = people.get(tok); send(p.ws, { t: 'closed', msg: m.msg || 'Игра закончилась' }); p.room = null; }
          rooms.delete(r.code);
          pushList();
        }
        break;
      case 'ping':
        send(ws, { t: 'pong', at: m.at });
        break;
      default:
    }
  });

  ws.on('close', () => {
    listeners.delete(ws);
    if (!me || me.ws !== ws) return;
    me.ws = null;
    const r = rooms.get(me.room);
    if (!r) return;
    broadcastRoom(r);          // «не на связи» видно сразу
    const grace = Date.now() < r.navUntil || r.status === 'wait' ? NAV_GRACE_MS : GRACE_MS;
    const who = me;
    clearTimeout(who.timer);
    who.timer = setTimeout(() => { if (!who.ws && who.room) leaveRoom(who, 'timeout'); }, grace);
  });
});

// проверка живости: соединение, молчащее 3 проверки подряд (~45 с), закрываем (место освободится через GRACE_MS).
// Одной пропущенной мало: телефон с тяжёлой сценой или вкладка в фоне отвечает с задержкой.
setInterval(() => {
  for (const ws of wss.clients) {
    if (++ws.missed > 3) { log('нет ответа на ping 45 с — соединение закрыто'); ws.terminate(); continue; }
    ws.ping();
  }
}, 15000).unref();

// давно опустевшие записи игроков без комнаты — чистим
setInterval(() => {
  for (const [tok, p] of people) if (!p.ws && !p.room) people.delete(tok);
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => log(`Хвосты: http://${HOST}:${PORT}/  (ws: /ws)`));

export { server, rooms };
