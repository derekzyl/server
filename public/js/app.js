/**
 * Velocis Telemetry & Speed Intelligence Console
 * Modular Client Application
 */

const REFRESH_INTERVAL_MS = 4000;
let adminKey = localStorage.getItem('velocis_admin') || '';
let sessionRole = 'none';
let dashboardAuth = false;
let soundEnabled = localStorage.getItem('velocis_sound') !== 'false';
let currentTheme = localStorage.getItem('velocis_theme') || 'dark';

let loadTimer = null;
let debounceTimer = null;
let lastLatestId = null;
let map = null;
let mapMarkers = {};
let geofenceLayers = [];
let trackLayer = null;
let trackVisible = false;
let trackFitPending = false;
let audioCtx = null;

// Telemetry State
let telemetryData = {
  stats: {},
  devices: [],
  violations: [],
  geofences: [],
  hourly: []
};

// ── Audio Alert Synthesizer (Web Audio API) ─────────────────
function playAlertSound(tier) {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();

    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);

    if (tier === 'SEVERE') {
      // Urgent dual-pulse chirp
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(880, now);
      osc1.frequency.exponentialRampToValueAtTime(1760, now + 0.15);
      osc1.frequency.setValueAtTime(880, now + 0.2);
      osc1.frequency.exponentialRampToValueAtTime(1760, now + 0.35);

      gain1.gain.setValueAtTime(0.3, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.45);

      osc1.start(now);
      osc1.stop(now + 0.45);
    } else {
      // Subtle warning chime
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.setValueAtTime(880, now + 0.1);  // A5

      gain1.gain.setValueAtTime(0.2, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

      osc1.start(now);
      osc1.stop(now + 0.3);
    }
  } catch (e) {
    console.warn('Audio alert error:', e);
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('velocis_sound', soundEnabled);
  updateSoundUI();
  toast(soundEnabled ? 'Alert chimes active' : 'Alert chimes muted');
  if (soundEnabled) playAlertSound('MINOR');
}

function updateSoundUI() {
  const btn = document.getElementById('soundToggleBtn');
  if (btn) {
    btn.innerHTML = soundEnabled ? '🔔 Chimes ON' : '🔕 Muted';
    btn.classList.toggle('active', soundEnabled);
  }
}

// ── Theme Manager ───────────────────────────────────────────
function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('velocis_theme', theme);
  const themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) {
    themeBtn.innerHTML = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  }
  if (map) {
    // Invalidate Leaflet tile layers if needed
    setTimeout(() => map.invalidateSize(), 100);
  }
}

function toggleTheme() {
  setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// ── Toast Notification System ───────────────────────────────
function toast(msg, ok = true) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (ok ? 'ok' : 'err');
  el.innerHTML = (ok ? '<span>✓</span> ' : '<span>⚠️</span> ') + esc(msg);
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    el.style.transition = 'all 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ── Helpers ─────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(String(iso).replace(' ', 'T'));
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function gmapsUrl(lat, lon) {
  const a = parseFloat(lat), b = parseFloat(lon);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${a.toFixed(6)},${b.toFixed(6)}`;
}

function gmapsLink(lat, lon, text = 'Google Maps ↗', cls = 'btn btn-ghost btn-sm') {
  const url = gmapsUrl(lat, lon);
  return url ? `<a class="${cls}" href="${url}" target="_blank" rel="noopener">${text}</a>` : '';
}

function isAdminRole() {
  if (sessionRole === 'admin') return true;
  if (sessionRole === 'viewer') return false;
  return !!adminKey;
}

function adminHeaders(isJson = false) {
  const h = {};
  if (isJson) h['Content-Type'] = 'application/json';
  if (adminKey) h['X-Admin-Key'] = adminKey;
  return h;
}

function adminQuery() {
  return adminKey ? ('?key=' + encodeURIComponent(adminKey)) : '';
}

// ── Role & Authentication UI ────────────────────────────────
function applyRoleUI() {
  const isAdmin = sessionRole === 'admin';
  const isViewer = sessionRole === 'viewer';
  const loggedIn = isAdmin || isViewer;
  const showAdminControls = !isViewer && isAdminRole();

  const rolePill = document.getElementById('rolePill');
  if (rolePill) {
    if (isAdmin) {
      rolePill.style.display = '';
      rolePill.innerHTML = '<span class="pulse-dot live"></span> Admin Mode';
    } else if (isViewer) {
      rolePill.style.display = '';
      rolePill.innerHTML = '<span class="pulse-dot"></span> Viewer Mode';
    } else {
      rolePill.style.display = 'none';
    }
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.style.display = loggedIn ? '' : 'none';

  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.style.display = showAdminControls ? '' : 'none';
  });
}

async function initAuth() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    const d = await r.json();
    sessionRole = (d && d.role) || 'none';
    dashboardAuth = !!(d && d.dashboard_auth);
  } catch {
    sessionRole = 'none';
  }
  applyRoleUI();
  if (dashboardAuth && sessionRole === 'none') {
    location.href = '/';
    return false;
  }
  return true;
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  sessionRole = 'none';
  applyRoleUI();
  location.href = '/';
}

function openAdmin() {
  document.getElementById('adminKeyInput').value = adminKey;
  document.getElementById('adminModal').classList.add('open');
  document.getElementById('adminKeyInput').focus();
}

function closeAdmin() {
  document.getElementById('adminModal').classList.remove('open');
}

function saveAdmin() {
  adminKey = document.getElementById('adminKeyInput').value.trim();
  localStorage.setItem('velocis_admin', adminKey);
  closeAdmin();
  applyRoleUI();
  toast(adminKey ? 'Admin key active' : 'Admin key cleared');
  loadAll(true);
}

// ── Tab Management ──────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-content-panel').forEach(panel => {
    panel.style.display = panel.id === `tab-${tabId}` ? 'block' : 'none';
  });
  if (tabId === 'cockpit' && map) {
    setTimeout(() => map.invalidateSize(), 150);
  }
}

// ── Interactive Leaflet Fleet Map ───────────────────────────
function initMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map', { zoomControl: true }).setView([9.07, 7.40], 11);

  // Modern CartoDB Dark Matter / Positron or OSM
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  }).addTo(map);

  // Stop the periodic auto-fit from yanking the view once the user moves the map.
  map.on('dragstart', () => { map._userPanned = true; });

  // Allow clicking on map to prefill Geofence bounds
  map.on('click', (e) => {
    const lat = e.latlng.lat.toFixed(4);
    const lon = e.latlng.lng.toFixed(4);
    const latMinEl = document.getElementById('geoLatMin');
    const lonMinEl = document.getElementById('geoLonMin');
    if (latMinEl && lonMinEl && !latMinEl.value) {
      latMinEl.value = (parseFloat(lat) - 0.02).toFixed(4);
      document.getElementById('geoLatMax').value = (parseFloat(lat) + 0.02).toFixed(4);
      lonMinEl.value = (parseFloat(lon) - 0.02).toFixed(4);
      document.getElementById('geoLonMax').value = (parseFloat(lon) + 0.02).toFixed(4);
      toast(`Prefilled coordinates around [${lat}, ${lon}]`);
      switchTab('geofences');
    }
  });
}

function updateMapVehicles(devices) {
  if (!map) initMap();
  if (!map) return;

  // Clear existing vehicle markers
  Object.values(mapMarkers).forEach(m => map.removeLayer(m));
  mapMarkers = {};

  const bounds = [];

  (devices || []).forEach(d => {
    const lat = parseFloat(d.last_lat);
    const lon = parseFloat(d.last_lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;

    const id = d.id || d.device;
    const isOnline = !!d.online;
    const isSpeeding = !!d.over_limit;

    const iconHtml = `
      <div class="custom-vehicle-marker">
        <div class="vehicle-pulse-pin ${isSpeeding ? 'speeding' : (isOnline ? 'online' : 'offline')}">
          🚗
        </div>
      </div>
    `;

    const icon = L.divIcon({
      className: '',
      html: iconHtml,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const marker = L.marker([lat, lon], { icon }).addTo(map);
    const popupContent = `
      <div style="font-family:var(--font-display);padding:4px">
        <strong style="font-size:1rem;color:var(--accent-cyan)">${esc(d.label || id)}</strong>
        ${d.vehicle ? `<div style="font-size:0.75rem;color:var(--text-muted)">${esc(d.vehicle)}</div>` : ''}
        <div style="margin-top:6px;font-family:var(--font-mono);font-size:0.85rem">
          Speed: <strong style="color:${isSpeeding ? 'var(--accent-rose)' : 'inherit'}">${d.last_speed != null ? d.last_speed + ' km/h' : 'Stationary'}</strong>
          ${d.last_limit != null ? ` / limit ${d.last_limit}` : ''}
        </div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">
          Seen: ${relTime(d.last_seen)} · [${lat.toFixed(5)}, ${lon.toFixed(5)}]
        </div>
        <div style="margin-top:6px">
          <a href="${gmapsUrl(lat, lon)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
        </div>
      </div>
    `;
    marker.bindPopup(popupContent);
    mapMarkers[id] = marker;
    bounds.push([lat, lon]);
  });

  // Fit bounds if vehicles exist
  if (bounds.length > 0 && !map._userPanned && !trackVisible) {
    try {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    } catch {}
  }
}

function updateMapGeofences(geofences) {
  if (!map) return;
  geofenceLayers.forEach(l => map.removeLayer(l));
  geofenceLayers = [];

  (geofences || []).forEach(g => {
    if (!g.active) return;
    const latMin = parseFloat(g.lat_min);
    const latMax = parseFloat(g.lat_max);
    const lonMin = parseFloat(g.lon_min);
    const lonMax = parseFloat(g.lon_max);

    if ([latMin, latMax, lonMin, lonMax].some(Number.isNaN)) return;

    const bounds = [[latMin, lonMin], [latMax, lonMax]];
    const rect = L.rectangle(bounds, {
      color: '#00e5ff',
      weight: 2,
      fillColor: '#00e5ff',
      fillOpacity: 0.12,
      dashArray: '4, 6'
    }).addTo(map);

    rect.bindPopup(`
      <strong>${esc(g.name)}</strong><br>
      Speed Limit: <strong>${g.limit_kph} km/h</strong><br>
      <span class="rel">Active Geofence Zone</span>
    `);
    geofenceLayers.push(rect);
  });
}

function zoomToLocation(lat, lon, label) {
  switchTab('cockpit');
  if (!map) initMap();
  if (!map) return;
  const a = parseFloat(lat), b = parseFloat(lon);
  if (Number.isNaN(a) || Number.isNaN(b)) return;
  map._userPanned = true;
  map.setView([a, b], 15);
  L.popup()
    .setLatLng([a, b])
    .setContent(`<strong>${esc(label || 'Target Location')}</strong><br>${a.toFixed(5)}, ${b.toFixed(5)}<br>` +
      `<a href="${gmapsUrl(a, b)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>`)
    .openOn(map);
}

// ── GPS Track Log ───────────────────────────────────────────
function populateTrackDevices(devices) {
  const sel = document.getElementById('trackDevice');
  if (!sel) return;
  const current = sel.value;
  const ids = (devices || []).map(d => d.id || d.device);
  const existing = Array.from(sel.options).slice(1).map(o => o.value);
  if (ids.join('|') !== existing.join('|')) {
    sel.innerHTML = '<option value="">Select device…</option>' + (devices || []).map(d => {
      const id = d.id || d.device;
      return `<option value="${esc(id)}">${esc(d.label || id)}${d.track_points_24h ? ` (${d.track_points_24h})` : ''}</option>`;
    }).join('');
    sel.value = ids.includes(current) ? current : '';
  }
  if (!sel.value && ids.length) sel.value = ids[0];
}

function clearTrackLayer() {
  if (trackLayer && map) map.removeLayer(trackLayer);
  trackLayer = null;
}

function toggleTrack() {
  trackVisible = !trackVisible;
  const btn = document.getElementById('trackToggleBtn');
  if (btn) btn.textContent = trackVisible ? 'Hide from map' : 'Show on map';
  if (trackVisible) {
    trackFitPending = true;
    loadTrack();
  } else {
    clearTrackLayer();
  }
}

async function loadTrack(refit = false) {
  const device = (document.getElementById('trackDevice') || {}).value || '';
  const hours = (document.getElementById('trackHours') || {}).value || '24';
  const countEl = document.getElementById('trackCount');
  const summaryEl = document.getElementById('trackSummary');
  const gm = document.getElementById('trackGmaps');
  const csv = document.getElementById('trackCsv');

  if (!device) {
    clearTrackLayer();
    if (gm) gm.style.display = 'none';
    if (csv) csv.style.display = 'none';
    if (countEl) countEl.textContent = '—';
    return;
  }
  if (refit) trackFitPending = true;

  const qs = `device=${encodeURIComponent(device)}&hours=${encodeURIComponent(hours)}`;
  let d;
  try {
    d = await fetch(`/api/track?${qs}`, { credentials: 'same-origin' }).then(r => r.json());
  } catch {
    return;
  }
  if (!d || !d.ok) return;

  const pts = d.points || [];
  if (countEl) countEl.textContent = `${pts.length} pts`;
  if (csv) { csv.href = `/api/track.csv?${qs}`; csv.style.display = pts.length ? '' : 'none'; }
  if (gm) {
    gm.href = d.route_url || '#';
    gm.style.display = d.route_url ? '' : 'none';
  }
  if (summaryEl) {
    if (!pts.length) {
      summaryEl.textContent = `No GPS points logged for ${device} in the last ${hours} h.`;
    } else {
      const last = pts[pts.length - 1];
      const overCount = pts.filter(p => p.over).length;
      const maxSpd = Math.max(...pts.map(p => p.speed || 0));
      summaryEl.innerHTML =
        `Last point ${relTime(last.recorded_at)} · peak ${Math.round(maxSpd)} km/h · ` +
        `<span style="color:${overCount ? 'var(--accent-rose)' : 'inherit'}">${overCount} over limit</span> · ` +
        gmapsLink(last.lat, last.lon, 'last position ↗', '');
    }
  }

  if (!trackVisible || !map) return;
  clearTrackLayer();
  if (!pts.length) return;

  const latlngs = pts.map(p => [p.lat, p.lon]);
  const layers = [L.polyline(latlngs, { color: '#00e5ff', weight: 4, opacity: 0.85 })];

  const pointPopup = (p, title) =>
    `<strong>${title}</strong><br>${esc(p.recorded_at)}<br>` +
    `${p.speed != null ? Math.round(p.speed) + ' km/h' : '—'}${p.speed_limit != null ? ' / limit ' + p.speed_limit : ''}<br>` +
    `<a href="${p.gmaps_url}" target="_blank" rel="noopener">Open in Google Maps ↗</a>`;

  pts.filter(p => p.over).slice(-300).forEach(p => {
    layers.push(L.circleMarker([p.lat, p.lon], { radius: 4, color: '#ff3366', fillOpacity: 0.9, weight: 1 })
      .bindPopup(pointPopup(p, '⚠️ Over limit')));
  });
  const first = pts[0], last = pts[pts.length - 1];
  layers.push(L.circleMarker([first.lat, first.lon], { radius: 6, color: '#0f9d8a', fillOpacity: 1 })
    .bindPopup(pointPopup(first, 'Start')));
  layers.push(L.circleMarker([last.lat, last.lon], { radius: 7, color: '#f59e0b', fillOpacity: 1 })
    .bindPopup(pointPopup(last, 'Latest')));

  trackLayer = L.layerGroup(layers).addTo(map);
  if (trackFitPending) {
    trackFitPending = false;
    try { map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 16 }); } catch {}
  }
}

// ── Speedometer Cockpit Gauge ───────────────────────────────
function updateSpeedometer(speed, limit, tier) {
  const maxScale = Math.max(160, limit ? limit * 1.6 : 160);
  const percent = Math.min(1, Math.max(0, speed / maxScale));
  
  // Semi-circle arc dasharray: 283
  const dashOffset = 283 - (percent * 283);
  const arcEl = document.getElementById('gaugeValArc');
  const valEl = document.getElementById('gaugeSpeedVal');
  const deltaEl = document.getElementById('gaugeDeltaVal');

  if (arcEl) {
    arcEl.style.strokeDashoffset = dashOffset;
    arcEl.className = 'gauge-val-arc ' + (tier === 'SEVERE' ? 'severe' : (tier === 'MODERATE' ? 'warn' : ''));
  }

  if (valEl) {
    valEl.textContent = Math.round(speed);
    valEl.style.color = (tier === 'SEVERE') ? 'var(--accent-rose)' :
                        (tier === 'MODERATE') ? 'var(--accent-amber)' : 'var(--text-main)';
  }

  if (deltaEl) {
    const diff = speed - (limit || 50);
    if (diff > 0) {
      deltaEl.innerHTML = `<span style="color:var(--accent-rose)">+${Math.round(diff)} km/h OVER</span>`;
    } else {
      deltaEl.innerHTML = `<span style="color:var(--accent-teal)">Compliant (-${Math.abs(Math.round(diff))})</span>`;
    }
  }
}

// ── Sparkline & Severity Bar Visualizations ─────────────────
function renderSpark(hourly) {
  const host = document.getElementById('spark');
  if (!host) return;
  const mapH = {};
  (hourly || []).forEach(h => { mapH[h.bucket] = h; });

  const points = [];
  const now = new Date();
  now.setMinutes(0, 0, 0);
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000);
    const key = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':00';
    points.push({ key, count: (mapH[key] && mapH[key].count) || 0, severe: (mapH[key] && mapH[key].severe) || 0 });
  }

  const max = Math.max(1, ...points.map(p => p.count));
  const w = 280, h = 68, pad = 4;
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - (p.count / max) * (h - pad * 2);
    return [x, y, p];
  });

  const line = coords.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
  const area = line + ' L' + (w - pad) + ',' + (h - pad) + ' L' + pad + ',' + (h - pad) + ' Z';
  const bars = coords.map(c => {
    const bh = Math.max(2, (h - pad) - c[1]);
    const fill = c[2].severe > 0 ? 'var(--accent-rose)' : 'var(--accent-cyan)';
    return `<rect x="${(c[0] - 2).toFixed(1)}" y="${c[1].toFixed(1)}" width="4" height="${bh.toFixed(1)}" rx="1.5" fill="${fill}" opacity="0.85"/>`;
  }).join('');

  host.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:100%">
      <path d="${area}" fill="rgba(0, 229, 255, 0.08)"/>
      <path d="${line}" fill="none" stroke="var(--accent-cyan)" stroke-width="2" stroke-linejoin="round"/>
      ${bars}
    </svg>
  `;

  const total24 = points.reduce((a, p) => a + p.count, 0);
  const sev24 = points.reduce((a, p) => a + p.severe, 0);
  const hEvents = document.getElementById('hEvents');
  const hSevere = document.getElementById('hSevere');
  if (hEvents) hEvents.textContent = total24;
  if (hSevere) hSevere.textContent = sev24;
}

function renderSeverityMix(stats) {
  const host = document.getElementById('severityBars');
  if (!host) return;
  const total = Math.max(1, stats.total || 0);
  const items = [
    { label: 'Severe', count: stats.severe || 0, cls: 'severe' },
    { label: 'Moderate', count: stats.moderate || 0, cls: 'moderate' },
    { label: 'Minor', count: stats.minor || 0, cls: 'minor' }
  ];

  host.innerHTML = items.map(item => `
    <div class="sev-bar-item">
      <span>${item.label}</span>
      <div class="sev-bar-track">
        <div class="sev-bar-fill ${item.cls}" style="width:${((item.count / total) * 100).toFixed(1)}%"></div>
      </div>
      <strong class="mono-cell">${item.count}</strong>
    </div>
  `).join('');
}

// ── Hero & Operational Status ───────────────────────────────
function updateHero(latest, stats) {
  const title = document.getElementById('heroTitle');
  const sub = document.getElementById('heroSub');
  const chips = document.getElementById('heroChips');

  if (!latest) {
    if (title) {
      title.className = 'hero-title ok';
      title.textContent = 'All Systems Nominal';
    }
    if (sub) {
      sub.textContent = 'No speeding violations recorded. All active fleet units operating within legal bounds.';
    }
    if (chips) {
      chips.innerHTML = `
        <span class="telemetry-chip">🟢 ${stats.online_count || 0} Online</span>
        <span class="telemetry-chip">📦 ${stats.registered || stats.devices || 0} Registered</span>
      `;
    }
    updateSpeedometer(0, 50, 'NONE');
    return;
  }

  const isSevere = latest.tier === 'SEVERE';
  if (title) {
    title.className = 'hero-title ' + (isSevere ? 'alert' : 'ok');
    title.textContent = isSevere ? '🚨 Severe Speed Violation Detected' : `⚠️ ${latest.tier} Limit Breach`;
  }
  if (sub) {
    sub.innerHTML = `Unit <strong>${esc(latest.device)}</strong> clocked at <strong>${latest.speed} km/h</strong> (limit <strong>${latest.speed_limit} km/h</strong>, +${latest.excess} over).`;
  }
  if (chips) {
    chips.innerHTML = `
      <span class="telemetry-chip ${isSevere ? 'rose' : 'amber'}">${latest.tier}</span>
      <span class="telemetry-chip">⏱️ ${relTime(latest.received_at)}</span>
      ${latest.lat != null ? `<a class="telemetry-chip" href="${gmapsUrl(latest.lat, latest.lon)}" target="_blank" rel="noopener" title="Open in Google Maps">📍 ${parseFloat(latest.lat).toFixed(4)}, ${parseFloat(latest.lon).toFixed(4)} ↗</a>` : ''}
      <span class="telemetry-chip">🟢 ${stats.online_count || 0} Units Online</span>
    `;
  }

  updateSpeedometer(latest.speed, latest.speed_limit, latest.tier);

  // Detect new event & trigger sound/toast
  if (lastLatestId != null && latest.id !== lastLatestId) {
    playAlertSound(latest.tier);
    toast(`Alert: ${latest.device} exceeded limit by +${latest.excess} km/h!`, !isSevere);
  }
  lastLatestId = latest.id;
}

// ── Device Cards Grid ───────────────────────────────────────
function renderDeviceCards(devices) {
  const host = document.getElementById('deviceCardsGrid');
  if (!host) return;

  // Don't wipe a limit the admin is typing on the 4 s refresh.
  const active = document.activeElement;
  if (active && host.contains(active) && /^(INPUT|SELECT)$/.test(active.tagName)) return;

  if (!devices || !devices.length) {
    host.innerHTML = `<div class="empty" style="grid-column:1/-1;text-align:center;padding:30px;color:var(--text-muted)">No fleet devices registered yet.</div>`;
    return;
  }

  host.innerHTML = devices.map(d => {
    const id = d.id || d.device;
    const isOnline = !!d.online;
    const over = !!d.over_limit;
    const mode = d.limit_mode || 'manual';
    const limitSetting = d.limit_kph != null ? Math.round(d.limit_kph) : null;
    return `
      <div class="device-card">
        <div class="device-card-header">
          <div>
            <div class="device-card-name">${esc(d.label || id)}</div>
            <div class="device-card-id">${esc(id)} ${d.vehicle ? `· ${esc(d.vehicle)}` : ''}</div>
          </div>
          <span class="telemetry-pill">
            <span class="pulse-dot ${isOnline ? 'live' : 'offline'}"></span>
            ${isOnline ? 'Online' : 'Offline'}
          </span>
        </div>
        <div class="device-card-metrics">
          <div>
            <div class="dev-metric-lbl">Speed</div>
            <div class="dev-metric-val" style="color:${over ? 'var(--accent-rose)' : 'inherit'}">${d.last_speed != null ? d.last_speed + ' <span style="font-size:0.7rem">km/h</span>' : '—'}</div>
          </div>
          <div>
            <div class="dev-metric-lbl">Limit now</div>
            <div class="dev-metric-val">${d.last_limit != null ? Math.round(d.last_limit) + ' <span style="font-size:0.7rem">km/h</span>' : '—'}</div>
          </div>
          <div>
            <div class="dev-metric-lbl">Violations</div>
            <div class="dev-metric-val" style="color:${d.severe > 0 ? 'var(--accent-rose)' : 'inherit'}">
              ${d.total_violations || 0}
            </div>
          </div>
          <div>
            <div class="dev-metric-lbl">Status</div>
            <div class="dev-metric-val" style="font-size:0.85rem;color:${over ? 'var(--accent-rose)' : 'var(--accent-teal)'}">
              ${d.last_speed == null || d.last_limit == null ? '—' : (over ? `OVER +${Math.round(d.last_speed - d.last_limit)}` : 'Within limit')}
            </div>
          </div>
        </div>
        <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:8px">
          Limit setting: <strong>${limitSetting != null ? limitSetting + ' km/h' : 'not reported yet'}</strong> · ${mode === 'auto' ? 'AUTO (zones)' : 'SET'}
          ${d.limit_pending ? '<span class="tier-tag moderate" title="Waiting for the device\'s next heartbeat">pending sync</span>' : ''}
        </div>
        ${isAdminRole() ? `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
          <input class="input-field" data-lim-kph type="number" min="5" max="250" step="1" value="${limitSetting != null ? limitSetting : ''}" placeholder="km/h" style="width:80px">
          <select class="select-field" data-lim-mode>
            <option value="manual" ${mode !== 'auto' ? 'selected' : ''}>Set (fixed)</option>
            <option value="auto" ${mode === 'auto' ? 'selected' : ''}>Auto (zones)</option>
          </select>
          <button class="btn btn-primary btn-sm" data-dev="${esc(id)}" onclick="saveDeviceLimit(this)">Set limit</button>
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;color:var(--text-muted)">
          <span>Seen: ${relTime(d.last_seen)}</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            ${d.last_lat != null ? `<button class="btn btn-ghost btn-sm" onclick="zoomToLocation(${d.last_lat}, ${d.last_lon}, '${esc(id)}')">Locate</button>` : ''}
            ${d.gmaps_url ? `<a class="btn btn-ghost btn-sm" href="${esc(d.gmaps_url)}" target="_blank" rel="noopener">Google Maps ↗</a>` : ''}
            ${isAdminRole() ? `<button class="btn btn-danger btn-sm" onclick="deleteDevice('${esc(id)}')">Remove</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function saveDeviceLimit(btn) {
  if (!isAdminRole()) { openAdmin(); toast('Admin authorization required', false); return; }
  const card = btn.closest('.device-card');
  const id = btn.dataset.dev;
  const kph = parseFloat(card.querySelector('[data-lim-kph]').value);
  const mode = card.querySelector('[data-lim-mode]').value;
  if (Number.isNaN(kph) || kph < 5 || kph > 250) { toast('Limit must be 5–250 km/h', false); return; }

  btn.disabled = true;
  try {
    const r = await fetch('/api/devices/' + encodeURIComponent(id) + '/limit' + adminQuery(), {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: adminHeaders(true),
      body: JSON.stringify({ limit_kph: kph, mode })
    });
    const d = await r.json();
    if (d.ok) {
      toast(`${id}: limit ${Math.round(kph)} km/h queued, applies on the device's next heartbeat`);
      btn.blur();
      loadStats();
    } else {
      toast(d.error || 'Limit update rejected', false);
    }
  } catch {
    toast('Network request failed', false);
  } finally {
    btn.disabled = false;
  }
}

// ── Violation Ledger Feed ───────────────────────────────────
async function loadViolations() {
  const tier = document.getElementById('filterTier') ? document.getElementById('filterTier').value : '';
  const device = document.getElementById('filterDevice') ? document.getElementById('filterDevice').value.trim() : '';

  let url = '/api/violations?limit=150';
  let csv = '/api/violations.csv?';
  if (tier) { url += `&tier=${encodeURIComponent(tier)}`; csv += `tier=${encodeURIComponent(tier)}&`; }
  if (device) { url += `&device=${encodeURIComponent(device)}`; csv += `device=${encodeURIComponent(device)}&`; }

  const csvBtn = document.getElementById('csvExportBtn');
  if (csvBtn) csvBtn.href = csv.replace(/[&?]$/, '');

  const r = await fetch(url, { credentials: 'same-origin' });
  const d = await r.json();
  if (!d.ok) throw new Error('violations fetch failed');

  const countLabel = document.getElementById('violationCountLabel');
  if (countLabel) countLabel.textContent = `${d.count} events`;

  const tbody = document.getElementById('violationsTbody');
  if (!tbody) return;

  if (!d.violations.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted)">No violations match criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = d.violations.map(v => {
    const isSevere = v.tier === 'SEVERE';
    const isMod = v.tier === 'MODERATE';
    const excessColor = isSevere ? 'var(--accent-rose)' : (isMod ? 'var(--accent-amber)' : 'var(--accent-sky)');

    return `
      <tr>
        <td class="mono-cell" style="color:var(--text-sub)">#${v.id}</td>
        <td><strong>${esc(v.device)}</strong></td>
        <td>
          <span class="tier-tag ${v.tier.toLowerCase()}">
            ${esc(v.tier)}
          </span>
        </td>
        <td class="mono-cell" style="font-weight:700">${v.speed} <span style="font-size:0.7rem;color:var(--text-sub)">km/h</span></td>
        <td class="mono-cell">${v.speed_limit}</td>
        <td class="mono-cell" style="color:${excessColor};font-weight:700">+${v.excess}</td>
        <td>
          ${v.lat != null ? `<div style="display:flex;gap:4px;flex-wrap:wrap">
            <a class="btn btn-ghost btn-sm" href="javascript:void(0)" title="Show on dashboard map" onclick="zoomToLocation(${v.lat}, ${v.lon}, '${esc(v.device)}')">📍 ${parseFloat(v.lat).toFixed(4)}, ${parseFloat(v.lon).toFixed(4)}</a>
            ${gmapsLink(v.lat, v.lon, 'Google Maps ↗')}
          </div>` : '—'}
        </td>
        <td>
          <div style="font-weight:500">${relTime(v.received_at)}</div>
          <div class="mono-cell" style="font-size:0.7rem;color:var(--text-sub)">${esc(v.received_at)}</div>
        </td>
      </tr>
    `;
  }).join('');
}

// ── Geofence Manager ────────────────────────────────────────
async function loadGeofences() {
  const url = isAdminRole()
    ? '/api/geofences?all=1' + (adminKey ? '&key=' + encodeURIComponent(adminKey) : '')
    : '/api/geofences';

  const r = await fetch(url, { credentials: 'same-origin', headers: adminHeaders(false) });
  const d = await r.json();
  if (!d.ok) throw new Error('geofences fetch failed');

  telemetryData.geofences = d.geofences || [];
  updateMapGeofences(telemetryData.geofences);

  const host = document.getElementById('geofenceListContainer');
  if (!host) return;

  if (!telemetryData.geofences.length) {
    host.innerHTML = `<div class="empty" style="padding:24px;text-align:center;color:var(--text-muted)">No geofences created yet.</div>`;
    return;
  }

  host.innerHTML = telemetryData.geofences.map(g => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border-subtle)">
      <div>
        <strong style="font-size:0.95rem">${esc(g.name)}</strong>
        ${g.active ? '<span class="tier-tag minor" style="margin-left:8px">Active</span>' : '<span class="tier-tag" style="margin-left:8px">Disabled</span>'}
        <div class="mono-cell" style="font-size:0.76rem;color:var(--text-muted);margin-top:3px">
          Bounds: [${g.lat_min}–${g.lat_max}, ${g.lon_min}–${g.lon_max}] · Limit: <strong>${g.limit_kph} km/h</strong>
        </div>
      </div>
      <div>
        ${isAdminRole() ? `<button class="btn btn-danger btn-sm" onclick="deleteGeofence(${g.id})">Delete</button>` : ''}
      </div>
    </div>
  `).join('');
}

// ── Load All Telemetry Data ─────────────────────────────────
async function loadStats() {
  const r = await fetch('/api/stats', { credentials: 'same-origin' });
  const d = await r.json();
  if (!d.ok) throw new Error('stats failed');

  const s = d.stats;
  telemetryData.stats = s;
  telemetryData.devices = d.devices || [];
  telemetryData.hourly = d.hourly || [];

  // Update KPIs
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('sToday', s.today ?? 0);
  setEl('sTotal', s.total ?? 0);
  setEl('sSevere', s.severe ?? 0);
  setEl('sModerate', s.moderate ?? 0);
  setEl('sMinor', s.minor ?? 0);
  setEl('sMaxSpeed', s.max_speed != null ? `${s.max_speed} km/h` : '—');
  setEl('sOnlineUnits', s.online_count ?? 0);

  updateHero(d.latest, s);
  renderSpark(telemetryData.hourly);
  renderSeverityMix(s);
  renderDeviceCards(telemetryData.devices);
  updateMapVehicles(telemetryData.devices);
  populateTrackDevices(telemetryData.devices);
}

async function loadAll(manual = false) {
  try {
    await Promise.all([loadStats(), loadViolations(), loadGeofences()]);
    loadTrack();
    const h = await fetch('/api/health', { credentials: 'same-origin' }).then(r => r.json());
    setLive(!!h.ok, h.ok ? `Live v${h.version || '3.2'}` : 'Degraded');
    if (manual) toast('Telemetry desk refreshed');
  } catch (e) {
    console.error(e);
    setLive(false, 'Offline');
    if (manual) toast('Refresh failed', false);
  }
}

function setLive(ok, text) {
  const dot = document.getElementById('liveDot');
  const label = document.getElementById('liveLabel');
  if (label) label.textContent = text;
  if (dot) dot.className = 'pulse-dot ' + (ok ? 'live' : 'err');
}

function debouncedLoadViolations() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(loadViolations, 300);
}

// ── CRUD Actions ────────────────────────────────────────────
async function addDevice() {
  if (!isAdminRole()) { openAdmin(); toast('Admin authorization required', false); return; }
  const id = document.getElementById('devId').value.trim();
  if (!id) { toast('Device ID is required', false); return; }

  const body = {
    id,
    label: document.getElementById('devLabel').value.trim() || id,
    vehicle: document.getElementById('devVehicle').value.trim() || null,
    api_key: document.getElementById('devKey').value.trim() || undefined
  };

  try {
    const r = await fetch('/api/devices' + adminQuery(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: adminHeaders(true),
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) {
      toast(`Device ${id} registered successfully`);
      ['devId', 'devLabel', 'devVehicle', 'devKey'].forEach(i => {
        const el = document.getElementById(i);
        if (el) el.value = '';
      });
      loadStats();
    } else {
      toast(d.error || 'Registration rejected', false);
    }
  } catch {
    toast('Network request failed', false);
  }
}

async function deleteDevice(id) {
  if (!isAdminRole()) { openAdmin(); toast('Admin authorization required', false); return; }
  if (!confirm(`Delete device ${id} from registry?`)) return;

  try {
    const r = await fetch('/api/devices/' + encodeURIComponent(id) + adminQuery(), {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: adminHeaders(false)
    });
    const d = await r.json();
    if (d.ok) {
      toast('Device deleted');
      loadStats();
    } else {
      toast(d.error || 'Delete failed', false);
    }
  } catch {
    toast('Request failed', false);
  }
}

async function addGeofence() {
  if (!isAdminRole()) { openAdmin(); toast('Admin authorization required', false); return; }
  const body = {
    name: document.getElementById('geoName').value.trim(),
    lat_min: parseFloat(document.getElementById('geoLatMin').value),
    lat_max: parseFloat(document.getElementById('geoLatMax').value),
    lon_min: parseFloat(document.getElementById('geoLonMin').value),
    lon_max: parseFloat(document.getElementById('geoLonMax').value),
    limit_kph: parseFloat(document.getElementById('geoLimit').value)
  };

  if (!body.name || Number.isNaN(body.limit_kph)) {
    toast('Zone Name and Speed Limit are required', false);
    return;
  }

  try {
    const r = await fetch('/api/geofences' + adminQuery(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: adminHeaders(true),
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) {
      toast(`Geofence ${body.name} activated`);
      ['geoName', 'geoLatMin', 'geoLatMax', 'geoLonMin', 'geoLonMax', 'geoLimit'].forEach(i => {
        const el = document.getElementById(i);
        if (el) el.value = '';
      });
      loadGeofences();
    } else {
      toast(d.error || 'Failed to add geofence', false);
    }
  } catch {
    toast('Request failed', false);
  }
}

async function deleteGeofence(id) {
  if (!isAdminRole()) { openAdmin(); toast('Admin authorization required', false); return; }
  if (!confirm(`Delete geofence #${id}?`)) return;

  try {
    const r = await fetch('/api/geofences/' + id + adminQuery(), {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: adminHeaders(false)
    });
    const d = await r.json();
    if (d.ok) {
      toast('Geofence removed');
      loadGeofences();
    } else {
      toast(d.error || 'Failed to delete', false);
    }
  } catch {
    toast('Request failed', false);
  }
}

async function clearAllViolations() {
  if (!isAdminRole()) { openAdmin(); toast('Admin authorization required', false); return; }
  if (!confirm('Permanently delete ALL violations from the log? This cannot be undone.')) return;

  try {
    const r = await fetch('/api/violations' + adminQuery(), {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: adminHeaders(false)
    });
    const d = await r.json();
    if (d.ok) {
      toast('Violation records cleared');
      loadAll();
    } else {
      toast(d.error || 'Action denied', false);
    }
  } catch {
    toast('Request failed', false);
  }
}

// ── Simulator & Test Ingestion Bench ────────────────────────
async function injectSimulatedViolation() {
  const device = document.getElementById('simDevice').value.trim() || 'ESP32-DEV-01';
  const speed = parseFloat(document.getElementById('simSpeed').value) || 85;
  const limit = parseFloat(document.getElementById('simLimit').value) || 50;
  const lat = parseFloat(document.getElementById('simLat').value) || 9.0722;
  const lon = parseFloat(document.getElementById('simLon').value) || 7.4913;
  const excess = speed - limit;
  const tier = excess >= 20 ? 'SEVERE' : (excess >= 10 ? 'MODERATE' : 'MINOR');

  try {
    const res = await fetch('/api/violation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device, speed, limit, excess, tier, lat, lon })
    });
    const data = await res.json();
    if (data.ok) {
      toast(`Simulated ${tier} violation ingested for ${device}!`);
      loadAll();
    } else {
      toast(data.error || (data.errors && data.errors.join(', ')) || 'Simulation rejected', false);
    }
  } catch (e) {
    toast('Simulation failed: ' + e.message, false);
  }
}

async function sendBackendSMS() {
  const phone = document.getElementById('smsPhone').value.trim();
  const msg = document.getElementById('smsMsg').value.trim();
  if (!phone || !msg) { toast('Phone and message required', false); return; }

  try {
    const res = await fetch('/api/test-sms', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: msg })
    });
    const data = await res.json();
    if (data.ok) {
      toast('SMS test simulated (logged to server console)');
      document.getElementById('smsMsg').value = '';
    } else {
      toast(data.error || 'SMS failed', false);
    }
  } catch {
    toast('Network error', false);
  }
}

// ── Clock & Initialization ──────────────────────────────────
function tickClock() {
  const el = document.getElementById('clockPill');
  if (el) {
    el.textContent = new Date().toLocaleTimeString([], { hour12: false });
  }
}

(async function boot() {
  setTheme(currentTheme);
  updateSoundUI();
  tickClock();
  setInterval(tickClock, 1000);

  const ok = await initAuth();
  if (!ok) return;

  initMap();
  await loadAll();
  loadTimer = setInterval(() => loadAll(false), REFRESH_INTERVAL_MS);
})();
