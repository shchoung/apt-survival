/**
 * APT Survival — WebSocket 멀티플레이 서버
 * 실행: node server.js
 * 배포: Railway / Render / Fly.io 무료 플랜 가능
 *
 * 설치: npm install ws express
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// 정적 파일 서빙 (game.html을 같은 폴더에 두면 됨)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ═══════════ 방 & 플레이어 관리 ═══════════ */
const rooms = new Map();   // roomCode → Room
const clients = new Map(); // ws → ClientInfo

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // playerId → PlayerState
    this.chat = [];           // 최근 50개 채팅
    this.floor = 0;
    this.phase = 'lobby';     // lobby | playing | clear | boss
    this.createdAt = Date.now();
  }

  broadcast(msg, excludeId = null) {
    const data = JSON.stringify(msg);
    this.players.forEach((p, id) => {
      if (id !== excludeId && p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(data);
      }
    });
  }

  broadcastAll(msg) {
    this.broadcast(msg, null);
  }

  get memberCount() { return this.players.size; }

  toPublic() {
    return {
      code: this.code,
      floor: this.floor,
      phase: this.phase,
      players: [...this.players.values()].map(p => p.toPublic()),
    };
  }
}

class PlayerState {
  constructor(ws, id, nick, charIdx) {
    this.ws = ws;
    this.id = id;
    this.nick = nick;
    this.charIdx = charIdx;
    this.hp = 100; this.maxHp = 100;
    this.lv = 1; this.exp = 0;
    this.x = 0; this.y = 0;
    this.kills = 0;
    this.isHost = false;
    this.joinedAt = Date.now();
  }
  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg));
  }
  toPublic() {
    return {
      id: this.id, nick: this.nick, charIdx: this.charIdx,
      hp: this.hp, maxHp: this.maxHp, lv: this.lv,
      x: this.x, y: this.y, kills: this.kills, isHost: this.isHost,
    };
  }
}

/* ═══════════ 유틸 ═══════════ */
function genCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // 6자리
}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) rooms.set(code, new Room(code));
  return rooms.get(code);
}

function removePlayer(ws) {
  const info = clients.get(ws);
  if (!info) return;
  const { roomCode, playerId } = info;
  const room = rooms.get(roomCode);
  if (!room) { clients.delete(ws); return; }

  const player = room.players.get(playerId);
  room.players.delete(playerId);
  clients.delete(ws);

  // 호스트가 나가면 다음 사람이 호스트
  if (player?.isHost && room.players.size > 0) {
    const next = room.players.values().next().value;
    next.isHost = true;
  }

  if (room.players.size === 0) {
    rooms.delete(roomCode);
    console.log(`[ROOM] ${roomCode} 삭제 (비어있음)`);
  } else {
    room.broadcast({ type: 'player_left', playerId, nick: player?.nick });
    room.broadcastAll({ type: 'room_state', room: room.toPublic() });
  }
  console.log(`[LEAVE] ${player?.nick || playerId} ← ${roomCode} (${room.players.size}명 남음)`);
}

/* ═══════════ 메시지 핸들러 ═══════════ */
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const { type } = msg;

  // 방 입장/생성
  if (type === 'join') {
    const { nick, charIdx, roomCode: wantCode } = msg;
    const code = wantCode ? wantCode.toUpperCase() : genCode();
    const room = getOrCreateRoom(code);

    if (room.memberCount >= 4) {
      ws.send(JSON.stringify({ type: 'error', msg: '방이 가득 찼습니다 (최대 4인)' }));
      return;
    }
    // 같은 캐릭터 중복 체크
    const taken = [...room.players.values()].map(p => p.charIdx);
    if (charIdx >= 0 && taken.includes(charIdx)) {
      ws.send(JSON.stringify({ type: 'error', msg: '이미 선택된 캐릭터입니다' }));
      return;
    }

    const playerId = crypto.randomUUID();
    const player = new PlayerState(ws, playerId, nick || '생존자', charIdx ?? -1);
    player.isHost = room.players.size === 0;

    room.players.set(playerId, player);
    clients.set(ws, { roomCode: code, playerId });

    // 입장 성공 응답
    player.send({
      type: 'joined',
      playerId,
      roomCode: code,
      isHost: player.isHost,
      room: room.toPublic(),
      recentChat: room.chat.slice(-20),
    });

    // 다른 플레이어에게 알림
    room.broadcast({ type: 'player_joined', player: player.toPublic() }, playerId);
    room.broadcastAll({ type: 'room_state', room: room.toPublic() });

    console.log(`[JOIN] ${nick} → ${code} (${room.memberCount}명, host:${player.isHost})`);
    return;
  }

  // 이후 메시지는 방에 소속된 클라이언트만
  const info = clients.get(ws);
  if (!info) return;
  const { roomCode, playerId } = info;
  const room = rooms.get(roomCode);
  if (!room) return;
  const player = room.players.get(playerId);
  if (!player) return;

  switch (type) {

    // 캐릭터 선택 변경
    case 'pick_char': {
      const { charIdx } = msg;
      const taken = [...room.players.values()].filter(p => p.id !== playerId).map(p => p.charIdx);
      if (taken.includes(charIdx)) {
        player.send({ type: 'error', msg: '이미 선택된 캐릭터' }); return;
      }
      player.charIdx = charIdx;
      room.broadcastAll({ type: 'room_state', room: room.toPublic() });
      break;
    }

    // 게임 시작 (호스트만)
    case 'start_game': {
      if (!player.isHost) return;
      if ([...room.players.values()].some(p => p.charIdx < 0)) {
        player.send({ type: 'error', msg: '모든 플레이어가 캐릭터를 선택해야 합니다' }); return;
      }
      room.phase = 'playing';
      room.floor = msg.floor ?? 0;
      room.broadcastAll({ type: 'game_start', floor: room.floor });
      console.log(`[START] ${roomCode} floor:${room.floor}`);
      break;
    }

    // 플레이어 상태 동기화 (위치, HP, LV 등) — 60fps 이하 권장
    case 'state': {
      const { x, y, hp, maxHp, lv, exp, kills } = msg;
      Object.assign(player, { x: x??player.x, y: y??player.y, hp: hp??player.hp,
        maxHp: maxHp??player.maxHp, lv: lv??player.lv, exp: exp??player.exp, kills: kills??player.kills });
      room.broadcast({
        type: 'player_state',
        playerId,
        x: player.x, y: player.y, hp: player.hp, maxHp: player.maxHp,
        lv: player.lv, charIdx: player.charIdx,
      }, playerId);
      break;
    }

    // 스킬 사용 브로드캐스트 (다른 플레이어 화면에 이펙트 표시)
    case 'skill': {
      room.broadcast({
        type: 'skill_fx',
        playerId, charIdx: player.charIdx,
        skillIdx: msg.skillIdx,
        x: msg.x, y: msg.y, angle: msg.angle,
      }, playerId);
      break;
    }

    // 적 처치 동기화 (호스트 기준)
    case 'enemy_kill': {
      room.broadcast({ type: 'enemy_killed', enemyId: msg.enemyId }, playerId);
      break;
    }

    // 층 이동
    case 'floor_change': {
      if (!player.isHost) return;
      room.floor = msg.floor;
      room.phase = 'playing';
      room.broadcastAll({ type: 'floor_change', floor: room.floor });
      break;
    }

    // 채팅
    case 'chat': {
      const text = (msg.text || '').trim().slice(0, 100);
      if (!text) return;
      const chatMsg = {
        type: 'chat',
        playerId, nick: player.nick,
        charIdx: player.charIdx,
        text, ts: Date.now(),
      };
      room.chat.push(chatMsg);
      if (room.chat.length > 50) room.chat.shift();
      room.broadcastAll(chatMsg);
      console.log(`[CHAT] ${roomCode} ${player.nick}: ${text}`);
      break;
    }

    // 핑 (연결 유지)
    case 'ping': {
      player.send({ type: 'pong', ts: msg.ts });
      break;
    }

    default:
      console.log(`[UNKNOWN] ${type}`);
  }
}

/* ═══════════ WebSocket 연결 ═══════════ */
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[CONNECT] ${ip}`);

  ws.on('message', raw => {
    try { handleMessage(ws, raw.toString()); }
    catch (e) { console.error('[MSG ERROR]', e.message); }
  });

  ws.on('close', () => {
    removePlayer(ws);
    console.log(`[DISCONNECT] 남은 방 수: ${rooms.size}`);
  });

  ws.on('error', e => console.error('[WS ERROR]', e.message));

  // 연결 확인 응답
  ws.send(JSON.stringify({ type: 'hello', msg: 'APT Survival Server v1.0' }));
});

/* ═══════════ 비활성 방 정리 (30분) ═══════════ */
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.size === 0 || now - room.createdAt > 30 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[CLEANUP] 방 ${code} 정리`);
    }
  });
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n🎮 APT Survival Server 시작!`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
