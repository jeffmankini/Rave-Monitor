import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, mime, TOPICS } from '../worker/contact/src/handler.js';

const ORIGIN = 'https://ravemonitor.com';
function setup(over = {}) {
  const sent = [];
  const env = {
    ALLOWED_ORIGINS: 'https://ravemonitor.com,https://www.ravemonitor.com', TURNSTILE_HOSTNAMES: 'ravemonitor.com',
    CONTACT_FROM: 'hello@ravemonitor.com', CONTACT_TO: 'inbox@example.com', TURNSTILE_SECRET: 'secret',
    EMAIL: { send: async m => { sent.push(m); return { messageId: 'x' }; } },
    ...over
  };
  const checks = [];
  const fetch = async (url, init) => { checks.push(Object.fromEntries(init.body)); return { json: async () => ({ success: true, hostname: 'ravemonitor.com' }) }; };
  return { env, sent, checks, fetch };
}
const post = (fields, headers = {}) => new Request('https://api.ravemonitor.com/contact', {
  method: 'POST', body: new URLSearchParams(fields),
  headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9', ...headers }
});
const good = { name: 'Ana', email: 'ana@example.org', topic: TOPICS[1], message: 'Please fix the start time of my night.', t: '9000', 'cf-turnstile-response': 'tok', page: 'https://ravemonitor.com/contact/' };

test('preflight and origin checks', async () => {
  const { env, fetch } = setup();
  const pre = await handle(new Request('https://api.ravemonitor.com/contact', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, { fetch });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const bad = await handle(post(good, { Origin: 'https://evil.example' }), env, { fetch });
  assert.equal(bad.status, 403);
  assert.equal((await handle(new Request('https://api.ravemonitor.com/other', { method: 'POST', headers: { Origin: ORIGIN } }), env, { fetch })).status, 404);
  assert.equal((await handle(new Request('https://api.ravemonitor.com/contact', { headers: { Origin: ORIGIN } }), env, { fetch })).status, 405);
});

test('a good message is checked with Turnstile and emailed with Reply-To the visitor', async () => {
  const { env, sent, checks, fetch } = setup();
  const res = await handle(post(good), env, { fetch });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].secret, 'secret');
  assert.equal(checks[0].response, 'tok');
  assert.equal(checks[0].remoteip, '203.0.113.9');
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'inbox@example.com');
  assert.deepEqual(m.from, { email: 'hello@ravemonitor.com', name: 'Rave Monitor contact form' });
  assert.equal(m.replyTo, 'ana@example.org');
  assert.equal(m.subject, 'Rave Monitor: Fix or remove a listing from Ana');
  assert.match(m.text, /Please fix the start time of my night\./);
  assert.match(m.text, /Page: https:\/\/ravemonitor\.com\/contact\//);
});

test('bad input is refused before anything is sent', async () => {
  const { env, sent, fetch } = setup();
  assert.equal((await handle(post({ ...good, email: 'not-an-email' }), env, { fetch })).status, 400);
  assert.equal((await handle(post({ ...good, message: 'hi' }), env, { fetch })).status, 400);
  const failing = async () => ({ json: async () => ({ success: false }) });
  const r = await handle(post(good), env, { fetch: failing });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: 'challenge', detail: 'not-success' });
  const wrongHost = async () => ({ json: async () => ({ success: true, hostname: 'elsewhere.example' }) });
  assert.equal((await handle(post(good), env, { fetch: wrongHost })).status, 400);
  assert.equal((await handle(post({ ...good, 'cf-turnstile-response': '' }), env, { fetch })).status, 400);
  assert.equal(sent.length, 0);
});

test('bots get a thank-you and nothing is sent', async () => {
  const { env, sent, checks, fetch } = setup();
  const honeypot = await handle(post({ ...good, website: 'http://spam.example' }), env, { fetch });
  assert.deepEqual(await honeypot.json(), { ok: true });
  const instant = await handle(post({ ...good, t: '400' }), env, { fetch });
  assert.deepEqual(await instant.json(), { ok: true });
  assert.equal(sent.length, 0);
  assert.equal(checks.length, 0);
});

test('names cannot add mail headers, and the rate limit applies', async () => {
  const { env, sent, fetch } = setup();
  await handle(post({ ...good, name: 'Ana\r\nBcc: victim@example.com' }), env, { fetch });
  assert.equal(sent[0].subject.includes('\n'), false);
  const limited = setup({ LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await handle(post(good), limited.env, { fetch: limited.fetch })).status, 429);
});

test('a failed send is reported with its reason, without addresses', async () => {
  const { env, fetch } = setup({ EMAIL: { send: async () => { const e = new Error('destination address not verified: inbox@example.com'); e.code = 'E_RECIPIENT_NOT_ALLOWED'; throw e; } } });
  const res = await handle(post(good), env, { fetch });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { ok: false, error: 'send_failed', detail: 'E_RECIPIENT_NOT_ALLOWED: destination address not verified: [address]' });
  const bare = setup({ CONTACT_TO: '' });
  const r2 = await handle(post(good), bare.env, { fetch: bare.fetch });
  assert.equal((await r2.json()).detail, 'not-configured: CONTACT_TO');
});

test('raw MIME encodes non-ASCII headers and the body', () => {
  const raw = mime({ from: 'hello@ravemonitor.com', fromName: 'Rave Monitor contact form', to: 'inbox@example.com', replyTo: 'zoe@example.org', replyName: 'Zoë', subject: 'Rave Monitor: Général', text: 'Ça va?\nYes.' });
  assert.match(raw, /^From: Rave Monitor contact form <hello@ravemonitor\.com>\r\n/);
  assert.match(raw, /\r\nReply-To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@example\.org>\r\n/);
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(raw, /\r\nMessage-ID: <[0-9a-f-]+@ravemonitor\.com>\r\n/);
  const body = raw.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Ça va?\nYes.');
});

test('with Email Routing, the binding gets an EmailMessage holding raw MIME', async () => {
  const { env, sent, fetch } = setup();
  class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }
  const res = await handle(post(good), env, { fetch, EmailMessage });
  assert.equal(res.status, 200);
  assert.ok(sent[0] instanceof EmailMessage);
  assert.equal(sent[0].from, 'hello@ravemonitor.com');
  assert.equal(sent[0].to, 'inbox@example.com');
  assert.match(sent[0].raw, /\r\nReply-To: Ana <ana@example\.org>\r\n/);
  assert.match(sent[0].raw, /\r\nTo: <inbox@example\.com>\r\n/);
});
