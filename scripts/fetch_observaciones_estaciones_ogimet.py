#!/usr/bin/env python3
"""
Trae de Ogimet (https://www.ogimet.com/) TODOS los reportes sinópticos
disponibles del día de "ayer" (hora Argentina) para las 6 ciudades, sin
resumirlos a un valor por día -- a diferencia de fetch_observaciones_ogimet.py
(que arma el resumen diario para la verificación de pronósticos), esto
guarda cada reporte horario crudo en la hoja separada
"Observaciones_Estaciones", pensada para un futuro visualizador de
observaciones puras. Lo corre GitHub Actions una vez por día.

Reutiliza el mismo endpoint de Ogimet y la misma tabla de estaciones que
fetch_observaciones_ogimet.py (ver ese archivo para más contexto sobre el
formato de la tabla de Ogimet y por qué fecha/hora vienen en celdas
separadas). Columnas confirmadas de gsynres con decoded=yes: Fecha, Hora,
T, Td, Hr, Ta, Tmax, Tmin, ddd, ff, P0, Pmar, PTnd, Prec, Nt, Nh, HKm, Vis,
WW, W1, W2.

OJO -- a diferencia del otro script, acá solo se habían validado contra
HTML real las columnas Tmax/Tmin/ddd/ff/Prec (son las que usa la
verificación de pronósticos). Las demás (T, Td, Hr, P0, Pmar, Nt, Vis, WW)
se mapean por posición según ese mismo orden de columnas, pero no se
revisaron todavía contra un reporte real -- conviene mirar las primeras
filas que entren a la hoja nueva y confirmar que los valores tengan
pinta razonable (temperatura/rocío en rango, presión ~1000 hPa, etc.)
antes de confiar en ellas para el visualizador.

No depende de fetch_observaciones_ogimet.py (está separado a propósito:
si Ogimet cambia algo y rompe uno, no se cae el otro).
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

# Mismas 6 ciudades y mismo OMM que fetch_observaciones_ogimet.py.
CIUDADES = {
    "La Plata": "87593",
    "Junín": "87548",
    "Mar del Plata": "87692",
    "Bolívar": "87640",
    "Tandil": "87645",
    "Bahía Blanca": "87750",
}

# Rumbos de 16 direcciones que puede devolver Ogimet, reducidos a los 8 que
# ya usa el resto del sistema.
RUMBO_16_A_8 = {
    "N": "N", "NNE": "N", "NE": "NE", "ENE": "NE",
    "E": "E", "ESE": "E", "SE": "SE", "SSE": "SE",
    "S": "S", "SSW": "S", "SW": "SW", "WSW": "SW",
    "W": "W", "WNW": "W", "NW": "NW", "NNW": "NW",
}


def hoy_ar():
    """Fecha de hoy en Argentina (UTC-3, sin horario de verano desde 2009)."""
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=3)).date()


def fetch_tabla_ogimet(omm, fecha_utc_hasta):
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
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(f"  (debug) status={resp.status} content-type={resp.headers.get('Content-Type')} url={url}")
        return resp.read().decode("utf-8", errors="replace")


def num(s):
    s = (s or "").strip()
    if s in ("", "---", "----", "No data"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parsear_precip(precip_raw):
    """Devuelve (mm, periodo_horas). Ogimet reporta la precipitación
    acumulada en una ventana que varía según la hora del reporte (no
    siempre 24h como en las filas 00/12 UTC) -- se guardan las dos cosas
    para no hacerle creer al visualizador que todo es un acumulado de 24h."""
    precip_raw = (precip_raw or "").strip()
    if precip_raw.startswith("Ip"):
        return 0.0, None  # traza: <0.1mm, mismo criterio que el SMN
    m = re.match(r"([\d.]+)\s*/\s*(\d+)h", precip_raw)
    if not m:
        return None, None
    return float(m.group(1)), int(m.group(2))


def parsear_filas(html_text, debug_ciudad=None):
    """Devuelve una lista de dicts con TODOS los campos de cada fila de la
    tabla que tenga fecha/hora reconocible (no se descartan filas sin
    Tmax/Tmin, a diferencia del resumen diario -- acá cada fila es un
    reporte en sí mismo)."""
    soup = BeautifulSoup(html_text, "lxml")
    tablas = soup.find_all("table", attrs={"border": "0"})
    if not tablas:
        todas = soup.find_all("table")
        tablas = sorted(todas, key=lambda t: len(t.find_all("tr")), reverse=True)[:1]

    if debug_ciudad:
        print(f"  (debug) {debug_ciudad}: {len(tablas)} tabla(s) elegida(s).")

    if not tablas:
        return []
    filas_html = tablas[0].find_all("tr")

    out = []
    for tr in filas_html:
        celdas = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
        if len(celdas) < 14:
            continue
        m_fecha = re.match(r"(\d{2})/(\d{2})/(\d{4})", celdas[0])
        m_hora = re.match(r"(\d{2}):(\d{2})", celdas[1])
        if not m_fecha or not m_hora:
            continue
        dd, mm, yyyy = m_fecha.groups()
        hh, mi = m_hora.groups()
        dt_utc = datetime.datetime(int(yyyy), int(mm), int(dd), int(hh), int(mi))

        precip_mm, precip_periodo_h = parsear_precip(celdas[13] if len(celdas) > 13 else "")
        v_dir_raw = celdas[8].strip() if len(celdas) > 8 else ""

        out.append({
            "dt_utc": dt_utc,
            "temp": num(celdas[2]) if len(celdas) > 2 else None,
            "punto_rocio": num(celdas[3]) if len(celdas) > 3 else None,
            "humedad": num(celdas[4]) if len(celdas) > 4 else None,
            "tmax_12h": num(celdas[6]) if len(celdas) > 6 else None,
            "tmin_12h": num(celdas[7]) if len(celdas) > 7 else None,
            "v_dir": RUMBO_16_A_8.get(v_dir_raw),
            "v_int_kmh": num(celdas[9]) if len(celdas) > 9 else None,
            "presion_estacion_hpa": num(celdas[10]) if len(celdas) > 10 else None,
            "presion_nivel_mar_hpa": num(celdas[11]) if len(celdas) > 11 else None,
            "precip_mm": precip_mm,
            "precip_periodo_h": precip_periodo_h,
            "nubosidad_octavos": num(celdas[14]) if len(celdas) > 14 else None,
            "visibilidad_km": num(celdas[17]) if len(celdas) > 17 else None,
            "tiempo_presente_ww": (celdas[18].strip() if len(celdas) > 18 and celdas[18].strip() not in ("", "---") else None),
        })
    return out


def fila_a_payload(fila, fecha_local, hora_local):
    payload = {"fecha": fecha_local.isoformat(), "hora": hora_local}
    for k, v in fila.items():
        if k == "dt_utc":
            continue
        if v is not None:
            payload[k] = v
    return payload


def publicar_lote(ciudad, filas, token):
    payload = {
        "action": "importar_observaciones_estacion",
        "team_password": token,
        "ciudad": ciudad,
        "filas": filas,
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
    # Mismo punto final que fetch_observaciones_ogimet.py: NO un día de más
    # margen (Ogimet rechaza con 400 si el punto final todavía es futuro
    # para su propio reloj). El margen hacia atrás lo da "ndays".
    fecha_utc_hasta = fecha_local + datetime.timedelta(days=1)

    # Un reporte UTC cae en el día local `fecha_local` si, pasado a hora
    # Argentina (UTC-3), su fecha calendario es esa.
    def es_del_dia_local(dt_utc):
        return (dt_utc - datetime.timedelta(hours=3)).date() == fecha_local

    for ciudad, omm in CIUDADES.items():
        try:
            html_text = fetch_tabla_ogimet(omm, fecha_utc_hasta)
            print(f"{ciudad}: HTML recibido ({len(html_text)} bytes).")
            if len(html_text) < 500:
                print(f"{ciudad}: contenido completo recibido: {html_text!r}")

            filas = parsear_filas(html_text, debug_ciudad=ciudad)
            filas_del_dia = [f for f in filas if es_del_dia_local(f["dt_utc"])]
            print(f"{ciudad}: {len(filas)} filas totales parseadas, {len(filas_del_dia)} del {fecha_local}.")

            if not filas_del_dia:
                print(f"{ciudad}: sin reportes de Ogimet para {fecha_local} (estación {omm}).")
                continue

            payloads = []
            for f in filas_del_dia:
                dt_local = f["dt_utc"] - datetime.timedelta(hours=3)
                payloads.append(fila_a_payload(f, dt_local.date(), dt_local.strftime("%H:%M")))

            resultado = publicar_lote(ciudad, payloads, team_password)
            print(f"{ciudad} ({fecha_local}): {len(payloads)} reportes -> {resultado}")
        except Exception as e:
            # No se corta el resto de las ciudades porque una falle.
            print(f"{ciudad}: ERROR -- {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
