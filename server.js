/**
 * ============================================================
 *  GPS Speed Monitor — Server  v2.0
 *  Node.js + Express + SQLite
 *
 *  Endpoints
 *  ---------
 *  POST   /api/violation         ← ESP32 posts alerts
 *  GET    /api/violations        ← list (JSON)
 *  GET    /api/violations/:id    ← single
 *  GET    /api/stats             ← summary + hourly trend
 *  GET    /api/devices           ← devices seen
 *  GET    /api/health            ← uptime / db ping
 *  DELETE /api/violations        ← clear all (?key=ADMIN_KEY)
 *  POST   /api/test-sms          ← SMS simulation
 *  GET    /                      ← live dashboard
 *
 *  Config (.env):
 *    PORT=3000
 *    ADMIN_KEY=changeme
 *    DB_FILE=./violations.db
 * ============================================================
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const morgan   = require('morgan');
const path     = require('path');
const Database = require('better-sqlite3');

const PORT      = process.env.PORT      || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
const DB_FILE   = process.env.DB_FILE   || path.join(__dirname, 'violations.db');
const STARTED   = Date.now();

// ── Database ────────────────────────────────────────────────
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

const stmtInsert = db.prepare(`
  INSERT INTO violations (device, speed, speed_limit, excess, tier, lat, lon)
  VALUES (@device, @speed, @speed_limit, @excess, @tier, @lat, @lon)
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
    MAX(received_at)  AS last_seen,
    SUM(CASE WHEN tier = 'SEVERE' THEN 1 ELSE 0 END) AS severe
  FROM violations
  GROUP BY device
  ORDER BY last_seen DESC
`);

const stmtLatest = db.prepare(`
  SELECT * FROM violations ORDER BY received_at DESC, id DESC LIMIT 1
`);

const stmtHourly = db.prepare(`
  SELECT
    strftime('%Y-%m-%d %H:00', received_at) AS bucket,
    COUNT(*) AS count,
    SUM(CASE WHEN tier = 'SEVERE' THEN 1 ELSE 0 END) AS severe
  FROM violations
  WHERE received_at >= datetime('now', 'localtime', '-24 hours')
  GROUP BY bucket
  ORDER BY bucket ASC
`);

const stmtToday = db.prepare(`
  SELECT COUNT(*) AS count
  FROM violations
  WHERE date(received_at) = date('now', 'localtime')
`);

// ── Express ─────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

function validateViolation(body) {
  const errors = [];
  if (typeof body.speed !== 'number' && Number.isNaN(parseFloat(body.speed)))
    errors.push('speed must be a number');
  if (typeof body.limit !== 'number' && Number.isNaN(parseFloat(body.limit)))
    errors.push('limit must be a number');
  if (!body.tier) errors.push('tier is required');
  else if (!['MINOR', 'MODERATE', 'SEVERE'].includes(String(body.tier).toUpperCase()))
    errors.push('tier must be MINOR, MODERATE or SEVERE');
  return errors;
}

// ══════════════════════════════════════════════════════════
//  API
// ══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.json({
    ok: dbOk,
    service: 'gps-speed-monitor',
    version: '2.0',
    uptime_s: Math.floor((Date.now() - STARTED) / 1000),
    db: dbOk ? 'ok' : 'error',
  });
});

app.post('/api/violation', (req, res) => {
  const body = req.body || {};
  const speed = parseFloat(body.speed);
  const limit = parseFloat(body.limit);
  const { device = 'UNKNOWN', excess, tier, lat = null, lon = null } = body;

  const errors = validateViolation({ ...body, speed, limit });
  if (errors.length) {
    return res.status(400).json({ ok: false, errors });
  }

  const row = {
    device: String(device),
    speed,
    speed_limit: limit,
    excess: parseFloat(excess ?? (speed - limit)),
    tier: String(tier).toUpperCase(),
    lat: lat != null && lat !== '' ? parseFloat(lat) : null,
    lon: lon != null && lon !== '' ? parseFloat(lon) : null,
  };

  try {
    const info = stmtInsert.run(row);
    console.log(`[POST] #${info.lastInsertRowid} | ${row.device} | ${row.tier} | ${row.speed} km/h (limit ${row.speed_limit})`);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('[POST] DB error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
});

app.get('/api/violations', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
  const tier   = req.query.tier   ? String(req.query.tier).toUpperCase() : null;
  const device = req.query.device ? String(req.query.device) : null;

  let query = 'SELECT * FROM violations';
  const where = [];
  const params = [];

  if (tier)   { where.push('tier = ?');   params.push(tier); }
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

app.get('/api/violations/:id', (req, res) => {
  const row = stmtById.get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  return res.json({ ok: true, violation: row });
});

app.get('/api/stats', (req, res) => {
  const stats  = stmtStats.get();
  const devices = stmtDevices.all();
  const latest = stmtLatest.get() || null;
  const hourly = stmtHourly.all();
  const today  = stmtToday.get();

  return res.json({
    ok: true,
    stats: { ...stats, today: today?.count || 0 },
    devices,
    latest,
    hourly,
  });
});

app.get('/api/devices', (req, res) => {
  return res.json({ ok: true, devices: stmtDevices.all() });
});

app.delete('/api/violations', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  db.exec('DELETE FROM violations');
  console.log('[ADMIN] Violations table cleared');
  return res.json({ ok: true, message: 'All violations deleted' });
});

app.post('/api/test-sms', (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: 'Missing phone number or message' });
  }

  console.log(`\n[SMS API] Simulated SMS`);
  console.log(`[SMS API]  ├─ To:   ${phone}`);
  console.log(`[SMS API]  └─ Text: ${message}\n`);

  return res.json({ ok: true, message: 'SMS request simulated (check server logs)' });
});

// ══════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.type('html').send(getDashboardHTML());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Velocis — Speed Monitor</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#0b1f33;
  --ink-soft:#3d5166;
  --muted:#6b7c8f;
  --line:#d5dee8;
  --paper:#f0f4f8;
  --card:#ffffff;
  --teal:#0f9d8a;
  --teal-deep:#0a7a6b;
  --amber:#d97706;
  --rose:#be123c;
  --sky:#0284c7;
  --shadow:0 12px 40px rgba(11,31,51,.08);
  --radius:14px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  font-family:'Sora',sans-serif;
  background:
    radial-gradient(1200px 600px at 10% -10%, rgba(15,157,138,.14), transparent 55%),
    radial-gradient(900px 500px at 100% 0%, rgba(2,132,199,.10), transparent 50%),
    linear-gradient(180deg, #e8eef4 0%, var(--paper) 40%, #e6edf3 100%);
  color:var(--ink);
  min-height:100vh;
}
body::before{
  content:"";
  position:fixed;inset:0;pointer-events:none;opacity:.35;z-index:0;
  background-image:
    linear-gradient(rgba(11,31,51,.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(11,31,51,.04) 1px, transparent 1px);
  background-size:48px 48px;
  mask-image:linear-gradient(180deg,#000 0%, transparent 85%);
}
.wrap{position:relative;z-index:1;max-width:1280px;margin:0 auto;padding:0 20px 48px}

/* Brand bar */
.brand{
  display:flex;align-items:flex-end;justify-content:space-between;gap:20px;
  padding:28px 0 20px;flex-wrap:wrap;
}
.brand-mark{display:flex;align-items:center;gap:14px}
.logo{
  width:48px;height:48px;border-radius:12px;
  background:linear-gradient(145deg, var(--ink) 0%, #163552 100%);
  display:grid;place-items:center;color:#9ef0e2;
  font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:.95rem;
  box-shadow:0 8px 24px rgba(11,31,51,.25);
}
.brand h1{
  font-size:clamp(1.6rem, 3vw, 2.15rem);font-weight:700;letter-spacing:-.03em;line-height:1;
}
.brand h1 span{color:var(--teal)}
.tagline{margin-top:6px;color:var(--muted);font-size:.88rem;font-weight:400}
.brand-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{
  display:inline-flex;align-items:center;gap:8px;
  background:var(--card);border:1px solid var(--line);
  border-radius:999px;padding:8px 14px;font-size:.78rem;color:var(--ink-soft);
  box-shadow:var(--shadow);
}
.pill .dot{
  width:8px;height:8px;border-radius:50%;background:var(--teal);
  box-shadow:0 0 0 3px rgba(15,157,138,.2);
}
.pill .dot.warn{background:var(--amber);box-shadow:0 0 0 3px rgba(217,119,6,.2)}
.pill .dot.err{background:var(--rose);box-shadow:0 0 0 3px rgba(190,18,60,.2)}
.pill.live .dot{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
.btn{
  border:none;border-radius:10px;padding:9px 14px;font:inherit;font-size:.82rem;
  font-weight:600;cursor:pointer;transition:transform .15s, background .15s, box-shadow .15s;
}
.btn:active{transform:scale(.98)}
.btn-ghost{background:var(--card);color:var(--ink);border:1px solid var(--line)}
.btn-ghost:hover{border-color:#b7c5d4}
.btn-primary{background:var(--teal);color:#fff}
.btn-primary:hover{background:var(--teal-deep)}
.btn-danger{background:var(--rose);color:#fff}
.btn-danger:hover{filter:brightness(.95)}

/* Hero status */
.hero{
  display:grid;grid-template-columns:1.4fr .9fr;gap:16px;margin-bottom:18px;
}
@media (max-width:900px){.hero{grid-template-columns:1fr}}
.panel{
  background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);overflow:hidden;
}
.hero-main{
  padding:22px 24px;
  background:
    linear-gradient(135deg, rgba(15,157,138,.08), transparent 45%),
    var(--card);
}
.eyebrow{
  font-family:'IBM Plex Mono',monospace;font-size:.72rem;letter-spacing:.12em;
  text-transform:uppercase;color:var(--muted);margin-bottom:10px;
}
.hero-title{font-size:clamp(1.35rem, 2.4vw, 1.75rem);font-weight:700;letter-spacing:-.02em}
.hero-title.ok{color:var(--teal-deep)}
.hero-title.alert{color:var(--rose)}
.hero-sub{margin-top:8px;color:var(--ink-soft);font-size:.92rem;line-height:1.45;max-width:42ch}
.hero-meta{
  display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;
}
.chip{
  font-family:'IBM Plex Mono',monospace;font-size:.72rem;
  background:#eef5f3;color:var(--teal-deep);border:1px solid #cce8e2;
  border-radius:8px;padding:6px 10px;
}
.chip.rose{background:#fde8ec;color:var(--rose);border-color:#f5c2cd}
.chip.amber{background:#fff4e5;color:#9a5b05;border-color:#f5d7a6}
.hero-side{padding:18px 20px;display:flex;flex-direction:column;gap:14px}
.metric-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.metric-row .lbl{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.metric-row .val{font-family:'IBM Plex Mono',monospace;font-size:1.35rem;font-weight:600}
.spark{
  height:72px;width:100%;margin-top:auto;
}
.spark svg{width:100%;height:100%;display:block}

/* KPI strip */
.kpis{
  display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:18px;
}
@media (max-width:1100px){.kpis{grid-template-columns:repeat(3,1fr)}}
@media (max-width:560px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{padding:16px 16px 14px;position:relative}
.kpi .lbl{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.kpi .val{
  font-family:'IBM Plex Mono',monospace;font-size:1.85rem;font-weight:600;
  margin-top:6px;letter-spacing:-.02em;
}
.kpi .hint{font-size:.72rem;color:var(--muted);margin-top:4px}
.kpi.severe .val{color:var(--rose)}
.kpi.moderate .val{color:var(--amber)}
.kpi.minor .val{color:var(--sky)}
.kpi.teal .val{color:var(--teal-deep)}

/* Main grid */
.main{
  display:grid;grid-template-columns:1.35fr .85fr;gap:16px;margin-bottom:16px;
}
@media (max-width:960px){.main{grid-template-columns:1fr}}
.section-hd{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:14px 16px;border-bottom:1px solid var(--line);
}
.section-hd h2{font-size:.95rem;font-weight:600}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}
.field,.select{
  background:#f7fafc;border:1px solid var(--line);border-radius:8px;
  padding:8px 10px;font:inherit;font-size:.82rem;color:var(--ink);min-width:0;
}
.field:focus,.select:focus{outline:2px solid rgba(15,157,138,.35);border-color:var(--teal)}
.table-wrap{overflow:auto;max-height:520px}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{
  position:sticky;top:0;background:#f7fafc;z-index:1;
  text-align:left;padding:10px 14px;color:var(--muted);font-weight:500;
  border-bottom:1px solid var(--line);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;
}
td{padding:11px 14px;border-bottom:1px solid #eef2f6;vertical-align:middle}
tr:hover td{background:#f8fbfa}
.mono{font-family:'IBM Plex Mono',monospace}
.badge{
  display:inline-flex;align-items:center;gap:6px;
  padding:3px 9px;border-radius:999px;font-size:.68rem;font-weight:600;
  letter-spacing:.04em;
}
.b-severe{background:#fde8ec;color:var(--rose)}
.b-moderate{background:#fff4e5;color:#9a5b05}
.b-minor{background:#e6f4fc;color:#0369a1}
.map-link{color:var(--sky);text-decoration:none;font-family:'IBM Plex Mono',monospace;font-size:.75rem}
.map-link:hover{text-decoration:underline}
.empty{padding:36px 20px;text-align:center;color:var(--muted);font-size:.88rem}
.rel{color:var(--muted);font-size:.75rem}

/* Side panels */
.side-stack{display:flex;flex-direction:column;gap:16px}
.bars{padding:16px;display:flex;flex-direction:column;gap:12px}
.bar-row{display:grid;grid-template-columns:72px 1fr 36px;gap:10px;align-items:center}
.bar-row span{font-size:.75rem;color:var(--ink-soft)}
.bar-track{height:8px;background:#e8eef4;border-radius:99px;overflow:hidden}
.bar-fill{height:100%;border-radius:99px}
.bar-fill.s{background:var(--rose)}
.bar-fill.m{background:var(--amber)}
.bar-fill.n{background:var(--sky)}
.device-list{padding:8px 0}
.device{
  display:flex;justify-content:space-between;gap:12px;align-items:center;
  padding:12px 16px;border-bottom:1px solid #eef2f6;
}
.device:last-child{border-bottom:none}
.device strong{font-size:.88rem}
.device .sub{font-size:.72rem;color:var(--muted);margin-top:3px}
.device .right{text-align:right;font-family:'IBM Plex Mono',monospace;font-size:.78rem}

/* Tools */
.tools{padding:16px}
.tools-grid{display:grid;grid-template-columns:1fr 1.4fr auto;gap:8px}
@media (max-width:560px){.tools-grid{grid-template-columns:1fr}}
.foot{
  margin-top:28px;padding-top:16px;border-top:1px solid var(--line);
  display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
  color:var(--muted);font-size:.75rem;
}
.foot a{color:var(--teal-deep);text-decoration:none}
.foot a:hover{text-decoration:underline}

/* Toast + modal */
#toasts{position:fixed;right:16px;bottom:16px;z-index:50;display:flex;flex-direction:column;gap:8px}
.toast{
  background:var(--ink);color:#e8eef4;padding:12px 14px;border-radius:10px;
  font-size:.82rem;box-shadow:0 12px 30px rgba(0,0,0,.25);min-width:220px;
  animation:slide .25s ease;
}
.toast.ok{border-left:3px solid var(--teal)}
.toast.err{border-left:3px solid #fb7185}
@keyframes slide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.modal-back{
  position:fixed;inset:0;background:rgba(11,31,51,.45);z-index:40;
  display:none;align-items:center;justify-content:center;padding:20px;
}
.modal-back.open{display:flex}
.modal{
  background:var(--card);border-radius:16px;padding:22px;width:min(420px,100%);
  box-shadow:0 24px 60px rgba(0,0,0,.25);
}
.modal h3{font-size:1.05rem;margin-bottom:6px}
.modal p{color:var(--muted);font-size:.85rem;margin-bottom:14px;line-height:1.4}
.modal .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
</style>
</head>
<body>
<div class="wrap">
  <header class="brand">
    <div class="brand-mark">
      <div class="logo">VX</div>
      <div>
        <h1>Veloc<span>is</span></h1>
        <p class="tagline">Fleet speed intelligence &amp; violation desk</p>
      </div>
    </div>
    <div class="brand-meta">
      <div class="pill live" id="livePill"><span class="dot" id="liveDot"></span><span id="liveLabel">Connecting…</span></div>
      <div class="pill mono" id="clockPill">--:--:--</div>
      <button class="btn btn-ghost" type="button" onclick="openAdmin()">Admin</button>
      <button class="btn btn-primary" type="button" onclick="loadAll(true)">Refresh</button>
    </div>
  </header>

  <section class="hero">
    <div class="panel hero-main">
      <div class="eyebrow">Operational status</div>
      <div class="hero-title ok" id="heroTitle">All systems nominal</div>
      <p class="hero-sub" id="heroSub">Waiting for the first device report. Violations from ESP32 trackers will appear here in real time.</p>
      <div class="hero-meta" id="heroMeta"></div>
    </div>
    <div class="panel hero-side">
      <div class="eyebrow">Last 24 hours</div>
      <div class="metric-row"><span class="lbl">Events</span><span class="val" id="hEvents">0</span></div>
      <div class="metric-row"><span class="lbl">Severe</span><span class="val" id="hSevere" style="color:var(--rose)">0</span></div>
      <div class="spark" id="spark" aria-label="Hourly violation trend"></div>
    </div>
  </section>

  <section class="kpis">
    <div class="panel kpi teal"><div class="lbl">Today</div><div class="val" id="sToday">—</div><div class="hint">violations</div></div>
    <div class="panel kpi"><div class="lbl">Total</div><div class="val" id="sTotal">—</div><div class="hint">all time</div></div>
    <div class="panel kpi severe"><div class="lbl">Severe</div><div class="val" id="sSevere">—</div><div class="hint">SMS tier</div></div>
    <div class="panel kpi moderate"><div class="lbl">Moderate</div><div class="val" id="sModerate">—</div></div>
    <div class="panel kpi minor"><div class="lbl">Minor</div><div class="val" id="sMinor">—</div></div>
    <div class="panel kpi"><div class="lbl">Peak speed</div><div class="val" id="sMaxSpeed">—</div><div class="hint">km/h recorded</div></div>
  </section>

  <section class="main">
    <div class="panel">
      <div class="section-hd">
        <h2>Violation feed</h2>
        <span class="rel" id="countLabel"></span>
      </div>
      <div class="toolbar">
        <select class="select" id="filterTier" onchange="loadViolations()">
          <option value="">All tiers</option>
          <option value="SEVERE">Severe</option>
          <option value="MODERATE">Moderate</option>
          <option value="MINOR">Minor</option>
        </select>
        <input class="field" id="filterDevice" placeholder="Filter device ID" oninput="debouncedLoad()">
        <button class="btn btn-ghost" type="button" onclick="clearAll()">Clear all</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Device</th><th>Tier</th><th>Speed</th>
              <th>Limit</th><th>Excess</th><th>Location</th><th>When</th>
            </tr>
          </thead>
          <tbody id="tbody"><tr><td colspan="8" class="empty">Loading feed…</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="side-stack">
      <div class="panel">
        <div class="section-hd"><h2>Severity mix</h2></div>
        <div class="bars" id="severityBars"></div>
      </div>
      <div class="panel">
        <div class="section-hd"><h2>Devices</h2><span class="rel" id="deviceCount"></span></div>
        <div class="device-list" id="devList"><div class="empty">No devices yet</div></div>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="section-hd">
      <h2>Backend SMS tester</h2>
      <span class="rel">Simulated — logs to server console</span>
    </div>
    <div class="tools">
      <div class="tools-grid">
        <input class="field" id="smsPhone" placeholder="+234…" type="tel">
        <input class="field" id="smsMsg" placeholder="Message content" type="text">
        <button class="btn btn-primary" type="button" onclick="sendBackendSMS()">Send</button>
      </div>
    </div>
  </section>

  <footer class="foot">
    <div>
      API
      <a href="/api/violations">/api/violations</a> ·
      <a href="/api/stats">/api/stats</a> ·
      <a href="/api/health">/api/health</a> ·
      <a href="/api/devices">/api/devices</a>
    </div>
    <div>Velocis server v2.0 · port ${PORT}</div>
  </footer>
</div>

<div id="toasts"></div>

<div class="modal-back" id="adminModal" onclick="if(event.target===this)closeAdmin()">
  <div class="modal">
    <h3>Admin access</h3>
    <p>Stored locally in this browser. Required only for destructive actions like clearing the violation log.</p>
    <input class="field" id="adminKeyInput" type="password" placeholder="Admin key" style="width:100%">
    <div class="actions">
      <button class="btn btn-ghost" type="button" onclick="closeAdmin()">Cancel</button>
      <button class="btn btn-primary" type="button" onclick="saveAdmin()">Save</button>
    </div>
  </div>
</div>

<script>
const REFRESH_MS = 5000;
let adminKey = localStorage.getItem('velocis_admin') || '';
let loadTimer = null;
let debounceTimer = null;
let lastLatestId = null;

function toast(msg, ok=true){
  const el = document.createElement('div');
  el.className = 'toast ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function openAdmin(){
  document.getElementById('adminKeyInput').value = adminKey;
  document.getElementById('adminModal').classList.add('open');
  document.getElementById('adminKeyInput').focus();
}
function closeAdmin(){ document.getElementById('adminModal').classList.remove('open'); }
function saveAdmin(){
  adminKey = document.getElementById('adminKeyInput').value.trim();
  localStorage.setItem('velocis_admin', adminKey);
  closeAdmin();
  toast(adminKey ? 'Admin key saved' : 'Admin key cleared');
}

function setLive(ok, label){
  const pill = document.getElementById('livePill');
  const dot = document.getElementById('liveDot');
  document.getElementById('liveLabel').textContent = label;
  pill.classList.toggle('live', ok);
  dot.className = 'dot' + (ok ? '' : ' err');
}

function tickClock(){
  document.getElementById('clockPill').textContent =
    new Date().toLocaleTimeString([], { hour12:false });
}

function relTime(iso){
  if (!iso) return '—';
  const t = Date.parse(String(iso).replace(' ', 'T'));
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function tierBadge(t){
  const c = t === 'SEVERE' ? 'b-severe' : t === 'MODERATE' ? 'b-moderate' : 'b-minor';
  return '<span class="badge ' + c + '">' + t + '</span>';
}

function mapLink(lat, lon){
  if (lat == null || lon == null) return '—';
  const a = parseFloat(lat), b = parseFloat(lon);
  if (Number.isNaN(a) || Number.isNaN(b)) return '—';
  return '<a class="map-link" href="https://maps.google.com/?q=' + a + ',' + b +
    '" target="_blank" rel="noopener">' + a.toFixed(4) + ', ' + b.toFixed(4) + '</a>';
}

function renderSpark(hourly){
  const host = document.getElementById('spark');
  const map = {};
  (hourly || []).forEach(h => { map[h.bucket] = h; });

  const points = [];
  const now = new Date();
  now.setMinutes(0,0,0);
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000);
    const key = d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0') + ' ' +
      String(d.getHours()).padStart(2,'0') + ':00';
    points.push({ key, count: (map[key] && map[key].count) || 0, severe: (map[key] && map[key].severe) || 0 });
  }

  const max = Math.max(1, ...points.map(p => p.count));
  const w = 280, h = 72, pad = 4;
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - (p.count / max) * (h - pad * 2);
    return [x, y, p];
  });

  const line = coords.map((c,i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
  const area = line + ' L' + (w-pad) + ',' + (h-pad) + ' L' + pad + ',' + (h-pad) + ' Z';
  const bars = coords.map(c => {
    const bh = Math.max(2, (h - pad) - c[1]);
    const fill = c[2].severe > 0 ? '#be123c' : '#0f9d8a';
    return '<rect x="' + (c[0]-2).toFixed(1) + '" y="' + c[1].toFixed(1) +
      '" width="4" height="' + bh.toFixed(1) + '" rx="1.5" fill="' + fill + '" opacity=".85"/>';
  }).join('');

  host.innerHTML =
    '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<path d="' + area + '" fill="rgba(15,157,138,.12)"/>' +
    '<path d="' + line + '" fill="none" stroke="#0f9d8a" stroke-width="2" stroke-linejoin="round"/>' +
    bars + '</svg>';

  const total24 = points.reduce((a,p) => a + p.count, 0);
  const sev24 = points.reduce((a,p) => a + p.severe, 0);
  document.getElementById('hEvents').textContent = total24;
  document.getElementById('hSevere').textContent = sev24;
}

function renderMix(stats){
  const total = Math.max(1, stats.total || 0);
  const rows = [
    ['Severe', stats.severe || 0, 's'],
    ['Moderate', stats.moderate || 0, 'm'],
    ['Minor', stats.minor || 0, 'n'],
  ];
  document.getElementById('severityBars').innerHTML = rows.map(([label, n, cls]) =>
    '<div class="bar-row"><span>' + label + '</span>' +
    '<div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' +
    ((n/total)*100).toFixed(1) + '%"></div></div>' +
    '<span class="mono">' + n + '</span></div>'
  ).join('');
}

function updateHero(latest, stats){
  const title = document.getElementById('heroTitle');
  const sub = document.getElementById('heroSub');
  const meta = document.getElementById('heroMeta');

  if (!latest) {
    title.className = 'hero-title ok';
    title.textContent = 'All systems nominal';
    sub.textContent = 'No violations on file. The desk is clear — devices will report here when limits are exceeded.';
    meta.innerHTML = '<span class="chip">' + (stats.devices || 0) + ' devices known</span>';
    return;
  }

  const isSevere = latest.tier === 'SEVERE';
  title.className = 'hero-title ' + (isSevere ? 'alert' : 'ok');
  title.textContent = isSevere
    ? 'Severe event on desk'
    : 'Latest: ' + latest.tier.toLowerCase() + ' excess';
  sub.textContent = latest.device + ' at ' + latest.speed + ' km/h (limit ' +
    latest.speed_limit + ' km/h, +' + latest.excess + ' over).';
  meta.innerHTML =
    '<span class="chip' + (isSevere ? ' rose' : latest.tier === 'MODERATE' ? ' amber' : '') + '">' +
    latest.tier + '</span>' +
    '<span class="chip">' + relTime(latest.received_at) + '</span>' +
    (latest.lat != null ? '<span class="chip">' + parseFloat(latest.lat).toFixed(3) + ', ' +
      parseFloat(latest.lon).toFixed(3) + '</span>' : '');

  if (lastLatestId != null && latest.id !== lastLatestId) {
    toast('New ' + latest.tier + ' from ' + latest.device, !isSevere);
  }
  lastLatestId = latest.id;
}

async function loadStats(){
  const r = await fetch('/api/stats');
  const d = await r.json();
  if (!d.ok) throw new Error('stats failed');
  const s = d.stats;

  document.getElementById('sToday').textContent = s.today ?? 0;
  document.getElementById('sTotal').textContent = s.total || 0;
  document.getElementById('sSevere').textContent = s.severe || 0;
  document.getElementById('sModerate').textContent = s.moderate || 0;
  document.getElementById('sMinor').textContent = s.minor || 0;
  document.getElementById('sMaxSpeed').textContent = s.max_speed != null ? s.max_speed : '—';

  renderMix(s);
  renderSpark(d.hourly || []);
  updateHero(d.latest, s);

  const list = document.getElementById('devList');
  document.getElementById('deviceCount').textContent = (d.devices || []).length + ' online history';
  if (!d.devices.length) {
    list.innerHTML = '<div class="empty">No devices yet</div>';
  } else {
    list.innerHTML = d.devices.map(dv =>
      '<div class="device"><div><strong>' + dv.device + '</strong>' +
      '<div class="sub">' + dv.total_violations + ' events · ' +
      (dv.severe || 0) + ' severe</div></div>' +
      '<div class="right">' + dv.max_speed + ' km/h' +
      '<div class="sub">' + relTime(dv.last_seen) + '</div></div></div>'
    ).join('');
  }
}

async function loadViolations(){
  const tier = document.getElementById('filterTier').value;
  const device = document.getElementById('filterDevice').value.trim();
  let url = '/api/violations?limit=200';
  if (tier) url += '&tier=' + encodeURIComponent(tier);
  if (device) url += '&device=' + encodeURIComponent(device);

  const r = await fetch(url);
  const d = await r.json();
  if (!d.ok) throw new Error('violations failed');

  document.getElementById('countLabel').textContent = d.count + ' shown';
  const tbody = document.getElementById('tbody');
  if (!d.violations.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No violations match this filter</td></tr>';
    return;
  }

  tbody.innerHTML = d.violations.map(v => {
    const excessColor = v.excess >= 20 ? 'var(--rose)' : v.excess >= 10 ? 'var(--amber)' : 'var(--sky)';
    return '<tr>' +
      '<td class="mono rel">' + v.id + '</td>' +
      '<td><strong>' + v.device + '</strong></td>' +
      '<td>' + tierBadge(v.tier) + '</td>' +
      '<td class="mono"><strong>' + v.speed + '</strong></td>' +
      '<td class="mono">' + v.speed_limit + '</td>' +
      '<td class="mono" style="color:' + excessColor + '">+' + v.excess + '</td>' +
      '<td>' + mapLink(v.lat, v.lon) + '</td>' +
      '<td><div class="rel">' + relTime(v.received_at) + '</div>' +
      '<div class="rel mono">' + v.received_at + '</div></td>' +
      '</tr>';
  }).join('');
}

async function loadAll(manual){
  try {
    await Promise.all([loadStats(), loadViolations()]);
    const h = await fetch('/api/health').then(r => r.json());
    setLive(!!h.ok, h.ok ? 'Live · ' + h.uptime_s + 's up' : 'Degraded');
    if (manual) toast('Dashboard refreshed');
  } catch (e) {
    console.error(e);
    setLive(false, 'Offline');
    if (manual) toast('Refresh failed', false);
  }
}

function debouncedLoad(){
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(loadViolations, 280);
}

async function clearAll(){
  if (!adminKey) { openAdmin(); toast('Set admin key first', false); return; }
  if (!confirm('Delete ALL violation records? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/violations?key=' + encodeURIComponent(adminKey), { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) { toast('Log cleared'); loadAll(); }
    else toast(d.error || 'Denied', false);
  } catch { toast('Request failed', false); }
}

async function sendBackendSMS(){
  const phone = document.getElementById('smsPhone').value.trim();
  const msg = document.getElementById('smsMsg').value.trim();
  if (!phone || !msg) { toast('Phone and message required', false); return; }
  try {
    const res = await fetch('/api/test-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: msg })
    });
    const data = await res.json();
    if (data.ok) {
      toast('SMS simulated — check server logs');
      document.getElementById('smsMsg').value = '';
    } else toast(data.error || 'Failed', false);
  } catch { toast('Network error', false); }
}

tickClock();
setInterval(tickClock, 1000);
loadAll();
loadTimer = setInterval(() => loadAll(false), REFRESH_MS);
</script>
</body>
</html>`;
}

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route ${req.method} ${req.path} not found` });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Velocis Speed Monitor Server  v2.0      ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Dashboard : http://localhost:${String(PORT).padEnd(5)}      ║`);
  console.log(`║  Health    : GET  /api/health            ║`);
  console.log(`║  Ingest    : POST /api/violation         ║`);
  console.log(`║  DB File   : ${String(DB_FILE).slice(-28).padEnd(28)} ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});

module.exports = app;
