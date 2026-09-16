/**
 * ============================================================
 *  Velocis Server  v3.0
 *  Node.js + Express + SQLite
 *
 *  Endpoints
 *  ---------
 *  POST   /api/violation              ← ESP32 posts alerts
 *  POST   /api/heartbeat              ← device presence / last_*
 *  GET    /api/violations             ← list (JSON)
 *  GET    /api/violations/:id         ← single
 *  GET    /api/violations.csv         ← CSV export
 *  GET    /api/stats                  ← summary + devices + hourly
 *  GET    /api/devices                ← device registry (+ online)
 *  POST   /api/devices                ← admin register
 *  PATCH  /api/devices/:id            ← admin update
 *  DELETE /api/devices/:id            ← admin delete
 *  GET    /api/geofences              ← active (public) / all (admin)
 *  POST   /api/geofences              ← admin create
 *  PATCH  /api/geofences/:id          ← admin update
 *  DELETE /api/geofences/:id          ← admin delete
 *  POST   /api/retention              ← admin purge old rows
 *  GET    /api/health                 ← uptime / db ping
 *  DELETE /api/violations             ← clear all (admin)
 *  POST   /api/test-sms               ← SMS simulation
 *  GET    /                           ← live dashboard
 *
 *  Config (.env):
 *    PORT=3000
 *    ADMIN_KEY=changeme
 *    DB_FILE=./violations.db
 *    REQUIRE_AUTH=false
 *    DEVICE_API_KEY=
 *    TELEGRAM_BOT_TOKEN=
 *    TELEGRAM_CHAT_ID=
 *    RETENTION_DAYS=90
 * ============================================================
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const morgan   = require('morgan');
const path     = require('path');
const crypto   = require('crypto');
const https    = require('https');
const Database = require('better-sqlite3');

const PORT              = process.env.PORT      || 3000;
const ADMIN_KEY         = process.env.ADMIN_KEY || 'changeme';
const DB_FILE           = process.env.DB_FILE   || path.join(__dirname, 'violations.db');
const REQUIRE_AUTH      = String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';
const DEVICE_API_KEY    = process.env.DEVICE_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID || '';
const RETENTION_DAYS    = Math.max(1, parseInt(process.env.RETENTION_DAYS || '90', 10) || 90);
const ONLINE_WINDOW_S   = 120;
const STARTED           = Date.now();
const VERSION           = '3.0';

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

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    label       TEXT,
    vehicle     TEXT,
    api_key     TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    last_seen   TEXT,
    last_lat    REAL,
    last_lon    REAL,
    last_speed  REAL,
    last_limit  REAL,
    gps_valid   INTEGER,
    wifi_rssi   INTEGER,
    free_heap   INTEGER,
    internet_ok INTEGER
  );

  CREATE TABLE IF NOT EXISTS geofences (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    lat_min   REAL NOT NULL,
    lat_max   REAL NOT NULL,
    lon_min   REAL NOT NULL,
    lon_max   REAL NOT NULL,
    limit_kph REAL NOT NULL,
    active    INTEGER NOT NULL DEFAULT 1
  );
`);

const geofenceCount = db.prepare('SELECT COUNT(*) AS n FROM geofences').get().n;
if (geofenceCount === 0) {
  const seed = db.prepare(`
    INSERT INTO geofences (name, lat_min, lat_max, lon_min, lon_max, limit_kph, active)
    VALUES (@name, @lat_min, @lat_max, @lon_min, @lon_max, @limit_kph, 1)
  `);
  const defaults = [
    { name: 'Residential', lat_min: 9.0700, lat_max: 9.0800, lon_min: 7.3900, lon_max: 7.4000, limit_kph: 30 },
    { name: 'Urban',       lat_min: 9.0800, lat_max: 9.0950, lon_min: 7.3900, lon_max: 7.4200, limit_kph: 50 },
    { name: 'Express',     lat_min: 9.0500, lat_max: 9.0700, lon_min: 7.3800, lon_max: 7.4300, limit_kph: 80 },
    { name: 'Highway',     lat_min: 8.9000, lat_max: 9.0500, lon_min: 7.3000, lon_max: 7.5000, limit_kph: 100 },
  ];
  const tx = db.transaction((rows) => { for (const r of rows) seed.run(r); });
  tx(defaults);
  console.log('[DB]  Seeded 4 default geofences (Nigeria zones)');
}

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

const stmtViolationDevices = db.prepare(`
  SELECT
    device,
    COUNT(*)          AS total_violations,
    MAX(speed)        AS max_speed,
    MAX(received_at)  AS last_seen,
    SUM(CASE WHEN tier = 'SEVERE' THEN 1 ELSE 0 END) AS severe
  FROM violations
  GROUP BY device
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

const stmtGetDevice = db.prepare(`SELECT * FROM devices WHERE id = ?`);

const stmtUpsertDeviceSeen = db.prepare(`
  INSERT INTO devices (
    id, label, created_at, last_seen,
    last_lat, last_lon, last_speed, last_limit,
    gps_valid, wifi_rssi, free_heap, internet_ok
  ) VALUES (
    @id, @label, datetime('now','localtime'), datetime('now','localtime'),
    @last_lat, @last_lon, @last_speed, @last_limit,
    @gps_valid, @wifi_rssi, @free_heap, @internet_ok
  )
  ON CONFLICT(id) DO UPDATE SET
    last_seen   = datetime('now','localtime'),
    last_lat    = COALESCE(@last_lat, last_lat),
    last_lon    = COALESCE(@last_lon, last_lon),
    last_speed  = COALESCE(@last_speed, last_speed),
    last_limit  = COALESCE(@last_limit, last_limit),
    gps_valid   = COALESCE(@gps_valid, gps_valid),
    wifi_rssi   = COALESCE(@wifi_rssi, wifi_rssi),
    free_heap   = COALESCE(@free_heap, free_heap),
    internet_ok = COALESCE(@internet_ok, internet_ok)
`);

const stmtListDevices = db.prepare(`SELECT * FROM devices ORDER BY last_seen IS NULL, last_seen DESC, id ASC`);

const stmtInsertDevice = db.prepare(`
  INSERT INTO devices (id, label, vehicle, api_key, notes, created_at)
  VALUES (@id, @label, @vehicle, @api_key, @notes, datetime('now','localtime'))
`);

const stmtUpdateDevice = db.prepare(`
  UPDATE devices SET
    label   = COALESCE(@label, label),
    vehicle = COALESCE(@vehicle, vehicle),
    api_key = COALESCE(@api_key, api_key),
    notes   = COALESCE(@notes, notes)
  WHERE id = @id
`);

const stmtDeleteDevice = db.prepare(`DELETE FROM devices WHERE id = ?`);

const stmtActiveGeofences = db.prepare(`
  SELECT id, name, lat_min, lat_max, lon_min, lon_max, limit_kph, active
  FROM geofences WHERE active = 1 ORDER BY id ASC
`);

const stmtAllGeofences = db.prepare(`
  SELECT id, name, lat_min, lat_max, lon_min, lon_max, limit_kph, active
  FROM geofences ORDER BY id ASC
`);

const stmtGeofenceById = db.prepare(`SELECT * FROM geofences WHERE id = ?`);

const stmtInsertGeofence = db.prepare(`
  INSERT INTO geofences (name, lat_min, lat_max, lon_min, lon_max, limit_kph, active)
  VALUES (@name, @lat_min, @lat_max, @lon_min, @lon_max, @limit_kph, @active)
`);

const stmtUpdateGeofence = db.prepare(`
  UPDATE geofences SET
    name      = COALESCE(@name, name),
    lat_min   = COALESCE(@lat_min, lat_min),
    lat_max   = COALESCE(@lat_max, lat_max),
    lon_min   = COALESCE(@lon_min, lon_min),
    lon_max   = COALESCE(@lon_max, lon_max),
    limit_kph = COALESCE(@limit_kph, limit_kph),
    active    = COALESCE(@active, active)
  WHERE id = @id
`);

const stmtDeleteGeofence = db.prepare(`DELETE FROM geofences WHERE id = ?`);

const stmtGeofencesVersion = db.prepare(`
  SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id FROM geofences WHERE active = 1
`);

const stmtRetention = db.prepare(`
  DELETE FROM violations
  WHERE received_at < datetime('now', 'localtime', ?)
`);

// ── Helpers ─────────────────────────────────────────────────
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function getApiKey(req) {
  const headerKey = req.get('X-API-Key') || req.get('x-api-key');
  if (headerKey) return String(headerKey).trim();

  const auth = req.get('Authorization') || req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();

  if (req.body && req.body.api_key != null && String(req.body.api_key).trim() !== '') {
    return String(req.body.api_key).trim();
  }
  if (req.query && req.query.api_key != null && String(req.query.api_key).trim() !== '') {
    return String(req.query.api_key).trim();
  }
  return '';
}

function requireAdmin(req) {
  const q = req.query && req.query.key != null ? String(req.query.key) : '';
  const h =
    req.get('X-Admin-Key') ||
    req.get('x-admin-key') ||
    req.get('X-API-Key') ||
    req.get('x-api-key') ||
    '';
  const auth = req.get('Authorization') || '';
  const bearer = (auth.match(/^Bearer\s+(.+)$/i) || [])[1] || '';
  const provided = q || h || bearer;
  return provided === ADMIN_KEY;
}

function authorizeDevice(req, deviceId) {
  if (!REQUIRE_AUTH) return { ok: true };

  const key = getApiKey(req);
  if (!key) return { ok: false, error: 'API key required' };

  if (DEVICE_API_KEY && key === DEVICE_API_KEY) return { ok: true };

  const device = stmtGetDevice.get(String(deviceId));
  if (device && device.api_key && key === device.api_key) return { ok: true };

  return { ok: false, error: 'Invalid API key for device' };
}

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  const t = Date.parse(String(lastSeen).replace(' ', 'T'));
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= ONLINE_WINDOW_S * 1000;
}

function geofencesVersion() {
  const v = stmtGeofencesVersion.get();
  return `g${v.count}-${v.max_id}`;
}

function upsertDevicePresence(opts) {
  const id = String(opts.id || 'UNKNOWN');
  stmtUpsertDeviceSeen.run({
    id,
    label: opts.label || id,
    last_lat: numOrNull(opts.lat),
    last_lon: numOrNull(opts.lon),
    last_speed: numOrNull(opts.speed),
    last_limit: numOrNull(opts.limit),
    gps_valid: intOrNull(opts.gps_valid),
    wifi_rssi: intOrNull(opts.wifi_rssi),
    free_heap: intOrNull(opts.free_heap),
    internet_ok: intOrNull(opts.internet_ok),
  });
}

function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage` +
    `?chat_id=${encodeURIComponent(TELEGRAM_CHAT_ID)}` +
    `&text=${encodeURIComponent(text)}`;

  const doFetch = typeof fetch === 'function'
    ? () => fetch(url).then((r) => {
        if (!r.ok) console.error('[Telegram] HTTP', r.status);
      })
    : () => new Promise((resolve, reject) => {
        https.get(url, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error('HTTP ' + res.statusCode));
          } else resolve();
        }).on('error', reject);
      });

  Promise.resolve()
    .then(doFetch)
    .catch((err) => console.error('[Telegram] send failed:', err.message || err));
}

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

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function enrichDevices(registryRows, violationAggs) {
  const byId = new Map();
  for (const v of violationAggs) {
    byId.set(v.device, v);
  }

  const enriched = registryRows.map((d) => {
    const agg = byId.get(d.id) || {};
    return {
      ...d,
      device: d.id,
      online: isOnline(d.last_seen),
      total_violations: agg.total_violations || 0,
      max_speed: agg.max_speed != null ? agg.max_speed : d.last_speed,
      severe: agg.severe || 0,
      label: d.label || d.id,
      vehicle: d.vehicle || null,
    };
  });

  // Include violation-only devices not yet in registry
  for (const v of violationAggs) {
    if (!registryRows.some((d) => d.id === v.device)) {
      enriched.push({
        id: v.device,
        device: v.device,
        label: v.device,
        vehicle: null,
        online: isOnline(v.last_seen),
        last_seen: v.last_seen,
        total_violations: v.total_violations,
        max_speed: v.max_speed,
        severe: v.severe,
        last_lat: null,
        last_lon: null,
        last_speed: null,
        last_limit: null,
      });
    }
  }

  enriched.sort((a, b) => {
    const ta = a.last_seen ? Date.parse(String(a.last_seen).replace(' ', 'T')) : 0;
    const tb = b.last_seen ? Date.parse(String(b.last_seen).replace(' ', 'T')) : 0;
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });

  return enriched;
}

// ── Express ─────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ══════════════════════════════════════════════════════════
//  API
// ══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.json({
    ok: dbOk,
    service: 'velocis',
    version: VERSION,
    uptime_s: Math.floor((Date.now() - STARTED) / 1000),
    db: dbOk ? 'ok' : 'error',
    require_auth: REQUIRE_AUTH,
    telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    retention_days: RETENTION_DAYS,
  });
});

app.post('/api/violation', (req, res) => {
  const body = req.body || {};
  const speed = parseFloat(body.speed);
  const limit = parseFloat(body.limit);
  const { device = 'UNKNOWN', excess, tier, lat = null, lon = null } = body;

  const auth = authorizeDevice(req, device);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

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

    // Auto-upsert unknown devices when REQUIRE_AUTH=false; always refresh last_* after auth
    const known = stmtGetDevice.get(row.device);
    if (!REQUIRE_AUTH || known || (DEVICE_API_KEY && getApiKey(req) === DEVICE_API_KEY)) {
      upsertDevicePresence({
        id: row.device,
        lat: row.lat,
        lon: row.lon,
        speed: row.speed,
        limit: row.speed_limit,
      });
    }

    console.log(`[POST] #${info.lastInsertRowid} | ${row.device} | ${row.tier} | ${row.speed} km/h (limit ${row.speed_limit})`);

    if (row.tier === 'SEVERE') {
      const msg =
        `🚨 SEVERE speed alert\n` +
        `Device: ${row.device}\n` +
        `Speed: ${row.speed} km/h (limit ${row.speed_limit})\n` +
        `Excess: +${row.excess}\n` +
        (row.lat != null ? `Loc: ${row.lat}, ${row.lon}` : 'Loc: n/a');
      sendTelegramAlert(msg);
    }

    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('[POST] DB error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
});

app.post('/api/heartbeat', (req, res) => {
  const body = req.body || {};
  const device = String(body.device || body.id || 'UNKNOWN');

  const auth = authorizeDevice(req, device);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

  try {
    upsertDevicePresence({
      id: device,
      lat: body.lat,
      lon: body.lon,
      speed: body.speed,
      limit: body.limit,
      gps_valid: body.gps_valid,
      wifi_rssi: body.wifi_rssi,
      free_heap: body.free_heap,
      internet_ok: body.internet_ok,
    });

    const version = geofencesVersion();
    const geofences = stmtActiveGeofences.all();
    return res.json({ ok: true, geofences_version: version, geofences });
  } catch (err) {
    console.error('[heartbeat] error:', err.message);
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

app.get('/api/violations.csv', (req, res) => {
  const tier   = req.query.tier   ? String(req.query.tier).toUpperCase() : null;
  const device = req.query.device ? String(req.query.device) : null;
  const limit  = Math.min(parseInt(req.query.limit || '10000', 10) || 10000, 50000);

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
    const header = ['id', 'device', 'speed', 'speed_limit', 'excess', 'tier', 'lat', 'lon', 'received_at'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(header.map((k) => csvEscape(r[k])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="violations.csv"');
    return res.send(lines.join('\n'));
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
  const stats   = stmtStats.get();
  const registry = stmtListDevices.all();
  const violAggs = stmtViolationDevices.all();
  const devices = enrichDevices(registry, violAggs);
  const latest  = stmtLatest.get() || null;
  const hourly  = stmtHourly.all();
  const today   = stmtToday.get();
  const online_count = devices.filter((d) => d.online).length;

  return res.json({
    ok: true,
    stats: {
      ...stats,
      today: today?.count || 0,
      online_count,
      registered: registry.length,
    },
    devices,
    latest,
    hourly,
  });
});

app.get('/api/devices', (req, res) => {
  const registry = stmtListDevices.all();
  const violAggs = stmtViolationDevices.all();
  const devices = enrichDevices(registry, violAggs);
  return res.json({
    ok: true,
    count: devices.length,
    online_count: devices.filter((d) => d.online).length,
    devices,
  });
});

app.post('/api/devices', (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const body = req.body || {};
  const id = body.id != null ? String(body.id).trim() : '';
  if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

  if (stmtGetDevice.get(id)) {
    return res.status(409).json({ ok: false, error: 'Device already exists' });
  }

  const api_key = (body.api_key != null && String(body.api_key).trim() !== '')
    ? String(body.api_key).trim()
    : crypto.randomBytes(16).toString('hex');

  try {
    stmtInsertDevice.run({
      id,
      label: body.label != null ? String(body.label) : id,
      vehicle: body.vehicle != null ? String(body.vehicle) : null,
      api_key,
      notes: body.notes != null ? String(body.notes) : null,
    });
    const device = stmtGetDevice.get(id);
    console.log(`[ADMIN] Registered device ${id}`);
    return res.status(201).json({ ok: true, device });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/devices/:id', (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const id = String(req.params.id);
  const existing = stmtGetDevice.get(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });

  const body = req.body || {};
  try {
    stmtUpdateDevice.run({
      id,
      label: body.label !== undefined ? String(body.label) : null,
      vehicle: body.vehicle !== undefined ? String(body.vehicle) : null,
      api_key: body.api_key !== undefined ? String(body.api_key) : null,
      notes: body.notes !== undefined ? String(body.notes) : null,
    });
    return res.json({ ok: true, device: stmtGetDevice.get(id) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/devices/:id', (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const id = String(req.params.id);
  const info = stmtDeleteDevice.run(id);
  if (!info.changes) return res.status(404).json({ ok: false, error: 'Not found' });
  console.log(`[ADMIN] Deleted device ${id}`);
  return res.json({ ok: true, message: 'Device deleted' });
});

app.get('/api/geofences', (req, res) => {
  try {
    if (requireAdmin(req) && String(req.query.all || '') === '1') {
      return res.json({ ok: true, geofences: stmtAllGeofences.all(), geofences_version: geofencesVersion() });
    }
    return res.json({
      ok: true,
      geofences: stmtActiveGeofences.all(),
      geofences_version: geofencesVersion(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/geofences', (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const body = req.body || {};
  const name = body.name != null ? String(body.name).trim() : '';
  const lat_min = numOrNull(body.lat_min);
  const lat_max = numOrNull(body.lat_max);
  const lon_min = numOrNull(body.lon_min);
  const lon_max = numOrNull(body.lon_max);
  const limit_kph = numOrNull(body.limit_kph ?? body.limit);
  const active = body.active === undefined ? 1 : (body.active ? 1 : 0);

  if (!name || lat_min == null || lat_max == null || lon_min == null || lon_max == null || limit_kph == null) {
    return res.status(400).json({
      ok: false,
      error: 'name, lat_min, lat_max, lon_min, lon_max, limit_kph required',
    });
  }

  try {
    const info = stmtInsertGeofence.run({ name, lat_min, lat_max, lon_min, lon_max, limit_kph, active });
    const row = stmtGeofenceById.get(info.lastInsertRowid);
    console.log(`[ADMIN] Geofence #${info.lastInsertRowid} created (${name})`);
    return res.status(201).json({ ok: true, geofence: row, geofences_version: geofencesVersion() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/geofences/:id', (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const id = parseInt(req.params.id, 10);
  if (!stmtGeofenceById.get(id)) return res.status(404).json({ ok: false, error: 'Not found' });

  const body = req.body || {};
  try {
    stmtUpdateGeofence.run({
      id,
      name: body.name !== undefined ? String(body.name) : null,
      lat_min: body.lat_min !== undefined ? numOrNull(body.lat_min) : null,
      lat_max: body.lat_max !== undefined ? numOrNull(body.lat_max) : null,
      lon_min: body.lon_min !== undefined ? numOrNull(body.lon_min) : null,
      lon_max: body.lon_max !== undefined ? numOrNull(body.lon_max) : null,
      limit_kph: body.limit_kph !== undefined || body.limit !== undefined
        ? numOrNull(body.limit_kph ?? body.limit)
        : null,
      active: body.active !== undefined ? (body.active ? 1 : 0) : null,
    });
    return res.json({
      ok: true,
      geofence: stmtGeofenceById.get(id),
      geofences_version: geofencesVersion(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/geofences/:id', (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const id = parseInt(req.params.id, 10);
  const info = stmtDeleteGeofence.run(id);
  if (!info.changes) return res.status(404).json({ ok: false, error: 'Not found' });
  console.log(`[ADMIN] Geofence #${id} deleted`);
  return res.json({ ok: true, message: 'Geofence deleted', geofences_version: geofencesVersion() });
});

app.post('/api/retention', (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const days = Math.max(1, parseInt((req.body && req.body.days) || RETENTION_DAYS, 10) || RETENTION_DAYS);
  try {
    const info = stmtRetention.run(`-${days} days`);
    console.log(`[ADMIN] Retention purge: deleted ${info.changes} rows older than ${days} days`);
    return res.json({ ok: true, deleted: info.changes, days });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/violations', (req, res) => {
  if (!requireAdmin(req)) {
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
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
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
.ver{
  font-family:'IBM Plex Mono',monospace;font-size:.72rem;
  background:var(--ink);color:#9ef0e2;border-radius:8px;padding:8px 10px;
}
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
.btn-sm{padding:6px 10px;font-size:.75rem}

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
.hero-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
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
.spark{height:72px;width:100%;margin-top:auto}
.spark svg{width:100%;height:100%;display:block}

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

.side-stack{display:flex;flex-direction:column;gap:16px}
.bars{padding:16px;display:flex;flex-direction:column;gap:12px}
.bar-row{display:grid;grid-template-columns:72px 1fr 36px;gap:10px;align-items:center}
.bar-row span{font-size:.75rem;color:var(--ink-soft)}
.bar-track{height:8px;background:#e8eef4;border-radius:99px;overflow:hidden}
.bar-fill{height:100%;border-radius:99px}
.bar-fill.s{background:var(--rose)}
.bar-fill.m{background:var(--amber)}
.bar-fill.n{background:var(--sky)}
.device-list{padding:8px 0;max-height:280px;overflow:auto}
.device{
  display:flex;justify-content:space-between;gap:12px;align-items:center;
  padding:12px 16px;border-bottom:1px solid #eef2f6;
}
.device:last-child{border-bottom:none}
.device strong{font-size:.88rem}
.device .sub{font-size:.72rem;color:var(--muted);margin-top:3px}
.device .right{text-align:right;font-family:'IBM Plex Mono',monospace;font-size:.78rem}
.status-dot{
  display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;
  background:#94a3b8;vertical-align:middle;
}
.status-dot.on{background:var(--teal);box-shadow:0 0 0 3px rgba(15,157,138,.2)}
.status-dot.off{background:#94a3b8}

.mgmt{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
@media (max-width:960px){.mgmt{grid-template-columns:1fr}}
#map{height:280px;width:100%;background:#dbe4ee}
.form-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:14px 16px;
}
.form-grid .full{grid-column:1 / -1}
.form-actions{padding:0 16px 16px;display:flex;gap:8px;flex-wrap:wrap}
.geo-list,.reg-list{padding:0 0 8px;max-height:220px;overflow:auto}
.geo-item,.reg-item{
  display:flex;justify-content:space-between;gap:10px;align-items:flex-start;
  padding:10px 16px;border-bottom:1px solid #eef2f6;font-size:.8rem;
}
.geo-item:last-child,.reg-item:last-child{border-bottom:none}

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
      <div class="ver">v3.0</div>
      <div class="pill live" id="livePill"><span class="dot" id="liveDot"></span><span id="liveLabel">Connecting…</span></div>
      <div class="pill mono" id="clockPill">--:--:--</div>
      <a class="btn btn-ghost" href="/api/violations.csv">Export CSV</a>
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
    <div class="panel kpi"><div class="lbl">Peak speed</div><div class="val" id="sMaxSpeed">—</div><div class="hint">km/h · <span id="sOnlineHint">0</span> online</div></div>
  </section>

  <section class="mgmt">
    <div class="panel">
      <div class="section-hd">
        <h2>Device registry</h2>
        <span class="rel" id="regCount"></span>
      </div>
      <div class="reg-list" id="regList"><div class="empty">No devices yet</div></div>
      <div class="form-grid">
        <input class="field" id="devId" placeholder="Device ID *" >
        <input class="field" id="devLabel" placeholder="Label">
        <input class="field" id="devVehicle" placeholder="Vehicle">
        <input class="field" id="devKey" placeholder="API key (auto if blank)">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" type="button" onclick="addDevice()">Add device</button>
      </div>
    </div>
    <div class="panel">
      <div class="section-hd"><h2>Live map</h2><span class="rel">Last known positions</span></div>
      <div id="map"></div>
    </div>
  </section>

  <section class="panel" style="margin-bottom:16px">
    <div class="section-hd">
      <h2>Geofences</h2>
      <span class="rel" id="geoCount"></span>
    </div>
    <div class="geo-list" id="geoList"><div class="empty">Loading…</div></div>
    <div class="form-grid">
      <input class="field full" id="geoName" placeholder="Name *">
      <input class="field" id="geoLatMin" placeholder="lat_min" type="number" step="any">
      <input class="field" id="geoLatMax" placeholder="lat_max" type="number" step="any">
      <input class="field" id="geoLonMin" placeholder="lon_min" type="number" step="any">
      <input class="field" id="geoLonMax" placeholder="lon_max" type="number" step="any">
      <input class="field" id="geoLimit" placeholder="limit_kph *" type="number" step="any">
    </div>
    <div class="form-actions">
      <button class="btn btn-primary btn-sm" type="button" onclick="addGeofence()">Add geofence</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="runRetention()">Run retention purge</button>
    </div>
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
        <a class="btn btn-ghost" id="csvLink" href="/api/violations.csv">CSV</a>
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
      <a href="/api/devices">/api/devices</a> ·
      <a href="/api/geofences">/api/geofences</a> ·
      <a href="/api/violations.csv">CSV</a>
    </div>
    <div>Velocis server v3.0 · port ${PORT}</div>
  </footer>
</div>

<div id="toasts"></div>

<div class="modal-back" id="adminModal" onclick="if(event.target===this)closeAdmin()">
  <div class="modal">
    <h3>Admin access</h3>
    <p>Stored locally in this browser. Required for device/geofence management, retention, and clearing the violation log.</p>
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
let map = null;
let mapMarkers = [];

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

function adminHeaders(json){
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (adminKey) h['X-Admin-Key'] = adminKey;
  return h;
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

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function tierBadge(t){
  const c = t === 'SEVERE' ? 'b-severe' : t === 'MODERATE' ? 'b-moderate' : 'b-minor';
  return '<span class="badge ' + c + '">' + esc(t) + '</span>';
}

function mapLink(lat, lon){
  if (lat == null || lon == null) return '—';
  const a = parseFloat(lat), b = parseFloat(lon);
  if (Number.isNaN(a) || Number.isNaN(b)) return '—';
  return '<a class="map-link" href="https://maps.google.com/?q=' + a + ',' + b +
    '" target="_blank" rel="noopener">' + a.toFixed(4) + ', ' + b.toFixed(4) + '</a>';
}

function ensureMap(){
  if (map || typeof L === 'undefined') return;
  map = L.map('map', { zoomControl: true }).setView([9.07, 7.40], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
}

function updateMap(devices){
  ensureMap();
  if (!map) return;
  mapMarkers.forEach(m => map.removeLayer(m));
  mapMarkers = [];
  const pts = [];
  (devices || []).forEach(d => {
    const lat = parseFloat(d.last_lat);
    const lon = parseFloat(d.last_lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    const label = d.label || d.id || d.device || '?';
    const m = L.circleMarker([lat, lon], {
      radius: 8,
      color: d.online ? '#0a7a6b' : '#64748b',
      fillColor: d.online ? '#0f9d8a' : '#94a3b8',
      fillOpacity: 0.85,
      weight: 2
    }).addTo(map);
    m.bindPopup('<strong>' + esc(label) + '</strong><br>' +
      (d.last_speed != null ? d.last_speed + ' km/h<br>' : '') +
      relTime(d.last_seen));
    mapMarkers.push(m);
    pts.push([lat, lon]);
  });
  if (pts.length) {
    try { map.fitBounds(pts, { padding: [24, 24], maxZoom: 14 }); } catch (e) {}
  }
  setTimeout(() => { if (map) map.invalidateSize(); }, 80);
}

function renderSpark(hourly){
  const host = document.getElementById('spark');
  const mapH = {};
  (hourly || []).forEach(h => { mapH[h.bucket] = h; });

  const points = [];
  const now = new Date();
  now.setMinutes(0,0,0);
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000);
    const key = d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0') + ' ' +
      String(d.getHours()).padStart(2,'0') + ':00';
    points.push({ key, count: (mapH[key] && mapH[key].count) || 0, severe: (mapH[key] && mapH[key].severe) || 0 });
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
    meta.innerHTML =
      '<span class="chip">' + (stats.online_count || 0) + ' online</span>' +
      '<span class="chip">' + (stats.registered || stats.devices || 0) + ' registered</span>';
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
      parseFloat(latest.lon).toFixed(3) + '</span>' : '') +
    '<span class="chip">' + (stats.online_count || 0) + ' online</span>';

  if (lastLatestId != null && latest.id !== lastLatestId) {
    toast('New ' + latest.tier + ' from ' + latest.device, !isSevere);
  }
  lastLatestId = latest.id;
}

function renderRegistry(devices){
  const list = document.getElementById('regList');
  const online = (devices || []).filter(d => d.online).length;
  document.getElementById('regCount').textContent = online + ' online · ' + (devices || []).length + ' total';

  if (!devices || !devices.length) {
    list.innerHTML = '<div class="empty">No devices yet</div>';
    return;
  }

  list.innerHTML = devices.map(d => {
    const id = d.id || d.device;
    const label = d.label || id;
    return '<div class="reg-item"><div>' +
      '<span class="status-dot ' + (d.online ? 'on' : 'off') + '"></span>' +
      '<strong>' + esc(label) + '</strong>' +
      (d.vehicle ? ' <span class="rel">· ' + esc(d.vehicle) + '</span>' : '') +
      '<div class="sub mono">' + esc(id) + '</div>' +
      '<div class="sub">' + (d.last_speed != null ? d.last_speed + ' km/h · ' : '') +
      relTime(d.last_seen) + '</div></div>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-id="' + esc(id) +
      '" onclick="deleteDevice(this.getAttribute(&quot;data-id&quot;))">Del</button></div>';
  }).join('');
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
  document.getElementById('sOnlineHint').textContent = s.online_count ?? 0;

  renderMix(s);
  renderSpark(d.hourly || []);
  updateHero(d.latest, s);
  renderRegistry(d.devices || []);
  updateMap(d.devices || []);

  const list = document.getElementById('devList');
  const online = (d.devices || []).filter(dv => dv.online).length;
  document.getElementById('deviceCount').textContent = online + ' online · ' + (d.devices || []).length;
  if (!d.devices.length) {
    list.innerHTML = '<div class="empty">No devices yet</div>';
  } else {
    list.innerHTML = d.devices.map(dv => {
      const name = dv.label || dv.device || dv.id;
      return '<div class="device"><div>' +
        '<span class="status-dot ' + (dv.online ? 'on' : 'off') + '"></span>' +
        '<strong>' + esc(name) + '</strong>' +
        '<div class="sub">' + (dv.total_violations || 0) + ' events · ' +
        (dv.severe || 0) + ' severe</div></div>' +
        '<div class="right">' + (dv.last_speed != null ? dv.last_speed : (dv.max_speed != null ? dv.max_speed : '—')) + ' km/h' +
        '<div class="sub">' + relTime(dv.last_seen) + '</div></div></div>';
    }).join('');
  }
}

async function loadGeofences(){
  const url = adminKey
    ? '/api/geofences?all=1&key=' + encodeURIComponent(adminKey)
    : '/api/geofences';
  const r = await fetch(url);
  const d = await r.json();
  if (!d.ok) throw new Error('geofences failed');
  const rows = d.geofences || [];
  document.getElementById('geoCount').textContent = rows.length + ' zones · ' + (d.geofences_version || '');
  const host = document.getElementById('geoList');
  if (!rows.length) {
    host.innerHTML = '<div class="empty">No geofences</div>';
    return;
  }
  host.innerHTML = rows.map(g =>
    '<div class="geo-item"><div><strong>' + esc(g.name) + '</strong>' +
    (g.active ? '' : ' <span class="rel">(inactive)</span>') +
    '<div class="sub mono">' + g.lat_min + '–' + g.lat_max + ' / ' +
    g.lon_min + '–' + g.lon_max + ' · ' + g.limit_kph + ' km/h</div></div>' +
    '<button class="btn btn-ghost btn-sm" type="button" onclick="deleteGeofence(' + g.id + ')">Del</button></div>'
  ).join('');
}

async function loadViolations(){
  const tier = document.getElementById('filterTier').value;
  const device = document.getElementById('filterDevice').value.trim();
  let url = '/api/violations?limit=200';
  let csv = '/api/violations.csv?';
  if (tier) { url += '&tier=' + encodeURIComponent(tier); csv += 'tier=' + encodeURIComponent(tier) + '&'; }
  if (device) { url += '&device=' + encodeURIComponent(device); csv += 'device=' + encodeURIComponent(device) + '&'; }
  document.getElementById('csvLink').href = csv.replace(/[&?]$/, '');

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
      '<td><strong>' + esc(v.device) + '</strong></td>' +
      '<td>' + tierBadge(v.tier) + '</td>' +
      '<td class="mono"><strong>' + v.speed + '</strong></td>' +
      '<td class="mono">' + v.speed_limit + '</td>' +
      '<td class="mono" style="color:' + excessColor + '">+' + v.excess + '</td>' +
      '<td>' + mapLink(v.lat, v.lon) + '</td>' +
      '<td><div class="rel">' + relTime(v.received_at) + '</div>' +
      '<div class="rel mono">' + esc(v.received_at) + '</div></td>' +
      '</tr>';
  }).join('');
}

async function loadAll(manual){
  try {
    await Promise.all([loadStats(), loadViolations(), loadGeofences()]);
    const h = await fetch('/api/health').then(r => r.json());
    setLive(!!h.ok, h.ok ? 'Live · v' + (h.version || '3.0') + ' · ' + h.uptime_s + 's' : 'Degraded');
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

async function addDevice(){
  if (!adminKey) { openAdmin(); toast('Set admin key first', false); return; }
  const id = document.getElementById('devId').value.trim();
  if (!id) { toast('Device ID required', false); return; }
  const body = {
    id,
    label: document.getElementById('devLabel').value.trim() || id,
    vehicle: document.getElementById('devVehicle').value.trim() || null,
    api_key: document.getElementById('devKey').value.trim() || undefined
  };
  try {
    const r = await fetch('/api/devices?key=' + encodeURIComponent(adminKey), {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) {
      toast('Device registered' + (d.device && d.device.api_key ? ' · key: ' + d.device.api_key : ''));
      document.getElementById('devId').value = '';
      document.getElementById('devLabel').value = '';
      document.getElementById('devVehicle').value = '';
      document.getElementById('devKey').value = '';
      loadStats();
    } else toast(d.error || 'Failed', false);
  } catch { toast('Request failed', false); }
}

async function deleteDevice(id){
  if (!adminKey) { openAdmin(); toast('Set admin key first', false); return; }
  if (!confirm('Delete device ' + id + '?')) return;
  try {
    const r = await fetch('/api/devices/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(adminKey), {
      method: 'DELETE',
      headers: adminHeaders(false)
    });
    const d = await r.json();
    if (d.ok) { toast('Device deleted'); loadStats(); }
    else toast(d.error || 'Failed', false);
  } catch { toast('Request failed', false); }
}

async function addGeofence(){
  if (!adminKey) { openAdmin(); toast('Set admin key first', false); return; }
  const body = {
    name: document.getElementById('geoName').value.trim(),
    lat_min: parseFloat(document.getElementById('geoLatMin').value),
    lat_max: parseFloat(document.getElementById('geoLatMax').value),
    lon_min: parseFloat(document.getElementById('geoLonMin').value),
    lon_max: parseFloat(document.getElementById('geoLonMax').value),
    limit_kph: parseFloat(document.getElementById('geoLimit').value)
  };
  if (!body.name || Number.isNaN(body.limit_kph)) {
    toast('Name and limit required', false); return;
  }
  try {
    const r = await fetch('/api/geofences?key=' + encodeURIComponent(adminKey), {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) {
      toast('Geofence added');
      ['geoName','geoLatMin','geoLatMax','geoLonMin','geoLonMax','geoLimit'].forEach(id => {
        document.getElementById(id).value = '';
      });
      loadGeofences();
    } else toast(d.error || 'Failed', false);
  } catch { toast('Request failed', false); }
}

async function deleteGeofence(id){
  if (!adminKey) { openAdmin(); toast('Set admin key first', false); return; }
  if (!confirm('Delete geofence #' + id + '?')) return;
  try {
    const r = await fetch('/api/geofences/' + id + '?key=' + encodeURIComponent(adminKey), {
      method: 'DELETE',
      headers: adminHeaders(false)
    });
    const d = await r.json();
    if (d.ok) { toast('Geofence deleted'); loadGeofences(); }
    else toast(d.error || 'Failed', false);
  } catch { toast('Request failed', false); }
}

async function runRetention(){
  if (!adminKey) { openAdmin(); toast('Set admin key first', false); return; }
  if (!confirm('Purge violations older than retention window?')) return;
  try {
    const r = await fetch('/api/retention?key=' + encodeURIComponent(adminKey), {
      method: 'POST',
      headers: adminHeaders(true),
      body: '{}'
    });
    const d = await r.json();
    if (d.ok) { toast('Purged ' + d.deleted + ' rows (>' + d.days + 'd)'); loadAll(); }
    else toast(d.error || 'Failed', false);
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
ensureMap();
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
  console.log(`║  Velocis Speed Monitor Server  v3.0      ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Dashboard : http://localhost:${String(PORT).padEnd(5)}      ║`);
  console.log(`║  Health    : GET  /api/health            ║`);
  console.log(`║  Ingest    : POST /api/violation         ║`);
  console.log(`║  Heartbeat : POST /api/heartbeat         ║`);
  console.log(`║  Auth      : ${String(REQUIRE_AUTH ? 'REQUIRED' : 'optional').padEnd(28)} ║`);
  console.log(`║  DB File   : ${String(DB_FILE).slice(-28).padEnd(28)} ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});

module.exports = app;
