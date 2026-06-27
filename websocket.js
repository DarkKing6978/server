/**
 * SlideMath WebSocket Server v3.0
 * Real-time сервер з HTTP API та прямим з'єднанням з PHP-бекендом.
 * Не потребує прямого доступу до MySQL — всі DB-операції через PHP API.
 */
require('dotenv').config({ __dirname: require('path').join(__dirname, '.env') });

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || process.env.WS_PORT || 8080;
const API_BASE_URL = process.env.API_BASE_URL || '';
const SERVER_API_KEY = process.env.SERVER_API_KEY || '';

// ── HTTP API helper ──────────────────────────────────────────────────────────
async function apiCall(endpoint, method = 'GET', body = null, retries = 2) {
  if (!API_BASE_URL) throw new Error('API_BASE_URL not configured');
  const url = `${API_BASE_URL.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (SERVER_API_KEY) opts.headers['X-SM-Server-Key'] = SERVER_API_KEY;
  if (body) opts.body = JSON.stringify(body);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      // Handle anti-hotlink HTML responses
      if (text.trim().startsWith('<!')) {
        if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
        throw new Error('Got HTML instead of JSON (anti-hotlink)');
      }
      const json = JSON.parse(text);
      return json;
    } catch (e) {
      if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Answer Buffer ──────────────────────────────────────────────────────────
// Buffers student answers in memory, flushes to PHP API in batch.
// Key = "participantId:questionId" → stores only the LATEST value per question.
// Flush triggers: periodic (15s), on disconnect, on shutdown, on endSession.

const FLUSH_INTERVAL_MS = 15_000;

class AnswerBuffer {
  constructor() {
    this.buffer = new Map();
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

  size() { return this.buffer.size; }

  async flush() {
    if (this.buffer.size === 0 || this.flushing) return;
    this.flushing = true;
    const entries = Array.from(this.buffer.values());
    this.buffer.clear();

    try {
      // Send each answer to PHP API individually
      const results = await Promise.allSettled(
        entries.map(e => apiCall('answers.php', 'POST', {
          participantId: e.participantId,
          questionId: e.questionId,
          sessionId: e.sessionId,
          testId: e.testId,
          value: e.value,
        }))
      );
      const ok = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
      const fail = results.filter(r => r.status === 'rejected' || !r.value?.ok).length;
      console.log(`[Buffer] Flushed ${ok}/${entries.length} answers to API` + (fail ? ` (${fail} failed)` : ''));
    } catch (e) {
      console.error('[Buffer] Flush failed:', e.message);
      for (const entry of entries) {
        const key = `${entry.participantId}:${entry.questionId}`;
        if (!this.buffer.has(key)) this.buffer.set(key, entry);
      }
    } finally {
      this.flushing = false;
    }
  }

  async flushParticipant(participantId) {
    const pid = String(participantId);
    const entries = [];
    const remaining = new Map();

    for (const [key, entry] of this.buffer) {
      if (entry.participantId === pid) entries.push(entry);
      else remaining.set(key, entry);
    }

    if (entries.length === 0) return;
    this.buffer = remaining;

    try {
      const results = await Promise.allSettled(
        entries.map(e => apiCall('answers.php', 'POST', {
          participantId: e.participantId,
          questionId: e.questionId,
          sessionId: e.sessionId,
          testId: e.testId,
          value: e.value,
        }))
      );
      const ok = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
      console.log(`[Buffer] Flushed ${ok}/${entries.length} answers for participant ${pid}`);
    } catch (e) {
      console.error(`[Buffer] Flush participant ${pid} failed:`, e.message);
      for (const entry of entries) {
        const key = `${entry.participantId}:${entry.questionId}`;
        if (!this.buffer.has(key)) this.buffer.set(key, entry);
      }
    }
  }

  async flushAll() {
    if (this.buffer.size === 0) return;
    console.log(`[Buffer] Flushing all ${this.buffer.size} answers before shutdown...`);
    await this.flush();
  }

  startPeriodicFlush() {
    this._flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    console.log(`[Buffer] Periodic flush every ${FLUSH_INTERVAL_MS / 1000}s`);
  }

  stopPeriodicFlush() {
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
  }
}

const answerBuffer = new AnswerBuffer();

// ── HTTP server + WebSocket ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, version: '3.0-http-api',
      uptime: process.uptime(),
      sessions: sessions.size,
      connections: Array.from(sessions.values()).reduce((sum, s) => sum + s.size, 0),
      bufferedAnswers: answerBuffer.size(),
      apiBase: API_BASE_URL ? '(configured)' : '(not set)',
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SlideMath WebSocket Server v3.0 (HTTP API mode)');
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

// ── Session state query (via PHP API) ──────────────────────────────────────
async function getSessionState(sessionId, full = false) {
  try {
    if (full) {
      const res = await apiCall(`session-state.php?id=${encodeURIComponent(sessionId)}&full=1`);
      if (!res || !res.ok || !res.session) return null;
      const s = res.session;
      // Merge buffer overlay for answers
      if (s.participants) {
        const buffered = answerBuffer.getForSession(sessionId);
        for (const entry of buffered) {
          const p = s.participants.find(x => x.id === entry.participantId);
          if (p) {
            if (!p.answers) p.answers = {};
            p.answers[entry.questionId] = {
              value: entry.value,
              submittedAt: entry.submittedAt,
              manualScore: null,
              graded: false,
            };
          }
        }
      }
      return s;
    }

    // Light mode — session-state.php without full
    const res = await apiCall(`session-state.php?id=${encodeURIComponent(sessionId)}`);
    if (!res || !res.ok) return null;

    // session-state.php light mode returns flat fields, not nested session object
    // Build a session-compatible object
    return {
      id: res.id,
      code: res.code,
      active: res.active,
      paused: res.paused,
      started: res.started,
      allowReview: res.allowReview,
      nmtMode: res.nmtMode,
      verificationCode: res.verificationCode,
      verificationCodes: res.verificationCodes,
      activeBlockIndex: res.activeBlockIndex,
      endedAt: res.endedAt,
      participants: (res.participants || []).map(p => ({
        id: p.id,
        name: p.name,
        paused: p.paused,
        finished: p.finished,
        disqualified: p.disqualified,
        extraTimeSignal: p.extraTimeSignal,
        extraQuestionTime: p.extraQuestionTime,
        savedTotalTimeLeft: p.savedTotalTimeLeft,
      })),
    };
  } catch (e) {
    console.error(`[WS] getSessionState error for ${sessionId}:`, e.message);
    return null;
  }
}

// ── WS message handlers ────────────────────────────────────────────────────
const handlers = {

  async submitAnswer(ws, msg) {
    const { sessionId, participantId, questionId, value, testId, cid } = msg;

    // Eligibility check via PHP API
    try {
      const check = await apiCall(`participant-check.php?participantId=${encodeURIComponent(participantId)}&sessionId=${encodeURIComponent(sessionId)}`);
      if (!check || !check.ok) {
        sendTo(ws, 'answer.rejected', { ok: false, reason: 'participant_not_found' }, cid);
        return;
      }
      if (!check.eligible) {
        sendTo(ws, 'answer.rejected', { ok: false, reason: 'participant_not_eligible' }, cid);
        return;
      }
    } catch (e) {
      console.error('[WS] Eligibility check failed:', e.message);
      // On network error, still buffer — PHP will validate during flush
    }

    // Buffer the answer (no immediate HTTP call)
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
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchParticipant',
        sessionId,
        participantId,
        fields: fields || {},
      });
      if (!res || !res.ok) {
        sendTo(ws, 'participant.patched', { ok: false, error: res?.error || 'patch_failed' }, cid);
        return;
      }
      sendTo(ws, 'participant.patched', { ok: true, participantId }, cid);
      if (fields?.finished || fields?.paused !== undefined || fields?.integrity) {
        broadcastEvent(sessionId, 'participant.updated', { participantId, fields });
      }
    } catch (e) {
      console.error('[WS] patchParticipant error:', e.message);
      sendTo(ws, 'participant.patched', { ok: false, error: e.message }, cid);
    }
  },

  async patchSession(ws, msg) {
    const { sessionId, fields, cid } = msg;
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchSession',
        sessionId,
        fields: fields || {},
      });
      if (!res || !res.ok) {
        sendTo(ws, 'session.patched', { ok: false, error: res?.error || 'patch_failed' }, cid);
        return;
      }
      sendTo(ws, 'session.patched', { ok: true, sessionId }, cid);
      broadcastEvent(sessionId, 'session.updated', fields);
    } catch (e) {
      console.error('[WS] patchSession error:', e.message);
      sendTo(ws, 'session.patched', { ok: false, error: e.message }, cid);
    }
  },

  async addExtraTime(ws, msg) {
    const { sessionId, participantId, minutes, unlockAll, cid } = msg;
    const totalMinutes = minutes * 60;
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchParticipant',
        sessionId,
        participantId,
        fields: {
          extraTimeSignal: { total: totalMinutes, unlockAll: !!unlockAll },
        },
      });
      if (!res || !res.ok) {
        sendTo(ws, 'extraTimeAdded', { ok: false, error: res?.error || 'failed' }, cid);
        return;
      }
      sendTo(ws, 'extraTimeAdded', { ok: true, participantId, minutes }, cid);
      broadcastEvent(sessionId, 'extraTimeSignal', { participantId, extraTimeTotal: totalMinutes, unlockAll });
    } catch (e) {
      console.error('[WS] addExtraTime error:', e.message);
      sendTo(ws, 'extraTimeAdded', { ok: false, error: e.message }, cid);
    }
  },

  async pauseParticipant(ws, msg) {
    const { sessionId, participantId, cid } = msg;
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchParticipant',
        sessionId,
        participantId,
        fields: { paused: true },
      });
      if (!res || !res.ok) {
        sendTo(ws, 'participant.patched', { ok: false, error: res?.error || 'failed' }, cid);
        return;
      }
      sendTo(ws, 'participant.patched', { ok: true, participantId }, cid);
      broadcastEvent(sessionId, 'participant.updated', { participantId, fields: { paused: true } });
    } catch (e) {
      console.error('[WS] pauseParticipant error:', e.message);
      sendTo(ws, 'participant.patched', { ok: false, error: e.message }, cid);
    }
  },

  async resumeParticipant(ws, msg) {
    const { sessionId, participantId, resumeToken, cid } = msg;
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchParticipant',
        sessionId,
        participantId,
        fields: { paused: false, finished: false, resumeToken: resumeToken || null },
      });
      if (!res || !res.ok) {
        sendTo(ws, 'participant.patched', { ok: false, error: res?.error || 'failed' }, cid);
        return;
      }
      sendTo(ws, 'participant.patched', { ok: true, participantId }, cid);
      broadcastEvent(sessionId, 'participant.updated', { participantId, fields: { paused: false } });
    } catch (e) {
      console.error('[WS] resumeParticipant error:', e.message);
      sendTo(ws, 'participant.patched', { ok: false, error: e.message }, cid);
    }
  },

  async recordTabSwitch(ws, msg) {
    const { sessionId, participantId, cid } = msg;
    try {
      // Read current state via participant-check (lightweight)
      const check = await apiCall(`participant-check.php?participantId=${encodeURIComponent(participantId)}`);
      if (!check || !check.ok) {
        sendTo(ws, 'tabSwitchRecorded', { ok: false, error: 'participant_not_found' }, cid);
        return;
      }

      // Read tab_switches count — need a dedicated field from participant-check
      // Since participant-check doesn't return tabSwitches, we use a workaround:
      // increment via patchParticipant with a special field
      // Actually, let's add tab_switches to the participant-check endpoint response
      // For now, read full participant via session-state
      // Simplest: send a patch with incremented count. PHP will handle it.

      // We need the current tab_switches count. Use session-state light to get it.
      // But session-state light doesn't include tabSwitches. Let me add it.
      // For now: read from participant-check and extend it.

      // Actually, the cleanest approach: just use patchParticipant with integrity
      // and let PHP handle the increment. But PHP's rel_patch_participant does SET, not +=.

      // So we need: read current count → increment → write.
      // The participant-check endpoint needs to return tab_switches.
      // Let me add that to participant-check.php
      const tabSwitches = check.tabSwitches || 0;
      const newCount = tabSwitches + 1;
      const disqualified = newCount > 2;

      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchParticipant',
        sessionId,
        participantId,
        fields: {
          integrity: { tabSwitches: newCount, disqualified },
          ...(disqualified ? { finished: true } : {}),
        },
      });

      sendTo(ws, 'tabSwitchRecorded', {
        ok: true, participantId, tabSwitches: newCount, disqualified,
      }, cid);
      broadcastEvent(sessionId, 'integrity.violation', {
        participantId, tabSwitches: newCount, disqualified,
      });
    } catch (e) {
      console.error('[WS] recordTabSwitch error:', e.message);
      sendTo(ws, 'tabSwitchRecorded', { ok: false, error: e.message }, cid);
    }
  },

  async markFinished(ws, msg) {
    const { sessionId, participantId, cid } = msg;
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchParticipant',
        sessionId,
        participantId,
        fields: { finished: true, paused: false },
      });
      if (!res || !res.ok) {
        sendTo(ws, 'participant.patched', { ok: false, error: res?.error || 'failed' }, cid);
        return;
      }
      sendTo(ws, 'participant.patched', { ok: true, participantId }, cid);
      broadcastEvent(sessionId, 'participant.updated', { participantId, fields: { finished: true } });
    } catch (e) {
      console.error('[WS] markFinished error:', e.message);
      sendTo(ws, 'participant.patched', { ok: false, error: e.message }, cid);
    }
  },

  async endSession(ws, msg) {
    const { sessionId, cid } = msg;
    await answerBuffer.flush();
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'endSession',
        sessionId,
        results: [],
      });
      if (!res || !res.ok) {
        sendTo(ws, 'session.patched', { ok: false, error: res?.error || 'failed' }, cid);
        return;
      }
      sendTo(ws, 'session.patched', { ok: true, sessionId }, cid);
      broadcastEvent(sessionId, 'session.ended', { endedAt: Date.now() });
    } catch (e) {
      console.error('[WS] endSession error:', e.message);
      sendTo(ws, 'session.patched', { ok: false, error: e.message }, cid);
    }
  },

  async subscribe(ws, msg) {
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

// ── Connection handling ────────────────────────────────────────────────────
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

// ── Stats + Server-side ping ──────────────────────────────────────────────
const HEARTBEAT_INTERVAL = 30000;
setInterval(() => {
  let total = 0, active = 0;
  sessions.forEach((c, id) => { total += c.size; if (c.size > 0) active++; });
  const buffered = answerBuffer.size();
  console.log(`[WS] ${active} sessions, ${total} connections, ${buffered} buffered answers`);
}, 60000);

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
  if (!API_BASE_URL) {
    console.warn('[WS] WARNING: API_BASE_URL not set. DB operations will fail.');
  } else {
    console.log('[WS] API Base URL:', API_BASE_URL);
  }
  answerBuffer.startPeriodicFlush();
  server.listen(PORT, () => {
    console.log(`[WS] Server v3.0 (HTTP API) running on port ${PORT}`);
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
  setTimeout(() => process.exit(1), 5000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { broadcastEvent };
