import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './prompt.js';
import { checkEmergency, emergencyReply, redact } from './safety.js';

export const LIMITS = {
  MAX_BODY_BYTES: 100 * 1024,
  MAX_MESSAGES: 20,
  MAX_USER_CHARS: 2000,
  MAX_ASSISTANT_CHARS: 8000,
  MAX_TOTAL_CHARS: 40000,
  MAX_OUTPUT_TOKENS: 1024,
  TIMEOUT_MS: 25000
};

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
const fail = (res, status, code, message, headers) => send(res, status, { error: { code, message } }, headers);

export function parseOrigins(value) {
  return String(value || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

export class ValidationError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Validate and normalise the client's message list. Returns an array ending in a user turn. */
export function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError('INVALID_REQUEST', '"messages" must be a non-empty array.');
  }
  const cleaned = [];
  for (const m of input) {
    if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      throw new ValidationError('INVALID_REQUEST', 'Each message needs a role ("user" or "assistant") and string content.');
    }
    let content = m.content.replace(/\u0000/g, '').trim();
    if (!content) continue; // drop empty
    if (m.role === 'user' && content.length > LIMITS.MAX_USER_CHARS) {
      throw new ValidationError('MESSAGE_TOO_LONG', `Messages can be at most ${LIMITS.MAX_USER_CHARS} characters.`, 413);
    }
    if (m.role === 'assistant') content = content.slice(0, LIMITS.MAX_ASSISTANT_CHARS);
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === m.role) {
      if (prev.content === content) continue; // exact duplicate
      prev.content += '\n\n' + content;        // merge consecutive same-role turns
    } else {
      cleaned.push({ role: m.role, content });
    }
  }
  // keep the most recent window, bounded by count and total size
  let window = cleaned.slice(-LIMITS.MAX_MESSAGES);
  let total = window.reduce((n, m) => n + m.content.length, 0);
  while (window.length > 1 && total > LIMITS.MAX_TOTAL_CHARS) { total -= window[0].content.length; window = window.slice(1); }
  while (window.length && window[0].role !== 'user') window = window.slice(1); // must start with user
  if (!window.length || window[window.length - 1].role !== 'user') {
    throw new ValidationError('INVALID_REQUEST', 'The last message must be a non-empty user message.');
  }
  return window;
}

export function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return function check(key) {
    const t = now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
    const entry = hits.get(key);
    if (!entry || entry.reset <= t) { hits.set(key, { count: 1, reset: t + windowMs }); return { ok: true }; }
    entry.count += 1;
    return entry.count > max ? { ok: false, retryAfter: Math.ceil((entry.reset - t) / 1000) } : { ok: true };
  };
}

/** Map provider errors to safe, user-facing responses. Never leaks internals. */
export function mapProviderError(err) {
  const status = err && err.status;
  const text = String((err && err.message) || '').toLowerCase();
  const ctor = err && err.constructor && err.constructor.name;
  if (err instanceof Anthropic.APIConnectionTimeoutError || ctor === 'APIConnectionTimeoutError')
    return { http: 504, code: 'AI_TIMEOUT', message: 'The AI took too long to respond. Please try again.' };
  if (status === 401 || status === 403)
    return { http: 502, code: 'AI_AUTH', message: 'The assistant\u2019s API credentials are missing or invalid. The site owner needs to fix this.' };
  if (status === 402 || (status === 400 && /credit|billing|balance/.test(text)))
    return { http: 503, code: 'AI_BILLING', message: 'The assistant has reached its usage or billing limit. The site owner needs to check the Anthropic account.' };
  if (status === 429)
    return { http: 429, code: 'AI_RATE_LIMIT', message: 'The AI service is busy right now. Please wait a moment and try again.' };
  if (status === 529 || status === 503 || status === 500)
    return { http: 503, code: 'AI_OVERLOADED', message: 'The AI service is temporarily unavailable. Please try again shortly.' };
  if (err instanceof Anthropic.APIConnectionError || ctor === 'APIConnectionError')
    return { http: 502, code: 'AI_UNREACHABLE', message: 'The backend could not reach the AI service. Please try again.' };
  return { http: 502, code: 'AI_ERROR', message: 'Something went wrong while contacting the AI. Please try again.' };
}

// ---------- handler factory (injectable for tests) ----------
export function createHandler({ client, env = process.env, now = Date.now } = {}) {
  const limiter = createRateLimiter({
    max: Number(env.RATE_LIMIT_MAX) || 10,
    windowMs: Number(env.RATE_LIMIT_WINDOW_MS) || 60000,
    now
  });
  let sdk = client;

  return async function handler(req, res) {
    const allowed = parseOrigins(env.ALLOWED_ORIGINS);
    const origin = req.headers && req.headers.origin;
    res.setHeader('Vary', 'Origin');

    if (origin) {
      if (!allowed.includes(origin.replace(/\/+$/, ''))) {
        return fail(res, 403, 'ORIGIN_NOT_ALLOWED', 'This website is not allowed to use the assistant.');
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST.', { Allow: 'POST, OPTIONS' });

    const ct = String((req.headers && req.headers['content-type']) || '');
    if (!ct.includes('application/json')) return fail(res, 415, 'INVALID_REQUEST', 'Content-Type must be application/json.');
    if (Number(req.headers['content-length']) > LIMITS.MAX_BODY_BYTES) return fail(res, 413, 'REQUEST_TOO_LARGE', 'Request is too large.');

    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
    const rl = limiter(ip);
    if (!rl.ok) return fail(res, 429, 'RATE_LIMITED', 'Too many requests. Please wait a bit and try again.', { 'Retry-After': String(rl.retryAfter) });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== 'object') return fail(res, 400, 'INVALID_REQUEST', 'Body must be valid JSON.');
    if (JSON.stringify(body).length > LIMITS.MAX_BODY_BYTES) return fail(res, 413, 'REQUEST_TOO_LARGE', 'Request is too large.');

    let messages;
    try { messages = validateMessages(body.messages); }
    catch (e) {
      if (e instanceof ValidationError) return fail(res, e.status, e.code, e.message);
      return fail(res, 400, 'INVALID_REQUEST', 'Invalid request.');
    }

    // Emergency pre-check on the latest user turn: answer immediately, no AI wait.
    const safety = checkEmergency(messages[messages.length - 1].content);
    if (safety.emergency) {
      return send(res, 200, { reply: emergencyReply(safety.kind), emergency: true, source: 'emergency-rule' });
    }

    if (!sdk) {
      if (!env.ANTHROPIC_API_KEY) {
        console.error('ANTHROPIC_API_KEY is not set');
        return fail(res, 500, 'SERVER_NOT_CONFIGURED', 'The assistant is not configured yet. The site owner needs to add the API key.');
      }
      sdk = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: LIMITS.TIMEOUT_MS, maxRetries: 1 });
    }

    try {
      const response = await sdk.messages.create({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: LIMITS.MAX_OUTPUT_TOKENS,
        system: buildSystemPrompt(),
        messages: messages.map((m) => ({ role: m.role, content: redact(m.content) }))
      });
      const reply = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!reply) return fail(res, 502, 'EMPTY_RESPONSE', 'The AI returned an empty answer. Please try again.');
      return send(res, 200, { reply, emergency: false, source: 'claude' });
    } catch (err) {
      const mapped = mapProviderError(err);
      // Log only codes/status, never message content or the API key.
      console.error('Claude API error:', mapped.code, err && err.status);
      return fail(res, mapped.http, mapped.code, mapped.message);
    }
  };
}
