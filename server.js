/**
 * ============================================================
 *  GPS Speed Monitor — Mini Server  v1.0
 *  Node.js + Express + SQLite
 *
 *  Endpoints
 *  ---------
 *  POST /api/violation        ← ESP32 posts alerts here
 *  GET  /api/violations       ← fetch all violations (JSON)
 *  GET  /api/violations/:id   ← single violation
 *  GET  /api/stats            ← summary statistics
 *  GET  /api/devices          ← list of seen devices
 *  DELETE /api/violations     ← clear all records (admin)
 *
 *  GET  /                     ← live web dashboard
 *
 *  Config via .env or environment variables:
 *    PORT=3000
 *    ADMIN_KEY=changeme        ← required for DELETE
 * ============================================================
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const morgan   = require('morgan');
const path     = require('path');
const Database = require('better-sqlite3');

// ── Config ──────────────────────────────────────────────────
const PORT      = process.env.PORT      || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
const DB_FILE   = process.env.DB_FILE   || path.join(__dirname, 'violations.db');

// ── Database setup ──────────────────────────────────────────
const db = new Database(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS violations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device      TEXT    NOT NULL,
    speed       REAL    NOT NULL,
    speed_limit REAL    NOT NULL,
    excess      REAL    NOT NULL,
    tier        TEXT    NOT NULL,
    lat         REAL,
    lon         REAL,
    received_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_device   ON violations(device);
  CREATE INDEX IF NOT EXISTS idx_tier     ON violations(tier);
  CREATE INDEX IF NOT EXISTS idx_received ON violations(received_at);
`);

console.log(`[DB]  SQLite ready — ${DB_FILE}`);

// Prepared statements
const stmtInsert = db.prepare(`
  INSERT INTO violations (device, speed, speed_limit, excess, tier, lat, lon)
  VALUES (@device, @speed, @speed_limit, @excess, @tier, @lat, @lon)
`);

const stmtAll = db.prepare(`
  SELECT * FROM violations ORDER BY received_at DESC LIMIT ?
`);

const stmtById = db.prepare(`SELECT * FROM violations WHERE id = ?`);

const stmtStats = db.prepare(`
  SELECT
    COUNT(*)                                        AS total,
    COUNT(DISTINCT device)                          AS devices,
    ROUND(AVG(excess), 2)                           AS avg_excess,
    ROUND(MAX(speed),  2)                           AS max_speed,
    SUM(CASE WHEN tier = 'SEVERE'   THEN 1 ELSE 0 END) AS severe,
    SUM(CASE WHEN tier = 'MODERATE' THEN 1 ELSE 0 END) AS moderate,
    SUM(CASE WHEN tier = 'MINOR'    THEN 1 ELSE 0 END) AS minor
  FROM violations
`);

const stmtDevices = db.prepare(`
  SELECT
    device,
    COUNT(*)          AS total_violations,
    MAX(speed)        AS max_speed,
    MAX(received_at)  AS last_seen
  FROM violations
  GROUP BY device
  ORDER BY last_seen DESC
`);

// ── Express app ──────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ── Validation helper ────────────────────────────────────────
function validateViolation(body) {
  const errors = [];
  if (typeof body.speed       !== 'number') errors.push('speed must be a number');
  if (typeof body.limit       !== 'number') errors.push('limit must be a number');
  if (!body.tier)                            errors.push('tier is required');
  if (!['MINOR','MODERATE','SEVERE'].includes(body.tier))
    errors.push('tier must be MINOR, MODERATE or SEVERE');
  return errors;
}

// ══════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════

// POST /api/violation  ← ESP32 sends here
app.post('/api/violation', (req, res) => {
  const { device = 'UNKNOWN', speed, limit, excess, tier, lat = null, lon = null } = req.body;

  const errors = validateViolation(req.body);
  if (errors.length) {
    return res.status(400).json({ ok: false, errors });
  }

  const row = {
    device,
    speed:       parseFloat(speed),
    speed_limit: parseFloat(limit),
    excess:      parseFloat(excess ?? (speed - limit)),
    tier:        String(tier).toUpperCase(),
    lat:         lat  != null ? parseFloat(lat)  : null,
    lon:         lon  != null ? parseFloat(lon)  : null,
  };

  try {
    const info = stmtInsert.run(row);
    console.log(`[POST] #${info.lastInsertRowid} | ${device} | ${tier} | ${speed} km/h (limit ${limit})`);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('[POST] DB error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
});

// GET /api/violations?limit=100&tier=SEVERE&device=ESP32-01
app.get('/api/violations', (req, res) => {
  let limit  = Math.min(parseInt(req.query.limit  || '200'), 1000);
  const tier   = req.query.tier   ? String(req.query.tier).toUpperCase()  : null;
  const device = req.query.device ? String(req.query.device) : null;

  let query  = 'SELECT * FROM violations';
  const where = [];
  const params = [];

  if (tier)   { where.push('tier = ?');   params.push(tier);   }
  if (device) { where.push('device = ?'); params.push(device); }
  if (where.length) query += ' WHERE ' + where.join(' AND ');
  query += ' ORDER BY received_at DESC LIMIT ?';
  params.push(limit);

  try {
    const rows = db.prepare(query).all(...params);
    return res.json({ ok: true, count: rows.length, violations: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/violations/:id
app.get('/api/violations/:id', (req, res) => {
  const row = stmtById.get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  return res.json({ ok: true, violation: row });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const stats = stmtStats.get();
  const devices = stmtDevices.all();
  return res.json({ ok: true, stats, devices });
});

// GET /api/devices
app.get('/api/devices', (req, res) => {
  return res.json({ ok: true, devices: stmtDevices.all() });
});

// DELETE /api/violations  (requires ?key=ADMIN_KEY)
app.delete('/api/violations', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  db.exec('DELETE FROM violations');
  console.log('[ADMIN] Violations table cleared');
  return res.json({ ok: true, message: 'All violations deleted' });
});

// ══════════════════════════════════════════════════════════
//  DASHBOARD  (served at GET /)
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.send(getDashboardHTML());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPS Speed Monitor — Server Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
       background:#0d1117;color:#e6edf3;min-height:100vh}
  .header{background:#161b22;padding:16px 28px;border-bottom:1px solid #30363d;
          display:flex;justify-content:space-between;align-items:center}
  .header h1{color:#58a6ff;font-size:1.25rem}
  .header span{color:#8b949e;font-size:.8rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
        gap:16px;padding:24px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:10px;
        padding:20px;text-align:center;transition:border-color .2s}
  .card:hover{border-color:#58a6ff}
  .card .val{font-size:2.4rem;font-weight:700;margin:8px 0}
  .card .lbl{font-size:.7rem;color:#8b949e;text-transform:uppercase;letter-spacing:.06em}
  .green{color:#3fb950} .yellow{color:#e3b341} .red{color:#f85149} .blue{color:#58a6ff}
  .section{padding:0 24px 28px}
  .section h2{font-size:.95rem;color:#8b949e;padding:12px 0 8px;
              border-bottom:1px solid #30363d;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:.83rem}
  th{background:#21262d;padding:9px 14px;text-align:left;color:#8b949e;
     border-bottom:1px solid #30363d}
  td{padding:9px 14px;border-bottom:1px solid #21262d}
  tr:hover td{background:#161b22}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.72rem;
         font-weight:600;border:1px solid}
  .b-severe  {color:#f85149;border-color:#f85149;background:#2d0f0e}
  .b-moderate{color:#e3b341;border-color:#e3b341;background:#2d1f00}
  .b-minor   {color:#79c0ff;border-color:#79c0ff;background:#0d1f36}
  .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;
           padding:16px 24px 0;margin-bottom:-8px}
  .toolbar select,.toolbar input{background:#21262d;border:1px solid #30363d;
    border-radius:6px;padding:6px 10px;color:#e6edf3;font-size:.85rem}
  .toolbar button{background:#238636;color:#fff;border:none;border-radius:6px;
    padding:6px 14px;cursor:pointer;font-size:.85rem}
  .toolbar button:hover{background:#2ea043}
  .toolbar .del-btn{background:#da3633}
  .toolbar .del-btn:hover{background:#b91c1c}
  #liveTag{background:#3fb950;color:#000;padding:2px 8px;border-radius:10px;
           font-size:.72rem;font-weight:700;animation:pulse 1.4s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .empty{color:#8b949e;padding:20px;text-align:center;font-size:.85rem}
  .map-link{color:#58a6ff;font-size:.75rem;text-decoration:none}
  .map-link:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="header">
  <h1>&#x1F6E6; GPS Speed Monitor &mdash; Server</h1>
  <span><span id="liveTag">LIVE</span> &nbsp; Auto-refresh every 5s &nbsp;|&nbsp; Port ${PORT}</span>
</div>

<!-- Stat cards filled by JS -->
<div class="grid" id="statGrid">
  <div class="card"><div class="lbl">Total Violations</div><div class="val blue" id="sTotal">—</div></div>
  <div class="card"><div class="lbl">Severe</div><div class="val red"   id="sSevere">—</div></div>
  <div class="card"><div class="lbl">Moderate</div><div class="val yellow" id="sModerate">—</div></div>
  <div class="card"><div class="lbl">Minor</div><div class="val blue"  id="sMinor">—</div></div>
  <div class="card"><div class="lbl">Avg Excess</div><div class="val yellow" id="sAvgExcess">—</div><div class="lbl">km/h</div></div>
  <div class="card"><div class="lbl">Max Speed</div><div class="val red" id="sMaxSpeed">—</div><div class="lbl">km/h</div></div>
  <div class="card"><div class="lbl">Devices Seen</div><div class="val green" id="sDevices">—</div></div>
</div>

<!-- Toolbar -->
<div class="toolbar">
  <select id="filterTier" onchange="loadViolations()">
    <option value="">All tiers</option>
    <option value="SEVERE">Severe only</option>
    <option value="MODERATE">Moderate only</option>
    <option value="MINOR">Minor only</option>
  </select>
  <input id="filterDevice" placeholder="Filter by device ID" onkeyup="loadViolations()">
  <button onclick="loadAll()">&#x21BB; Refresh</button>
  <button class="del-btn" onclick="clearAll()">&#x1F5D1; Clear All</button>
  <span style="color:#8b949e;font-size:.8rem" id="countLabel"></span>
</div>

<!-- Violations table -->
<div class="section" style="padding-top:16px">
  <h2>Recent Violations</h2>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Device</th><th>Tier</th><th>Speed</th>
        <th>Limit</th><th>Excess</th><th>Location</th><th>Received</th>
      </tr>
    </thead>
    <tbody id="tbody"><tr><td colspan="8" class="empty">Loading...</td></tr></tbody>
  </table>
</div>

<!-- Device list -->
<div class="section">
  <h2>Devices</h2>
  <table>
    <thead><tr><th>Device ID</th><th>Violations</th><th>Max Speed</th><th>Last Seen</th></tr></thead>
    <tbody id="devTbody"></tbody>
  </table>
</div>

<div style="padding:16px 24px;color:#6e7681;font-size:.75rem">
  API: &nbsp;
  <a href="/api/violations" style="color:#58a6ff">/api/violations</a> &nbsp;
  <a href="/api/stats" style="color:#58a6ff">/api/stats</a> &nbsp;
  <a href="/api/devices" style="color:#58a6ff">/api/devices</a>
</div>

<script>
const ADMIN_KEY = prompt('Enter admin key (press Cancel for read-only):') || '';

async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    const d = await r.json();
    if (!d.ok) return;
    const s = d.stats;
    document.getElementById('sTotal').textContent    = s.total    || 0;
    document.getElementById('sSevere').textContent   = s.severe   || 0;
    document.getElementById('sModerate').textContent = s.moderate || 0;
    document.getElementById('sMinor').textContent    = s.minor    || 0;
    document.getElementById('sAvgExcess').textContent= s.avg_excess != null ? s.avg_excess : '—';
    document.getElementById('sMaxSpeed').textContent = s.max_speed != null ? s.max_speed : '—';
    document.getElementById('sDevices').textContent  = d.devices.length;

    // Device table
    const devTbody = document.getElementById('devTbody');
    devTbody.innerHTML = d.devices.map(dv =>
      \`<tr>
        <td>\${dv.device}</td>
        <td>\${dv.total_violations}</td>
        <td>\${dv.max_speed} km/h</td>
        <td style="font-size:.78rem">\${dv.last_seen}</td>
      </tr>\`
    ).join('') || '<tr><td colspan="4" class="empty">No devices yet</td></tr>';
  } catch(e) { console.error(e); }
}

async function loadViolations() {
  const tier   = document.getElementById('filterTier').value;
  const device = document.getElementById('filterDevice').value.trim();
  let url = '/api/violations?limit=200';
  if (tier)   url += '&tier='   + encodeURIComponent(tier);
  if (device) url += '&device=' + encodeURIComponent(device);

  try {
    const r = await fetch(url);
    const d = await r.json();
    if (!d.ok) return;

    document.getElementById('countLabel').textContent = d.count + ' records shown';

    const tbody = document.getElementById('tbody');
    if (!d.violations.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No violations found</td></tr>';
      return;
    }

    const tierBadge = t =>
      t === 'SEVERE'   ? "<span class='badge b-severe'>SEVERE</span>"
    : t === 'MODERATE' ? "<span class='badge b-moderate'>MODERATE</span>"
    :                    "<span class='badge b-minor'>MINOR</span>";

    const mapLink = (lat, lon) =>
      (lat && lon)
        ? \`<a class="map-link" href="https://maps.google.com/?q=\${lat},\${lon}" target="_blank">
            \${parseFloat(lat).toFixed(4)}, \${parseFloat(lon).toFixed(4)}</a>\`
        : '—';

    tbody.innerHTML = d.violations.map(v =>
      \`<tr>
        <td style="color:#8b949e">\${v.id}</td>
        <td><strong>\${v.device}</strong></td>
        <td>\${tierBadge(v.tier)}</td>
        <td><strong>\${v.speed}</strong> km/h</td>
        <td>\${v.speed_limit} km/h</td>
        <td style="color:\${v.excess>=20?'#f85149':v.excess>=10?'#e3b341':'#79c0ff'}">
          +\${v.excess} km/h</td>
        <td>\${mapLink(v.lat, v.lon)}</td>
        <td style="font-size:.75rem;color:#8b949e">\${v.received_at}</td>
      </tr>\`
    ).join('');
  } catch(e) { console.error(e); }
}

async function clearAll() {
  if (!ADMIN_KEY) { alert('Admin key required'); return; }
  if (!confirm('Delete ALL violation records? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/violations?key=' + encodeURIComponent(ADMIN_KEY),
                          { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) loadAll(); else alert('Error: ' + d.error);
  } catch(e) { alert('Request failed'); }
}

function loadAll() { loadStats(); loadViolations(); }

// Initial load + auto-refresh
loadAll();
setInterval(loadAll, 5000);
</script>
</body>
</html>`;
}

// ── 404 catch-all ────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route ${req.method} ${req.path} not found` });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  GPS Speed Monitor Server  v1.0      ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Dashboard : http://localhost:${PORT}     ║`);
  console.log(`║  API POST  : POST /api/violation      ║`);
  console.log(`║  API GET   : GET  /api/violations     ║`);
  console.log(`║  DB File   : ${DB_FILE.slice(-30).padEnd(30)} ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

module.exports = app;
