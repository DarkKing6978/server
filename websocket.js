/**
 * SlideMath WebSocket Server v2.0
 * Повноцінний real-time сервер з прямим доступом до MySQL.
 * Замінює HTTP-запити: submitAnswer, pollSessionState, patchParticipant, patchSession.
 */
require('dotenv').config({ __dirname: require('path').join(__dirname, '.env') });

const WebSocket = require('ws');
const http = require('http');
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || process.env.WS_PORT || 8080;

// ── MySQL connection pool ──────────────────────────────────────────────────
let db = null;

async function getDb() {
  if (db) return db;
  db = await mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
  console.log('[WS] MySQL connected:', process.env.DB_HOST + '/' + process.env.DB_NAME);
  return db;
}

// ── Answer Buffer ──────────────────────────────────────────────────────────
// Buffers student answers in memory, flushes to MySQL in batch.
// Key = "participantId:questionId" → stores only the LATEST value per question.
// Flush triggers: periodic (15s), on disconnect, on shutdown, on endSession.

const FLUSH_INTERVAL_MS = 15_000;

class AnswerBuffer {
  constructor() {
    this.buffer = new Map();       // "pid:qid" → { sessionId, participantId, questionId, value, testId, submittedAt }
    this.flushing = false;
    this._flushTimer = null;
  }

  add(sessionId, participantId, questionId, value, testId) {
    const key = `${participantId}:${questionId}`;
    this.buffer.set(key, {
      sessionId,
      participantId: String(participantId),
      questionId: String(questionId),
      value: value ?? '',
      testId: testId || '',
      submittedAt: Date.now(),
    });
  }

  // Returns all buffered entries (for merging with MySQL data)
  getForParticipant(participantId) {
    const pid = String(participantId);
    const entries = [];
    for (const [key, entry] of this.buffer) {
      if (entry.participantId === pid) entries.push(entry);
    }
    return entries;
  }

  getForSession(sessionId) {
    const entries = [];
    for (const [key, entry] of this.buffer) {
      if (entry.sessionId === sessionId) entries.push(entry);
    }
    return entries;
  }

  size() {
    return this.buffer.size;
  }

  // Flush all buffered entries to MySQL in batch
  async flush() {
    if (this.buffer.size === 0 || this.flushing) return;
    this.flushing = true;
    const entries = Array.from(this.buffer.values());
    this.buffer.clear();

    try {
      const pool = await getDb();
      await this._batchUpsert(pool, entries);
      console.log(`[Buffer] Flushed ${entries.length} answers to MySQL`);
    } catch (e) {
      console.error('[Buffer] Flush failed, re-queuing entries:', e.message);
      // Re-queue failed entries so they aren't lost
      for (const entry of entries) {
        const key = `${entry.participantId}:${entry.questionId}`;
        if (!this.buffer.has(key)) this.buffer.set(key, entry);
      }
    } finally {
      this.flushing = false;
    }
  }

  // Flush only one participant's answers (on disconnect)
  async flushParticipant(participantId) {
    const pid = String(participantId);
    const entries = [];
    const remaining = new Map();

    for (const [key, entry] of this.buffer) {
      if (entry.participantId === pid) {
        entries.push(entry);
      } else {
        remaining.set(key, entry);
      }
    }

    if (entries.length === 0) return;
    this.buffer = remaining;

    try {
      const pool = await getDb();
      await this._batchUpsert(pool, entries);
      console.log(`[Buffer] Flushed ${entries.length} answers for participant ${pid}`);
    } catch (e) {
      console.error(`[Buffer] Flush participant ${pid} failed, re-queuing:`, e.message);
      for (const entry of entries) {
        const key = `${entry.participantId}:${entry.questionId}`;
        if (!this.buffer.has(key)) this.buffer.set(key, entry);
      }
    }
  }

  // Flush everything (on shutdown)
  async flushAll() {
    if (this.buffer.size === 0) return;
    console.log(`[Buffer] Flushing all ${this.buffer.size} answers before shutdown...`);
    await this.flush();
  }

  // Batch UPSERT: one multi-row INSERT for all entries
  async _batchUpsert(pool, entries) {
    if (!entries.length) return;

    // Group by session to keep queries clean
    const bySession = new Map();
    for (const e of entries) {
      if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
      bySession.get(e.sessionId).push(e);
    }

    for (const [sessionId, sessionEntries] of bySession) {
      // Build multi-row INSERT
      const placeholders = [];
      const values = [];
      const participantIds = new Set();

      for (const e of sessionEntries) {
        placeholders.push('(?, ?, ?, ?, ?, ?)');
        values.push(e.participantId, e.questionId, sessionId, e.testId, e.value, e.submittedAt);
        participantIds.add(e.participantId);
      }

      const sql = `
        INSERT INTO sm_answers (participant_id, question_id, session_id, test_id, value, submitted_at)
        VALUES ${placeholders.join(', ')}
        ON DUPLICATE KEY UPDATE
          value = VALUES(value), submitted_at = VALUES(submitted_at), updated_at = NOW()
      `;
      await pool.query(sql, values);

      // Batch update last_active for all participants in this flush
      if (participantIds.size > 0) {
        const pidArray = Array.from(participantIds);
        const pidPlaceholders = pidArray.map(() => '?').join(', ');
        const now = Date.now();
        await pool.query(
          `UPDATE sm_participants SET last_active = ? WHERE id IN (${pidPlaceholders})`,
          [now, ...pidArray]
        );
      }
    }
  }

  startPeriodicFlush() {
    this._flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    console.log(`[Buffer] Periodic flush every ${FLUSH_INTERVAL_MS / 1000}s`);
  }

  stopPeriodicFlush() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }
}

const answerBuffer = new AnswerBuffer();

// ── HTTP server + WebSocket ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS headers for health checks from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime: process.uptime(),
      sessions: sessions.size,
      connections: Array.from(sessions.values()).reduce((sum, s) => sum + s.size, 0),
      bufferedAnswers: answerBuffer.size(),
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SlideMath WebSocket Server v2.0 running');
});

const wss = new WebSocket.Server({ server, path: '/websocket' });

// Session → Set<WebSocket>
const sessions = new Map();
// "sessionId:participantId" → ws
const participantSockets = new Map();

// ── Broadcast helpers ──────────────────────────────────────────────────────
function broadcastEvent(sessionId, eventType, data) {
  const conns = sessions.get(sessionId);
  if (!conns || conns.size === 0) return;
  const msg = JSON.stringify({ sessionId, type: eventType, data, timestamp: Date.now() });
  conns.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function sendTo(ws, type, data, cid) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = { type, data, timestamp: Date.now() };
    if (cid) msg.cid = cid;
    ws.send(JSON.stringify(msg));
  }
}

// ── Session state query (lightweight) ──────────────────────────────────────
async function getSessionState(sessionId, full = false) {
  const pool = await getDb();
  const [rows] = await pool.query('SELECT * FROM sm_sessions WHERE id = ? LIMIT 1', [sessionId]);
  if (!rows.length) return null;
  const row = rows[0];

  const session = {
    id: row.id, code: row.code, testId: row.test_id, teacherId: row.teacher_id,
    name: row.name, active: !!row.active, started: !!row.started, paused: !!row.paused,
    allowReview: !!row.allow_review, nmtMode: !!row.nmt_mode,
    verificationCode: row.verification_code,
    verificationCodes: row.verification_codes ? JSON.parse(row.verification_codes) : null,
    activeBlockIndex: row.active_block_index || 0,
    themeColor: row.theme_color,
    createdAt: row.created_at, endedAt: row.ended_at,
    blocks: row.blocks_json ? JSON.parse(row.blocks_json) : null,
  };

  // Participants (always included)
  const [parts] = await pool.query(
    'SELECT * FROM sm_participants WHERE session_id = ? ORDER BY joined_at ASC',
    [sessionId]
  );
  session.participants = parts.map(p => ({
    id: p.id, userId: p.user_id, name: p.name, login: p.login, password: p.password,
    status: p.status, finished: !!p.finished, paused: !!p.paused,
    integrity: { disqualified: !!p.disqualified, tabSwitches: p.tab_switches || 0 },
    joinedAt: p.joined_at, lastActive: p.last_active, endedAt: p.ended_at,
    savedTimers: p.saved_timers ? JSON.parse(p.saved_timers) : null,
    savedTotalTimeLeft: p.saved_total_time_left,
    extraTimeSignal: p.extra_time_total || 0,
    extraTimeUnlockAll: !!p.extra_time_unlock_all,
    extraQuestionTime: p.extra_question_time ? JSON.parse(p.extra_question_time) : null,
    resumeToken: p.resume_token,
  }));

  // Answers (only for full mode) — merge MySQL + buffer
  if (full) {
    const [ans] = await pool.query(
      'SELECT * FROM sm_answers WHERE session_id = ?', [sessionId]
    );
    session.participants.forEach(p => {
      p.answers = {};
    });
    ans.forEach(a => {
      const p = session.participants.find(x => x.id === a.participant_id);
      if (p) {
        p.answers[a.question_id] = {
          value: a.value, submittedAt: a.submitted_at,
          manualScore: a.manual_score, graded: !!a.graded,
        };
      }
    });

    // Overlay buffered (newer) answers on top of MySQL data
    const buffered = answerBuffer.getForSession(sessionId);
    for (const entry of buffered) {
      const p = session.participants.find(x => x.id === entry.participantId);
      if (p) {
        p.answers[entry.questionId] = {
          value: entry.value,
          submittedAt: entry.submittedAt,
          manualScore: null,
          graded: false,
        };
      }
    }
  }

  return session;
}

// ── WS message handlers ────────────────────────────────────────────────────
const handlers = {

  async submitAnswer(ws, msg) {
    const { sessionId, participantId, questionId, value, testId, cid } = msg;
    const pool = await getDb();

    // Eligibility check (still reads MySQL — fast SELECT, not a write)
    const [parts] = await pool.query(
      'SELECT finished, paused, disqualified FROM sm_participants WHERE id = ? AND session_id = ?',
      [participantId, sessionId]
    );
    if (!parts.length || parts[0].finished || parts[0].paused || parts[0].disqualified) {
      sendTo(ws, 'answer.rejected', { ok: false, reason: 'participant_not_eligible' }, cid);
      return;
    }

    // Buffer the answer (0 MySQL writes)
    answerBuffer.add(sessionId, participantId, questionId, value, testId);

    sendTo(ws, 'answer.saved', { ok: true, questionId }, cid);
    broadcastEvent(sessionId, 'answer.submitted', { participantId, questionId });
  },

  async pollState(ws, msg) {
    const { sessionId, full, cid } = msg;
    const session = await getSessionState(sessionId, !!full);
    if (!session) {
      sendTo(ws, 'stateUpdate', { ok: false, error: 'session_not_found' }, cid);
      return;
    }
    sendTo(ws, 'stateUpdate', { ok: true, session }, cid);
  },

  async patchParticipant(ws, msg) {
    const { sessionId, participantId, fields, cid } = msg;
    const pool = await getDb();
    const sets = [];
    const vals = [];

    const colMap = {
      status: 'status', finished: 'finished', paused: 'paused',
      lastActive: 'last_active', joinedAt: 'joined_at', endedAt: 'ended_at',
      savedTotalTimeLeft: 'saved_total_time_left', resumeToken: 'resume_token',
    };

    for (const [key, val] of Object.entries(fields || {})) {
      if (key === 'integrity') {
        if (val.disqualified !== undefined) { sets.push('disqualified = ?'); vals.push(val.disqualified ? 1 : 0); }
        if (val.tabSwitches !== undefined) { sets.push('tab_switches = ?'); vals.push(val.tabSwitches); }
        continue;
      }
      if (key === 'savedTimers') { sets.push('saved_timers = ?'); vals.push(JSON.stringify(val)); continue; }
      if (key === 'extraTimeSignal') { sets.push('extra_time_total = ?'); vals.push(val); continue; }
      if (key === 'extraTimeUnlockAll') { sets.push('extra_time_unlock_all = ?'); vals.push(val ? 1 : 0); continue; }
      if (key === 'extraQuestionTime') { sets.push('extra_question_time = ?'); vals.push(JSON.stringify(val)); continue; }
      const col = colMap[key];
      if (col) {
        sets.push(`\`${col}\` = ?`);
        if (typeof val === 'boolean') vals.push(val ? 1 : 0);
        else vals.push(val);
      }
    }

    if (sets.length === 0) {
      sendTo(ws, 'participant.patched', { ok: false, error: 'no_fields' }, cid);
      return;
    }

    vals.push(participantId);
    await pool.query(`UPDATE sm_participants SET ${sets.join(', ')} WHERE id = ?`, vals);

    sendTo(ws, 'participant.patched', { ok: true, participantId }, cid);

    if (fields.finished || fields.paused !== undefined || fields.integrity) {
      broadcastEvent(sessionId, 'participant.updated', { participantId, fields });
    }
  },

  async patchSession(ws, msg) {
    const { sessionId, fields, cid } = msg;
    const pool = await getDb();
    const sets = [];
    const vals = [];

    const colMap = {
      started: 'started', paused: 'paused', active: 'active',
      allowReview: 'allow_review', name: 'name',
      activeBlockIndex: 'active_block_index',
      verificationCode: 'verification_code',
      endedAt: 'ended_at',
    };

    for (const [key, val] of Object.entries(fields || {})) {
      if (key === 'verificationCodes') { sets.push('verification_codes = ?'); vals.push(JSON.stringify(val)); continue; }
      const col = colMap[key];
      if (col) {
        sets.push(`\`${col}\` = ?`);
        if (typeof val === 'boolean') vals.push(val ? 1 : 0);
        else vals.push(val);
      }
    }

    if (sets.length === 0) {
      sendTo(ws, 'session.patched', { ok: false, error: 'no_fields' }, cid);
      return;
    }

    vals.push(sessionId);
    await pool.query(`UPDATE sm_sessions SET ${sets.join(', ')} WHERE id = ?`, vals);

    sendTo(ws, 'session.patched', { ok: true, sessionId }, cid);
    broadcastEvent(sessionId, 'session.updated', fields);
  },

  async addExtraTime(ws, msg) {
    const { sessionId, participantId, minutes, unlockAll, cid } = msg;
    const pool = await getDb();
    const totalMinutes = minutes * 60;
    await pool.query(
      'UPDATE sm_participants SET extra_time_total = extra_time_total + ?, extra_time_unlock_all = ? WHERE id = ?',
      [totalMinutes, unlockAll ? 1 : 0, participantId]
    );
    sendTo(ws, 'extraTimeAdded', { ok: true, participantId, minutes }, cid);
    broadcastEvent(sessionId, 'extraTimeSignal', { participantId, extraTimeTotal: totalMinutes, unlockAll });
  },

  async pauseParticipant(ws, msg) {
    const { sessionId, participantId, cid } = msg;
    const pool = await getDb();
    await pool.query('UPDATE sm_participants SET paused = 1 WHERE id = ?', [participantId]);
    sendTo(ws, 'participant.patched', { ok: true, participantId }, cid);
    broadcastEvent(sessionId, 'participant.updated', { participantId, fields: { paused: true } });
  },

  async resumeParticipant(ws, msg) {
    const { sessionId, participantId, resumeToken, cid } = msg;
    const pool = await getDb();
    await pool.query(
      'UPDATE sm_participants SET paused = 0, finished = 0, resume_token = ? WHERE id = ?',
      [resumeToken || null, participantId]
    );
    sendTo(ws, 'participant.patched', { ok: true, participantId }, cid);
    broadcastEvent(sessionId, 'participant.updated', { participantId, fields: { paused: false } });
  },

  async recordTabSwitch(ws, msg) {
    const { sessionId, participantId, cid } = msg;
    const pool = await getDb();

    const [rows] = await pool.query('SELECT tab_switches, disqualified FROM sm_participants WHERE id = ?', [participantId]);
    if (!rows.length) return;
    const p = rows[0];

    const newCount = (p.tab_switches || 0) + 1;
    const disqualified = newCount > 2;

    await pool.query(
      'UPDATE sm_participants SET tab_switches = ?, disqualified = ?, finished = ? WHERE id = ?',
      [newCount, disqualified ? 1 : 0, disqualified ? 1 : 0, participantId]
    );

    sendTo(ws, 'tabSwitchRecorded', {
      ok: true, participantId, tabSwitches: newCount, disqualified,
    }, cid);
    broadcastEvent(sessionId, 'integrity.violation', {
      participantId, tabSwitches: newCount, disqualified,
    });
  },

  async markFinished(ws, msg) {
    const { sessionId, participantId, cid } = msg;
    const pool = await getDb();
    await pool.query(
      'UPDATE sm_participants SET finished = 1, paused = 0 WHERE id = ?',
      [participantId]
    );
    sendTo(ws, 'participant.patched', { ok: true, participantId }, cid);
    broadcastEvent(sessionId, 'participant.updated', { participantId, fields: { finished: true } });
  },

  async endSession(ws, msg) {
    const { sessionId, cid } = msg;
    // Flush all buffered answers before ending session
    await answerBuffer.flush();
    const pool = await getDb();
    await pool.query('UPDATE sm_sessions SET active = 0, ended_at = ? WHERE id = ?', [Date.now(), sessionId]);
    sendTo(ws, 'session.patched', { ok: true, sessionId }, cid);
    broadcastEvent(sessionId, 'session.ended', { endedAt: Date.now() });
  },

  async   subscribe(ws, msg) {
    const { sessionId, participantId, participantName, role, cid } = msg;
    ws._sessionId = sessionId;
    ws._participantId = participantId;
    ws._role = role || (participantId ? 'student' : 'unknown');
    console.log(`[WS] Subscribe: ${ws._role} ${participantId || ''} → ${sessionId}`);
    if (participantId) {
      participantSockets.set(`${sessionId}:${participantId}`, ws);
      broadcastEvent(sessionId, 'participant.joined', { participantId, participantName });
    }
    sendTo(ws, 'subscribed', { sessionId, participantId, role: ws._role }, cid);
  },

  heartbeat(ws, msg) {
    sendTo(ws, 'pong', {}, msg.cid);
  },

  registerParticipant(ws, msg) {
    ws._participantId = msg.participantId;
    if (ws._sessionId && msg.participantId) {
      participantSockets.set(`${ws._sessionId}:${msg.participantId}`, ws);
    }
  },
};

// ── Connection handling (shared for both /websocket and /teacher-ws) ────────
function handleConnection(ws, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('id');

  if (!sessionId) { ws.close(4000, 'Session ID required'); return; }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  console.log(`[WS] Client connected: ${sessionId} (awaiting subscribe)`);

  if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
  sessions.get(sessionId).add(ws);
  ws._sessionId = sessionId;

  sendTo(ws, 'connected', { sessionId });

  ws.on('message', async (raw) => {
    let cid;
    try {
      const msg = JSON.parse(raw.toString());
      cid = msg.cid;
      const handler = handlers[msg.type];
      if (handler) {
        await handler(ws, msg);
      } else {
        console.log(`[WS] Unknown type: ${msg.type}`);
      }
    } catch (e) {
      console.error(`[WS] Error:`, e.message);
      sendTo(ws, 'error', { message: e.message }, cid);
    }
  });

  ws.on('close', () => {
    sessions.get(sessionId)?.delete(ws);
    if (ws._participantId) {
      answerBuffer.flushParticipant(ws._participantId);
      const key = `${sessionId}:${ws._participantId}`;
      if (participantSockets.get(key) === ws) {
        participantSockets.delete(key);
      }
    }
    if (sessions.get(sessionId)?.size === 0) sessions.delete(sessionId);
  });

  ws.on('error', (e) => console.error(`[WS] Error ${sessionId}:`, e.message));
}

wss.on('connection', handleConnection);

// ── Stats + Server-side ping (keeps Render proxy alive) ──────────────────────
const HEARTBEAT_INTERVAL = 30000;
setInterval(() => {
  let total = 0, active = 0;
  sessions.forEach((c, id) => { total += c.size; if (c.size > 0) active++; });
  const buffered = answerBuffer.size();
  console.log(`[WS] ${active} sessions, ${total} connections, ${buffered} buffered answers`);
}, 60000);

// Server-initiated pings to prevent Render proxy from killing idle connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[WS] Terminating stale connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// ── Start ──────────────────────────────────────────────────────────────────
async function start() {
  await getDb();
  answerBuffer.startPeriodicFlush();
  server.listen(PORT, () => {
    console.log(`[WS] Server running on port ${PORT}`);
    console.log(`[WS] WebSocket path: /websocket`);
    console.log(`[WS] Health check: http://localhost:${PORT}/health`);
  });
}

start().catch(e => {
  console.error('[WS] Failed to start:', e.message);
  process.exit(1);
});

const gracefulShutdown = async (signal) => {
  console.log(`[WS] ${signal} received, shutting down...`);
  answerBuffer.stopPeriodicFlush();
  await answerBuffer.flushAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000); // force exit after 5s
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { broadcastEvent };
