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
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { isOpen: true };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

let state = loadState();

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/status', (req, res) => {
  res.json({ isOpen: state.isOpen });
});

app.post('/api/toggle', (req, res) => {
  state.isOpen = !state.isOpen;
  saveState(state);
  res.json({ isOpen: state.isOpen });
});

// ---------------------------------------------------------------------------
// Public status page  (shown on a TV / monitor in hallways, etc.)
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
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      transition: background-color 0.6s ease;
    }

    #status-text {
      font-size: clamp(3rem, 12vw, 9rem);
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      text-align: center;
      color: #fff;
      text-shadow: 0 4px 24px rgba(0,0,0,0.25);
      line-height: 1.15;
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
  <div id="status-text">Help Desk is Open</div>
  <div id="subtitle">Walk-ins welcome</div>

  <script>
    function applyStatus(isOpen) {
      document.body.className = isOpen ? 'open' : 'closed';
      document.getElementById('status-text').textContent =
        isOpen ? 'Help Desk is Open' : 'Help Desk is Closed';
      document.getElementById('subtitle').textContent =
        isOpen ? 'Walk-ins welcome' : 'Please check back later';
    }

    async function poll() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        applyStatus(data.isOpen);
      } catch (e) {
        // silently ignore network hiccups
      }
    }

    poll();
    setInterval(poll, 5000);   // refresh every 5 seconds
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Tech admin page  (bookmarked by helpdesk staff)
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
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #1e1e2e;
      color: #cdd6f4;
      gap: 2rem;
      padding: 2rem;
    }

    h1 {
      font-size: 1.6rem;
      letter-spacing: 0.05em;
      color: #89b4fa;
    }

    #indicator {
      font-size: 2.4rem;
      font-weight: 700;
      padding: 0.6rem 2.4rem;
      border-radius: 2rem;
      letter-spacing: 0.06em;
      transition: background 0.4s, color 0.4s;
    }
    .open-badge   { background: #1a7a3a; color: #fff; }
    .closed-badge { background: #b71c1c; color: #fff; }

    #toggle-btn {
      font-size: 1.5rem;
      font-weight: 700;
      padding: 1.1rem 3.2rem;
      border: none;
      border-radius: 0.75rem;
      cursor: pointer;
      letter-spacing: 0.04em;
      transition: background 0.2s, transform 0.1s;
      min-width: 280px;
    }
    #toggle-btn:active { transform: scale(0.97); }

    .btn-close { background: #b71c1c; color: #fff; }
    .btn-open  { background: #1a7a3a; color: #fff; }
    .btn-close:hover { background: #d32f2f; }
    .btn-open:hover  { background: #2e7d32; }

    #feedback {
      font-size: 0.95rem;
      color: #a6adc8;
      min-height: 1.4rem;
    }
  </style>
</head>
<body>
  <h1>Help Desk Admin</h1>
  <div id="indicator" class="open-badge">OPEN</div>
  <button id="toggle-btn" class="btn-close">Close the Help Desk</button>
  <div id="feedback"></div>

  <script>
    const indicator  = document.getElementById('indicator');
    const btn        = document.getElementById('toggle-btn');
    const feedback   = document.getElementById('feedback');

    let currentlyOpen = true;

    function applyStatus(isOpen) {
      currentlyOpen = isOpen;
      if (isOpen) {
        indicator.textContent = 'OPEN';
        indicator.className   = 'open-badge';
        btn.textContent       = 'Close the Help Desk';
        btn.className         = 'btn-close';
      } else {
        indicator.textContent = 'CLOSED';
        indicator.className   = 'closed-badge';
        btn.textContent       = 'Open the Help Desk';
        btn.className         = 'btn-open';
      }
    }

    async function fetchStatus() {
      try {
        const res  = await fetch('/api/status');
        const data = await res.json();
        applyStatus(data.isOpen);
      } catch (e) {
        feedback.textContent = 'Could not reach server.';
      }
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      feedback.textContent = 'Updating\u2026';
      try {
        const res  = await fetch('/api/toggle', { method: 'POST' });
        const data = await res.json();
        applyStatus(data.isOpen);
        feedback.textContent = data.isOpen
          ? 'Help desk marked as OPEN.'
          : 'Help desk marked as CLOSED.';
      } catch (e) {
        feedback.textContent = 'Error — please try again.';
      } finally {
        btn.disabled = false;
      }
    });

    fetchStatus();
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Help Desk Status running at http://localhost:${PORT}`);
  console.log(`  Public board : http://localhost:${PORT}/`);
  console.log(`  Admin panel  : http://localhost:${PORT}/admin`);
});
