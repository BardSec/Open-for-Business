'use strict';

require('dotenv').config();

const express    = require('express');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const session    = require('express-session');
const { Issuer, generators } = require('openid-client');

const app  = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');

// ---------------------------------------------------------------------------
// Auth configuration
// ---------------------------------------------------------------------------

// OIDC (Microsoft Entra / Google / any OpenID Connect provider)
// Set all three env vars to enable OIDC SSO; otherwise falls back to Basic Auth.
//   OIDC_ISSUER       – discovery URL, e.g.:
//                         Google:    https://accounts.google.com
//                         Microsoft: https://login.microsoftonline.com/{tenant}/v2.0
//   OIDC_CLIENT_ID    – OAuth2 app / client ID
//   OIDC_CLIENT_SECRET
//   OIDC_REDIRECT_URI – defaults to http://localhost:{PORT}/auth/callback
//   SESSION_SECRET    – random secret for signing session cookies (auto-generated if unset)

const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI ||
  `http://localhost:${PORT}/auth/callback`;

let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[SECURITY] SESSION_SECRET not set — sessions will not survive restarts.');
}

// Basic Auth fallback (only used when OIDC is not configured)
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(16).toString('hex');
  console.warn('[SECURITY] ADMIN_PASSWORD not set — using a one-time random password.');
  console.warn(`[SECURITY] Admin password: ${ADMIN_PASSWORD}`);
  console.warn('[SECURITY] Set ADMIN_PASSWORD env var to make it persistent.');
}

// OIDC user allowlist — checked at login time.
// If neither var is set, any user the provider authenticates becomes admin.
//   OIDC_ALLOWED_EMAILS  – comma-separated list:  alice@school.org,bob@school.org
//   OIDC_ALLOWED_DOMAIN  – email domain suffix:   school.org
const OIDC_ALLOWED_EMAILS = (process.env.OIDC_ALLOWED_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const OIDC_ALLOWED_DOMAIN = (process.env.OIDC_ALLOWED_DOMAIN || '').toLowerCase().trim();

function isAllowedOIDCUser(email) {
  if (!OIDC_ALLOWED_EMAILS.length && !OIDC_ALLOWED_DOMAIN) return true;
  const e = (email || '').toLowerCase();
  if (OIDC_ALLOWED_EMAILS.length && OIDC_ALLOWED_EMAILS.includes(e)) return true;
  if (OIDC_ALLOWED_DOMAIN && e.endsWith('@' + OIDC_ALLOWED_DOMAIN)) return true;
  return false;
}

// Filled in by initOIDC() if env vars are present
let oidcClient = null;

async function initOIDC() {
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = process.env;
  const present = [OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET].filter(Boolean).length;

  if (present === 0) {
    console.warn('[AUTH] OIDC not configured — falling back to HTTP Basic Auth.');
    console.warn('[AUTH] Set OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET to enable SSO.');
    return;
  }
  if (present < 3) {
    console.error('[AUTH] Partial OIDC config — set all of: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET');
    process.exit(1);
  }

  try {
    const issuer = await Issuer.discover(OIDC_ISSUER);
    oidcClient = new issuer.Client({
      client_id:     OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
      redirect_uris: [OIDC_REDIRECT_URI],
      response_types: ['code'],
    });
    console.log(`[AUTH] OIDC SSO configured. Issuer: ${issuer.metadata.issuer}`);
    if (!OIDC_ALLOWED_EMAILS.length && !OIDC_ALLOWED_DOMAIN) {
      console.warn('[SECURITY] OIDC allowlist not configured — any authenticated tenant user has admin access.');
      console.warn('[SECURITY] Set OIDC_ALLOWED_EMAILS or OIDC_ALLOWED_DOMAIN to restrict access.');
    }
  } catch (err) {
    console.error(`[AUTH] OIDC discovery failed: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SITES          = 50;
const MAX_NAME_LEN       = 80;
const MAX_RANGE_MS       = 2 * 365.25 * 24 * 60 * 60 * 1000; // ~2 years
const EVENT_RETENTION_MS = MAX_RANGE_MS;
const RATE_LIMIT_MAX     = 60;     // requests per window per IP
const RATE_LIMIT_WINDOW  = 60_000; // 1 minute in ms
const TIME_RE            = /^\d{2}:\d{2}$/;

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function defaultBusinessHours() {
  return { start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] };
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Migrate legacy single-site format { isOpen: bool }
    if (typeof raw.isOpen === 'boolean' && !raw.sites) {
      return {
        sites: [{ id: 'main', name: 'Help Desk', isOpen: raw.isOpen, businessHours: defaultBusinessHours() }],
        events: [{ siteId: 'main', isOpen: raw.isOpen, ts: Date.now() }],
      };
    }
    // Migrate global businessHours down to each site (v2 → v3)
    const globalBH = raw.businessHours || defaultBusinessHours();
    for (const site of raw.sites) {
      if (!site.businessHours) site.businessHours = { ...globalBH };
    }
    delete raw.businessHours;
    if (!raw.events) {
      raw.events = raw.sites.map(s => ({ siteId: s.id, isOpen: s.isOpen, ts: Date.now() }));
    }
    return raw;
  } catch {
    return {
      sites: [{ id: 'main', name: 'Help Desk', isOpen: true, businessHours: defaultBusinessHours() }],
      events: [{ siteId: 'main', isOpen: true, ts: Date.now() }],
    };
  }
}

// Atomic write: write to a temp file then rename, so a crash mid-write
// never leaves a truncated state.json.
function saveState() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Keep only events within the retention window, plus one anchor event per
// site just before the cutoff so report calculations at the window edge work.
function pruneEvents() {
  const cutoff = Date.now() - EVENT_RETENTION_MS;
  const byId = new Map();
  for (const e of state.events) {
    if (!byId.has(e.siteId)) byId.set(e.siteId, []);
    byId.get(e.siteId).push(e);
  }
  const pruned = [];
  for (const [, evts] of byId) {
    evts.sort((a, b) => a.ts - b.ts);
    const inWindow = evts.filter(e => e.ts >= cutoff);
    const before   = evts.filter(e => e.ts < cutoff);
    const anchor   = before.length ? before[before.length - 1] : null;
    if (anchor) pruned.push(anchor);
    pruned.push(...inWindow);
  }
  state.events = pruned;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function uniqueId(name) {
  const base = slugify(name) || 'site';
  const existing = new Set(state.sites.map(s => s.id));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let state = loadState();
pruneEvents(); // prune stale events on startup

// ---------------------------------------------------------------------------
// Business-hours auto-close
// Runs every minute; closes any site that is open but outside its configured
// hours. Opening is always manual — this is purely a safety-net auto-close.
// Times are compared against server-local time, so make sure the host TZ
// matches the school's timezone (set TZ= in compose.yaml if needed).
// ---------------------------------------------------------------------------

function checkBusinessHours() {
  const now     = new Date();
  const day     = now.getDay();                          // 0 = Sun … 6 = Sat
  const nowMins = now.getHours() * 60 + now.getMinutes(); // minutes since midnight
  let changed   = false;

  for (const site of state.sites) {
    if (!site.isOpen) continue; // already closed — nothing to do

    const bh = site.businessHours || defaultBusinessHours();

    // Convert "HH:MM" strings → minutes since midnight for a simple numeric range check.
    const [startH, startM] = bh.start.split(':').map(Number);
    const [endH,   endM  ] = bh.end.split(':').map(Number);
    const startMins = startH * 60 + startM;
    const endMins   = endH   * 60 + endM;

    // Map days to numbers to guard against any string/number type mismatch in stored state.
    const inDay  = bh.days.map(Number).includes(day);
    const inTime = nowMins >= startMins && nowMins < endMins;

    if (!inDay || !inTime) {
      site.isOpen = false;
      state.events.push({ siteId: site.id, isOpen: false, ts: Date.now(), auto: true });
      changed = true;
      console.log(`[SCHEDULE] Auto-closed "${site.name}" — outside business hours (${bh.days.join(',')} ${bh.start}–${bh.end})`);
    }
  }

  if (changed) saveState();
}

checkBusinessHours(); // run immediately so a restart outside hours closes sites
setInterval(checkBusinessHours, 60 * 1000).unref(); // then every minute

// Prune and save once a day so the event log doesn't grow unbounded
setInterval(() => { pruneEvents(); saveState(); }, 24 * 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Report calculation
// ---------------------------------------------------------------------------

function calcBusinessMinutes(fromMs, toMs, bh) {
  if (toMs <= fromMs) return 0;
  const [startH, startM] = bh.start.split(':').map(Number);
  const [endH, endM]     = bh.end.split(':').map(Number);
  const daySet = new Set(bh.days);
  let totalMs = 0;
  const cursor = new Date(fromMs);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < toMs) {
    if (daySet.has(cursor.getDay())) {
      const dayStart = new Date(cursor); dayStart.setHours(startH, startM, 0, 0);
      const dayEnd   = new Date(cursor); dayEnd.setHours(endH, endM, 0, 0);
      const overlapStart = Math.max(dayStart.getTime(), fromMs);
      const overlapEnd   = Math.min(dayEnd.getTime(),   toMs);
      if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return totalMs / 60000;
}

function calcSiteReport(siteId, fromMs, toMs, bh) {
  const siteEvents = state.events
    .filter(e => e.siteId === siteId)
    .sort((a, b) => a.ts - b.ts);
  let stateAtFrom = false;
  for (const e of siteEvents) {
    if (e.ts <= fromMs) stateAtFrom = e.isOpen;
    else break;
  }
  const relevant = siteEvents.filter(e => e.ts > fromMs && e.ts <= toMs);
  const intervals = [];
  let curState = stateAtFrom;
  let curStart = fromMs;
  for (const e of relevant) {
    intervals.push({ isOpen: curState, start: curStart, end: e.ts });
    curState = e.isOpen;
    curStart = e.ts;
  }
  intervals.push({ isOpen: curState, start: curStart, end: toMs });
  let openMins = 0, closedMins = 0;
  for (const iv of intervals) {
    const m = calcBusinessMinutes(iv.start, iv.end, bh);
    if (iv.isOpen) openMins += m; else closedMins += m;
  }
  return { openMins: Math.round(openMins), closedMins: Math.round(closedMins) };
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

app.disable('x-powered-by');
app.set('trust proxy', 1); // one reverse-proxy hop (nginx/Caddy); lets req.ip see real client IPs
app.use(express.json());

app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly:  true,
    sameSite:  'lax',
    secure:    process.env.NODE_ENV === 'production',
    maxAge:    8 * 60 * 60 * 1000, // 8 hours
  },
}));

// Security headers on every response
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

// Protects admin pages and write API endpoints.
// Uses OIDC session when configured; falls back to HTTP Basic Auth otherwise.
function requireAuth(req, res, next) {
  if (oidcClient) {
    // OIDC mode: check for a valid session
    if (req.session && req.session.user) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Session expired — please reload and log in again.' });
    }
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/login');
  } else {
    // Basic Auth fallback
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Basic ')) {
      const decoded  = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      const pass     = colonIdx === -1 ? '' : decoded.slice(colonIdx + 1);
      const a = Buffer.from(pass);
      const b = Buffer.from(ADMIN_PASSWORD);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Help Desk Admin"');
    return res.status(401).send('Authentication required');
  }
}

// CSRF guard for state-changing API endpoints.
// Our own fetch() calls include this header; cross-origin CSRF requests
// cannot set arbitrary headers without a CORS preflight that we never grant.
function requireXHR(req, res, next) {
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per-IP)
// ---------------------------------------------------------------------------

const _rateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _rateMap) if (now > e.resetAt) _rateMap.delete(ip);
}, 5 * 60 * 1000).unref();

function rateLimit(req, res, next) {
  const ip  = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let e = _rateMap.get(ip);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + RATE_LIMIT_WINDOW }; _rateMap.set(ip, e); }
  if (++e.count > RATE_LIMIT_MAX) return res.status(429).json({ error: 'Too many requests — slow down.' });
  next();
}

// ---------------------------------------------------------------------------
// OIDC auth routes  (/auth/login, /auth/callback, /auth/logout)
// ---------------------------------------------------------------------------

app.get('/auth/login', (req, res) => {
  if (!oidcClient) return res.redirect('/admin');
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.oidcState = state;
  req.session.oidcNonce = nonce;
  res.redirect(oidcClient.authorizationUrl({ scope: 'openid email profile', state, nonce }));
});

app.get('/auth/callback', async (req, res) => {
  if (!oidcClient) return res.redirect('/admin');
  try {
    const params   = oidcClient.callbackParams(req);
    const tokenSet = await oidcClient.callback(
      OIDC_REDIRECT_URI,
      params,
      { state: req.session.oidcState, nonce: req.session.oidcNonce }
    );
    const claims = tokenSet.claims();
    const email   = claims.email || claims.preferred_username || '';

    if (!isAllowedOIDCUser(email)) {
      console.warn(`[AUTH] OIDC login denied for: ${email}`);
      return res.status(403).send(
        'Access denied. Your account is not authorised to manage this help desk. ' +
        '<a href="/">Return to status page</a>'
      );
    }

    const user     = { email, name: claims.name || email || 'Admin' };
    const returnTo = req.session.returnTo || '/admin';

    // Regenerate the session ID to prevent session fixation attacks.
    req.session.regenerate((err) => {
      if (err) {
        console.error('[OIDC] Session regeneration failed:', err.message);
        return res.status(500).send('Authentication error. <a href="/auth/login">Try again</a>');
      }
      req.session.user = user;
      res.redirect(returnTo);
    });
  } catch (err) {
    console.error('[OIDC] Callback error:', err.message);
    res.status(400).send('Authentication failed. <a href="/auth/login">Try again</a>');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------------------------------------------------------------------------
// API – sites
// ---------------------------------------------------------------------------

app.get('/api/sites', (req, res) => {
  res.json(state.sites);
});

app.post('/api/sites', requireAuth, requireXHR, rateLimit, (req, res) => {
  if (state.sites.length >= MAX_SITES) {
    return res.status(400).json({ error: `Maximum of ${MAX_SITES} sites reached` });
  }
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error: `name must be ${MAX_NAME_LEN} characters or fewer` });
  const site = { id: uniqueId(name), name, isOpen: true, businessHours: defaultBusinessHours() };
  state.sites.push(site);
  state.events.push({ siteId: site.id, isOpen: true, ts: Date.now() });
  saveState();
  res.status(201).json(site);
});

app.delete('/api/sites/:id', requireAuth, requireXHR, rateLimit, (req, res) => {
  const idx = state.sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const siteId = state.sites[idx].id;
  state.sites.splice(idx, 1);
  state.events = state.events.filter(e => e.siteId !== siteId); // clean up orphaned events
  saveState();
  res.json({ ok: true });
});

app.post('/api/sites/:id/toggle', requireAuth, requireXHR, rateLimit, (req, res) => {
  const site = state.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  site.isOpen = !site.isOpen;
  state.events.push({ siteId: site.id, isOpen: site.isOpen, ts: Date.now() });
  saveState();
  res.json(site);
});

// ---------------------------------------------------------------------------
// API – business hours & reporting
// ---------------------------------------------------------------------------

app.post('/api/sites/:id/business-hours', requireAuth, requireXHR, rateLimit, (req, res) => {
  const site = state.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  const { start, end, days } = req.body;
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
    return res.status(400).json({ error: 'start and end must be HH:MM' });
  }
  if (!Array.isArray(days)) {
    return res.status(400).json({ error: 'days must be an array' });
  }
  const daysNums = [...new Set(days.map(Number))];
  if (daysNums.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
    return res.status(400).json({ error: 'days must contain integers 0 (Sun) through 6 (Sat)' });
  }
  site.businessHours = { start, end, days: daysNums };
  saveState();
  res.json(site.businessHours);
});

app.get('/api/report', requireAuth, rateLimit, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const fromMs = new Date(fy, fm - 1, fd,  0,  0,  0,   0).getTime();
  const toMs   = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime();

  if (isNaN(fromMs) || isNaN(toMs) || toMs < fromMs) {
    return res.status(400).json({ error: 'invalid date range' });
  }
  if (toMs - fromMs > MAX_RANGE_MS) {
    return res.status(400).json({ error: 'date range cannot exceed 2 years' });
  }

  const sites = state.sites.map(site => {
    const bh = site.businessHours || defaultBusinessHours();
    const totalBizMins = Math.round(calcBusinessMinutes(fromMs, toMs, bh));
    const { openMins, closedMins } = calcSiteReport(site.id, fromMs, toMs, bh);
    return {
      id:   site.id,
      name: site.name,
      openMins,
      closedMins,
      totalBizMins,
      openPct: totalBizMins > 0 ? Math.round((openMins / totalBizMins) * 1000) / 10 : 0,
    };
  });

  res.json({ from, to, sites });
});

// ---------------------------------------------------------------------------
// Master overview page  –  shows all sites at a glance
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Help Desk Status</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      min-height: 100vh;
      background: #111;
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem 1.5rem;
      gap: 2.5rem;
    }
    h1 { font-size: clamp(1.6rem, 4vw, 2.8rem); letter-spacing: 0.04em; text-align: center; }
    #grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.5rem;
      width: 100%;
      max-width: 960px;
    }
    .card {
      border-radius: 1rem;
      padding: 2rem 1.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.6rem;
      text-decoration: none;
      transition: transform 0.15s, filter 0.15s;
    }
    .card:hover { transform: translateY(-4px); filter: brightness(1.1); }
    .card.open   { background: #1a7a3a; }
    .card.closed { background: #b71c1c; }
    .card-name   { font-size: 1.1rem; font-weight: 600; color: rgba(255,255,255,0.8); text-align: center; }
    .card-status { font-size: 2.2rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; }
    .card-sub    { font-size: 0.85rem; color: rgba(255,255,255,0.65); }
    #empty       { color: #555; font-size: 1rem; }
    #clock       { font-size: 1.1rem; font-variant-numeric: tabular-nums; letter-spacing: 0.08em; color: rgba(255,255,255,0.4); }
  </style>
</head>
<body>
  <h1>Help Desk Status</h1>
  <div id="clock"></div>
  <div id="grid"></div>
  <script>
    (function tickClock() {
      document.getElementById('clock').textContent =
        new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setTimeout(tickClock, 1000 - (Date.now() % 1000));
    })();
    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    async function poll() {
      try {
        const sites = await fetch('/api/sites').then(r => r.json());
        const grid = document.getElementById('grid');
        grid.innerHTML = '';
        if (sites.length === 0) {
          grid.innerHTML = '<p id="empty">No sites configured yet.</p>';
          return;
        }
        for (const site of sites) {
          const a = document.createElement('a');
          a.className = 'card ' + (site.isOpen ? 'open' : 'closed');
          a.href = '/site/' + esc(site.id);
          a.innerHTML =
            '<div class="card-name">'   + esc(site.name) + '</div>' +
            '<div class="card-status">' + (site.isOpen ? 'Open' : 'Closed') + '</div>' +
            '<div class="card-sub">'    + (site.isOpen ? 'Walk-ins welcome' : 'Check back later') + '</div>';
          grid.appendChild(a);
        }
      } catch (e) { /* ignore */ }
    }
    poll();
    setInterval(poll, 5000);
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Individual site public page  –  fullscreen open/closed board
// ---------------------------------------------------------------------------

app.get('/site/:id', (req, res) => {
  const site = state.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).send('Site not found');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(site.name)} \u2013 Help Desk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      transition: background-color 0.6s ease;
    }
    #site-name {
      font-size: clamp(1rem, 3vw, 1.8rem);
      color: rgba(255,255,255,0.75);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 0.4rem;
    }
    #status-text {
      font-size: clamp(3rem, 12vw, 9rem);
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      text-align: center;
      color: #fff;
      text-shadow: 0 4px 24px rgba(0,0,0,0.25);
      padding: 0 1rem;
    }
    #subtitle {
      margin-top: 1.5rem;
      font-size: clamp(1rem, 3vw, 1.8rem);
      color: rgba(255,255,255,0.85);
      letter-spacing: 0.06em;
    }
    .open   { background-color: #1a7a3a; }
    .closed { background-color: #b71c1c; }
    #clock  {
      margin-top: 2.5rem;
      font-size: clamp(1.1rem, 3vw, 1.8rem);
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.12em;
      color: rgba(255,255,255,0.55);
    }
  </style>
</head>
<body class="open">
  <div id="site-name">${escHtml(site.name)}</div>
  <div id="status-text">Help Desk is Open</div>
  <div id="subtitle">Walk-ins welcome</div>
  <div id="clock"></div>
  <script>
    (function tickClock() {
      document.getElementById('clock').textContent =
        new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setTimeout(tickClock, 1000 - (Date.now() % 1000));
    })();
    const SITE_ID = ${JSON.stringify(site.id)};
    function applyStatus(isOpen) {
      document.body.className = isOpen ? 'open' : 'closed';
      document.getElementById('status-text').textContent =
        isOpen ? 'Help Desk is Open' : 'Help Desk is Closed';
      document.getElementById('subtitle').textContent =
        isOpen ? 'Walk-ins welcome' : 'Please check back later';
    }
    async function poll() {
      try {
        const sites = await fetch('/api/sites').then(r => r.json());
        const site  = sites.find(s => s.id === SITE_ID);
        if (site) applyStatus(site.isOpen);
      } catch (e) { /* ignore */ }
    }
    poll();
    setInterval(poll, 5000);
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Admin page  –  manage all sites
// ---------------------------------------------------------------------------

app.get('/admin', requireAuth, (req, res) => {
  const userInfo = oidcClient && req.session.user
    ? `<span class="user-info">\u{1F464} ${escHtml(req.session.user.name)}</span><a href="/auth/logout" class="logout-link">Sign out</a>`
    : '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Help Desk Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      min-height: 100vh;
      background: #1e1e2e;
      color: #cdd6f4;
      padding: 2.5rem 1.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.5rem;
    }
    h1 { font-size: 1.6rem; letter-spacing: 0.05em; color: #89b4fa; }
    .nav-links { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; justify-content: center; }
    .nav-links a { color: #89b4fa; font-size: 0.9rem; text-decoration: none; }
    .nav-links a:hover { text-decoration: underline; }
    .user-info { font-size: 0.85rem; color: #a6adc8; }
    .logout-link { color: #f38ba8 !important; }
    #sites-list { width: 100%; max-width: 620px; display: flex; flex-direction: column; gap: 0.75rem; }
    .site-row {
      background: #2a2a3d;
      border-radius: 0.75rem;
      padding: 0.9rem 1.1rem;
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .site-info { flex: 1; min-width: 0; }
    .site-name { font-size: 1.05rem; font-weight: 600; }
    .site-link { font-size: 0.78rem; color: #89b4fa; text-decoration: none; display: inline-block; margin-top: 0.15rem; }
    .site-link:hover { text-decoration: underline; }
    .toggle-wrap { display: flex; flex-direction: column; align-items: center; gap: 0.2rem; }
    .switch { position: relative; width: 54px; height: 28px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; inset: 0;
      background: #b71c1c; border-radius: 28px;
      cursor: pointer; transition: background 0.3s;
    }
    .slider::before {
      content: ''; position: absolute;
      width: 22px; height: 22px; left: 3px; top: 3px;
      background: #fff; border-radius: 50%; transition: transform 0.3s;
    }
    .switch input:checked + .slider               { background: #1a7a3a; }
    .switch input:checked + .slider::before       { transform: translateX(26px); }
    .toggle-label { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #a6adc8; }
    .delete-btn {
      background: none; border: 1px solid #45475a; color: #f38ba8;
      border-radius: 0.4rem; padding: 0.3rem 0.65rem;
      cursor: pointer; font-size: 0.85rem; transition: background 0.2s; white-space: nowrap;
    }
    .delete-btn:hover { background: rgba(243,139,168,0.15); }
    #add-form {
      width: 100%; max-width: 620px; background: #2a2a3d;
      border-radius: 0.75rem; padding: 1.1rem 1.2rem;
      display: flex; gap: 0.75rem; align-items: center;
    }
    #new-site-name {
      flex: 1; background: #1e1e2e; border: 1px solid #45475a;
      border-radius: 0.5rem; color: #cdd6f4; padding: 0.6rem 0.9rem; font-size: 1rem;
    }
    #new-site-name::placeholder { color: #585b70; }
    #add-btn {
      background: #89b4fa; color: #1e1e2e; border: none;
      border-radius: 0.5rem; padding: 0.6rem 1.2rem;
      font-size: 1rem; font-weight: 700; cursor: pointer; white-space: nowrap;
    }
    #add-btn:hover { background: #b4d0fb; }
    #feedback { font-size: 0.9rem; color: #a6adc8; min-height: 1.2rem; }
    .empty-msg { color: #585b70; font-size: 0.95rem; text-align: center; padding: 0.8rem; }
    #clock     { font-size: 0.9rem; font-variant-numeric: tabular-nums; letter-spacing: 0.05em; color: #6c7086; }
  </style>
</head>
<body>
  <h1>Help Desk Admin</h1>
  <div class="nav-links">
    <a href="/">&#8592; Public overview</a>
    <a href="/admin/report">&#128202; Reports</a>
    ${userInfo}
  </div>
  <div id="clock"></div>
  <div id="sites-list"></div>
  <div id="add-form">
    <input id="new-site-name" type="text" placeholder="New site name (e.g. North Campus)" maxlength="80">
    <button id="add-btn">Add Site</button>
  </div>
  <div id="feedback"></div>
  <script>
    const XHR_HEADER = { 'X-Requested-With': 'XMLHttpRequest' };
    let sites = [];
    const list     = document.getElementById('sites-list');
    const feedback = document.getElementById('feedback');
    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    async function apiFetch(url, opts = {}) {
      const res = await fetch(url, opts);
      if (res.status === 401) { window.location.href = '/auth/login'; throw new Error('session expired'); }
      return res;
    }
    function render() {
      list.innerHTML = '';
      if (sites.length === 0) {
        list.innerHTML = '<p class="empty-msg">No sites yet \u2014 add one below.</p>';
        return;
      }
      for (const site of sites) {
        const row = document.createElement('div');
        row.className = 'site-row';
        row.innerHTML =
          '<div class="site-info">' +
            '<div class="site-name">' + esc(site.name) + '</div>' +
            '<a class="site-link" href="/site/' + esc(site.id) + '" target="_blank">/site/' + esc(site.id) + ' \u2197</a>' +
          '</div>' +
          '<div class="toggle-wrap">' +
            '<label class="switch">' +
              '<input type="checkbox" data-id="' + esc(site.id) + '"' + (site.isOpen ? ' checked' : '') + '>' +
              '<span class="slider"></span>' +
            '</label>' +
            '<span class="toggle-label" id="lbl-' + esc(site.id) + '">' + (site.isOpen ? 'Open' : 'Closed') + '</span>' +
          '</div>' +
          '<button class="delete-btn" data-id="' + esc(site.id) + '">Delete</button>';
        list.appendChild(row);
      }
    }
    async function loadSites() {
      try {
        sites = await fetch('/api/sites').then(r => r.json());
        render();
      } catch (e) { feedback.textContent = 'Could not reach server.'; }
    }
    list.addEventListener('change', async (e) => {
      if (e.target.type !== 'checkbox') return;
      const id = e.target.dataset.id;
      try {
        const updated = await apiFetch('/api/sites/' + id + '/toggle', {
          method: 'POST',
          headers: XHR_HEADER,
        }).then(r => r.json());
        const s = sites.find(s => s.id === id);
        if (s) s.isOpen = updated.isOpen;
        const lbl = document.getElementById('lbl-' + id);
        if (lbl) lbl.textContent = updated.isOpen ? 'Open' : 'Closed';
        e.target.checked = updated.isOpen;
        feedback.textContent = esc(updated.name) + ' marked as ' + (updated.isOpen ? 'OPEN' : 'CLOSED') + '.';
      } catch (err) {
        if (err.message !== 'session expired') feedback.textContent = 'Error \u2014 please try again.';
        e.target.checked = !e.target.checked;
      }
    });
    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.delete-btn');
      if (!btn) return;
      const id   = btn.dataset.id;
      const site = sites.find(s => s.id === id);
      if (!confirm('Delete "' + (site ? site.name : id) + '"?')) return;
      try {
        await apiFetch('/api/sites/' + id, { method: 'DELETE', headers: XHR_HEADER });
        sites = sites.filter(s => s.id !== id);
        render();
        feedback.textContent = 'Site deleted.';
      } catch (err) {
        if (err.message !== 'session expired') feedback.textContent = 'Error \u2014 please try again.';
      }
    });
    document.getElementById('add-btn').addEventListener('click', async () => {
      const input = document.getElementById('new-site-name');
      const name  = input.value.trim();
      if (!name) { feedback.textContent = 'Please enter a site name.'; return; }
      try {
        const site = await apiFetch('/api/sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...XHR_HEADER },
          body: JSON.stringify({ name }),
        }).then(r => r.json());
        if (site.error) { feedback.textContent = site.error; return; }
        sites.push(site);
        render();
        input.value = '';
        feedback.textContent = 'Site "' + esc(site.name) + '" added. Public URL: /site/' + esc(site.id);
      } catch (err) {
        if (err.message !== 'session expired') feedback.textContent = 'Error \u2014 please try again.';
      }
    });
    document.getElementById('new-site-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('add-btn').click();
    });
    loadSites();
    setInterval(loadSites, 10000);
    (function tickClock() {
      document.getElementById('clock').textContent =
        new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setTimeout(tickClock, 1000 - (Date.now() % 1000));
    })();
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Admin report page  –  business hours config + open/closed time reporting
// ---------------------------------------------------------------------------

app.get('/admin/report', requireAuth, (req, res) => {
  const userInfo = oidcClient && req.session.user
    ? `<span class="user-info">\u{1F464} ${escHtml(req.session.user.name)}</span><a href="/auth/logout" class="logout-link">Sign out</a>`
    : '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Help Desk Reports</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      min-height: 100vh;
      background: #1e1e2e;
      color: #cdd6f4;
      padding: 2.5rem 1.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.5rem;
    }
    h1 { font-size: 1.6rem; letter-spacing: 0.05em; color: #89b4fa; }
    h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.07em; color: #89b4fa; margin-bottom: 1rem; }
    .nav-links { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; justify-content: center; }
    .nav-links a { color: #89b4fa; font-size: 0.9rem; text-decoration: none; }
    .nav-links a:hover { text-decoration: underline; }
    .user-info { font-size: 0.85rem; color: #a6adc8; }
    .logout-link { color: #f38ba8 !important; }
    .card {
      background: #2a2a3d;
      border-radius: 0.75rem;
      padding: 1.4rem 1.6rem;
      width: 100%;
      max-width: 720px;
    }

    /* ---- per-site business hours ---- */
    .site-bh-row {
      padding: 1rem 0;
      border-bottom: 1px solid #313244;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .site-bh-row:first-child { padding-top: 0; }
    .site-bh-row:last-child  { border-bottom: none; padding-bottom: 0; }
    .site-bh-name { font-size: 1rem; font-weight: 600; }
    .days-row { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .day-btn {
      padding: 0.3rem 0.6rem;
      border-radius: 0.4rem;
      border: 1px solid #45475a;
      background: #1e1e2e;
      color: #a6adc8;
      cursor: pointer;
      font-size: 0.82rem;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .day-btn.active { background: #89b4fa; color: #1e1e2e; border-color: #89b4fa; font-weight: 700; }
    .time-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .time-row label { font-size: 0.85rem; color: #a6adc8; }
    input[type="time"], input[type="date"] {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 0.4rem;
      color: #cdd6f4;
      padding: 0.38rem 0.6rem;
      font-size: 0.9rem;
    }
    .empty-msg { color: #585b70; font-size: 0.9rem; }

    /* ---- date range ---- */
    .range-form { display: flex; flex-direction: column; gap: 1rem; }
    .date-row   { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .date-row label { font-size: 0.88rem; color: #a6adc8; }
    .presets    { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .preset-btn {
      padding: 0.3rem 0.7rem;
      border-radius: 0.4rem;
      border: 1px solid #45475a;
      background: #1e1e2e;
      color: #a6adc8;
      cursor: pointer;
      font-size: 0.8rem;
      transition: background 0.15s;
    }
    .preset-btn:hover { background: #313244; }

    /* ---- buttons ---- */
    .btn {
      background: #89b4fa; color: #1e1e2e; border: none;
      border-radius: 0.5rem; padding: 0.5rem 1.2rem;
      font-size: 0.92rem; font-weight: 700; cursor: pointer;
    }
    .btn:hover { background: #b4d0fb; }
    .inline-note { margin-left: 0.6rem; font-size: 0.8rem; color: #a6adc8; }

    /* ---- results table ---- */
    .summary { font-size: 0.88rem; color: #a6adc8; margin-bottom: 1.1rem; }
    table { width: 100%; border-collapse: collapse; }
    th {
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
      color: #6c7086; padding: 0.45rem 0.65rem; text-align: left;
      border-bottom: 1px solid #313244;
    }
    td { padding: 0.65rem 0.65rem; font-size: 0.9rem; border-bottom: 1px solid #1e1e2e; }
    .bar-wrap { display: flex; align-items: center; gap: 0.5rem; }
    .bar-bg   { flex: 1; background: #1e1e2e; border-radius: 4px; height: 7px; min-width: 50px; }
    .bar-fill { background: #1a7a3a; border-radius: 4px; height: 7px; }
    .pct-val  { font-size: 0.83rem; color: #a6e3a1; font-weight: 700; white-space: nowrap; }
    #error-msg { font-size: 0.9rem; color: #f38ba8; min-height: 1.2rem; }
    #clock     { font-size: 0.9rem; font-variant-numeric: tabular-nums; letter-spacing: 0.05em; color: #6c7086; }
  </style>
</head>
<body>
  <h1>Help Desk Reports</h1>
  <div class="nav-links">
    <a href="/admin">&#8592; Back to Admin</a>
    ${userInfo}
  </div>
  <div id="clock"></div>

  <!-- Per-site business hours config -->
  <div class="card">
    <h2>Business Hours</h2>
    <div id="bh-container"><p class="empty-msg">Loading\u2026</p></div>
  </div>

  <!-- Date range + generate -->
  <div class="card">
    <h2>Generate Report</h2>
    <div class="range-form">
      <div class="date-row">
        <label for="from-date">From</label>
        <input type="date" id="from-date">
        <label for="to-date">To</label>
        <input type="date" id="to-date">
      </div>
      <div class="presets">
        <button class="preset-btn" data-preset="this-week">This Week</button>
        <button class="preset-btn" data-preset="last-week">Last Week</button>
        <button class="preset-btn" data-preset="this-month">This Month</button>
        <button class="preset-btn" data-preset="last-month">Last Month</button>
        <button class="preset-btn" data-preset="last-30">Last 30 Days</button>
      </div>
      <div>
        <button class="btn" id="gen-btn">Generate</button>
      </div>
    </div>
  </div>

  <!-- Results -->
  <div class="card" id="results-card" style="display:none">
    <h2>Results</h2>
    <div class="summary" id="results-summary"></div>
    <table>
      <thead>
        <tr>
          <th>Site</th>
          <th>Biz Hrs Total</th>
          <th>Open</th>
          <th>Closed</th>
          <th>Open %</th>
        </tr>
      </thead>
      <tbody id="results-body"></tbody>
    </table>
  </div>

  <div id="error-msg"></div>

  <script>
    const XHR_HEADER = { 'X-Requested-With': 'XMLHttpRequest' };

    // ---- helpers ----
    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function fmtMins(m) {
      const h = Math.floor(m / 60), min = m % 60;
      if (h === 0) return min + 'm';
      return h + 'h' + (min > 0 ? ' ' + min + 'm' : '');
    }
    function localDateStr(d) {
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    }
    async function apiFetch(url, opts = {}) {
      const res = await fetch(url, opts);
      if (res.status === 401) { window.location.href = '/auth/login'; throw new Error('session expired'); }
      return res;
    }

    // ---- per-site business hours ----
    let sitesData = [];

    async function loadSites() {
      try {
        sitesData = await fetch('/api/sites').then(r => r.json());
        renderBHForms();
      } catch (e) {
        document.getElementById('bh-container').textContent = 'Could not load sites.';
      }
    }

    function renderBHForms() {
      const container = document.getElementById('bh-container');
      container.innerHTML = '';
      if (sitesData.length === 0) {
        container.innerHTML = '<p class="empty-msg">No sites configured. Add sites from the <a href="/admin" style="color:#89b4fa">Admin</a> panel.</p>';
        return;
      }
      for (const site of sitesData) {
        const bh = site.businessHours || { start: '08:00', end: '17:00', days: [1,2,3,4,5] };
        const activeDays = new Set(bh.days); // per-site closure

        const row = document.createElement('div');
        row.className = 'site-bh-row';
        row.innerHTML =
          '<div class="site-bh-name">' + esc(site.name) + '</div>' +
          '<div class="days-row">' +
            [['Sun',0],['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6]].map(([lbl, i]) =>
              '<button class="day-btn' + (activeDays.has(i) ? ' active' : '') + '" data-day="' + i + '">' + lbl + '</button>'
            ).join('') +
          '</div>' +
          '<div class="time-row">' +
            '<label>Open</label>' +
            '<input type="time" class="bh-start" value="' + esc(bh.start) + '">' +
            '<label>Close</label>' +
            '<input type="time" class="bh-end" value="' + esc(bh.end) + '">' +
            '<button class="btn save-bh-btn">Save</button>' +
            '<span class="inline-note bh-note"></span>' +
          '</div>';

        row.querySelectorAll('.day-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const d = Number(btn.dataset.day);
            if (activeDays.has(d)) activeDays.delete(d); else activeDays.add(d);
            btn.classList.toggle('active', activeDays.has(d));
          });
        });

        row.querySelector('.save-bh-btn').addEventListener('click', async () => {
          const note = row.querySelector('.bh-note');
          try {
            const updated = await apiFetch('/api/sites/' + site.id + '/business-hours', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...XHR_HEADER },
              body: JSON.stringify({
                start: row.querySelector('.bh-start').value,
                end:   row.querySelector('.bh-end').value,
                days:  [...activeDays],
              }),
            }).then(r => r.json());
            const s = sitesData.find(s => s.id === site.id);
            if (s) s.businessHours = updated;
            note.textContent = 'Saved!';
            setTimeout(() => { note.textContent = ''; }, 2000);
          } catch (e) {
            if (e.message !== 'session expired') note.textContent = 'Error saving.';
          }
        });

        container.appendChild(row);
      }
    }

    // ---- date presets ----
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        let from, to;
        switch (btn.dataset.preset) {
          case 'this-week': {
            const dow = today.getDay();
            const diff = dow === 0 ? -6 : 1 - dow;
            from = new Date(today); from.setDate(today.getDate() + diff);
            to   = today; break;
          }
          case 'last-week': {
            const dow = today.getDay();
            const diff = dow === 0 ? -6 : 1 - dow;
            const mon = new Date(today); mon.setDate(today.getDate() + diff);
            from = new Date(mon); from.setDate(mon.getDate() - 7);
            to   = new Date(mon); to.setDate(mon.getDate() - 1); break;
          }
          case 'this-month': {
            from = new Date(today.getFullYear(), today.getMonth(), 1);
            to   = today; break;
          }
          case 'last-month': {
            from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            to   = new Date(today.getFullYear(), today.getMonth(), 0); break;
          }
          case 'last-30': {
            from = new Date(today); from.setDate(today.getDate() - 29);
            to   = today; break;
          }
        }
        if (from && to) {
          document.getElementById('from-date').value = localDateStr(from);
          document.getElementById('to-date').value   = localDateStr(to);
        }
      });
    });

    // ---- generate report ----
    document.getElementById('gen-btn').addEventListener('click', async () => {
      const from  = document.getElementById('from-date').value;
      const to    = document.getElementById('to-date').value;
      const errEl = document.getElementById('error-msg');
      errEl.textContent = '';
      if (!from || !to) { errEl.textContent = 'Please select a date range.'; return; }
      try {
        const data = await apiFetch('/api/report?from=' + from + '&to=' + to).then(r => r.json());
        if (data.error) { errEl.textContent = data.error; return; }
        renderReport(data, from, to);
      } catch (e) {
        if (e.message !== 'session expired') errEl.textContent = 'Error generating report.';
      }
    });

    function renderReport(data, from, to) {
      const summary = document.getElementById('results-summary');
      const body    = document.getElementById('results-body');

      summary.textContent = from + ' \u2013 ' + to;

      body.innerHTML = '';
      for (const site of data.sites) {
        const pct = site.openPct;
        const tr  = document.createElement('tr');
        tr.innerHTML =
          '<td>' + esc(site.name) + '</td>' +
          '<td style="color:#a6adc8">'  + fmtMins(site.totalBizMins) + '</td>' +
          '<td style="color:#a6e3a1">'  + fmtMins(site.openMins)     + '</td>' +
          '<td style="color:#f38ba8">'  + fmtMins(site.closedMins)   + '</td>' +
          '<td>' +
            '<div class="bar-wrap">' +
              '<div class="bar-bg"><div class="bar-fill" style="width:' + Math.min(pct, 100) + '%"></div></div>' +
              '<span class="pct-val">' + pct + '%</span>' +
            '</div>' +
          '</td>';
        body.appendChild(tr);
      }
      document.getElementById('results-card').style.display = '';
      document.getElementById('results-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ---- init ----
    loadSites();
    (function() {
      const today = new Date();
      document.getElementById('from-date').value = localDateStr(new Date(today.getFullYear(), today.getMonth(), 1));
      document.getElementById('to-date').value   = localDateStr(today);
    })();
    (function tickClock() {
      document.getElementById('clock').textContent =
        new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setTimeout(tickClock, 1000 - (Date.now() % 1000));
    })();
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------

async function start() {
  await initOIDC();
  app.listen(PORT, () => {
    console.log(`Help Desk Status running at http://localhost:${PORT}`);
    console.log(`  Public overview : http://localhost:${PORT}/`);
    console.log(`  Admin panel     : http://localhost:${PORT}/admin`);
    console.log(`  Reports         : http://localhost:${PORT}/admin/report`);
    if (oidcClient) {
      console.log(`  OIDC callback   : ${OIDC_REDIRECT_URI}`);
    }
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
