#!/usr/bin/env python3
"""
Actualiza los datos de Vigía. Lo ejecuta GitHub Actions cada 30 minutos.

- data/precios.json: precios oficiales de todas las gasolineras de España
  (Ministerio para la Transición Ecológica). Si un precio cambia, se guarda el
  anterior durante 24 h para que la app muestre la flecha ↑/↓.
- data/radares.json: radares fijos, de tramo y de semáforo de España
  (OpenStreetMap). Se renueva una vez al día.
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
        lat, lon = num(d.get("Latitud")), num(d.get("Longitud (WGS84)"))
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
                     round(lat, 6), round(lon, 6), prices, prev if any(prev) else 0, ts or 0])
    return rows


def update_prices():
    raw = get_json(MINISTERIO, timeout=180)
    if raw.get("ResultadoConsulta", "OK").upper() != "OK" and not raw.get("ListaEESSPrecio"):
        raise RuntimeError(f"Respuesta del Ministerio: {raw.get('ResultadoConsulta')}")
    rows = build_prices(raw, load(PRECIOS), int(time.time()))
    if len(rows) < 1000:
        raise RuntimeError(f"Solo {len(rows)} gasolineras: no se sobrescribe")
    write_lines(PRECIOS, {"actualizado": now_iso(), "fecha_ministerio": raw.get("Fecha", "")}, "e", rows)
    print(f"Precios: {len(rows)} gasolineras")


# ---------------- Radares ----------------
QUERY = """
[out:json][timeout:240];
area["ISO3166-1"="ES"][admin_level=2]->.es;
node["highway"="speed_camera"](area.es)->.cams;
rel(bn.cams)["type"="enforcement"]->.enf;
.cams out body;
.enf out body;
"""


def int_prefix(s):
    digits = ""
    for ch in str(s or "").strip():
        if ch.isdigit():
            digits += ch
        else:
            break
    return int(digits) if digits and "mph" not in str(s) else None


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
        rows.append([round(n["lat"], 6), round(n["lon"], 6), kind_of.get(nid, "f"), lim, direction])
    rows.sort()
    return rows


def update_radars(force=False):
    old = load(RADARES)
    if old and not force:
        try:
            age = time.time() - datetime.fromisoformat(old["actualizado"]).timestamp()
            if age < 20 * 3600:
                print("Radares: al día")
                return
        except (KeyError, ValueError):
            pass
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for url in OVERPASS:
        try:
            j = get_json(url, data=body, timeout=300)
            rows = build_radars(j.get("elements", []))
            if len(rows) < 100:
                raise RuntimeError(f"Solo {len(rows)} radares")
            write_lines(RADARES, {"actualizado": now_iso(), "fuente": "OpenStreetMap"}, "r", rows)
            print(f"Radares: {len(rows)}")
            return
        except Exception as e:  # probar el siguiente servidor
            last = e
    raise RuntimeError(f"Overpass: {last}")


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
