/* Vigía · app web para iPhone (Safari → Añadir a pantalla de inicio) */
(() => {
  'use strict';
  const V = window.VL;

  const CONFIG = {
    // Canal donde se comparten los avisos de radares móviles entre los usuarios de tu Vigía.
    ntfyTopic: 'vigia-f8b4b1a2c7e4',
    ntfy: 'https://ntfy.sh',
    osrm: 'https://router.project-osrm.org',
    photon: 'https://photon.komoot.io',
    overpass: 'https://overpass-api.de/api/interpreter',
    ministerio: 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/',
  };

  // ---------- Utilidades ----------
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (id, cls = '') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
  const fmt = V.fmt;
  const now = () => Date.now();

  async function fetchTimeout(url, ms = 15000, opts = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem('vigia.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('vigia.' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  };

  // ---------- Ajustes ----------
  const DEFAULTS = {
    voiceGuide: true, radarVoice: true, radarSound: true, maneuverSound: true,
    alertFar: true, alertNear: true, speeding: true,
    layer: 'all', showGone: true, mapStyle: 'dark',
    tolls: 'avoid', criterion: 'eco', avoidMotorways: false,
    fuel: 'g95', consumption: 6.5,
  };
  const S = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveS = () => store.set('settings', S);
  let deviceId = store.get('device', null);
  if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 10); store.set('device', deviceId); }

  // ---------- Estado ----------
  const st = {
    pos: null, speed: 0, heading: null, compass: null, acc: 50, lastFix: null,
    official: [], community: [], radarSource: '', stations: [], pricesAt: null, pricesSource: '',
    routes: [], selectedId: null, origin: { current: true, name: 'Mi ubicación' }, dest: null,
    follow: true, nav: null, firstFix: true, communityAt: null,
  };

  const allRadars = () => {
    const t = now();
    const com = st.community.map(r => ({ ...r, status: V.radarStatus(r, t) }));
    return st.official.map(r => ({ ...r, status: 'active' })).concat(com);
  };
  const alertable = () => allRadars().filter(r => r.status !== 'gone');
  const findRadar = id => allRadars().find(r => r.id === id);

  // ---------- Audio y voz ----------
  let audio = null;
  let esVoice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    esVoice = vs.find(v => v.lang === 'es-ES' && /Mónica|Monica|Jorge|Marisol|Paulina/i.test(v.name))
      || vs.find(v => v.lang === 'es-ES') || vs.find(v => v.lang && v.lang.startsWith('es')) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  function unlockAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      audio.resume();
      const b = audio.createBuffer(1, 1, 22050), s = audio.createBufferSource();
      s.buffer = b; s.connect(audio.destination); s.start(0);
    } catch { audio = null; }
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u);
    }
  }

  function tone(freq, at, dur, vol) {
    const o = audio.createOscillator(), o2 = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o2.type = 'sine';
    o.frequency.value = freq; o2.frequency.value = freq * 2;
    const g2 = audio.createGain(); g2.gain.value = 0.3;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.start(at); o2.start(at); o.stop(at + dur + 0.05); o2.stop(at + dur + 0.05);
  }

  const SOUNDS = {
    far: [[784, 0, .35, .5], [1046, .38, .5, .5]],                                   // radar a 1 km: dos notas suaves
    near: [[1318, 0, .16, .7], [1318, .2, .16, .7], [1568, .4, .45, .75]],            // radar a 500 m: tres notas urgentes
    report: [[1046, 0, .12, .4], [1568, .12, .3, .4]],
    maneuver: [[659, 0, .25, .35]],
  };
  function play(name) {
    if (!audio) return;
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime + 0.02;
    for (const [f, d, dur, v] of SOUNDS[name]) tone(f, t + d, dur, v);
  }

  function say(text, priority = false) {
    if (!('speechSynthesis' in window) || !text) return;
    if (priority) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES'; if (esVoice) u.voice = esVoice;
    u.rate = 1.02;
    speechSynthesis.speak(u);
  }

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); }
    catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake();
      loadPrices(); pollCommunity();
    }
  });

  // ---------- Mapa ----------
  const STYLES = {
    dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    light: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    satellite: {
      version: 8,
      sources: { sat: { type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Imágenes © Esri',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] } },
      layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
    },
  };

  const lastView = store.get('view', { c: [-3.7, 40.3], z: 5.4 });
  const map = new maplibregl.Map({
    container: 'map', style: STYLES[S.mapStyle] || STYLES.dark,
    center: lastView.c, zoom: lastView.z, attributionControl: { compact: true },
    maxPitch: 65, fadeDuration: 0,
  });

  const RADAR_GLYPH = {
    fixed: ctx => { ctx.fill(new Path2D('M5 7h10a2.5 2.5 0 0 1 2.5 2.5v5.5A2.5 2.5 0 0 1 15 17.5H5A2.5 2.5 0 0 1 2.5 15V9.5A2.5 2.5 0 0 1 5 7zM17.5 10.5 21.5 8v8.5l-4-2.5z')); return [[10, 12.2, 2.8]]; },
    section: ctx => { ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.stroke(new Path2D('M6 21 9 3M18 21 15 3M12 4v3M12 10.5v3M12 17v3')); return []; },
    mobile: ctx => { ctx.fill(new Path2D('M5 11l1.8-4.2A2 2 0 0 1 8.6 5.5h6.8a2 2 0 0 1 1.8 1.3L19 11h.5a1.5 1.5 0 0 1 1.5 1.5V17h-2v1.5a1 1 0 0 1-2 0V17H7v1.5a1 1 0 0 1-2 0V17H3v-4.5A1.5 1.5 0 0 1 4.5 11z')); return [[7, 14, 1.3], [17, 14, 1.3]]; },
    light: ctx => { ctx.fill(new Path2D('M10.5 2.5h3a3.5 3.5 0 0 1 3.5 3.5v12a3.5 3.5 0 0 1-3.5 3.5h-3A3.5 3.5 0 0 1 7 18V6a3.5 3.5 0 0 1 3.5-3.5z')); return [[12, 7, 1.8], [12, 12, 1.8], [12, 17, 1.8]]; },
    police: ctx => { ctx.fill(new Path2D('M12 2.5 20 5.5v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10v-6z')); return []; },
  };
  const STATUS_COLOR = { active: '#34D873', unconfirmed: '#FFC83A', gone: '#8A93A8' };

  /** Icono de radar dibujado en canvas: "rk:<tipo>:<estado>:<o|c>". */
  function radarImage(id) {
    const [, kind, status, src] = id.split(':');
    const px = 2, size = 40, c = document.createElement('canvas');
    c.width = c.height = size * px;
    const ctx = c.getContext('2d');
    ctx.scale(px, px);
    const color = status === 'gone' ? '#5B6478' : (V.KINDS[kind] || V.KINDS.fixed).color;
    ctx.beginPath(); ctx.arc(20, 20, 15, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.save(); ctx.translate(11, 11); ctx.scale(0.75, 0.75);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
    const holes = (RADAR_GLYPH[kind] || RADAR_GLYPH.fixed)(ctx);
    ctx.fillStyle = color;
    for (const [x, y, r] of holes) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    if (src === 'c') {
      ctx.beginPath(); ctx.arc(32, 8, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = STATUS_COLOR[status] || STATUS_COLOR.active; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#0A0F1C'; ctx.stroke();
    }
    const data = ctx.getImageData(0, 0, size * px, size * px);
    return { width: size * px, height: size * px, data: new Uint8Array(data.data.buffer) };
  }
  map.on('styleimagemissing', e => {
    if (e.id.startsWith('rk:') && !map.hasImage(e.id)) map.addImage(e.id, radarImage(e.id), { pixelRatio: 2 });
  });

  const EMPTY = { type: 'FeatureCollection', features: [] };
  function addOverlays() {
    if (map.getSource('route-alt')) return;
    map.addSource('route-alt', { type: 'geojson', data: EMPTY });
    map.addSource('route-sel', { type: 'geojson', data: EMPTY, lineMetrics: true });
    map.addSource('radars', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'route-alt', type: 'line', source: 'route-alt',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#7B86A3', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 15, 8] } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route-sel',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#04121A', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 8, 15, 14] } });
    map.addLayer({ id: 'route-sel', type: 'line', source: 'route-sel',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 15, 9],
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#00E0C6', 1, '#2F6EFF'] } });
    map.addLayer({ id: 'radars', type: 'symbol', source: 'radars',
      layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.55, 12, 0.85, 16, 1],
        'symbol-sort-key': ['get', 'sort'] },
      paint: { 'icon-opacity': ['case', ['==', ['get', 'status'], 'gone'], 0.55, 1] } });
    drawRoutes(); drawRadars();
  }
  map.on('style.load', addOverlays);

  map.on('click', 'radars', e => {
    const f = e.features && e.features[0];
    if (f) openRadarDetail(f.properties.id);
  });
  map.on('click', 'route-alt', e => {
    const f = e.features && e.features[0];
    if (f && !st.nav) { st.selectedId = f.properties.id; drawRoutes(); renderPlanner(); }
  });
  for (const l of ['radars', 'route-alt']) {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
  for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) {
    map.on(ev, e => { if (e.originalEvent && st.follow) setFollow(false); });
  }
  let moveTimer = null;
  map.on('moveend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      drawStations();
      const c = map.getCenter();
      store.set('view', { c: [c.lng, c.lat], z: map.getZoom() });
    }, 400);
  });

  function setSource(id, data) { const s = map.getSource(id); if (s) s.setData(data); }

  function drawRadars() {
    if (!map.getSource('radars')) return;
    const show = S.layer === 'all' || S.layer === 'radars';
    const list = show ? allRadars().filter(r => S.showGone || r.status !== 'gone') : [];
    setSource('radars', { type: 'FeatureCollection', features: list.map(r => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { id: r.id, status: r.status, sort: r.status === 'gone' ? 0 : 1,
        icon: `rk:${r.kind}:${r.status}:${r.source === 'community' ? 'c' : 'o'}` },
    })) });
  }

  // Marcador de mi posición
  const meEl = document.createElement('div');
  meEl.className = 'me';
  meEl.innerHTML = `<div class="halo"></div><svg viewBox="0 0 40 40"><defs><linearGradient id="g-me" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00E0C6"/><stop offset="1" stop-color="#2F6EFF"/></linearGradient></defs>
    <circle cx="20" cy="20" r="17" fill="rgba(0,224,198,.18)"/><path d="M20 6 30 31 20 26 10 31z" fill="url(#g-me)" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/></svg>`;
  const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: 'map', pitchAlignment: 'map' });
  let meAdded = false;
  const haloEl = meEl.querySelector('.halo');

  const destEl = document.createElement('div');
  destEl.className = 'dest-pin';
  destEl.innerHTML = ic('i-pin');
  const destMarker = new maplibregl.Marker({ element: destEl, anchor: 'bottom' });

  // ---------- Gasolineras en el mapa ----------
  const stationMarkers = new Map();
  function drawStations() {
    const show = (S.layer === 'all' || S.layer === 'gas') && map.getZoom() >= 11.5 && !st.nav;
    const wanted = new Map();
    if (show && st.stations.length) {
      const b = map.getBounds(), c = map.getCenter();
      const inView = st.stations.filter(s => s.prices[S.fuel] != null && b.contains([s.lon, s.lat]))
        .map(s => ({ s, d: V.haversine(c.lat, c.lng, s.lat, s.lon) }))
        .sort((a, b) => a.d - b.d).slice(0, 70).map(x => x.s);
      const ps = inView.map(s => s.prices[S.fuel]).sort((a, b) => a - b);
      const lo = ps[Math.floor(ps.length / 3)], hi = ps[Math.floor(ps.length * 2 / 3)];
      for (const s of inView) {
        const p = s.prices[S.fuel];
        const band = ps.length < 3 ? 1 : p <= lo ? 0 : p >= hi ? 2 : 1;
        wanted.set(s.id, { s, band });
      }
    }
    for (const [id, m] of stationMarkers) {
      if (!wanted.has(id)) { m.remove(); stationMarkers.delete(id); }
    }
    for (const [id, { s, band }] of wanted) {
      const color = ['#34D873', '#FFC83A', '#FF6B4D'][band];
      const tr = trendOf(s, S.fuel);
      const html = `<div class="tag">${ic('i-fuel')}${fmt.price(s.prices[S.fuel])}${tr ? ic(tr === 'up' ? 'i-up' : 'i-down') : ''}</div><div class="tip"></div>`;
      let m = stationMarkers.get(id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'station';
        el.addEventListener('click', ev => { ev.stopPropagation(); openStation(id); });
        m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([s.lon, s.lat]).addTo(map);
        stationMarkers.set(id, m);
      }
      const el = m.getElement();
      el.style.setProperty('--c', color);
      if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
    }
  }

  function trendOf(s, f) {
    const p = s.prices[f], q = s.prev && s.prev[f];
    if (p == null || q == null) return null;
    if (p > q + 0.0005) return 'up';
    if (p < q - 0.0005) return 'down';
    return null;
  }

  // ---------- Rutas en el mapa ----------
  function visibleRoutes() {
    let list = st.routes;
    if (S.tolls === 'avoid') {
      const free = list.filter(r => !r.hasTolls);
      if (free.length) list = free;
    }
    return V.sortRoutes(list, S.criterion);
  }
  const selectedRoute = () => st.routes.find(r => r.id === st.selectedId) || visibleRoutes()[0] || null;

  const lineFeature = (r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: { id: r.id } });
  function drawRoutes() {
    if (!map.getSource('route-sel')) return;
    if (st.nav) {
      setSource('route-alt', EMPTY);
      setSource('route-sel', { type: 'FeatureCollection', features: [lineFeature(st.nav.route)] });
      return;
    }
    const vis = visibleRoutes(), sel = selectedRoute();
    setSource('route-alt', { type: 'FeatureCollection', features: vis.filter(r => r !== sel).map(lineFeature) });
    setSource('route-sel', { type: 'FeatureCollection', features: sel ? [lineFeature(sel)] : [] });
  }

  function fitRoute(r) {
    const [a, b, c, d] = r.line.bbox;
    map.fitBounds([[a, b], [c, d]], { padding: { top: 140, left: 40, right: 40, bottom: Math.round(innerHeight * 0.5) }, duration: 900, pitch: 0, bearing: 0 });
  }

  // ---------- GPS ----------
  // Cada lectura del GPS se guarda en `fix`. Un bucle de animación mueve la flecha
  // suavemente entre lecturas (y la pega a la carretera durante la ruta) y la
  // cámara la sigue, como en Google Maps.
  let fix = null;
  let gotGoodFix = false, centeredOnce = false;

  const locEl = document.createElement('div');
  locEl.id = 'locating';
  locEl.className = 'locating glass';
  locEl.hidden = true;
  locEl.innerHTML = '<span class="spin"></span><span><b>Buscando tu ubicación…</b><small id="locatingAcc">Sal al exterior para más precisión</small></span>';
  document.querySelector('.hud-top').appendChild(locEl);

  function onPosition(p) {
    const c = p.coords;
    const lat = c.latitude, lon = c.longitude, t = now();
    const acc = c.accuracy || 50;
    // Ignora lecturas mucho peores que una buena reciente (saltos por wifi o antenas).
    if (fix && acc > 80 && fix.acc < 40 && t - fix.t < 10000) return;
    let speed = c.speed != null && c.speed >= 0 ? c.speed : null;
    let heading = c.heading != null && !Number.isNaN(c.heading) && c.heading >= 0 ? c.heading : null;
    if (fix) {
      const d = V.haversine(fix.lat, fix.lon, lat, lon), dt = (t - fix.t) / 1000;
      // Algunos GPS dan velocidad 0 o nula aunque te muevas: la calculamos con la distancia recorrida.
      if (dt > 0.4 && (speed == null || (speed < 0.5 && d / dt > 2 && d > acc * 0.5))) speed = d / dt;
      if (heading == null && d > Math.max(6, acc * 0.5)) heading = V.bearing(fix.lat, fix.lon, lat, lon);
    }
    fix = { lat, lon, acc, t, speed: speed || 0 };
    st.pos = { lat, lon };
    st.acc = acc;
    st.speed = Math.max(0, (speed || 0) * 3.6);
    if (heading != null && st.speed > 5) st.heading = heading;
    else if (st.compass != null && st.speed <= 5) st.heading = st.compass;
    st.lastFix = t;

    if (!meAdded) { disp = { lat, lon }; meMarker.setLngLat([lon, lat]).addTo(map); meAdded = true; }
    if (st.firstFix) {
      st.firstFix = false;
      if (!st.official.length) loadOverpassAround(lat, lon);
      pollCommunity();
      setTimeout(renderCheap, 50);
    }
    if (!gotGoodFix && acc <= 65) {
      gotGoodFix = true;
      locEl.hidden = true;
      if (st.follow && !st.nav) flyToMe(16.5);
    } else if (!gotGoodFix) {
      locEl.hidden = false;
      $('#locatingAcc').textContent = `Precisión actual: ±${Math.round(acc)} m`;
      if (st.follow && !st.nav && !centeredOnce) { centeredOnce = true; flyToMe(14); }
    }
    if (st.nav) updateNav(lat, lon);
    evaluateRadars(lat, lon);
    renderSpeed();
    throttledCheap();
  }

  function onPositionError(e) {
    if (e.code === 1) {
      locEl.hidden = true;
      notice('Sin permiso de ubicación. Actívalo en Ajustes del iPhone → Privacidad y seguridad → Localización → Safari (o Vigía) → "Mientras se usa" y "Ubicación exacta".', 15000);
    } else if (!fix) {
      locEl.hidden = false;
    }
  }

  function startGPS() {
    if (!('geolocation' in navigator)) { notice('Este navegador no tiene GPS.'); return; }
    locEl.hidden = false;
    const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
    navigator.geolocation.getCurrentPosition(onPosition, () => {}, opts);
    navigator.geolocation.watchPosition(onPosition, onPositionError, opts);
  }

  function startCompass() {
    const handler = e => {
      const h = e.webkitCompassHeading != null ? e.webkitCompassHeading : (e.absolute && e.alpha != null ? 360 - e.alpha : null);
      if (h == null) return;
      st.compass = h;
      if (st.speed <= 5) st.heading = h;
    };
    try {
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(s => { if (s === 'granted') addEventListener('deviceorientation', handler); }).catch(() => {});
      } else if (window.DeviceOrientationEvent) {
        addEventListener('deviceorientationabsolute', handler);
        addEventListener('deviceorientation', handler);
      }
    } catch { /* sin brújula */ }
  }

  // --- Animación de la flecha y de la cámara ---
  let disp = null, dispBearing = 0, camZoom = null, flying = false, lastFrame = 0;
  const lerp = (a, b, k) => a + (b - a) * k;
  const lerpAngle = (a, b, k) => { const d = ((b - a + 540) % 360) - 180; return (a + d * k + 360) % 360; };
  const navPadding = () => ({ top: Math.round(innerHeight * 0.42), bottom: 0, left: 0, right: 0 });
  const noPadding = { top: 0, bottom: 0, left: 0, right: 0 };

  /** Dónde debería estar la flecha ahora mismo (avanza según velocidad entre lecturas). */
  function predicted() {
    const dt = Math.min(1.5, (now() - fix.t) / 1000), v = fix.speed;
    if (st.nav && !st.nav.rerouting) {
      const p = V.project(st.nav.line, fix.lat, fix.lon, st.nav.hint);
      if (p.dist < Math.max(40, fix.acc)) {
        const pt = V.pointAt(st.nav.line, p.along + (v > 1 ? v * dt : 0));
        return { lat: pt.lat, lon: pt.lon, bearing: pt.bearing };
      }
    }
    let lat = fix.lat, lon = fix.lon;
    if (v > 1.5 && st.heading != null) {
      const d = v * dt, r = st.heading * Math.PI / 180;
      lat += d * Math.cos(r) / 110540;
      lon += d * Math.sin(r) / (111320 * Math.cos(lat * Math.PI / 180));
    }
    return { lat, lon, bearing: st.heading };
  }

  function updateHalo() {
    const show = !st.nav && st.acc > 12;
    haloEl.style.display = show ? '' : 'none';
    if (!show) return;
    const mpp = 40075016.686 * Math.cos(disp.lat * Math.PI / 180) / (512 * Math.pow(2, map.getZoom()));
    const px = Math.min(600, Math.max(44, 2 * st.acc / mpp));
    haloEl.style.width = haloEl.style.height = px + 'px';
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!fix || document.hidden) { lastFrame = ts; return; }
    const dtf = Math.min(0.1, Math.max(0.001, (ts - lastFrame) / 1000));
    lastFrame = ts;
    const target = predicted();
    if (!disp) disp = { lat: target.lat, lon: target.lon };
    const jump = V.haversine(disp.lat, disp.lon, target.lat, target.lon);
    const k = jump > 250 ? 1 : 1 - Math.pow(0.003, dtf);
    disp.lat = lerp(disp.lat, target.lat, k);
    disp.lon = lerp(disp.lon, target.lon, k);
    if (target.bearing != null) dispBearing = lerpAngle(dispBearing, target.bearing, 1 - Math.pow(0.02, dtf));
    meMarker.setLngLat([disp.lon, disp.lat]).setRotation(dispBearing);
    updateHalo();
    if (!st.follow || flying) return;
    if (st.nav) {
      const z = st.speed > 100 ? 15.2 : st.speed > 70 ? 15.8 : st.speed > 40 ? 16.4 : 17.2;
      camZoom = camZoom == null ? map.getZoom() : lerp(camZoom, z, 1 - Math.pow(0.4, dtf));
      map.jumpTo({ center: [disp.lon, disp.lat], bearing: dispBearing, pitch: 60, zoom: camZoom, padding: navPadding() });
    } else {
      map.jumpTo({ center: [disp.lon, disp.lat], padding: noPadding });
    }
  }
  requestAnimationFrame(frame);

  /** Vuela hasta la flecha (al empezar, al iniciar la ruta o al pulsar "centrar"). */
  function flyToMe(zoom) {
    const p = disp || fix;
    if (!p) return;
    flying = true;
    const nav = !!st.nav;
    camZoom = nav ? 17.2 : (zoom || Math.max(map.getZoom(), 16));
    map.flyTo({ center: [p.lon, p.lat], zoom: camZoom, pitch: nav ? 60 : 0,
      bearing: nav ? dispBearing : 0, padding: nav ? navPadding() : noPadding, duration: 1300, essential: true });
    clearTimeout(flyToMe.t);
    flyToMe.t = setTimeout(() => { flying = false; }, 1400);
  }

  function setFollow(on) {
    st.follow = on;
    $('#recenterBtn').classList.toggle('on', on);
    $('#recenterBtn').classList.toggle('nudge', !on && !!st.nav);
    if (on) flyToMe();
  }

  // ---------- Datos: radares ----------
  async function loadOfficialRadars() {
    try {
      const r = await fetchTimeout('data/radares.json?v=' + Math.floor(now() / 3600e3), 20000);
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      st.official = V.parseRadarsCompact(j);
      st.radarSource = `OpenStreetMap · ${new Date(j.actualizado).toLocaleDateString('es-ES')}`;
      drawRadars();
    } catch {
      if (st.pos) loadOverpassAround(st.pos.lat, st.pos.lon);
    }
  }

  async function loadOverpassAround(lat, lon) {
    if (st.official.length) return;
    const q = `[out:json][timeout:25];node["highway"="speed_camera"](around:80000,${lat},${lon});out body;`;
    try {
      const r = await fetchTimeout(`${CONFIG.overpass}?data=${encodeURIComponent(q)}`, 30000);
      const j = await r.json();
      st.official = (j.elements || []).map(e => ({
        id: 'osm-' + e.id, lat: e.lat, lon: e.lon, kind: 'fixed', source: 'official',
        limit: parseInt(e.tags && e.tags.maxspeed, 10) || null,
        dir: Number.isFinite(parseFloat(e.tags && e.tags.direction)) ? parseFloat(e.tags.direction) : null,
      }));
      st.radarSource = 'OpenStreetMap (80 km a tu alrededor)';
      drawRadars();
    } catch {
      notice('No se pudieron cargar los radares fijos. Revisa la conexión.');
    }
  }

  // ---------- Datos: avisos de la comunidad (ntfy) ----------
  async function pollCommunity() {
    try {
      const r = await fetchTimeout(`${CONFIG.ntfy}/${CONFIG.ntfyTopic}/json?poll=1&since=12h`, 15000);
      const text = await r.text();
      const msgs = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(m => m && m.event === 'message');
      st.community = V.communityFromMessages(msgs);
      st.communityAt = now();
      drawRadars();
      if (st.nav) st.nav.radarsOn = V.radarsOnLine(st.nav.line, alertable());
      refreshOpenRadarDetail();
    } catch { /* sin conexión: se reintenta */ }
  }

  async function publish(payload) {
    const r = await fetchTimeout(`${CONFIG.ntfy}/`, 15000, {
      method: 'POST', body: JSON.stringify({ topic: CONFIG.ntfyTopic, message: JSON.stringify(payload) }),
    });
    if (!r.ok) throw new Error(r.status);
  }

  async function report(kind) {
    if (!st.pos) { toast('Esperando señal GPS…'); return; }
    closeSheet();
    play('report');
    if (navigator.vibrate) navigator.vibrate(40);
    const near = allRadars().find(r => r.source === 'community' && r.kind === kind && r.status !== 'gone'
      && V.haversine(r.lat, r.lon, st.pos.lat, st.pos.lon) < 300);
    try {
      if (near) {
        await publish({ t: 'v', id: near.id, v: 1, d: deviceId });
      } else {
        const id = Math.random().toString(36).slice(2, 11);
        const b = st.heading != null && st.speed > 10 ? Math.round(st.heading) : undefined;
        await publish({ t: 'r', id, k: kind, la: +st.pos.lat.toFixed(6), lo: +st.pos.lon.toFixed(6), b, d: deviceId });
      }
      toast(`${V.KINDS[kind].label} avisado. ¡Gracias!`);
      setTimeout(pollCommunity, 800);
    } catch {
      toast('No se pudo enviar el aviso');
    }
  }

  async function vote(id, v) {
    try {
      await publish({ t: 'v', id, v, d: deviceId });
      toast(v > 0 ? 'Confirmado: sigue ahí' : 'Anotado: ya no está');
      closeSheet();
      setTimeout(pollCommunity, 800);
    } catch { toast('No se pudo enviar tu voto'); }
  }

  // ---------- Datos: precios ----------
  let loadingPrices = false;
  async function loadPrices(force = false) {
    if (loadingPrices) return;
    if (!force && st.pricesFetchedAt && now() - st.pricesFetchedAt < 9 * 60e3) return;
    loadingPrices = true;
    renderGasHeader();
    try {
      const r = await fetchTimeout('data/precios.json?v=' + Math.floor(now() / 60e3), 30000);
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      st.stations = V.parsePricesCompact(j);
      st.pricesAt = new Date(j.actualizado);
      st.pricesSource = 'auto';
      if (st.stations.length < 8000) throw new Error('lista incompleta');
    } catch {
      try {
        const r = await fetchTimeout(CONFIG.ministerio, 45000, { headers: { Accept: 'application/json' } });
        const fresh = V.parseMinisterio(await r.json());
        const old = new Map(st.stations.map(s => [s.id, s]));
        for (const s of fresh) {
          const o = old.get(s.id);
          if (o) for (const k in s.prices) if (o.prices[k] != null && o.prices[k] !== s.prices[k]) s.prev[k] = o.prices[k];
        }
        st.stations = fresh;
        st.pricesAt = new Date();
        st.pricesSource = 'directo';
      } catch {
        if (!st.stations.length) notice('No se pudieron descargar los precios de las gasolineras.');
      }
    }
    st.pricesFetchedAt = now();
    loadingPrices = false;
    drawStations(); renderCheap(); renderGasHeader(); refreshGasList();
  }

  function nearbyStations(lat, lon, radius, fuel) {
    const dLat = radius / 111000;
    return st.stations.filter(s => s.prices[fuel] != null && Math.abs(s.lat - lat) < dLat)
      .map(s => ({ s, d: V.haversine(lat, lon, s.lat, s.lon) }))
      .filter(x => x.d < radius).sort((a, b) => a.d - b.d);
  }

  function refPrice(lat, lon) {
    const fallback = S.fuel.startsWith('diesel') ? 1.45 : 1.55;
    if (lat == null) return fallback;
    const ps = nearbyStations(lat, lon, 25000, S.fuel).map(x => x.s.prices[S.fuel]).sort((a, b) => a - b).slice(0, 10);
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : fallback;
  }

  // ---------- Rutas ----------
  async function osrm(from, to, exclude) {
    const url = `${CONFIG.osrm}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
      `?overview=full&geometries=geojson&steps=true&alternatives=3${exclude ? '&exclude=' + exclude : ''}`;
    const r = await fetchTimeout(url, 25000);
    const j = await r.json();
    if (j.code !== 'Ok') throw new Error(j.code || 'error');
    return j.routes;
  }

  let routeSeq = 0;
  async function computeRoutes(from, to) {
    const plain = S.avoidMotorways ? 'motorway' : null;
    const noToll = S.avoidMotorways ? 'motorway,toll' : 'toll';
    const res = await Promise.allSettled([osrm(from, to, plain), osrm(from, to, noToll)]);
    let raw = [];
    res.forEach(x => { if (x.status === 'fulfilled') raw = raw.concat(x.value); });
    if (res[1].status === 'rejected' && S.avoidMotorways) {
      try { raw = raw.concat(await osrm(from, to, 'toll')); } catch { /* sin alternativa */ }
    }
    if (!raw.length) throw new Error('NoRoute');
    const price = refPrice(from.lat, from.lon);
    const radars = alertable();
    const list = raw.map(rt => {
      const coords = rt.geometry.coordinates;
      const steps = rt.legs.flatMap(l => l.steps);
      const hasTolls = steps.some(s => (s.intersections || []).some(i => (i.classes || []).includes('toll')));
      const line = V.prepareLine(coords);
      const liters = V.fuelLiters(rt.distance, rt.duration, S.consumption);
      return {
        id: 'r' + (++routeSeq), coords, line, steps, hasTolls,
        distance: rt.distance, duration: rt.duration,
        via: rt.legs.map(l => l.summary).filter(Boolean).join(', '),
        liters, cost: liters * price, price,
        radars: V.radarsOnLine(line, radars),
      };
    });
    return V.dedupeRoutes(list);
  }

  async function planRoute() {
    if (!st.dest) return;
    const from = st.origin.current ? st.pos : st.origin;
    if (!from) { toast('Esperando señal GPS…'); return; }
    st.routes = []; st.selectedId = null;
    openPlanner(true);
    try {
      st.routes = await computeRoutes(from, st.dest);
      st.selectedId = visibleRoutes()[0]?.id || null;
      drawRoutes();
      const sel = selectedRoute(); if (sel) fitRoute(sel);
      setFollow(false);
      renderPlanner();
    } catch (e) {
      renderPlanner(e.message === 'NoRoute' ? 'No hay ninguna ruta en coche entre esos dos puntos.' : 'No se pudo calcular la ruta. Revisa la conexión e inténtalo otra vez.');
    }
  }

  // ---------- Navegación ----------
  function prepareNav(route) {
    let hint = 0;
    const steps = route.steps.map(s => {
      const [lon, lat] = s.maneuver.location;
      const p = V.project(route.line, lat, lon, hint);
      hint = p.idx;
      return { ...V.instruction(s), along: p.along, length: s.distance };
    });
    return { route, line: route.line, steps, hint: 0, spoken: {}, off: 0, rerouting: false, lastReroute: 0,
      arrived: false, progress: 0, radarsOn: V.radarsOnLine(route.line, alertable()) };
  }

  function startNav() {
    const r = selectedRoute();
    if (!r || !st.dest) return;
    closePlanner(false);
    st.nav = prepareNav(r);
    radarStages.clear();
    document.body.classList.add('navigating');
    $('#topbar').hidden = true; $('#chips').hidden = true;
    $('#maneuver').hidden = false; $('#navbar').hidden = false; $('#arrived').hidden = true;
    $('#gasBtn').hidden = true; $('#voiceBtn').hidden = false; renderVoiceBtn();
    $('#cheapPill').hidden = true;
    drawRoutes(); drawStations();
    keepAwake();
    if (st.pos) {
      // Orienta la cámara en el sentido de la ruta desde el primer momento.
      const p0 = V.project(st.nav.line, st.pos.lat, st.pos.lon);
      dispBearing = V.pointAt(st.nav.line, p0.along + 10).bearing;
    }
    setFollow(true);
    if (S.voiceGuide) {
      const n = r.radars.length;
      say(`Iniciando ruta. ${fmt.dur(r.duration).replace('min', 'minutos').replace(' h ', ' horas ')}, ${V.spokenDistance(r.distance)}.` +
        (n ? ` Hay ${n} radar${n === 1 ? '' : 'es'} en el camino.` : ''));
    }
    if (st.pos) updateNav(st.pos.lat, st.pos.lon);
  }

  function endNav() {
    st.nav = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    document.body.classList.remove('navigating');
    $('#maneuver').hidden = true; $('#navbar').hidden = true; $('#arrived').hidden = true;
    $('#topbar').hidden = false; $('#chips').hidden = false;
    $('#gasBtn').hidden = false; $('#voiceBtn').hidden = true;
    clearRoute();
    radarStages.clear();
    camZoom = null;
    setFollow(true);
    renderCheap();
  }

  function updateNav(lat, lon) {
    const n = st.nav;
    if (!n || n.rerouting) return;
    const p = V.project(n.line, lat, lon, n.hint);
    n.hint = p.idx;
    n.progress = p.along;

    const tol = Math.max(50, st.acc * 1.5);
    n.off = p.dist > tol ? n.off + 1 : 0;
    if (n.off >= 3 && now() - n.lastReroute > 12000) { reroute(); return; }

    const remaining = Math.max(0, n.line.length - p.along);
    const remTime = n.route.distance > 0 ? n.route.duration * remaining / n.route.distance : 0;
    $('#remDist').textContent = fmt.dist(remaining);
    $('#remTime').textContent = fmt.dur(remTime);
    $('#etaVal').textContent = new Date(now() + remTime * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

    const toDest = V.haversine(lat, lon, st.dest.lat, st.dest.lon);
    if (remaining < 30 || toDest < 35) {
      if (!n.arrived) {
        n.arrived = true;
        $('#navbar').hidden = true; $('#arrived').hidden = false;
        $('#arrivedName').textContent = st.dest.name;
        setManeuver('flag', 'Has llegado a tu destino', 0);
        if (S.voiceGuide) say('Has llegado a tu destino', true);
      }
      return;
    }

    const i = n.steps.findIndex((s, k) => k > 0 && s.along > p.along + 8);
    if (i < 0) return;
    const step = n.steps[i], d = step.along - p.along;
    setManeuver(step.icon, step.text, d);
    const next = n.steps[i + 1];
    $('#thenBox').hidden = !(next && next.along - step.along < 250 && next.type !== 'arrive');
    if (next) $('#thenIcon').innerHTML = `<use href="#m-${next.icon}"/>`;
    announce(i, step, d);
  }

  function setManeuver(icon, text, d) {
    $('#maneuverIcon').innerHTML = `<use href="#m-${icon}"/>`;
    $('#maneuver .maneuver-icon').classList.toggle('spin', icon === 'reroute');
    $('#maneuverInstr').textContent = text;
    $('#maneuverDist').textContent = icon === 'flag' && !d ? 'Destino' : icon === 'reroute' ? 'Recalculando' : fmt.dist(d);
  }

  function announce(i, step, d) {
    if (!S.voiceGuide || step.type === 'arrive' && d > 300) return;
    const n = st.nav, fast = st.speed > 75;
    const farAt = fast ? 2000 : 800, midAt = fast ? 700 : 250, nowAt = Math.max(40, st.speed / 3.6 * 4);
    const done = n.spoken[i] || (n.spoken[i] = new Set());
    const lower = step.text.charAt(0).toLowerCase() + step.text.slice(1);
    if (d <= nowAt && !done.has(2)) {
      [0, 1, 2].forEach(x => done.add(x));
      if (S.maneuverSound) play('maneuver');
      say(step.text);
    } else if (d <= midAt && d > nowAt * 1.5 && !done.has(1)) {
      done.add(0); done.add(1);
      say(`En ${V.spokenDistance(d)}, ${lower}`);
    } else if (d <= farAt && d > midAt * 1.6 && !done.has(0)) {
      done.add(0);
      say(`En ${V.spokenDistance(d)}, ${lower}`);
    }
  }

  async function reroute() {
    const n = st.nav;
    if (!n || !st.pos) return;
    n.rerouting = true; n.lastReroute = now();
    setManeuver('reroute', 'Buscando el mejor camino…', 0);
    if (S.voiceGuide) say('Recalculando ruta', true);
    try {
      st.routes = await computeRoutes(st.pos, st.dest);
      const best = visibleRoutes()[0];
      if (best && st.nav) {
        st.selectedId = best.id;
        st.nav = prepareNav(best);
        drawRoutes();
      }
    } catch {
      if (st.nav) { st.nav.rerouting = false; st.nav.off = 0; }
      notice('Sin conexión para recalcular. Sigue las indicaciones de la carretera.', 5000);
      return;
    }
    if (st.nav) st.nav.rerouting = false;
  }

  // ---------- Avisos de radar ----------
  const radarStages = new Map();
  let currentRadar = null;

  function evaluateRadars(lat, lon) {
    let best = null;
    if (st.nav) {
      for (const x of st.nav.radarsOn) {
        const ahead = x.along - st.nav.progress;
        if (ahead > -20 && ahead < 1200 && x.radar.status !== 'gone') { best = { r: x.radar, d: Math.max(0, ahead) }; break; }
      }
    } else {
      const h = st.heading, moving = st.speed > 12 && h != null;
      for (const r of alertable()) {
        if (Math.abs(r.lat - lat) > 0.012 || Math.abs(r.lon - lon) > 0.016) continue;
        const d = V.haversine(lat, lon, r.lat, r.lon);
        if (d > 1200) continue;
        if (moving) {
          if (V.angleDiff(h, V.bearing(lat, lon, r.lat, r.lon)) > 50 && d > 40) continue;
          if (r.dir != null && V.angleDiff(h, r.dir) > 60) continue;
        }
        if (!best || d < best.d) best = { r, d };
      }
    }

    if (!best) {
      currentRadar = null;
      renderBanner();
      for (const [id] of radarStages) {
        const r = findRadar(id);
        if (!r || V.haversine(lat, lon, r.lat, r.lon) > 1600) radarStages.delete(id);
      }
      return;
    }
    currentRadar = best;
    const { r, d } = best;
    const done = radarStages.get(r.id) || new Set();
    const limitTxt = r.limit ? `. Límite ${r.limit}` : '';
    const label = V.KINDS[r.kind].label;
    if (d <= 520 && !done.has(2)) {
      done.add(1); done.add(2);
      if (S.alertNear) {
        if (S.radarSound) play('near');
        if (S.radarVoice) say(`${label} a 500 metros${limitTxt}`, true);
        if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
      }
    } else if (d <= 1050 && d > 620 && !done.has(1)) {
      done.add(1);
      if (S.alertFar) {
        if (S.radarSound) play('far');
        if (S.radarVoice) say(`${label} a 1 kilómetro`);
        if (navigator.vibrate) navigator.vibrate(100);
      }
    }
    if (S.speeding && r.limit && d < 450 && st.speed > r.limit + 3 && !done.has(3)) {
      done.add(3);
      if (S.radarVoice) say('Reduce la velocidad', true); else if (S.radarSound) play('near');
    }
    radarStages.set(r.id, done);
    renderBanner();
  }

  // ---------- Interfaz: HUD ----------
  const LAYERS = [
    { k: 'all', label: 'Todo', icon: 'i-layers' },
    { k: 'radars', label: 'Radares', icon: 'i-camera' },
    { k: 'gas', label: 'Gasolineras', icon: 'i-fuel' },
    { k: 'none', label: 'Solo mapa', icon: 'i-map' },
  ];
  function renderChips() {
    $('#chips').innerHTML = LAYERS.map(l =>
      `<button class="chip" role="tab" type="button" data-layer="${l.k}" aria-selected="${S.layer === l.k}">${ic(l.icon)}${l.label}</button>`).join('');
  }
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('[data-layer]');
    if (!b) return;
    S.layer = b.dataset.layer; saveS();
    renderChips(); drawRadars(); drawStations();
  });

  function renderSearchBar() {
    const t = $('#searchText');
    t.textContent = st.dest ? st.dest.name : '¿A dónde vamos?';
    t.classList.toggle('placeholder', !st.dest);
    $('#clearBtn').hidden = !st.dest;
    $('#searchIcon').style.display = st.dest ? 'none' : '';
  }

  function isSpeeding() {
    const lim = currentRadar && currentRadar.r.limit;
    return !!(lim && st.speed > lim + 2);
  }

  function renderSpeed() {
    const v = Math.round(st.speed);
    $('#speedVal').textContent = v;
    $('#speedArc').style.strokeDasharray = `${(76 * Math.min(v / 160, 1)).toFixed(1)} 100`;
    const lim = currentRadar && currentRadar.r.limit;
    $('#speedLimit').hidden = !lim;
    if (lim) $('#speedLimit').textContent = lim;
    $('#speed').classList.toggle('speeding', isSpeeding());
  }

  const KIND_ICON = { fixed: 'i-camera', section: 'i-lanes', mobile: 'i-car', light: 'i-light', police: 'i-shield' };
  const STATUS_LABEL = { active: 'Activo', unconfirmed: 'Sin confirmar', gone: 'Ya no está' };

  function renderBanner() {
    const b = $('#banner');
    if (!currentRadar) { b.hidden = true; renderSpeed(); return; }
    const { r, d } = currentRadar;
    const k = V.KINDS[r.kind];
    b.hidden = false;
    b.style.setProperty('--kind', k.color);
    $('#bannerIcon').innerHTML = `<use href="#${KIND_ICON[r.kind]}"/>`;
    $('#bannerKind').textContent = k.label;
    const sp = $('#bannerStatus');
    sp.hidden = r.source !== 'community';
    if (!sp.hidden) { sp.textContent = STATUS_LABEL[r.status]; sp.style.setProperty('--c', STATUS_COLOR[r.status]); }
    $('#bannerDist').textContent = fmt.dist(d);
    $('#bannerLimit').hidden = !r.limit;
    if (r.limit) $('#bannerLimit').textContent = r.limit;
    b.classList.toggle('speeding', isSpeeding());
    renderSpeed();
  }

  let cheapAt = 0;
  function throttledCheap() { if (now() - cheapAt > 15000) renderCheap(); }
  function renderCheap() {
    cheapAt = now();
    const el = $('#cheapPill');
    if (st.nav || !st.pos || !st.stations.length) { el.hidden = true; return; }
    const near = nearbyStations(st.pos.lat, st.pos.lon, 5000, S.fuel);
    if (!near.length) { el.hidden = true; return; }
    const best = near.reduce((a, b) => b.s.prices[S.fuel] < a.s.prices[S.fuel] ? b : a);
    const f = V.FUELS.find(x => x.key === S.fuel);
    el.hidden = false;
    el.dataset.id = best.s.id;
    el.innerHTML = `${ic('i-fuel')}<span><small>${f.short} más barata cerca</small><b>${fmt.price(best.s.prices[S.fuel])} € · ${fmt.dist(best.d)}</b></span>`;
  }

  function renderVoiceBtn() {
    const b = $('#voiceBtn');
    b.innerHTML = ic(S.voiceGuide ? 'i-vol' : 'i-mute');
    b.classList.toggle('off', !S.voiceGuide);
    b.setAttribute('aria-label', S.voiceGuide ? 'Silenciar guía por voz' : 'Activar guía por voz');
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
  }
  let noticeTimer = null;
  function notice(msg, ms = 6000) {
    const n = $('#notice');
    n.textContent = msg; n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { n.hidden = true; }, ms);
  }

  // ---------- Hojas ----------
  let sheetKind = null, sheetData = null;
  function openSheet(kind, title, html, data) {
    sheetKind = kind; sheetData = data || null;
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#sheet').classList.toggle('full', kind === 'search' || kind === 'settings');
    $('#sheet').hidden = false; $('#scrim').hidden = false;
    $('#sheetBody').scrollTop = 0;
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#scrim').hidden = true;
    sheetKind = null; sheetData = null;
  }
  $('#scrim').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);

  // --- Buscador ---
  const search = { editing: 'dest', q: { origin: '', dest: '' }, results: [], timer: null, seq: 0 };
  const recents = () => store.get('recents', []);
  function addRecent(p) {
    const list = recents().filter(x => !(x.name === p.name && x.sub === p.sub));
    list.unshift({ name: p.name, sub: p.sub, lat: p.lat, lon: p.lon });
    store.set('recents', list.slice(0, 8));
  }

  function openSearch() {
    search.editing = 'dest';
    search.q = { origin: st.origin.current ? '' : st.origin.name, dest: st.dest ? st.dest.name : '' };
    search.results = [];
    openSheet('search', 'Planificar ruta', `
      <div class="od">
        <div class="od-dots"><b class="a"></b><i></i><i></i><i></i>${ic('i-pin')}</div>
        <div class="od-fields">
          <label class="field" id="fwO"><input id="fOrigin" placeholder="Mi ubicación" autocomplete="off" enterkeyhint="search" value="${esc(search.q.origin)}"></label>
          <label class="field active" id="fwD"><input id="fDest" placeholder="Destino: calle, ciudad, lugar…" autocomplete="off" enterkeyhint="search" value="${esc(search.q.dest)}"></label>
        </div>
        <button class="swap" id="swapBtn" type="button" aria-label="Intercambiar origen y destino" ${st.dest ? '' : 'disabled'}>${ic('i-swap')}</button>
      </div>
      <div id="results" class="list"></div>`);
    const fo = $('#fOrigin'), fd = $('#fDest');
    const focusField = which => {
      search.editing = which;
      $('#fwO').classList.toggle('active', which === 'origin');
      $('#fwD').classList.toggle('active', which === 'dest');
      runSearch();
    };
    fo.addEventListener('focus', () => focusField('origin'));
    fd.addEventListener('focus', () => focusField('dest'));
    fo.addEventListener('input', () => { search.q.origin = fo.value; runSearch(); });
    fd.addEventListener('input', () => { search.q.dest = fd.value; runSearch(); });
    $('#swapBtn').addEventListener('click', () => {
      if (!st.dest) return;
      const o = st.origin;
      st.origin = { ...st.dest, current: false };
      st.dest = o.current ? null : o;
      if (st.dest) destMarker.setLngLat([st.dest.lon, st.dest.lat]).addTo(map); else destMarker.remove();
      closeSheet(); renderSearchBar();
      if (st.dest) planRoute(); else openSearch();
    });
    $('#results').addEventListener('click', e => {
      const b = e.target.closest('[data-i]');
      if (b) choosePlace(b.dataset.i);
    });
    renderResults();
    setTimeout(() => fd.focus(), 250);
  }

  function runSearch() {
    clearTimeout(search.timer);
    const q = search.q[search.editing].trim();
    if (q.length < 3) { search.results = []; renderResults(); return; }
    search.timer = setTimeout(async () => {
      const my = ++search.seq;
      const c = st.pos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
      try {
        const r = await fetchTimeout(`${CONFIG.photon}/api/?q=${encodeURIComponent(q)}&limit=8&lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}`, 10000);
        const j = await r.json();
        if (my !== search.seq) return;
        search.results = (j.features || []).map(f => {
          const p = f.properties || {};
          const street = [p.street, p.housenumber].filter(Boolean).join(' ');
          const name = p.name || street || p.city || 'Lugar';
          const sub = [p.name ? street : '', [p.postcode, p.city || p.town || p.village].filter(Boolean).join(' '), p.state]
            .filter(Boolean).filter(x => x !== name).join(', ');
          return { name, sub, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
        });
        renderResults();
      } catch {
        if (my === search.seq) { search.results = []; renderResults('No se pudo buscar. Revisa la conexión.'); }
      }
    }, 320);
  }

  function renderResults(error) {
    const box = $('#results');
    if (!box) return;
    const q = search.q[search.editing].trim();
    let items = [];
    if (search.editing === 'origin') items.push({ key: 'me', icon: 'i-me', color: 'var(--teal)', name: 'Mi ubicación', sub: 'Usar el GPS' });
    let label = '';
    if (q.length < 3) {
      const rec = recents();
      if (rec.length) label = 'Recientes';
      items = items.concat(rec.map((p, i) => ({ key: 'rec' + i, icon: 'i-clock', color: 'var(--muted)', ...p })));
    } else {
      items = items.concat(search.results.map((p, i) => ({ key: 'res' + i, icon: 'i-pin', color: 'var(--blue)', ...p })));
    }
    search.items = items;
    box.innerHTML = (label ? `<div class="section-label">${label}</div>` : '') +
      items.map((it, i) => `<button class="item" type="button" data-i="${i}">
        <span class="ic" style="color:${it.color}">${ic(it.icon)}</span>
        <span class="tx"><div class="t1">${esc(it.name)}</div>${it.sub ? `<div class="t2">${esc(it.sub)}</div>` : ''}</span></button>`).join('') +
      (error ? `<div class="empty">${esc(error)}</div>` : '') +
      (!items.length && q.length >= 3 && !error ? '<div class="empty">Sin resultados todavía…</div>' : '');
  }

  function choosePlace(i) {
    const it = search.items[+i];
    if (!it) return;
    if (search.editing === 'origin') {
      st.origin = it.key === 'me' ? { current: true, name: 'Mi ubicación' } : { name: it.name, sub: it.sub, lat: it.lat, lon: it.lon, current: false };
      $('#fOrigin').value = st.origin.current ? '' : st.origin.name;
      search.q.origin = $('#fOrigin').value;
      $('#fDest').focus();
      return;
    }
    st.dest = { name: it.name, sub: it.sub, lat: it.lat, lon: it.lon };
    addRecent(st.dest);
    closeSheet();
    renderSearchBar();
    destMarker.setLngLat([st.dest.lon, st.dest.lat]).addTo(map);
    planRoute();
  }

  function clearRoute() {
    st.dest = null; st.routes = []; st.selectedId = null;
    st.origin = { current: true, name: 'Mi ubicación' };
    destMarker.remove();
    closePlanner(false);
    drawRoutes(); renderSearchBar();
  }

  // --- Comparador de rutas ---
  function openPlanner(loading) {
    $('#planner').hidden = false;
    $('#planner').classList.remove('expanded');
    if (loading) $('#plannerBody').innerHTML = `<div class="route-head"><div style="min-width:0"><h3>${esc(st.dest.name)}</h3><p>Calculando rutas con y sin peajes…</p></div></div><div class="empty">Un momento…</div>`;
  }
  function closePlanner(clear = true) {
    $('#planner').hidden = true;
    if (clear) clearRoute();
  }
  $('#plannerGrab').addEventListener('click', () => $('#planner').classList.toggle('expanded'));

  const CRITERIA = [
    { k: 'eco', label: 'Eco', icon: 'i-leaf', best: 'Gasta menos' },
    { k: 'shortest', label: 'Más corta', icon: 'i-ruler', best: 'Más corta' },
    { k: 'fastest', label: 'Más rápida', icon: 'i-bolt', best: 'Más rápida' },
  ];

  function renderPlanner(error) {
    if ($('#planner').hidden || !st.dest) return;
    const vis = visibleRoutes(), sel = selectedRoute();
    const originName = st.origin.current ? 'Desde mi ubicación' : `Desde ${st.origin.name}`;
    let html = `<div class="route-head"><div style="min-width:0"><h3>${esc(st.dest.name)}</h3><p>${esc(originName)}</p></div>
      <button class="icon-plain" type="button" data-act="close" aria-label="Cerrar">${ic('i-x')}</button></div>`;
    if (error) {
      html += `<div class="empty">${esc(error)}</div><button class="btn-grad" type="button" data-act="retry">${ic('i-refresh')}Reintentar</button>`;
      $('#plannerBody').innerHTML = html; return;
    }
    html += `<div class="seg" role="group" aria-label="Peajes">
        <button type="button" data-toll="any" aria-pressed="${S.tolls === 'any'}">Con peajes</button>
        <button type="button" data-toll="avoid" aria-pressed="${S.tolls === 'avoid'}">Sin peajes</button></div>
      <div class="criteria">${CRITERIA.map(c => `<button class="chip" type="button" data-crit="${c.k}" aria-selected="${S.criterion === c.k}">${ic(c.icon)}${c.label}</button>`).join('')}</div>`;

    const paid = V.sortRoutes(st.routes.filter(r => r.hasTolls), 'fastest')[0];
    const free = V.sortRoutes(st.routes.filter(r => !r.hasTolls), 'fastest')[0];
    if (paid && free) {
      const dt = free.duration - paid.duration, dc = free.cost - paid.cost;
      html += `<div class="compare">${ic('i-euro')}<span>Sin peajes: ${dt >= 0 ? '+' : '−'}${fmt.dur(Math.abs(dt))} · ${dc >= 0 ? '+' : '−'}${fmt.eur(Math.abs(dc))} de combustible</span></div>`;
    } else if (st.routes.length && !free && S.tolls === 'avoid') {
      html += `<div class="compare">${ic('i-euro')}<span>No hay alternativa sin peajes para este trayecto.</span></div>`;
    }

    const crit = CRITERIA.find(c => c.k === S.criterion);
    html += vis.map((r, i) => `
      <button class="rcard ${sel && r.id === sel.id ? 'sel' : ''}" type="button" data-route="${r.id}">
        <div class="top"><span class="time">${fmt.dur(r.duration)}</span><span class="km">${fmt.dist(r.distance)}</span>
          ${i === 0 ? `<span class="best-tag">${ic(crit.icon)}${crit.best}</span>` : ''}</div>
        ${r.via ? `<div class="via">Por ${esc(r.via)}</div>` : ''}
        <div class="pills">
          <span class="pill" style="--c:var(--cheap)">${ic('i-fuel')}${fmt.liters(r.liters)} · ${fmt.eur(r.cost)}</span>
          <span class="pill" style="--c:${r.radars.length ? 'var(--red)' : 'var(--muted)'}">${ic('i-camera')}${r.radars.length} radar${r.radars.length === 1 ? '' : 'es'}</span>
          <span class="pill" style="--c:${r.hasTolls ? 'var(--mid)' : 'var(--teal)'}">${ic(r.hasTolls ? 'i-euro' : 'i-check')}${r.hasTolls ? 'Peaje' : 'Sin peaje'}</span>
        </div>
      </button>`).join('');
    if (sel) {
      html += `<button class="btn-grad" type="button" data-act="go">${ic('i-locate')}Iniciar navegación</button>`;
      html += `<p class="fine">Consumo estimado con ${fmt.liters(S.consumption)}/100 km y ${V.FUELS.find(f => f.key === S.fuel).label} a ${fmt.price(sel.price)} €/L (media de las gasolineras más baratas cerca). El precio del peaje no se incluye.</p>`;
    }
    $('#plannerBody').innerHTML = html;
  }

  $('#plannerBody').addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.act === 'close') { closePlanner(true); return; }
    if (t.dataset.act === 'retry') { planRoute(); return; }
    if (t.dataset.act === 'go') { startNav(); return; }
    if (t.dataset.toll) { S.tolls = t.dataset.toll; saveS(); st.selectedId = visibleRoutes()[0]?.id; }
    if (t.dataset.crit) { S.criterion = t.dataset.crit; saveS(); st.selectedId = visibleRoutes()[0]?.id; }
    if (t.dataset.route) st.selectedId = t.dataset.route;
    drawRoutes(); renderPlanner();
    const sel = selectedRoute(); if (sel && (t.dataset.toll || t.dataset.crit || t.dataset.route)) fitRoute(sel);
  });

  // --- Gasolineras ---
  const gasUI = { sort: 'price', radius: 10000 };
  function openGas() {
    openSheet('gas', 'Gasolineras', `
      <div class="opt" style="padding:0;border:0;min-height:0"><span class="lbl">Combustible</span>
        <select id="gasFuel">${V.FUELS.map(f => `<option value="${f.key}" ${f.key === S.fuel ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>
      <div class="seg" id="gasSort">
        <button type="button" data-v="price" aria-pressed="${gasUI.sort === 'price'}">Más baratas</button>
        <button type="button" data-v="dist" aria-pressed="${gasUI.sort === 'dist'}">Más cerca</button></div>
      <div class="seg" id="gasRadius">${[5000, 10000, 25000, 50000].map(r =>
        `<button type="button" data-v="${r}" aria-pressed="${gasUI.radius === r}">${r / 1000} km</button>`).join('')}</div>
      <div class="row" style="justify-content:space-between"><span id="gasUpdated" class="fine"></span>
        <button class="icon-plain" id="gasRefresh" type="button" aria-label="Actualizar precios">${ic('i-refresh')}</button></div>
      <div id="gasList" class="list"></div>`);
    $('#gasFuel').addEventListener('change', e => { S.fuel = e.target.value; saveS(); refreshGasList(); drawStations(); renderCheap(); });
    $('#gasSort').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; gasUI.sort = b.dataset.v; setPressed('#gasSort', b); refreshGasList(); });
    $('#gasRadius').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; gasUI.radius = +b.dataset.v; setPressed('#gasRadius', b); refreshGasList(); });
    $('#gasRefresh').addEventListener('click', () => loadPrices(true));
    $('#gasList').addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) openStation(b.dataset.id); });
    renderGasHeader(); refreshGasList();
  }
  function setPressed(sel, b) { document.querySelectorAll(`${sel} button`).forEach(x => x.setAttribute('aria-pressed', x === b)); }

  function renderGasHeader() {
    const el = $('#gasUpdated');
    if (!el) return;
    if (loadingPrices) { el.textContent = 'Actualizando precios…'; return; }
    el.textContent = st.pricesAt
      ? `Precios oficiales de las ${st.pricesAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} · se actualizan solos`
      : 'Descargando precios oficiales…';
  }

  function trendHtml(s, f) {
    const tr = trendOf(s, f);
    if (!tr) return '<span class="t3">€/L</span>';
    return `<span class="trend ${tr}">${ic(tr === 'up' ? 'i-up' : 'i-down')}antes ${fmt.price(s.prev[f])}</span>`;
  }

  function refreshGasList() {
    const box = $('#gasList');
    if (!box || sheetKind !== 'gas') return;
    const c = st.pos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
    let list = nearbyStations(c.lat, c.lon, gasUI.radius, S.fuel).slice(0, 150);
    if (gasUI.sort === 'price') list = list.slice().sort((a, b) => a.s.prices[S.fuel] - b.s.prices[S.fuel] || a.d - b.d);
    const min = Math.min(...list.map(x => x.s.prices[S.fuel]));
    if (!list.length) {
      box.innerHTML = `<div class="empty">${st.stations.length ? 'No hay gasolineras con ese combustible en este radio.' : 'Cargando precios…'}</div>`;
      return;
    }
    box.innerHTML = list.map(({ s, d }) => {
      const p = s.prices[S.fuel], best = p === min;
      const name = V.brandName(s.brand);
      return `<button class="item" type="button" data-id="${esc(s.id)}">
        <span class="ic" style="font:800 13px var(--font-display)">${esc(name.slice(0, 2).toUpperCase())}</span>
        <span class="tx"><div class="t1">${esc(name)}${best ? '<span class="badge">MÁS BARATA</span>' : ''}</div>
          <div class="t2">${esc([s.address, s.town].filter(Boolean).join(', '))}</div>
          <div class="t3">${fmt.dist(d)}${/24H/i.test(s.schedule) ? ' · 24 h' : ''}</div></span>
        <span class="end"><div class="price ${best ? 'best' : ''}">${fmt.price(p)}</div>${trendHtml(s, S.fuel)}</span></button>`;
    }).join('');
  }

  function openStation(id) {
    const s = st.stations.find(x => x.id === id);
    if (!s) return;
    const d = st.pos ? V.haversine(st.pos.lat, st.pos.lon, s.lat, s.lon) : null;
    openSheet('station', V.brandName(s.brand), `
      <div class="detail-head"><span class="big" style="background:var(--cheap);color:#08130C">${ic('i-fuel')}</span>
        <div style="min-width:0"><div class="sub">${esc([s.address, s.town].filter(Boolean).join(', '))}</div></div></div>
      <div class="ptable">${V.FUELS.filter(f => s.prices[f.key] != null).map(f => `
        <div class="${f.key === S.fuel ? 'me-fuel' : ''}"><span>${f.label}</span>${trendHtml(s, f.key)}<b class="price">${fmt.price(s.prices[f.key])} €</b></div>`).join('')}</div>
      <div class="facts"><div>${ic('i-clock')}${esc(s.schedule || 'Horario no disponible')}</div>
        ${st.pricesAt ? `<div>${ic('i-refresh')}Precios de las ${st.pricesAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}</div>
      <button class="btn-grad" type="button" id="goStation">${ic('i-locate')}Ir aquí${d != null ? ' · ' + fmt.dist(d) : ''}</button>`);
    $('#goStation').addEventListener('click', () => {
      closeSheet();
      st.dest = { name: V.brandName(s.brand), sub: s.address, lat: s.lat, lon: s.lon };
      st.origin = { current: true, name: 'Mi ubicación' };
      renderSearchBar();
      destMarker.setLngLat([s.lon, s.lat]).addTo(map);
      planRoute();
    });
  }

  // --- Radar ---
  function relTime(t) {
    const m = Math.round((now() - t) / 60000);
    if (m < 1) return 'hace un momento';
    if (m < 60) return `hace ${m} min`;
    return `hace ${Math.floor(m / 60)} h ${m % 60} min`;
  }

  function radarDetailHtml(r) {
    const k = V.KINDS[r.kind];
    let html = `<div class="detail-head"><span class="big" style="background:${r.status === 'gone' ? '#5B6478' : k.color}">${ic(KIND_ICON[r.kind])}</span>
      <div style="min-width:0;flex:1"><h3>${k.label}</h3><div class="sub"><span class="dot" style="--c:${STATUS_COLOR[r.status]}"></span>
        <b style="color:${STATUS_COLOR[r.status]}">${STATUS_LABEL[r.status]}</b> · ${r.source === 'community' ? 'Aviso de conductores' : 'Radar fijo publicado'}</div></div>
      ${r.limit ? `<div class="limit">${r.limit}</div>` : ''}</div>`;
    if (r.source === 'community') {
      html += `<div class="facts"><div>${ic('i-clock')}Avisado ${relTime(r.created)}</div>
        ${r.lastSeen > r.created ? `<div>${ic('i-check')}Confirmado por última vez ${relTime(r.lastSeen)}</div>` : ''}
        <div>${ic('i-thumb-up')}${r.ups} lo han visto · ${r.downs} dicen que ya no está</div></div>`;
      if (r.voters.includes(deviceId)) {
        html += `<p class="fine" style="color:var(--teal)">Ya has votado este aviso. Gracias.</p>`;
      } else {
        html += `<div class="btns"><button class="btn-grad" type="button" data-vote="1">${ic('i-thumb-up')}Sigue ahí</button>
          <button class="btn-soft" type="button" data-vote="-1">${ic('i-thumb-down')}Ya no está</button></div>`;
      }
    } else {
      html += `<div class="facts"><div>${ic('i-check')}Siempre se avisa a 1 km y a 500 m.</div>
        ${r.dir != null ? `<div>${ic('i-locate')}Controla el sentido ${Math.round(r.dir)}°</div>` : ''}
        <div>${ic('i-map')}Fuente: OpenStreetMap</div></div>`;
    }
    return html;
  }

  function openRadarDetail(id) {
    const r = findRadar(id);
    if (!r) return;
    openSheet('radar', '', radarDetailHtml(r), id);
    $('#sheetBody').onclick = e => { const b = e.target.closest('[data-vote]'); if (b) vote(r.id, +b.dataset.vote); };
  }
  function refreshOpenRadarDetail() {
    if (sheetKind !== 'radar') return;
    const r = findRadar(sheetData);
    if (r) $('#sheetBody').innerHTML = radarDetailHtml(r);
  }

  // --- Avisar ---
  function openReport() {
    const kinds = ['mobile', 'police', 'fixed', 'section', 'light'];
    openSheet('report', '¿Qué hay aquí?', `
      <p class="fine" style="margin:0">Se comparte al momento con los demás conductores que usan tu Vigía. Hazlo como copiloto o con el coche parado.</p>
      <div class="tiles">${kinds.map(k => `<button class="tile" type="button" data-kind="${k}" style="--c:${V.KINDS[k].color}">${ic(KIND_ICON[k])}${V.KINDS[k].short}</button>`).join('')}</div>`);
    $('#sheetBody').onclick = e => { const b = e.target.closest('[data-kind]'); if (b) report(b.dataset.kind); };
  }

  // --- Ajustes ---
  function sw(key, label, sub) {
    return `<label class="opt"><span class="lbl">${label}${sub ? `<small>${sub}</small>` : ''}</span>
      <span class="switch"><input type="checkbox" id="set-${key}" data-set="${key}" ${S[key] ? 'checked' : ''}><span></span></span></label>`;
  }
  function sel(key, label, opts) {
    return `<label class="opt"><span class="lbl">${label}</span><select id="set-${key}" data-set="${key}">
      ${opts.map(([v, l]) => `<option value="${v}" ${String(S[key]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  }

  function openSettings() {
    openSheet('settings', 'Ajustes', `
      <div class="about">${ic('logo')}<div><b class="grad">Vigía</b><div class="fine">Radares · Rutas · Gasolineras</div></div></div>
      <div class="section-label">Asistente de voz y sonidos</div>
      <div class="group">
        ${sw('voiceGuide', 'Guía por voz', 'Te indica cada giro durante la ruta')}
        ${sw('radarVoice', 'Avisos de radar por voz')}
        ${sw('radarSound', 'Sonido de radar')}
        ${sw('maneuverSound', 'Sonido antes de girar')}
      </div>
      <div class="section-label">Avisos de radar</div>
      <div class="group">
        ${sw('alertFar', 'Avisar a 1 km')}
        ${sw('alertNear', 'Avisar a 500 m')}
        ${sw('speeding', 'Avisar si voy por encima del límite')}
        <div class="test">
          <button type="button" data-test="far">Probar 1 km</button>
          <button type="button" data-test="near">Probar 500 m</button>
          <button type="button" data-test="voice">Probar voz</button>
        </div>
      </div>
      <div class="section-label">Mapa</div>
      <div class="group">
        ${sel('layer', 'Mostrar', [['all', 'Todo'], ['radars', 'Solo radares'], ['gas', 'Solo gasolineras'], ['none', 'Solo mapa']])}
        ${sw('showGone', 'Ver radares retirados', 'En gris, los que ya no están')}
        ${sel('mapStyle', 'Estilo', [['dark', 'Oscuro'], ['light', 'Claro'], ['satellite', 'Satélite']])}
      </div>
      <div class="section-label">Rutas</div>
      <div class="group">
        ${sel('tolls', 'Peajes', [['avoid', 'Sin peajes'], ['any', 'Con peajes']])}
        ${sel('criterion', 'Ruta preferida', [['eco', 'Eco (gasta menos)'], ['shortest', 'Más corta'], ['fastest', 'Más rápida']])}
        ${sw('avoidMotorways', 'Evitar autopistas y autovías')}
      </div>
      <div class="section-label">Mi coche</div>
      <div class="group">
        ${sel('fuel', 'Combustible', V.FUELS.map(f => [f.key, f.label]))}
        <div class="opt"><span class="lbl">Consumo medio<small>Litros cada 100 km</small></span>
          <div class="stepper"><button type="button" data-step="-0.1" aria-label="Menos">−</button><b id="consVal">${fmt.liters(S.consumption)}</b><button type="button" data-step="0.1" aria-label="Más">+</button></div></div>
      </div>
      <div class="section-label">Datos</div>
      <div class="group">
        <div class="opt"><span class="lbl">Radares fijos<small>${esc(st.radarSource || 'Cargando…')}</small></span><b>${st.official.length}</b></div>
        <div class="opt"><span class="lbl">Avisos de conductores<small>${st.communityAt ? 'Actualizado ' + relTime(st.communityAt) : 'Cargando…'}</small></span><b>${allRadars().filter(r => r.source === 'community' && r.status !== 'gone').length}</b></div>
        <div class="opt"><span class="lbl">Gasolineras<small>${st.pricesAt ? 'Precios de las ' + st.pricesAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : 'Cargando…'}</small></span><b>${st.stations.length}</b></div>
      </div>
      <p class="fine">Mapa © OpenStreetMap y CARTO · Rutas: OSRM · Precios: Ministerio para la Transición Ecológica. Avisar de radares con una app es legal en España. Respeta siempre los límites.</p>`);
    const body = $('#sheetBody');
    body.onchange = e => {
      const k = e.target.dataset.set;
      if (!k) return;
      S[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      saveS();
      if (k === 'mapStyle') map.setStyle(STYLES[S.mapStyle]);
      if (k === 'layer') { renderChips(); drawRadars(); drawStations(); }
      if (k === 'showGone') drawRadars();
      if (k === 'fuel') { drawStations(); renderCheap(); }
      if (k === 'voiceGuide') renderVoiceBtn();
    };
    body.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.test === 'far') play('far');
      if (t.dataset.test === 'near') play('near');
      if (t.dataset.test === 'voice') say('Radar fijo a 500 metros. Límite 80', true);
      if (t.dataset.step) {
        S.consumption = Math.min(25, Math.max(2, Math.round((S.consumption + +t.dataset.step) * 10) / 10));
        saveS(); $('#consVal').textContent = fmt.liters(S.consumption);
      }
    };
  }

  // ---------- Botones ----------
  $('#searchBtn').addEventListener('click', openSearch);
  $('#clearBtn').addEventListener('click', () => clearRoute());
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#gasBtn').addEventListener('click', openGas);
  $('#reportBtn').addEventListener('click', openReport);
  $('#recenterBtn').addEventListener('click', () => {
    if (!fix) { toast('Todavía buscando tu ubicación…'); return; }
    setFollow(true);
  });
  $('#cheapPill').addEventListener('click', e => openStation(e.currentTarget.dataset.id));
  $('#voiceBtn').addEventListener('click', () => {
    S.voiceGuide = !S.voiceGuide; saveS(); renderVoiceBtn();
    if (!S.voiceGuide && 'speechSynthesis' in window) speechSynthesis.cancel();
    toast(S.voiceGuide ? 'Guía por voz activada' : 'Guía por voz silenciada');
  });
  $('#endBtn').addEventListener('click', endNav);
  $('#arrivedBtn').addEventListener('click', endNav);

  // ---------- Arranque ----------
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !standalone) $('#installHint').hidden = false;

  $('#startBtn').addEventListener('click', () => {
    unlockAudio();
    startCompass();
    startGPS();
    keepAwake();
    $('#start').classList.add('leaving');
    setTimeout(() => { $('#start').hidden = true; }, 500);
  });

  renderChips(); renderSearchBar(); renderSpeed(); setFollow(true);
  loadOfficialRadars();
  loadPrices();
  setInterval(() => loadPrices(), 10 * 60e3);        // precios: cada 10 min
  setInterval(pollCommunity, 45e3);                  // avisos de conductores: cada 45 s
  setInterval(drawRadars, 60e3);                     // el estado de los avisos cambia con el tiempo
})();
