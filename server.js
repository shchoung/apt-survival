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

  // game_saves: 캐릭터별 슬롯 (user_id + char_idx 복합 유니크)
  await db.query(`
    CREATE TABLE IF NOT EXISTS game_saves (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      nick        VARCHAR(10) NOT NULL,
      char_idx    SMALLINT NOT NULL DEFAULT 0,
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
      UNIQUE(user_id, char_idx)
    );
  `);

  // 기존 UNIQUE(user_id) 제약 → UNIQUE(user_id, char_idx) 마이그레이션
  // (이미 배포된 DB에 안전하게 적용)
  try {
    await db.query(`
      DO $$
      BEGIN
        -- 구버전 단일 유니크 제약 제거
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'game_saves_user_id_key'
        ) THEN
          ALTER TABLE game_saves DROP CONSTRAINT game_saves_user_id_key;
          ALTER TABLE game_saves ADD CONSTRAINT game_saves_user_id_char_idx_key
            UNIQUE (user_id, char_idx);
        END IF;
      END$$;
    `);
  } catch(e) { console.warn('[MIGRATE] game_saves 마이그레이션 스킵:', e.message); }

  // 공용 인벤토리 컬럼 마이그레이션 (users 테이블에 JSONB 컬럼 추가)
  try {
    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS
        shared_inventory JSONB DEFAULT '[]';
    `);
  } catch(e) { console.warn('[MIGRATE] shared_inventory 마이그레이션 스킵:', e.message); }

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

  await db.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id) ON DELETE SET NULL,
      nick        VARCHAR(20) NOT NULL,
      is_anon     BOOLEAN DEFAULT FALSE,
      title       VARCHAR(100) NOT NULL,
      content     TEXT NOT NULL,
      view_count  INT DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id          SERIAL PRIMARY KEY,
      post_id     INT REFERENCES posts(id) ON DELETE CASCADE,
      parent_id   INT REFERENCES comments(id) ON DELETE CASCADE,
      user_id     INT REFERENCES users(id) ON DELETE SET NULL,
      nick        VARCHAR(20) NOT NULL,
      is_anon     BOOLEAN DEFAULT FALSE,
      content     VARCHAR(500) NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS auction_items (
      id          SERIAL PRIMARY KEY,
      seller_id   INT REFERENCES users(id) ON DELETE CASCADE,
      seller_nick VARCHAR(10) NOT NULL,
      item_id     VARCHAR(60) NOT NULL,
      item_name   VARCHAR(60) NOT NULL,
      item_icon   VARCHAR(10) NOT NULL,
      item_grade  CHAR(1) NOT NULL,
      enh_level   SMALLINT DEFAULT 0,
      price       INT NOT NULL CHECK (price > 0),
      status      VARCHAR(10) NOT NULL DEFAULT 'active',
      buyer_id    INT REFERENCES users(id) ON DELETE SET NULL,
      buyer_nick  VARCHAR(10),
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '72 hours'
    );
  `);

  // 만료 세션 정리 (1일마다)
  async function cleanExpiredSessions() {
    try {
      const r = await db.query("DELETE FROM sessions WHERE expires_at < NOW()");
      if (r.rowCount > 0) console.log(`[SESSION] 만료 세션 ${r.rowCount}건 삭제`);
    } catch(e) { console.warn('[SESSION] 정리 실패', e.message); }
  }
  cleanExpiredSessions();
  setInterval(cleanExpiredSessions, 24 * 60 * 60 * 1000);

  // 만료 경매 자동 정리 (서버 시작 시 + 1시간마다)
  async function cleanExpiredAuctions() {
    try {
      const res = await db.query(
        "UPDATE auction_items SET status='expired' WHERE status='active' AND expires_at < NOW()"
      );
      if (res.rowCount > 0) console.log(`[AUCTION] 만료 ${res.rowCount}건 처리`);
    } catch(e) { console.warn('[AUCTION] 만료 정리 실패', e.message); }
  }
  cleanExpiredAuctions();
  setInterval(cleanExpiredAuctions, 60 * 60 * 1000);

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

    // 기본 세이브 데이터 생성 — 캐릭터 4개 슬롯 초기화
    for (let ci = 0; ci < 4; ci++) {
      await db.query(
        'INSERT INTO game_saves(user_id, nick, char_idx) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [user.id, nick, ci]
      );
    }

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

    // 세이브 데이터 조회 — 캐릭터별 4개 슬롯
    const savesResult = await db.query(
      'SELECT * FROM game_saves WHERE user_id=$1 ORDER BY char_idx ASC',
      [user.id]
    );
    // 슬롯이 없으면 초기화
    if (savesResult.rows.length === 0) {
      for (let ci = 0; ci < 4; ci++) {
        await db.query(
          'INSERT INTO game_saves(user_id, nick, char_idx) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [user.id, nick, ci]
        );
      }
      savesResult.rows = Array.from({length:4}, (_,i) => ({user_id:user.id, nick, char_idx:i, lv:1, exp:0, hp:100, max_hp:100, atk:50, def_stat:50, floor:0, gold:0, kills:0, cleared_floors:[], inventory:[], equipped:{}, saved_at:null}));
    }
    const saves = [0,1,2,3].map(ci => {
      const row = savesResult.rows.find(r => r.char_idx === ci) || null;
      return formatSave(row, ci);
    });

    console.log(`[LOGIN] ${nick}`);
    res.json({ ok: true, token, nick: user.nick, saves });
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

/* ─ 세이브 불러오기 — 캐릭터 4개 슬롯 전체 ─ */
app.get('/api/save', async (req, res) => {
  const sess = await verifyToken(req.headers['authorization']);
  if (!sess) return res.json({ ok: false, msg: '인증 실패' });

  const result = await db.query(
    'SELECT * FROM game_saves WHERE user_id=$1 ORDER BY char_idx ASC',
    [sess.user_id]
  );
  const saves = [0,1,2,3].map(ci => {
    const row = result.rows.find(r => r.char_idx === ci) || null;
    return formatSave(row, ci);
  });
  res.json({ ok: true, saves });
});

/* ─ 세이브 저장 — char_idx별 개별 저장 ─ */
app.post('/api/save', async (req, res) => {
  try {
    const sess = await verifyToken(req.headers['authorization']);
    if (!sess) return res.json({ ok: false, msg: '인증 실패' });

    const {
      charIdx, lv, exp, hp, maxHp, atk, def,
      floor, gold, kills, clearedFloors,
      inventory, equipped,
    } = req.body;

    if (charIdx === undefined || charIdx < 0 || charIdx > 3)
      return res.json({ ok: false, msg: '잘못된 캐릭터 인덱스' });

    await db.query(`
      INSERT INTO game_saves
        (user_id, nick, char_idx, lv, exp, hp, max_hp, atk, def_stat,
         floor, gold, kills, cleared_floors, inventory, equipped, saved_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (user_id, char_idx) DO UPDATE SET
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
      charIdx,
      lv ?? 1, exp ?? 0,
      hp ?? 100, maxHp ?? 100,
      atk ?? 50, def ?? 50,
      floor ?? 0, gold ?? 0, kills ?? 0,
      clearedFloors ?? [],
      JSON.stringify(inventory ?? []),
      JSON.stringify(equipped ?? {}),
    ]);

    console.log(`[SAVE] ${sess.nick} char:${charIdx} Lv${lv} floor:${floor}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[SAVE ERROR]', e.message);
    res.json({ ok: false, msg: '저장 실패' });
  }
});

/* ═══ 공용 인벤토리 API ═══ */

// GET /api/shared-inv — 공용 인벤토리 조회
app.get('/api/shared-inv', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.json({ ok: false, msg: '인증 필요' });
    const sess = await db.query(
      'SELECT user_id FROM sessions WHERE token=$1 AND expires_at>NOW()', [token]
    );
    if (!sess.rows.length) return res.json({ ok: false, msg: '세션 만료' });
    const uid = sess.rows[0].user_id;
    const row = await db.query('SELECT shared_inventory FROM users WHERE id=$1', [uid]);
    const inv = row.rows[0]?.shared_inventory || [];
    res.json({ ok: true, sharedInv: inv });
  } catch (e) {
    console.error('[SHARED-INV GET]', e.message);
    res.json({ ok: false, msg: '조회 실패' });
  }
});

// POST /api/shared-inv — 공용 인벤토리 저장
app.post('/api/shared-inv', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.json({ ok: false, msg: '인증 필요' });
    const sess = await db.query(
      'SELECT user_id FROM sessions WHERE token=$1 AND expires_at>NOW()', [token]
    );
    if (!sess.rows.length) return res.json({ ok: false, msg: '세션 만료' });
    const uid = sess.rows[0].user_id;
    const { sharedInv } = req.body;
    if (!Array.isArray(sharedInv)) return res.json({ ok: false, msg: '잘못된 데이터' });
    // 최대 40슬롯 제한
    const clamped = sharedInv.slice(0, 40);
    await db.query(
      'UPDATE users SET shared_inventory=$1 WHERE id=$2',
      [JSON.stringify(clamped), uid]
    );
    console.log(`[SHARED-INV] user:${uid} items:${clamped.length}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[SHARED-INV POST]', e.message);
    res.json({ ok: false, msg: '저장 실패' });
  }
});

/* ═══════════════════════════════════════
   경매장 API
═══════════════════════════════════════ */

// 인증 헬퍼
async function authSession(token) {
  if (!token) return null;
  try {
    const r = await db.query(
      'SELECT user_id, nick FROM sessions WHERE token=$1 AND expires_at>NOW()', [token]
    );
    return r.rows[0] || null;
  } catch(e) {
    console.error('[AUTH]', e.message);
    return null;
  }
}

// GET /api/auction — 경매 목록 (active 전체, 최신순, 페이지당 20개)
app.get('/api/auction', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page)||1);
    const limit = 20;
    const offset = (page-1)*limit;
    const grade = req.query.grade || '';       // 등급 필터
    const keyword = req.query.q || '';          // 이름 검색

    let where = "WHERE status='active' AND expires_at > NOW()";
    const params = [];
    let pi = 1;
    if (grade) { where += ` AND item_grade=$${pi++}`; params.push(grade); }
    if (keyword) { where += ` AND item_name ILIKE $${pi++}`; params.push('%'+keyword+'%'); }

    const rows = await db.query(
      `SELECT id,seller_nick,item_id,item_name,item_icon,item_grade,enh_level,price,created_at,expires_at
       FROM auction_items ${where}
       ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const total = await db.query(`SELECT COUNT(*) FROM auction_items ${where}`, params);
    res.json({ ok:true, items:rows.rows, total:parseInt(total.rows[0].count), page, limit });
  } catch(e) {
    console.error('[AUCTION LIST]', e.message);
    res.json({ ok:false, msg:'목록 조회 실패' });
  }
});

// GET /api/auction/mine — 내 등록 목록 + 판매 완료 내역
app.get('/api/auction/mine', async (req, res) => {
  try {
    const sess = await authSession(req.headers.authorization);
    if (!sess) return res.json({ ok:false, msg:'로그인 필요' });
    const rows = await db.query(
      `SELECT id,item_id,item_name,item_icon,item_grade,enh_level,price,status,buyer_nick,created_at,expires_at
       FROM auction_items WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [sess.user_id]
    );
    // 구매한 내역
    const bought = await db.query(
      `SELECT id,item_id,item_name,item_icon,item_grade,enh_level,price,seller_nick,created_at
       FROM auction_items WHERE buyer_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [sess.user_id]
    );
    res.json({ ok:true, listed:rows.rows, bought:bought.rows });
  } catch(e) {
    res.json({ ok:false, msg:'조회 실패' });
  }
});

/* ═══ 게시판 API ═══ */


// POST /api/auction — 아이템 등록
app.post('/api/auction', async (req, res) => {
  try {
    const sess = await authSession(req.headers.authorization);
    if (!sess) return res.json({ ok:false, msg:'로그인 필요' });

    const { itemId, itemName, itemIcon, itemGrade, enhLevel, price } = req.body;
    if (!itemId || !price || price <= 0) return res.json({ ok:false, msg:'잘못된 데이터' });
    if (price > 99999999) return res.json({ ok:false, msg:'가격 한도 초과 (최대 99,999,999G)' });

    // 동일 유저 활성 등록 10개 제한
    const cnt = await db.query(
      "SELECT COUNT(*) FROM auction_items WHERE seller_id=$1 AND status='active'",
      [sess.user_id]
    );
    if (parseInt(cnt.rows[0].count) >= 10)
      return res.json({ ok:false, msg:'등록 한도 초과 (최대 10개)' });

    const row = await db.query(
      `INSERT INTO auction_items
         (seller_id,seller_nick,item_id,item_name,item_icon,item_grade,enh_level,price)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [sess.user_id, sess.nick, itemId, itemName||itemId, itemIcon||'📦',
       itemGrade||'C', enhLevel||0, price]
    );
    console.log(`[AUCTION] 등록 ${sess.nick}: ${itemName} ${price}G`);
    res.json({ ok:true, id:row.rows[0].id });
  } catch(e) {
    console.error('[AUCTION POST]', e.message);
    res.json({ ok:false, msg:'등록 실패' });
  }
});

// POST /api/auction/:id/buy — 구매
app.post('/api/auction/:id/buy', async (req, res) => {
  // 원자적 상태 변경으로 동시 구매 방지
  try {
    const sess = await authSession(req.headers.authorization);
    if (!sess) return res.json({ ok:false, msg:'로그인 필요' });
    const auctionId = parseInt(req.params.id);

    // 경매 아이템 조회 (FOR UPDATE 효과: status 체크 후 바로 업데이트)
    const aRow = await db.query(
      "SELECT * FROM auction_items WHERE id=$1 AND status='active' AND expires_at>NOW()",
      [auctionId]
    );
    if (!aRow.rows.length) return res.json({ ok:false, msg:'이미 판매되었거나 만료된 아이템입니다' });
    const item = aRow.rows[0];
    if (item.seller_id === sess.user_id) return res.json({ ok:false, msg:'자신의 아이템은 구매할 수 없습니다' });

    // 구매자 골드 확인 (현재 캐릭터 기준 — 가장 골드 많은 슬롯)
    const saves = await db.query(
      'SELECT char_idx, gold FROM game_saves WHERE user_id=$1 ORDER BY gold DESC LIMIT 1',
      [sess.user_id]
    );
    if (!saves.rows.length)
      return res.json({ ok:false, msg:'캐릭터 데이터 없음. 게임을 먼저 시작하세요.' });
    if (saves.rows[0].gold < item.price)
      return res.json({ ok:false, msg:`골드 부족 (보유: ${saves.rows[0].gold.toLocaleString()}G / 필요: ${item.price.toLocaleString()}G)` });

    const buyerSave = saves.rows[0];

    // 원자적 상태 변경 (동시 구매 방지)
    const upd = await db.query(
      "UPDATE auction_items SET status='sold',buyer_id=$1,buyer_nick=$2 WHERE id=$3 AND status='active' RETURNING id",
      [sess.user_id, sess.nick, auctionId]
    );
    if (!upd.rows.length) return res.json({ ok:false, msg:'동시 구매 충돌, 다시 시도하세요' });

    // 구매자 골드 차감
    await db.query(
      'UPDATE game_saves SET gold=gold-$1 WHERE user_id=$2 AND char_idx=$3',
      [item.price, sess.user_id, buyerSave.char_idx]
    );
    // 판매자 골드 지급 (수수료 5%)
    const tax = Math.floor(item.price * 0.05);
    const gain = item.price - tax;
    await db.query(
      'UPDATE game_saves SET gold=gold+$1 WHERE user_id=$2 AND char_idx=(SELECT char_idx FROM game_saves WHERE user_id=$2 ORDER BY char_idx ASC LIMIT 1)',
      [gain, item.seller_id]
    );

    console.log(`[AUCTION] 판매 완료: ${item.item_name} ${item.price}G (${item.seller_nick}→${sess.nick}, 수수료 ${tax}G)`);
    res.json({
      ok:true,
      item:{ itemId:item.item_id, itemName:item.item_name, itemIcon:item.item_icon,
             itemGrade:item.item_grade, enhLevel:item.enh_level },
      paid:item.price, gain, tax,
      charIdx:buyerSave.char_idx
    });
  } catch(e) {
    console.error('[AUCTION BUY]', e.message);
    res.json({ ok:false, msg:'구매 실패' });
  }
});

// DELETE /api/auction/:id — 본인 등록 취소
app.delete('/api/auction/:id', async (req, res) => {
  try {
    const sess = await authSession(req.headers.authorization);
    if (!sess) return res.json({ ok:false, msg:'로그인 필요' });
    const auctionId = parseInt(req.params.id);
    const upd = await db.query(
      "UPDATE auction_items SET status='cancelled' WHERE id=$1 AND seller_id=$2 AND status='active' RETURNING id,item_id,item_name,item_icon,item_grade,enh_level",
      [auctionId, sess.user_id]
    );
    if (!upd.rows.length) return res.json({ ok:false, msg:'취소할 수 없는 아이템입니다' });
    const it = upd.rows[0];
    res.json({
      ok:true,
      item:{ itemId:it.item_id, itemName:it.item_name, itemIcon:it.item_icon,
             itemGrade:it.item_grade, enhLevel:it.enh_level }
    });
  } catch(e) {
    console.error('[AUCTION DELETE]', e.message);
    res.json({ ok:false, msg:'취소 실패' });
  }
});


// 목록 조회
app.get('/api/posts', async (req, res) => {
  try {
    const page=Math.max(1,parseInt(req.query.page)||1);
    const limit=20, offset=(page-1)*limit;
    const rows=await db.query(`
      SELECT p.id, p.title,
        CASE WHEN p.is_anon THEN '익명' ELSE p.nick END AS nick,
        p.is_anon, p.view_count, p.created_at,
        COUNT(c.id)::int AS comment_count
      FROM posts p LEFT JOIN comments c ON c.post_id=p.id
      GROUP BY p.id ORDER BY p.created_at DESC LIMIT $1 OFFSET $2
    `,[limit,offset]);
    const total=await db.query('SELECT COUNT(*) FROM posts');
    res.json({ok:true,posts:rows.rows,
      total:parseInt(total.rows[0].count),page,limit});
  } catch(e){res.json({ok:false,msg:e.message});}
});

// 글 작성
app.post('/api/posts', async (req, res) => {
  const sess=await verifyToken(req.headers['authorization']);
  if(!sess) return res.json({ok:false,msg:'로그인 필요'});
  const {title,content,is_anon=false}=req.body;
  if(!title?.trim()||!content?.trim()) return res.json({ok:false,msg:'제목/내용 필수'});
  if(title.length>100||content.length>2000) return res.json({ok:false,msg:'길이 초과'});
  try {
    const r=await db.query(
      `INSERT INTO posts(user_id,nick,is_anon,title,content)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [sess.user_id,sess.nick,!!is_anon,title.trim(),content.trim()]);
    res.json({ok:true,id:r.rows[0].id});
  } catch(e){res.json({ok:false,msg:e.message});}
});

// 글 상세 + 댓글
app.get('/api/posts/:id', async (req, res) => {
  const id=parseInt(req.params.id);
  if(!id) return res.json({ok:false});
  try {
    await db.query('UPDATE posts SET view_count=view_count+1 WHERE id=$1',[id]);
    const post=await db.getOne(`
      SELECT id,title,content,
        CASE WHEN is_anon THEN '익명' ELSE nick END AS nick,
        is_anon,view_count,created_at FROM posts WHERE id=$1`,[id]);
    if(!post) return res.json({ok:false,msg:'없는 글'});
    const cmts=await db.query(`
      SELECT id,parent_id,
        CASE WHEN is_anon THEN '익명' ELSE nick END AS nick,
        is_anon,content,created_at
      FROM comments WHERE post_id=$1 ORDER BY created_at ASC`,[id]);
    res.json({ok:true,post,comments:cmts.rows});
  } catch(e){res.json({ok:false,msg:e.message});}
});

// 댓글/답글 작성
app.post('/api/posts/:id/comments', async (req, res) => {
  const sess=await verifyToken(req.headers['authorization']);
  if(!sess) return res.json({ok:false,msg:'로그인 필요'});
  const post_id=parseInt(req.params.id);
  const {content,parent_id=null,is_anon=false}=req.body;
  if(!content?.trim()) return res.json({ok:false,msg:'내용 필수'});
  if(content.length>500) return res.json({ok:false,msg:'500자 이내'});
  try {
    const r=await db.query(
      `INSERT INTO comments(post_id,parent_id,user_id,nick,is_anon,content)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,
      [post_id,parent_id||null,sess.user_id,sess.nick,!!is_anon,content.trim()]);
    res.json({ok:true,id:r.rows[0].id,
      nick:is_anon?'익명':sess.nick,
      created_at:r.rows[0].created_at});
  } catch(e){res.json({ok:false,msg:e.message});}
});

/* ─ 랭킹 (캐릭터별 최고 기록) ─ */
app.get('/api/ranking', async (req, res) => {
  try {
    const sort = req.query.sort || 'floor';
    const orderMap = {
      floor: 'floor DESC, lv DESC, kills DESC',
      lv:    'lv DESC, floor DESC, kills DESC',
      kills: 'kills DESC, floor DESC, lv DESC',
    };
    const orderBy = orderMap[sort] || orderMap.floor;
    // 유저+캐릭터 조합별 최고 기록 (인벤토리/장착 포함)
    const rows = await db.query(`
      SELECT nick, char_idx, lv, floor, kills, gold,
             array_length(cleared_floors,1) AS clear_count,
             inventory, equipped,
             saved_at
      FROM game_saves
      WHERE lv > 1 OR floor > 0 OR kills > 0
      ORDER BY ${orderBy}
      LIMIT 30
    `);
    res.json({ ok: true, ranking: rows.rows });
  } catch (e) {
    res.json({ ok: false, ranking: [] });
  }
});

/* ─ 내 정보 — 캐릭터별 4슬롯 ─ */
app.get('/api/me', async (req, res) => {
  const sess = await verifyToken(req.headers['authorization']);
  if (!sess) return res.json({ ok: false });
  const result = await db.query(
    'SELECT * FROM game_saves WHERE user_id=$1 ORDER BY char_idx ASC', [sess.user_id]
  );
  const saves = [0,1,2,3].map(ci => {
    const row = result.rows.find(r => r.char_idx === ci) || null;
    return formatSave(row, ci);
  });
  res.json({ ok: true, nick: sess.nick, saves });
});

// DB row → 클라이언트 형식 변환
// charIdx: 슬롯이 없을 때도 기본값 객체 반환 (신규 캐릭터)
function formatSave(row, charIdx) {
  const ci = row ? row.char_idx : (charIdx ?? 0);
  if (!row) {
    return {
      charIdx: ci, lv: 1, exp: 0,
      hp: 100, maxHp: 100, atk: 50, def: 50,
      floor: 0, gold: 0, kills: 0,
      clearedFloors: [], inventory: [], equipped: {},
      savedAt: null, isNew: true,
    };
  }
  return {
    charIdx:       ci,
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
    isNew:         false,
  };
}

/* ══════════════════════════════════════
   세션 인메모리 캐시 (WebSocket용)
══════════════════════════════════════ */
const sessions  = new Map(); // token → { nick, user_id }
const rooms     = new Map(); // roomCode → Room
const clients   = new Map(); // ws → ClientInfo
const userConnections = new Map(); // user_id → ws (동시접속 방지)

/* ══════════════════════════════════════
   방 & 플레이어 클래스 (단순 릴레이)
══════════════════════════════════════ */
class Room {
  constructor(code) {
    this.code      = code;
    this.players   = new Map();
    this.chat      = [];
    this.mapSeed   = Math.floor(Math.random() * 999999);
    this.phase     = 'active';
    this.createdAt = Date.now();
  }
  broadcast(msg, excludeId=null) {
    const data=JSON.stringify(msg);
    this.players.forEach((p,id)=>{
      if(id!==excludeId && p.ws?.readyState===WebSocket.OPEN)
        p.ws.send(data);
    });
  }
  broadcastAll(msg){ this.broadcast(msg,null); }
  broadcastSameFloor(msg, floor, excludeId=null){
    const data=JSON.stringify(msg);
    this.players.forEach((p,id)=>{
      if(id===excludeId) return;
      if(p.floor!==floor) return;
      if(p.ws?.readyState===WebSocket.OPEN) p.ws.send(data);
    });
  }
  get memberCount(){ return this.players.size; }
  toPublic(){
    return {
      code:this.code, mapSeed:this.mapSeed, phase:this.phase,
      players:[...this.players.values()].map(p=>p.toPublic()),
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
  if (!player?.userId || player.charIdx < 0) return;
  try {
    const sd = player.toSaveData();
    // ON CONFLICT (user_id, char_idx) — 캐릭터 슬롯별 저장
    await db.query(`
      INSERT INTO game_saves
        (user_id,nick,char_idx,lv,exp,hp,max_hp,atk,def_stat,
         floor,gold,kills,cleared_floors,inventory,equipped,saved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT(user_id,char_idx) DO UPDATE SET
        lv=$4,exp=$5,hp=$6,max_hp=$7,atk=$8,def_stat=$9,
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
    console.log(`[AUTO-SAVE] ${player.nick} char:${sd.charIdx} Lv${sd.lv} floor:${sd.floor}`);
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

  // userConnections 정리 (현재 ws가 등록된 경우만)
  if (player?.userId) {
    const cur = userConnections.get(player.userId);
    if (cur === ws) userConnections.delete(player.userId);
  }

  // 비정상 이탈 포함 자동 저장
  if (player) await savePlayerToDB(player);

  room.players.delete(playerId);
  clients.delete(ws);

  // 서버가 게임을 관리하므로 호스트 위임 불필요
  // 단, 클라이언트 호환성을 위해 첫 번째 플레이어에게 isHost 전달
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

    // ── user_id 기반 중복 접속 차단 (로그인 유저만) ──
    if (userId) {
      const existingWs = userConnections.get(userId);
      if (existingWs && existingWs !== ws && existingWs.readyState === WebSocket.OPEN) {
        console.log(`[DUPLICATE] user_id=${userId} (${nick}) 중복 접속 — 기존 연결 강제 종료`);
        try {
          existingWs.send(JSON.stringify({ type: 'duplicate_login', msg: '다른 기기에서 접속하여 연결이 종료되었습니다.' }));
          existingWs.close();
        } catch {}
      }
      userConnections.set(userId, ws);
    }

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

    // 저장 데이터 복원 — 선택한 캐릭터 슬롯만
    if (userId && assignedChar >= 0) {
      const save = await db.getOne(
        'SELECT * FROM game_saves WHERE user_id=$1 AND char_idx=$2',
        [userId, assignedChar]
      ).catch(()=>null);
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
      floor: room.floor,
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

    // 저장 데이터 복원 — 선택한 캐릭터 슬롯만
    if (userId && (charIdx ?? -1) >= 0) {
      const save = await db.getOne(
        'SELECT * FROM game_saves WHERE user_id=$1 AND char_idx=$2',
        [userId, charIdx]
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
        // charIdx는 클라이언트가 선택한 값 그대로 (저장값으로 덮지 않음)
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

    // 스킬 — 같은 층에만 릴레이
    case 'skill': {
      room.broadcastSameFloor({
        type:'skill_fx', playerId, charIdx:player.charIdx,
        skillIdx:msg.skillIdx, x:msg.x, y:msg.y, angle:msg.angle,
        floor:player.floor,
      }, player.floor, playerId);
      break;
    }

    // 채팅 — 전체 릴레이 (보낸 사람 제외)
    case 'chat': {
      const text=(msg.text||'').trim().slice(0,100);
      if(!text) return;
      const chatMsg={type:'chat',playerId,nick:player.nick,
        charIdx:player.charIdx,text,ts:Date.now()};
      room.chat.push(chatMsg);
      if(room.chat.length>50) room.chat.shift();
      room.broadcast(chatMsg, playerId);
      break;
    }

    // 보스 동기화 — 같은 층 릴레이
    case 'boss_sync':
    case 'boss_dead': {
      room.broadcastSameFloor({...msg, playerId}, player.floor, playerId);
      break;
    }

    // 비호스트 보스 공격 → 같은 층 호스트에게 전달
    case 'boss_attack': {
      room.broadcastSameFloor({...msg, playerId}, player.floor, playerId);
      break;
    }

    // 플레이어 층 업데이트
    case 'player_floor': {
      player.floor=msg.floor??player.floor;
      break;
    }

    case 'ping': player.send({type:'pong',ts:msg.ts}); break;
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
