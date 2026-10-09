#!/usr/bin/env python3
"""
Arma la observación de "ayer" (día meteorológico local, 09:00 a 09:00 hora
Argentina = 12 UTC a 12 UTC) para las 6 ciudades, leyendo la tabla de Ogimet
(https://www.ogimet.com/) para cada estación, y la publica en la hoja
Observaciones vía el mismo endpoint que usa el importador manual
(verificacion-admin.html, action=importar_observaciones_lote). Lo corre
GitHub Actions una vez por día, no cada visitante.

CÓMO ARMA EL DATO DE UN DÍA (no es un cálculo trivial, documentado acá para
no tener que redescubrirlo si hay que tocar esto después):

Ogimet solo reporta Tmax/Tmin en los horarios 00 UTC y 12 UTC, cada uno con
el extremo de las 12 horas ANTERIORES a ese horario (estándar OMM, no es
particular de Ogimet). El día meteorológico del SMN (12 UTC a 12 UTC) queda
cubierto por DOS filas consecutivas:
  - la fila de las 00 UTC del día siguiente (UTC) -> cubre 12-24 UTC
  - la fila de las 12 UTC del día siguiente (UTC) -> cubre 00-12 UTC
Juntas cubren exactamente el período 12 UTC (día X) a 12 UTC (día X+1), que
en hora local es 09:00 (día X) a 09:00 (día X+1) -- el "día X" que se le
asigna a la observación.

TMAX = el mayor de los dos Tmax de esas dos filas; TMIN = el menor de los
dos Tmin. La precipitación es más simple: la fila de las 12 UTC ya trae el
acumulado de 24hs en una sola columna ("X.X/24h"), no hace falta sumar las
dos mitades. El viento se toma de la fila de las 12 UTC (dirección e
intensidad instantánea de ese momento, no un promedio del día -- es la
mejor aproximación disponible de esta fuente).

LIMITACIÓN CONOCIDA (a revisar más adelante, confirmado con el usuario):
si la mínima real del día ocurre de madrugada muy cerca del corte de las
09:00 local, puede quedar mal repartida entre un día y el siguiente según
en qué mitad cayó el reporte. No se intenta corregir esto por ahora.
"""
import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.request

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("Falta beautifulsoup4 (pip install beautifulsoup4 lxml)", file=sys.stderr)
    raise

APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyKbRPl7kgOPJWsDtq_2eb7Da6P8iDGvF75_-D55Rwo0xn3WSv_eJnQe2Azgwj4i3XS/exec"

# OMM de la estación de superficie de cada ciudad (mismas que usa el
# importador de archivos .lst del SMN en verificacion-admin.html) y a qué
# columna del esquema de Observaciones mapea cada una: La Plata Aero está
# en las afueras -> suburbana; las otras 5 ciudades solo tienen "urbana".
CIUDADES = {
    "La Plata": {"omm": "87593", "campo": "sub"},
    "Junín": {"omm": "87548", "campo": "urb"},
    "Mar del Plata": {"omm": "87692", "campo": "urb"},
    "Bolívar": {"omm": "87640", "campo": "urb"},
    "Tandil": {"omm": "87645", "campo": "urb"},
    "Bahía Blanca": {"omm": "87750", "campo": "urb"},
}

# Rumbos de 16 direcciones que puede devolver Ogimet, reducidos a los 8 que
# ya usa el resto del sistema (mismo criterio que admin.html/verificacion-admin.html).
RUMBO_16_A_8 = {
    "N": "N", "NNE": "N", "NE": "NE", "ENE": "NE",
    "E": "E", "ESE": "E", "SE": "SE", "SSE": "SE",
    "S": "S", "SSW": "S", "SW": "SW", "WSW": "SW",
    "W": "W", "WNW": "W", "NW": "NW", "NNW": "NW",
}

# Mismos umbrales que usa el importador de .lst del SMN en el navegador
# (vientoACategoria en verificacion-admin.html) -- definidos por el equipo
# (no un estándar externo), mantenerlos iguales entre las dos fuentes para
# no tener dos criterios distintos de "qué es moderado".
def viento_a_categoria(kmh):
    if kmh <= 22:
        return "LEVES"
    if kmh <= 29:
        return "MODERADOS"
    if kmh <= 39:
        return "REGULARES"
    return "FUERTES"


def hoy_ar():
    """Fecha de hoy en Argentina (UTC-3, sin horario de verano desde 2009)."""
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=3)).date()


def fetch_tabla_ogimet(omm, fecha_utc_hasta):
    """Trae la tabla HTML de Ogimet para una estación, con margen suficiente
    de días hacia atrás como para encontrar las filas de 00 y 12 UTC que
    hacen falta aunque algún reporte puntual haya faltado."""
    params = {
        "ind": omm,
        "ndays": "4",
        "ano": fecha_utc_hasta.year,
        "mes": f"{fecha_utc_hasta.month:02d}",
        "day": f"{fecha_utc_hasta.day:02d}",
        "hora": "12",
        "decoded": "yes",
    }
    url = f"https://www.ogimet.com/cgi-bin/gsynres?{urllib.parse.urlencode(params)}"
    # Accept-Encoding: identity fuerza respuesta SIN comprimir -- urllib (a
    # diferencia de requests) no descomprime gzip solo, así que si el
    # servidor igual decide comprimir, lo que se lee acá sale como texto
    # ilegible/cortísimo en vez de HTML real. Mejor pedirle directo que no
    # comprima, que andar adivinando después.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(f"  (debug) status={resp.status} content-type={resp.headers.get('Content-Type')} content-encoding={resp.headers.get('Content-Encoding')} url={url}")
        return resp.read().decode("utf-8", errors="replace")


def parsear_filas(html_text, debug_ciudad=None):
    """Devuelve una lista de dicts {dt (datetime UTC), tmax, tmin, precip_mm,
    v_dir, v_int} por cada fila de la tabla que tenga fecha reconocible.
    Las filas sin Tmax/Tmin válido igual se devuelven (hacen falta para el
    viento/precipitación de la fila de 12 UTC), simplemente esos campos
    quedan en None."""
    soup = BeautifulSoup(html_text, "lxml")
    tablas = soup.find_all("table", attrs={"border": "0"})
    if not tablas:
        # Respaldo por si Ogimet cambia el atributo de la tabla: se queda
        # con la tabla que tenga más filas (la de datos, no las de layout).
        todas = soup.find_all("table")
        tablas = sorted(todas, key=lambda t: len(t.find_all("tr")), reverse=True)[:1]

    if debug_ciudad and not tablas:
        print(f"  (debug) {debug_ciudad}: no se encontró NINGÚN <table> en la página.")
    elif debug_ciudad:
        todas = soup.find_all("table")
        print(f"  (debug) {debug_ciudad}: {len(todas)} tablas en la página. Filas por tabla: {[len(t.find_all('tr')) for t in todas]}")
        primeras_filas = tablas[0].find_all("tr")[:3]
        for i, tr in enumerate(primeras_filas):
            celdas = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
            print(f"  (debug) {debug_ciudad}: tabla elegida, fila {i}: {celdas}")

    if not tablas:
        return []
    filas_html = tablas[0].find_all("tr")

    out = []
    for tr in filas_html:
        celdas = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
        if len(celdas) < 14:
            continue
        # OJO: fecha y hora vienen en DOS celdas separadas ('09/10/2026' y
        # '12:00'), no una sola combinada como parecía a simple vista en la
        # tabla renderizada -- confirmado con el HTML real, no es una
        # suposición.
        m_fecha = re.match(r"(\d{2})/(\d{2})/(\d{4})", celdas[0])
        m_hora = re.match(r"(\d{2}):(\d{2})", celdas[1])
        if not m_fecha or not m_hora:
            continue
        dd, mm, yyyy = m_fecha.groups()
        hh, mi = m_hora.groups()
        dt = datetime.datetime(int(yyyy), int(mm), int(dd), int(hh), int(mi))

        def num(s):
            s = (s or "").strip()
            if s in ("", "---", "----", "No data"):
                return None
            try:
                return float(s)
            except ValueError:
                return None

        # Columnas reales (confirmadas contra HTML real de gsynres con
        # decoded=yes): Fecha, Hora, T, Td, Hr, Ta, Tmax, Tmin, ddd, ff, P0,
        # Pmar, PTnd, Prec, Nt, Nh, HKm, Vis, WW, W1, W2.
        tmax = num(celdas[6])
        tmin = num(celdas[7])
        v_dir_raw = celdas[8].strip()
        v_int_kmh = num(celdas[9])
        precip_raw = celdas[13]
        # "Ip" = traza de precipitación (<0.1mm, mismo criterio que usa el
        # SMN en el archivo .lst) -- se la cuenta como 0mm, no como "sin dato".
        if precip_raw.startswith("Ip"):
            precip_mm = 0.0
        else:
            precip_m = re.match(r"([\d.]+)\s*/\s*24h", precip_raw)
            precip_mm = float(precip_m.group(1)) if precip_m else None

        out.append({
            "dt": dt, "tmax": tmax, "tmin": tmin,
            "v_dir_raw": v_dir_raw, "v_int_kmh": v_int_kmh,
            "precip_mm": precip_mm,
        })
    return out


def armar_observacion(filas, fecha_local):
    """Combina la fila de 00 UTC y la de 12 UTC del día UTC siguiente para
    construir la observación del día local `fecha_local`. Devuelve None si
    no se encontró ninguna de las dos (no hay nada que armar)."""
    dt_utc_dia = fecha_local + datetime.timedelta(days=1)
    fila_00 = next((f for f in filas if f["dt"].date() == dt_utc_dia and f["dt"].hour == 0), None)
    fila_12 = next((f for f in filas if f["dt"].date() == dt_utc_dia and f["dt"].hour == 12), None)

    if not fila_00 and not fila_12:
        return None

    tmaxs = [f["tmax"] for f in (fila_00, fila_12) if f and f["tmax"] is not None]
    tmins = [f["tmin"] for f in (fila_00, fila_12) if f and f["tmin"] is not None]
    tmax = max(tmaxs) if tmaxs else None
    tmin = min(tmins) if tmins else None

    precip_mm = fila_12["precip_mm"] if fila_12 else None
    precip = None if precip_mm is None else ("SI" if precip_mm > 0 else "NO")

    v_dir = None
    v_int = None
    if fila_12:
        rumbo8 = RUMBO_16_A_8.get(fila_12["v_dir_raw"])
        if rumbo8:
            v_dir = rumbo8
        if fila_12["v_int_kmh"] is not None:
            v_int = viento_a_categoria(fila_12["v_int_kmh"])

    if tmax is None and tmin is None and precip is None and v_dir is None:
        return None

    return {"tmax": tmax, "tmin": tmin, "precip": precip, "v_dir": v_dir, "v_int": v_int}


def publicar(ciudad, fecha_local, obs, campo, team_password):
    fila = {"fecha": fecha_local.isoformat()}
    if obs["tmin"] is not None:
        fila[f"tmin_{campo}"] = obs["tmin"]
    if obs["tmax"] is not None:
        fila[f"tmax_{campo}"] = obs["tmax"]
    if obs["precip"] is not None:
        fila["precip"] = obs["precip"]
    if obs["v_dir"] is not None:
        fila["v_dir"] = obs["v_dir"]
    if obs["v_int"] is not None:
        fila["v_int"] = obs["v_int"]

    payload = {
        "action": "importar_observaciones_lote",
        "team_password": team_password,
        "ciudad": ciudad,
        "cargado_por": "Importación automática (Ogimet)",
        "filas": [fila],
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(APPS_SCRIPT_URL, data=data, headers={"Content-Type": "text/plain"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    team_password = os.environ.get("TEAM_PASSWORD")
    if not team_password:
        print("Falta la variable de entorno TEAM_PASSWORD (Secret de GitHub Actions).", file=sys.stderr)
        sys.exit(1)

    fecha_local = hoy_ar() - datetime.timedelta(days=1)
    # Exactamente el día UTC cuyas filas de 00/12 hacen falta (fecha_local+1,
    # ver el porqué al principio del archivo) -- NO un día más de margen: ese
    # punto es el final de la ventana que se le pide a Ogimet, y pedir un
    # día que todavía no pasó (fúturo para el propio Ogimet) es lo que
    # tiraba "400 Bad Request". El margen hacia atrás lo da "ndays" en
    # fetch_tabla_ogimet, no corriendo este punto final hacia adelante.
    fecha_utc_hasta = fecha_local + datetime.timedelta(days=1)

    for ciudad, info in CIUDADES.items():
        try:
            html_text = fetch_tabla_ogimet(info["omm"], fecha_utc_hasta)
            # Diagnóstico: si Ogimet bloqueó el pedido o devolvió otra cosa
            # (común en sitios así con IPs de datacenter/nube como las de
            # GitHub Actions), esto lo deja a la vista en vez de fallar en
            # silencio como "sin datos".
            tiene_marca = "WMO ID" in html_text or "Synop decodificados" in html_text or "gsynres" in html_text.lower()
            print(f"{ciudad}: HTML recibido ({len(html_text)} bytes, marca esperada {'SI' if tiene_marca else 'NO -- revisar, puede estar bloqueado'}).")
            if len(html_text) < 500:
                # Muy corto para ser la página real -- lo mostramos entero
                # en vez de intentar adivinar qué es.
                print(f"{ciudad}: contenido completo recibido: {html_text!r}")

            filas = parsear_filas(html_text, debug_ciudad=ciudad)
            if filas:
                fechas = sorted(f["dt"] for f in filas)
                print(f"{ciudad}: {len(filas)} filas parseadas, de {fechas[0]} a {fechas[-1]}.")
            else:
                print(f"{ciudad}: 0 filas parseadas -- no se encontró la tabla esperada en el HTML.")

            obs = armar_observacion(filas, fecha_local)
            if obs is None:
                print(f"{ciudad}: sin datos de Ogimet para {fecha_local} (estación {info['omm']}).")
                continue
            resultado = publicar(ciudad, fecha_local, obs, info["campo"], team_password)
            print(f"{ciudad} ({fecha_local}): {obs} -> {resultado}")
        except Exception as e:
            # No se corta el resto de las ciudades porque una falle.
            print(f"{ciudad}: ERROR -- {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
