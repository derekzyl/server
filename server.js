/**
 * ============================================================
 *  Velocis Server  v3.2
 *  Node.js + Express + SQLite
 *
 *  Endpoints
 *  ---------
 *  POST   /api/violation              ← ESP32 posts alerts
 *  POST   /api/heartbeat              ← device presence / last_* (+ limit sync)
 *  POST   /api/track                  ← GPS track points (batch)
 *  GET    /api/track?device=&hours=   ← track + Google Maps route URL
 *  GET    /api/track.csv              ← track CSV export
 *  GET    /api/violations             ← list (JSON)
 *  GET    /api/violations/:id         ← single
 *  GET    /api/violations.csv         ← CSV export
 *  GET    /api/stats                  ← summary + devices + hourly
 *  GET    /api/devices                ← device registry (+ online)
 *  POST   /api/devices                ← admin register
 *  PATCH  /api/devices/:id            ← admin update
 *  PATCH  /api/devices/:id/limit      ← admin set speed limit (pushed on next heartbeat)
 *  DELETE /api/devices/:id            ← admin delete
 *  GET    /api/geofences              ← active (public) / all (admin)
 *  POST   /api/geofences              ← admin create
 *  PATCH  /api/geofences/:id          ← admin update
 *  DELETE /api/geofences/:id          ← admin delete
 *  POST   /api/retention              ← admin purge old rows
 *  GET    /api/health                 ← uptime / db ping
 *  DELETE /api/violations             ← clear all (admin)
 *  POST   /api/test-sms               ← SMS simulation
 *  POST   /api/login                  ← dashboard session (admin|viewer)
 *  POST   /api/logout                 ← clear session cookie
 *  GET    /api/me                     ← { ok, role }
 *  GET    /                           ← live dashboard (or login)
 *
 *  Config (.env):
 *    PORT=3000
 *    ADMIN_KEY=changeme
 *    VIEWER_KEY=viewer
 *    DASHBOARD_AUTH=false
 *    DB_FILE=./violations.db
 *    REQUIRE_AUTH=false
 *    DEVICE_API_KEY=
 *    TELEGRAM_BOT_TOKEN=
 *    TELEGRAM_CHAT_ID=
 *    RETENTION_DAYS=90
 *    CARTO_API_KEY=
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
const VIEWER_KEY        = process.env.VIEWER_KEY || 'viewer';
const DASHBOARD_AUTH    = String(process.env.DASHBOARD_AUTH || 'false').toLowerCase() === 'true';
const DB_FILE           = process.env.DB_FILE   || path.join(__dirname, 'violations.db');
const REQUIRE_AUTH      = String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';
const DEVICE_API_KEY    = process.env.DEVICE_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID || '';
const RETENTION_DAYS    = Math.max(1, parseInt(process.env.RETENTION_DAYS || '90', 10) || 90);
const CARTO_API_KEY     = process.env.CARTO_API_KEY || '';
const ONLINE_WINDOW_S   = 120;
const STARTED           = Date.now();
const VERSION           = '3.2';
const SESS_COOKIE       = 'velocis_sess';
const SESS_MAX_AGE_S    = 7 * 24 * 60 * 60;

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

  CREATE TABLE IF NOT EXISTS track_points (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device      TEXT    NOT NULL,
    lat         REAL    NOT NULL,
    lon         REAL    NOT NULL,
    speed       REAL,
    speed_limit REAL,
    over        INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_track_dev_time ON track_points(device, recorded_at);
`);

// Additive column migrations for databases created by older versions.
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`[DB]  Migrated: ${table}.${column}`);
  }
}
// limit_kph/limit_mode: the device's configured limit. limit_rev bumps on each
// dashboard edit; limit_ack_rev is the rev the device last confirmed applying.
addColumnIfMissing('devices', 'limit_kph',     'REAL');
addColumnIfMissing('devices', 'limit_mode',    "TEXT DEFAULT 'manual'");
addColumnIfMissing('devices', 'limit_rev',     'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('devices', 'limit_ack_rev', 'INTEGER NOT NULL DEFAULT 0');

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

const stmtTrackRetention = db.prepare(`
  DELETE FROM track_points
  WHERE recorded_at < datetime('now', 'localtime', ?)
`);

const stmtInsertTrack = db.prepare(`
  INSERT INTO track_points (device, lat, lon, speed, speed_limit, over, recorded_at)
  VALUES (@device, @lat, @lon, @speed, @speed_limit, @over, datetime('now', 'localtime', @offset))
`);

const stmtTrackForDevice = db.prepare(`
  SELECT id, device, lat, lon, speed, speed_limit, over, recorded_at
  FROM track_points
  WHERE device = @device AND recorded_at >= datetime('now', 'localtime', @since)
  ORDER BY recorded_at DESC, id DESC
  LIMIT @limit
`);

const stmtTrackCounts = db.prepare(`
  SELECT device, COUNT(*) AS points, MAX(recorded_at) AS last_point
  FROM track_points
  WHERE recorded_at >= datetime('now', 'localtime', '-24 hours')
  GROUP BY device
`);

const stmtSetDeviceLimit = db.prepare(`
  UPDATE devices SET limit_kph = @kph, limit_mode = @mode, limit_rev = limit_rev + 1
  WHERE id = @id
`);

const stmtDeviceLimitReport = db.prepare(`
  UPDATE devices SET
    limit_kph     = @kph,
    limit_mode    = @mode,
    limit_ack_rev = @ack,
    limit_rev     = MAX(limit_rev, @ack)
  WHERE id = @id
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

function parseCookies(req) {
  const header = req.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function signRole(role) {
  return crypto.createHmac('sha256', ADMIN_KEY).update(String(role)).digest('hex');
}

function makeSessionToken(role) {
  return role + ':' + signRole(role);
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf(':');
  if (i < 0) return null;
  const role = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (role !== 'admin' && role !== 'viewer') return null;
  const expected = signRole(role);
  try {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return role;
}

function sessionCookieHeader(token) {
  return (
    SESS_COOKIE + '=' + encodeURIComponent(token) +
    '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + SESS_MAX_AGE_S
  );
}

function clearSessionCookieHeader() {
  return SESS_COOKIE + '=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';
}

function getProvidedAccessKey(req) {
  const q = req.query && req.query.key != null ? String(req.query.key) : '';
  const h =
    req.get('X-Admin-Key') ||
    req.get('x-admin-key') ||
    req.get('X-API-Key') ||
    req.get('x-api-key') ||
    '';
  const auth = req.get('Authorization') || req.get('authorization') || '';
  const bearer = (auth.match(/^Bearer\s+(.+)$/i) || [])[1] || '';
  return String(q || h || bearer || '').trim();
}

/** Resolve role from cookie or X-Admin-Key / Bearer / ?key= */
function getSessionRole(req) {
  const provided = getProvidedAccessKey(req);
  if (provided && provided === ADMIN_KEY) return 'admin';
  if (provided && provided === VIEWER_KEY) return 'viewer';

  const cookies = parseCookies(req);
  const fromCookie = verifySessionToken(cookies[SESS_COOKIE]);
  if (fromCookie) return fromCookie;
  return 'none';
}

function requireAdmin(req) {
  return getSessionRole(req) === 'admin';
}

/** Admin or viewer when DASHBOARD_AUTH; otherwise open (compat). */
function requireViewer(req) {
  if (!DASHBOARD_AUTH) return true;
  const role = getSessionRole(req);
  return role === 'admin' || role === 'viewer';
}

function unauthorized(res, asHtml) {
  if (asHtml) {
    return res.status(401).type('html').send(getLoginHTML('Session required'));
  }
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
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

function normalizeMode(m) {
  const s = String(m || '').toLowerCase();
  return s === 'auto' || s === 'manual' ? s : null;
}

/**
 * Two-way speed-limit sync, called on every device report (heartbeat / track).
 * - Dashboard edit newer than what the device applied → return it for the device to apply.
 * - Otherwise the device is authoritative: store what it reports (button/local web edits).
 */
function syncDeviceLimit(deviceId, body) {
  const d = stmtGetDevice.get(String(deviceId));
  if (!d) return null;

  const devRev  = intOrNull(body.limit_rev) || 0;
  const devKph  = numOrNull(body.limit_setting);
  const devMode = normalizeMode(body.limit_mode);
  const srvRev  = d.limit_rev || 0;

  if (srvRev > devRev && d.limit_kph != null) {
    return { kph: d.limit_kph, mode: d.limit_mode || 'manual', rev: srvRev };
  }
  if (devKph != null && devMode) {
    stmtDeviceLimitReport.run({ id: d.id, kph: devKph, mode: devMode, ack: devRev });
  }
  return null;
}

function validLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6);
}

function gmapsPointUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${(+lat).toFixed(6)},${(+lon).toFixed(6)}`;
}

/** Route through up to maxStops evenly sampled points (oldest → newest). */
function gmapsRouteUrl(pointsAsc, maxStops = 10) {
  if (!pointsAsc.length) return null;
  if (pointsAsc.length === 1) return gmapsPointUrl(pointsAsc[0].lat, pointsAsc[0].lon);
  const n = Math.min(maxStops, pointsAsc.length);
  const picked = [];
  for (let i = 0; i < n; i++) {
    picked.push(pointsAsc[Math.round((i * (pointsAsc.length - 1)) / (n - 1))]);
  }
  return 'https://www.google.com/maps/dir/' +
    picked.map((p) => `${(+p.lat).toFixed(6)},${(+p.lon).toFixed(6)}`).join('/');
}

/** Accepts { points: [...] } batches or a single { lat, lon, ... } point. */
function parseTrackPoints(body) {
  const raw = Array.isArray(body.points) ? body.points : [body];
  const out = [];
  for (const p of raw.slice(0, 200)) {
    const lat = numOrNull(p.lat);
    const lon = numOrNull(p.lon);
    if (!validLatLon(lat, lon)) continue;
    const speed = numOrNull(p.speed);
    const limit = numOrNull(p.limit ?? p.speed_limit);
    const age = Math.max(0, Math.min(7 * 86400, intOrNull(p.age_s) || 0));
    out.push({
      lat, lon, speed, speed_limit: limit,
      over: speed != null && limit != null && speed > limit ? 1 : 0,
      age,
    });
  }
  return out;
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
  const trackById = new Map(stmtTrackCounts.all().map((t) => [t.device, t]));

  const enriched = registryRows.map((d) => {
    const agg = byId.get(d.id) || {};
    const tr = trackById.get(d.id) || {};
    const hasPos = validLatLon(d.last_lat, d.last_lon);
    const online = isOnline(d.last_seen);
    return {
      ...d,
      device: d.id,
      online,
      total_violations: agg.total_violations || 0,
      max_speed: agg.max_speed != null ? agg.max_speed : d.last_speed,
      severe: agg.severe || 0,
      label: d.label || d.id,
      vehicle: d.vehicle || null,
      limit_mode: d.limit_mode || 'manual',
      limit_pending: (d.limit_rev || 0) > (d.limit_ack_rev || 0),
      over_limit: online && d.gps_valid !== 0 && d.last_speed != null && d.last_limit != null &&
        d.last_speed > d.last_limit,
      gmaps_url: hasPos ? gmapsPointUrl(d.last_lat, d.last_lon) : null,
      track_points_24h: tr.points || 0,
      last_track_at: tr.last_point || null,
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
    dashboard_auth: DASHBOARD_AUTH,
    telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    retention_days: RETENTION_DAYS,
  });
});

app.post('/api/login', (req, res) => {
  const key = String((req.body && req.body.key) || '').trim();
  let role = null;
  if (key && key === ADMIN_KEY) role = 'admin';
  else if (key && key === VIEWER_KEY) role = 'viewer';
  else return res.status(401).json({ ok: false, error: 'Invalid key' });

  res.setHeader('Set-Cookie', sessionCookieHeader(makeSessionToken(role)));
  return res.json({ ok: true, role });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookieHeader());
  return res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const role = getSessionRole(req);
  return res.json({
    ok: true,
    role: role === 'admin' || role === 'viewer' ? role : 'none',
    dashboard_auth: DASHBOARD_AUTH,
    carto_key: CARTO_API_KEY,
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
        (validLatLon(row.lat, row.lon) ? `Map: ${gmapsPointUrl(row.lat, row.lon)}` : 'Loc: n/a');
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

    const limit = syncDeviceLimit(device, body);
    const version = geofencesVersion();
    const geofences = stmtActiveGeofences.all();
    return res.json({ ok: true, geofences_version: version, geofences, ...(limit ? { limit } : {}) });
  } catch (err) {
    console.error('[heartbeat] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
});

// ── GPS track log ───────────────────────────────────────────
app.post('/api/track', (req, res) => {
  const body = req.body || {};
  const device = String(body.device || body.id || 'UNKNOWN');

  const auth = authorizeDevice(req, device);
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });

  const points = parseTrackPoints(body);
  try {
    const insertAll = db.transaction((rows) => {
      for (const p of rows) {
        stmtInsertTrack.run({
          device, lat: p.lat, lon: p.lon, speed: p.speed, speed_limit: p.speed_limit,
          over: p.over, offset: `-${p.age} seconds`,
        });
      }
    });
    insertAll(points);

    const known = stmtGetDevice.get(device);
    if (!REQUIRE_AUTH || known || (DEVICE_API_KEY && getApiKey(req) === DEVICE_API_KEY)) {
      const newest = points.reduce((a, p) => (!a || p.age < a.age ? p : a), null);
      upsertDevicePresence({
        id: device,
        lat: newest ? newest.lat : null,
        lon: newest ? newest.lon : null,
        speed: newest ? newest.speed : body.speed,
        limit: newest ? newest.speed_limit : body.limit,
        gps_valid: newest ? 1 : body.gps_valid,
      });
    }

    const limit = syncDeviceLimit(device, body);
    return res.status(201).json({ ok: true, stored: points.length, ...(limit ? { limit } : {}) });
  } catch (err) {
    console.error('[track] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
});

function queryTrack(req) {
  const device = String(req.query.device || '').trim();
  const hours = Math.max(1, Math.min(24 * 30, parseInt(req.query.hours || '24', 10) || 24));
  const limit = Math.max(1, Math.min(20000, parseInt(req.query.limit || '2000', 10) || 2000));
  const rows = device
    ? stmtTrackForDevice.all({ device, since: `-${hours} hours`, limit })
    : [];
  return { device, hours, rows };
}

app.get('/api/track', (req, res) => {
  if (!requireViewer(req)) return unauthorized(res);
  const { device, hours, rows } = queryTrack(req);
  if (!device) return res.status(400).json({ ok: false, error: 'device is required' });
  const asc = rows.slice().reverse();
  return res.json({
    ok: true,
    device,
    hours,
    count: asc.length,
    points: asc.map((p) => ({ ...p, gmaps_url: gmapsPointUrl(p.lat, p.lon) })),
    route_url: gmapsRouteUrl(asc),
  });
});

app.get('/api/track.csv', (req, res) => {
  if (!requireViewer(req)) return unauthorized(res);
  const { device, rows } = queryTrack(req);
  if (!device) return res.status(400).json({ ok: false, error: 'device is required' });
  const header = ['id', 'device', 'lat', 'lon', 'speed', 'speed_limit', 'over', 'recorded_at', 'google_maps'];
  const lines = [header.join(',')];
  for (const r of rows.slice().reverse()) {
    lines.push(header.map((k) => csvEscape(k === 'google_maps' ? gmapsPointUrl(r.lat, r.lon) : r[k])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="track-${device}.csv"`);
  return res.send(lines.join('\n'));
});

app.get('/api/violations', (req, res) => {
  if (!requireViewer(req)) return unauthorized(res);

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
  if (!requireViewer(req)) return unauthorized(res);

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
  if (!requireViewer(req)) return unauthorized(res);

  const row = stmtById.get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  return res.json({ ok: true, violation: row });
});

app.get('/api/stats', (req, res) => {
  if (!requireViewer(req)) return unauthorized(res);

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
  if (!requireViewer(req)) return unauthorized(res);

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

// Queued until the device's next heartbeat/track upload, which returns it.
app.patch('/api/devices/:id/limit', (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const id = String(req.params.id);
  if (!stmtGetDevice.get(id)) return res.status(404).json({ ok: false, error: 'Not found' });

  const body = req.body || {};
  const kph = numOrNull(body.limit_kph ?? body.limit);
  const mode = normalizeMode(body.mode ?? body.limit_mode) || 'manual';
  if (kph == null || kph < 5 || kph > 250) {
    return res.status(400).json({ ok: false, error: 'limit_kph must be between 5 and 250' });
  }
  try {
    stmtSetDeviceLimit.run({ id, kph: Math.round(kph), mode });
    const d = stmtGetDevice.get(id);
    console.log(`[ADMIN] Limit for ${id} → ${Math.round(kph)} km/h (${mode}), rev ${d.limit_rev}`);
    return res.json({
      ok: true,
      device: id,
      limit_kph: d.limit_kph,
      limit_mode: d.limit_mode,
      limit_rev: d.limit_rev,
      limit_pending: d.limit_rev > d.limit_ack_rev,
    });
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
    const trackInfo = stmtTrackRetention.run(`-${days} days`);
    console.log(`[ADMIN] Retention purge: deleted ${info.changes} violations, ${trackInfo.changes} track points older than ${days} days`);
    return res.json({ ok: true, deleted: info.changes, track_deleted: trackInfo.changes, days });
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
//  DASHBOARD & STATIC ASSETS
// ══════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (DASHBOARD_AUTH && !requireViewer(req)) {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route ${req.method} ${req.path} not found` });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Velocis Speed Monitor Server  v${VERSION}      ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Dashboard : http://localhost:${String(PORT).padEnd(5)}      ║`);
  console.log(`║  Health    : GET  /api/health            ║`);
  console.log(`║  Ingest    : POST /api/violation         ║`);
  console.log(`║  Heartbeat : POST /api/heartbeat         ║`);
  console.log(`║  Auth      : ${String(REQUIRE_AUTH ? 'REQUIRED' : 'optional').padEnd(28)} ║`);
  console.log(`║  Dash auth : ${String(DASHBOARD_AUTH ? 'ON' : 'off').padEnd(28)} ║`);
  console.log(`║  DB File   : ${String(DB_FILE).slice(-28).padEnd(28)} ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});

module.exports = app;
