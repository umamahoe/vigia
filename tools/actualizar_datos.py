#!/usr/bin/env python3
"""
Actualiza los datos de Vigía. Lo ejecuta GitHub Actions cada 30 minutos.

- data/precios.json: precios oficiales de todas las gasolineras de España
  (Ministerio para la Transición Ecológica). Si un precio cambia, se guarda el
  anterior durante 24 h para que la app muestre la flecha ↑/↓.
- data/radares.json: radares fijos, de tramo y de semáforo de España
  (DGT + Servei Català de Trànsit + OpenStreetMap). Se renueva una vez al día.
"""
import json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PRECIOS = os.path.join(DATA, "precios.json")
RADARES = os.path.join(DATA, "radares.json")

MINISTERIO = "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

FUELS = [
    ["Precio Gasolina 95 E5", "Precio Gasolina 95 E10", "Precio Gasolina 95 E5 Premium"],
    ["Precio Gasolina 98 E5", "Precio Gasolina 98 E10"],
    ["Precio Gasoleo A", "Precio Gasóleo A"],
    ["Precio Gasoleo Premium", "Precio Gasóleo Premium"],
    ["Precio Gases licuados del petróleo", "Precio Gases licuados del petroleo"],
]
DAY = 24 * 3600


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_json(url, data=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers={
        "Accept": "application/json", "User-Agent": "Vigia/1.0 (datos abiertos para app personal)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def num(v):
    if v is None or v == "":
        return None
    try:
        n = float(str(v).replace(",", "."))
        return n if n > 0 else None
    except ValueError:
        return None


def coord(v):
    """Coordenada: puede ser negativa (todo lo que está al oeste de Greenwich)."""
    if v is None or str(v).strip() == "":
        return None
    try:
        n = float(str(v).replace(",", "."))
        return n if n != 0 else None
    except ValueError:
        return None


def title(s):
    s = (s or "").strip().lower()
    out, up = [], True
    for ch in s:
        out.append(ch.upper() if up and ch.isalpha() else ch)
        up = ch in " (/-"
    return "".join(out)


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_lines(path, head, key, rows):
    """JSON con una fila por línea: git guarda los cambios de forma mucho más compacta."""
    os.makedirs(DATA, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(head, ensure_ascii=False)[:-1] + f', "{key}": [\n')
        f.write(",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows))
        f.write("\n]}\n")
    os.replace(tmp, path)


# ---------------- Precios ----------------
def build_prices(raw, old, t):
    """raw: respuesta del Ministerio. old: precios.json anterior (o None). t: epoch actual."""
    prev_by_id = {}
    for e in (old or {}).get("e", []):
        prev_by_id[str(e[0])] = e
    rows = []
    for d in raw.get("ListaEESSPrecio", []):
        lat, lon = coord(d.get("Latitud")), coord(d.get("Longitud (WGS84)"))
        if lat is None or lon is None:
            continue
        prices = []
        for keys in FUELS:
            p = next((num(d.get(k)) for k in keys if num(d.get(k))), None)
            prices.append(round(p, 3) if p else None)
        if not any(prices):
            continue
        sid = str(d.get("IDEESS") or f"{lat},{lon}")
        prev, ts = [None] * len(FUELS), 0
        o = prev_by_id.get(sid)
        if o:
            o_cur, o_prev, o_ts = o[7] or [], o[8] or [], o[9] or 0
            changed = False
            for i, p in enumerate(prices):
                oc = o_cur[i] if i < len(o_cur) else None
                if p is not None and oc is not None and abs(p - oc) > 0.0004:
                    prev[i] = oc
                    changed = True
                elif o_ts and t - o_ts < DAY and i < len(o_prev) and o_prev[i] is not None:
                    prev[i] = o_prev[i]
            ts = t if changed else (o_ts if o_ts and t - o_ts < DAY and any(prev) else 0)
            if not ts:
                prev = [None] * len(FUELS)
        rows.append([sid, (d.get("Rótulo") or "").strip(), title(d.get("Dirección")),
                     title(d.get("Localidad") or d.get("Municipio")), d.get("Horario") or "",
                     round(lat, 6), round(lon, 6), prices, prev if any(prev) else 0, ts or 0,
                     str(d.get("IDProvincia") or "")])
    return rows


def fetch_ministerio():
    """Lista completa de gasolineras. A veces el Ministerio devuelve una lista
    incompleta: se reintenta y, si sigue corta, se pide provincia a provincia."""
    best = None
    for _ in range(3):
        try:
            raw = get_json(MINISTERIO, timeout=180)
            if best is None or len(raw.get("ListaEESSPrecio", [])) > len(best.get("ListaEESSPrecio", [])):
                best = raw
            if len(best.get("ListaEESSPrecio", [])) >= 10000:
                return best
        except Exception as e:
            print(f"Ministerio (completo): {e}", file=sys.stderr)
        time.sleep(10)
    merged, fecha = {}, (best or {}).get("Fecha", "")
    for prov in range(1, 53):
        try:
            r = get_json(f"{MINISTERIO}FiltroProvincia/{prov:02d}", timeout=90)
            fecha = r.get("Fecha") or fecha
            for d in r.get("ListaEESSPrecio", []):
                merged[str(d.get("IDEESS"))] = d
        except Exception as e:
            print(f"Ministerio provincia {prov:02d}: {e}", file=sys.stderr)
    for d in (best or {}).get("ListaEESSPrecio", []):
        merged.setdefault(str(d.get("IDEESS")), d)
    return {"Fecha": fecha, "ListaEESSPrecio": list(merged.values())}


def update_prices():
    raw = fetch_ministerio()
    rows = build_prices(raw, load(PRECIOS), int(time.time()))
    if len(rows) < 8000:
        raise RuntimeError(f"Solo {len(rows)} gasolineras: no se sobrescribe")
    write_lines(PRECIOS, {"actualizado": now_iso(), "fecha_ministerio": raw.get("Fecha", "")}, "e", rows)
    print(f"Precios: {len(rows)} gasolineras")


# ---------------- Radares ----------------
# Fuentes:
#  - DGT (lista oficial, toda España salvo Cataluña y País Vasco)
#  - Servei Català de Trànsit (lista oficial de Cataluña, coordenadas UTM 31N)
#  - OpenStreetMap (completa lo que falta: País Vasco, radares urbanos, semáforos…)
# Si una fuente falla se conservan sus filas anteriores.
# Fila: [lat, lon, tipo f|s|l, límite, sentido, carretera, fuente]
DGT_URL = "https://nap.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml"
SCT_URL = "https://transit.gencat.cat/web/.content/documents/seguretat_viaria/radars.txt"
# Zonas pequeñas: una consulta para toda España tarda demasiado y el servidor la corta.
BOXES = [(lat, lon, lat + 2, lon + 2.5) for lat in (35.9, 37.9, 39.9, 41.9) for lon in (-9.4, -6.9, -4.4, -1.9, 0.6, 3.1)
         if not (lon >= 3.1 and lat < 38.5)] + [(27.5, -18.3, 29.5, -13.3), (35.1, -5.5, 35.95, -2.8)]
QUERY = ('[out:json][timeout:120];area["ISO3166-1"="ES"][admin_level=2]->.es;'
         'node["highway"="speed_camera"]({},{},{},{})(area.es)->.cams;'
         'rel(bn.cams)["type"="enforcement"]->.enf;.cams out body;.enf out body;')


def get_text(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "Vigia/1.0 (datos abiertos para app personal)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def int_prefix(s):
    digits = ""
    for ch in str(s or "").strip():
        if ch.isdigit():
            digits += ch
        else:
            break
    return int(digits) if digits and "mph" not in str(s) else None


def utm_to_latlon(e, n, zone=31):
    """UTM ETRS89 (GRS80) → lat/lon."""
    import math
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    x, m = e - 500000.0, n / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
          + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    n1 = a / math.sqrt(1 - e2 * math.sin(p1) ** 2); t1 = math.tan(p1) ** 2; c1 = ep2 * math.cos(p1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p1) ** 2) ** 1.5; d = x / (n1 * k0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                          + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(p1)
    return math.degrees(lat), zone * 6 - 183 + math.degrees(lon)


def bearing(a, b):
    import math
    la1, la2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)
    return round((math.degrees(math.atan2(y, x)) + 360) % 360)


def dist(a, b):
    import math
    r = math.pi / 180
    h = math.sin((b[0] - a[0]) * r / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


def fetch_sct():
    rows = []
    for line in get_text(SCT_URL).splitlines():
        p = line.split()
        if len(p) < 5:
            continue
        try:
            x, y = float(p[-2].replace(",", ".")), float(p[-1].replace(",", "."))
        except ValueError:
            continue
        if not (x > 100000 and y > 4000000):
            continue
        lat, lon = utm_to_latlon(x, y)
        v = int_prefix(p[-3])
        rows.append([round(lat, 6), round(lon, 6), "f", v if v and v <= 130 else None, None,
                     f"{p[0]} km {p[1].replace(',', '.')}", "sct"])
    if len(rows) < 100:
        raise RuntimeError(f"SCT: solo {len(rows)} radares")
    return rows


def fetch_dgt():
    import xml.etree.ElementTree as ET
    root = ET.fromstring(get_text(DGT_URL, timeout=90))
    local = lambda el: el.tag.rsplit("}", 1)[-1]

    def find_all(el, name):
        return [x for x in el.iter() if local(x) == name]

    def point(el):
        if el is None:
            return None
        la, lo = find_all(el, "latitude"), find_all(el, "longitude")
        return (float(la[0].text), float(lo[0].text)) if la and lo else None

    rows = []
    for pl in root.iter():
        if local(pl) != "predefinedLocation" or not pl.get("id"):
            continue
        names = find_all(pl, "predefinedLocationName")
        name = "".join(names[0].itertext()).strip() if names else ""
        rn = find_all(pl, "roadName") or find_all(pl, "roadNumber") or find_all(pl, "descriptor")
        road = "".join(rn[0].itertext()).strip() if rn else ""
        frm, to = find_all(pl, "from"), find_all(pl, "to")
        a, b = point(frm[0] if frm else None), point(to[0] if to else None)
        if a and b:
            rows.append([round(a[0], 6), round(a[1], 6), "s", None, bearing(a, b), road, "dgt"])
            continue
        p = point(pl)
        if p:
            rows.append([round(p[0], 6), round(p[1], 6), "s" if "TRAMO" in name.upper() else "f", None, None, road, "dgt"])
    if len(rows) < 300:
        raise RuntimeError(f"DGT: solo {len(rows)} radares")
    return rows


def build_radars(elements):
    nodes = {e["id"]: e for e in elements if e.get("type") == "node"}
    kind_of, limit_of = {}, {}
    for rel in (e for e in elements if e.get("type") == "relation"):
        tags = rel.get("tags", {})
        enf = tags.get("enforcement", "")
        k = "s" if enf == "average_speed" else "l" if enf == "traffic_signals" else None
        lim = int_prefix(tags.get("maxspeed"))
        for m in rel.get("members", []):
            if m.get("type") == "node" and m.get("ref") in nodes:
                if k:
                    kind_of[m["ref"]] = k
                if lim:
                    limit_of.setdefault(m["ref"], lim)
    rows = []
    for nid, n in nodes.items():
        tags = n.get("tags", {})
        lim = int_prefix(tags.get("maxspeed")) or limit_of.get(nid)
        try:
            direction = float(tags.get("direction"))
            direction = direction if 0 <= direction <= 360 else None
        except (TypeError, ValueError):
            direction = None
        rows.append([round(n["lat"], 6), round(n["lon"], 6), kind_of.get(nid, "f"), lim, direction, "", "osm"])
    return rows


def fetch_osm():
    elements, failed = {}, 0
    for box in BOXES:
        body = urllib.parse.urlencode({"data": QUERY.format(*box)}).encode()
        for attempt, url in enumerate(OVERPASS * 2):
            try:
                j = get_json(url, data=body, timeout=150)
                for e in j.get("elements", []):
                    elements[(e.get("type"), e.get("id"))] = e
                break
            except Exception as e:  # probar el otro servidor, o el mismo un poco después
                print(f"Overpass {box}: {e}", file=sys.stderr)
                time.sleep(10 * (attempt + 1))
        else:
            failed += 1
        time.sleep(2)
    rows = build_radars(list(elements.values()))
    if len(rows) < 500 or failed > 2:
        raise RuntimeError(f"Overpass: {len(rows)} radares, {failed} zonas sin respuesta")
    return rows


class Grid:
    def __init__(self, rows=()):
        self.g = {}
        for r in rows:
            self.add(r)

    def add(self, r):
        self.g.setdefault((int(r[0] * 10 // 1), int(r[1] * 10 // 1)), []).append(r)

    def near(self, lat, lon, m, reach=1):
        out = []
        ki, kj = int(lat * 10 // 1), int(lon * 10 // 1)
        for i in range(-reach, reach + 1):
            for j in range(-reach, reach + 1):
                for r in self.g.get((ki + i, kj + j), ()):
                    d = dist((lat, lon), (r[0], r[1]))
                    if d < m:
                        out.append((d, r))
        return sorted(out, key=lambda x: x[0])


def merge_radars(sct, dgt, osm, stations):
    official = sct + dgt
    og = Grid(osm)
    for r in official:  # la DGT no publica el límite: se toma de OSM si hay un radar al lado
        if r[3] is None:
            n = next((x for x in og.near(r[0], r[1], 300) if x[1][3]), None)
            if n:
                r[3] = n[1][3]
        if r[4] is None:
            n = next((x for x in og.near(r[0], r[1], 150) if x[1][4] is not None), None)
            if n:
                r[4] = n[1][4]
    out, fg = [], Grid()
    for r in official:
        if not fg.near(r[0], r[1], 25):
            fg.add(r); out.append(r)
    sg = Grid([(s[5], s[6]) for s in stations]) if stations else None
    for r in osm:
        m = 20 if r[2] == "l" else 150
        if any(x[1][6] != "osm" or x[0] < 25 for x in fg.near(r[0], r[1], m)):
            continue
        if sg and not sg.near(r[0], r[1], 12000, 2):  # fuera de España (Portugal, Francia, Andorra)
            continue
        fg.add(r); out.append(r)
    out.sort(key=lambda r: (r[0], r[1]))
    return out


def update_radars(force=False):
    old = load(RADARES) or {}
    try:
        age = time.time() - datetime.fromisoformat(old["actualizado"]).timestamp()
    except (KeyError, ValueError, TypeError):
        age = 1e9
    if age < 20 * 3600 and not force:
        print("Radares: al día")
        return
    prev = {"sct": [], "dgt": [], "osm": []}
    for r in old.get("r", []):
        src = r[6] if len(r) > 6 else "osm"
        row = (list(r) + [None] * 7)[:7]
        row[5], row[6] = row[5] or "", src
        prev.setdefault(src, []).append(row)
    got, errors = {}, []
    for name, fn in (("sct", fetch_sct), ("dgt", fetch_dgt), ("osm", fetch_osm)):
        try:
            got[name] = fn()
        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"Radares {name}: {e}", file=sys.stderr)
            got[name] = prev.get(name, [])
    if len(errors) == 3:
        raise RuntimeError("ninguna fuente de radares respondió: " + "; ".join(errors))
    rows = merge_radars(got["sct"], got["dgt"], got["osm"], (load(PRECIOS) or {}).get("e", []))
    if len(rows) < 1000:
        raise RuntimeError(f"Solo {len(rows)} radares: no se sobrescribe")
    write_lines(RADARES, {"actualizado": now_iso(), "fuente": "DGT · Servei Català de Trànsit · OpenStreetMap"}, "r", rows)
    counts = {k: sum(1 for r in rows if r[6] == k) for k in ("dgt", "sct", "osm")}
    print(f"Radares: {len(rows)} {counts}" + (f" (errores: {errors})" if errors else ""))


def main():
    errors = []
    for name, fn in (("precios", update_prices), ("radares", lambda: update_radars("--radares" in sys.argv))):
        try:
            fn()
        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"ERROR {name}: {e}", file=sys.stderr)
    if len(errors) == 2:
        sys.exit(1)


if __name__ == "__main__":
    main()
