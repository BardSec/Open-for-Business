const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');

app.use(express.json());

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Migrate legacy single-site format { isOpen: bool }
    if (typeof raw.isOpen === 'boolean' && !raw.sites) {
      return { sites: [{ id: 'main', name: 'Help Desk', isOpen: raw.isOpen }] };
    }
    return raw;
  } catch {
    return { sites: [{ id: 'main', name: 'Help Desk', isOpen: true }] };
  }
}

function saveState() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/sites', (req, res) => {
  res.json(state.sites);
});

app.post('/api/sites', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const site = { id: uniqueId(name), name, isOpen: true };
  state.sites.push(site);
  saveState();
  res.status(201).json(site);
});

app.delete('/api/sites/:id', (req, res) => {
  const idx = state.sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  state.sites.splice(idx, 1);
  saveState();
  res.json({ ok: true });
});

app.post('/api/sites/:id/toggle', (req, res) => {
  const site = state.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  site.isOpen = !site.isOpen;
  saveState();
  res.json(site);
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
    h1 {
      font-size: clamp(1.6rem, 4vw, 2.8rem);
      letter-spacing: 0.04em;
      text-align: center;
    }
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
  </style>
</head>
<body>
  <h1>Help Desk Status</h1>
  <div id="grid"></div>

  <script>
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
      } catch (e) { /* ignore network hiccups */ }
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
  <title>${escHtml(site.name)} – Help Desk</title>
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
  </style>
</head>
<body class="open">
  <div id="site-name">${escHtml(site.name)}</div>
  <div id="status-text">Help Desk is Open</div>
  <div id="subtitle">Walk-ins welcome</div>

  <script>
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

app.get('/admin', (req, res) => {
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

    a.overview-link { color: #89b4fa; font-size: 0.9rem; text-decoration: none; }
    a.overview-link:hover { text-decoration: underline; }

    /* ---- sites list ---- */
    #sites-list {
      width: 100%;
      max-width: 620px;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
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
    .site-link {
      font-size: 0.78rem;
      color: #89b4fa;
      text-decoration: none;
      display: inline-block;
      margin-top: 0.15rem;
    }
    .site-link:hover { text-decoration: underline; }

    /* ---- toggle switch ---- */
    .toggle-wrap { display: flex; flex-direction: column; align-items: center; gap: 0.2rem; }
    .switch { position: relative; width: 54px; height: 28px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      inset: 0;
      background: #b71c1c;
      border-radius: 28px;
      cursor: pointer;
      transition: background 0.3s;
    }
    .slider::before {
      content: '';
      position: absolute;
      width: 22px; height: 22px;
      left: 3px; top: 3px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.3s;
    }
    .switch input:checked + .slider               { background: #1a7a3a; }
    .switch input:checked + .slider::before       { transform: translateX(26px); }
    .toggle-label {
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #a6adc8;
    }

    /* ---- delete button ---- */
    .delete-btn {
      background: none;
      border: 1px solid #45475a;
      color: #f38ba8;
      border-radius: 0.4rem;
      padding: 0.3rem 0.65rem;
      cursor: pointer;
      font-size: 0.85rem;
      transition: background 0.2s;
      white-space: nowrap;
    }
    .delete-btn:hover { background: rgba(243,139,168,0.15); }

    /* ---- add-site form ---- */
    #add-form {
      width: 100%;
      max-width: 620px;
      background: #2a2a3d;
      border-radius: 0.75rem;
      padding: 1.1rem 1.2rem;
      display: flex;
      gap: 0.75rem;
      align-items: center;
    }
    #new-site-name {
      flex: 1;
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 0.5rem;
      color: #cdd6f4;
      padding: 0.6rem 0.9rem;
      font-size: 1rem;
    }
    #new-site-name::placeholder { color: #585b70; }
    #add-btn {
      background: #89b4fa;
      color: #1e1e2e;
      border: none;
      border-radius: 0.5rem;
      padding: 0.6rem 1.2rem;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }
    #add-btn:hover { background: #b4d0fb; }

    #feedback { font-size: 0.9rem; color: #a6adc8; min-height: 1.2rem; }
    .empty-msg { color: #585b70; font-size: 0.95rem; text-align: center; padding: 0.8rem; }
  </style>
</head>
<body>
  <h1>Help Desk Admin</h1>
  <a class="overview-link" href="/">← Public overview</a>

  <div id="sites-list"></div>

  <div id="add-form">
    <input id="new-site-name" type="text" placeholder="New site name (e.g. North Campus)" maxlength="80">
    <button id="add-btn">Add Site</button>
  </div>

  <div id="feedback"></div>

  <script>
    let sites = [];
    const list     = document.getElementById('sites-list');
    const feedback = document.getElementById('feedback');

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function render() {
      list.innerHTML = '';
      if (sites.length === 0) {
        list.innerHTML = '<p class="empty-msg">No sites yet — add one below.</p>';
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
      } catch (e) {
        feedback.textContent = 'Could not reach server.';
      }
    }

    // Toggle open/closed
    list.addEventListener('change', async (e) => {
      if (e.target.type !== 'checkbox') return;
      const id = e.target.dataset.id;
      try {
        const updated = await fetch('/api/sites/' + id + '/toggle', { method: 'POST' }).then(r => r.json());
        const s = sites.find(s => s.id === id);
        if (s) s.isOpen = updated.isOpen;
        const lbl = document.getElementById('lbl-' + id);
        if (lbl) lbl.textContent = updated.isOpen ? 'Open' : 'Closed';
        e.target.checked = updated.isOpen;
        feedback.textContent = esc(updated.name) + ' marked as ' + (updated.isOpen ? 'OPEN' : 'CLOSED') + '.';
      } catch (err) {
        feedback.textContent = 'Error — please try again.';
        e.target.checked = !e.target.checked;
      }
    });

    // Delete site
    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.delete-btn');
      if (!btn) return;
      const id   = btn.dataset.id;
      const site = sites.find(s => s.id === id);
      if (!confirm('Delete "' + (site ? site.name : id) + '"?')) return;
      try {
        await fetch('/api/sites/' + id, { method: 'DELETE' });
        sites = sites.filter(s => s.id !== id);
        render();
        feedback.textContent = 'Site deleted.';
      } catch (err) {
        feedback.textContent = 'Error — please try again.';
      }
    });

    // Add new site
    document.getElementById('add-btn').addEventListener('click', async () => {
      const input = document.getElementById('new-site-name');
      const name  = input.value.trim();
      if (!name) { feedback.textContent = 'Please enter a site name.'; return; }
      try {
        const site = await fetch('/api/sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        }).then(r => r.json());
        if (site.error) { feedback.textContent = site.error; return; }
        sites.push(site);
        render();
        input.value = '';
        feedback.textContent = 'Site "' + site.name + '" added. Public URL: /site/' + site.id;
      } catch (err) {
        feedback.textContent = 'Error — please try again.';
      }
    });

    document.getElementById('new-site-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('add-btn').click();
    });

    loadSites();
    setInterval(loadSites, 10000);
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Help Desk Status running at http://localhost:${PORT}`);
  console.log(`  Public overview : http://localhost:${PORT}/`);
  console.log(`  Admin panel     : http://localhost:${PORT}/admin`);
});
