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
    overpassList: ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'],
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
    // Voz: 'all' = indicaciones y radares · 'directions' = solo indicaciones · 'alerts' = solo radares · 'none' = nada
    voiceMode: 'all', silentOverride: true,
    voiceGuide: true, radarVoice: true, radarSound: true, maneuverSound: true,
    alertFar: true, alertNear: true, speeding: true,
    layer: 'all', showGone: true, mapStyle: 'dark',
    tolls: 'avoid', criterion: 'eco', avoidMotorways: false,
    fuel: 'g95', consumption: 6.5,
    meStyle: 'arrow', meColor: '#00E0C6', meSize: 'm', autoTrips: true, md_inc: true, md_cam: false, showLimit: true,
    // Qué se ve en el mapa (lo oculto tampoco avisa)
    sh_fixed: true, sh_section: true, sh_mobile: true, sh_light: true, sh_police: true, sh_gas: true,
  };
  const shown = kind => S['sh_' + kind] !== false;
  const S = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveS = () => store.set('settings', S);
  if (!('voiceMode' in store.get('settings', {}))) {   // ajustes antiguos → modo de voz
    const old = store.get('settings', {});
    const g = old.voiceGuide !== false, r = old.radarVoice !== false || old.radarSound !== false;
    S.voiceMode = g && r ? 'all' : g ? 'directions' : r ? 'alerts' : 'none';
  }
  const VOICE_MODES = {
    all: { label: 'Indicaciones y radares', icon: 'i-vol' },
    directions: { label: 'Solo indicaciones', icon: 'm-right' },
    alerts: { label: 'Solo avisos de radar', icon: 'i-camera' },
    none: { label: 'Sin voz ni sonidos', icon: 'i-mute' },
  };
  const wantDirections = () => S.voiceMode === 'all' || S.voiceMode === 'directions';
  const wantAlerts = () => S.voiceMode === 'all' || S.voiceMode === 'alerts';
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
  const alertable = () => allRadars().filter(r => r.status !== 'gone' && shown(r.kind));
  /** Solo se fía del sentido de un radar si viene de un aviso de conductor o de un tramo de la DGT. */
  const dirKnown = r => r.dir != null && (r.source === 'community' || r.origin === 'dgt');
  const roadCode = s => String(s || '').toUpperCase().replace(/\s+KM.*$/, '').replace(/[\s]/g, '');
  /** Radares de una ruta que te afectan: sobre el camino y en tu sentido de marcha.
   *  Las listas oficiales a veces sitúan el radar a 50-150 m de la línea de la ruta: si el
   *  radar es de la misma carretera que ese tramo de la ruta, también cuenta. */
  function routeRadars(route, includeHidden = false) {
    const line = route.line, spans = route.spans || [];
    const pool = includeHidden ? allRadars().filter(r => r.status !== 'gone') : alertable();
    return V.radarsOnLine(line, pool, 150).filter(x => {
      const r = x.radar;
      if (dirKnown(r) && V.angleDiff(r.dir, V.pointAt(line, x.along).bearing) > 60) return false;
      if (x.dist < 50) return true;
      const code = roadCode(r.road);
      if (!code) return false;
      let span = null;
      for (const sp of spans) { if (sp.along <= x.along + 1) span = sp; else break; }
      return !!(span && span.refs.includes(code));
    });
  }
  /** Los radares cambian (llega la lista, avisos nuevos, filtros): recalcula la ruta en curso y las tarjetas de rutas. */
  function refreshRouteRadars() {
    if (st.nav) st.nav.radarsOn = routeRadars(st.nav.route);
    if (st.routes && st.routes.length) renderPlanner();
  }
  /** Tramos de la ruta con su carretera (para saber por qué vía va cada parte). */
  function routeSpans(line, steps) {
    let hint = 0;
    return steps.map(s => {
      const [lon, lat] = s.maneuver.location;
      const p = V.project(line, lat, lon, hint); hint = p.idx;
      const refs = String(s.ref || '').split(/[;,]/).concat(String(s.name || '').split(/[;,]/)).map(roadCode).filter(Boolean);
      return { along: p.along, refs };
    });
  }
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

  /** En iPhone, con el interruptor de silencio puesto, Safari no suena (ni voz ni pitidos)
   *  salvo que la web pida el modo "reproducción". */
  function applyAudioSession() {
    try { if (navigator.audioSession) navigator.audioSession.type = S.silentOverride ? 'playback' : 'auto'; } catch { /* no soportado */ }
  }
  // iOS solo deja hablar/sonar si la primera vez ocurre al tocar la pantalla: se "desbloquea" en cada toque.
  function unlockAudio() {
    applyAudioSession();
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state !== 'running') audio.resume();
      const b = audio.createBuffer(1, 1, 22050), s = audio.createBufferSource();
      s.buffer = b; s.connect(audio.destination); s.start(0);
    } catch { audio = null; }
    if ('speechSynthesis' in window && !unlockAudio.voiceDone) {
      unlockAudio.voiceDone = true;
      const u = new SpeechSynthesisUtterance('.'); u.volume = 0.01; u.rate = 2; u.lang = 'es-ES';
      speechSynthesis.speak(u);
    }
  }
  addEventListener('touchend', () => { if (!audio || audio.state !== 'running') unlockAudio(); }, { passive: true });
  addEventListener('click', () => { if (!audio || audio.state !== 'running') unlockAudio(); });

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

  const speaking = [];   // Safari descarta frases si no se guarda una referencia hasta que acaban
  function say(text, priority = false) {
    if (!('speechSynthesis' in window) || !text) return;
    const ss = speechSynthesis;
    const go = () => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-ES'; if (esVoice) u.voice = esVoice;
      u.rate = 1.02; u.volume = 1;
      u.onend = u.onerror = () => { const i = speaking.indexOf(u); if (i >= 0) speaking.splice(i, 1); };
      speaking.push(u);
      if (ss.paused) ss.resume();
      ss.speak(u);
    };
    applyAudioSession();
    if (audio && audio.state !== 'running') audio.resume();
    // Cancelar y hablar en el mismo instante hace que Safari se coma la frase nueva.
    if (priority && (ss.speaking || ss.pending)) { ss.cancel(); setTimeout(go, 120); } else go();
  }

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); }
    catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake();
      // Al volver de segundo plano la voz de iOS a veces se queda atascada.
      if ('speechSynthesis' in window && !speaking.length) speechSynthesis.cancel();
      if (audio && audio.state !== 'running') audio.resume().catch(() => {});
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
    terrain: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  };
  // Satélite con nombres de calles y pueblos encima, para poder orientarse.
  STYLES.satellite.sources.satRoads = { type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'] };
  STYLES.satellite.sources.satLabels = { type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'] };
  STYLES.satellite.layers.push({ id: 'satRoads', type: 'raster', source: 'satRoads', paint: { 'raster-opacity': 0.75 } },
    { id: 'satLabels', type: 'raster', source: 'satLabels' });

  const lastView = store.get('view', { c: [-3.7, 40.3], z: 5.4 });
  const map = new maplibregl.Map({
    container: 'map', style: STYLES[S.mapStyle] || STYLES.dark,
    center: lastView.c, zoom: lastView.z, attributionControl: { compact: true },
    maxPitch: 65, fadeDuration: 0,
  });

  // ---------- Tipos de mapa y detalles ----------
  // Fuentes gratuitas y sin clave: relieve (Mapzen/AWS), edificios (OpenFreeMap), bici (CyclOSM), tren (OpenRailwayMap).
  const MAP_TYPES = [
    { k: 'dark', name: 'Noche' }, { k: 'light', name: 'Día' }, { k: 'satellite', name: 'Satélite' }, { k: 'terrain', name: 'Relieve' },
  ];
  const MAP_DETAILS = [
    { k: 'inc', name: 'Incidencias' }, { k: 'cam', name: 'Cámaras DGT' },
    { k: 'buildings', name: 'Edificios 3D' }, { k: 'bike', name: 'Carril bici' }, { k: 'rail', name: 'Tren y metro' },
  ];
  // Miniaturas propias de Vigía: paleta nocturna turquesa→azul del logo.
  const MAP_ART = {
    dark: `<rect width="64" height="64" fill="#0B1222"/><path d="M-4 50C14 46 18 30 34 28S54 14 70 8" stroke="#1E2A44" stroke-width="12" fill="none"/>
      <path d="M-4 50C14 46 18 30 34 28S54 14 70 8" stroke="url(#mt-g)" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M8 -4 22 70" stroke="#1E2A44" stroke-width="5"/><circle cx="50" cy="44" r="7" fill="#F2F6FF"/><circle cx="53" cy="41.5" r="6" fill="#0B1222"/>`,
    light: `<rect width="64" height="64" fill="#EAF1F7"/><rect x="36" y="34" width="24" height="26" rx="4" fill="#CFE9D9"/>
      <path d="M-4 50C14 46 18 30 34 28S54 14 70 8" stroke="#fff" stroke-width="12" fill="none"/>
      <path d="M-4 50C14 46 18 30 34 28S54 14 70 8" stroke="url(#mt-g)" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M8 -4 22 70" stroke="#fff" stroke-width="5"/><circle cx="48" cy="14" r="6" fill="#FFC83A"/>
      <g stroke="#FFC83A" stroke-width="2" stroke-linecap="round"><path d="M48 3.5v2.5M48 22v2.5M37.5 14H40M56 14h2.5"/></g>`,
    satellite: `<rect width="64" height="64" fill="#2E4A2C"/><path d="M0 0h30L22 26 0 34z" fill="#3C5E34"/><path d="M40 64 46 36 64 30v34z" fill="#6B6A3E"/>
      <path d="M30 0 64 22v8L28 8z" fill="#55703F"/><path d="M-4 52C16 44 24 36 36 30S56 26 70 18" stroke="#B9B2A2" stroke-width="5" fill="none"/>
      <g transform="translate(44 12) rotate(35)"><rect x="-3" y="-3" width="6" height="6" rx="1" fill="#F2F6FF"/><rect x="-12" y="-2" width="7" height="4" fill="#2F6EFF"/><rect x="5" y="-2" width="7" height="4" fill="#2F6EFF"/></g>
      <path d="M34 22a14 14 0 0 1 4-12" stroke="#00E0C6" stroke-width="1.6" fill="none" stroke-dasharray="2 2"/>`,
    terrain: `<rect width="64" height="64" fill="#EFE7D6"/><g fill="none" stroke-width="1.8">
      <path d="M8 40c6-18 30-26 42-12s-8 30-26 26S4 50 8 40z" stroke="#C9B48E"/><path d="M16 39c5-11 22-16 29-7s-6 19-17 16-14-3-12-9z" stroke="#B19A70"/>
      <path d="M24 38c3-6 12-8 15-3s-3 9-8 8-8-2-7-5z" stroke="#00B8A3"/></g>
      <path d="M44 6 56 22H32z" fill="#9C8763"/><path d="M44 6 48 11.5 44 10 40.5 12z" fill="#fff"/>`,
    inc: `<rect width="64" height="64" fill="#0B1222"/><path d="M-4 46C16 42 26 28 70 22" stroke="#1E2A44" stroke-width="12" fill="none"/>
      <path d="M-4 46C16 42 26 28 70 22" stroke="url(#mt-g)" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M32 12 47 38H17z" fill="#FF8A3D" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/><path d="M32 21v8M32 33v.5" stroke="#0B1222" stroke-width="3.2" stroke-linecap="round"/>`,
    cam: `<rect width="64" height="64" fill="#0B1222"/><path d="M-4 52C18 46 30 36 70 32" stroke="#1E2A44" stroke-width="12" fill="none"/>
      <path d="M14 10h4v26h-4z" fill="#55627F"/><rect x="18" y="12" width="26" height="15" rx="4" fill="url(#mt-g)"/><path d="M44 16l8-4v15l-8-4z" fill="#2F6EFF"/>
      <circle cx="28" cy="19.5" r="4.5" fill="#0B1222"/><circle cx="28" cy="19.5" r="1.8" fill="#8FF5E8"/><circle cx="50" cy="44" r="3" fill="#FF4554"/>`,
    buildings: `<rect width="64" height="64" fill="#0B1222"/><path d="M8 46 22 38l14 8-14 8z" fill="#1E2A44"/>
      <path d="M14 44V22l10-6 10 6v22l-10 6z" fill="#2F6EFF"/><path d="M24 50V28l10-6v22z" fill="#1D4DC4"/><path d="M14 22l10 6 10-6-10-6z" fill="#7FA6FF"/>
      <path d="M36 48V34l8-5 8 5v14l-8 5z" fill="#00E0C6"/><path d="M44 53V39l8-5v14z" fill="#00A792"/><path d="M36 34l8 5 8-5-8-5z" fill="#8FF5E8"/>`,
    bike: `<rect width="64" height="64" fill="#0B1222"/><path d="M-4 44C18 40 30 20 70 18" stroke="#1E2A44" stroke-width="12" fill="none"/>
      <path d="M-4 44C18 40 30 20 70 18" stroke="#34D873" stroke-width="3" fill="none" stroke-dasharray="5 4"/>
      <g fill="none" stroke="#F2F6FF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="22" cy="50" r="6"/><circle cx="42" cy="50" r="6"/>
      <path d="M22 50l7-11h10l3 11M29 39l5 11h8M36 35h5"/></g>`,
    rail: `<rect width="64" height="64" fill="#0B1222"/><g stroke="#3B4766" stroke-width="3"><path d="M12 6 24 62M28 2 40 58" transform="rotate(-8 32 32)"/></g>
      <g stroke="#55627F" stroke-width="2.4"><path d="M10 12h22M12 22h22M14 32h22M16 42h22M18 52h22" transform="rotate(-20 32 32)"/></g>
      <rect x="34" y="14" width="20" height="26" rx="7" fill="url(#mt-g)"/><rect x="38" y="19" width="12" height="7" rx="2" fill="#0B1222"/>
      <circle cx="39.5" cy="34" r="1.8" fill="#FFF6C8"/><circle cx="48.5" cy="34" r="1.8" fill="#FFF6C8"/>`,
  };
  const mapArt = k => `<svg viewBox="0 0 64 64"><defs><linearGradient id="mt-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00E0C6"/><stop offset="1" stop-color="#2F6EFF"/></linearGradient></defs>${MAP_ART[k]}</svg>`;
  function mapPickerHtml() {
    return `<div class="section-label">Tipo de mapa</div>
      <div class="map-tiles">${MAP_TYPES.map(t => `<button type="button" class="map-tile" data-maptype="${t.k}" aria-pressed="${S.mapStyle === t.k}">${mapArt(t.k)}<span>${t.name}</span></button>`).join('')}</div>
      <div class="section-label">Detalles del mapa</div>
      <div class="map-tiles">${MAP_DETAILS.map(d => `<button type="button" class="map-tile" data-mapdetail="${d.k}" aria-pressed="${!!S['md_' + d.k]}">${mapArt(d.k)}<span>${d.name}</span></button>`).join('')}</div>
      <p class="fine" style="margin:0">Los edificios 3D se ven al acercarte y con el mapa inclinado. Carril bici, tren y cámaras se ven mejor con zoom de ciudad. Incidencias y cámaras: DGT y Servei Català de Trànsit.</p>`;
  }
  /** Cambia tipo de mapa o detalles. Devuelve true si el clic era de aquí. */
  function onMapPickerClick(t) {
    if (t.dataset.maptype) { S.mapStyle = t.dataset.maptype; }
    else if (t.dataset.mapdetail) { const k = 'md_' + t.dataset.mapdetail; S[k] = S[k] === false ? true : !S[k]; }
    else return false;
    saveS();
    if (t.dataset.mapdetail === 'inc' || t.dataset.mapdetail === 'cam') {
      document.querySelectorAll('[data-mapdetail]').forEach(b => b.setAttribute('aria-pressed', S['md_' + b.dataset.mapdetail] !== false && !!S['md_' + b.dataset.mapdetail]));
      drawTraffic(); refreshRouteIncidents(); return true;
    }
    document.querySelectorAll('[data-maptype]').forEach(b => b.setAttribute('aria-pressed', b.dataset.maptype === S.mapStyle));
    document.querySelectorAll('[data-mapdetail]').forEach(b => b.setAttribute('aria-pressed', !!S['md_' + b.dataset.mapdetail]));
    map.setStyle(STYLES[S.mapStyle] || STYLES.dark, { diff: false });
    return true;
  }

  // Se ejecuta antes que el resto de capas de Vigía (rutas, radares, gasolineras), así quedan siempre debajo.
  function addMapDetails() {
    const layers = map.getStyle().layers || [];
    const firstLabel = (layers.find(l => l.type === 'symbol') || {}).id;
    const dark = S.mapStyle === 'dark' || S.mapStyle === 'satellite';
    try {
      if (S.mapStyle === 'terrain') {
        map.addSource('vg-dem', { type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], attribution: 'Relieve © Mapzen' });
        map.addLayer({ id: 'vg-hillshade', type: 'hillshade', source: 'vg-dem',
          paint: { 'hillshade-exaggeration': 0.6, 'hillshade-shadow-color': '#5A4A30', 'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#7A6A4A' } }, firstLabel);
      }
      if (S.md_bike) {
        map.addSource('vg-bike', { type: 'raster', tileSize: 256, maxzoom: 18, attribution: 'Bici © CyclOSM',
          tiles: ['a', 'b', 'c'].map(s => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm-lite/{z}/{x}/{y}.png`) });
        map.addLayer({ id: 'vg-bike', type: 'raster', source: 'vg-bike', minzoom: 11, paint: { 'raster-opacity': 0.9 } }, firstLabel);
      }
      if (S.md_rail) {
        map.addSource('vg-rail', { type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Tren © OpenRailwayMap',
          tiles: ['a', 'b', 'c'].map(s => `https://${s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png`) });
        map.addLayer({ id: 'vg-rail', type: 'raster', source: 'vg-rail', minzoom: 8, paint: { 'raster-opacity': 0.85 } }, firstLabel);
      }
      if (S.md_buildings) {
        map.addSource('vg-ofm', { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: 'Edificios © OpenFreeMap' });
        map.addLayer({ id: 'vg-buildings', type: 'fill-extrusion', source: 'vg-ofm', 'source-layer': 'building', minzoom: 14,
          paint: { 'fill-extrusion-color': dark ? '#26324F' : '#D8D2C6',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.85] } }, firstLabel);
      }
    } catch (e) { console.warn('Detalles del mapa', e); }
  }
  map.on('style.load', addMapDetails);

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
  // Ojo: mientras la cámara sigue a la flecha, MapLibre lanza 'moveend' en cada fotograma.
  // Por eso se agrupa (como mucho una vez cada 400 ms) en lugar de esperar a que pare.
  map.on('moveend', () => {
    if (moveTimer) return;
    moveTimer = setTimeout(() => {
      moveTimer = null;
      drawStations();
      const c = map.getCenter();
      store.set('view', { c: [c.lng, c.lat], z: map.getZoom() });
    }, 400);
  });

  function setSource(id, data) { const s = map.getSource(id); if (s) s.setData(data); }

  function drawRadars() {
    if (!map.getSource('radars')) return;
    const show = !!st.nav || S.layer === 'all' || S.layer === 'radars';
    let src = allRadars();
    if (st.nav) {
      const prog = st.nav.progress;
      src = st.nav.radarsOn.filter(x => x.along > prog - 30).map(x => x.radar);
    }
    const list = show ? src.filter(r => shown(r.kind) && (S.showGone || r.status !== 'gone')) : [];
    setSource('radars', { type: 'FeatureCollection', features: list.map(r => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { id: r.id, status: r.status, sort: r.status === 'gone' ? 0 : 1,
        icon: `rk:${r.kind}:${r.status}:${r.source === 'community' ? 'c' : 'o'}` },
    })) });
  }

  // Marcador de mi posición: varios iconos a elegir (todos miran hacia arriba = hacia donde vas).
  const ME_COLORS = [['#00E0C6', 'Turquesa'], ['#2F6EFF', 'Azul'], ['#9B6BFF', 'Morado'], ['#FF5CA8', 'Rosa'],
    ['#FF4554', 'Rojo'], ['#FF8A3D', 'Naranja'], ['#FFC83A', 'Amarillo'], ['#F2F6FF', 'Blanco']];
  const shade = (hex, f) => '#' + [1, 3, 5].map(i => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * f))).toString(16).padStart(2, '0')).join('');
  let meSeq = 0;
  const ME_STYLES = {
    // --- Básicos ---
    arrow: { name: 'Flecha', basic: true, svg: (c, id) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${shade(c, .55)}"/></linearGradient></defs>
      <circle cx="24" cy="24" r="20" fill="${c}" opacity=".18"/><path d="M24 8 35 36 24 30 13 36z" fill="url(#${id})" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>` },
    dot: { name: 'Punto', basic: true, svg: c => `<path d="M24 3 32 15Q24 11 16 15z" fill="${c}" opacity=".55"/><circle cx="24" cy="24" r="12" fill="${c}" opacity=".2"/>
      <circle cx="24" cy="24" r="8.5" fill="${c}" stroke="#fff" stroke-width="3"/>` },
    car: { name: 'Coche', basic: true, svg: c => `<rect x="14.5" y="7" width="19" height="34" rx="7.5" fill="${c}" stroke="#fff" stroke-width="2"/>
      <ellipse cx="13.6" cy="19" rx="2" ry="1.4" fill="${c}" stroke="#fff" stroke-width="1"/><ellipse cx="34.4" cy="19" rx="2" ry="1.4" fill="${c}" stroke="#fff" stroke-width="1"/>
      <path d="M17.2 17h13.6l-1.6 5.5H18.8z" fill="#0B1220" opacity=".78"/><rect x="18.6" y="23.5" width="10.8" height="9" rx="2.2" fill="#fff" opacity=".2"/>
      <path d="M18.5 34h11l-.8 3.6h-9.4z" fill="#0B1220" opacity=".7"/><circle cx="18.6" cy="9.6" r="1.4" fill="#FFF6C8"/><circle cx="29.4" cy="9.6" r="1.4" fill="#FFF6C8"/>` },
    // --- Únicos de Vigía ---
    beam: { name: 'Faro', svg: (c, id) => `<defs><linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${c}" stop-opacity=".75"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>
      <path class="me-beam" d="M24 24 9 1Q24-3 39 1z" fill="url(#${id})"/><circle cx="24" cy="24" r="10" fill="${c}" opacity=".25"/>
      <circle cx="24" cy="24" r="7" fill="#fff" stroke="${c}" stroke-width="4"/>` },
    comet: { name: 'Cometa', svg: (c, id) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".95"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>
      <radialGradient id="${id}h"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff"/><stop offset="1" stop-color="${c}"/></radialGradient></defs>
      <path class="me-tail" d="M24 18C16 28 18 38 24 47 30 38 32 28 24 18z" fill="url(#${id})"/>
      <circle cx="24" cy="18" r="11" fill="${c}" opacity=".25"/><circle cx="24" cy="18" r="7.5" fill="url(#${id}h)"/>
      <circle class="me-spark" cx="15" cy="30" r="1.3" fill="#fff"/><circle class="me-spark s2" cx="33" cy="34" r="1" fill="#fff"/>` },
    koi: { name: 'Koi', svg: c => `<g class="me-tailfin"><path d="M24 33C18 37 17 44 20.5 46.5 22.5 43 23.5 40 24 37.5 24.5 40 25.5 43 27.5 46.5 31 44 30 37 24 33z" fill="${c}" opacity=".85" stroke="#fff" stroke-width="1.2"/></g>
      <path d="M17 19 11 23 17.5 24zM31 19 37 23 30.5 24z" fill="${c}" opacity=".8"/>
      <path d="M24 5C31.5 9 31.5 24 27.5 31L24 36 20.5 31C16.5 24 16.5 9 24 5z" fill="${c}" stroke="#fff" stroke-width="2"/>
      <path d="M21 15c2-2 5-1.5 6 .5-1.5 2.5-4.5 3-6-.5zM22.5 24c1.5-1 3.5-.6 4 .8-1.2 1.6-3 1.6-4-.8z" fill="#fff" opacity=".85"/>
      <circle cx="21.4" cy="10.5" r="1.2" fill="#0B1220"/><circle cx="26.6" cy="10.5" r="1.2" fill="#0B1220"/>` },
    plane: { name: 'Avión de papel', svg: c => `<path d="M24 4 39 41 24 32z" fill="${shade(c, .7)}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
      <path d="M24 4 9 41 24 32z" fill="${c}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>` },
    rocket: { name: 'Cohete', svg: c => `<path class="me-flame" d="M20.5 38Q24 49 27.5 38z" fill="#FFB23D"/><path class="me-flame" d="M22.2 38Q24 44.5 25.8 38z" fill="#FFF3B0"/>
      <path d="M18 29 11.5 36.5 18.5 35zM30 29 36.5 36.5 29.5 35z" fill="${shade(c, .7)}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M24 3C30.5 10 31.5 21 29.5 33L27.5 38H20.5L18.5 33C16.5 21 17.5 10 24 3z" fill="${c}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="24" cy="17" r="3.6" fill="#0B1220" stroke="#fff" stroke-width="1.5"/>` },
  };
  const ME_SIZES = { s: 34, m: 44, l: 56 };
  const meSvg = (style, color) => `<svg viewBox="0 0 48 48" class="me-${style}">${(ME_STYLES[style] || ME_STYLES.arrow).svg(color, 'gme' + (++meSeq))}</svg>`;

  const meEl = document.createElement('div');
  meEl.className = 'me';
  function renderMe() {
    const style = ME_STYLES[S.meStyle] ? S.meStyle : 'arrow', color = S.meColor || '#00E0C6', size = ME_SIZES[S.meSize] || ME_SIZES.m;
    meEl.style.setProperty('--me', color);
    meEl.style.setProperty('--me-size', size + 'px');
    meEl.innerHTML = `<div class="halo"></div>${meSvg(style, color)}`;
    haloEl = meEl.querySelector('.halo');
    try { if (disp) updateHalo(); } catch { /* aún no hay posición */ }
  }
  let haloEl = null;
  renderMe();
  const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: 'map', pitchAlignment: 'map' });
  let meAdded = false;

  const destEl = document.createElement('div');
  destEl.className = 'dest-pin';
  destEl.innerHTML = ic('i-pin');
  const destMarker = new maplibregl.Marker({ element: destEl, anchor: 'bottom' });

  // ---------- Gasolineras en el mapa ----------
  // Todas las gasolineras de la zona visible como capas del mapa (rápido aunque haya miles):
  // de lejos, puntos de color; de cerca, etiqueta con el precio. Verde = barata, rojo = cara,
  // gris = no vende el combustible elegido.
  const BAND_COLOR = ['#34D873', '#FFC83A', '#FF6B4D', '#8A93A8'];
  function priceImage(id) {
    const [, band, price, trend] = id.split('|');
    const px = 2, fs = 12, h = 22, tipH = 6;
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    ctx.font = `800 ${fs}px -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif`;
    const tw = Math.ceil(ctx.measureText(price).width);
    const w = 8 + 12 + 3 + tw + (trend ? 11 : 0) + 8;
    c.width = w * px; c.height = (h + tipH) * px;
    ctx.scale(px, px);
    const color = BAND_COLOR[band] || BAND_COLOR[1];
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(10,15,28,.55)'; ctx.lineWidth = 1;
    const r = (h - 1) / 2;
    ctx.beginPath();
    ctx.moveTo(0.5 + r, 0.5); ctx.lineTo(w - 0.5 - r, 0.5);
    ctx.arc(w - 0.5 - r, 0.5 + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(0.5 + r, h - 0.5);
    ctx.arc(0.5 + r, 0.5 + r, r, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2 - 5, h - 1); ctx.lineTo(w / 2, h + tipH - 0.5); ctx.lineTo(w / 2 + 5, h - 1); ctx.fill();
    ctx.fillStyle = '#0A0F1C';
    ctx.save(); ctx.translate(8, 5); ctx.scale(0.5, 0.5);   // surtidor (24×24 → 12×12)
    ctx.fill(new Path2D('M4 3h9a1 1 0 0 1 1 1v16h1V12a1 1 0 0 1 1-1h1.5A2.5 2.5 0 0 1 20 13.5V18a1 1 0 0 0 2 0V8.4l-2.7-2.7 1.4-1.4L23 6.6V18a3 3 0 0 1-6 0v-5h-1v8H3V4a1 1 0 0 1 1-1zm2 2v5h5V5z'));
    ctx.restore();
    ctx.font = `800 ${fs}px -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(price, 23, h / 2 + 0.5);
    if (trend) {
      const x = 23 + tw + 6, y = h / 2;
      ctx.beginPath();
      if (trend === 'up') { ctx.moveTo(x - 4, y + 3); ctx.lineTo(x, y - 3); ctx.lineTo(x + 4, y + 3); }
      else { ctx.moveTo(x - 4, y - 3); ctx.lineTo(x, y + 3); ctx.lineTo(x + 4, y - 3); }
      ctx.fill();
    }
    const data = ctx.getImageData(0, 0, c.width, c.height);
    return { width: c.width, height: c.height, data: new Uint8Array(data.data.buffer) };
  }
  map.on('styleimagemissing', e => {
    if (e.id.startsWith('pz|') && !map.hasImage(e.id)) map.addImage(e.id, priceImage(e.id), { pixelRatio: 2 });
  });

  function addStationLayers() {
    if (map.getSource('stations')) return;
    map.addSource('stations', { type: 'geojson', data: EMPTY });
    drawStations.sig = null;
    const beforeRadars = map.getLayer('radars') ? 'radars' : undefined;
    map.addLayer({ id: 'stations-dot', type: 'circle', source: 'stations', minzoom: 8,
      paint: { 'circle-color': ['get', 'color'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 11, 4.5, 14, 6],
        'circle-stroke-color': '#0A0F1C', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 1.5],
        'circle-opacity': ['case', ['get', 'has'], 1, 0.7] } }, beforeRadars);
    map.addLayer({ id: 'stations-price', type: 'symbol', source: 'stations', minzoom: 11.5,
      filter: ['get', 'has'],
      layout: { 'icon-image': ['get', 'icon'], 'icon-anchor': 'bottom', 'icon-allow-overlap': false,
        'icon-padding': 1, 'symbol-sort-key': ['get', 'sort'] } }, beforeRadars);
    for (const l of ['stations-dot', 'stations-price']) {
      map.on('click', l, e => {
        const f = e.features && e.features[0];
        if (f && !(map.queryRenderedFeatures(e.point, { layers: ['radars'] }) || []).length) openStation(f.properties.id);
      });
      map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
    }
    drawStations();
  }
  map.on('style.load', addStationLayers);

  function drawStations() {
    if (!map.getSource('stations')) return;
    const show = (S.layer === 'all' || S.layer === 'gas') && shown('gas') && !st.nav && map.getZoom() >= 7.5;
    if (!show || !st.stations.length) {
      if (drawStations.sig !== '') { drawStations.sig = ''; setSource('stations', EMPTY); }
      return;
    }
    const b = map.getBounds();
    const padLat = (b.getNorth() - b.getSouth()) * 0.25, padLon = (b.getEast() - b.getWest()) * 0.25;
    const s0 = b.getSouth() - padLat, n0 = b.getNorth() + padLat, w0 = b.getWest() - padLon, e0 = b.getEast() + padLon;
    const inView = st.stations.filter(s => s.lat > s0 && s.lat < n0 && s.lon > w0 && s.lon < e0);
    const ps = inView.map(s => s.prices[S.fuel]).filter(p => p != null).sort((a, c) => a - c);
    const lo = ps[Math.floor(ps.length / 3)], hi = ps[Math.floor(ps.length * 2 / 3)];
    const features = inView.map(s => {
      const p = s.prices[S.fuel], has = p != null;
      const band = !has ? 3 : ps.length < 3 || lo === hi ? 1 : p <= lo ? 0 : p >= hi ? 2 : 1;
      const tr = has ? trendOf(s, S.fuel) : null;
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: { id: s.id, has, color: BAND_COLOR[band], sort: has ? Math.round(p * 1000) : 99999,
          icon: has ? `pz|${band}|${fmt.price(p)}|${tr || ''}` : '' } };
    });
    // Mientras sigues a la flecha esto se llama a menudo: solo se repinta si algo cambió.
    const sig = S.fuel + features.length + ':' + features.map(f => f.properties.id + f.properties.icon + f.properties.color).join(',');
    if (sig === drawStations.sig) return;
    drawStations.sig = sig;
    setSource('stations', { type: 'FeatureCollection', features });
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
      setTimeout(() => loadOverpassAround(lat, lon), 4000);
      pollCommunity();
      setTimeout(renderCheap, 50);
      const tryLive = () => (loadingPrices ? setTimeout(tryLive, 1500) : loadPrices(true));
      tryLive();
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
    Trips.onFix(lat, lon, acc, speed || 0, t);
    SpeedLimit.onFix(lat, lon);
    if (st.nav) checkNavIncidents();
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
        // Si vas en sentido contrario a la ruta (no has seguido la indicación), la flecha
        // muestra hacia dónde vas de verdad, no el sentido de la ruta.
        const against = v > 1.5 && st.heading != null && V.angleDiff(st.heading, pt.bearing) > 75;
        if (!against) return { lat: pt.lat, lon: pt.lon, bearing: pt.bearing };
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
      const c = map.getCenter();
      if (Math.abs(c.lat - disp.lat) > 1e-7 || Math.abs(c.lng - disp.lon) > 1e-7) {
        map.jumpTo({ center: [disp.lon, disp.lat], padding: noPadding });
      }
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
      const fileRadars = V.parseRadarsCompact(j);
      const extra = st.official.filter(r => r.id.startsWith('osm-'));
      st.official = fileRadars;
      addNearbyOsm(extra);
      st.radarSource = `${j.fuente || 'OpenStreetMap'} · ${new Date(j.actualizado).toLocaleDateString('es-ES')}`;
      drawRadars();
      refreshRouteRadars();
    } catch {
      if (st.pos) loadOverpassAround(st.pos.lat, st.pos.lon);
    }
  }

  /** Añade radares de OpenStreetMap que no estén ya en la lista oficial (a menos de 150 m). */
  function addNearbyOsm(list) {
    let added = 0;
    for (const r of list) {
      const dup = st.official.some(o => Math.abs(o.lat - r.lat) < 0.003 && Math.abs(o.lon - r.lon) < 0.004 &&
        V.haversine(o.lat, o.lon, r.lat, r.lon) < 150);
      if (!dup) { st.official.push(r); added++; }
    }
    return added;
  }

  // Radares recién añadidos a OpenStreetMap a tu alrededor (complementa el archivo oficial).
  const osmDone = [];
  async function loadOverpassAround(lat, lon) {
    if (osmDone.some(p => V.haversine(p.lat, p.lon, lat, lon) < 25000)) return;
    osmDone.push({ lat, lon });
    const q = `[out:json][timeout:25];node["highway"="speed_camera"](around:50000,${lat},${lon});out body;`;
    for (const base of CONFIG.overpassList) {
      try {
        const r = await fetchTimeout(`${base}?data=${encodeURIComponent(q)}`, 30000);
        if (!r.ok) continue;
        const j = await r.json();
        const list = (j.elements || []).map(e => ({
          id: 'osm-' + e.id, lat: e.lat, lon: e.lon, kind: 'fixed', source: 'official',
          limit: parseInt(e.tags && e.tags.maxspeed, 10) || null,
          dir: Number.isFinite(parseFloat(e.tags && e.tags.direction)) ? parseFloat(e.tags.direction) : null,
        }));
        const empty = !st.official.length;
        if (addNearbyOsm(list)) {
          if (empty) st.radarSource = 'OpenStreetMap (50 km a tu alrededor)';
          drawRadars();
          refreshRouteRadars();
        }
        return;
      } catch { /* probar el siguiente servidor */ }
    }
    osmDone.pop();
    if (!st.official.length) notice('No se pudieron cargar los radares fijos. Revisa la conexión.');
  }

  // ---------- Datos: avisos de la comunidad (ntfy) ----------
  async function pollCommunity() {
    try {
      const r = await fetchTimeout(`${CONFIG.ntfy}/${CONFIG.ntfyTopic}/json?poll=1&since=12h`, 15000);
      const text = await r.text();
      const msgs = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(m => m && m.event === 'message');
      st.community = V.communityFromMessages(msgs);
      st.cmsgs = msgs;
      st.communityAt = now();
      drawRadars();
      refreshRouteRadars();
      refreshOpenRadarDetail();
    } catch { /* sin conexión: se reintenta */ }
  }

  async function publish(payload) {
    if (S.nick && (payload.t === 'r' || payload.t === 'v')) payload = { ...payload, n: S.nick.slice(0, 20) };
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
        addMyStat('votes');
        toast(`${V.KINDS[kind].label} confirmado. ¡Gracias! +1 punto`);
      } else {
        const id = Math.random().toString(36).slice(2, 11);
        const b = st.heading != null && st.speed > 10 ? Math.round(st.heading) : undefined;
        await publish({ t: 'r', id, k: kind, la: +st.pos.lat.toFixed(6), lo: +st.pos.lon.toFixed(6), b, d: deviceId });
        addMyStat('reports');
        toast(`${V.KINDS[kind].label} avisado · +3 puntos`, { label: 'Deshacer', fn: () => deleteReport(id) });
      }
      setTimeout(pollCommunity, 800);
    } catch {
      toast('No se pudo enviar el aviso');
    }
  }

  /** Borra un aviso creado desde este móvil (los demás no pueden borrarlo). */
  async function deleteReport(id) {
    try {
      await publish({ t: 'x', id, d: deviceId });
      st.community = st.community.filter(r => r.id !== id);
      drawRadars();
      refreshRouteRadars();
      toast('Aviso borrado');
      setTimeout(pollCommunity, 800);
      return true;
    } catch {
      toast('No se pudo borrar. Revisa la conexión.');
      return false;
    }
  }

  async function vote(id, v) {
    try {
      await publish({ t: 'v', id, v, d: deviceId });
      if (v > 0) addMyStat('votes');
      toast(v > 0 ? 'Confirmado: sigue ahí' : 'Anotado: ya no está');
      closeSheet();
      setTimeout(pollCommunity, 800);
    } catch { toast('No se pudo enviar tu voto'); }
  }

  // ---------- Datos: precios ----------
  /** Mezcla precios nuevos con los que ya teníamos: si un precio cambia, guarda el anterior (flecha ↑/↓). */
  function mergeStations(fresh, replaceAll) {
    const old = new Map(st.stations.map(s => [s.id, s]));
    for (const s of fresh) {
      const o = old.get(s.id);
      if (!o) continue;
      s.prev = Object.assign({}, o.prev, s.prev);
      for (const k in s.prices) {
        if (o.prices[k] != null && Math.abs(o.prices[k] - s.prices[k]) > 0.0005) { s.prev[k] = o.prices[k]; s.changedAt = now(); }
      }
      if (!s.prov) s.prov = o.prov;
    }
    if (replaceAll) { st.stations = fresh; return; }
    const byId = new Map(fresh.map(s => [s.id, s]));
    st.stations = st.stations.map(s => byId.get(s.id) || s);
    const known = new Set(st.stations.map(s => s.id));
    for (const s of fresh) if (!known.has(s.id)) st.stations.push(s);
  }

  /** Provincia (código del Ministerio) de la gasolinera más cercana a un punto. */
  function provinceAt(lat, lon) {
    let best = null, bd = Infinity;
    for (const s of st.stations) {
      if (!s.prov || Math.abs(s.lat - lat) > 0.4 || Math.abs(s.lon - lon) > 0.5) continue;
      const d = V.haversine(lat, lon, s.lat, s.lon);
      if (d < bd) { bd = d; best = s.prov; }
    }
    return best;
  }

  /** Precios en directo del Ministerio para la provincia donde estás (o la del destino). */
  async function loadLivePrices() {
    const points = [];
    if (st.pos) points.push(st.pos);
    if (st.dest) points.push(st.dest);
    const provs = [...new Set(points.map(p => provinceAt(p.lat, p.lon)).filter(Boolean))];
    if (!provs.length) {
      // Aún no sabemos la provincia: pedimos la lista completa (más pesada) una sola vez.
      if (st.stations.length >= 8000 || !st.pos) return false;
      const r = await fetchTimeout(CONFIG.ministerio, 60000, { headers: { Accept: 'application/json' } });
      const j = await r.json();
      const fresh = V.parseMinisterio(j);
      if (fresh.length < 8000) return false;
      mergeStations(fresh, true);
      st.pricesAt = V.parseFecha(j.Fecha) || new Date();
      st.pricesLive = true;
      return true;
    }
    let ok = false;
    for (const prov of provs) {
      try {
        const r = await fetchTimeout(`${CONFIG.ministerio}FiltroProvincia/${prov}`, 30000, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        const fresh = V.parseMinisterio(j);
        if (!fresh.length) continue;
        mergeStations(fresh, false);
        const f = V.parseFecha(j.Fecha);
        if (f && (!st.pricesAt || f > st.pricesAt || !st.pricesLive)) st.pricesAt = f;
        st.pricesLive = true;
        ok = true;
      } catch { /* se reintenta en la próxima actualización */ }
    }
    return ok;
  }

  let loadingPrices = false;
  async function loadPrices(force = false) {
    if (loadingPrices) return;
    if (!force && st.pricesFetchedAt && now() - st.pricesFetchedAt < 9 * 60e3) return;
    loadingPrices = true;
    renderGasHeader();
    // 1) Lista de toda España (la prepara GitHub; puede tener algo de retraso).
    try {
      const r = await fetchTimeout('data/precios.json?v=' + Math.floor(now() / 60e3), 30000);
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const list = V.parsePricesCompact(j);
      if (list.length > st.stations.length * 0.8 || !st.stations.length) {
        mergeStations(list, true);
        const f = V.parseFecha(j.fecha_ministerio) || new Date(j.actualizado);
        if (!st.pricesLive || !st.pricesAt || f > st.pricesAt) st.pricesAt = f;
      }
    } catch { /* seguimos con los precios en directo */ }
    drawStations(); renderCheap(); refreshGasList();
    // 2) Precios en directo de tu provincia (siempre los últimos publicados).
    let live = false;
    try { live = await loadLivePrices(); } catch { live = false; }
    if (!st.stations.length) notice('No se pudieron descargar los precios de las gasolineras.');
    st.pricesSource = live ? 'directo' : 'archivo';
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
  async function osrm(from, to, exclude, heading) {
    const url = `${CONFIG.osrm}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
      `?overview=full&geometries=geojson&steps=true&alternatives=3${exclude ? '&exclude=' + exclude : ''}` +
      (heading != null ? `&bearings=${Math.round(heading) % 360},60;` : '');
    const r = await fetchTimeout(url, 25000);
    const j = await r.json();
    if (j.code !== 'Ok') throw new Error(j.code || 'error');
    return j.routes;
  }

  let routeSeq = 0;
  async function computeRoutes(from, to, heading = null) {
    const plain = S.avoidMotorways ? 'motorway' : null;
    const noToll = S.avoidMotorways ? 'motorway,toll' : 'toll';
    const res = await Promise.allSettled([osrm(from, to, plain, heading), osrm(from, to, noToll, heading)]);
    if (heading != null && res.every(x => x.status === 'rejected')) return computeRoutes(from, to, null);
    let raw = [];
    res.forEach(x => { if (x.status === 'fulfilled') raw = raw.concat(x.value); });
    if (res[1].status === 'rejected' && S.avoidMotorways) {
      try { raw = raw.concat(await osrm(from, to, 'toll')); } catch { /* sin alternativa */ }
    }
    if (!raw.length) throw new Error('NoRoute');
    const price = refPrice(from.lat, from.lon);
    const list = raw.map(rt => {
      const coords = rt.geometry.coordinates;
      const steps = rt.legs.flatMap(l => l.steps);
      const hasTolls = steps.some(s => (s.intersections || []).some(i => (i.classes || []).includes('toll')));
      const line = V.prepareLine(coords);
      const spans = routeSpans(line, steps);
      const liters = V.fuelLiters(rt.distance, rt.duration, S.consumption);
      return {
        id: 'r' + (++routeSeq), coords, line, spans, steps, hasTolls,
        distance: rt.distance, duration: rt.duration,
        via: rt.legs.map(l => l.summary).filter(Boolean).join(', '),
        liters, cost: liters * price, price,
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
      st.routes = await computeRoutes(from, st.dest, st.origin.current && st.speed > 8 ? st.heading : null);
      st.selectedId = visibleRoutes()[0]?.id || null;
      drawRoutes();
      const sel = selectedRoute(); if (sel) fitRoute(sel);
      setFollow(false);
      renderPlanner();
      annotateRoutes();
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
      const lanes = ((s.intersections || [])[0] || {}).lanes || null;
      return { ...V.instruction(s), along: p.along, length: s.distance, lanes };
    });
    return { route, line: route.line, steps, hint: 0, spoken: {}, off: 0, wrong: 0, rerouting: false, lastReroute: 0,
      arrived: false, progress: 0, radarsOn: routeRadars(route) };
  }

  function startNav() {
    setTimeout(drawParking, 0);
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
    setTimeout(() => {
      const f = refuelPlan(r), tips = [];
      if (f && !f.ok && f.best) tips.push(`Te conviene repostar en ${V.brandName(f.best.s.brand)}, en el kilómetro ${Math.round(f.best.along / 1000)} de la ruta, a ${fmt.price(f.best.p)} €/L.`);
      else if (f && f.none) tips.push('Ojo: no te llega la gasolina y no hay gasolineras en el camino. Reposta antes.');
      if (r.zbe && r.zbe.length) tips.push(`La ruta pasa por la zona de bajas emisiones de ${r.zbe[0]}. ${zbeAdvice()}`);
      if (tips.length) { notice(tips.join(' '), 12000); if (wantAlerts()) say(tips.join(' ')); }
    }, 4500);
    drawRoutes(); drawStations(); drawRadars();
    keepAwake();
    if (st.speed > 5 && st.heading != null) dispBearing = st.heading;   // hacia donde vas de verdad
    else if (st.pos) {
      // Parado: orienta la cámara en el sentido de la ruta.
      const p0 = V.project(st.nav.line, st.pos.lat, st.pos.lon);
      dispBearing = V.pointAt(st.nav.line, p0.along + 10).bearing;
    }
    setFollow(true);
    unlockAudio();
    const n = st.nav.radarsOn.length;
    const radarsTxt = n ? ` Hay ${n} radar${n === 1 ? '' : 'es'} en el camino.` : ' No hay radares en el camino.';
    if (wantDirections()) {
      say(`Iniciando ruta. ${spokenDur(r.duration)}, ${V.spokenDistance(r.distance)}.` + (wantAlerts() ? radarsTxt : ''));
    } else if (wantAlerts()) {
      say(radarsTxt.trim());
    }
    if (st.pos) updateNav(st.pos.lat, st.pos.lon);
  }

  const spokenDur = sec => fmt.dur(sec).replace(/(\d+) h (\d+) min/, (m, h, mi) => `${h} hora${h === '1' ? '' : 's'} y ${mi} minutos`).replace(/(\d+) min$/, '$1 minutos');

  function endNav() {
    st.nav = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    document.body.classList.remove('navigating');
    $('#maneuver').hidden = true; $('#navbar').hidden = true; $('#arrived').hidden = true;
    renderLanes(null);
    $('#topbar').hidden = false; $('#chips').hidden = false;
    $('#gasBtn').hidden = false; $('#voiceBtn').hidden = true;
    clearRoute();
    radarStages.clear();
    drawRadars();
    camZoom = null;
    setFollow(true);
    renderCheap();
    drawParking();
  }

  function updateNav(lat, lon) {
    const n = st.nav;
    if (!n || n.rerouting) return;
    const p = V.project(n.line, lat, lon, n.hint);
    n.hint = p.idx;
    n.progress = p.along;

    const tol = Math.max(40, st.acc * 1.5);
    n.off = p.dist > tol ? n.off + 1 : 0;
    // Sentido contrario: estás sobre la ruta pero vas al revés (p. ej. no se podía girar a la izquierda).
    const rb = V.pointAt(n.line, p.along).bearing;
    const wrongWay = st.speed > 8 && st.heading != null && V.angleDiff(st.heading, rb) > 110;
    n.wrong = wrongWay ? n.wrong + 1 : 0;
    if ((n.off >= 2 || n.wrong >= 3) && now() - n.lastReroute > 8000) { reroute(); return; }
    // Los radares ya pasados desaparecen del mapa
    if (now() - (n.radarDrawAt || 0) > 5000) { n.radarDrawAt = now(); drawRadars(); }

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
        renderLanes(null);
        if (wantDirections()) say('Has llegado a tu destino', true);
      }
      return;
    }

    const i = n.steps.findIndex((s, k) => k > 0 && s.along > p.along + 8);
    if (i < 0) return;
    const step = n.steps[i], d = step.along - p.along;
    setManeuver(step.icon, step.text, d);
    renderLanes(d < (st.speed > 75 ? 1500 : 800) ? step.lanes : null);
    const next = n.steps[i + 1];
    $('#thenBox').hidden = !(next && next.along - step.along < 250 && next.type !== 'arrive');
    if (next) $('#thenIcon').innerHTML = `<use href="#m-${next.icon}"/>`;
    announce(i, step, d);
  }

  // ---------- Carriles ----------
  // OSRM da, en cada cruce que lo tiene en OpenStreetMap, los carriles y cuáles sirven para la maniobra.
  const LANE_ICON = { straight: 'm-straight', none: 'm-straight', left: 'm-left', 'sharp left': 'm-left',
    right: 'm-right', 'sharp right': 'm-right', 'slight left': 'm-slight-left', 'slight right': 'm-slight-right', uturn: 'm-uturn' };
  function renderLanes(lanes) {
    const el = $('#lanes');
    const useful = lanes && lanes.length >= 2 && lanes.some(l => l.valid) && lanes.some(l => !l.valid);
    if (!useful) { if (!el.hidden) { el.hidden = true; el.dataset.k = ''; } return; }
    const k = JSON.stringify(lanes);
    if (el.dataset.k === k && !el.hidden) return;
    el.dataset.k = k;
    el.innerHTML = lanes.map(l => {
      const inds = (l.indications && l.indications.length ? l.indications : ['straight']);
      return `<div class="lane${l.valid ? ' ok' : ''}"><svg viewBox="0 0 48 48">${inds.map(x => `<use href="#${LANE_ICON[x] || 'm-straight'}"/>`).join('')}</svg></div>`;
    }).join('<span class="lane-sep"></span>');
    el.hidden = false;
  }
  /** "por el carril izquierdo", "por los 2 carriles de la derecha"… o '' si no aporta. */
  function laneHint(lanes) {
    if (!lanes || lanes.length < 2) return '';
    const ok = lanes.map(l => !!l.valid), n = ok.filter(Boolean).length, total = ok.length;
    if (!n || n === total) return '';
    const first = ok.indexOf(true), last = ok.lastIndexOf(true);
    if (last - first + 1 !== n) return '';
    const cnt = n === 1 ? 'por el carril' : `por los ${n} carriles`;
    if (first === 0) return n === 1 ? 'por el carril izquierdo' : `${cnt} de la izquierda`;
    if (last === total - 1) return n === 1 ? 'por el carril derecho' : `${cnt} de la derecha`;
    return n === 1 ? 'por el carril central' : `${cnt} centrales`;
  }

  function setManeuver(icon, text, d) {
    $('#maneuverIcon').innerHTML = `<use href="#m-${icon}"/>`;
    $('#maneuver .maneuver-icon').classList.toggle('spin', icon === 'reroute');
    $('#maneuverInstr').textContent = text;
    $('#maneuverDist').textContent = icon === 'flag' && !d ? 'Destino' : icon === 'reroute' ? 'Recalculando' : fmt.dist(d);
  }

  function announce(i, step, d) {
    if (!wantDirections() || step.type === 'arrive' && d > 300) return;
    const n = st.nav, fast = st.speed > 75;
    const farAt = fast ? 2000 : 800, midAt = fast ? 700 : 250, nowAt = Math.max(40, st.speed / 3.6 * 4);
    const done = n.spoken[i] || (n.spoken[i] = new Set());
    const lanes = laneHint(step.lanes);
    const lower = step.text.charAt(0).toLowerCase() + step.text.slice(1) + (lanes ? `, ${lanes}` : '');
    if (d <= nowAt && !done.has(2)) {
      [0, 1, 2].forEach(x => done.add(x));
      if (S.maneuverSound) play('maneuver');
      say(step.text + (lanes && d > 60 ? `, ${lanes}` : ''));
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
    renderLanes(null);
    if (wantDirections()) say('Recalculando ruta', true);
    try {
      st.routes = await computeRoutes(st.pos, st.dest, st.speed > 5 ? st.heading : null);
      const best = visibleRoutes()[0];
      if (best && st.nav) {
        st.selectedId = best.id;
        st.nav = prepareNav(best);
        drawRoutes(); drawRadars();
        if (wantDirections()) say(`Nueva ruta. ${spokenDur(best.duration)} hasta el destino.`);
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
          if (dirKnown(r) && V.angleDiff(h, r.dir) > 60) continue;
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
      if (S.alertNear && wantAlerts()) {
        if (S.radarSound) play('near');
        if (S.radarVoice) setTimeout(() => say(`${label} a 500 metros${limitTxt}`, true), S.radarSound ? 650 : 0);
        if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
      }
    } else if (d <= 1050 && d > 620 && !done.has(1)) {
      done.add(1);
      if (S.alertFar && wantAlerts()) {
        if (S.radarSound) play('far');
        if (S.radarVoice) setTimeout(() => say(`${label} a ${V.spokenDistance(Math.max(600, Math.round(d / 100) * 100))}${limitTxt}`), S.radarSound ? 900 : 0);
        if (navigator.vibrate) navigator.vibrate(100);
      }
    }
    if (S.speeding && r.limit && d < 450 && st.speed > r.limit + 3 && !done.has(3)) {
      done.add(3);
      if (wantAlerts()) { if (S.radarVoice) say('Reduce la velocidad', true); else if (S.radarSound) play('near'); }
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
  const TYPES = ['fixed', 'section', 'mobile', 'light', 'police', 'gas'];
  function renderChips() {
    const hidden = TYPES.filter(k => !shown(k)).length;
    $('#chips').innerHTML =
      `<button class="chip chip-filter" type="button" data-open="layers">${ic('i-sliders')}Filtrar${hidden ? `<span class="count">${hidden}</span>` : ''}</button>` +
      LAYERS.map(l =>
        `<button class="chip" role="tab" type="button" data-layer="${l.k}" aria-selected="${S.layer === l.k}">${ic(l.icon)}${l.label}</button>`).join('') +
      `<button class="chip" type="button" data-open="group">${ic('i-me')}Juntos</button>`;
  }
  $('#chips').addEventListener('click', e => {
    if (e.target.closest('[data-open="layers"]')) { openLayers(); return; }
    if (e.target.closest('[data-open="group"]')) { openGroup(); return; }
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
    const lim = (currentRadar && currentRadar.r.limit) || streetLimit();
    return !!(lim && st.speed > lim + 2);
  }

  function renderSpeed() {
    const v = Math.round(st.speed);
    $('#speedVal').textContent = v;
    $('#speedArc').style.strokeDasharray = `${(76 * Math.min(v / 160, 1)).toFixed(1)} 100`;
    const lim = (currentRadar && currentRadar.r.limit) || streetLimit();
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
    if (st.nav || !st.pos || !st.stations.length || !shown('gas')) { el.hidden = true; return; }
    const near = nearbyStations(st.pos.lat, st.pos.lon, 5000, S.fuel);
    if (!near.length) { el.hidden = true; return; }
    const best = near.reduce((a, b) => b.s.prices[S.fuel] < a.s.prices[S.fuel] ? b : a);
    const f = V.FUELS.find(x => x.key === S.fuel);
    el.hidden = false;
    el.dataset.id = best.s.id;
    el.innerHTML = `${ic('i-fuel')}<span><small>${f.short} más barata cerca</small><b>${fmt.price(best.s.prices[S.fuel])} € · ${fmt.dist(best.d)}</b></span>`;
  }

  function renderVoiceBtn() {
    const b = $('#voiceBtn'), m = VOICE_MODES[S.voiceMode] || VOICE_MODES.all;
    b.innerHTML = ic(m.icon);
    b.classList.toggle('off', S.voiceMode === 'none');
    b.setAttribute('aria-label', 'Voz: ' + m.label);
  }

  let toastTimer = null;
  function toast(msg, action) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : '');
    if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.fn(); };
    t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2400);
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
    $('#sheet').classList.toggle('full', kind === 'search' || kind === 'settings' || kind === 'car');
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
    const rc = r => { const all = routeRadars(r, true).length; return { all, hidden: all - routeRadars(r).length }; };
    html += vis.map((r, i) => { const n = rc(r); return `
      <button class="rcard ${sel && r.id === sel.id ? 'sel' : ''}" type="button" data-route="${r.id}">
        <div class="top"><span class="time">${fmt.dur(r.duration)}</span><span class="km">${fmt.dist(r.distance)}</span>
          ${i === 0 ? `<span class="best-tag">${ic(crit.icon)}${crit.best}</span>` : ''}</div>
        ${r.via ? `<div class="via">Por ${esc(r.via)}</div>` : ''}
        <div class="pills">
          <span class="pill" style="--c:var(--cheap)">${ic('i-fuel')}${fmt.liters(r.liters)} · ${fmt.eur(r.cost)}</span>
          <span class="pill" style="--c:${n.all ? 'var(--red)' : 'var(--muted)'}">${ic('i-camera')}${n.all} radar${n.all === 1 ? '' : 'es'}${n.hidden ? ` · ${n.hidden} oculto${n.hidden === 1 ? '' : 's'}` : ''}</span>
          <span class="pill" style="--c:${r.hasTolls ? 'var(--mid)' : 'var(--teal)'}">${ic(r.hasTolls ? 'i-euro' : 'i-check')}${r.hasTolls ? `Peaje ~${fmt.eur(tollEstimate(r))}` : 'Sin peaje'}</span>
        </div>
      </button>`; }).join('');
    if (sel) {
      html += incidentsLine(sel) + refuelLine(sel) + zbeLine(sel);
      html += `<button class="btn-grad" type="button" data-act="go">${ic('i-locate')}Iniciar navegación</button>`;
      if (Group.code) html += `<button class="btn-ghost" type="button" data-act="sendgroup">Enviar este destino al grupo</button>`;
      html += `<p class="fine">Consumo estimado con ${fmt.liters(S.consumption)}/100 km y ${V.FUELS.find(f => f.key === S.fuel).label} a ${fmt.price(sel.price)} €/L (media de las gasolineras más baratas cerca). El peaje es una estimación por km.</p>`;
    }
    $('#plannerBody').innerHTML = html;
  }

  $('#plannerBody').addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.act === 'close') { closePlanner(true); return; }
    if (t.dataset.act === 'retry') { planRoute(); return; }
    if (t.dataset.act === 'go') { startNav(); return; }
    if (t.dataset.station) { openStation(t.dataset.station); return; }
    if (t.dataset.inc) { openIncident(t.dataset.inc); return; }
    if (t.dataset.act === 'sendgroup' && st.dest) { Group.send({ t: 'dest', name: st.dest.name, sub: st.dest.sub || '', la: st.dest.lat, lo: st.dest.lon }); toast('Destino enviado al grupo'); return; }
    if (t.dataset.toll) { S.tolls = t.dataset.toll; saveS(); st.selectedId = visibleRoutes()[0]?.id; }
    if (t.dataset.crit) { S.criterion = t.dataset.crit; saveS(); st.selectedId = visibleRoutes()[0]?.id; }
    if (t.dataset.route) st.selectedId = t.dataset.route;
    drawRoutes(); renderPlanner(); annotateRoutes();
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

  function pricesTimeText() {
    const d = st.pricesAt;
    const t = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    return new Date().toDateString() === d.toDateString() ? `hoy a las ${t}` : `${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} a las ${t}`;
  }

  function renderGasHeader() {
    const el = $('#gasUpdated');
    if (!el) return;
    if (loadingPrices) { el.textContent = 'Actualizando precios…'; return; }
    el.textContent = st.pricesAt
      ? `Precios del Ministerio de ${pricesTimeText()}${st.pricesSource === 'directo' ? ' · en directo' : ''} · se actualizan solos`
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
        ${st.pricesAt ? `<div>${ic('i-refresh')}Precios del Ministerio de ${pricesTimeText()}</div>` : ''}</div>
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
    if (m >= 2880) return `hace ${Math.round(m / 1440)} días`;
    if (m >= 1440) return 'hace 1 día';
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
      if (r.reporter === deviceId) {
        html += `<p class="fine" style="color:var(--teal);margin:0">Este aviso lo creaste tú.</p>
          <button class="btn-danger" type="button" data-del="${esc(r.id)}">${ic('i-x')}Borrar mi aviso</button>`;
      } else if (r.voters.includes(deviceId)) {
        html += `<p class="fine" style="color:var(--teal)">Ya has votado este aviso. Gracias.</p>`;
      } else {
        html += `<div class="btns"><button class="btn-grad" type="button" data-vote="1">${ic('i-thumb-up')}Sigue ahí</button>
          <button class="btn-soft" type="button" data-vote="-1">${ic('i-thumb-down')}Ya no está</button></div>`;
      }
    } else {
      html += `<div class="facts"><div>${ic('i-check')}Siempre se avisa a 1 km y a 500 m.</div>
        ${r.dir != null ? `<div>${ic('i-locate')}Controla el sentido ${Math.round(r.dir)}°</div>` : ''}
        ${r.road ? `<div>${ic('i-pin')}Carretera ${esc(r.road)}</div>` : ''}
        <div>${ic('i-map')}Fuente: ${({ dgt: 'DGT (lista oficial)', sct: 'Servei Català de Trànsit (lista oficial)' })[r.origin] || 'OpenStreetMap'}</div></div>`;
    }
    return html;
  }

  function openRadarDetail(id) {
    const r = findRadar(id);
    if (!r) return;
    openSheet('radar', '', radarDetailHtml(r), id);
    $('#sheetBody').onclick = async e => {
      const b = e.target.closest('[data-vote]'); if (b) vote(r.id, +b.dataset.vote);
      const d = e.target.closest('[data-del]'); if (d && await deleteReport(d.dataset.del)) closeSheet();
    };
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
      <div class="tiles">${kinds.map(k => `<button class="tile" type="button" data-kind="${k}" style="--c:${V.KINDS[k].color}">${ic(KIND_ICON[k])}${V.KINDS[k].short}</button>`).join('')}</div>
      ${myReportsHtml()}
      ${levelHtml()}`);
    $('#sheetBody').onclick = async e => {
      if (e.target.closest('[data-act="ranking"]')) { openRanking(); return; }
      const b = e.target.closest('[data-kind]'); if (b) { report(b.dataset.kind); return; }
      const d = e.target.closest('[data-del]');
      if (d) { d.disabled = true; if (await deleteReport(d.dataset.del)) openReport(); else d.disabled = false; }
    };
  }

  function myReportsHtml() {
    const mine = allRadars().filter(r => r.source === 'community' && r.reporter === deviceId && r.status !== 'gone')
      .sort((a, b) => b.created - a.created);
    if (!mine.length) return '';
    return `<div class="section-label">Tus avisos</div><div class="list">` + mine.map(r => {
      const d = st.pos ? ' · a ' + fmt.dist(V.haversine(st.pos.lat, st.pos.lon, r.lat, r.lon)) : '';
      return `<div class="item"><span class="ic" style="background:${V.KINDS[r.kind].color};color:#fff">${ic(KIND_ICON[r.kind])}</span>
        <span class="tx"><div class="t1">${V.KINDS[r.kind].label}</div><div class="t2">${relTime(r.created)}${d}</div></span>
        <button class="del-btn" type="button" data-del="${esc(r.id)}">Borrar</button></div>`;
    }).join('') + `</div>`;
  }

  // --- Qué se ve en el mapa ---
  const PLURAL = { fixed: 'Radares fijos', section: 'Radares de tramo', mobile: 'Radares móviles',
    light: 'Cámaras de semáforo', police: 'Controles policiales', gas: 'Gasolineras' };
  function typeRows() {
    const counts = {};
    for (const r of allRadars()) if (r.status !== 'gone') counts[r.kind] = (counts[r.kind] || 0) + 1;
    return TYPES.map(k => {
      const isGas = k === 'gas';
      const color = isGas ? 'var(--cheap)' : V.KINDS[k].color;
      const n = isGas ? st.stations.length : (counts[k] || 0);
      const sub = isGas ? `${n} con precio` : `${n} en total`;
      return `<label class="opt"><span class="type-ic" style="background:${color}">${ic(isGas ? 'i-fuel' : KIND_ICON[k])}</span>
        <span class="lbl">${PLURAL[k]}<small>${sub}</small></span>
        <span class="switch"><input type="checkbox" id="set-sh_${k}" data-set="sh_${k}" ${shown(k) ? 'checked' : ''}><span></span></span></label>`;
    }).join('');
  }

  function openLayers() {
    openSheet('layers', 'Qué ver en el mapa', `
      ${mapPickerHtml()}
      <div class="section-label">Radares y gasolineras</div>
      <div class="group">${typeRows()}</div>
      <p class="fine" style="margin:0">Lo que ocultes tampoco te avisará. Los radares que hayas ocultado se pueden volver a mostrar aquí o en Ajustes.</p>
      <div class="btns"><button class="btn-soft" type="button" data-all="1">Mostrar todo</button></div>`);
    const body = $('#sheetBody');
    body.onchange = onSettingChange;
    body.onclick = e => {
      const t = e.target.closest('button');
      if (t && onMapPickerClick(t)) return;
      if (!e.target.closest('[data-all]')) return;
      TYPES.forEach(k => { S['sh_' + k] = true; });
      saveS(); applyVisibility(); openLayers();
    };
  }

  function applyVisibility() {
    renderChips(); drawRadars(); drawStations(); renderCheap();
    currentRadar = null; renderBanner();
    refreshRouteRadars();
  }

  function onSettingChange(e) {
    const k = e.target.dataset.set;
    if (!k) return;
    S[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    saveS();
    if (k.startsWith('sh_')) applyVisibility();
    if (k === 'layer') { renderChips(); drawRadars(); drawStations(); }
    if (k === 'showGone') drawRadars();
    if (k === 'fuel') { car.profile.fuel = S.fuel; saveCar(); drawStations(); renderCheap(); }
    if (k === 'silentOverride') applyAudioSession();
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

  function meTiles(basic) {
    return Object.entries(ME_STYLES).filter(([, m]) => !!m.basic === basic).map(([k, m]) =>
      `<button type="button" class="me-tile" data-me="${k}" aria-pressed="${S.meStyle === k}">${meSvg(k, S.meColor)}<span>${m.name}</span></button>`).join('');
  }
  function openSettings() {
    openSheet('settings', 'Ajustes', `
      <div class="about">${ic('logo')}<div><b class="grad">Vigía</b><div class="fine">Radares · Rutas · Gasolineras</div></div></div>
      <div class="section-label">Asistente de voz y sonidos</div>
      <div class="group">
        <div class="opt col"><span class="lbl">Qué quieres oír</span>
          <div class="seg seg-4" id="voiceSeg">${Object.entries(VOICE_MODES).map(([k, m]) =>
            `<button type="button" data-voice="${k}" aria-pressed="${S.voiceMode === k}">${ic(m.icon)}<span>${{ all: 'Ambas', directions: 'Indicaciones', alerts: 'Radares', none: 'Nada' }[k]}</span></button>`).join('')}</div>
          <small class="fine" id="voiceDesc">${VOICE_MODES[S.voiceMode].label}</small></div>
        ${sw('radarVoice', 'Decir el radar en voz alta', 'Ej.: «Radar fijo a 500 metros. Límite 80»')}
        ${sw('radarSound', 'Pitido de radar')}
        ${sw('maneuverSound', 'Pitido antes de girar')}
        ${isIOS ? sw('silentOverride', 'Sonar con el iPhone en silencio', 'Si no, con el botón de silencio no se oye nada. Puede pausar tu música mientras habla') : ''}
      </div>
      <div class="section-label">Avisos de radar</div>
      <div class="group">
        ${sw('alertFar', 'Avisar a 1 km')}
        ${sw('alertNear', 'Avisar a 500 m')}
        ${sw('speeding', 'Avisar si voy por encima del límite')}
        ${sw('showLimit', 'Ver el límite de cada calle', 'Junto a tu velocidad. Se pone en rojo si lo pasas')}
        <div class="test">
          <button type="button" data-test="far">Probar 1 km</button>
          <button type="button" data-test="near">Probar 500 m</button>
          <button type="button" data-test="voice">Probar voz</button>
        </div>
      </div>
      <div class="section-label">Qué ver en el mapa</div>
      <div class="group">${typeRows()}</div>
      <div class="section-label">Mapa</div>
      <div class="group">
        ${sel('layer', 'Mostrar', [['all', 'Todo'], ['radars', 'Solo radares'], ['gas', 'Solo gasolineras'], ['none', 'Solo mapa']])}
        ${sw('showGone', 'Ver radares retirados', 'En gris, los que ya no están')}
      </div>
      <div class="map-pick">${mapPickerHtml()}</div>
      <div class="section-label">Tu icono en el mapa</div>
      <div class="group me-pick">
        <div class="opt col"><span class="lbl">Básicos</span><div class="me-grid" id="meGrid1">${meTiles(true)}</div></div>
        <div class="opt col"><span class="lbl">Solo en Vigía</span><div class="me-grid" id="meGrid2">${meTiles(false)}</div></div>
        <div class="opt col"><span class="lbl">Color</span><div class="me-colors">${ME_COLORS.map(([c, n]) => `<button type="button" data-mecolor="${c}" aria-label="${n}" aria-pressed="${S.meColor === c}" style="--c:${c}"></button>`).join('')}</div></div>
        <div class="opt col"><span class="lbl">Tamaño</span><div class="seg" id="meSizeSeg">${[['s', 'Pequeño'], ['m', 'Normal'], ['l', 'Grande']].map(([k, l]) => `<button type="button" data-mesize="${k}" aria-pressed="${S.meSize === k}">${l}</button>`).join('')}</div></div>
      </div>
      <div class="section-label">Comunidad</div>
      <div class="group">
        <button type="button" class="opt car-row" data-act="group">${ic('i-me')}<span class="lbl">Viajar juntos y modo copiloto<small>${Group.code ? 'Estás en un grupo' : 'Ved dónde está cada uno y mandaos destinos'}</small></span><span class="chev">›</span></button>
        <button type="button" class="opt car-row" data-act="ranking">${ic('i-alert')}<span class="lbl">Avisadores<small>Tu nivel: ${levelOf(myPoints()).L[1]} · ranking de hoy</small></span><span class="chev">›</span></button>
      </div>
      <div class="section-label">Rutas</div>
      <div class="group">
        ${sel('tolls', 'Peajes', [['avoid', 'Sin peajes'], ['any', 'Con peajes']])}
        ${sel('criterion', 'Ruta preferida', [['eco', 'Eco (gasta menos)'], ['shortest', 'Más corta'], ['fastest', 'Más rápida']])}
        ${sw('avoidMotorways', 'Evitar autopistas y autovías')}
      </div>
      <div class="section-label">Mi coche</div>
      <div class="group">
        <button type="button" class="opt car-row" data-act="car">${ic('i-car')}<span class="lbl">${esc(carName())}<small>${esc(carSub())} · revisiones, gasolina y papeles</small></span><span class="chev">›</span></button>
        ${sel('fuel', 'Combustible', V.FUELS.map(f => [f.key, f.label]))}
        <div class="opt"><span class="lbl">Consumo medio<small>Litros cada 100 km</small></span>
          <div class="stepper"><button type="button" data-step="-0.1" aria-label="Menos">−</button><b id="consVal">${fmt.liters(S.consumption)}</b><button type="button" data-step="0.1" aria-label="Más">+</button></div></div>
      </div>
      <div class="section-label">Datos</div>
      <div class="group">
        <div class="opt"><span class="lbl">Radares fijos<small>${esc(st.radarSource || 'Cargando…')}</small></span><b>${st.official.length}</b></div>
        <div class="opt"><span class="lbl">Avisos de conductores<small>${st.communityAt ? 'Actualizado ' + relTime(st.communityAt) : 'Cargando…'}</small></span><b>${allRadars().filter(r => r.source === 'community' && r.status !== 'gone').length}</b></div>
        <div class="opt"><span class="lbl">Gasolineras<small>${st.pricesAt ? 'Precios de ' + pricesTimeText() : 'Cargando…'}</small></span><b>${st.stations.length}</b></div>
      </div>
      <p class="fine">Mapa © OpenStreetMap y CARTO · Rutas: OSRM · Precios: Ministerio para la Transición Ecológica. Avisar de radares con una app es legal en España. Respeta siempre los límites.</p>`);
    const body = $('#sheetBody');
    body.onchange = onSettingChange;
    body.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.act === 'car') return openCar();
      if (onMapPickerClick(t)) return;
      if (t.dataset.act === 'group') return openGroup();
      if (t.dataset.act === 'ranking') return openRanking();
      if (t.dataset.me || t.dataset.mecolor || t.dataset.mesize) {
        if (t.dataset.me) S.meStyle = t.dataset.me;
        if (t.dataset.mecolor) S.meColor = t.dataset.mecolor;
        if (t.dataset.mesize) S.meSize = t.dataset.mesize;
        saveS(); renderMe();
        $('#meGrid1').innerHTML = meTiles(true); $('#meGrid2').innerHTML = meTiles(false);
        document.querySelectorAll('[data-mecolor]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mecolor === S.meColor));
        document.querySelectorAll('[data-mesize]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mesize === S.meSize));
        return;
      }
      if (t.dataset.test === 'far') play('far');
      if (t.dataset.test === 'near') play('near');
      if (t.dataset.test === 'voice') { unlockAudio(); say('En 300 metros, toma la salida hacia Manresa. Radar fijo a 500 metros. Límite 80', true); }
      if (t.dataset.voice) {
        S.voiceMode = t.dataset.voice; saveS(); renderVoiceBtn();
        setPressed('#voiceSeg', t);
        $('#voiceDesc').textContent = VOICE_MODES[S.voiceMode].label;
        if ('speechSynthesis' in window) speechSynthesis.cancel();
      }
      if (t.dataset.step) {
        S.consumption = Math.min(25, Math.max(2, Math.round((S.consumption + +t.dataset.step) * 10) / 10));
        saveS(); $('#consVal').textContent = fmt.liters(S.consumption);
      }
    };
  }

  // ---------- Mi coche ----------
  // Ficha editable (marca, modelo, año…). Por defecto, el Peugeot 206 1.4 de 2002.
  // Intervalos de mantenimiento orientativos: si el taller o el libro del coche dicen otra cosa, manda eso.
  const CAR_DEFAULT = {
    brand: 'Peugeot', model: '206', year: 2002, version: '1.4 75 CV', cc: 1360, hp: 75,
    fuel: 'g95', tank: 50, consumption: 6.8, plate: '3856CCG', label: 'B', oil: 'Unos 3 L con filtro · 10W-40 o 5W-40',
  };
  const BRANDS = ['Abarth', 'Alfa Romeo', 'Audi', 'BMW', 'BYD', 'Citroën', 'Cupra', 'Dacia', 'DS', 'Fiat', 'Ford', 'Honda', 'Hyundai',
    'Jaguar', 'Jeep', 'Kia', 'Land Rover', 'Lexus', 'Mazda', 'Mercedes-Benz', 'MG', 'Mini', 'Mitsubishi', 'Nissan', 'Opel', 'Peugeot',
    'Porsche', 'Renault', 'Seat', 'Škoda', 'Smart', 'SsangYong', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo'];
  const LABELS = [['0', '0 (azul)'], ['ECO', 'ECO'], ['C', 'C (verde)'], ['B', 'B (amarilla)'], ['none', 'Sin etiqueta']];
  const DGT = {
    label: p => `https://sede.dgt.gob.es/es/vehiculos/informacion-de-vehiculos/distintivo-ambiental/index.html?matricula=${encodeURIComponent(p)}`,
    report: 'https://sede.dgt.gob.es/es/vehiculos/informacion-de-vehiculos/informe-de-un-vehiculo/',
  };

  const car = Object.assign({ km: null, maint: {}, docs: {}, fills: [], itvs: [], reports: [], tab: 'maint', applied: false }, store.get('car', {}));
  car.profile = Object.assign({}, CAR_DEFAULT, car.profile || {});
  car.itvs = car.itvs || []; car.reports = car.reports || [];
  const saveCar = () => store.set('car', car);
  const P = () => car.profile;
  const isDiesel = () => P().fuel.startsWith('diesel');
  const fuelLabel = k => (V.FUELS.find(f => f.key === k) || {}).label || k;
  const carName = () => [P().brand, P().model].filter(Boolean).join(' ') || 'Mi coche';
  const carSub = () => [P().version, P().year].filter(Boolean).join(' · ');
  const carAge = () => P().year ? new Date().getFullYear() - P().year : null;
  const itvEveryMonths = () => { const a = carAge(); return a == null ? 12 : a < 4 ? 48 : a <= 10 ? 24 : 12; };
  const itvText = () => { const a = carAge(); return a == null ? 'Según la antigüedad' : a < 4 ? 'La primera a los 4 años' : a <= 10 ? 'Cada 2 años' : 'Cada año (tiene más de 10 años)'; };
  const labelText = () => (LABELS.find(l => l[0] === P().label) || [0, 'Sin indicar'])[1];

  function maintList() {
    return [
      { k: 'aceite', name: 'Aceite y filtro de aceite', km: isDiesel() ? 20000 : 15000, months: 12, tip: P().oil || 'Mira el aceite recomendado en el libro del coche' },
      { k: 'aire', name: 'Filtro de aire', km: 30000, months: 24 },
      { k: 'polen', name: 'Filtro de habitáculo (polen)', km: 15000, months: 12 },
      { k: 'gasolina', name: isDiesel() ? 'Filtro de gasoil' : 'Filtro de gasolina', km: isDiesel() ? 40000 : 60000, months: 48 },
      ...(isDiesel() ? [] : [{ k: 'bujias', name: 'Bujías', km: 30000, months: 36 }]),
      { k: 'distribucion', name: 'Correa de distribución y bomba de agua', km: 80000, months: 60, tip: 'Si se rompe, el motor se estropea. Mejor no apurarla. Si tu motor lleva cadena, no hace falta.' },
      { k: 'accesorios', name: 'Correa de accesorios', km: 80000, months: 60 },
      { k: 'liqfrenos', name: 'Líquido de frenos', km: 0, months: 24 },
      { k: 'refrigerante', name: 'Anticongelante', km: 0, months: 48 },
      { k: 'pastillas', name: 'Pastillas de freno (revisar)', km: 20000, months: 24 },
      { k: 'neumaticos', name: 'Neumáticos', km: 40000, months: 72, tip: 'Revisa la presión una vez al mes. La correcta está en la pegatina de la puerta del conductor o en la tapa del depósito.' },
      { k: 'bateria', name: 'Batería', km: 0, months: 60 },
    ];
  }
  const DOCS = [
    { k: 'itv', name: 'ITV' },
    { k: 'seguro', name: 'Seguro' },
    { k: 'ivtm', name: 'Impuesto de circulación' },
  ];
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const kmFmt = n => Math.round(n).toLocaleString('es-ES') + ' km';
  const dateFmt = iso => new Date(iso + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  const daysUntil = iso => Math.round((new Date(iso + 'T12:00:00') - new Date(todayISO() + 'T12:00:00')) / 864e5);
  const addMonths = (iso, m) => { const d = new Date(iso + 'T12:00:00'); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };
  const newId = () => Math.random().toString(36).slice(2, 9);

  // Vigía usa el combustible y el consumo de tu coche para las gasolineras y el gasto de cada ruta.
  function applyCarToVigia() {
    const fuelChanged = S.fuel !== P().fuel;
    S.fuel = P().fuel;
    if (!fuelStats().realCons) S.consumption = P().consumption;
    saveS();
    if (fuelChanged) { drawStations(); renderCheap(); }
  }
  if (!car.applied) { car.applied = true; saveCar(); S.fuel = P().fuel; if (S.consumption === DEFAULTS.consumption) S.consumption = P().consumption; saveS(); }

  // ---- Archivos (informes de la DGT en PDF): se guardan dentro de la app, en este iPhone ----
  const Files = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('vigia-coche', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => { const t = db.transaction('files', mode); const q = fn(t.objectStore('files')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
    },
    put: rec => Files.run('readwrite', s => s.put(rec)),
    get: id => Files.run('readonly', s => s.get(id)),
    del: id => Files.run('readwrite', s => s.delete(id)),
  };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  function maintStatus(it) {
    const last = car.maint[it.k];
    if (!last || (!last.km && !last.date)) return { level: 'none', text: 'Sin apuntar', sub: 'Toca para apuntar la última vez' };
    let kmLeft = null, daysLeft = null;
    if (it.km && last.km != null && car.km != null) kmLeft = last.km + it.km - car.km;
    if (it.months && last.date) daysLeft = daysUntil(addMonths(last.date, it.months));
    const parts = [];
    if (kmLeft != null) parts.push(kmLeft >= 0 ? `faltan ${kmFmt(kmLeft)}` : `pasado ${kmFmt(-kmLeft)}`);
    if (daysLeft != null) { const m = Math.round(Math.abs(daysLeft) / 30.4) || 1; parts.push(daysLeft >= 0 ? (daysLeft < 60 ? `${daysLeft} días` : `${Math.round(daysLeft / 30.4)} meses`) : `pasado ${m} mes${m > 1 ? 'es' : ''}`); }
    const late = (kmLeft != null && kmLeft < 0) || (daysLeft != null && daysLeft < 0);
    const soon = !late && ((kmLeft != null && kmLeft < 1500) || (daysLeft != null && daysLeft < 30));
    const doneTxt = [last.km != null ? kmFmt(last.km) : '', last.date ? dateFmt(last.date) : ''].filter(Boolean).join(' · ');
    return { level: late ? 'late' : soon ? 'soon' : 'ok', text: late ? 'Toca ya' : soon ? 'Pronto' : 'Al día',
      sub: (parts.length ? parts.join(' · ') : 'Apunta los km actuales para calcularlo') + (doneTxt ? ` · última: ${doneTxt}` : '') };
  }
  function docStatus(d) {
    const iso = car.docs[d.k];
    if (!iso) return { level: 'none', text: 'Sin fecha', sub: 'Toca para poner la fecha' };
    const n = daysUntil(iso);
    return { level: n < 0 ? 'late' : n <= 30 ? 'soon' : 'ok', text: n < 0 ? 'Caducado' : n === 0 ? 'Hoy' : n <= 30 ? `${n} días` : 'Al día',
      sub: `${n < 0 ? 'Caducó' : 'Vence'} el ${dateFmt(iso)}${n > 30 ? ` · ${n < 60 ? n + ' días' : Math.round(n / 30.4) + ' meses'}` : ''}` };
  }

  // Consumo real: de lleno a lleno.
  function fuelStats() {
    const f = car.fills.filter(x => x.km != null).sort((a, b) => a.km - b.km);
    let realCons = null;
    if (f.length >= 2) {
      const liters = f.slice(1).reduce((a, x) => a + x.liters, 0), dist = f[f.length - 1].km - f[0].km;
      if (dist > 50) realCons = liters / dist * 100;
    }
    const ym = todayISO().slice(0, 7);
    const month = car.fills.filter(x => x.date.slice(0, 7) === ym);
    const yr = car.fills.filter(x => x.date.slice(0, 4) === ym.slice(0, 4));
    return { realCons, monthEur: month.reduce((a, x) => a + x.euros, 0), monthL: month.reduce((a, x) => a + x.liters, 0),
      yearEur: yr.reduce((a, x) => a + x.euros, 0) };
  }
  function cheapestNear() {
    if (!st.pos || !st.stations.length) return null;
    const near = nearbyStations(st.pos.lat, st.pos.lon, 10000, P().fuel);
    if (!near.length) return null;
    return near.reduce((a, b) => b.s.prices[P().fuel] < a.s.prices[P().fuel] ? b : a);
  }

  const lvlPill = s => `<span class="car-pill ${s.level}">${esc(s.text)}</span>`;
  function carAlerts() {
    const out = [];
    for (const d of DOCS) { const s = docStatus(d); if (s.level === 'late' || s.level === 'soon') out.push({ name: d.name, s }); }
    for (const it of maintList()) { const s = maintStatus(it); if (s.level === 'late' || s.level === 'soon') out.push({ name: it.name, s }); }
    return out;
  }
  const extLink = (href, label, icon = 'i-search') => `<a class="opt car-row car-link" href="${esc(href)}" target="_blank" rel="noopener">${ic(icon)}<span class="lbl">${label}</span><span class="chev">↗</span></a>`;

  function carHtml() {
    const tabs = [['trips', 'Viajes'], ['maint', 'Revisiones'], ['fuel', 'Gasolina'], ['docs', 'Papeles'], ['info', 'Ficha']];
    const alerts = carAlerts();
    let html = `<div class="car-head">${ic('i-car')}<div><b>${esc(carName())}</b><div class="fine">${esc(carSub())}${P().plate ? ` · ${esc(P().plate)}` : ''}</div></div>
      <button type="button" class="car-km" data-act="km"><small>Kilómetros</small><b>${car.km != null ? kmFmt(car.km) : 'Apuntar'}</b></button></div>
      ${alerts.length ? `<div class="car-alert">${ic('i-alert')}<span>${alerts.slice(0, 3).map(a => `<b>${esc(a.name)}</b>: ${esc(a.s.text.toLowerCase())}`).join(' · ')}${alerts.length > 3 ? ` y ${alerts.length - 3} más` : ''}</span></div>` : ''}
      <div class="seg" id="carTabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${car.tab === k}">${l}</button>`).join('')}</div>`;

    if (car.tab === 'trips') {
      html += tripsHtml();
    } else if (car.tab === 'maint') {
      html += `<div class="group">${maintList().map(it => { const s = maintStatus(it); return `<button type="button" class="opt car-row" data-maint="${it.k}">
        <span class="lbl">${esc(it.name)}<small>${esc(s.sub)}</small></span>${lvlPill(s)}</button>`; }).join('')}</div>
        <p class="fine">Intervalos orientativos para un coche ${isDiesel() ? 'diésel' : 'de gasolina'}. Si en el taller o en el libro del coche pone otra cosa, manda eso.</p>`;
    } else if (car.tab === 'fuel') {
      const fs = fuelStats(), cheap = cheapestNear();
      const p = cheap ? cheap.s.prices[P().fuel] : null;
      html += fuelGaugeHtml() + `<div class="car-stats">
          <div><small>Consumo real</small><b>${fs.realCons ? fmt.liters(fs.realCons) : '—'}</b><small>${fs.realCons ? 'cada 100 km' : 'Apunta 2 repostajes con km'}</small></div>
          <div><small>Este mes</small><b>${fmt.eur(fs.monthEur)}</b><small>${fmt.liters(fs.monthL)}</small></div>
          <div><small>Este año</small><b>${fmt.eur(fs.yearEur)}</b><small>${car.fills.length} repostajes</small></div>
        </div>
        ${p ? `<button type="button" class="opt car-cheap" data-station="${esc(cheap.s.id)}"><span class="lbl">Llenar el depósito (${P().tank} L): <b>${fmt.eur(p * P().tank)}</b><small>${esc(V.brandName(cheap.s.brand))} a ${fmt.dist(cheap.d)} · ${fmt.price(p)} €/L de ${esc(fuelLabel(P().fuel))}, la más barata cerca</small></span></button>` : ''}
        <div class="section-label">Apuntar repostaje</div>
        <form id="fillForm" class="group car-form">
          <label class="opt"><span class="lbl">Litros</span><input name="liters" type="number" inputmode="decimal" step="0.01" min="1" max="${(P().tank || 80) + 10}" required placeholder="35,2"></label>
          <label class="opt"><span class="lbl">Total pagado (€)</span><input name="euros" type="number" inputmode="decimal" step="0.01" min="1" required placeholder="52,40"></label>
          <label class="opt"><span class="lbl">Km del coche<small>Para calcular el consumo real</small></span><input name="km" type="number" inputmode="numeric" min="0" placeholder="${car.km ?? '185000'}"></label>
          <label class="opt"><span class="lbl">Fecha</span><input name="date" type="date" value="${todayISO()}" required></label>
          <label class="opt"><span class="lbl">He llenado el depósito<small>Hasta que salta la pistola</small></span><span class="switch"><input type="checkbox" name="full" checked><span></span></span></label>
        </form>
        <button type="button" class="btn-grad" data-act="addFill">${ic('i-fuel')}Guardar repostaje</button>
        <p class="fine">Llena el depósito hasta que salte la pistola cada vez: así el consumo real sale bien. Cuando lo tenga, Vigía lo usa para calcular lo que gastas en cada ruta.</p>
        ${car.fills.length ? `<div class="section-label">Historial</div><div class="group">${car.fills.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.km || 0) - (a.km || 0)).slice(0, 30).map(f => `
          <div class="opt"><span class="lbl">${dateFmt(f.date)} · ${fmt.liters(f.liters)}<small>${fmt.price(f.euros / f.liters)} €/L${f.km != null ? ' · ' + kmFmt(f.km) : ''}</small></span><b>${fmt.eur(f.euros)}</b>
          <button type="button" class="icon-plain car-del" data-delfill="${f.id}" aria-label="Borrar repostaje">${ic('i-x')}</button></div>`).join('')}</div>` : ''}`;
    } else if (car.tab === 'docs') {
      const itvs = car.itvs.slice().sort((a, b) => b.date.localeCompare(a.date));
      html += `<div class="group">${DOCS.map(d => { const s = docStatus(d); return `<button type="button" class="opt car-row" data-doc="${d.k}">
        <span class="lbl">${esc(d.name)}<small>${esc(s.sub)}</small></span>${lvlPill(s)}</button>`; }).join('')}</div>
        <button type="button" class="btn-grad" data-act="calendar">${ic('i-clock')}Avisos en el calendario del iPhone</button>
        <p class="fine">ITV: ${esc(itvText().toLowerCase())}. Con el calendario, el iPhone te avisa 30 y 7 días antes aunque no abras Vigía. Si cambias fechas, vuelve a añadirlos.</p>

        <div class="section-label">Historial de ITV</div>
        <div class="group">
          ${itvs.map(x => `<div class="opt"><span class="lbl">${dateFmt(x.date)}${x.km != null ? ' · ' + kmFmt(x.km) : ''}<small>${esc(x.result)}${x.note ? ' · ' + esc(x.note) : ''}</small></span>
            <span class="car-pill ${x.result === 'Favorable' ? 'ok' : x.result === 'Desfavorable' ? 'soon' : 'late'}">${esc(x.result)}</span>
            <button type="button" class="icon-plain car-del" data-delitv="${x.id}" aria-label="Borrar inspección">${ic('i-x')}</button></div>`).join('')}
          <button type="button" class="opt car-row" data-act="addItv">${ic('i-check')}<span class="lbl">Añadir una inspección<small>Fecha, km y resultado. Están en el informe de la DGT y en la tarjeta ITV.</small></span><span class="chev">›</span></button>
        </div>

        <div class="section-label">Informe de la DGT</div>
        <div class="group">
          ${car.reports.map(r => `<div class="opt"><span class="lbl">${esc(r.name)}<small>Añadido el ${dateFmt(r.date)} · ${(r.size / 1024).toFixed(0)} KB</small></span>
            <button type="button" class="btn-ghost small" data-openrep="${r.id}">Ver</button>
            <button type="button" class="icon-plain car-del" data-delrep="${r.id}" aria-label="Borrar informe">${ic('i-x')}</button></div>`).join('')}
          <label class="opt car-row car-file">${ic('i-down')}<span class="lbl">${car.reports.length ? 'Añadir otro informe (PDF)' : 'Añadir el informe (PDF)'}<small>Se guarda dentro de Vigía, en este iPhone</small></span><input type="file" id="repFile" accept="application/pdf,.pdf"></label>
          ${extLink(DGT.report, 'Pedir el informe en la DGT<small>Completo: tasa de 8,67 €. Reducido: gratis</small>', 'i-euro')}
        </div>
        <p class="fine">El informe es una foto del coche el día que lo pides: no se actualiza solo. Lo que apuntes aquí (ITV, km) se queda guardado.</p>`;
    } else {
      const fs = fuelStats(), pr = P();
      const rows = [['Marca y modelo', carName()], ['Versión', pr.version || '—'], ['Año', pr.year || '—'], ['Matrícula', pr.plate || '—'],
        ['Motor', [pr.cc ? pr.cc.toLocaleString('es-ES') + ' cc' : '', pr.hp ? pr.hp + ' CV' : ''].filter(Boolean).join(' · ') || '—'],
        ['Combustible', fuelLabel(pr.fuel)], ['Depósito', pr.tank ? `${pr.tank} L` : '—'],
        ['Consumo para las rutas', fmt.liters(S.consumption) + ' / 100 km' + (fs.realCons ? ' (real)' : ' (aprox.)')],
        ['Autonomía con el depósito lleno', pr.tank ? `unos ${Math.round(pr.tank / S.consumption * 100 / 10) * 10} km` : '—'],
        ['Aceite', pr.oil || '—'], ['Etiqueta DGT', labelText()], ['ITV', itvText()]];
      html += `<button type="button" class="btn-grad" data-act="editCar">${ic('i-sliders')}Cambiar coche o editar datos</button>
        <div class="group">${rows.map(([a, b]) => `<div class="opt"><span class="lbl">${a}</span><b class="car-val">${esc(String(b))}</b></div>`).join('')}</div>
        ${pr.plate ? `<div class="group">${extLink(DGT.label(pr.plate), `Comprobar la etiqueta en la DGT<small>Con la matrícula ${esc(pr.plate)}. Gratis</small>`)}</div>` : ''}
        <div class="section-label">Copia de seguridad</div>
        <div class="group">
          <button type="button" class="opt car-row" data-act="export">${ic('i-down')}<span class="lbl">Guardar copia<small>Ficha, revisiones, repostajes, papeles e ITV. Guárdala en Archivos</small></span><span class="chev">›</span></button>
          <label class="opt car-row car-file">${ic('i-up')}<span class="lbl">Recuperar una copia<small>Si borras Vigía o cambias de iPhone</small></span><input type="file" id="impFile" accept="application/json,.json"></label>
        </div>
        <p class="fine">Datos orientativos. Para el aceite y las presiones, manda el libro del coche o la pegatina de la puerta.</p>`;
    }
    return html;
  }

  function openCar() {
    openSheet('car', 'Mi coche', carHtml());
    const body = $('#sheetBody');
    body.onchange = async e => {
      if (e.target.dataset.set) return onSettingChange(e);
      if (e.target.id === 'repFile' && e.target.files[0]) return addReport(e.target.files[0]);
      if (e.target.id === 'impFile' && e.target.files[0]) return importCar(e.target.files[0]);
    };
    body.onclick = async e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.tab) { car.tab = t.dataset.tab; saveCar(); return openCar(); }
      if (onTripsClick(t)) return;
      if (t.dataset.act === 'km') return editKm();
      if (t.dataset.act === 'editCar') return editCar();
      if (t.dataset.act === 'addItv') return addItv();
      if (t.dataset.act === 'export') return exportCar();
      if (t.dataset.act === 'calendar') return exportCalendar();
      if (t.dataset.maint) return editMaint(maintList().find(x => x.k === t.dataset.maint));
      if (t.dataset.doc) return editDoc(DOCS.find(x => x.k === t.dataset.doc));
      if (t.dataset.station) return openStation(t.dataset.station);
      if (t.dataset.openrep) return openPdfReport(t.dataset.openrep);
      if (t.dataset.delrep) {
        const r = car.reports.find(x => x.id === t.dataset.delrep);
        if (!confirm(`¿Borrar «${r.name}» de Vigía?`)) return;
        car.reports = car.reports.filter(x => x !== r); saveCar(); Files.del(r.id).catch(() => {}); openCar(); toast('Informe borrado');
        return;
      }
      if (t.dataset.delitv) {
        const x = car.itvs.find(i => i.id === t.dataset.delitv);
        car.itvs = car.itvs.filter(i => i !== x); saveCar(); openCar();
        toast('Inspección borrada', { label: 'Deshacer', fn: () => { car.itvs.push(x); saveCar(); openCar(); } });
        return;
      }
      if (t.dataset.delfill) {
        const f = car.fills.find(x => x.id === t.dataset.delfill);
        car.fills = car.fills.filter(x => x !== f); saveCar(); applyRealConsumption(); openCar();
        toast('Repostaje borrado', { label: 'Deshacer', fn: () => { car.fills.push(f); saveCar(); applyRealConsumption(); openCar(); } });
        return;
      }
      if (t.dataset.act === 'addFill') {
        const form = $('#fillForm');
        if (!form.reportValidity()) return;
        const v = n => form.elements[n].value.trim().replace(',', '.');
        const liters = +v('liters'), euros = +v('euros'), km = v('km') === '' ? null : Math.round(+v('km'));
        if (km != null && car.km != null && km + 5000 < car.km) { toast('Esos km son menores que los del coche. Revísalos.'); return; }
        const full = form.elements.full.checked;
        car.fills.push({ id: newId(), date: v('date'), liters, euros, km, full });
        if (full) setFuelLevel(tankL()); else if (car.fuelLevel) setFuelLevel(fuelLeft() + liters);
        if (km != null && (car.km == null || km > car.km)) car.km = km;
        saveCar(); applyRealConsumption(); openCar();
        toast(`Guardado: ${fmt.liters(liters)} a ${fmt.price(euros / liters)} €/L`);
      }
    };
  }
  function applyRealConsumption() {
    const c = fuelStats().realCons;
    S.consumption = c && c > 2 && c < 25 ? Math.round(c * 10) / 10 : P().consumption; saveS();
  }

  // ---- Informes PDF ----
  async function addReport(file) {
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast('Elige un archivo PDF'); return; }
    if (file.size > 25 * 1048576) { toast('El PDF es demasiado grande (máx. 25 MB)'); return; }
    const rec = { id: 'rep-' + newId(), name: file.name.replace(/\.pdf$/i, '') || 'Informe DGT', date: todayISO(), size: file.size };
    try {
      await Files.put({ id: rec.id, blob: file, type: 'application/pdf' });
      car.reports.push(rec); saveCar(); openCar();
      toast('Informe guardado. Pasa los datos de ITV a «Historial de ITV»');
    } catch { toast('No se pudo guardar el PDF en este iPhone'); }
  }
  async function openPdfReport(id) {
    try {
      const f = await Files.get(id);
      if (!f) { toast('Este informe ya no está guardado en este iPhone'); return; }
      const url = URL.createObjectURL(new Blob([f.blob], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast('No se pudo abrir el informe'); }
  }

  // ---- Copia de seguridad (sin los PDF, que pesan mucho) ----
  function exportCar() {
    const data = { app: 'vigia-coche', v: 2, at: new Date().toISOString(), car: { ...car, reports: [] }, consumption: S.consumption };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `vigia-${(P().model || 'coche').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Copia creada. Guárdala en Archivos');
  }
  async function importCar(file) {
    try {
      const d = JSON.parse(await file.text());
      if (d.app !== 'vigia-coche' || !d.car) throw 0;
      if (!confirm('Se sustituirán los datos del coche de este iPhone por los de la copia. ¿Seguir?')) return;
      const keepReports = car.reports;
      Object.keys(car).forEach(k => delete car[k]);
      Object.assign(car, { km: null, maint: {}, docs: {}, fills: [], itvs: [], tab: 'info', applied: true }, d.car, { reports: keepReports });
      car.profile = Object.assign({}, CAR_DEFAULT, car.profile || {});
      saveCar(); applyCarToVigia(); applyRealConsumption(); openCar();
      toast('Copia recuperada');
    } catch { toast('Ese archivo no es una copia de Vigía'); }
  }

  // ---- Formularios ----
  function subForm(title, html, onSave, extra) {
    openSheet('car', title, `<form id="carSub" class="group car-form">${html}</form>
      <div class="btns">${extra || ''}<button type="button" class="btn-grad" data-act="save">${ic('i-check')}Guardar</button></div>
      <button type="button" class="link-btn" data-act="back">Volver a Mi coche</button>`);
    const body = $('#sheetBody');
    body.onchange = null;
    body.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      const form = $('#carSub');
      if (t.dataset.act === 'back') return openCar();
      if (t.dataset.act === 'save') { if (!form.reportValidity()) return; if (onSave(form) === false) return; saveCar(); openCar(); }
      if (t.dataset.act === 'today') { if (form.elements.km && car.km != null) form.elements.km.value = car.km; if (form.elements.date) form.elements.date.value = todayISO(); }
      if (t.dataset.act === 'clear') { onSave(null); saveCar(); openCar(); }
    };
  }
  const num = (f, n) => { const v = f.elements[n].value.trim().replace(',', '.'); return v === '' ? null : +v; };

  function editCar() {
    const p = P(), y = new Date().getFullYear();
    subForm('Tu coche', `
      <label class="opt"><span class="lbl">Marca</span><input name="brand" list="carBrands" required maxlength="30" value="${esc(p.brand)}" placeholder="Seat"></label>
      <datalist id="carBrands">${BRANDS.map(b => `<option value="${esc(b)}">`).join('')}</datalist>
      <label class="opt"><span class="lbl">Modelo</span><input name="model" required maxlength="30" value="${esc(p.model)}" placeholder="Ibiza"></label>
      <label class="opt"><span class="lbl">Año</span><input name="year" type="number" inputmode="numeric" min="1950" max="${y + 1}" value="${p.year ?? ''}" placeholder="2015"></label>
      <label class="opt"><span class="lbl">Versión<small>Motor y potencia, como lo conoces</small></span><input name="version" maxlength="40" value="${esc(p.version)}" placeholder="1.0 TSI 95 CV"></label>
      <label class="opt"><span class="lbl">Cilindrada (cc)</span><input name="cc" type="number" inputmode="numeric" min="0" max="9000" value="${p.cc ?? ''}" placeholder="1360"></label>
      <label class="opt"><span class="lbl">Potencia (CV)</span><input name="hp" type="number" inputmode="numeric" min="0" max="2000" value="${p.hp ?? ''}" placeholder="75"></label>
      <label class="opt"><span class="lbl">Combustible</span><select name="fuel">${V.FUELS.map(f => `<option value="${f.key}" ${f.key === p.fuel ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
      <label class="opt"><span class="lbl">Depósito (litros)</span><input name="tank" type="number" inputmode="decimal" min="10" max="200" value="${p.tank ?? ''}" placeholder="50"></label>
      <label class="opt"><span class="lbl">Consumo medio<small>Litros cada 100 km. Si apuntas repostajes, se usa el real</small></span><input name="consumption" type="number" inputmode="decimal" step="0.1" min="2" max="25" required value="${p.consumption}" placeholder="6,5"></label>
      <label class="opt"><span class="lbl">Matrícula</span><input name="plate" maxlength="10" autocapitalize="characters" value="${esc(p.plate)}" placeholder="1234ABC"></label>
      <label class="opt"><span class="lbl">Etiqueta DGT</span><select name="label">${LABELS.map(([k, l]) => `<option value="${k}" ${k === p.label ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="opt"><span class="lbl">Aceite<small>Tipo y cantidad, del libro del coche</small></span><input name="oil" maxlength="60" value="${esc(p.oil)}" placeholder="4 L · 5W-30"></label>`,
      f => {
        const v = n => f.elements[n].value.trim();
        const isNewCar = v('brand') !== p.brand || v('model') !== p.model;
        if (isNewCar && (car.fills.length || Object.keys(car.maint).length || car.itvs.length) &&
          !confirm('Has cambiado de coche. ¿Borro las revisiones, repostajes, papeles e ITV del anterior?\n\nAceptar: empezar de cero · Cancelar: mantenerlos')) {
          // Mantener el historial
        } else if (isNewCar) {
          Object.assign(car, { km: null, maint: {}, docs: {}, fills: [], itvs: [] });
        }
        Object.assign(car.profile, {
          brand: v('brand'), model: v('model'), year: num(f, 'year'), version: v('version'), cc: num(f, 'cc'), hp: num(f, 'hp'),
          fuel: v('fuel'), tank: num(f, 'tank'), consumption: num(f, 'consumption'), plate: v('plate').toUpperCase().replace(/[\s-]/g, ''),
          label: v('label'), oil: v('oil'),
        });
        saveCar(); applyCarToVigia(); applyRealConsumption();
        toast('Coche guardado');
      });
  }
  function editKm() {
    subForm('Kilómetros del coche', `<label class="opt"><span class="lbl">Km que marca ahora<small>Míralo en el cuentakilómetros</small></span>
      <input name="km" type="number" inputmode="numeric" min="0" max="999999" required value="${car.km ?? ''}" placeholder="185000"></label>`,
      f => { car.km = Math.round(+f.elements.km.value); });
  }
  function addItv() {
    subForm('Inspección ITV', `
      <label class="opt"><span class="lbl">Fecha</span><input name="date" type="date" required max="${todayISO()}" value="${todayISO()}"></label>
      <label class="opt"><span class="lbl">Km en la inspección</span><input name="km" type="number" inputmode="numeric" min="0" max="999999" placeholder="${car.km ?? ''}"></label>
      <label class="opt"><span class="lbl">Resultado</span><select name="result"><option>Favorable</option><option>Desfavorable</option><option>Negativa</option></select></label>
      <label class="opt"><span class="lbl">Nota (opcional)</span><input name="note" maxlength="80" placeholder="Defecto leve: luces"></label>`,
      f => {
        const date = f.elements.date.value, km = num(f, 'km'), result = f.elements.result.value, note = f.elements.note.value.trim();
        car.itvs.push({ id: newId(), date, km, result, note });
        if (km != null && (car.km == null || km > car.km)) car.km = km;
        // La última favorable marca la fecha de la próxima ITV.
        const lastOk = car.itvs.filter(x => x.result === 'Favorable').sort((a, b) => b.date.localeCompare(a.date))[0];
        if (lastOk) { const next = addMonths(lastOk.date, itvEveryMonths()); if (!car.docs.itv || next > car.docs.itv) car.docs.itv = next; }
        toast('Inspección guardada');
      });
  }
  function editMaint(it) {
    const last = car.maint[it.k] || {};
    const every = [it.km ? kmFmt(it.km) : '', it.months ? (it.months % 12 ? it.months + ' meses' : (it.months / 12 === 1 ? '1 año' : it.months / 12 + ' años')) : ''].filter(Boolean).join(' o ');
    subForm(it.name, `<div class="opt"><span class="lbl">Cada<small>${esc(it.tip || 'Lo que llegue antes')}</small></span><b class="car-val">${every}</b></div>
      ${it.km ? `<label class="opt"><span class="lbl">Km cuando se hizo</span><input name="km" type="number" inputmode="numeric" min="0" value="${last.km ?? ''}" placeholder="${car.km ?? ''}"></label>` : ''}
      <label class="opt"><span class="lbl">Fecha cuando se hizo</span><input name="date" type="date" value="${last.date || ''}" max="${todayISO()}"></label>`,
      f => {
        if (!f) { delete car.maint[it.k]; return; }
        const km = f.elements.km && f.elements.km.value !== '' ? Math.round(+f.elements.km.value) : null;
        const date = f.elements.date.value || null;
        if (km == null && !date) { delete car.maint[it.k]; return; }
        car.maint[it.k] = { km, date };
        if (km != null && (car.km == null || km > car.km)) car.km = km;
      },
      `<button type="button" class="btn-ghost" data-act="today">Hecho hoy</button>${last.km != null || last.date ? '<button type="button" class="btn-ghost" data-act="clear">Borrar</button>' : ''}`);
  }
  function editDoc(d) {
    const tip = d.k === 'itv' ? `${itvText()}. Mira la fecha en la pegatina del parabrisas o en la tarjeta ITV` : 'Mira la fecha en el papel o en el recibo';
    subForm(d.name, `<label class="opt"><span class="lbl">Vence el<small>${esc(tip)}</small></span>
      <input name="date" type="date" required value="${car.docs[d.k] || ''}"></label>`,
      f => { if (!f) delete car.docs[d.k]; else car.docs[d.k] = f.elements.date.value; },
      car.docs[d.k] ? '<button type="button" class="btn-ghost" data-act="clear">Borrar</button>' : '');
  }
  function carStartupNotice() {
    const a = carAlerts();
    if (!a.length) { lowFuelCheck(); return; }
    notice(`Mi coche · ${a.slice(0, 2).map(x => `${x.name}: ${x.s.text.toLowerCase()}`).join(' · ')}${a.length > 2 ? ` y ${a.length - 2} más` : ''}. Tócalo en el botón del coche.`, 9000);
  }


  // ---------- Diario de viajes, km y gasolina automáticos ----------
  // Con Vigía abierta, cada vez que el coche se mueve se graba un viaje: km, tiempo, velocidad,
  // frenazos y acelerones. Al terminar, suma los km al cuentakilómetros, resta la gasolina
  // gastada del depósito y guarda dónde has aparcado. (iOS no deja a una web usar el GPS con la app cerrada.)
  car.fuelLevel = car.fuelLevel || null;   // { liters, t }
  car.parking = car.parking || null;       // { lat, lon, t }
  const tripsAll = () => store.get('trips', []);
  const saveTrips = list => store.set('trips', list.slice(-600));
  const tankL = () => P().tank || 50;
  const fuelLeft = () => car.fuelLevel ? Math.max(0, Math.min(tankL(), car.fuelLevel.liters)) : null;
  const rangeKm = () => fuelLeft() == null ? null : fuelLeft() / S.consumption * 100;
  function setFuelLevel(liters) { car.fuelLevel = { liters: Math.max(0, Math.min(tankL(), liters)), t: now() }; saveCar(); }

  const Trips = {
    cur: null, lastWarn: 0, recent: [], mode: 'still',
    // ¿Qué estás haciendo? Con la velocidad de los últimos segundos:
    //  · parado: casi 0 · andando: hasta 7 km/h · corriendo: de 7 a 20 km/h, o un acelerón desde andar
    //  · en coche: más de 10 km/h durante 20 s y llegando a 20 km/h, o más de 30 km/h varias lecturas seguidas
    classify(t) {
      const R = this.recent, win = R.filter(x => t - x.t <= 22000), last3 = R.slice(-3);
      const span = win.length ? t - win[0].t : 0;
      const allOver10 = win.length >= 3 && win.filter(x => x.v <= 2.8).length <= 1;
      const peak = Math.max(0, ...win.map(x => x.v));
      if ((span >= 18000 && allOver10 && peak > 5.6) || (last3.length === 3 && last3.every(x => x.v > 8.3))) return 'car';
      const v = R.length ? R[R.length - 1].v : 0;
      if (this.mode === 'car' && v > 2.8) return 'car';        // sigues en coche (atasco lento, rotonda…)
      if (v < 0.5) return 'still';
      const prev = R.slice(-6, -1), wasWalking = prev.length && prev.every(x => x.v < 1.9);
      if (v >= 1.9 || (wasWalking && v - prev[prev.length - 1].v > 1.2)) return 'run';
      return 'walk';
    },
    onFix(lat, lon, acc, v, t) {
      if (S.autoTrips === false || acc > 45) return;
      this.recent.push({ t, v, lat, lon }); this.recent = this.recent.filter(x => t - x.t <= 40000);
      this.mode = this.classify(t);
      const c = this.cur;
      if (!c) {
        if (this.mode !== 'car') return;
        // El viaje empieza donde arrancaste: el primer punto de esta racha por encima de 10 km/h.
        let i = this.recent.length - 1; while (i > 0 && this.recent[i - 1].v > 2.8) i--;
        const first = this.recent[i];
        this.cand = { lat: first.lat, lon: first.lon, t: first.t };
        this.cur = { id: 't' + t.toString(36), start: this.cand.t, from: { lat: this.cand.lat, lon: this.cand.lon },
          last: { lat, lon, t, v }, dist: V.haversine(this.cand.lat, this.cand.lon, lat, lon), moving: 0, maxV: v,
          brakes: 0, accels: 0, lastEvt: 0, lastMove: t, lastDrive: t, driveDist: 0, park: { lat, lon }, pts: [[+lon.toFixed(5), +lat.toFixed(5)]], ptDist: 0, dest: st.dest ? st.dest.name : null };
        this.cand = null; this.persist();
        return;
      }
      const L = c.last, dt = (t - L.t) / 1000;
      if (dt <= 0) return;
      const d = V.haversine(L.lat, L.lon, lat, lon);
      if (d / dt > 70) return;   // salto imposible del GPS
      if (d > Math.max(3, acc * 0.3)) { c.dist += d; c.ptDist += d; L.lat = lat; L.lon = lon; }
      if (v > 1.5) { c.moving += dt * 1000; c.lastMove = t; }
      if (this.mode === 'car') { c.lastDrive = t; c.driveDist = c.dist; c.park = { lat, lon }; }   // andar o correr no cuenta
      c.maxV = Math.max(c.maxV, v);
      if (dt >= 1 && dt <= 5 && t - c.lastEvt > 6000) {
        const a = (v - L.v) / dt;
        if (a < -3.4) { c.brakes++; c.lastEvt = t; }
        else if (a > 2.8 && L.v > 2) { c.accels++; c.lastEvt = t; }
      }
      L.v = v; L.t = t;
      if (c.ptDist > 150 && c.pts.length < 400) { c.pts.push([+lon.toFixed(5), +lat.toFixed(5)]); c.ptDist = 0; }
      if (st.dest && !c.dest) c.dest = st.dest.name;
      if (t - (c.saved || 0) > 15000) { c.saved = t; this.persist(); }
    },
    persist() { store.set('tripCur', this.cur); },
    // Parado más de 4 minutos = fin del viaje.
    tick() { if (this.cur && now() - (this.cur.lastDrive || this.cur.lastMove) > 5 * 60e3) this.finish(); },
    finish(reason) {
      const c = this.cur; this.cur = null; store.set('tripCur', null);
      // Lo que hiciste andando después de aparcar no cuenta: el viaje acaba en el último punto en coche.
      if (c && c.driveDist != null) { c.dist = c.driveDist; if (c.park) { c.last.lat = c.park.lat; c.last.lon = c.park.lon; } }
      if (!c || c.dist < 500) return null;
      const end = c.lastDrive || Math.max(c.lastMove, c.last.t);
      const km = c.dist / 1000, movingS = Math.max(60, c.moving / 1000);
      const liters = V.fuelLiters(c.dist, movingS, S.consumption);
      const price = refPrice(c.last.lat, c.last.lon);
      const trip = { id: c.id, start: c.start, end, km: Math.round(km * 10) / 10, moving: Math.round(movingS),
        maxKmh: Math.round(c.maxV * 3.6), brakes: c.brakes, accels: c.accels, score: driveScore(km, c.brakes, c.accels),
        liters: Math.round(liters * 100) / 100, eur: Math.round(liters * price * 100) / 100,
        from: c.from, to: { lat: c.last.lat, lon: c.last.lon }, dest: c.dest || null, pts: c.pts };
      const list = tripsAll(); list.push(trip); saveTrips(list);
      // Cuentakilómetros y depósito
      if (car.km != null) car.km = Math.round(car.km + km);
      if (car.fuelLevel) car.fuelLevel = { liters: Math.max(0, car.fuelLevel.liters - liters), t: now() };
      car.parking = { lat: c.last.lat, lon: c.last.lon, t: end };
      saveCar(); drawParking();
      if (reason !== 'silent') {
        toast(`Viaje guardado: ${fmt.dist(c.dist)} · nota ${trip.score}`, { label: 'Ver', fn: () => { car.tab = 'trips'; openCar(); } });
        setTimeout(lowFuelCheck, 2500);
      }
      return trip;
    },
    restore() {
      const c = store.get('tripCur', null);
      if (!c) return;
      if (now() - c.last.t < 10 * 60e3) this.cur = c;   // la app se cerró un momento: sigue el mismo viaje
      else { this.cur = c; this.finish('silent'); }
    },
  };
  function driveScore(km, brakes, accels) {
    const per10 = (brakes * 7 + accels * 4) * 10 / Math.max(5, km);
    return Math.max(0, Math.min(100, Math.round(100 - per10)));
  }
  const scoreWord = s => s >= 90 ? 'Muy suave' : s >= 75 ? 'Suave' : s >= 55 ? 'Normal' : 'Brusca';
  addEventListener('pagehide', () => Trips.persist());
  document.addEventListener('visibilitychange', () => { if (document.hidden) Trips.persist(); });
  setInterval(() => Trips.tick(), 30e3);

  // Aviso de poca gasolina, con la gasolinera más barata cerca.
  function lowFuelCheck() {
    const r = rangeKm();
    if (r == null || r > 80 || now() - Trips.lastWarn < 20 * 60e3) return;
    Trips.lastWarn = now();
    const cheap = cheapestNear();
    notice(`Te quedan unos ${Math.max(0, Math.round(r / 10) * 10)} km de gasolina.` +
      (cheap ? ` La más barata cerca: ${V.brandName(cheap.s.brand)} a ${fmt.dist(cheap.d)}, ${fmt.price(cheap.s.prices[P().fuel])} €/L.` : ''), 10000);
  }

  // ---- Dónde aparqué ----
  const parkEl = document.createElement('button');
  parkEl.type = 'button'; parkEl.className = 'park-pin'; parkEl.setAttribute('aria-label', 'Tu coche aparcado');
  parkEl.innerHTML = '<span>P</span>';
  parkEl.addEventListener('click', e => { e.stopPropagation(); openParking(); });
  const parkMarker = new maplibregl.Marker({ element: parkEl, anchor: 'bottom' });
  let parkShown = false;
  function drawParking() {
    const p = car.parking;
    if (p && !st.nav) { parkMarker.setLngLat([p.lon, p.lat]); if (!parkShown) { parkMarker.addTo(map); parkShown = true; } }
    else if (parkShown) { parkMarker.remove(); parkShown = false; }
  }
  const walkUrl = p => `https://maps.apple.com/?daddr=${p.lat},${p.lon}&dirflg=w`;
  function openParking() {
    const p = car.parking; if (!p) return;
    const d = st.pos ? V.haversine(st.pos.lat, st.pos.lon, p.lat, p.lon) : null;
    openSheet('parking', 'Tu coche', `
      <div class="car-head">${ic('i-car')}<div><b>Aparcado ${relTime(p.t)}</b><div class="fine">${d != null ? `A ${fmt.dist(d)} de ti` : 'Guardado al terminar tu último viaje'}</div></div></div>
      <a class="btn-grad" href="${walkUrl(p)}" target="_blank" rel="noopener">${ic('i-locate')}Llevarme andando</a>
      <div class="btns"><button type="button" class="btn-ghost" data-act="center">Ver en el mapa</button><button type="button" class="btn-ghost" data-act="got">Ya lo tengo</button></div>`);
    $('#sheetBody').onchange = null;
    $('#sheetBody').onclick = e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.act === 'center') { closeSheet(); setFollow(false); map.flyTo({ center: [p.lon, p.lat], zoom: 17, duration: 900 }); }
      if (t.dataset.act === 'got') { car.parking = null; saveCar(); drawParking(); closeSheet(); toast('Aparcamiento borrado'); }
    };
  }

  // ---- Pestaña «Viajes» de Mi coche ----
  let tripMonth = todayISO().slice(0, 7);
  const monthName = ym => new Date(ym + '-15T12:00:00').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const shiftMonth = (ym, n) => { const d = new Date(ym + '-15T12:00:00'); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 7); };
  const ymOf = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
  const hm = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

  function fuelGaugeHtml() {
    const l = fuelLeft();
    if (l == null) return `<div class="group"><div class="opt col"><span class="lbl">¿Cuánta gasolina tienes ahora?<small>Dímelo una vez y Vigía la irá descontando sola con cada viaje</small></span>
      <div class="seg fuel-set">${[['0.12', 'Reserva'], ['0.25', '¼'], ['0.5', '½'], ['0.75', '¾'], ['1', 'Lleno']].map(([f, n]) => `<button type="button" data-fuelset="${f}">${n}</button>`).join('')}</div></div></div>`;
    const pct = l / tankL(), r = rangeKm();
    const lvl = pct < 0.15 ? 'late' : pct < 0.3 ? 'soon' : 'ok';
    return `<div class="fuel-gauge ${lvl}"><div class="fg-top"><div><small>En el depósito</small><b>${fmt.liters(l)}</b></div>
        <div class="fg-r"><small>Te da para</small><b>unos ${Math.round(r / 10) * 10} km</b></div></div>
      <div class="fg-bar"><span style="width:${Math.round(pct * 100)}%"></span></div>
      <div class="seg fuel-set">${[['0.12', 'Reserva'], ['0.25', '¼'], ['0.5', '½'], ['0.75', '¾'], ['1', 'Lleno']].map(([f, n]) => `<button type="button" data-fuelset="${f}">${n}</button>`).join('')}</div>
      <small class="fg-note">Se descuenta sola con cada viaje. Si no cuadra con la aguja, toca el nivel real.</small></div>`;
  }

  function tripsHtml() {
    const all = tripsAll();
    const month = all.filter(x => ymOf(x.start) === tripMonth);
    const km = month.reduce((a, x) => a + x.km, 0), secs = month.reduce((a, x) => a + x.moving, 0);
    const eur = month.reduce((a, x) => a + (x.eur || 0), 0);
    const avgScore = month.length ? Math.round(month.reduce((a, x) => a + x.score * x.km, 0) / Math.max(0.1, km)) : null;
    const longest = month.reduce((a, x) => (!a || x.km > a.km ? x : a), null);
    const top = month.reduce((a, x) => Math.max(a, x.maxKmh || 0), 0);
    const nowYm = todayISO().slice(0, 7);
    let html = `<div class="wrap-card">
        <div class="wrap-nav"><button type="button" class="icon-plain" data-month="-1" aria-label="Mes anterior">‹</button>
          <span>Tu ${esc(monthName(tripMonth))}</span>
          <button type="button" class="icon-plain" data-month="1" aria-label="Mes siguiente" ${tripMonth >= nowYm ? 'disabled' : ''}>›</button></div>
        ${month.length ? `<div class="wrap-big">${Math.round(km).toLocaleString('es-ES')}<small>km</small></div>
        <div class="wrap-grid">
          <div><b>${month.length}</b><small>viajes</small></div>
          <div><b>${hm(secs)}</b><small>al volante</small></div>
          <div><b>${fmt.eur(eur)}</b><small>de gasolina (aprox.)</small></div>
          <div><b>${avgScore}</b><small>nota de conducción · ${scoreWord(avgScore)}</small></div>
          <div><b>${fmt.dist(longest.km * 1000)}</b><small>tu viaje más largo</small></div>
          <div><b>${top} km/h</b><small>velocidad máxima</small></div>
        </div>` : `<p class="wrap-empty">${tripMonth === nowYm ? 'Aún no hay viajes este mes. Abre Vigía al conducir y se grabarán solos.' : 'No hubo viajes este mes.'}</p>`}
      </div>`;
    if (car.parking) html += `<button type="button" class="opt car-row park-row" data-act="parking">${ic('i-pin')}<span class="lbl">Dónde aparqué<small>Hace ${relTime(car.parking.t).replace(/^hace /, '')}${st.pos ? ' · a ' + fmt.dist(V.haversine(st.pos.lat, st.pos.lon, car.parking.lat, car.parking.lon)) : ''}</small></span><span class="chev">›</span></button>`;
    if (st.pos) html += `<button type="button" class="btn-ghost" data-act="parkHere">${ic('i-pin')} He aparcado aquí</button>`;
    if (Trips.cur) html += `<div class="rec-row"><span class="rec-dot"></span>Grabando viaje · ${fmt.dist(Trips.cur.driveDist || Trips.cur.dist)}</div>`;
    else if (st.pos) html += `<div class="mode-row">Ahora mismo: <b>${{ still: 'parado', walk: 'andando', run: 'corriendo', car: 'en coche' }[Trips.mode]}</b></div>`;
    const recent = all.slice().reverse().filter(x => ymOf(x.start) === tripMonth).slice(0, 40);
    if (recent.length) {
      html += `<div class="section-label">Viajes</div><div class="group">${recent.map(x => {
        const d = new Date(x.start);
        const when = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        return `<div class="opt"><span class="score-ring s${x.score >= 75 ? 'ok' : x.score >= 55 ? 'mid' : 'bad'}">${x.score}</span>
          <span class="lbl">${x.dest ? esc(x.dest) : fmt.dist(x.km * 1000)}<small>${when} · ${x.dest ? fmt.dist(x.km * 1000) + ' · ' : ''}${hm(x.moving)}${x.brakes + x.accels ? ` · ${x.brakes} frenazo${x.brakes === 1 ? '' : 's'}, ${x.accels} ${x.accels === 1 ? 'acelerón' : 'acelerones'}` : ''}</small></span>
          <button type="button" class="icon-plain car-del" data-deltrip="${x.id}" aria-label="Borrar viaje">${ic('i-x')}</button></div>`;
      }).join('')}</div>`;
    }
    html += `<div class="group">${sw('autoTrips', 'Grabar viajes automáticamente', 'Suma los km y descuenta la gasolina sola')}</div>
      <p class="fine">Funciona con Vigía abierta: el iPhone no deja que una web use la ubicación con la app cerrada. Llévala delante en el soporte. La nota baja con frenazos y acelerones fuertes.</p>`;
    return html;
  }
  function onTripsClick(t) {
    if (t.dataset.month) { const n = shiftMonth(tripMonth, +t.dataset.month); if (n <= todayISO().slice(0, 7)) tripMonth = n; openCar(); return true; }
    if (t.dataset.act === 'parking') { openParking(); return true; }
    if (t.dataset.act === 'parkHere' && st.pos) { car.parking = { lat: st.pos.lat, lon: st.pos.lon, t: now() }; saveCar(); drawParking(); openCar(); toast('Aparcamiento guardado'); return true; }
    if (t.dataset.fuelset) { setFuelLevel(tankL() * +t.dataset.fuelset); openCar(); toast(`Depósito: ${fmt.liters(fuelLeft())}`); return true; }
    if (t.dataset.deltrip) {
      const list = tripsAll(), x = list.find(i => i.id === t.dataset.deltrip);
      saveTrips(list.filter(i => i !== x)); openCar();
      toast('Viaje borrado', { label: 'Deshacer', fn: () => { const l = tripsAll(); l.push(x); l.sort((a, b) => a.start - b.start); saveTrips(l); openCar(); } });
      return true;
    }
    return false;
  }
  Trips.restore();

  // ---------- ¿Cuándo reposto? ----------
  // Con la gasolina que te queda, busca la gasolinera más barata a menos de 1,2 km de tu ruta
  // a la que llegas con margen.
  function refuelPlan(route) {
    if (route._refuel !== undefined && route._refuelAt === (car.fuelLevel && car.fuelLevel.t)) return route._refuel;
    route._refuelAt = car.fuelLevel && car.fuelLevel.t;
    const r = rangeKm();
    if (r == null) return (route._refuel = null);
    const total = route.distance / 1000;
    if (r - total > 50) return (route._refuel = { ok: true, left: r - total });
    const fuel = P().fuel, line = route.line, [a, b, c, d] = line.bbox, m = 0.02;
    const maxAlong = Math.max(0, (r - 20) * 1000), cands = [];
    for (const s of st.stations) {
      const p = s.prices[fuel];
      if (p == null || s.lon < a - m || s.lon > c + m || s.lat < b - m || s.lat > d + m) continue;
      const pr = V.project(line, s.lat, s.lon);
      if (pr.dist < 1200 && pr.along <= maxAlong) cands.push({ s, p, along: pr.along });
    }
    if (!cands.length) return (route._refuel = { ok: false, none: true, range: r });
    cands.sort((x, y) => x.p - y.p || y.along - x.along);
    const best = cands[0], avg = cands.reduce((s2, x) => s2 + x.p, 0) / cands.length;
    const liters = Math.max(5, tankL() - Math.max(0, fuelLeft() - best.along / 1000 * S.consumption / 100));
    return (route._refuel = { ok: false, best, save: Math.max(0, (avg - best.p) * liters), liters, range: r });
  }
  function refuelLine(route) {
    const f = refuelPlan(route);
    if (!f) return '';
    if (f.ok) return `<div class="refuel ok">${ic('i-fuel')}<span>No hace falta repostar: llegarás con gasolina para unos ${Math.round(f.left / 10) * 10} km</span></div>`;
    if (f.none) return `<div class="refuel bad">${ic('i-fuel')}<span>Te da para unos ${Math.round(f.range)} km y no hay gasolineras en el camino a tu alcance. Reposta antes de salir.</span></div>`;
    return `<button type="button" class="refuel warn" data-station="${esc(f.best.s.id)}">${ic('i-fuel')}<span><b>Reposta en ${esc(V.brandName(f.best.s.brand))}</b>, en el km ${Math.round(f.best.along / 1000)} de la ruta · ${fmt.price(f.best.p)} €/L${f.save >= 0.5 ? ` · ahorras unos ${fmt.eur(f.save)}` : ''}</span></button>`;
  }

  // ---------- Zonas de bajas emisiones (ZBE) ----------
  // Las zonas salen de OpenStreetMap. Las normas cambian según la ciudad, así que solo avisa.
  const zbeCache = new Map();
  async function zbeZones(bbox) {
    const [a, b, c, d] = bbox.map(x => +x.toFixed(2));
    const key = [a, b, c, d].join(',');
    if (zbeCache.has(key)) return zbeCache.get(key);
    const q = `[out:json][timeout:25];(relation["boundary"="low_emission_zone"](${b},${a},${d},${c});way["boundary"="low_emission_zone"](${b},${a},${d},${c}););out geom;`;
    for (const base of CONFIG.overpassList) {
      try {
        const r = await fetchTimeout(`${base}?data=${encodeURIComponent(q)}`, 30000);
        if (!r.ok) continue;
        const j = await r.json();
        const zones = (j.elements || []).map(e => {
          const ways = e.type === 'way' ? [e.geometry] : (e.members || []).filter(mm => mm.type === 'way' && mm.role !== 'inner' && mm.geometry).map(mm => mm.geometry);
          const rings = joinRings(ways.map(g => g.map(p => [p.lon, p.lat])));
          const tags = e.tags || {};
          return { name: tags.name || tags['name:es'] || 'Zona de bajas emisiones', rings };
        }).filter(z => z.rings.length);
        zbeCache.set(key, zones);
        return zones;
      } catch { /* siguiente servidor */ }
    }
    return [];
  }
  function joinRings(parts) {
    const rings = [], open = parts.map(p => p.slice());
    while (open.length) {
      let ring = open.shift();
      let guard = 0;
      while ((ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) && guard++ < 500) {
        const end = ring[ring.length - 1];
        const i = open.findIndex(p => (p[0][0] === end[0] && p[0][1] === end[1]) || (p[p.length - 1][0] === end[0] && p[p.length - 1][1] === end[1]));
        if (i < 0) break;
        const nx = open.splice(i, 1)[0];
        ring = ring.concat(nx[0][0] === end[0] && nx[0][1] === end[1] ? nx.slice(1) : nx.reverse().slice(1));
      }
      if (ring.length > 3) rings.push(ring);
    }
    return rings;
  }
  function inRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  async function checkZbe(route) {
    if (route.zbe !== undefined) return route.zbe;
    route.zbe = null;
    const zones = await zbeZones(route.line.bbox);
    const coords = route.coords, step = Math.max(1, Math.floor(coords.length / 400)), hits = new Set();
    for (const z of zones) {
      for (let i = 0; i < coords.length; i += step) if (z.rings.some(rg => inRing(coords[i], rg))) { hits.add(z.name); break; }
    }
    route.zbe = [...hits];
    return route.zbe;
  }
  function zbeAdvice() {
    const l = P().label;
    if (l === '0' || l === 'ECO' || l === 'C') return 'Con tu etiqueta puedes entrar sin problema.';
    if (l === 'B') return 'Con etiqueta B se puede entrar en casi todas, pero algunas limitan el centro o los días de mucha contaminación. Mira las normas de esa ciudad.';
    if (l === 'none') return 'Sin etiqueta normalmente no puedes entrar y te pueden multar.';
    return 'Pon tu etiqueta en Mi coche para saber si puedes entrar.';
  }
  function zbeLine(route) {
    if (!route.zbe || !route.zbe.length) return '';
    const bad = P().label === 'none';
    return `<div class="refuel ${bad ? 'bad' : 'warn'}">${ic('i-shield')}<span><b>Pasas por ${esc(route.zbe.slice(0, 2).join(' y '))}</b> (zona de bajas emisiones). ${esc(zbeAdvice())}</span></div>`;
  }
  async function annotateRoutes() {
    const sel = selectedRoute(); if (!sel) return;
    await checkZbe(sel).catch(() => {});
    renderPlanner();
  }

  // ---------- Viajar juntos (grupo de amigos y modo copiloto) ----------
  // Cada uno comparte su posición con el grupo mientras tiene Vigía abierta. Cualquiera puede
  // mandar un destino al grupo: el copiloto lo busca en su móvil y al conductor le llega para tocar «Ir».
  const MEMBER_COLORS = ['#FF5CA8', '#FFC83A', '#9B6BFF', '#34D873', '#FF8A3D', '#3D8BFF', '#00E0C6', '#FF4554'];
  const Group = {
    code: store.get('group', null), es: null, members: new Map(), markers: new Map(), lastSent: 0,
    topic() { return 'vigia-g-' + this.code; },
    name() { return (S.nick || '').trim() || 'Conductor ' + deviceId.slice(0, 3).toUpperCase(); },
    newCode() { const c = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)]; return s; },
    join(code) {
      this.leave(true);
      this.code = code; store.set('group', code);
      try {
        this.es = new EventSource(`${CONFIG.ntfy}/${this.topic()}/sse?since=2m`);
        this.es.onmessage = ev => { try { const m = JSON.parse(ev.data); if (m.event === 'message') this.onMsg(JSON.parse(m.message)); } catch { /* mensaje raro */ } };
      } catch { toast('No se pudo conectar con el grupo'); }
      this.sendPos(true); renderGroupPill();
    },
    leave(quiet) {
      if (this.es) { this.es.close(); this.es = null; }
      if (this.code && !quiet) this.send({ t: 'bye' });
      this.markers.forEach(mk => mk.remove()); this.markers.clear(); this.members.clear();
      if (!quiet) { this.code = null; store.set('group', null); }
      renderGroupPill();
    },
    async send(p) {
      if (!this.code) return;
      try { await fetchTimeout(`${CONFIG.ntfy}/`, 12000, { method: 'POST', body: JSON.stringify({ topic: this.topic(), message: JSON.stringify({ ...p, d: deviceId, n: this.name() }) }) }); } catch { /* sin conexión */ }
    },
    sendPos(force) {
      if (!this.code || !st.pos || (!force && now() - this.lastSent < 12000)) return;
      this.lastSent = now();
      const n = st.nav, eta = n && n.route.distance > 0 ? Math.round(n.route.duration * Math.max(0, n.route.distance - (n.progress || 0)) / n.route.distance) : null;
      this.send({ t: 'p', la: +st.pos.lat.toFixed(5), lo: +st.pos.lon.toFixed(5), h: st.heading != null ? Math.round(st.heading) : null,
        v: Math.round(st.speed), dest: st.nav && st.dest ? st.dest.name : null, eta });
    },
    onMsg(p) {
      if (!p || p.d === deviceId) return;
      if (p.t === 'bye') { this.drop(p.d); return; }
      if (p.t === 'p' && Number.isFinite(p.la)) {
        const m = this.members.get(p.d) || { color: MEMBER_COLORS[this.members.size % MEMBER_COLORS.length] };
        Object.assign(m, { name: p.n, lat: p.la, lon: p.lo, v: p.v, dest: p.dest, eta: p.eta, t: now() });
        this.members.set(p.d, m); this.draw(p.d); renderGroupPill();
      }
      if (p.t === 'dest' && Number.isFinite(p.la)) {
        play('near');
        toast(`${p.n} propone ir a ${p.name}`, { label: 'Ir', fn: () => goTo({ name: p.name, sub: p.sub || '', lat: p.la, lon: p.lo }) });
      }
      if (p.t === 'msg') toast(`${p.n}: ${p.text}`);
    },
    draw(id) {
      const m = this.members.get(id); if (!m) return;
      let mk = this.markers.get(id);
      if (!mk) {
        const el = document.createElement('div'); el.className = 'buddy';
        mk = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([m.lon, m.lat]).addTo(map);
        this.markers.set(id, mk);
      }
      mk.getElement().innerHTML = `<span class="buddy-dot" style="--c:${m.color}">${esc((m.name || '?').trim()[0] || '?').toUpperCase()}</span><span class="buddy-name">${esc(m.name)}${m.v > 5 ? ` · ${m.v} km/h` : ''}</span>`;
      mk.setLngLat([m.lon, m.lat]);
    },
    drop(id) { const mk = this.markers.get(id); if (mk) mk.remove(); this.markers.delete(id); this.members.delete(id); renderGroupPill(); },
    prune() { for (const [id, m] of this.members) if (now() - m.t > 3 * 60e3) this.drop(id); },
  };
  setInterval(() => { Group.sendPos(); Group.prune(); }, 5000);
  function goTo(dest) {
    if (st.nav) endNav();
    st.dest = dest; addRecent(dest); closeSheet(); renderSearchBar();
    destMarker.setLngLat([dest.lon, dest.lat]).addTo(map);
    planRoute();
  }
  const inviteUrl = () => `${location.origin}${location.pathname}?grupo=${Group.code}`;
  function renderGroupPill() {
    let el = $('#groupPill');
    if (!Group.code) { if (el) el.hidden = true; return; }
    if (!el) {
      el = document.createElement('button'); el.id = 'groupPill'; el.type = 'button'; el.className = 'group-pill glass';
      el.addEventListener('click', openGroup);
      document.querySelector('.hud-top').appendChild(el);
    }
    el.hidden = false;
    const n = Group.members.size;
    el.innerHTML = `${ic('i-me')}<span>${n ? `${n + 1} en el grupo` : 'Grupo: esperando a los demás'}</span>`;
  }
  function openGroup() {
    if (!Group.code) {
      openSheet('group', 'Viajar juntos', `
        <p class="fine" style="margin:0">Crea un grupo y pasa el enlace por WhatsApp. Veréis en el mapa dónde está cada uno mientras tengáis Vigía abierta, y podréis mandaros destinos.</p>
        <div class="group"><label class="opt"><span class="lbl">Tu nombre<small>Lo verán los demás</small></span><input class="car-input" id="nickIn" maxlength="20" value="${esc(S.nick || '')}" placeholder="Gerard"></label></div>
        <button type="button" class="btn-grad" data-act="create">${ic('i-me')}Crear grupo</button>
        <div class="group"><label class="opt"><span class="lbl">¿Te han pasado un código?</span><input class="car-input" id="codeIn" maxlength="40" placeholder="abc23xyz"></label></div>
        <button type="button" class="btn-ghost" data-act="joinCode">Unirme con el código</button>
        <div class="section-label">Modo copiloto</div>
        <p class="fine" style="margin:0">Tu acompañante se une al grupo desde su móvil, busca el destino y pulsa «Enviar al grupo». A ti te llega para tocar «Ir», sin soltar el volante.</p>`);
    } else {
      const list = [...Group.members.values()];
      openSheet('group', 'Viajar juntos', `
        <div class="group">
          <div class="opt"><span class="buddy-dot" style="--c:var(--teal)">${esc(Group.name()[0].toUpperCase())}</span><span class="lbl">${esc(Group.name())} (tú)<small>${st.nav && st.dest ? 'Yendo a ' + esc(st.dest.name) : 'Compartiendo tu ubicación'}</small></span></div>
          ${list.map(m => `<button type="button" class="opt car-row" data-buddy="${esc(m.name)}" data-la="${m.lat}" data-lo="${m.lon}"><span class="buddy-dot" style="--c:${m.color}">${esc((m.name || '?')[0].toUpperCase())}</span>
            <span class="lbl">${esc(m.name)}<small>${st.pos ? 'A ' + fmt.dist(V.haversine(st.pos.lat, st.pos.lon, m.lat, m.lon)) : ''}${m.v > 5 ? ` · ${m.v} km/h` : ' · parado'}${m.dest ? ' · va a ' + esc(m.dest) + (m.eta ? ', llega en ' + fmt.dur(m.eta) : '') : ''}</small></span><span class="chev">›</span></button>`).join('')}
          ${list.length ? '' : '<div class="opt"><span class="lbl">Todavía no se ha unido nadie<small>Pásales el enlace</small></span></div>'}
        </div>
        <button type="button" class="btn-grad" data-act="share">${ic('i-up')}Invitar (WhatsApp, mensajes…)</button>
        ${st.dest ? `<button type="button" class="btn-ghost" data-act="sendDest">Enviar «${esc(st.dest.name)}» al grupo</button>` : '<p class="fine" style="margin:0">Para mandar un destino al grupo, búscalo arriba y luego vuelve aquí.</p>'}
        <div class="test"><button type="button" data-msg="Voy">«Voy»</button><button type="button" data-msg="Paramos a repostar">«Paramos»</button><button type="button" data-msg="Llego en 5 min">«5 min»</button></div>
        <p class="fine" style="margin:0">Código del grupo: <b>${esc(Group.code)}</b>. Solo lo ve quien tenga el enlace.</p>
        <button type="button" class="link-btn danger" data-act="leave">Salir del grupo</button>`);
    }
    $('#sheetBody').onchange = null;
    $('#sheetBody').onclick = async e => {
      const t = e.target.closest('button'); if (!t) return;
      const saveNick = () => { const v = ($('#nickIn') || {}).value; if (v != null) { S.nick = v.trim(); saveS(); } };
      if (t.dataset.act === 'create') { saveNick(); Group.join(Group.newCode()); openGroup(); shareInvite(); }
      if (t.dataset.act === 'joinCode') {
        saveNick();
        const raw = ($('#codeIn').value || '').trim(); const code = (raw.match(/grupo=([a-z0-9]+)/i) || [])[1] || raw.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (code.length < 6) { toast('Ese código no es válido'); return; }
        Group.join(code); openGroup(); toast('Te has unido al grupo');
      }
      if (t.dataset.act === 'share') shareInvite();
      if (t.dataset.act === 'leave') { Group.leave(); closeSheet(); toast('Has salido del grupo'); }
      if (t.dataset.act === 'sendDest' && st.dest) { await Group.send({ t: 'dest', name: st.dest.name, sub: st.dest.sub || '', la: st.dest.lat, lo: st.dest.lon }); toast('Destino enviado al grupo'); }
      if (t.dataset.msg) { await Group.send({ t: 'msg', text: t.dataset.msg }); toast('Enviado'); }
      if (t.dataset.buddy) { closeSheet(); setFollow(false); map.flyTo({ center: [+t.dataset.lo, +t.dataset.la], zoom: 15, duration: 900 }); }
    };
  }
  async function shareInvite() {
    const text = `Únete a mi grupo en Vigía para ver dónde estamos: ${inviteUrl()}`;
    try { if (navigator.share) { await navigator.share({ title: 'Vigía', text, url: inviteUrl() }); return; } } catch { return; }
    try { await navigator.clipboard.writeText(inviteUrl()); toast('Enlace copiado'); } catch { toast(inviteUrl()); }
  }
  // Abrir un enlace de invitación (…/vigia/?grupo=xxxx)
  (() => {
    const code = new URLSearchParams(location.search).get('grupo');
    if (code && /^[a-z0-9]{6,20}$/i.test(code)) {
      history.replaceState(null, '', location.pathname);
      setTimeout(() => { if (Group.code !== code.toLowerCase()) { Group.join(code.toLowerCase()); toast('Te has unido al grupo'); } openGroup(); }, 1200);
    } else if (Group.code) setTimeout(() => Group.join(Group.code), 1500);
  })();

  // ---------- Ranking de avisadores ----------
  // Tus avisos y confirmaciones suben tu nivel (se guarda en este móvil). El ranking del día
  // cuenta los avisos de las últimas 12 horas de todos los conductores de Vigía.
  const LEVELS = [[0, 'Novato', '🌱'], [5, 'Vigilante', '👀'], [20, 'Centinela', '🛡️'], [50, 'Halcón', '🦅'], [120, 'Leyenda', '👑']];
  const myStats = () => Object.assign({ reports: 0, votes: 0 }, store.get('myStats', {}));
  function addMyStat(k) { const s = myStats(); s[k]++; store.set('myStats', s); }
  const myPoints = () => { const s = myStats(); return s.reports * 3 + s.votes; };
  function levelOf(pts) { let L = LEVELS[0], next = null; for (let i = 0; i < LEVELS.length; i++) if (pts >= LEVELS[i][0]) { L = LEVELS[i]; next = LEVELS[i + 1] || null; } return { L, next }; }
  function rankingToday() {
    const pts = new Map();
    for (const m of st.cmsgs || []) {
      let p; try { p = JSON.parse(m.message); } catch { continue; }
      if (!p || !p.d || (p.t !== 'r' && p.t !== 'v')) continue;
      const e = pts.get(p.d) || { pts: 0, name: null };
      e.pts += p.t === 'r' ? 3 : (p.v > 0 ? 1 : 0); if (p.n) e.name = p.n;
      pts.set(p.d, e);
    }
    return [...pts.entries()].filter(([, e]) => e.pts > 0).sort((a, b) => b[1].pts - a[1].pts).slice(0, 10);
  }
  function levelHtml() {
    const p = myPoints(), { L, next } = levelOf(p), s = myStats();
    const pct = next ? Math.round((p - L[0]) / (next[0] - L[0]) * 100) : 100;
    return `<button type="button" class="level-card" data-act="ranking"><span class="lv-emoji">${L[2]}</span>
      <span class="lv-main"><b>${L[1]}</b><small>${s.reports} avisos · ${s.votes} confirmaciones${next ? ` · ${next[0] - p} puntos para ${next[1]}` : ' · nivel máximo'}</small>
      <span class="lv-bar"><span style="width:${pct}%"></span></span></span><span class="chev">›</span></button>`;
  }
  function openRanking() {
    const top = rankingToday();
    openSheet('ranking', 'Avisadores', `
      ${levelHtml().replace('data-act="ranking"', 'data-act="none"').replace('<span class="chev">›</span>', '')}
      <div class="section-label">Insignias</div>
      <div class="badges">${LEVELS.map(([min, n, e]) => `<div class="badge ${myPoints() >= min ? 'on' : ''}"><span>${e}</span><small>${n}</small><small class="b-min">${min} pts</small></div>`).join('')}</div>
      <div class="section-label">Top de hoy (últimas 12 h)</div>
      <div class="group">${top.length ? top.map(([id, e], i) => `<div class="opt"><span class="rank-n">${i + 1}</span><span class="lbl">${id === deviceId ? '<b>Tú</b>' : esc(e.name || 'Conductor ' + id.slice(0, 3).toUpperCase())}</span><b>${e.pts} pts</b></div>`).join('')
        : '<div class="opt"><span class="lbl">Hoy nadie ha avisado todavía<small>¡Sé el primero!</small></span></div>'}</div>
      <div class="group"><label class="opt"><span class="lbl">Tu nombre en el ranking<small>Si lo dejas vacío, sales como «Conductor»</small></span><input class="car-input" id="nickIn2" maxlength="20" value="${esc(S.nick || '')}" placeholder="Gerard"></label></div>
      <p class="fine" style="margin:0">Avisar de un radar: 3 puntos. Confirmar uno: 1 punto. Avisa solo como copiloto o parado.</p>`);
    $('#sheetBody').onclick = null;
    $('#sheetBody').onchange = e => { if (e.target.id === 'nickIn2') { S.nick = e.target.value.trim(); saveS(); toast('Nombre guardado'); } };
  }

  // ---------- Límite de velocidad de la calle ----------
  // Calles con su límite (OpenStreetMap) en ~1 km a tu alrededor; se vuelve a pedir al salir de esa zona.
  const SpeedLimit = {
    ways: [], box: null, loading: false, cur: null, lastTry: 0,
    parse(v) {
      if (!v) return null;
      v = String(v).toLowerCase().trim();
      const n = parseInt(v, 10);
      if (n > 0 && n < 200) return v.includes('mph') ? Math.round(n * 1.609) : n;
      return { 'es:urban': 50, 'es:zone30': 30, 'es:zone20': 20, 'es:rural': 90, 'es:trunk': 100, 'es:motorway': 120, 'es:living_street': 20, 'walk': 10 }[v] || null;
    },
    async load(lat, lon) {
      if (this.loading || now() - this.lastTry < 15000) return;
      this.loading = true; this.lastTry = now();
      const d = 0.012, bbox = [lat - d, lon - d * 1.35, lat + d, lon + d * 1.35];
      const q = `[out:json][timeout:20];way["highway"]["highway"!~"footway|path|cycleway|steps|pedestrian|track|bridleway|service"](${bbox.join(',')});out tags geom;`;
      for (const base of CONFIG.overpassList) {
        try {
          const r = await fetchTimeout(`${base}?data=${encodeURIComponent(q)}`, 25000);
          if (!r.ok) continue;
          const j = await r.json();
          this.ways = (j.elements || []).filter(e => e.geometry && e.geometry.length > 1).map(e => {
            const t = e.tags || {};
            return { pts: e.geometry.map(p => [p.lat, p.lon]), oneway: t.oneway === 'yes' || t.junction === 'roundabout' || /motorway/.test(t.highway),
              max: this.parse(t.maxspeed), fwd: this.parse(t['maxspeed:forward']), bwd: this.parse(t['maxspeed:backward']),
              hw: t.highway, name: t.name || t.ref || '' };
          });
          this.box = bbox;
          break;
        } catch { /* siguiente servidor */ }
      }
      this.loading = false;
    },
    // Calle más cercana que va en tu dirección
    match(lat, lon, heading) {
      let best = null;
      const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
      for (const w of this.ways) {
        for (let i = 1; i < w.pts.length; i++) {
          const [la1, lo1] = w.pts[i - 1], [la2, lo2] = w.pts[i];
          const ax = (lo1 - lon) * kx, ay = (la1 - lat) * ky, bx = (lo2 - lon) * kx, by = (la2 - lat) * ky;
          const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
          const tt = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L));
          const dist = Math.hypot(ax + tt * dx, ay + tt * dy);
          if (dist > 30) continue;
          let penalty = 0, back = false;
          if (heading != null && st.speed > 8) {
            const segB = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, diff = V.angleDiff(heading, segB);
            back = diff > 90;
            penalty = Math.min(diff, 180 - diff) * 0.4 + (back && w.oneway ? 60 : 0);
          }
          const score = dist + penalty;
          if (!best || score < best.score) best = { score, w, back };
        }
      }
      if (!best) return null;
      const w = best.w;
      return (best.back ? w.bwd : w.fwd) || w.max || null;
    },
    onFix(lat, lon) {
      if (S.showLimit === false) { this.cur = null; return; }
      const b = this.box, m = 0.004;
      if (!b || lat < b[0] + m || lat > b[2] - m || lon < b[1] + m * 1.35 || lon > b[3] - m * 1.35) this.load(lat, lon);
      this.cur = this.match(lat, lon, st.heading);
    },
  };
  const streetLimit = () => SpeedLimit.cur;

  // ---------- Tráfico: incidencias y cámaras de la DGT ----------
  const INC = {
    acc: { label: 'Accidente', color: '#FF4554', icon: 'i-alert' },
    obr: { label: 'Obras', color: '#FF8A3D', icon: 'i-lanes' },
    cor: { label: 'Corte o carril cerrado', color: '#FF4554', icon: 'i-x' },
    ret: { label: 'Retención', color: '#FFC83A', icon: 'i-car' },
    met: { label: 'Tiempo adverso', color: '#6FB7FF', icon: 'i-alert' },
    obs: { label: 'Obstáculo en la vía', color: '#FF8A3D', icon: 'i-alert' },
    inc: { label: 'Incidencia', color: '#FFC83A', icon: 'i-alert' },
  };
  st.incidents = []; st.cameras = []; st.trafficAt = null;
  async function loadTraffic(cams) {
    try {
      const r = await fetchTimeout('data/incidencias.json?v=' + Math.floor(now() / 300e3), 20000);
      if (r.ok) {
        const j = await r.json();
        st.incidents = (j.i || []).map(x => ({ id: x[0], kind: INC[x[1]] ? x[1] : 'inc', lat: x[2], lon: x[3], lat2: x[4], lon2: x[5], road: x[6], detail: x[7], start: x[8] }));
        st.trafficAt = new Date(j.actualizado);
        drawTraffic(); refreshRouteIncidents();
      }
    } catch { /* aún no hay datos */ }
    if (!cams) return;
    try {
      const r = await fetchTimeout('data/camaras.json?v=' + Math.floor(now() / 3600e3), 20000);
      if (r.ok) { const j = await r.json(); st.cameras = (j.c || []).map(x => ({ id: x[0], lat: x[1], lon: x[2], road: x[3], km: x[4], url: x[5] })); drawTraffic(); }
    } catch { /* aún no hay datos */ }
  }
  function trafficImage(id) {
    const [, kind] = id.split(':');
    const isCam = kind === 'cam', c = document.createElement('canvas'), px = 2, size = isCam ? 30 : 36;
    c.width = c.height = size * px;
    const ctx = c.getContext('2d'); ctx.scale(px, px);
    if (isCam) {
      ctx.beginPath(); ctx.roundRect(3, 3, 24, 24, 7); ctx.fillStyle = '#1E2A44'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#8FB4FF'; ctx.stroke();
      ctx.fillStyle = '#8FB4FF'; ctx.beginPath(); ctx.roundRect(8, 11, 11, 8, 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(19, 13.5); ctx.lineTo(23, 11); ctx.lineTo(23, 19); ctx.lineTo(19, 16.5); ctx.fill();
      return ctx.getImageData(0, 0, c.width, c.height);
    }
    const k = INC[kind] || INC.inc;
    // Triángulo de aviso con el color del tipo
    ctx.beginPath(); ctx.moveTo(18, 3); ctx.lineTo(34, 31); ctx.lineTo(2, 31); ctx.closePath();
    ctx.fillStyle = k.color; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.fillStyle = '#0B1220'; ctx.font = '700 15px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText({ acc: '!', obr: '⚒', cor: '⛔', ret: '≡', met: '☁', obs: '!', inc: '!' }[kind] || '!', 18, 27);
    return ctx.getImageData(0, 0, c.width, c.height);
  }
  map.on('styleimagemissing', e => { if (e.id.startsWith('tf:') && !map.hasImage(e.id)) map.addImage(e.id, trafficImage(e.id), { pixelRatio: 2 }); });
  function addTrafficLayers() {
    const before = map.getLayer('radars') ? 'radars' : undefined;
    map.addSource('vg-cam', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('vg-inc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'vg-cam', type: 'symbol', source: 'vg-cam', minzoom: 9,
      layout: { 'icon-image': 'tf:cam', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 0.9] } }, before);
    map.addLayer({ id: 'vg-inc', type: 'symbol', source: 'vg-inc', minzoom: 6,
      layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.55, 13, 0.95] } }, before);
    drawTraffic();
  }
  map.on('style.load', addTrafficLayers);
  function drawTraffic() {
    const set = (id, feats) => { const s2 = map.getSource(id); if (s2) s2.setData({ type: 'FeatureCollection', features: feats }); };
    set('vg-inc', S.md_inc === false ? [] : st.incidents.map(x => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.lon, x.lat] }, properties: { id: x.id, icon: 'tf:' + x.kind } })));
    set('vg-cam', !S.md_cam ? [] : st.cameras.map(x => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.lon, x.lat] }, properties: { id: x.id } })));
  }
  map.on('click', 'vg-inc', e => { const f = e.features && e.features[0]; if (f) openIncident(f.properties.id); });
  map.on('click', 'vg-cam', e => { const f = e.features && e.features[0]; if (f) openCamera(f.properties.id); });
  ['vg-inc', 'vg-cam'].forEach(l => { map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; }); map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; }); });
  const incTitle = x => INC[x.kind].label + (x.detail ? ` · ${x.detail}` : '');
  function openIncident(id) {
    const x = st.incidents.find(i => i.id === id); if (!x) return;
    const d = st.pos ? V.haversine(st.pos.lat, st.pos.lon, x.lat, x.lon) : null;
    const since = x.start ? new Date(x.start).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    openSheet('incident', INC[x.kind].label, `
      <div class="facts"><div>${ic('i-alert')}${esc(incTitle(x))}</div>
        ${x.road ? `<div>${ic('i-map')}${esc(x.road)}</div>` : ''}
        ${since ? `<div>${ic('i-clock')}Desde el ${esc(since)}</div>` : ''}
        ${d != null ? `<div>${ic('i-locate')}A ${fmt.dist(d)} de ti</div>` : ''}</div>
      <p class="fine" style="margin:0">Fuente: ${x.id.startsWith('sct') ? 'Servei Català de Trànsit' : 'DGT'}${st.trafficAt ? ' · actualizado ' + relTime(st.trafficAt.getTime()) : ''}.</p>`);
    $('#sheetBody').onclick = null; $('#sheetBody').onchange = null;
  }
  let camTimer = null;
  function openCamera(id) {
    const x = st.cameras.find(c => String(c.id) === String(id)); if (!x) return;
    const src = () => x.url + (x.url.includes('?') ? '&' : '?') + 't=' + Math.floor(now() / 30000);
    openSheet('camera', x.road ? `Cámara ${x.road}` : 'Cámara DGT', `
      <img class="cam-img" id="camImg" src="${esc(src())}" alt="Imagen en directo de la cámara">
      <p class="fine" style="margin:0">${x.km ? `Km ${esc(x.km)} · ` : ''}Imagen en directo de la DGT. Se actualiza sola cada 30 segundos.</p>`);
    $('#sheetBody').onclick = null; $('#sheetBody').onchange = null;
    const img = $('#camImg'); img.onerror = () => { img.replaceWith(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Esta cámara no está emitiendo ahora mismo.' })); };
    clearInterval(camTimer);
    camTimer = setInterval(() => { const el = $('#camImg'); if (!el || sheetKind !== 'camera') { clearInterval(camTimer); return; } el.src = src(); }, 30000);
  }
  // Incidencias en la ruta
  function routeIncidents(route) {
    if (!st.incidents.length || S.md_inc === false) return [];
    return V.radarsOnLine(route.line, st.incidents, 120).map(x => ({ inc: x.radar, along: x.along })).sort((a, b) => a.along - b.along);
  }
  function incidentsLine(route) {
    const list = routeIncidents(route);
    if (!list.length) return '';
    const first = list[0].inc;
    return `<button type="button" class="refuel bad" data-inc="${esc(first.id)}">${ic('i-alert')}<span><b>${list.length} incidencia${list.length === 1 ? '' : 's'} en tu ruta</b>: ${esc(incTitle(first).toLowerCase())}${first.road ? ' en ' + esc(first.road) : ''}, en el km ${Math.round(list[0].along / 1000)}${list.length > 1 ? ' y más' : ''}</span></button>`;
  }
  function refreshRouteIncidents() {
    if (st.nav) st.nav.incOn = routeIncidents(st.nav.route);
    if (st.routes && st.routes.length) renderPlanner();
  }
  // Aviso a 2 km de una incidencia en la ruta (una vez cada una)
  function checkNavIncidents() {
    const n = st.nav; if (!n) return;
    if (!n.incOn) n.incOn = routeIncidents(n.route);
    n.incSaid = n.incSaid || new Set();
    for (const x of n.incOn) {
      const ahead = x.along - (n.progress || 0);
      if (ahead > 0 && ahead < 2000 && !n.incSaid.has(x.inc.id)) {
        n.incSaid.add(x.inc.id);
        const txt = `${incTitle(x.inc)} a ${V.spokenDistance(ahead)}`;
        notice(txt, 8000); play('far'); if (wantAlerts()) say(txt);
      }
    }
  }

  // ---------- Peajes (estimación) ----------
  // No hay una tarifa abierta de todos los peajes: se estima con los km de peaje de la ruta (≈0,11 €/km en turismo).
  function tollEstimate(route) {
    if (!route.hasTolls) return 0;
    let m = 0;
    for (const s2 of route.steps) if ((s2.intersections || []).some(i => (i.classes || []).includes('toll'))) m += s2.distance;
    const eur = m / 1000 * 0.11;
    return eur < 0.5 ? 0.5 : Math.round(eur * 2) / 2;
  }

  // ---------- Avisos en el calendario del iPhone ----------
  // Un archivo de calendario con ITV, seguro, impuesto y revisiones con fecha: el iPhone avisa aunque no abras Vigía.
  function calendarFile() {
    const ev = [];
    const ymd = iso => iso.replace(/-/g, '');
    const add = (iso, title, desc) => {
      if (!iso || daysUntil(iso) < -1) return;
      const end = new Date(iso + 'T12:00:00'); end.setDate(end.getDate() + 1);
      ev.push(['BEGIN:VEVENT', `UID:vigia-${ymd(iso)}-${title.replace(/\W+/g, '')}@vigia`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
        `DTSTART;VALUE=DATE:${ymd(iso)}`, `DTEND;VALUE=DATE:${ymd(end.toISOString().slice(0, 10))}`, `SUMMARY:${title}`, `DESCRIPTION:${desc}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'TRIGGER:-P30D', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'TRIGGER:-P7D', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'TRIGGER:-PT9H', 'END:VALARM', 'END:VEVENT'].join('\r\n'));
    };
    const name = carName();
    for (const d of DOCS) if (car.docs[d.k]) add(car.docs[d.k], `${d.name} · ${name}`, `Vence hoy. Recordatorio de Vigía.`);
    for (const it of maintList()) {
      const last = car.maint[it.k];
      if (last && last.date && it.months) add(addMonths(last.date, it.months), `${it.name} · ${name}`, `Toca por tiempo (o antes si llegas a los km). Recordatorio de Vigía.`);
    }
    if (!ev.length) return null;
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vigia//ES', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Vigía · ' + name, ...ev, 'END:VCALENDAR'].join('\r\n');
  }
  function exportCalendar() {
    const ics = calendarFile();
    if (!ics) { toast('Pon primero las fechas de ITV, seguro o revisiones'); return; }
    const blob = new Blob([ics], { type: 'text/calendar' });
    const file = new File([blob], 'vigia-avisos.ics', { type: 'text/calendar' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Avisos de Vigía' }).catch(() => {}); return; }
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'vigia-avisos.ics'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  if (location.hostname === 'localhost') window.__vigia = { Trips, car, refuelPlan, setFuelLevel, Group, inRing, joinRings, SpeedLimit, routeIncidents, tollEstimate, calendarFile, openCamera, openIncident };   // solo para pruebas

  // ---------- Botones ----------
  $('#searchBtn').addEventListener('click', openSearch);
  $('#clearBtn').addEventListener('click', () => clearRoute());
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#gasBtn').addEventListener('click', openGas);
  $('#carBtn').addEventListener('click', openCar);
  $('#reportBtn').addEventListener('click', openReport);
  $('#recenterBtn').addEventListener('click', () => {
    if (!fix) { toast('Todavía buscando tu ubicación…'); return; }
    setFollow(true);
  });
  $('#cheapPill').addEventListener('click', e => openStation(e.currentTarget.dataset.id));
  // Durante la ruta, cada toque cambia el modo: ambas → solo radares → solo indicaciones → nada.
  $('#voiceBtn').addEventListener('click', () => {
    const order = ['all', 'alerts', 'directions', 'none'];
    S.voiceMode = order[(order.indexOf(S.voiceMode) + 1) % order.length]; saveS(); renderVoiceBtn();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    toast('Voz: ' + VOICE_MODES[S.voiceMode].label);
    if (S.voiceMode !== 'none') setTimeout(() => say(VOICE_MODES[S.voiceMode].label), 150);
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
    setTimeout(carStartupNotice, 2500);
  });

  renderChips(); renderSearchBar(); renderSpeed(); setFollow(true);
  drawParking();
  loadOfficialRadars();
  loadPrices();
  setInterval(() => loadPrices(), 10 * 60e3);        // precios: cada 10 min
  loadTraffic(true);
  setInterval(() => loadTraffic(now() % 3600e3 < 600e3), 10 * 60e3);   // incidencias cada 10 min, cámaras cada hora
  setInterval(pollCommunity, 45e3);                  // avisos de conductores: cada 45 s
  setInterval(drawRadars, 60e3);                     // el estado de los avisos cambia con el tiempo
})();
