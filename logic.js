/* Vigía · lógica pura (sin DOM). Se puede probar con Node. */
(function (root) {
  'use strict';

  // ---------- Geometría ----------
  const R = 6371000;
  const rad = d => d * Math.PI / 180;

  function haversine(aLat, aLon, bLat, bLon) {
    const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(aLat, aLon, bLat, bLon) {
    const y = Math.sin(rad(bLon - aLon)) * Math.cos(rad(bLat));
    const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLon - aLon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function angleDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /** Prepara una ruta [[lon,lat],...] para proyectar posiciones sobre ella. */
  function prepareLine(coords) {
    const lat0 = coords.length ? coords[0][1] : 40;
    const kx = Math.cos(rad(lat0)) * 111320, ky = 110540;
    const xy = coords.map(c => [c[0] * kx, c[1] * ky]);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    }
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const c of coords) {
      if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
      if (c[0] < minLon) minLon = c[0]; if (c[0] > maxLon) maxLon = c[0];
    }
    return { coords, xy, cum, kx, ky, length: cum[cum.length - 1], bbox: [minLon, minLat, maxLon, maxLat] };
  }

  /** Distancia de un punto a la línea y posición a lo largo (m). `hint` acelera la búsqueda. */
  function project(line, lat, lon, hint) {
    const px = lon * line.kx, py = lat * line.ky;
    const n = line.xy.length;
    let from = 0, to = n - 1;
    if (hint != null && hint >= 0) { from = Math.max(0, hint - 30); to = Math.min(n - 1, hint + 400); }
    const best = scan(line, px, py, from, to);
    if (hint != null && best.dist > 120 && (from > 0 || to < n - 1)) return scan(line, px, py, 0, n - 1);
    return best;
  }

  function scan(line, px, py, from, to) {
    let best = { dist: Infinity, along: 0, idx: from };
    const xy = line.xy;
    if (from === to) {
      return { dist: Math.hypot(px - xy[from][0], py - xy[from][1]), along: line.cum[from], idx: from };
    }
    for (let i = from; i < to; i++) {
      const ax = xy[i][0], ay = xy[i][1], bx = xy[i + 1][0], by = xy[i + 1][1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best.dist) best = { dist: d, along: line.cum[i] + Math.sqrt(l2) * t, idx: i };
    }
    return best;
  }

  /** Radares a menos de `tol` m de la ruta, con su distancia desde el inicio. */
  /** Punto de la línea a `along` metros del inicio, con el rumbo del tramo. */
  function pointAt(line, along) {
    const cum = line.cum, c = line.coords, n = c.length;
    if (n < 2) return { lon: c[0][0], lat: c[0][1], bearing: 0 };
    along = Math.max(0, Math.min(line.length, along));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= along) lo = mid; else hi = mid; }
    const seg = cum[hi] - cum[lo], t = seg > 0 ? (along - cum[lo]) / seg : 0;
    const a = c[lo], b = c[hi];
    return { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, bearing: bearing(a[1], a[0], b[1], b[0]) };
  }

  function radarsOnLine(line, radars, tol = 45) {
    const [a, b, c, d] = line.bbox, m = 0.02;
    const out = [];
    for (const r of radars) {
      if (r.lon < a - m || r.lon > c + m || r.lat < b - m || r.lat > d + m) continue;
      const p = project(line, r.lat, r.lon);
      if (p.dist < tol) out.push({ radar: r, along: p.along, dist: p.dist });
    }
    return out.sort((x, y) => x.along - y.along);
  }

  // ---------- Consumo ----------
  /** Litros estimados: consumo medio corregido por velocidad media (óptimo ~70-90 km/h). */
  function fuelLiters(distance, duration, consumption) {
    const v = duration > 0 ? distance / duration * 3.6 : 80;
    let f;
    if (v < 30) f = 1.45; else if (v < 50) f = 1.25; else if (v < 70) f = 1.08;
    else f = 1 + 0.000085 * Math.max(v - 85, 0) ** 2;
    return distance / 1000 / 100 * consumption * f;
  }

  function sortRoutes(list, criterion) {
    const a = list.slice();
    if (criterion === 'shortest') return a.sort((x, y) => x.distance - y.distance);
    if (criterion === 'fastest') return a.sort((x, y) => x.duration - y.duration);
    return a.sort((x, y) =>
      Math.abs(x.liters - y.liters) / Math.max(x.liters, 0.01) < 0.03 ? x.distance - y.distance : x.liters - y.liters);
  }

  function dedupeRoutes(list) {
    const out = [];
    for (const r of list) {
      if (!out.some(o => Math.abs(o.distance - r.distance) < Math.max(50, r.distance * 0.004)
        && Math.abs(o.duration - r.duration) < 60)) out.push(r);
    }
    return out;
  }

  // ---------- Instrucciones en español (OSRM) ----------
  const SIDE = { left: 'a la izquierda', right: 'a la derecha', 'slight left': 'ligeramente a la izquierda',
    'slight right': 'ligeramente a la derecha', 'sharp left': 'bruscamente a la izquierda',
    'sharp right': 'bruscamente a la derecha', straight: 'recto', uturn: 'el cambio de sentido' };
  const ORD = ['', 'primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'séptima', 'octava'];

  function iconFor(type, mod) {
    if (type === 'arrive') return 'flag';
    if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') return 'roundabout';
    if (mod === 'uturn') return 'uturn';
    if (mod === 'left' || mod === 'sharp left') return 'left';
    if (mod === 'right' || mod === 'sharp right') return 'right';
    if (mod === 'slight left') return 'slight-left';
    if (mod === 'slight right') return 'slight-right';
    return 'straight';
  }

  function instruction(step) {
    const m = step.maneuver || {};
    const type = m.type, mod = m.modifier;
    const name = step.name || step.ref || '';
    const por = name ? ` por ${name}` : '';
    const dest = step.destinations ? ` hacia ${step.destinations.split(',')[0].split(':').pop().trim()}` : '';
    const side = SIDE[mod] || '';
    let text;
    switch (type) {
      case 'depart': text = name ? `Sal por ${name}` : 'Inicia la ruta'; break;
      case 'arrive': text = mod === 'left' ? 'Tu destino está a la izquierda'
        : mod === 'right' ? 'Tu destino está a la derecha' : 'Tu destino está más adelante'; break;
      case 'turn': case 'end of road':
        text = mod === 'uturn' ? `Haz el cambio de sentido${por}`
          : mod === 'straight' ? `Sigue recto${por}`
          : `${type === 'end of road' ? 'Al final de la vía, gira' : 'Gira'} ${side}${por}`; break;
      case 'new name': case 'continue': case 'notification':
        text = mod && mod !== 'straight' && type === 'continue' ? `Continúa ${side}${por}` : `Continúa${por}`; break;
      case 'merge': text = `Incorpórate ${side}${por}`.replace('  ', ' '); break;
      case 'on ramp': text = `Toma el acceso${dest || por}`; break;
      case 'off ramp': {
        const ex = step.exits ? ` ${step.exits.split(';')[0]}` : '';
        text = `Toma la salida${ex}${dest || por}`; break;
      }
      case 'fork': text = `En la bifurcación, mantente ${mod && mod.includes('left') ? 'a la izquierda' : 'a la derecha'}${dest || por}`; break;
      case 'roundabout': case 'rotary': case 'roundabout turn': {
        const n = m.exit;
        text = n ? `En la rotonda, toma la ${ORD[n] || n + 'ª'} salida${dest || por}` : `Entra en la rotonda${por}`; break;
      }
      case 'exit roundabout': case 'exit rotary': text = `Sal de la rotonda${por}`; break;
      default: text = side && side !== 'recto' ? `Gira ${side}${por}` : `Continúa${por}`;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), icon: iconFor(type, mod), type };
  }

  // ---------- Formatos ----------
  const comma = s => s.replace('.', ',');
  const fmt = {
    dist(m) {
      if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
      return comma((m / 1000).toFixed(m < 10000 ? 1 : 0)) + ' km';
    },
    dur(s) {
      const min = Math.round(s / 60);
      return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
    },
    eur: v => comma(v.toFixed(2)) + ' €',
    price: v => comma(v.toFixed(3)),
    liters: v => comma(v.toFixed(1)) + ' L',
  };

  function spokenDistance(m) {
    if (m >= 950) {
      const km = Math.round(m / 500) / 2;
      if (km === 1) return '1 kilómetro';
      if (Number.isInteger(km)) return `${km} kilómetros`;
      const k = Math.floor(km);
      return `${k} kilómetro${k === 1 ? '' : 's'} y medio`;
    }
    const r = m >= 300 ? Math.round(m / 100) * 100 : Math.round(m / 50) * 50;
    return `${Math.max(r, 50)} metros`;
  }

  // ---------- Gasolineras ----------
  const FUELS = [
    { key: 'g95', label: 'Gasolina 95', short: 'G95', api: ['Precio Gasolina 95 E5', 'Precio Gasolina 95 E10', 'Precio Gasolina 95 E5 Premium'] },
    { key: 'g98', label: 'Gasolina 98', short: 'G98', api: ['Precio Gasolina 98 E5', 'Precio Gasolina 98 E10'] },
    { key: 'diesel', label: 'Diésel', short: 'Diésel', api: ['Precio Gasoleo A', 'Precio Gasóleo A'] },
    { key: 'dieselPlus', label: 'Diésel Premium', short: 'Diésel+', api: ['Precio Gasoleo Premium', 'Precio Gasóleo Premium'] },
    { key: 'glp', label: 'GLP', short: 'GLP', api: ['Precio Gases licuados del petróleo', 'Precio Gases licuados del petroleo'] },
  ];

  const num = v => {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const coord = v => {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) && n !== 0 ? n : null;
  };

  /** "07/10/2026 16:37:00" (hora de España) → Date. */
  function parseFecha(f) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(f || '');
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    return isNaN(d) ? null : d;
  }

  const title = s => (s || '').toLowerCase().replace(/(^|[\s(/-])\p{L}/gu, c => c.toUpperCase());

  /** Formato compacto generado por la Action de GitHub (data/precios.json). */
  function parsePricesCompact(json) {
    return (json.e || []).map(e => {
      const prices = {}, prev = {};
      FUELS.forEach((f, i) => {
        if (e[7] && e[7][i] != null) prices[f.key] = e[7][i];
        if (e[8] && e[8][i] != null) prev[f.key] = e[8][i];
      });
      return { id: String(e[0]), brand: e[1], address: e[2], town: e[3], schedule: e[4],
        lat: e[5], lon: e[6], prices, prev, changedAt: e[9] || null, prov: e[10] || null };
    });
  }

  /** Respuesta directa de la API del Ministerio. */
  function parseMinisterio(json) {
    const out = [];
    for (const d of json.ListaEESSPrecio || []) {
      const lat = coord(d['Latitud']), lon = coord(d['Longitud (WGS84)']);
      if (lat == null || lon == null) continue;
      const prices = {};
      for (const f of FUELS) {
        for (const k of f.api) { const p = num(d[k]); if (p) { prices[f.key] = p; break; } }
      }
      if (!Object.keys(prices).length) continue;
      out.push({ id: String(d['IDEESS'] || `${lat},${lon}`), brand: (d['Rótulo'] || '').trim(),
        address: title(d['Dirección']), town: title(d['Localidad'] || d['Municipio']),
        schedule: d['Horario'] || '', lat, lon, prices, prev: {}, changedAt: null, prov: d['IDProvincia'] || null });
    }
    return out;
  }

  function brandName(b) {
    b = (b || '').trim();
    if (!b) return 'Gasolinera';
    return b.length <= 4 ? b.toUpperCase() : title(b);
  }

  // ---------- Radares ----------
  const KINDS = {
    fixed: { label: 'Radar fijo', short: 'Fijo', color: '#FF4554' },
    section: { label: 'Radar de tramo', short: 'Tramo', color: '#A55BFF' },
    mobile: { label: 'Radar móvil', short: 'Móvil', color: '#FF9A2E' },
    light: { label: 'Cámara de semáforo', short: 'Semáforo', color: '#FFD23F' },
    police: { label: 'Control policial', short: 'Control', color: '#3B7BFF' },
  };
  const LIFETIME = { mobile: 2 * 3600e3, police: 3600e3 };

  /** Radares oficiales en formato compacto: [lat, lon, tipo, límite, sentido]. */
  function parseRadarsCompact(json) {
    const code = { f: 'fixed', s: 'section', l: 'light' };
    return (json.r || []).map((r, i) => ({
      id: `of-${i}-${r[0].toFixed(4)}`, lat: r[0], lon: r[1], kind: code[r[2]] || 'fixed',
      limit: r[3] || null, dir: r[4] ?? null, source: 'official',
      road: r[5] || '', origin: r[6] || 'osm',
    }));
  }

  /** Estado de un aviso de la comunidad. */
  function radarStatus(r, now) {
    if (r.source !== 'community') return 'active';
    if (r.downs > r.ups) return 'gone';
    const life = LIFETIME[r.kind] || 6 * 3600e3;
    const age = now - (r.lastSeen || r.created);
    if (age > life) return age > life * 3 ? 'gone' : 'unconfirmed';
    return 'active';
  }

  /** Reconstruye los avisos de la comunidad a partir de los mensajes (ntfy). */
  function communityFromMessages(msgs) {
    const map = new Map(), deleted = new Set();
    const sorted = msgs.slice().sort((a, b) => a.time - b.time);
    for (const m of sorted) {
      let p; try { p = JSON.parse(m.message); } catch { continue; }
      if (!p || typeof p !== 'object') continue;
      const t = m.time * 1000;
      if (p.t === 'r' && KINDS[p.k] && Number.isFinite(p.la) && Number.isFinite(p.lo) && !map.has(p.id) && !deleted.has(p.id)) {
        map.set(p.id, { id: p.id, kind: p.k, lat: p.la, lon: p.lo, dir: Number.isFinite(p.b) ? p.b : null,
          limit: null, source: 'community', created: t, lastSeen: t, reporter: p.d,
          upSet: new Set([p.d]), downSet: new Set() });
      } else if (p.t === 'v' && map.has(p.id)) {
        const r = map.get(p.id);
        if (p.v > 0) { r.upSet.add(p.d); r.downSet.delete(p.d); r.lastSeen = Math.max(r.lastSeen, t); }
        else { r.downSet.add(p.d); r.upSet.delete(p.d); }
      } else if (p.t === 'x') {
        // Borrado: solo cuenta si lo pide el mismo dispositivo que creó el aviso.
        const r = map.get(p.id);
        if (r && r.reporter === p.d) { map.delete(p.id); deleted.add(p.id); }
      }
    }
    return [...map.values()].map(r => {
      const { upSet, downSet, ...rest } = r;
      return { ...rest, ups: upSet.size, downs: downSet.size, voters: [...upSet, ...downSet] };
    });
  }

  root.VL = { haversine, bearing, angleDiff, prepareLine, project, pointAt, radarsOnLine, fuelLiters, sortRoutes,
    dedupeRoutes, instruction, fmt, spokenDistance, FUELS, parsePricesCompact, parseMinisterio, parseFecha, brandName,
    KINDS, LIFETIME, parseRadarsCompact, radarStatus, communityFromMessages };
})(typeof window !== 'undefined' ? window : globalThis);
