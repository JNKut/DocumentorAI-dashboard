import express from 'express';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Checked here on the server; a VITE_* variable would be compiled into the
// public JS bundle where anyone could read it. VITE_DASHBOARD_PASSWORD is
// still accepted so existing Railway config keeps working.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || process.env.VITE_DASHBOARD_PASSWORD || '';
if (!DASHBOARD_PASSWORD) {
  console.warn('DASHBOARD_PASSWORD is not set; the dashboard is open to anyone with the URL.');
}

const SESSION_COOKIE = 'dash_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt; cleared on restart, which just means logging in again

const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const failedLogins = new Map(); // ip -> { count, lockedUntil }

function timingSafeStringEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

function isAuthed(req) {
  if (!DASHBOARD_PASSWORD) return true;
  const token = getSessionToken(req);
  const expiresAt = token && sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Not signed in' });
  next();
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(join(__dirname, 'dist')));

app.get('/api/session', (req, res) => {
  res.json({ authRequired: !!DASHBOARD_PASSWORD, authed: isAuthed(req) });
});

app.post('/api/login', (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.json({ ok: true });

  const ip = req.ip;
  const attempt = failedLogins.get(ip);
  if (attempt && attempt.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!timingSafeStringEqual(password, DASHBOARD_PASSWORD)) {
    const count = (attempt && attempt.lockedUntil === 0 ? attempt.count : 0) + 1;
    failedLogins.set(ip, { count, lockedUntil: count >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOGIN_LOCKOUT_MS : 0 });
    return res.status(401).json({ error: 'Incorrect password' });
  }

  failedLogins.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// Proxy Railway's GraphQL API server-side to avoid CORS restrictions.
// Token is supplied per-request and never persisted on this server.
app.post('/api/railway-proxy', requireAuth, async (req, res) => {
  const { token, query, variables } = req.body;
  if (!token || !query) {
    return res.status(400).json({ error: 'token and query are required' });
  }
  try {
    const r = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Railway API' });
  }
});

// Serve the SPA for all other routes (Express 5 compatible)
app.use((_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Dashboard server running on port ${port}`));
