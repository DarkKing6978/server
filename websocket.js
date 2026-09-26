/**
 * SlideMath WebSocket Server v3.0
 * Real-time сервер з HTTP API та прямим з'єднанням з PHP-бекендом.
 * Не потребує прямого доступу до MySQL — всі DB-операції через PHP API.
 */
require('dotenv').config({ __dirname: require('path').join(__dirname, '.env') });

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || process.env.WS_PORT || 8080;
const API_BASE_URL = process.env.API_BASE_URL || '';
const SERVER_API_KEY = process.env.SERVER_API_KEY || '';

// ── HTTP API helper ──────────────────────────────────────────────────────────
// Cookie jar for anti-hotlink protection (InfinityFree returns HTML on first request)
const _cookieJar = new Map(); // name → value

function _solveAntiHotlink(html) {
  const m = html.match(/var a=toNumbers\("([0-9a-f]+)"\),b=toNumbers\("([0-9a-f]+)"\),c=toNumbers\("([0-9a-f]+)"\)/);
  if (!m) return null;
  try {
    const key = Buffer.from(m[1], 'hex');
    const iv = Buffer.from(m[2], 'hex');
    const ciphertext = Buffer.from(m[3], 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('hex');
  } catch (e) {
    console.error('[API] AES decrypt error:', e.message);
    return null;
  }
}

function _extractCookie(response) {
  const headers = response.headers;
  const setCookie = headers.getSetCookie?.() || [];
  for (const raw of setCookie) {
    const parts = raw.split(';')[0].trim();
    const eqIdx = parts.indexOf('=');
    if (eqIdx > 0) {
      _cookieJar.set(parts.substring(0, eqIdx).trim(), parts.substring(eqIdx + 1).trim());
    }
  }
}

function _getCookieHeader() {
  if (_cookieJar.size === 0) return undefined;
  return Array.from(_cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function apiCall(endpoint, method = 'GET', body = null, retries = 3) {
  if (!API_BASE_URL) throw new Error('API_BASE_URL not configured');
  const baseUrl = API_BASE_URL.replace(/\/+$/, '');
  const url = `${baseUrl}/${endpoint.replace(/^\/+/, '')}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (SERVER_API_KEY) opts.headers['X-SM-Server-Key'] = SERVER_API_KEY;
      const cookie = _getCookieHeader();
      if (cookie) opts.headers['Cookie'] = cookie;
      if (body) opts.body = JSON.stringify(body);

      const res = await fetch(url, opts);

      // Store any Set-Cookie headers
      _extractCookie(res);

      const text = await res.text();

      // Check if response is HTML (anti-hotlink or error page)
      if (text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
        // Try AES decrypt for InfinityFree anti-hotlink
        const cookieValue = _solveAntiHotlink(text);
        if (cookieValue) {
          _cookieJar.set('__test', cookieValue);
          console.log(`[API] Solved anti-hotlink cookie: __test=${cookieValue.substring(0, 8)}...`);
        }
        if (attempt < retries) {
          console.log(`[API] Got HTML from ${endpoint} (attempt ${attempt + 1}/${retries + 1}), retrying...`);
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new Error(`Got HTML instead of JSON from ${endpoint}`);
      }

      const json = JSON.parse(text);
      return json;
    } catch (e) {
      if (attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── AI (Gemini) proxy ───────────────────────────────────────────────────────
// Ключ зберігається ЛИШЕ в env сервісу (Render), у клієнт і PHP не потрапляє.
// Браузер → POST /ai (X-SM-Auth/X-SM-User) → перевірка ролі через PHP me.php
// → Gemini generateContent → JSON у відповідь.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const GEMINI_MAX_OUTPUT_TOKENS = parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 16384;
const GEMINI_THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || '').toLowerCase();

// Повні AI-логи: AI_DEBUG=1|true|yes|on у середовищі Render (Env → AI Debug).
// Увімкнення друкує промпти, схеми, сирі відповіді, таймінги та параметри запитів.
const AI_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.AI_DEBUG || '').trim());
function aiDebug(...args) {
  if (AI_DEBUG) console.log('[AI:debug]', ...args);
}
if (AI_DEBUG) console.log('[AI] verbose logging enabled (AI_DEBUG=1)');

const AI_BODY_LIMIT = 300 * 1024;
const AI_TIMEOUT_MS = 60000;                 // таймаут ОДНІЄЇ спроби
const AI_DEADLINE_MS = 140000;               // дедлайн на весь запит (генерація)
const AI_DEADLINE_GRADE_MS = 80000;          // grade_answer (клієнт чекає 90с)
const AI_RETRY_DELAYS_MS = [1000, 3000, 7000];
const AI_RATE_WINDOW_MS = 60 * 60 * 1000;
const AI_RATE_MAX = parseInt(process.env.AI_RATE_MAX, 10) || 30;
// Вчитель з власним ключем (BYOK) сплачує квоту сам → вищий ліміт.
const AI_RATE_MAX_OWN = parseInt(process.env.AI_RATE_MAX_OWN, 10) || 300;
const AI_MAX_QUESTIONS = 40;
const AI_MAX_SLIDES = 30;
const AI_MAX_TEXT = 6000;
// Коригувальний повтор: якщо жодне питання не пройшло фільтр — один повтор із
// фідбеком (сиря відповідь + причини відсіву). Вимикається: AI_CORRECTIVE_RETRY=0.
const AI_CORRECTIVE_RETRY = !/^(0|false|no|off)$/i.test(String(process.env.AI_CORRECTIVE_RETRY || '').trim());
// Мінімальний залишок дедлайну, щоб взятися за коригувальний повтор.
const AI_CORRECTIVE_MIN_MS = 20000;

const AI_ACTIONS = new Set([
  'generate_questions',   // лише питання (в редактор тесту)
  'generate_full_test',   // повний тест (з налаштуваннями)
  'generate_explanations',// пояснення до питань
  'generate_slides',      // слайди для редактора уроку
  'grade_answer',         // перевірка відкритої відповіді (пропозиція)
]);

const _aiRate = new Map();  // userId → { count, resetAt }
const _meCache = new Map(); // sha256(user:token) → { user, exp }

const AI_SYSTEM_INSTRUCTION =
  'Ти — асистент учителя математики для української освітньої платформи SlideMath. ' +
  'Відповідай ЛИШЕ валідним JSON — без markdown-обгородження, без пояснень до або після JSON. ' +
  'Уся мова контенту — українська (якщо прямо не вказано інше). ' +
  'Математичні формули записуй у LaTeX: \\( ... \\) усередині рядка, \\[ ... \\] для блоків. ' +
  'Не додавай персональні дані, імена чи оцінки реальних людей.';

// ── AI: читання тіла запиту ─────────────────────────────────────────────────
function aiReadBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => { if (!done) { done = true; resolve(data); } });
    req.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}

// ── AI: rate limit (in-memory, на користувача) ──────────────────────────────
// limit визначає джерело ключа: власний ключ (BYOK) → AI_RATE_MAX_OWN,
// платформний → AI_RATE_MAX. Ліміт у записі оновлюється при кожному виклику,
// щоб зміна ключа вчителям підхоплювалась одразу.
function aiRateCheck(userId, limit) {
  const max = Number.isFinite(limit) && limit > 0 ? limit : AI_RATE_MAX;
  const now = Date.now();
  const rec = _aiRate.get(userId);
  if (!rec || rec.resetAt <= now) {
    _aiRate.set(userId, { count: 1, resetAt: now + AI_RATE_WINDOW_MS, max });
    if (_aiRate.size > 2000) {
      for (const [k, v] of _aiRate) { if (v.resetAt <= now) _aiRate.delete(k); }
    }
    return { ok: true };
  }
  rec.max = max;
  if (rec.count >= max) return { ok: false, resetAt: rec.resetAt };
  rec.count += 1;
  return { ok: true };
}

// ── AI: перевірка користувача через PHP API (me.php) ────────────────────────
async function aiFetchJson(url, opts, retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      _extractCookie(res);
      const text = await res.text();
      if (text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
        const cookieValue = _solveAntiHotlink(text);
        if (cookieValue) _cookieJar.set('__test', cookieValue);
        lastErr = new Error('HTML instead of JSON (anti-hotlink)');
        if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
        throw lastErr;
      }
      return { status: res.status, json: JSON.parse(text) };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('request failed');
}

async function aiResolveUser(req) {
  const token = req.headers['x-sm-auth'];
  const userId = req.headers['x-sm-user'];
  if (!token || !userId) return null;

  // X-SM-Key-Rev — клієнтська ревізія ключа (оновлюється після збереження
  // власного ключа вчителем): дозволяє одразу скинути кеш me.php, не чекаючи 60с.
  const keyRev = String(req.headers['x-sm-key-rev'] || '');
  const cacheKey = crypto.createHash('sha256').update(`${userId}:${token}:${keyRev}`).digest('hex');
  const hit = _meCache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.user;
  if (_meCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of _meCache) { if (v.exp <= now) _meCache.delete(k); }
  }

  if (!API_BASE_URL) throw new Error('API_BASE_URL not configured');
  const url = `${API_BASE_URL.replace(/\/+$/, '')}/me.php`;
  const opts = {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'X-SM-Auth': String(token), 'X-SM-User': String(userId) },
  };
  const cookie = _getCookieHeader();
  if (cookie) opts.headers['Cookie'] = cookie;

  const { status, json } = await aiFetchJson(url, opts);
  if (status !== 200 || !json || !json.ok || !json.user) return null;
  const user = {
    id: String(json.user.id || userId),
    role: json.user.role || 'student',
    status: json.user.status || '',
    // Власний Gemini-ключ вчителя (BYOK), якщо заданий; '' → ключ платформи.
    aiApiKey: typeof json.user.aiApiKey === 'string' ? json.user.aiApiKey.trim() : '',
  };
  _meCache.set(cacheKey, { user, exp: Date.now() + 60000 });
  return user;
}

// ── AI: виклик Gemini ───────────────────────────────────────────────────────
function aiSchema(schema) {
  // responseSchema бо responseJsonSchema: надсилаємо класичний responseSchema.
  return schema;
}

function aiRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function aiTransientNetworkError(e) {
  if (!e) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const code = e.code || (e.cause && e.cause.code) || '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
}

function aiOverloadMessage(msg) {
  if (!msg) return false;
  const m = String(msg).toLowerCase();
  return m.includes('high demand') || m.includes('try again later') || m.includes('overloaded')
    || m.includes('resource_exhausted') || m.includes('unavailable') || m.includes('service unavailable');
}

// Дружні повідомлення для «постійних» помилок доступу: невалідний ключ,
// немає прав на модель, модель не існує. Текст Google додається наприкінці,
// щоб нічого не втратити. Повертає null, якщо це не випадок доступу.
function aiAccessError(status, gcode, rawMsg, model) {
  const g = String(gcode || '').toUpperCase();
  const raw = String(rawMsg || '');
  const low = raw.toLowerCase();

  const invalidKey =
    status === 401 ||
    g === 'UNAUTHENTICATED' ||
    g === 'API_KEY_INVALID' ||
    low.includes('api key not valid') ||
    low.includes('api_key_invalid') ||
    low.includes('api key not valid.');

  if (invalidKey) {
    return `Ключ Gemini невалідний або відкликаний: перевірте ключ. Google: ${raw}`;
  }

  const badModel =
    status === 404 ||
    g === 'NOT_FOUND' ||
    g === 'MODEL_NOT_FOUND' ||
    (low.includes('model') && (low.includes('not found') || low.includes('unknown model')));

  if (badModel) {
    return `AI-модель "${model}" недоступна або не існує: перевірте змінну GEMINI_MODEL у Render. Google: ${raw}`;
  }

  const noAccess = status === 403 || g === 'PERMISSION_DENIED' || g === 'FORBIDDEN';
  if (noAccess) {
    return `Немає доступу до AI-моделі для цього ключа (модель недозволена або API Generative Language вимкнено): перевірте права ключа. Google: ${raw}`;
  }

  return null;
}

// Один виклик Gemini. Кидає помилку з .status / .retryable / .code.
// opts.apiKey — ключ конкретного запиту (власний ключ вчителя або платформенний).
async function aiGenerateOnce({ systemInstruction, userMessage, schema }, { action, deadlineAt, apiKey }) {
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: aiSchema(schema),
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
  };
  if (GEMINI_THINKING_LEVEL === 'low' || GEMINI_THINKING_LEVEL === 'medium' || GEMINI_THINKING_LEVEL === 'high') {
    generationConfig.thinkingLevel = GEMINI_THINKING_LEVEL.toUpperCase();
  }

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig,
  };

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const key = String(apiKey || '').trim() || GEMINI_API_KEY;
  const remaining = deadlineAt ? deadlineAt - Date.now() : AI_TIMEOUT_MS;
  const timeoutMs = Math.max(5000, Math.min(AI_TIMEOUT_MS, remaining));
  const started = Date.now();

  aiDebug('POST', {
    model: GEMINI_MODEL,
    url,
    timeoutMs,
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    thinking: generationConfig.thinkingLevel || 'default',
    systemLen: systemInstruction.length,
    userLen: userMessage.length,
  });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(`Gemini API: ${e.name === 'TimeoutError' ? 'таймаут запиту' : (e.message || 'мережева помилка')}`);
    err.status = 0;
    err.code = 502;
    err.retryable = true;
    err.nativeName = e.name;
    err.nativeCode = e.code || (e.cause && e.cause.code) || '';
    console.log(`[AI] ${action} network error in ${Date.now() - started}ms: ${err.nativeName || ''} ${err.nativeCode || ''} ${err.message}`);
    throw err;
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* не-JSON */ }

  const usage = (data && data.usageMetadata) || null;
  const candidate = (data && data.candidates && data.candidates[0]) || null;
  const finish = (candidate && candidate.finishReason) || '';
  const usageStr = usage
    ? `tokens=${usage.promptTokenCount || 0}/${usage.candidatesTokenCount || 0}${usage.thoughtsTokenCount ? ' thoughts=' + usage.thoughtsTokenCount : ''}`
    : 'tokens=-';

  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : `HTTP ${res.status}`;
    const gcode = (data && data.error && data.error.status) || '';
    const friendly = aiAccessError(res.status, gcode, msg, GEMINI_MODEL);
    const err = new Error(friendly || `Gemini API: ${msg}`);
    err.status = res.status;
    err.code = res.status === 429 ? 429 : 502;
    err.retryable = aiRetryableStatus(res.status);
    err.googleCode = gcode;
    if (friendly) {
      err.retryable = false;   // невалідний ключ / немає доступу / немає моделі — повтори безглузді
      err.accessIssue = true;
    }
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = Math.min(retryAfter, 30) * 1000;

    console.log(`[AI] ${action} http ${res.status}${gcode ? ' ' + gcode : ''} ${usageStr} ${Date.now() - started}ms: ${msg}`);
    if (friendly) aiDebug('access issue →', friendly);
    throw err;
  }

  const out = ((candidate && candidate.content && candidate.content.parts) || [])
    .map(p => (p && p.text) || '').join('');

  if (!out.trim()) {
    const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
    console.log(`[AI] ${action} empty output finish=${finish || '-'} blocked=${blocked || '-'} ${usageStr} ${Date.now() - started}ms`);
    const err = new Error(`Порожня відповідь AI${blocked ? ` (blocked: ${blocked})` : ''}${finish ? ` (finishReason: ${finish})` : ''}`);
    err.code = 502;
    err.retryable = false;
    throw err;
  }

  console.log(`[AI] ${action} ok finish=${finish || '-'} ${usageStr} out=${Buffer.byteLength(out, 'utf8')}B ${Date.now() - started}ms`);
  aiDebug('raw head', JSON.stringify(out.slice(0, 500)));
  aiDebug('raw tail', JSON.stringify(out.slice(-300)));
  return out;
}

// Ретраї транзієнтних помилок (429/5xx, мережа, таймаут) у межах дедлайну.
// opts.apiKey — ключ цього запиту (власний вчителя або платформенний).
async function aiGenerate(request, opts = {}) {
  const action = opts.action || 'generate';
  const deadlineMs = opts.deadlineMs || AI_DEADLINE_MS;
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey && !GEMINI_API_KEY) {
    throw Object.assign(
      new Error('AI ще не налаштовано: додайте свій Gemini-ключ у профілі (⚙️ Профіль → AI-ключ) або задайте GEMINI_API_KEY у сервісі Render.'),
      { code: 503 }
    );
  }

  const deadlineAt = Date.now() + deadlineMs;
  aiDebug('generate', { action, deadlineMs, key: apiKey ? 'set' : 'none' });
  let lastErr = null;
  let stoppedByDeadline = false;

  for (let attempt = 0; attempt <= AI_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const budget = deadlineAt - Date.now();
      const wait = Math.min(AI_RETRY_DELAYS_MS[attempt - 1] + Math.floor(Math.random() * 400), budget);
      if (wait <= 0) { stoppedByDeadline = true; break; }
      console.log(`[AI] retry ${attempt}/${AI_RETRY_DELAYS_MS.length} for ${action} in ${wait}ms after: ${lastErr ? lastErr.message : ''}`);
      await sleep(wait);
      if (Date.now() >= deadlineAt) { stoppedByDeadline = true; break; }
    }

    try {
      return await aiGenerateOnce(request, { action, deadlineAt, apiKey });
    } catch (e) {
      lastErr = e;
      const transient = (e && e.retryable) || aiRetryableStatus(e && e.status) || aiTransientNetworkError(e);
      if (!transient) break;
      if (Date.now() >= deadlineAt) { stoppedByDeadline = true; break; }
      if (attempt === AI_RETRY_DELAYS_MS.length) break;
    }
  }

  const err = lastErr || new Error('AI недоступний');
  const transient = (err && err.retryable) || aiRetryableStatus(err && err.status) || aiTransientNetworkError(err);
  const overloaded = aiRetryableStatus(err.status) && err.status !== 500 && err.status !== 502 && err.status !== 504
    || aiOverloadMessage(err.message);

  if (transient) {
    const msg = overloaded
      ? 'AI тимчасово перевантажено (пікове навантаження). Спробуйте за 1–2 хвилини.'
      : 'AI тривалий час не відповідає. Спробуйте ще раз за хвилину.';
    const out = Object.assign(new Error(msg), { code: 503, retryAfterSec: 15, cause: err.message });
    console.log(`[AI] ${action} giving up${stoppedByDeadline ? ' (deadline)' : ' (retries exhausted)'}: status=${err.status || 0} ${err.message}`);
    throw out;
  }

  throw err;
}

function aiParseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* not plain JSON */ }
  const fenced = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(fenced); } catch { /* ignore */ }
  const start = text.indexOf('{');
  const startArr = text.indexOf('[');
  const s = (start === -1 || (startArr !== -1 && startArr < start)) ? startArr : start;
  if (s === -1) return null;
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (end <= s) return null;
  try { return JSON.parse(text.slice(s, end + 1)); } catch { return null; }
}

// Відновлення з ОБРІЗАНОЇ відповіді (модель згенерувала дегенеративне число /
// упиралася в ліміт токенів): витягуємо лише ПОВНІ об'єкти питань із масиву
// "questions", решту (незавершену) відкидаємо.
function aiSalvageQuestions(text) {
  if (!text) return null;
  const m = /"questions"\s*:\s*\[/.exec(text);
  if (!m) return null;
  const grabStr = (key) => {
    const re = new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")');
    const mm = re.exec(text);
    if (mm) { try { return JSON.parse(mm[1]); } catch { /* ignore */ } }
    return '';
  };
  const items = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) { items.push(text.slice(start, i + 1)); start = -1; }
    } else if (depth === 0 && c === ']') break;
  }
  const questions = [];
  for (const s of items) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && !Array.isArray(o)) questions.push(o);
    } catch { /* неповний/зіпсований об'єкт — пропускаємо */ }
  }
  if (!questions.length) return null;
  return { title: grabStr('title'), subtitle: grabStr('subtitle'), questions };
}

function aiStr(v, max = AI_MAX_TEXT) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max).trim();
}

function aiInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function aiStrList(v, maxLen = 40, itemMax = 60) {
  if (!Array.isArray(v)) return [];
  return v.map(x => aiStr(x, itemMax)).filter(Boolean).slice(0, maxLen);
}

// ── AI: схеми відповідей ────────────────────────────────────────────────────
const AI_QUESTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['single', 'multiple', 'short', 'long', 'ordering', 'matching'] },
    prompt: { type: 'STRING' },
    points: { type: 'INTEGER', minimum: 1, maximum: 1000000 },
    options: { type: 'ARRAY', items: { type: 'STRING' } },
    correctIndexes: { type: 'ARRAY', items: { type: 'INTEGER' } },
    acceptedAnswers: { type: 'ARRAY', items: { type: 'STRING' } },
    items: { type: 'ARRAY', items: { type: 'STRING' } },
    correctOrder: { type: 'ARRAY', items: { type: 'INTEGER' } },
    pairs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { left: { type: 'STRING' }, right: { type: 'STRING' } },
        required: ['left', 'right'],
      },
    },
    modelAnswer: { type: 'STRING' },
    explanation: { type: 'STRING' },
  },
  required: ['type', 'prompt'],
};

const AI_TEST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    subtitle: { type: 'STRING' },
    topics: { type: 'ARRAY', items: { type: 'STRING' } },
    questions: { type: 'ARRAY', items: AI_QUESTION_SCHEMA },
  },
  required: ['title', 'questions'],
};

const AI_QUESTIONS_SCHEMA = {
  type: 'OBJECT',
  properties: { questions: { type: 'ARRAY', items: AI_QUESTION_SCHEMA } },
  required: ['questions'],
};

const AI_EXPLANATIONS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    explanations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          explanation: { type: 'STRING' },
          modelAnswer: { type: 'STRING' },
        },
        required: ['id', 'explanation'],
      },
    },
  },
  required: ['explanations'],
};

const AI_GRADE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'NUMBER' },
    comment: { type: 'STRING' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
  },
  required: ['score', 'comment'],
};

const AI_SLIDES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    slides: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' }, body: { type: 'STRING' } },
        required: ['title', 'body'],
      },
    },
  },
  required: ['title', 'slides'],
};

// ── AI: промпти ─────────────────────────────────────────────────────────────
function aiQuestionSpec({ withExplanations, withModelAnswers }) {
  let s =
    'Кожне питання — об\'єкт із полями:\n' +
    '- "type": "single" | "multiple" | "short" | "long" | "ordering" | "matching"\n' +
    '- "prompt": текст питання (LaTeX у \\( \\));\n' +
    '- "points": ціле число балів 1…1000 (зазвичай 1); ніколи не пиши довгі числа чи ланцюжки нулів;\n' +
    '- для "single"/"multiple": "options" — масив РІВНО 4 різних варіантів відповіді, ' +
    '"correctIndexes" — масив індексів правильної відповіді (single: рівно 1, multiple: 2-3);\n' +
    '- для "short": "acceptedAnswers" — масив із 1-3 прийнятних коротких відповідей;\n' +
    '- для "ordering": "items" — 3-5 елементів у довільному (перемішаному) порядку, ' +
    '"correctOrder" — масив індексів 0..n-1, що задає правильний порядок;\n' +
    '- для "matching": "pairs" — 3-4 об\'єкти {"left": "...", "right": "..."};\n';
  if (withModelAnswers) {
    s += '- для "long": "modelAnswer" — короткий еталон відповіді (5-10 речень);\n';
  }
  if (withExplanations) {
    s += '- "explanation": пояснення для учня (2-4 речення): чому відповідь правильна і типова помилка.\n';
  }
  s += 'ВАЖЛИВО:\n' +
    '1) Індекси в "correctIndexes"/"correctOrder" — ЗАВЖДИ починаючи з 0 (перший варіант = 0), ніколи з 1.\n' +
    '2) Поля правильної відповіді обов\'язкові для кожного типу: single/multiple → "correctIndexes", ' +
    'short → "acceptedAnswers", ordering → "correctOrder", matching → "pairs". ' +
    'Якщо не можеш вказати правильну відповідь — не генеруй це питання, а візьми інше.\n' +
    '3) Варіанти відповідей мають бути правдоподібними (один явно правильний, решта — типові помилки), ' +
    'без \'усі з вищевказаних\'.\n' +
    '4) Масив питань НІКОЛИ не скорочуй: якщо попросили N — поверни рівно N повних, завершених об\'єктів. ' +
    'Не віддавай частковий результат, не пропускай поля, не замінюй повне питання коротким натяком.\n' +
    '5) Питання "single"/"multiple" БЕЗ масива "options" (рівно 4 елементи) і "correctIndexes" — неприпустиме: ' +
    'таке питання буде відхилено платформою як некоректне.\n' +
    '6) Числові поля — тільки малі цілі числа (наприклад "points": 1). Ніколи не генеруй довгі ланцюжки цифр: ' +
    'така відповідь буде обрізано і відхилено.';
  return s;
}

function aiBuildQuestionsRequest(p, { fullTest }) {
  const count = aiInt(p.count, 1, AI_MAX_QUESTIONS, 10);
  const types = aiStrList(p.types, 6, 20).filter(t => AI_QUESTION_SCHEMA.properties.type.enum.includes(t));
  const withExplanations = p.withExplanations !== false;
  const withModelAnswers = p.includeModelAnswers !== false;
  const topic = aiStr(p.topic, 300);
  const grade = aiStr(p.grade, 30);
  const difficulty = aiStr(p.difficulty, 60) || 'середня';
  const language = aiStr(p.language, 40) || 'українська';
  const customTitle = aiStr(p.title, 200);

  let msg = `Створи навчальний матеріал для платформи SlideMath.\n\n` +
    `Тема: ${topic || '(вказана в контексті)'}\n` +
    `Клас/рівень: ${grade || 'невідомо'}\n` +
    `Складність: ${difficulty}\n` +
    `Мова: ${language}\n` +
    `Кількість запитань: ${count} — поверни у масиві "questions" РОВНО стільки питань (кожне з правильною відповіддю)\n` +
    `Дозволені типи запитань: ${(types.length ? types : AI_QUESTION_SCHEMA.properties.type.enum).join(', ')}\n` +
    (customTitle ? `Заголовок тесту: ${customTitle}\n` : '') +
    `\n${aiQuestionSpec({ withExplanations, withModelAnswers })}\n`;

  if (fullTest) {
    msg += `\nЦе повний тест. Додай поле "title" (заголовок тесту), "subtitle" і "topics" (2-4 короткі теми). ` +
      `Час та античит-налаштування задає вчитель окремо — їх не повертай.`;
  }

  msg += `\n\nПоверни ОДИН JSON: ${fullTest ? '{"title", "subtitle", "topics", "questions": [...]} ' : '{"questions": [...]} '}` +
    `з рівно ${count} ${aiPlural(count, 'питанням', 'питаннями', 'питаннями')} у масиві "questions". ` +
    `Кожне питання — повне (з усіма обов\'язковими полями свого типу), жодних скорочень.`;

  return {
    systemInstruction: AI_SYSTEM_INSTRUCTION,
    userMessage: msg,
    schema: fullTest ? AI_TEST_SCHEMA : AI_QUESTIONS_SCHEMA,
    meta: { count, withExplanations, withModelAnswers, types },
  };
}

function aiBuildExplanationsRequest(p) {
  const list = Array.isArray(p.questions) ? p.questions.slice(0, AI_MAX_QUESTIONS) : [];
  if (!list.length) throw Object.assign(new Error('Порожній список питань'), { code: 400 });
  const withModelAnswers = p.includeModelAnswers !== false;

  const lines = list.map((q, i) => {
    const parts = [
      `${i + 1}) id="${aiStr(q.id, 60)}"`,
      `type=${aiStr(q.type, 20)}`,
      `питання: ${aiStr(q.prompt, 2000)}`,
    ];
    if (q.correctAnswer) parts.push(`правильна відповідь: ${aiStr(q.correctAnswer, 1000)}`);
    if (q.modelAnswer) parts.push(`еталон: ${aiStr(q.modelAnswer, 2000)}`);
    if (q.options && Array.isArray(q.options) && q.options.length) {
      parts.push(`варіанти: ${q.options.map((o, j) => `[${j}] ${aiStr(o, 300)}`).join(' | ')}`);
    }
    return parts.join('; ');
  });

  const msg =
    `Для кожного запитання із списку напиши пояснення для учня після проходження тесту.\n` +
    `Вимоги до "explanation": 2-4 речення українською, поясни правильну відповідь і назви типову помилку; ` +
    `без оцінок, без звернень по імені.\n` +
    (withModelAnswers
      ? `Для типу "long" також поверни "modelAnswer" — стислий еталон відповіді (5-8 речень).\n`
      : '') +
    `Поверни ОДИН об'єкт {"explanations": [{"id": "...", "explanation": "..."}]}, id — точно як у списку.\n\n` +
    `Питання:\n${lines.join('\n')}`;

  return { systemInstruction: AI_SYSTEM_INSTRUCTION, userMessage: msg, schema: AI_EXPLANATIONS_SCHEMA };
}

function aiBuildGradeRequest(p) {
  const maxPoints = Math.max(0.5, Number(p.maxPoints) || 1);
  const prompt = aiStr(p.prompt, 4000);
  const studentAnswer = aiStr(p.studentAnswer, 8000);
  if (!prompt) throw Object.assign(new Error('Відсутній текст питання'), { code: 400 });
  if (!studentAnswer) throw Object.assign(new Error('Відсутня відповідь учня'), { code: 400 });

  const msg =
    `Перевір відповідь учня на відкрите запитання. Це ПРОПОЗИЦІЯ оцінки для вчителя (він підтвердить її вручну).\n\n` +
    `Запитання: ${prompt}\n` +
    (p.modelAnswer ? `Еталонна відповідь учителя: ${aiStr(p.modelAnswer, 4000)}\n` : '') +
    (p.explanation ? `Пояснення до запитання: ${aiStr(p.explanation, 4000)}\n` : '') +
    `Максимум балів: ${maxPoints}\n` +
    `Відповідь учня: ${studentAnswer}\n\n` +
    `Критерії: оцінюй лише змістовну частину відповіді (математичну правильність, повноту, обґрунтування). ` +
    `Ігноруй орфографію, форматування та зайву воду. Якщо відповідь правильна за змістом — максимум балів; ` +
    `якщо частково — пропорційно; якщо суттєво помилкова або не по темі — 0.\n` +
    `"score" — число від 0 до ${maxPoints} (дозволені дробні), "comment" — 1-3 речення українською для вчителя, ` +
    `за потреби поясни зниження балу. "confidence" — наскільки впевнена оцінка.`;

  return { systemInstruction: AI_SYSTEM_INSTRUCTION, userMessage: msg, schema: AI_GRADE_SCHEMA, meta: { maxPoints } };
}

function aiBuildSlidesRequest(p) {
  const count = aiInt(p.count, 1, AI_MAX_SLIDES, 8);
  const topic = aiStr(p.topic, 300);
  const grade = aiStr(p.grade, 30);
  const points = aiStrList(p.points, 20, 200);
  const language = aiStr(p.language, 40) || 'українська';

  const msg =
    `Створи навчальні слайди для уроку на платформі SlideMath.\n\n` +
    `Тема: ${topic}\n` +
    `Клас/рівень: ${grade || 'невідомо'}\n` +
    `Кількість слайдів: ${count}\n` +
    `Мова: ${language}\n` +
    (points.length ? `Обов'язкові пункти: ${points.join('; ')}\n` : '') +
    `\nКожен слайд: "title" — короткий заголовок; "body" — контент у Markdown (2-5 пунктів списку ` +
    `або 1-2 абзаци). Формули — LaTeX у \\( \\) / \\[ \\]. Не використовуй таблиці зображень, ` +
    `посилання на зовнішні ресурси чи HTML-теги. Перший слайд — вступний, останній — підсумок/висновки.`;

  return { systemInstruction: AI_SYSTEM_INSTRUCTION, userMessage: msg, schema: AI_SLIDES_SCHEMA };
}

// Коригувальний запит: показуємо моделі її ж невдалу відповідь і причину,
// просимо виправити. Використовується ОДИН раз на запит.
// feedback — український опис причини (відсів питань або зіпсований JSON).
function aiBuildCorrectiveRequest(request, prevRaw, feedback) {
  const count = (request.meta && request.meta.count) || AI_MAX_QUESTIONS;
  const snippet = prevRaw.length > 6000
    ? prevRaw.slice(0, 4500) + '\n…[середину обрізано]…\n' + prevRaw.slice(-1200)
    : prevRaw;

  const msg =
    `Твоя попередня відповідь була відхилена платформою. Виправ її і поверни повний JSON за тією ж схемою.\n\n` +
    `Причина: ${feedback || 'невідомі причини'}.\n` +
    `Потрібно: рівно ${count} ${aiPlural(count, 'питанням', 'питаннями', 'питаннями')} у масиві "questions", ` +
    `кожне питання — повне та валідне.\n` +
    `Для "single"/"multiple": обов'язково "options" (рівно 4 елементи) і "correctIndexes" (індекси з 0).\n` +
    `Числові поля (наприклад "points") — тільки малі цілі числа 1…1000; ніколи не пиши довгі ланцюжки цифр.\n` +
    `Не скорочуй відповідь, не пропускай поля, не пиши нічого поза JSON.\n\n` +
    `Завдання (твоє попереднє повідомлення, для контексту):\n${request.userMessage.slice(0, 1500)}\n\n` +
    `Попередня відповідь (невалідна):\n${snippet}`;

  return { systemInstruction: request.systemInstruction, userMessage: msg, schema: request.schema, meta: request.meta };
}

// ── AI: валідація результату від моделі ─────────────────────────────────────
function aiValidateQuestions(result, meta) {
  const raw = result && Array.isArray(result.questions) ? result.questions : [];
  const allowedTypes = AI_QUESTION_SCHEMA.properties.type.enum;
  const questions = [];
  const rejected = {};
  let sample = null;
  const drop = (reason, q) => {
    rejected[reason] = (rejected[reason] || 0) + 1;
    if (!sample && q && typeof q === 'object') sample = q;
  };
  for (const q of raw) {
    if (!q || typeof q !== 'object') { drop('not_object', null); continue; }
    const type = allowedTypes.includes(q.type) ? q.type : null;
    const prompt = aiStr(q.prompt, 4000);
    if (!type || !prompt) { drop(type ? 'no_prompt' : 'type_invalid', q); continue; }
    const out = { type, prompt, points: aiInt(q.points, 1, 100, 1) };

    if (type === 'single' || type === 'multiple') {
      const options = (Array.isArray(q.options) ? q.options : []).map(o => aiStr(o, 1000)).filter(Boolean).slice(0, 8);
      if (options.length < 2) { drop('options_lt2', q); continue; }

      // Толерантне читання правильної відповіді: масив "correctIndexes",
      // одиночний "correctIndex" або "correct" (модель віддає їх по-різному).
      let rawIdx = Array.isArray(q.correctIndexes) ? q.correctIndexes
        : (Array.isArray(q.correct) ? q.correct
          : (q.correctIndex !== undefined && q.correctIndex !== null ? [q.correctIndex] : []));
      rawIdx = rawIdx.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n));
      let correct = rawIdx.filter(n => n >= 0 && n < options.length);
      // Модель часто рахує індекси З 1 (тоді max === options.length, всі ≥ 1) → зсуваємо на -1.
      if (!correct.length && rawIdx.length && rawIdx.every(n => n >= 1)) {
        correct = rawIdx.map(n => n - 1).filter(n => n >= 0 && n < options.length);
      }
      // Текстова правильна відповідь → шукаємо збіг із варіантами.
      if (!correct.length) {
        const answerText = aiStr(q.correctAnswer || q.answer, 1000);
        if (answerText) {
          const norm = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
          const idx = options.findIndex(o => norm(o) === norm(answerText));
          if (idx >= 0) correct = [idx];
        }
      }
      correct = Array.from(new Set(correct)).sort((a, b) => a - b);
      if (!correct.length) { drop('no_correct', q); continue; }
      if (type === 'single' && correct.length > 1) correct = [correct[0]];
      if (type === 'multiple' && correct.length < 2) { drop('multiple_lt2', q); continue; }
      out.options = options;
      out.correctIndexes = correct;
    } else if (type === 'short') {
      let acc = (Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : []).map(a => aiStr(a, 300)).filter(Boolean);
      if (!acc.length) {
        // Толерантність: одна прийнятна відповідь може прийти під іншими полями.
        const alt = (q.answer !== undefined && q.answer !== null) ? q.answer
          : ((q.accepted !== undefined && q.accepted !== null) ? q.accepted : q.correctAnswer);
        acc = (Array.isArray(alt) ? alt : [alt]).map(a => aiStr(a, 300)).filter(Boolean);
      }
      acc = acc.slice(0, 5);
      if (!acc.length) { drop('no_accepted', q); continue; }
      out.acceptedAnswers = acc;
    } else if (type === 'ordering') {
      const items = (Array.isArray(q.items) ? q.items : []).map(i => aiStr(i, 500)).filter(Boolean).slice(0, 8);
      if (items.length < 2) { drop('items_lt2', q); continue; }
      let order = (Array.isArray(q.correctOrder) ? q.correctOrder : []).map(n => parseInt(n, 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n < items.length);
      order = Array.from(new Set(order));
      if (order.length !== items.length) order = items.map((_, i) => i);
      out.items = items;
      out.correctOrder = order;
    } else if (type === 'matching') {
      const pairs = (Array.isArray(q.pairs) ? q.pairs : [])
        .filter(pr => pr && typeof pr === 'object')
        .map(pr => ({ left: aiStr(pr.left, 500), right: aiStr(pr.right, 500) }))
        .filter(pr => pr.left && pr.right).slice(0, 8);
      if (pairs.length < 2) { drop('pairs_lt2', q); continue; }
      out.pairs = pairs;
    }

    if (type === 'long') {
      const ma = aiStr(q.modelAnswer, 6000);
      if (meta && meta.withModelAnswers && ma) out.modelAnswer = ma;
    }
    if (meta && meta.withExplanations) {
      const ex = aiStr(q.explanation, 4000);
      if (ex) out.explanation = ex;
    }
    questions.push(out);
    if (questions.length >= (meta && meta.count ? meta.count : AI_MAX_QUESTIONS)) break;
  }

  const stats = [`questions raw=${raw.length} kept=${questions.length}`];
  if (Object.keys(rejected).length) stats.push(`rejected=${JSON.stringify(rejected)}`);
  if (sample) {
    stats.push(`sample=${JSON.stringify({
      type: typeof sample.type === 'string' ? sample.type : String(sample.type),
      keys: Object.keys(sample).slice(0, 12),
      prompt: String(sample.prompt || '').slice(0, 150),
    })}`);
  }
  console.log(`[AI] ${stats.join(' ')}`);
  return { questions, rawCount: raw.length, rejected };
}

// Причини відсіву питань — українською для повідомлення в UI.
const AI_REJECT_REASON_UA = {
  not_object: 'необ’єкт',
  type_invalid: 'невалідний тип',
  no_prompt: 'порожній текст запитання',
  options_lt2: 'менше 2 варіантів',
  no_correct: 'нема правильної відповіді',
  multiple_lt2: 'для multiple <2 правильних',
  no_accepted: 'нема прийнятих відповідей',
  items_lt2: 'менше 2 елементів',
  pairs_lt2: 'менше 2 пар',
};

function aiRejectionSummary(rejected) {
  return Object.entries(rejected || {})
    .map(([k, n]) => `${AI_REJECT_REASON_UA[k] || k}: ${n}`)
    .join(', ');
}

// Українська плюралізація: 1 запитання / 2 запитання / 5 запитань.
function aiPlural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

// ── AI: головний обробник POST /ai ──────────────────────────────────────────
async function handleAiRequest(req, res) {
  const send = (code, obj) => {
    if (res.headersSent) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  // Примітка: GEMINI_API_KEY (платформний) може бути не заданий — тоді
  // виручить власний ключ вчителя (BYOK); перевірка «чи є хоч якийсь ключ»
  // виконується після розв'язання користувача (нижче).

  let bodyText;
  try {
    bodyText = await aiReadBody(req, AI_BODY_LIMIT);
  } catch (e) {
    return send(e && e.message === 'too_large' ? 413 : 400, { ok: false, error: 'Некоректне тіло запиту' });
  }

  let payload;
  try { payload = JSON.parse(bodyText || '{}'); } catch { return send(400, { ok: false, error: 'Некоректний JSON' }); }

  const action = payload && payload.action;
  if (!AI_ACTIONS.has(action)) return send(400, { ok: false, error: 'Невідома дія' });
  aiDebug('POST /ai', {
    action,
    bodyBytes: bodyText.length,
    params: JSON.stringify(payload.params || {}).slice(0, 500),
  });

  // 1) Автентифікація + роль (перевірка через PHP me.php).
  let user = null;
  try {
    user = await aiResolveUser(req);
  } catch (e) {
    console.error('[AI] me.php failed:', e.message);
    return send(502, { ok: false, error: 'Не вдалося перевірити користувача. Спробуйте ще раз.' });
  }
  if (!user) return send(401, { ok: false, error: 'Потрібен вхід в акаунт' });

  const role = user.role;
  if (!(role === 'admin' || role === 'teacher')) {
    return send(403, { ok: false, error: 'Генерація та AI-перевірка доступні лише вчителям' });
  }
  if (role === 'teacher' && user.status && user.status !== 'active') {
    return send(403, { ok: false, error: 'Акаунт вчителя ще не активовано' });
  }

  // 2) Ключ: власний вчительський (BYOK) → платформений; rate limit під нього.
  const ownKey = String(user.aiApiKey || '').trim();
  const apiKey = ownKey || GEMINI_API_KEY;
  const keySource = ownKey ? 'own' : 'platform';
  if (!apiKey) {
    return send(503, { ok: false, error: 'AI ще не налаштовано: додайте свій Gemini-ключ у профілі (⚙️ Профіль → AI-ключ) або задайте ключ платформи.' });
  }

  const rl = aiRateCheck(user.id, ownKey ? AI_RATE_MAX_OWN : AI_RATE_MAX);
  aiDebug('user', {
    id: user.id,
    role,
    keySource,
    rateLimit: ownKey ? AI_RATE_MAX_OWN : AI_RATE_MAX,
    rateOk: rl.ok,
  });
  if (!rl.ok) {
    const mins = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 60000));
    return send(429, { ok: false, error: `Забагато AI-запитів. Спробуйте за ${mins} хв.` });
  }

  // 3) Побудова запиту до моделі.
  let request;
  try {
    const params = payload.params || {};
    if (action === 'generate_questions') request = aiBuildQuestionsRequest(params, { fullTest: false });
    else if (action === 'generate_full_test') request = aiBuildQuestionsRequest(params, { fullTest: true });
    else if (action === 'generate_explanations') request = aiBuildExplanationsRequest(params);
    else if (action === 'generate_slides') request = aiBuildSlidesRequest(params);
    else if (action === 'grade_answer') request = aiBuildGradeRequest(params);
  } catch (e) {
    return send(e.code || 400, { ok: false, error: e.message || 'Некоректні параметри' });
  }
  aiDebug('prompt head', JSON.stringify(request.userMessage.slice(0, 600)));
  aiDebug('schema', Object.keys((request.schema && request.schema.properties) || {}), 'meta', JSON.stringify(request.meta || {}));

  // 4) Виклик Gemini.
  const started = Date.now();
  const deadlineMs = action === 'grade_answer' ? AI_DEADLINE_GRADE_MS : AI_DEADLINE_MS;
  const deadlineAt = started + deadlineMs;   // дедлайн на весь запит (враховує коригувальний повтор)
  console.log(`[AI] ${action} for ${user.id} (${role}) key=${keySource}`);
  let raw;
  try {
    raw = await aiGenerate(request, {
      action,
      apiKey,
      deadlineMs,
    });
  } catch (e) {
    let msg = e.message || 'AI недоступний';
    if (e.accessIssue) {
      // Підказка, ЯКИЙ ключ використано — щоб знати, де саме лікувати.
      msg += ` [ключ: ${keySource === 'own' ? 'ваш, із профілю' : 'платформний GEMINI_API_KEY'}]`;
    }
    console.error(`[AI] ${action} failed after ${Date.now() - started}ms:`, msg);
    return send(e.code || 502, { ok: false, error: msg });
  }

  const wantsQuestions = action === 'generate_questions' || action === 'generate_full_test';

  // Коригувальний повтор: ОДИН раз на запит — або при зіпсованому/обрізаному JSON,
  // або коли жодне питання не пройшло фільтр. Показуємо моделі її ж відповідь + причину.
  let correctiveTried = false;
  const tryCorrective = async (feedback) => {
    if (correctiveTried || !wantsQuestions || !AI_CORRECTIVE_RETRY) return null;
    correctiveTried = true;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < AI_CORRECTIVE_MIN_MS) {
      console.log(`[AI] ${action} corrective retry skipped: deadline (${remainingMs}ms left)`);
      return null;
    }
    console.log(`[AI] ${action} corrective retry: ${feedback}, budget=${remainingMs}ms`);
    try {
      const fixRaw = await aiGenerate(
        aiBuildCorrectiveRequest(request, raw, feedback),
        { action, apiKey, deadlineMs: remainingMs }
      );
      const fixParsed = aiParseJsonLoose(fixRaw);
      if (!fixParsed) {
        console.log(`[AI] ${action} corrective retry did not help: parse failed`);
        return null;
      }
      return fixParsed;
    } catch (e) {
      console.log(`[AI] ${action} corrective retry failed: ${e.message}`);
      return null;
    }
  };

  let parsed = aiParseJsonLoose(raw);
  if (!parsed && wantsQuestions) {
    // Обрізана відповідь (дегенеративне число в "points", ліміт токенів) →
    // відновлюємо принаймні повні питання з масиву.
    const salv = aiSalvageQuestions(raw);
    if (salv) {
      parsed = salv;
      console.log(`[AI] ${action} salvage: відновлено ${salv.questions.length} повних питань із обрізаного JSON`);
    }
  }
  if (!parsed) {
    console.log(`[AI] ${action}: JSON parse failed, raw length=${raw.length} head=${JSON.stringify(raw.slice(0, 200))} tail=${JSON.stringify(raw.slice(-120))}`);
    parsed = await tryCorrective('відповідь обрізано або зіпсовано (наприклад, дегенеративне число в "points")');
    if (!parsed) {
      return send(502, { ok: false, error: 'AI повернув некоректну відповідь. Спробуйте ще раз.' });
    }
  }
  aiDebug('parsed keys', JSON.stringify(Object.keys(parsed)),
    Array.isArray(parsed.questions) ? `questions=${parsed.questions.length}` : '',
    Array.isArray(parsed.slides) ? `slides=${parsed.slides.length}` : '',
    Array.isArray(parsed.explanations) ? `explanations=${parsed.explanations.length}` : '');

  // 5) Валідація результату.
  let result;
  try {
    if (wantsQuestions) {
      let v = aiValidateQuestions(parsed, request.meta);

      // Коригувальний повтор: жодне питання не пройшло фільтр → виправлення з фідбеком.
      if (!v.questions.length) {
        console.log(`[AI] ${action} corrective needed: kept=0/${v.rawCount} (${aiRejectionSummary(v.rejected)})`);
        const fixParsed = await tryCorrective(`питання не пройшли фільтр: ${aiRejectionSummary(v.rejected)}`);
        if (fixParsed) {
          const v2 = aiValidateQuestions(fixParsed, request.meta);
          if (v2.questions.length) {
            v = v2;
            parsed = fixParsed;
            console.log(`[AI] ${action} corrective retry ok: kept=${v2.questions.length}/${v2.rawCount}`);
          } else {
            console.log(`[AI] ${action} corrective retry did not help: kept=0/${v2.rawCount} rejected=${JSON.stringify(v2.rejected)}`);
          }
        }
      }

      if (!v.questions.length) {
        const detail = v.rawCount
          ? `AI повернув ${v.rawCount} ${aiPlural(v.rawCount, 'запитання', 'запитання', 'запитань')}, жодне не пройшло фільтр (${aiRejectionSummary(v.rejected)})`
          : 'AI повернув порожній список запитань';
        throw Object.assign(new Error(`${detail}. Спробуйте ще раз або змініть параметри.`), { code: 502 });
      }
      result = {
        title: aiStr(parsed.title, 200),
        subtitle: aiStr(parsed.subtitle, 300),
        topics: aiStrList(parsed.topics, 6, 60),
        questions: v.questions,
      };
    } else if (action === 'generate_explanations') {
      const list = Array.isArray(parsed.explanations) ? parsed.explanations : [];
      result = {
        explanations: list
          .filter(x => x && x.id)
          .map(x => ({ id: aiStr(x.id, 60), explanation: aiStr(x.explanation, 4000), modelAnswer: aiStr(x.modelAnswer, 6000) }))
          .filter(x => x.explanation),
      };
      if (!result.explanations.length) throw Object.assign(new Error('AI не повернув пояснень'), { code: 502 });
    } else if (action === 'grade_answer') {
      const maxPoints = request.meta.maxPoints;
      const scoreRaw = Number(parsed.score);
      const score = Number.isFinite(scoreRaw) ? Math.min(maxPoints, Math.max(0, Math.round(scoreRaw * 100) / 100)) : 0;
      const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium';
      result = { score, comment: aiStr(parsed.comment, 2000), confidence, maxPoints };
    } else if (action === 'generate_slides') {
      const slides = (Array.isArray(parsed.slides) ? parsed.slides : [])
        .map(s => ({ title: aiStr(s && s.title, 300), body: aiStr(s && s.body, 8000) }))
        .filter(s => s.title && s.body)
        .slice(0, AI_MAX_SLIDES);
      if (!slides.length) throw Object.assign(new Error('AI не зміг згенерувати слайди'), { code: 502 });
      result = { title: aiStr(parsed.title, 200), slides };
    } else {
      result = parsed;
    }
  } catch (e) {
    return send(e.code || 502, { ok: false, error: e.message || 'AI повернув некоректні дані' });
  }

  console.log(`[AI] ${action} ok for ${user.id} (${role}) key=${keySource} in ${Date.now() - started}ms`);
  send(200, { ok: true, action, model: GEMINI_MODEL, key: keySource, result });
}

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

// ── In-memory per-participant current question (not persisted to DB) ────────
const participantCurrentQuestion = new Map(); // `${sessionId}:${participantId}` → questionId

// ── HTTP server + WebSocket ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SM-Auth, X-SM-User, X-SM-Key-Rev');

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
      ai: GEMINI_API_KEY ? GEMINI_MODEL : '(not configured)',
    }));
    return;
  }

  if (url.pathname === '/ai') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }
    handleAiRequest(req, res).catch(e => {
      console.error('[AI] unhandled error:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Внутрішня помилка AI-сервісу' }));
      }
    });
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
      // Merge buffer overlay for answers + current question
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
        // Inject in-memory currentQuestionId
        for (const p of s.participants) {
          const key = `${sessionId}:${p.id}`;
          if (participantCurrentQuestion.has(key)) {
            p.currentQuestionId = participantCurrentQuestion.get(key);
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
      if (fields?.finished || fields?.paused !== undefined || fields?.integrity || fields?.status || fields?.extraBlockTimeAdded) {
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

  "question.current"(ws, msg) {
    const { sessionId, participantId, questionId } = msg;
    if (!participantId || !questionId) return;
    const key = `${sessionId}:${participantId}`;
    participantCurrentQuestion.set(key, questionId);
    broadcastEvent(sessionId, 'question.current', { participantId, questionId });
  },

  async addQuestionTime(ws, msg) {
    const { sessionId, participantId, questionId, seconds, cid } = msg;
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchParticipant', sessionId, participantId,
        fields: { extraQuestionTime: { [questionId]: seconds } },
      });
      sendTo(ws, 'participant.patched', { ok: !!res?.ok, participantId }, cid);
      if (res?.ok) broadcastEvent(sessionId, 'participant.updated', { participantId, fields: { extraQuestionTime: { [questionId]: seconds } } });
    } catch (e) {
      console.error('[WS] addQuestionTime error:', e.message);
      sendTo(ws, 'participant.patched', { ok: false, error: e.message }, cid);
    }
  },

  async saveTimers(ws, msg) {
    const { sessionId, participantId, savedTimers, savedTotalTimeLeft, cid } = msg;
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'patchParticipant', sessionId, participantId,
        fields: { savedTimers, savedTotalTimeLeft },
      });
      sendTo(ws, 'participant.patched', { ok: !!res?.ok, participantId }, cid);
    } catch (e) {
      console.error('[WS] saveTimers error:', e.message);
      sendTo(ws, 'participant.patched', { ok: false, error: e.message }, cid);
    }
  },

  async setManualGrade(ws, msg) {
    const { sessionId, participantId, questionId, value, testId, manualScore, graded, cid } = msg;
    try {
      const res = await apiCall('answers.php', 'POST', {
        sessionId, participantId: String(participantId), questionId: String(questionId),
        value: value ?? '', testId: testId || '', manualScore, graded: true,
      });
      sendTo(ws, 'answer.graded', { ok: !!res?.ok, questionId, participantId }, cid);
      if (res?.ok) broadcastEvent(sessionId, 'answer.graded', { participantId, questionId, manualScore, graded: true });
    } catch (e) {
      console.error('[WS] setManualGrade error:', e.message);
      sendTo(ws, 'answer.graded', { ok: false, error: e.message }, cid);
    }
  },

  async joinSession(ws, msg) {
    const { sessionId, code, participantName, participantId, cid } = msg;
    try {
      const res = await apiCall('save.php', 'PATCH', {
        op: 'joinSession', sessionId, code, participantName, participantId,
      });
      sendTo(ws, 'join.result', { ok: !!res?.ok, ...res }, cid);
      if (res?.ok) broadcastEvent(sessionId, 'participant.joined', { participantId, participantName });
    } catch (e) {
      console.error('[WS] joinSession error:', e.message);
      sendTo(ws, 'join.result', { ok: false, error: e.message }, cid);
    }
  },

  async fetchSessionByCode(ws, msg) {
    const { code, cid } = msg;
    try {
      const res = await apiCall(`session-state.php?code=${encodeURIComponent(code)}&full=1`);
      sendTo(ws, 'session.lookup', { ok: !!res?.ok, session: res?.session || res }, cid);
    } catch (e) {
      console.error('[WS] fetchSessionByCode error:', e.message);
      sendTo(ws, 'session.lookup', { ok: false, error: e.message }, cid);
    }
  },

  async fetchSessionLight(ws, msg) {
    const { sessionId, cid } = msg;
    try {
      const res = await apiCall(`init-session.php?id=${encodeURIComponent(sessionId)}`);
      sendTo(ws, 'session.light', { ok: !!res, ...res }, cid);
    } catch (e) {
      console.error('[WS] fetchSessionLight error:', e.message);
      sendTo(ws, 'session.light', { ok: false, error: e.message }, cid);
    }
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
      participantCurrentQuestion.delete(key);
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
