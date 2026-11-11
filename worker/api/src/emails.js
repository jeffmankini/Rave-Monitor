// Rave Monitor's emails: the sign-in link (API Worker) and alerts and digests (pipeline/notify.js).
// Each returns { subject, html, text }. The HTML is plain tables and inline styles, so it holds up
// in Gmail, Apple Mail and Outlook; the text part says the same thing.

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const C = { void: '#070814', ink: '#15131f', ink2: '#4b4a5e', ink3: '#7a7990', line: '#e6e3ee', now: '#f6ecd8', page: '#f4f2f8' };

function layout({ preheader, body, footer }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>Rave Monitor</title></head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};color:${C.ink}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:${C.void};padding:18px 24px"><a href="https://ravemonitor.com" style="color:${C.now};text-decoration:none;font-weight:800;letter-spacing:.08em;font-size:14px">RAVE MONITOR</a><span style="color:#7c7fa3;font-size:12px"> by Geff Bohm</span></td></tr>
<tr><td style="padding:24px">${body}</td></tr>
<tr><td style="padding:16px 24px 22px;border-top:1px solid ${C.line};color:${C.ink3};font-size:12px;line-height:1.6">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td style="background:${C.void};border-radius:10px"><a href="${esc(href)}" style="display:inline-block;padding:12px 20px;color:${C.now};text-decoration:none;font-weight:700;font-size:15px">${esc(label)}</a></td></tr></table>`;

/** The email with a sign-in link. */
export function signInEmail({ link, siteUrl = 'https://ravemonitor.com' }) {
  const body = `<h1 style="margin:0 0 10px;font-size:20px">Sign in to Rave Monitor</h1>
<p style="margin:0;color:${C.ink2};font-size:15px;line-height:1.55">Use the button to sign in. The link works once, for the next 15 minutes.</p>
${button(link, 'Sign in')}
<p style="margin:0;color:${C.ink3};font-size:13px;line-height:1.55">Or paste this into your browser:<br><a href="${esc(link)}" style="color:${C.ink2};word-break:break-all">${esc(link)}</a></p>`;
  const footer = `If you didn't ask to sign in, you can ignore this email. Nothing happens until the link is used.<br>Rave Monitor, by Geff Bohm · <a href="${esc(siteUrl)}" style="color:${C.ink3}">${esc(siteUrl.replace(/^https?:\/\//, ''))}</a>`;
  return {
    subject: 'Your Rave Monitor sign-in link',
    html: layout({ preheader: 'Sign in to follow artists and venues, save shows and get alerts.', body, footer }),
    text: `Sign in to Rave Monitor\n\nOpen this link to sign in. It works once, for the next 15 minutes:\n${link}\n\nIf you didn't ask to sign in, you can ignore this email. Nothing happens until the link is used.\n\nRave Monitor, by Geff Bohm\n${siteUrl}`
  };
}

/** "Sat 15 Nov, 10:00 PM" in the listing's own time zone. */
export function when(iso, tz) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  try {
    const f = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' });
    const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value]));
    return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ${p.dayPeriod || ''}`.trim();
  } catch (err) { return new Date(t).toUTCString().slice(0, 22); }
}

// How each kind of alert is headed, in the order the sections appear.
export const SECTIONS = [
  { kinds: ['cancelled', 'postponed', 'soldout'], title: 'Changes to shows you saved' },
  { kinds: ['reminder'], title: 'Coming up' },
  { kinds: ['new_show'], title: 'New from who you follow' },
  { kinds: ['scene'], title: 'New in your scene' },
  { kinds: ['picks'], title: 'Picks for your week' }
];
const PREFIX = { cancelled: 'Cancelled', postponed: 'Postponed', soldout: 'Sold out', reminder: 'Reminder', new_show: 'New show' };

const eventUrl = (siteUrl, ev) => siteUrl + '/?event=' + encodeURIComponent(ev.id);
const metaLine = ev => [when(ev.start, ev.tz), [ev.venue, ev.cityName].filter(Boolean).join(', ')].filter(Boolean).join(' · ');

function eventRow(siteUrl, ev, label, why) {
  return `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.line}">
${label ? `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.ink3};margin-bottom:3px">${esc(label)}</div>` : ''}
<a href="${esc(eventUrl(siteUrl, ev))}" style="color:${C.ink};font-weight:700;font-size:15px;text-decoration:none;line-height:1.35">${esc(ev.title)}</a>
<div style="color:${C.ink2};font-size:13px;line-height:1.5;margin-top:2px">${esc(metaLine(ev))}</div>
${why ? `<div style="color:${C.ink3};font-size:12px;line-height:1.5;margin-top:2px">${esc(why)}</div>` : ''}
</td></tr>`;
}

/**
 * Alerts as one email. items: notifications with data parsed ({ kind, title, body, data }).
 * freq: 'instant' | 'daily' | 'weekly' (how this person gets new-show alerts; changes and
 * reminders always go out right away, as 'instant').
 */
export function alertsEmail({ items, freq = 'instant', siteUrl = 'https://ravemonitor.com', settingsUrl, unsubUrl }) {
  const n = items.length;
  const single = n === 1 && items[0].kind !== 'picks' && items[0].kind !== 'scene' ? items[0] : null;
  let subject;
  if (single) subject = `${PREFIX[single.kind] || 'Alert'}: ${single.data.title || single.title}`;
  else if (n === 1) subject = items[0].title;
  else if (freq === 'daily') subject = `Your day on Rave Monitor: ${n} ${n === 1 ? 'alert' : 'alerts'}`;
  else if (freq === 'weekly') subject = `Your week on Rave Monitor: ${n} ${n === 1 ? 'alert' : 'alerts'}`;
  else subject = `${n} new alerts from Rave Monitor`;
  if (subject.length > 110) subject = subject.slice(0, 109) + '…';

  let html = '', text = '';
  for (const sec of SECTIONS) {
    const its = items.filter(it => sec.kinds.includes(it.kind));
    if (!its.length) continue;
    html += `<h2 style="margin:18px 0 4px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:${C.ink2}">${esc(sec.title)}</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0">`;
    text += `\n${sec.title.toUpperCase()}\n`;
    for (const it of its) {
      if (it.kind === 'picks' || it.kind === 'scene') {
        html += `<tr><td style="padding:6px 0 2px;color:${C.ink2};font-size:13px">${esc(it.body)}</td></tr>`;
        text += `${it.body}\n`;
        for (const ev of (it.data.events || [])) {
          html += eventRow(siteUrl, ev, '', ev.why || '');
          text += `- ${ev.title}\n  ${metaLine(ev)}\n  ${eventUrl(siteUrl, ev)}\n`;
        }
      } else {
        const ev = it.data || {};
        const label = it.kind === 'new_show' ? '' : PREFIX[it.kind];
        html += eventRow(siteUrl, ev, label, it.body);
        text += `- ${label ? label + ': ' : ''}${ev.title}\n  ${metaLine(ev)}\n${it.body ? '  ' + it.body + '\n' : ''}  ${eventUrl(siteUrl, ev)}\n`;
      }
    }
    html += '</table>';
  }
  const how = freq === 'daily' ? 'a daily email' : freq === 'weekly' ? 'a weekly email' : 'emails as alerts happen';
  const footer = `You're getting this because you have a Rave Monitor account and chose ${how} for new shows; changes and reminders for shows you saved come right away.<br>
<a href="${esc(settingsUrl)}" style="color:${C.ink3}">Change what we send</a> · <a href="${esc(unsubUrl)}" style="color:${C.ink3}">Unsubscribe from all emails</a><br>Rave Monitor, by Geff Bohm · Milwaukee, WI`;
  const intro = single ? '' : `<p style="margin:0;color:${C.ink2};font-size:15px;line-height:1.55">${freq === 'weekly' ? 'Here is your week.' : freq === 'daily' ? 'Here is what is new since yesterday.' : 'Here is what just changed.'}</p>`;
  return {
    subject,
    html: layout({ preheader: single ? metaLine(single.data || {}) : `${n} ${n === 1 ? 'alert' : 'alerts'} from Rave Monitor`, body: intro + html + button(siteUrl, 'Open Rave Monitor'), footer }),
    text: `${single ? '' : (freq === 'weekly' ? 'Your week on Rave Monitor' : freq === 'daily' ? 'Your day on Rave Monitor' : 'New alerts from Rave Monitor') + '\n'}${text}\nOpen Rave Monitor: ${siteUrl}\n\nChange what we send: ${settingsUrl}\nUnsubscribe from all emails: ${unsubUrl}\nRave Monitor, by Geff Bohm · Milwaukee, WI`
  };
}
