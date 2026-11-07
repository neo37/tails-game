/**
 * Лобби командной игры: ник/цвет, список открытых игр, вход по коду, создание игры, комната ожидания.
 */
import { MAPS, resolveLevel } from './levels.js';
import { Net, me, saveMe, COLORS, EMOJIS } from './net.js';
import { myLevels, decode, analyze } from './custom.js';
import { myRaces, decode as decodeTrack, analyze as analyzeTrack, trackName } from './race-design.js';
import { EXPERIMENTAL } from './flags.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const profile = me();
saveMe(profile);

/* ── кто ты: выбирается на странице профиля ── */
$('me').textContent = `${profile.emoji} ${profile.name}`;
$('me').style.setProperty('--c', profile.color);

/* ── выбор карты и уровня ── */
const my = myLevels.list().filter((x) => { const d = decode(x.code); return d && analyze(d).ok; });   // черновики в командную игру не берём
const fromEditor = qs.get('map') === 'custom' && qs.get('code') && decode(qs.get('code')) ? qs.get('code') : null;
// свои трассы гонки: из конструктора и сохранённые на телефоне, только готовые
const okTrack = (code) => { const d = decodeTrack(code); return d && analyzeTrack(d).ok ? d : null; };
const fromTrack = qs.get('map') === 'track' && qs.get('code') && okTrack(qs.get('code')) ? qs.get('code') : null;
const tracks = [...(fromTrack ? [{ code: fromTrack, name: `${trackName(decodeTrack(fromTrack))} (из конструктора)` }] : []),
  ...myRaces.list().filter((x) => x.code !== fromTrack && okTrack(x.code)).map((x) => ({ code: x.code, name: trackName(decodeTrack(x.code)) }))];
$('map').innerHTML = Object.values(MAPS).filter((m) => !m.hidden || EXPERIMENTAL).map((m) => `<option value="${m.id}">${m.emoji} ${m.name}</option>`).join('')
  + (my.length || fromEditor ? '<option value="custom">🛠 Мои уровни</option>' : '')
  + (tracks.length ? '<option value="track">🧱 Мои трассы</option>' : '');
function fillLevels() {
  const m = $('map').value;
  if (m === 'track') {
    $('level').innerHTML = tracks.map((x) => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('');
  } else if (m === 'custom') {
    const items = [...(fromEditor ? [{ code: fromEditor, name: decode(fromEditor).name + ' (из редактора)' }] : []), ...my];
    $('level').innerHTML = items.map((x) => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('');
  } else {
    $('level').innerHTML = MAPS[m].levels.map((l) => `<option value="${l.id}">${l.id}. ${l.name}${l.players ? ` (игроков ${l.players})` : ''}</option>`).join('');
  }
}
const ffRow = () => { $('ff-row').hidden = $('map').value !== 'lab'; };
$('map').onchange = () => { fillLevels(); ffRow(); };
if (fromEditor) $('map').value = 'custom';
if (fromTrack) $('map').value = 'track';
if (qs.get('map') && MAPS[qs.get('map')]) $('map').value = qs.get('map');
fillLevels();
if (qs.get('level') && !['custom', 'track'].includes($('map').value)) $('level').value = qs.get('level');
ffRow();

/* ── сеть ── */
const net = new Net();
let room = null;
const err = (t) => { $('err').textContent = t || ''; };
function rehello() { if (net.open) net.send({ t: 'hello', token: sessionStorage.getItem('tg.token'), ...profile }); }

const mapName = (r) => (r.map === 'custom' ? '🛠 Свой уровень' : r.map === 'track' ? '🧱 Своя трасса' : `${MAPS[r.map]?.emoji || ''} ${MAPS[r.map]?.name || r.map}`);
// название своего уровня из редактора — свободный текст, чужим его не показываем (у трасс — из готовых слов, их можно)
const levelName = (r) => (r.map === 'custom' ? '' : r.levelName || (resolveLevel(r.map, r.level, r.lv) || {}).name || '');
const where = (r) => `${mapName(r)}${levelName(r) ? ` · ${esc(levelName(r))}` : ''}`;

net.on('rooms', (m) => {
  if (!EXPERIMENTAL) m.rooms = m.rooms.filter((r) => !MAPS[r.map]?.hidden);    // экспериментальные игры видны только в экспериментальной сборке
  $('games').innerHTML = m.rooms.length ? m.rooms.map((r) => `
    <div class="game" data-code="${r.code}">
      <div class="what"><b>${where(r)}</b><br><span class="empty">ведёт ${esc(r.host)} · код ${r.code}</span></div>
      <span>👫 ${r.n}/${r.max}</span>
      <span class="st ${r.status}">${r.status === 'wait' ? 'ждут' : 'идёт'}</span>
      <button class="btn" data-join="${r.code}" ${r.n >= r.max ? 'disabled' : ''}>Присоединиться</button>
    </div>`).join('') : '<div class="empty">Пока никто не играет. Создай игру — она появится здесь!</div>';
});
$('games').onclick = (e) => { const b = e.target.closest('[data-join]'); if (b) join(b.dataset.join); };

net.on('room', (m) => {
  room = m.room;
  showRoom();
  if (room.status === 'play') go();
});
net.on('start', () => go());
net.on('error', (m) => err(m.msg));
net.on('left', () => { room = null; showRoom(); });
net.on('down', () => err('Нет связи с сервером — переподключаемся…'));
net.on('welcome', () => { err(''); net.send({ t: 'list' }); });

function go() { net.close(); location.href = `${MAPS[room.map]?.race || room.map === 'track' ? 'race' : 'play'}.html?room=${room.code}${qs.has('debug') ? '&debug' : ''}`; }

function showRoom() {
  $('room-panel').hidden = !room;
  $('lobby-main').hidden = !!room;
  if (!room) return;
  $('room-code').textContent = room.code;
  $('room-where').textContent = `· ${mapName(room)}${levelName(room) ? ` · ${levelName(room)}` : ''}${room.pub ? '' : ' · только по коду'}`;
  $('room-players').innerHTML = room.players.map((p) => `<span class="p${p.online ? '' : ' off'}" style="--c:${p.color}">
    ${p.emoji} ${esc(p.name)}${p.id === room.host ? ' 👑' : ''}${p.id === net.id ? ' (ты)' : ''}</span>`).join('')
    + `<span class="empty">${room.players.length}/4</span>`;
  const host = room.host === net.id;
  $('btn-start').hidden = !host;
  $('room-wait').hidden = host;
}

function join(code) {
  code = String(code || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{4}$/.test(code)) { err('Код — 4 буквы или цифры'); return; }
  err('');
  net.send({ t: 'join', code });
}
$('btn-join').onclick = () => join($('join-code').value);
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('join-code').value); });
$('btn-create').onclick = () => {
  const map = $('map').value;
  const pub = document.querySelector('input[name=vis]:checked').value === 'pub';
  if (map === 'custom' || map === 'track') net.send({ t: 'create', map, lv: $('level').value, pub });
  else net.send({ t: 'create', map, level: Number($('level').value), pub, ff: map === 'lab' && $('ff').checked });
};
$('btn-start').onclick = () => net.send({ t: 'start' });
$('btn-leave').onclick = () => net.send({ t: 'leave' });

await net.connect(profile);
if (qs.get('join')) join(qs.get('join'));
