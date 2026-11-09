// Rave Monitor contact form: POST /contact from https://ravemonitor.com/contact/.
// Checks the origin, a per-IP rate limit, a honeypot, the Turnstile challenge and the fields,
// then emails the message through Cloudflare Email Routing (the EMAIL binding) to CONTACT_TO,
// with Reply-To set to the visitor so a reply goes straight to them. Nothing is stored, and the
// logs carry only error codes, never what people wrote.

export const TOPICS = ['General', 'Fix or remove a listing', 'Suggest a city or source', 'Press or partnership'];
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_BODY = 20000;

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
// One line, no control characters (so nothing can add a mail header), at most n characters.
const line = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// Free text: keep line breaks and tabs, drop other control characters.
const text = (s, n) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);
const EMAIL_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[a-z]{2,}$/i;

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function readBody(request) {
  const len = +(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return null;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  const type = request.headers.get('Content-Type') || '';
  try {
    if (type.includes('application/json')) return JSON.parse(raw) || {};
    return Object.fromEntries(new URLSearchParams(raw));
  } catch (err) {
    return null;
  }
}

export async function verifyTurnstile(env, token, ip, fetchImpl = fetch) {
  if (!token || !env.TURNSTILE_SECRET) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token).slice(0, 2048), idempotency_key: crypto.randomUUID() });
  if (ip) form.set('remoteip', ip);
  try {
    const r = await fetchImpl(SITEVERIFY, { method: 'POST', body: form });
    const v = await r.json();
    if (!v || !v.success) return false;
    const hosts = list(env.TURNSTILE_HOSTNAMES);
    return !hosts.length || hosts.includes(v.hostname);
  } catch (err) {
    return false;
  }
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const word = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';

/** A plain-text email as raw MIME, for Email Routing's EmailMessage. */
export function mime(m) {
  return [
    `From: ${word(m.fromName)} <${m.from}>`,
    `To: <${m.to}>`,
    `Reply-To: ${m.replyName ? word(m.replyName) + ' ' : ''}<${m.replyTo}>`,
    `Subject: ${word(m.subject)}`,
    `Message-ID: <${crypto.randomUUID()}@${m.from.split('@')[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(m.text).replace(/.{1,76}/g, '$&\r\n')
  ].join('\r\n');
}

async function send(env, m) {
  let EmailMessage = null;
  try { ({ EmailMessage } = await import('cloudflare:email')); } catch (err) { /* not in the Workers runtime */ }
  if (EmailMessage) return env.EMAIL.send(new EmailMessage(m.from, m.to, mime(m)));
  // Email Service's structured form (also what the tests use).
  return env.EMAIL.send({ to: m.to, from: { email: m.from, name: m.fromName }, replyTo: m.replyTo, subject: m.subject, text: m.text });
}

export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const allowed = list(env.ALLOWED_ORIGINS);
  const cors = {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || '*'),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (url.pathname !== '/contact') return json({ ok: false, error: 'not_found' }, 404, cors);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
  if (!allowed.includes(origin)) return json({ ok: false, error: 'origin' }, 403, cors);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: ip || 'unknown' });
    if (!success) return json({ ok: false, error: 'rate_limited' }, 429, cors);
  }

  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'bad_request' }, 400, cors);
  // Bots fill the hidden field or submit instantly: say thanks and send nothing.
  if (line(data.website, 200) || (+data.t && +data.t < 2000)) return json({ ok: true }, 200, cors);

  const name = line(data.name, 100);
  const email = line(data.email, 200);
  const topic = TOPICS.includes(data.topic) ? data.topic : TOPICS[0];
  const message = text(data.message, 5000);
  const page = line(data.page, 300);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'invalid_email' }, 400, cors);
  if (message.length < 10) return json({ ok: false, error: 'too_short' }, 400, cors);

  if (!(await verifyTurnstile(env, data['cf-turnstile-response'], ip, deps.fetch))) return json({ ok: false, error: 'challenge' }, 400, cors);

  const body = [
    'New message from the Rave Monitor contact form.',
    '',
    'Name: ' + (name || '(not given)'),
    'Email: ' + email,
    'Topic: ' + topic,
    page && allowed.some(o => page.startsWith(o)) ? 'Page: ' + page : null,
    '',
    message,
    '',
    '-- ',
    'Reply to this email to answer them directly.'
  ].filter(l => l !== null).join('\n');
  try {
    await send(env, {
      from: env.CONTACT_FROM, fromName: 'Rave Monitor contact form', to: env.CONTACT_TO,
      replyTo: email, replyName: name, subject: line('Rave Monitor: ' + topic + ' from ' + (name || email), 140), text: body
    });
  } catch (err) {
    console.log('send failed', (err && (err.code || err.name)) || 'error');
    return json({ ok: false, error: 'send_failed' }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

export default { fetch: (request, env) => handle(request, env) };
