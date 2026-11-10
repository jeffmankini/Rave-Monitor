// Postmark's email API. The API Worker sends sign-in links with it; the alerts step
// (pipeline/notify.js) sends alerts and digests. https://postmarkapp.com/developer

const API = 'https://api.postmarkapp.com';

/** One call to Postmark. Resolves to { ok, status, data }; never throws for an HTTP error. */
export async function postmark(token, path, body, fetchImpl = fetch, method = 'POST') {
  const r = await fetchImpl(API + path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await r.json(); } catch (err) { data = null; }
  const failed = data && !Array.isArray(data) && data.ErrorCode;
  return { ok: r.ok && !failed, status: r.status, data };
}

/** A message in Postmark's shape. Opens and clicks are never tracked. */
export function message({ from, fromName, to, subject, html, text, stream, tag, headers, replyTo }) {
  const m = {
    From: fromName ? `${fromName.replace(/["\\]/g, '')} <${from}>` : from,
    To: to, Subject: subject, HtmlBody: html, TextBody: text,
    MessageStream: stream || 'outbound', TrackOpens: false, TrackLinks: 'None'
  };
  if (tag) m.Tag = tag;
  if (replyTo) m.ReplyTo = replyTo;
  if (headers && headers.length) m.Headers = headers;
  return m;
}

export const sendEmail = (token, msg, fetchImpl) => postmark(token, '/email', msg, fetchImpl);
// Up to 500 messages a call; the answer lists each message's ErrorCode (0 is sent).
export const sendBatch = (token, msgs, fetchImpl) => postmark(token, '/email/batch', msgs, fetchImpl);
