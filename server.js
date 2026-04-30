/**
 * APT Survival — Server v3.0
 * DB: PostgreSQL (Railway 제공)
 * 설치: npm install
 * 실행: node server.js
 *
 * 환경변수 (Railway 자동 주입):
 *   DATABASE_URL  — PostgreSQL 연결 문자열
 *   PORT          — 포트 (기본 3000)
 *   JWT_SECRET    — 토큰 서명 키 (직접 설정 권장)
 */

const express  = require('express');
const http     = require('http');
const path     = require('path');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { Pool } = require('pg');
const { WebSocketServer, WebSocket } = require('ws');

const app    = express();
const server = http.createServer(app);
// ── WebSocket: path 없이 루트에 바인딩 (Railway 호환) ──
const wss    = new WebSocketServer({ server, path: '/' });
const PORT   = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'apt_survival_secret_2024';

// ── CORS (Railway 도메인 허용) ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ── 헬스체크 (Railway 생존 확인용) ──
app.get('/health', (req, res) => res.json({ ok: true, version: '3.0' }));
app.get('/api', (req, res) => res.json({ ok: true, msg: 'APT Survival API v3.0' }));

/* ══════════════════════════════════════
   PostgreSQL 연결
══════════════════════════════════════ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }  // Railway SSL
    : false,
});

// DB 쿼리 헬퍼
const db = {
  query: (text, params) => pool.query(text, params),
  async getOne(text, params) {
    const r = await pool.query(text, params);
    return r.rows[0] || null;
  },
};

/* ══════════════════════════════════════
   DB 초기화 — 테이블 생성
══════════════════════════════════════ */
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      nick        VARCHAR(10) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS game_saves (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      nick        VARCHAR(10) NOT NULL,
      char_idx    SMALLINT DEFAULT 0,
      lv          INT DEFAULT 1,
      exp         INT DEFAULT 0,
      hp          INT DEFAULT 100,
      max_hp      INT DEFAULT 100,
      atk         INT DEFAULT 50,
      def_stat    INT DEFAULT 50,
      floor       SMALLINT DEFAULT 0,
      gold        INT DEFAULT 0,
      kills       INT DEFAULT 0,
      cleared_floors  INT[] DEFAULT '{}',
      inventory   JSONB DEFAULT '[]',
      equipped    JSONB DEFAULT '{"weapon":null,"armor":null,"acc":null}',
      saved_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       VARCHAR(128) PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      nick        VARCHAR(10) NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS room_logs (
      id          SERIAL PRIMARY KEY,
      room_code   VARCHAR(8),
      event       VARCHAR(32),
      nick        VARCHAR(10),
      detail      JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('[DB] 테이블 초기화 완료');
}

/* ══════════════════════════════════════
   토큰 유틸
══════════════════════════════════════ */
function makeToken(userId, nick) {
  const payload = `${userId}:${nick}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${sig}`;
}

async function verifyToken(token) {
  if (!token) return null;
  try {
    const row = await db.getOne(
      `SELECT s.user_id, s.nick FROM sessions s
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    return row || null;
  } catch { return null; }
}

/* ══════════════════════════════════════
   REST API
══════════════════════════════════════ */

/* ─ 회원가입 ─ */
app.post('/api/register', async (req, res) => {
  try {
    const { nick, password } = req.body;
    if (!nick || !password)
      return res.json({ ok: false, msg: '닉네임과 비밀번호를 입력하세요.' });
    if (nick.length < 2 || nick.length > 10)
      return res.json({ ok: false, msg: '닉네임은 2~10자여야 합니다.' });
    if (password.length < 4)
      return res.json({ ok: false, msg: '비밀번호는 4자 이상이어야 합니다.' });
    if (!/^[a-zA-Z0-9가-힣_]+$/.test(nick))
      return res.json({ ok: false, msg: '닉네임에 특수문자는 사용할 수 없습니다.' });

    const exists = await db.getOne('SELECT id FROM users WHERE nick=$1', [nick]);
    if (exists) return res.json({ ok: false, msg: '이미 사용 중인 닉네임입니다.' });

    const hash = await bcrypt.hash(password, 10);
    const user = await db.getOne(
      'INSERT INTO users(nick,password_hash) VALUES($1,$2) RETURNING id',
      [nick, hash]
    );

    // 기본 세이브 데이터 생성
    await db.query(
      'INSERT INTO game_saves(user_id,nick) VALUES($1,$2)',
      [user.id, nick]
    );

    console.log(`[REGISTER] ${nick}`);
    res.json({ ok: true, msg: '회원가입 완료!' });
  } catch (e) {
    console.error('[REGISTER ERROR]', e.message);
    res.json({ ok: false, msg: '서버 오류가 발생했습니다.' });
  }
});

/* ─ 로그인 ─ */
app.post('/api/login', async (req, res) => {
  try {
    const { nick, password } = req.body;
    const user = await db.getOne(
      'SELECT id, nick, password_hash FROM users WHERE nick=$1',
      [nick]
    );
    if (!user) return res.json({ ok: false, msg: '존재하지 않는 닉네임입니다.' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.json({ ok: false, msg: '비밀번호가 틀렸습니다.' });

    // 기존 세션 정리 + 새 토큰 발급
    const token = makeToken(user.id, user.nick);
    await db.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    await db.query(
      'INSERT INTO sessions(token,user_id,nick) VALUES($1,$2,$3)',
      [token, user.id, user.nick]
    );

    // 세이브 데이터 조회
    const save = await db.getOne(
      'SELECT * FROM game_saves WHERE user_id=$1',
      [user.id]
    );

    console.log(`[LOGIN] ${nick}`);
    res.json({ ok: true, token, nick: user.nick, save: formatSave(save) });
  } catch (e) {
    console.error('[LOGIN ERROR]', e.message);
    res.json({ ok: false, msg: '서버 오류가 발생했습니다.' });
  }
});

/* ─ 로그아웃 ─ */
app.post('/api/logout', async (req, res) => {
  const token = req.headers['authorization'];
  if (token) await db.query('DELETE FROM sessions WHERE token=$1', [token]);
  res.json({ ok: true });
});

/* ─ 세이브 불러오기 ─ */
app.get('/api/save', async (req, res) => {
  const sess = await verifyToken(req.headers['authorization']);
  if (!sess) return res.json({ ok: false, msg: '인증 실패' });

  const save = await db.getOne(
    'SELECT * FROM game_saves WHERE nick=$1',
    [sess.nick]
  );
  res.json({ ok: true, save: formatSave(save) });
});

/* ─ 세이브 저장 ─ */
app.post('/api/save', async (req, res) => {
  try {
    const sess = await verifyToken(req.headers['authorization']);
    if (!sess) return res.json({ ok: false, msg: '인증 실패' });

    const {
      charIdx, lv, exp, hp, maxHp, atk, def,
      floor, gold, kills, clearedFloors,
      inventory, equipped,
    } = req.body;

    await db.query(`
      INSERT INTO game_saves
        (user_id, nick, char_idx, lv, exp, hp, max_hp, atk, def_stat,
         floor, gold, kills, cleared_floors, inventory, equipped, saved_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        char_idx       = EXCLUDED.char_idx,
        lv             = EXCLUDED.lv,
        exp            = EXCLUDED.exp,
        hp             = EXCLUDED.hp,
        max_hp         = EXCLUDED.max_hp,
        atk            = EXCLUDED.atk,
        def_stat       = EXCLUDED.def_stat,
        floor          = EXCLUDED.floor,
        gold           = EXCLUDED.gold,
        kills          = EXCLUDED.kills,
        cleared_floors = EXCLUDED.cleared_floors,
        inventory      = EXCLUDED.inventory,
        equipped       = EXCLUDED.equipped,
        saved_at       = NOW()
    `, [
      sess.user_id, sess.nick,
      charIdx ?? 0,
      lv ?? 1, exp ?? 0,
      hp ?? 100, maxHp ?? 100,
      atk ?? 50, def ?? 50,
      floor ?? 0, gold ?? 0, kills ?? 0,
      clearedFloors ?? [],
      JSON.stringify(inventory ?? []),
      JSON.stringify(equipped ?? {}),
    ]);

    console.log(`[SAVE] ${sess.nick} Lv${lv} floor:${floor}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[SAVE ERROR]', e.message);
    res.json({ ok: false, msg: '저장 실패' });
  }
});

/* ─ 랭킹 (클리어 층 기준) ─ */
app.get('/api/ranking', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT nick, char_idx, lv, floor, kills, gold,
             array_length(cleared_floors,1) AS clear_count,
             saved_at
      FROM game_saves
      ORDER BY floor DESC, lv DESC, kills DESC
      LIMIT 20
    `);
    res.json({ ok: true, ranking: rows.rows });
  } catch (e) {
    res.json({ ok: false, ranking: [] });
  }
});

/* ─ 내 정보 ─ */
app.get('/api/me', async (req, res) => {
  const sess = await verifyToken(req.headers['authorization']);
  if (!sess) return res.json({ ok: false });
  const save = await db.getOne('SELECT * FROM game_saves WHERE nick=$1', [sess.nick]);
  res.json({ ok: true, nick: sess.nick, save: formatSave(save) });
});

// DB row → 클라이언트 형식 변환
function formatSave(row) {
  if (!row) return null;
  return {
    charIdx:       row.char_idx,
    lv:            row.lv,
    exp:           row.exp,
    hp:            row.hp,
    maxHp:         row.max_hp,
    atk:           row.atk,
    def:           row.def_stat,
    floor:         row.floor,
    gold:          row.gold,
    kills:         row.kills,
    clearedFloors: row.cleared_floors || [],
    inventory:     row.inventory || [],
    equipped:      row.equipped  || {},
    savedAt:       row.saved_at,
  };
}

/* ══════════════════════════════════════
   세션 인메모리 캐시 (WebSocket용)
══════════════════════════════════════ */
const sessions  = new Map(); // token → { nick, user_id }
const rooms     = new Map(); // roomCode → Room
const clients   = new Map(); // ws → ClientInfo

/* ══════════════════════════════════════
   방 & 플레이어 클래스
══════════════════════════════════════ */
class Room {
  constructor(code) {
    this.code      = code;
    this.players   = new Map();
    this.chat      = [];
    this.floor     = 0;
    this.mapSeed   = Math.floor(Math.random() * 999999);
    this.phase     = 'lobby';
    this.createdAt = Date.now();
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
      code: this.code, floor: this.floor,
      phase: this.phase, mapSeed: this.mapSeed,
      players: [...this.players.values()].map(p => p.toPublic()),
    };
  }
}

class PlayerState {
  constructor(ws, id, nick, charIdx, userId) {
    this.ws      = ws;  this.id     = id;
    this.nick    = nick; this.userId = userId;
    this.charIdx = charIdx;
    this.hp = 100; this.maxHp = 100;
    this.lv = 1;   this.exp   = 0;
    this.atk = 50; this.def   = 50;
    this.x = 0;   this.y     = 0;
    this.floor = 0; this.gold  = 0; this.kills = 0;
    this.inventory     = [];
    this.equipped      = {};
    this.clearedFloors = [];
    this.isHost  = false;
    this.joinedAt = Date.now();
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
  toSaveData() {
    return {
      charIdx: this.charIdx, lv: this.lv, exp: this.exp,
      hp: this.hp, maxHp: this.maxHp, atk: this.atk, def: this.def,
      floor: this.floor, gold: this.gold, kills: this.kills,
      clearedFloors: this.clearedFloors,
      inventory: this.inventory, equipped: this.equipped,
    };
  }
}

/* ══════════════════════════════════════
   저장 함수 (DB + 인메모리 세션)
══════════════════════════════════════ */
async function savePlayerToDB(player) {
  if (!player?.userId) return;
  try {
    const sd = player.toSaveData();
    await db.query(`
      INSERT INTO game_saves
        (user_id,nick,char_idx,lv,exp,hp,max_hp,atk,def_stat,
         floor,gold,kills,cleared_floors,inventory,equipped,saved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT(user_id) DO UPDATE SET
        char_idx=$3,lv=$4,exp=$5,hp=$6,max_hp=$7,atk=$8,def_stat=$9,
        floor=$10,gold=$11,kills=$12,cleared_floors=$13,
        inventory=$14,equipped=$15,saved_at=NOW()
    `, [
      player.userId, player.nick,
      sd.charIdx,sd.lv,sd.exp,sd.hp,sd.maxHp,sd.atk,sd.def,
      sd.floor,sd.gold,sd.kills,
      sd.clearedFloors,
      JSON.stringify(sd.inventory),
      JSON.stringify(sd.equipped),
    ]);
    console.log(`[AUTO-SAVE] ${player.nick} Lv${sd.lv} floor:${sd.floor}`);
  } catch (e) {
    console.error('[SAVE ERROR]', e.message);
  }
}

/* ══════════════════════════════════════
   이탈 처리
══════════════════════════════════════ */
async function removePlayer(ws) {
  const info = clients.get(ws);
  if (!info) return;
  const { roomCode, playerId } = info;
  const room = rooms.get(roomCode);
  if (!room) { clients.delete(ws); return; }

  const player = room.players.get(playerId);

  // 비정상 이탈 포함 자동 저장
  if (player) await savePlayerToDB(player);

  room.players.delete(playerId);
  clients.delete(ws);

  // 호스트 위임
  if (player?.isHost && room.players.size > 0) {
    const next = [...room.players.values()][0];
    next.isHost = true;
    next.send({ type: 'host_promoted', mapSeed: room.mapSeed });
  }

  if (room.players.size === 0) {
    rooms.delete(roomCode);
  } else {
    room.broadcast({ type: 'player_left', playerId, nick: player?.nick });
    room.broadcastAll({ type: 'room_state', room: room.toPublic() });
  }
  console.log(`[LEAVE] ${player?.nick} ← ${roomCode}`);
}

/* ══════════════════════════════════════
   WebSocket 메시지 핸들러
══════════════════════════════════════ */
async function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  // ── 자동 매칭 (빈 방 자동 입장) ──
  if (msg.type === 'auto_match') {
    const { token, nick: guestNick, charIdx } = msg;
    let sess = null;
    if (token) {
      const cached = sessions.get(token);
      if (cached) sess = cached;
      else {
        const row = await db.getOne(
          'SELECT user_id, nick FROM sessions WHERE token=$1 AND expires_at>NOW()',
          [token]
        ).catch(()=>null);
        if (row) { sess = row; sessions.set(token, row); }
      }
    }
    const nick = sess?.nick || guestNick || ('생존자'+Math.floor(Math.random()*9000+1000));
    const userId = sess?.user_id || null;

    // ── 같은 닉네임이 이미 방에 있으면 기존 세션 제거 (중복 접속 방지) ──
    for (const [, r] of rooms) {
      for (const [pid, p] of r.players) {
        if (p.nick === nick && p.ws !== ws) {
          console.log(`[DUPLICATE] ${nick} 중복 접속 — 기존 세션 제거`);
          try { p.ws.close(); } catch {}
          r.players.delete(pid);
          // 클라이언트 맵에서도 제거
          for (const [cws, info] of clients) {
            if (info.playerId === pid) { clients.delete(cws); break; }
          }
        }
      }
    }

    // 4명 미만인 기존 방 찾기
    let room = null;
    for (const [, r] of rooms) {
      if (r.memberCount < 4 && r.phase !== 'closed') { room = r; break; }
    }
    // 없으면 새 방 생성
    if (!room) {
      const code = genCode();
      room = new Room(code);
      rooms.set(code, room);
    }

    // 캐릭터 중복 처리: 겹치면 다른 캐릭터 자동 배정
    const taken = [...room.players.values()].map(p => p.charIdx);
    let assignedChar = charIdx ?? -1;
    if (assignedChar >= 0 && taken.includes(assignedChar)) {
      const available = [0,1,2,3].find(c => !taken.includes(c));
      assignedChar = available ?? -1;
    }

    const playerId = crypto.randomUUID();
    const player   = new PlayerState(ws, playerId, nick, assignedChar, userId);
    player.isHost  = room.players.size === 0;

    // 저장 데이터 복원
    if (userId) {
      const save = await db.getOne('SELECT * FROM game_saves WHERE user_id=$1',[userId]).catch(()=>null);
      if (save) {
        player.lv=save.lv;player.exp=save.exp;
        player.hp=save.hp;player.maxHp=save.max_hp;
        player.atk=save.atk;player.def=save.def_stat;
        player.floor=save.floor;player.gold=save.gold;
        player.kills=save.kills;
        player.clearedFloors=save.cleared_floors||[];
        player.inventory=save.inventory||[];
        player.equipped=save.equipped||{};
      }
    }

    room.players.set(playerId, player);
    clients.set(ws, { roomCode: room.code, playerId });

    player.send({
      type: 'joined', playerId, roomCode: room.code,
      isHost: player.isHost, mapSeed: room.mapSeed,
      room: room.toPublic(), recentChat: room.chat.slice(-20),
    });
    room.broadcast({ type:'player_joined', player:player.toPublic() }, playerId);
    room.broadcastAll({ type:'room_state', room:room.toPublic() });
    console.log(`[AUTO_MATCH] ${nick}(${assignedChar}) → ${room.code} (${room.memberCount}명)`);
    return;
  }

  // ── 기존 방 입장 ──
  if (msg.type === 'join') {
    const { token, nick: guestNick, charIdx, roomCode: wantCode } = msg;

    // 토큰 검증 (DB)
    let sess = null;
    if (token) {
      const cached = sessions.get(token);
      if (cached) { sess = cached; }
      else {
        const row = await db.getOne(
          'SELECT user_id, nick FROM sessions WHERE token=$1 AND expires_at>NOW()',
          [token]
        );
        if (row) { sess = row; sessions.set(token, row); }
      }
    }

    const nick = sess?.nick || guestNick || ('생존자' + Math.floor(Math.random()*9000+1000));
    const userId = sess?.user_id || null;

    const code = wantCode ? wantCode.toUpperCase() : genCode();
    if (!rooms.has(code)) rooms.set(code, new Room(code));
    const room = rooms.get(code);

    if (room.memberCount >= 4) {
      ws.send(JSON.stringify({ type: 'error', msg: '방이 가득 찼습니다' })); return;
    }
    const taken = [...room.players.values()].map(p => p.charIdx);
    if (charIdx >= 0 && taken.includes(charIdx)) {
      ws.send(JSON.stringify({ type: 'error', msg: '이미 선택된 캐릭터입니다' })); return;
    }

    const playerId = crypto.randomUUID();
    const player   = new PlayerState(ws, playerId, nick, charIdx ?? -1, userId);
    player.isHost  = room.players.size === 0;

    // 저장 데이터 복원
    if (userId) {
      const save = await db.getOne(
        'SELECT * FROM game_saves WHERE user_id=$1', [userId]
      );
      if (save) {
        player.lv = save.lv; player.exp = save.exp;
        player.hp = save.hp; player.maxHp = save.max_hp;
        player.atk = save.atk; player.def = save.def_stat;
        player.floor = save.floor; player.gold = save.gold;
        player.kills = save.kills;
        player.clearedFloors = save.cleared_floors || [];
        player.inventory = save.inventory || [];
        player.equipped  = save.equipped  || {};
        if (save.char_idx >= 0 && charIdx < 0)
          player.charIdx = save.char_idx;
      }
    }

    room.players.set(playerId, player);
    clients.set(ws, { roomCode: code, playerId });

    player.send({
      type: 'joined', playerId, roomCode: code,
      isHost: player.isHost, mapSeed: room.mapSeed,
      room: room.toPublic(), recentChat: room.chat.slice(-20),
      savedData: formatSave(userId ? await db.getOne(
        'SELECT * FROM game_saves WHERE user_id=$1',[userId]
      ) : null),
    });

    room.broadcast({ type: 'player_joined', player: player.toPublic() }, playerId);
    room.broadcastAll({ type: 'room_state', room: room.toPublic() });
    console.log(`[JOIN] ${nick} → ${code} (${room.memberCount}명)`);
    return;
  }

  // ── 이후 메시지는 방 멤버만 ──
  const info = clients.get(ws);
  if (!info) return;
  const { roomCode, playerId } = info;
  const room   = rooms.get(roomCode);
  if (!room)   return;
  const player = room.players.get(playerId);
  if (!player) return;

  switch (msg.type) {
    case 'pick_char': {
      const taken = [...room.players.values()].filter(p=>p.id!==playerId).map(p=>p.charIdx);
      if (taken.includes(msg.charIdx)) {
        player.send({ type:'error', msg:'이미 선택된 캐릭터' }); return;
      }
      player.charIdx = msg.charIdx;
      room.broadcastAll({ type:'room_state', room:room.toPublic() });
      break;
    }

    case 'start_game': {
      if (!player.isHost) return;
      room.mapSeed = msg.mapSeed ?? Math.floor(Math.random()*999999);
      room.phase   = 'playing';
      room.floor   = msg.floor ?? 0;
      room.broadcastAll({ type:'game_start', floor:room.floor, mapSeed:room.mapSeed });
      break;
    }

    // 상태 동기화 + 인벤토리/장비 포함
    case 'state': {
      const {x,y,hp,maxHp,lv,exp,atk,def,kills,floor,
             inventory,equipped,gold,clearedFloors} = msg;
      Object.assign(player, {
        x:x??player.x, y:y??player.y,
        hp:hp??player.hp, maxHp:maxHp??player.maxHp,
        lv:lv??player.lv, exp:exp??player.exp,
        atk:atk??player.atk, def:def??player.def,
        kills:kills??player.kills, floor:floor??player.floor,
        gold:gold??player.gold,
        inventory:inventory??player.inventory,
        equipped:equipped??player.equipped,
        clearedFloors:clearedFloors??player.clearedFloors,
      });
      // ── 같은 층 플레이어에게만 위치 브로드캐스트 ──
      room.players.forEach((p, id) => {
        if (id === playerId) return;
        if (p.ws?.readyState !== WebSocket.OPEN) return;
        // 같은 층이면 위치 포함, 다른 층이면 층+HP만 전송
        const sameFloor = (p.floor === player.floor);
        p.ws.send(JSON.stringify({
          type: 'player_state',
          playerId,
          charIdx: player.charIdx,
          lv: player.lv,
          hp: player.hp,
          maxHp: player.maxHp,
          floor: player.floor,
          // 같은 층일 때만 좌표 포함
          ...(sameFloor ? { x: player.x, y: player.y } : {}),
        }));
      });
      break;
    }

    // 정상 나가기 (저장 포함)
    case 'leave_game': {
      if (msg.saveData) Object.assign(player, msg.saveData);
      await savePlayerToDB(player);
      player.send({ type:'leave_ack' });
      break;
    }

    // 30초 자동저장
    case 'auto_save': {
      if (msg.saveData) Object.assign(player, msg.saveData);
      await savePlayerToDB(player);
      break;
    }

    // 층 이동
    case 'floor_change': {
      if (!player.isHost) return;
      room.floor   = msg.floor;
      room.mapSeed = Math.floor(Math.random()*999999);
      room.broadcastAll({ type:'floor_change', floor:room.floor, mapSeed:room.mapSeed });
      break;
    }

    // 스킬 브로드캐스트
    case 'skill': {
      // 같은 층 플레이어에게만 스킬 이펙트 전송
      room.players.forEach((p, id) => {
        if (id === playerId) return;
        if (p.ws?.readyState !== WebSocket.OPEN) return;
        if (p.floor !== player.floor) return;
        p.ws.send(JSON.stringify({
          type:'skill_fx', playerId, charIdx:player.charIdx,
          skillIdx:msg.skillIdx, x:msg.x, y:msg.y, angle:msg.angle,
          floor:player.floor,
        }));
      });
      break;
    }

    // 채팅
    case 'chat': {
      const text = (msg.text||'').trim().slice(0,100);
      if (!text) return;
      const chatMsg = {
        type:'chat', playerId, nick:player.nick,
        charIdx:player.charIdx, text, ts:Date.now(),
      };
      room.chat.push(chatMsg);
      if (room.chat.length > 50) room.chat.shift();
      room.broadcastAll(chatMsg);
      break;
    }

    case 'ping': player.send({ type:'pong', ts:msg.ts }); break;
  }
}

/* ══════════════════════════════════════
   WebSocket 연결
══════════════════════════════════════ */
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[CONNECT] ${ip}`);
  ws.on('message', raw => handleMessage(ws, raw.toString()).catch(console.error));
  ws.on('close',   () => removePlayer(ws));
  ws.on('error',   e  => console.error('[WS]', e.message));
  ws.send(JSON.stringify({ type:'hello', msg:'APT Survival Server v3.0' }));
});

/* ══════════════════════════════════════
   유틸 & 정리
══════════════════════════════════════ */
function genCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

// 비활성 방 + 만료 세션 정리
setInterval(async () => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.size === 0 || now - room.createdAt > 30*60*1000)
      rooms.delete(code);
  });
  try {
    await db.query('DELETE FROM sessions WHERE expires_at < NOW()');
  } catch {}
}, 5 * 60 * 1000);

/* ══════════════════════════════════════
   서버 시작
══════════════════════════════════════ */
(async () => {
  try {
    await initDB();

    // ── 정적 파일은 API 라우트 등록 후 맨 마지막에 ──
    app.use(express.static(path.join(__dirname, 'public')));
    // SPA 폴백 (모든 미매칭 GET → index.html)
    app.get('*', (req, res) => {
      const idx = path.join(__dirname, 'public', 'index.html');
      res.sendFile(idx, err => {
        if (err) res.status(404).json({ ok: false, msg: 'Not found' });
      });
    });

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🎮 APT Survival Server v3.0`);
      console.log(`   PORT: ${PORT}`);
      console.log(`   DB: ${process.env.DATABASE_URL ? '✅ PostgreSQL' : '❌ DATABASE_URL 없음'}`);
      console.log(`   JWT: ${process.env.JWT_SECRET ? '✅ 설정됨' : '⚠ 기본값 사용 중'}\n`);
    });
  } catch (e) {
    console.error('[STARTUP ERROR]', e);
    process.exit(1);
  }
})();
