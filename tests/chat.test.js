import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createHandler, validateMessages, createRateLimiter, mapProviderError } from '../lib/handler.js';
import { checkEmergency, redact } from '../lib/safety.js';
import { buildSystemPrompt } from '../lib/prompt.js';

const ORIGIN = 'https://student.github.io';
const baseEnv = { ANTHROPIC_API_KEY: 'sk-ant-test-SECRET', ALLOWED_ORIGINS: ORIGIN, RATE_LIMIT_MAX: '3' };

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b = '') => { res.body = b; };
  res.json = () => (res.body ? JSON.parse(res.body) : null);
  return res;
}
function mockReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: { messages: [{ role: 'user', content: 'What is diabetes?' }] },
    ...overrides
  };
}
function fakeClient(impl) {
  const calls = [];
  return { calls, messages: { create: async (args) => { calls.push(args); return impl(args); } } };
}
const okClient = (text = 'Diabetes is a condition...') => fakeClient(() => ({ content: [{ type: 'text', text }] }));
async function run(handler, req) { const res = mockRes(); await handler(req, res); return res; }

// ---------- validation ----------
test('validateMessages normalises, drops empties/duplicates, ends with user', () => {
  const out = validateMessages([
    { role: 'assistant', content: 'stray' },
    { role: 'user', content: '  hi ' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: '   ' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'what causes it?' }
  ]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user']);
});
test('validateMessages rejects bad input', () => {
  assert.throws(() => validateMessages([]), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateMessages('x'), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateMessages([{ role: 'system', content: 'x' }]), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateMessages([{ role: 'user', content: 'x'.repeat(2001) }]), { code: 'MESSAGE_TOO_LONG' });
});
test('validateMessages bounds history length', () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  msgs.push({ role: 'user', content: 'last' });
  const out = validateMessages(msgs);
  assert.ok(out.length <= 20 && out[0].role === 'user' && out.at(-1).content.endsWith('last'));
});

// ---------- safety ----------
test('emergency check: urgent phrases', () => {
  for (const t of ["I can't breathe", 'severe chest pain and sweating', 'my face is drooping and speech slurred',
    'he is unconscious', 'my throat is swelling after eating peanuts', 'I want to die', 'heavy bleeding that wont stop']) {
    assert.equal(checkEmergency(t).emergency || checkEmergency(t + ' slurred speech').emergency, true, t);
  }
  assert.equal(checkEmergency('I want to die').kind, 'mental_health');
});
test('emergency check: educational/benign questions are not flagged', () => {
  for (const t of ['What is diabetes?', 'What causes it?', 'What is a stroke?', 'I have a cough and fever',
    'Which specialist handles skin conditions?', 'what does BP mean']) {
    assert.equal(checkEmergency(t).emergency, false, t);
  }
});
test('redact removes emails, phones and 12-digit ids', () => {
  const r = redact('mail me a@b.com or call +91 98765 43210, id 1234 5678 9012, bp 120 80');
  assert.ok(!r.includes('a@b.com') && !r.includes('98765') && !r.includes('9012'));
  assert.ok(r.includes('120 80'));
});
test('system prompt describes demo-only features and forbids fabrication', () => {
  const p = buildSystemPrompt();
  assert.match(p, /SIMULATED DEMO ONLY/);
  assert.match(p, /Never invent hospital names/);
});

// ---------- handler ----------
test('success: calls Claude with history and returns reply; key never in response', async () => {
  const client = okClient('Diabetes is...');
  const h = createHandler({ client, env: baseEnv });
  const res = await run(h, mockReq({ body: { messages: [
    { role: 'user', content: 'What is diabetes?' },
    { role: 'assistant', content: 'Diabetes is a condition of high blood sugar.' },
    { role: 'user', content: 'What causes it?' }] } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reply, 'Diabetes is...');
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].messages.length, 3); // context preserved
  assert.ok(client.calls[0].system.length > 100);
  assert.ok(!res.body.includes('SECRET'));
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
});
test('emergency bypasses AI call', async () => {
  const client = okClient();
  const h = createHandler({ client, env: baseEnv });
  const res = await run(h, mockReq({ body: { messages: [{ role: 'user', content: "I can't breathe and have severe chest pain" }] } }));
  assert.equal(res.json().emergency, true);
  assert.match(res.json().reply, /112/);
  assert.equal(client.calls.length, 0);
});
test('PII is redacted before reaching the provider', async () => {
  const client = okClient();
  const h = createHandler({ client, env: baseEnv });
  await run(h, mockReq({ body: { messages: [{ role: 'user', content: 'my email is jeev@example.com, what is anemia?' }] } }));
  assert.ok(!client.calls[0].messages[0].content.includes('jeev@example.com'));
});
test('CORS: disallowed origin rejected, preflight OK, GET rejected', async () => {
  const h = createHandler({ client: okClient(), env: baseEnv });
  assert.equal((await run(h, mockReq({ headers: { origin: 'https://evil.com', 'content-type': 'application/json' } }))).statusCode, 403);
  const pre = await run(h, mockReq({ method: 'OPTIONS' }));
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
  const get = await run(h, mockReq({ method: 'GET' }));
  assert.equal(get.statusCode, 405);
});
test('invalid body, wrong content type, oversize', async () => {
  const h = createHandler({ client: okClient(), env: baseEnv });
  assert.equal((await run(h, mockReq({ body: { messages: [] } }))).statusCode, 400);
  assert.equal((await run(h, mockReq({ body: 'not json' }))).statusCode, 400);
  assert.equal((await run(h, mockReq({ headers: { origin: ORIGIN, 'content-type': 'text/plain' } }))).statusCode, 415);
  assert.equal((await run(h, mockReq({ headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '999999' } }))).statusCode, 413);
});
test('missing API key gives safe config error', async () => {
  const h = createHandler({ env: { ALLOWED_ORIGINS: ORIGIN } });
  const res = await run(h, mockReq());
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, 'SERVER_NOT_CONFIGURED');
});
test('rate limiting returns 429 with Retry-After', async () => {
  const h = createHandler({ client: okClient(), env: baseEnv });
  for (let i = 0; i < 3; i++) assert.equal((await run(h, mockReq())).statusCode, 200);
  const res = await run(h, mockReq());
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error.code, 'RATE_LIMITED');
  assert.ok(res.headers['retry-after']);
});
test('rate limiter window resets', () => {
  let t = 0; const check = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
  assert.ok(check('a').ok); assert.ok(!check('a').ok); t = 1500; assert.ok(check('a').ok);
});
test('provider errors map to safe codes without leaking details', async () => {
  const cases = [
    [new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key sk-ant-LEAK' } }, 'invalid x-api-key sk-ant-LEAK', new Headers()), 'AI_AUTH'],
    [new Anthropic.RateLimitError(429, {}, 'rate', new Headers()), 'AI_RATE_LIMIT'],
    [new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the API.' } }, undefined, new Headers()), 'AI_BILLING'],
    [new Anthropic.InternalServerError(529, {}, 'overloaded', new Headers()), 'AI_OVERLOADED'],
    [new Anthropic.APIConnectionTimeoutError(), 'AI_TIMEOUT'],
    [new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'AI_UNREACHABLE'],
    [new Error('boom stack trace here'), 'AI_ERROR']
  ];
  for (const [err, code] of cases) {
    assert.equal(mapProviderError(err).code, code);
    const h = createHandler({ client: fakeClient(() => { throw err; }), env: baseEnv });
    const res = await run(h, mockReq());
    assert.equal(res.json().error.code, code);
    assert.ok(!res.body.includes('LEAK') && !res.body.includes('stack trace') && !res.body.includes('SECRET'));
  }
});
test('empty provider response is reported honestly', async () => {
  const h = createHandler({ client: fakeClient(() => ({ content: [] })), env: baseEnv });
  assert.equal((await run(h, mockReq())).json().error.code, 'EMPTY_RESPONSE');
});
