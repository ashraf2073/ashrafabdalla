'use strict';
/*
  Ashraf's portfolio server. No npm packages needed (Node 18 or newer).

  It does two things:
    1. Serves the website (index.html and the icon files next to this file).
    2. POST /api/contact: takes the contact form and emails it to you through the
       Gmail API using Google OAuth. The page stays put: no redirects, no pop-ups.

  Set these as Environment Variables on Render (never put them in the code):
    GOOGLE_CLIENT_ID       OAuth client ID from Google Cloud Console
    GOOGLE_CLIENT_SECRET   OAuth client secret
    GOOGLE_REFRESH_TOKEN   refresh token for the Gmail account, authorised with the
                           scope https://www.googleapis.com/auth/gmail.send
    GMAIL_USER             that Gmail address (the one that authorised the token)
    MAIL_TO                optional: where messages go (defaults to GMAIL_USER)
    ALLOWED_ORIGIN         optional: your site address, e.g. https://ashraf-abdalla.onrender.com
                           (defaults to accepting only requests from the same host)
*/

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT) || 3000;
const E = process.env;
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon', 'public, max-age=86400'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml', 'public, max-age=86400'],
  '/og.jpg': ['og.jpg', 'image/jpeg', 'public, max-age=86400'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
};

/* only these files are ever served, so server.js and package.json stay private */
const cache = {};
for (const [url, [file]] of Object.entries(FILES)) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, file));
    cache[url] = { raw, gz: /\.(html|svg|ico)$/.test(file) ? zlib.gzipSync(raw, { level: 9 }) : null };
  } catch (e) { /* missing optional file */ }
}

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

/* ---------- Gmail (Google OAuth) ---------- */
let token = { value: '', exp: 0 };
async function accessToken(force) {
  if (!force && token.value && Date.now() < token.exp - 60000) return token.value;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: E.GOOGLE_CLIENT_ID,
      client_secret: E.GOOGLE_CLIENT_SECRET,
      refresh_token: E.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Google token error: ' + (j.error || r.status) + (j.error_description ? ' (' + j.error_description + ')' : ''));
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encodedWord = (s) => '=?UTF-8?B?' + b64(s) + '?=';

function buildRaw({ from, to, replyTo, subject, text }) {
  const head = [
    'From: ' + encodedWord('Portfolio contact form') + ' <' + from + '>',
    'To: ' + to,
    replyTo ? 'Reply-To: ' + replyTo : null,
    'Subject: ' + encodedWord(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
  return Buffer.from(head.join('\r\n') + '\r\n\r\n' + body).toString('base64url');
}

async function sendMail(msg) {
  const raw = buildRaw(msg);
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await accessToken(attempt > 0);
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (r.ok) return;
    if (r.status === 401 && attempt === 0) continue; // token expired: refresh once and retry
    const j = await r.json().catch(() => ({}));
    throw new Error('Gmail error ' + r.status + (j.error && j.error.message ? ': ' + j.error.message : ''));
  }
}

/* ---------- contact form ---------- */
const hits = new Map(); // ip -> timestamps
let globalHits = [];
function limited(ip) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const mine = (hits.get(ip) || []).filter((t) => now - t < win);
  globalHits = globalHits.filter((t) => now - t < 60 * 60 * 1000);
  if (mine.length >= 5 || globalHits.length >= 60) { hits.set(ip, mine); return true; }
  mine.push(now); globalHits.push(now); hits.set(ip, mine);
  return false;
}
setInterval(() => { const now = Date.now(); for (const [ip, ts] of hits) if (!ts.some((t) => now - t < 15 * 60 * 1000)) hits.delete(ip); }, 10 * 60 * 1000).unref();

const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').trim().slice(0, max);
const multiLine = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const EMAIL = /^[^\s@<>"',;:()]+@[^\s@<>"',;:()]+\.[^\s@<>"',;:()]+$/;

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameSite(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser or same-origin GET-like request
  if (E.ALLOWED_ORIGIN) return E.ALLOWED_ORIGIN.split(',').map((s) => s.trim().replace(/\/$/, '')).includes(origin);
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

async function contact(req, res) {
  if (!sameSite(req)) return json(res, 403, { ok: false, error: 'This request was not allowed.' });
  if (!/application\/json/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'Unsupported request.' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return json(res, 429, { ok: false, error: 'Too many messages. Please try again a little later.' });

  let data;
  try { data = JSON.parse(await readBody(req)); } catch (e) {
    return json(res, e.code === 413 ? 413 : 400, { ok: false, error: 'Could not read the message.' });
  }
  if (!data || typeof data !== 'object') return json(res, 400, { ok: false, error: 'Could not read the message.' });
  if (oneLine(data.website, 50)) return json(res, 200, { ok: true }); // honeypot: bots fill this in

  const name = oneLine(data.name, 100), contactInfo = oneLine(data.contact, 150), message = multiLine(data.message, 4000);
  if (!name || !contactInfo || !message) return json(res, 400, { ok: false, error: 'Please fill in your name, your email or phone, and a message.' });

  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GMAIL_USER'].filter((k) => !E[k]);
  if (missing.length) {
    console.error('Contact form is not configured. Missing: ' + missing.join(', '));
    return json(res, 503, { ok: false, error: 'The contact form is not available right now. Please email servicestribridge@gmail.com instead.' });
  }

  const text = ['New message from your portfolio', '', 'Name: ' + name, 'Contact: ' + contactInfo, '', 'Message:', message, '', 'Sent: ' + new Date().toISOString()].join('\n');
  try {
    await sendMail({ from: E.GMAIL_USER, to: E.MAIL_TO || E.GMAIL_USER, replyTo: EMAIL.test(contactInfo) ? contactInfo : '', subject: 'Portfolio message from ' + name, text });
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error(e.message);
    return json(res, 502, { ok: false, error: 'Sorry, the message could not be sent. Please try again, or email servicestribridge@gmail.com.' });
  }
}

/* ---------- http ---------- */
http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/contact') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
    return contact(req, res).catch((e) => { console.error(e); json(res, 500, { ok: false, error: 'Something went wrong.' }); });
  }
  if (url === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  const f = cache[url];
  if (!f) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const [, type, cc] = FILES[url];
  const gz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? f.gz : f.raw;
  const h = { 'Content-Type': type, 'Cache-Control': cc, 'Content-Length': body.length, Vary: 'Accept-Encoding' };
  if (gz) h['Content-Encoding'] = 'gzip';
  send(res, 200, req.method === 'HEAD' ? undefined : body, h);
}).listen(PORT, () => console.log('Portfolio running on port ' + PORT));
