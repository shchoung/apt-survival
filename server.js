/**
 * APT Survival — Server v2.0
 * 기능: 회원가입/로그인, 맵 시드 동기화, 게임 상태 저장, 이탈 감지
 * 설치: npm install ws express bcryptjs
 * 실행: node server.js
 */

const express  = require('express');
const http     = require('http');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const { WebSocketServer, WebSocket } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ══════════════════════════════════════
   데이터 저장소 (파일 기반 — 프로덕션은 DB 권장)
══════════════════════════════════════ */
const DATA_DIR  = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SAVES_FILE = path.join(DATA_DIR, 'saves.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
if (!fs.existsSync(SAVES_FILE)) fs.writeFileSync(SAVES_FILE, '{}');

function readJSON(file)        { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// users: { nick → { nick, passwordHash, createdAt } }
// saves: { nick → { charIdx, lv, exp, hp, floor, inventory, equipped, gold, kills, savedAt } }

/* ══════════════════════════════════════
   REST API — 회원가입 / 로그인 / 저장 불러오기
══════════════════════════════════════ */

// 회원가입
app.post('/api/register', async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password)
    return res.json({ ok: false, msg: '닉네임과 비밀번호를 입력하세요.' });
  if (nick.length < 2 || nick.length > 10)
    return res.json({ ok: false, msg: '닉네임은 2~10자여야 합니다.' });
  if (password.length < 4)
    return res.json({ ok: false, msg: '비밀번호는 4자 이상이어야 합니다.' });

  const users = readJSON(USERS_FILE);
  if (users[nick])
    return res.json({ ok: false, msg: '이미 사용 중인 닉네임입니다.' });

  const hash = await bcrypt.hash(password, 10);
  users[nick] = { nick, passwordHash: hash, createdAt: Date.now() };
  writeJSON(USERS_FILE, users);

  console.log(`[REGISTER] ${nick}`);
  res.json({ ok: true, msg: '회원가입 완료!' });
});

// 로그인
app.post('/api/login', async (req, res) => {
  const { nick, password } = req.body;
  const users = readJSON(USERS_FILE);
  const user  = users[nick];
  if (!user)
    return res.json({ ok: false, msg: '존재하지 않는 닉네임입니다.' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match)
    return res.json({ ok: false, msg: '비밀번호가 틀렸습니다.' });

  // 세션 토큰 발급 (간단한 HMAC 기반)
  const token = crypto.createHmac('sha256', 'apt_secret_key_2024')
    .update(`${nick}:${Date.now()}`)
    .digest('hex');
  sessions.set(token, { nick, loginAt: Date.now() });

  // 저장 데이터 로드
  const saves = readJSON(SAVES_FILE);
  const save  = saves[nick] || null;

  console.log(`[LOGIN] ${nick}`);
  res.json({ ok: true, token, nick, save });
});

// 저장 데이터 불러오기
app.get('/api/save/:nick', (req, res) => {
  const token = req.headers['authorization'];
  const sess  = sessions.get(token);
  if (!sess || sess.nick !== req.params.nick)
    return res.json({ ok: false, msg: '인증 실패' });

  const saves = readJSON(SAVES_FILE);
  res.json({ ok: true, save: saves[req.params.nick] || null });
});

// 상태 저장 (REST — 게임 나가기/이탈 시 호출)
app.post('/api/save', (req, res) => {
  const token = req.headers['authorization'];
  const sess  = sessions.get(token);
  if (!sess) return res.json({ ok: false, msg: '인증 실패' });

  const { charIdx, lv, exp, hp, floor, inventory, equipped, gold, kills } = req.body;
  const saves = readJSON(SAVES_FILE);
  saves[sess.nick] = {
    charIdx, lv: lv||1, exp: exp||0, hp: hp||100,
    floor: floor||0, inventory: inventory||[], equipped: equipped||{},
    gold: gold||0, kills: kills||0,
    savedAt: Date.now(),
  };
  writeJSON(SAVES_FILE, saves);
  console.log(`[SAVE] ${sess.nick} Lv${lv} floor:${floor}`);
  res.json({ ok: true });
});

/* ══════════════════════════════════════
   세션 관리
══════════════════════════════════════ */
const sessions = new Map(); // token → { nick, loginAt }

function verifyToken(token) {
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess) return null;
  // 24시간 만료
  if (Date.now() - sess.loginAt > 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return null;
  }
  return sess;
}

/* ══════════════════════════════════════
   방 & 플레이어 관리
══════════════════════════════════════ */
const rooms   = new Map(); // roomCode → Room
const clients = new Map(); // ws → ClientInfo

class Room {
  constructor(code) {
    this.code       = code;
    this.players    = new Map();
    this.chat       = [];
    this.floor      = 0;
    this.mapSeed    = Math.floor(Math.random() * 999999); // ← 맵 동기화 시드
    this.phase      = 'lobby';
    this.createdAt  = Date.now();
  }

  broadcast(msg, excludeId = null) {
    const data = JSON.stringify(msg);
    this.players.forEach((p, id) => {
      if (id !== excludeId && p.ws?.readyState === WebSocket.OPEN)
        p.ws.send(data);
    });
  }
  broadcastAll(msg) { this.broadcast(msg, null); }

  get memberCount() { return this.players.size; }

  toPublic() {
    return {
      code: this.code, floor: this.floor, phase: this.phase,
      mapSeed: this.mapSeed,
      players: [...this.players.values()].map(p => p.toPublic()),
    };
  }
}

class PlayerState {
  constructor(ws, id, nick, charIdx) {
    this.ws      = ws;
    this.id      = id;
    this.nick    = nick;
    this.charIdx = charIdx;
    this.hp = 100; this.maxHp = 100;
    this.lv = 1;   this.exp   = 0;
    this.x = 0;    this.y     = 0;
    this.floor     = 0;
    this.kills     = 0;
    this.inventory = [];
    this.equipped  = {};
    this.gold      = 0;
    this.isHost    = false;
    this.joinedAt  = Date.now();
  }
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg));
  }
  toPublic() {
    return {
      id: this.id, nick: this.nick, charIdx: this.charIdx,
      hp: this.hp, maxHp: this.maxHp, lv: this.lv,
      x: this.x,  y: this.y, kills: this.kills, isHost: this.isHost,
    };
  }
  // DB 저장용 스냅샷
  toSaveData() {
    return {
      charIdx: this.charIdx, lv: this.lv, exp: this.exp,
      hp: this.hp, floor: this.floor,
      inventory: this.inventory, equipped: this.equipped,
      gold: this.gold, kills: this.kills,
      savedAt: Date.now(),
    };
  }
}

/* ══════════════════════════════════════
   유틸
══════════════════════════════════════ */
function genCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

function savePlayerData(nick, data) {
  if (!nick) return;
  const saves = readJSON(SAVES_FILE);
  saves[nick] = { ...data, savedAt: Date.now() };
  writeJSON(SAVES_FILE, saves);
  console.log(`[AUTO-SAVE] ${nick} Lv${data.lv} floor:${data.floor}`);
}

function removePlayer(ws) {
  const info = clients.get(ws);
  if (!info) return;
  const { roomCode, playerId, nick } = info;
  const room = rooms.get(roomCode);
  if (!room) { clients.delete(ws); return; }

  const player = room.players.get(playerId);

  // ── 비정상 이탈 포함 자동 저장 ──
  if (player && nick) {
    savePlayerData(nick, player.toSaveData());
  }

  room.players.delete(playerId);
  clients.delete(ws);

  // 호스트 위임
  if (player?.isHost && room.players.size > 0) {
    const next = room.players.values().next().value;
    next.isHost = true;
    // 새 호스트에게 맵 시드 재전송
    next.send({ type: 'host_promoted', mapSeed: room.mapSeed });
    room.broadcastAll({ type: 'system_msg', text: `${next.nick} 님이 새 호스트가 됐습니다` });
  }

  if (room.players.size === 0) {
    rooms.delete(roomCode);
    console.log(`[ROOM] ${roomCode} 삭제`);
  } else {
    room.broadcast({ type: 'player_left', playerId, nick: player?.nick });
    room.broadcastAll({ type: 'room_state', room: room.toPublic() });
  }
  console.log(`[LEAVE] ${player?.nick || playerId} ← ${roomCode}`);
}

/* ══════════════════════════════════════
   WebSocket 메시지 핸들러
══════════════════════════════════════ */
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { type } = msg;

  /* ── 인증 후 방 입장 ── */
  if (type === 'join') {
    const { token, nick: guestNick, charIdx, roomCode: wantCode } = msg;
    const sess = verifyToken(token);
    const nick = sess ? sess.nick : (guestNick || '생존자'); // 비회원도 허용

    const code = wantCode ? wantCode.toUpperCase() : genCode();
    if (!rooms.has(code)) rooms.set(code, new Room(code));
    const room = rooms.get(code);

    if (room.memberCount >= 4) {
      ws.send(JSON.stringify({ type: 'error', msg: '방이 가득 찼습니다 (최대 4인)' })); return;
    }
    const taken = [...room.players.values()].map(p => p.charIdx);
    if (charIdx >= 0 && taken.includes(charIdx)) {
      ws.send(JSON.stringify({ type: 'error', msg: '이미 선택된 캐릭터입니다' })); return;
    }

    const playerId = crypto.randomUUID();
    const player   = new PlayerState(ws, playerId, nick, charIdx ?? -1);
    player.isHost  = room.players.size === 0;

    // 저장된 데이터 복원
    if (sess) {
      const saves = readJSON(SAVES_FILE);
      const save  = saves[nick];
      if (save) {
        player.lv        = save.lv        || 1;
        player.exp       = save.exp       || 0;
        player.floor     = save.floor     || 0;
        player.inventory = save.inventory || [];
        player.equipped  = save.equipped  || {};
        player.gold      = save.gold      || 0;
        player.kills     = save.kills     || 0;
        if (save.charIdx >= 0) player.charIdx = save.charIdx;
      }
    }

    room.players.set(playerId, player);
    clients.set(ws, { roomCode: code, playerId, nick: sess ? nick : null });

    player.send({
      type: 'joined', playerId, roomCode: code,
      isHost: player.isHost, mapSeed: room.mapSeed,
      room: room.toPublic(), recentChat: room.chat.slice(-20),
      savedData: player.toSaveData(), // 클라이언트에 저장 데이터 전달
    });

    room.broadcast({ type: 'player_joined', player: player.toPublic() }, playerId);
    room.broadcastAll({ type: 'room_state', room: room.toPublic() });
    console.log(`[JOIN] ${nick} → ${code} (${room.memberCount}명)`);
    return;
  }

  /* ── 인증된 클라이언트만 ── */
  const info = clients.get(ws);
  if (!info) return;
  const { roomCode, playerId, nick } = info;
  const room   = rooms.get(roomCode);
  if (!room)   return;
  const player = room.players.get(playerId);
  if (!player) return;

  switch (type) {

    case 'pick_char': {
      const taken = [...room.players.values()].filter(p => p.id !== playerId).map(p => p.charIdx);
      if (taken.includes(msg.charIdx)) {
        player.send({ type: 'error', msg: '이미 선택된 캐릭터' }); return;
      }
      player.charIdx = msg.charIdx;
      room.broadcastAll({ type: 'room_state', room: room.toPublic() });
      break;
    }

    case 'start_game': {
      if (!player.isHost) return;
      if ([...room.players.values()].some(p => p.charIdx < 0)) {
        player.send({ type: 'error', msg: '모든 플레이어가 캐릭터를 선택해야 합니다' }); return;
      }
      // ── 새 맵 시드 생성 후 전체 동기화 ──
      room.mapSeed = msg.mapSeed ?? Math.floor(Math.random() * 999999);
      room.phase   = 'playing';
      room.floor   = msg.floor ?? 0;
      room.broadcastAll({
        type: 'game_start',
        floor: room.floor,
        mapSeed: room.mapSeed,  // ← 모든 클라에 동일 시드 전달
      });
      console.log(`[START] ${roomCode} floor:${room.floor} seed:${room.mapSeed}`);
      break;
    }

    // 상태 동기화
    case 'state': {
      const { x, y, hp, maxHp, lv, exp, kills, floor, inventory, equipped, gold } = msg;
      Object.assign(player, {
        x: x??player.x, y: y??player.y,
        hp: hp??player.hp, maxHp: maxHp??player.maxHp,
        lv: lv??player.lv, exp: exp??player.exp,
        kills: kills??player.kills,
        floor: floor??player.floor,
        inventory: inventory??player.inventory,
        equipped: equipped??player.equipped,
        gold: gold??player.gold,
      });
      room.broadcast({
        type: 'player_state', playerId,
        x: player.x, y: player.y,
        hp: player.hp, maxHp: player.maxHp,
        lv: player.lv, charIdx: player.charIdx,
      }, playerId);
      break;
    }

    // 정상 게임 나가기 (상태 저장 후 방 퇴장)
    case 'leave_game': {
      // 저장 데이터 갱신
      if (msg.saveData) Object.assign(player, msg.saveData);
      if (nick) savePlayerData(nick, player.toSaveData());
      player.send({ type: 'leave_ack' }); // 클라에 저장 완료 신호
      // removePlayer는 ws.close 이벤트에서 처리
      break;
    }

    // 스킬 브로드캐스트
    case 'skill': {
      room.broadcast({
        type: 'skill_fx', playerId, charIdx: player.charIdx,
        skillIdx: msg.skillIdx, x: msg.x, y: msg.y, angle: msg.angle,
      }, playerId);
      break;
    }

    // 층 이동 (호스트만, 새 시드 생성)
    case 'floor_change': {
      if (!player.isHost) return;
      room.floor   = msg.floor;
      room.mapSeed = Math.floor(Math.random() * 999999); // 층마다 새 시드
      room.phase   = 'playing';
      room.broadcastAll({
        type: 'floor_change',
        floor: room.floor,
        mapSeed: room.mapSeed,
      });
      console.log(`[FLOOR] ${roomCode} → ${room.floor} seed:${room.mapSeed}`);
      break;
    }

    // 채팅
    case 'chat': {
      const text = (msg.text || '').trim().slice(0, 100);
      if (!text) return;
      const chatMsg = {
        type: 'chat', playerId, nick: player.nick,
        charIdx: player.charIdx, text, ts: Date.now(),
      };
      room.chat.push(chatMsg);
      if (room.chat.length > 50) room.chat.shift();
      room.broadcastAll(chatMsg);
      break;
    }

    // 주기적 자동 저장 (클라에서 30초마다 호출)
    case 'auto_save': {
      if (msg.saveData) Object.assign(player, msg.saveData);
      if (nick) savePlayerData(nick, player.toSaveData());
      break;
    }

    case 'ping': player.send({ type: 'pong', ts: msg.ts }); break;
    default: break;
  }
}

/* ══════════════════════════════════════
   WebSocket 연결
══════════════════════════════════════ */
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[CONNECT] ${ip}`);

  ws.on('message', raw => {
    try { handleMessage(ws, raw.toString()); }
    catch (e) { console.error('[MSG ERROR]', e.message); }
  });

  ws.on('close', () => {
    removePlayer(ws);
  });

  ws.on('error', e => console.error('[WS ERROR]', e.message));
  ws.send(JSON.stringify({ type: 'hello', msg: 'APT Survival Server v2.0' }));
});

/* ══════════════════════════════════════
   비활성 방 정리 + 세션 만료 정리
══════════════════════════════════════ */
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.size === 0 || now - room.createdAt > 30 * 60 * 1000)
      rooms.delete(code);
  });
  sessions.forEach((sess, token) => {
    if (now - sess.loginAt > 24 * 60 * 60 * 1000) sessions.delete(token);
  });
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n🎮 APT Survival Server v2.0`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
