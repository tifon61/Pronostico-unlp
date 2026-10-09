#!/usr/bin/env python3
"""
Trae de Ogimet (https://www.ogimet.com/) TODOS los reportes sinópticos
disponibles para las 6 ciudades, sin resumirlos a un valor por día -- a
diferencia de fetch_observaciones_ogimet.py (que arma el resumen diario
para la verificación de pronósticos), esto guarda cada reporte horario
crudo en la hoja separada "Observaciones_Estaciones", pensada para un
futuro visualizador de observaciones puras.

Dos modos de uso:
  - Sin argumentos: carga el día de "ayer" (hora Argentina). Es el modo
    que usa GitHub Actions una vez por día (ver el workflow).
  - Con --desde (y opcionalmente --hasta): backfill manual de un rango de
    fechas pasado, ej. `python3 fetch_observaciones_estaciones_ogimet.py
    --desde 2026-09-01 --hasta 2026-09-30`. Pensado para cargar historial
    de antes de que existiera esta hoja, o rellenar un día que falló.

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
import argparse
import datetime
import json
import os
import re
import sys
import time
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


# Tamaño máximo de ventana (en días) por pedido a Ogimet. Para un rango
# largo (backfill) no se pide todo de una -- una respuesta gigante tarda
# más y arriesga que Ogimet corte el pedido -- se parte en pedidos de
# a lo sumo esto, uno detrás del otro.
CHUNK_DIAS = 20

# Pausa entre pedidos a Ogimet (incluso entre ciudades) y reintentos ante
# una respuesta que tenga pinta de bloqueo. Ogimet bloquea temporalmente
# IPs de datacenter/nube (como las de GitHub Actions) si nota ráfagas de
# pedidos -- confirmado en un backfill real: de ~30 pedidos casi sin pausa
# entre ellos, varios volvieron vacíos o con "403 Forbidden" en el cuerpo
# (con status HTTP 200 igual, no se puede confiar solo en el status code).
PAUSA_ENTRE_PEDIDOS_SEG = 4
REINTENTOS_MAX = 3
PAUSA_REINTENTO_SEG = 20


def _respuesta_valida(html_text):
    # Una página real de gsynres decoded=yes siempre tiene estas marcas y
    # un tamaño mínimo -- un bloqueo/error de Ogimet (visto en la práctica:
    # "Status: 403 Forbidden" de 25 bytes, o una página vacía de 7769
    # bytes repetida igual para estaciones distintas) no las tiene.
    if len(html_text) < 10000:
        return False
    low = html_text.lower()
    return "gsynres" in low or "wmo id" in low or "synop decodificados" in low


def fetch_tabla_ogimet(omm, fecha_utc_hasta, ndays=4):
    params = {
        "ind": omm,
        "ndays": str(ndays),
        "ano": fecha_utc_hasta.year,
        "mes": f"{fecha_utc_hasta.month:02d}",
        "day": f"{fecha_utc_hasta.day:02d}",
        "hora": "12",
        "decoded": "yes",
    }
    url = f"https://www.ogimet.com/cgi-bin/gsynres?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity"})

    ultimo_texto = ""
    for intento in range(1, REINTENTOS_MAX + 1):
        with urllib.request.urlopen(req, timeout=60) as resp:
            print(f"  (debug) status={resp.status} content-type={resp.headers.get('Content-Type')} url={url}")
            ultimo_texto = resp.read().decode("utf-8", errors="replace")
        if _respuesta_valida(ultimo_texto):
            return ultimo_texto
        print(f"  (debug) respuesta sospechosa (posible bloqueo de Ogimet, {len(ultimo_texto)} bytes), "
              f"intento {intento}/{REINTENTOS_MAX}: {ultimo_texto[:200]!r}", file=sys.stderr)
        if intento < REINTENTOS_MAX:
            time.sleep(PAUSA_REINTENTO_SEG)

    raise RuntimeError(f"Ogimet no devolvió una respuesta válida tras {REINTENTOS_MAX} intentos "
                        f"(ind={omm}, hasta={fecha_utc_hasta}, ndays={ndays}) -- probable bloqueo temporal.")


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


# Nombres de columna EXACTOS tal como los manda Ogimet en el encabezado de
# gsynres (decoded=yes). No todas las estaciones tienen las mismas: si una
# estación nunca reporta ráfaga o altura de nube, Ogimet saca esa columna
# entera en vez de dejarla vacía -- eso corre la posición de todo lo que
# viene después (confirmado con datos reales: en Bahía Blanca "Prec" queda
# una posición más a la derecha que en las demás por la columna "Rachkmh"
# que las otras no tienen). Por eso NO se puede usar una posición fija:
# cada columna se ubica por su nombre en el encabezado de esa tabla.
COL_T = "T(C)"
COL_TD = "Td(C)"
COL_HR = "Hr%"
COL_TMAX = "Tmax(C)"
COL_TMIN = "Tmin(C)"
COL_DDD = "ddd"
COL_FF = "ffkmh"
COL_P0 = "P0hPa"
COL_PMAR = "P marhPa"
COL_PREC = "Prec(mm)"
COL_NT = "Nt"
COL_VIS = "Viskm"
COL_WW = "WW"


def construir_indices_columnas(header_cells):
    """Mapea nombre de columna (tal como aparece en el encabezado) a su
    índice en una FILA DE DATOS. El encabezado tiene una celda menos que
    los datos porque su "Fecha" cubre fecha+hora juntas, mientras que en
    los datos vienen en dos celdas separadas -- de ahí el +1."""
    return {nombre.strip(): i + 1 for i, nombre in enumerate(header_cells)}


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
    if not filas_html:
        return []

    header_cells = [td.get_text(strip=True) for td in filas_html[0].find_all(["td", "th"])]
    idx = construir_indices_columnas(header_cells)

    if debug_ciudad and COL_PREC not in idx:
        # Esto sí es señal de que algo cambió de verdad (no simplemente que
        # esta estación no reporte ráfaga/HKm, que es normal) -- sin la
        # columna "Prec" en el encabezado no hay de dónde sacar precipitación.
        print(f"  (debug-cols) {debug_ciudad}: ALERTA -- no se encontró la columna 'Prec(mm)' en el "
              f"encabezado ({len(header_cells)} cols) = {header_cells}")

    def val(celdas, nombre):
        i = idx.get(nombre)
        return celdas[i] if i is not None and i < len(celdas) else None

    out = []
    for tr in filas_html[1:]:
        celdas = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
        if len(celdas) < 2:
            continue
        m_fecha = re.match(r"(\d{2})/(\d{2})/(\d{4})", celdas[0])
        m_hora = re.match(r"(\d{2}):(\d{2})", celdas[1])
        if not m_fecha or not m_hora:
            continue
        dd, mm, yyyy = m_fecha.groups()
        hh, mi = m_hora.groups()
        dt_utc = datetime.datetime(int(yyyy), int(mm), int(dd), int(hh), int(mi))

        precip_raw = val(celdas, COL_PREC) or ""
        precip_mm, precip_periodo_h = parsear_precip(precip_raw)
        # Red de seguridad: si lo que cayó en la columna "Prec" no tiene
        # pinta de precipitación (no es "X.X/Nh", "Ip..." ni un guion) pero
        # la celda siguiente sí, es que esta fila en particular trajo una
        # columna de más que el encabezado no reflejaba -- se usa esa en
        # vez de adivinar en silencio con el valor equivocado (que es
        # justo lo que pasaba antes: terminaba guardando la tendencia de
        # presión como si fuera precipitación).
        if precip_mm is None and precip_raw.strip() not in ("", "---", "----"):
            i_prec = idx.get(COL_PREC)
            siguiente = celdas[i_prec + 1] if i_prec is not None and i_prec + 1 < len(celdas) else ""
            mm2, h2 = parsear_precip(siguiente)
            if mm2 is not None or siguiente.strip().startswith("Ip"):
                if debug_ciudad:
                    print(f"  (debug-precip) {debug_ciudad}: {dt_utc} columna Prec con valor raro "
                          f"({precip_raw!r}), se usa la siguiente ({siguiente!r}) -- fila con una columna de más.")
                precip_raw, precip_mm, precip_periodo_h = siguiente, mm2, h2

        v_dir_raw = (val(celdas, COL_DDD) or "").strip()

        out.append({
            "dt_utc": dt_utc,
            "temp": num(val(celdas, COL_T)),
            "punto_rocio": num(val(celdas, COL_TD)),
            "humedad": num(val(celdas, COL_HR)),
            "tmax_12h": num(val(celdas, COL_TMAX)),
            "tmin_12h": num(val(celdas, COL_TMIN)),
            "v_dir": RUMBO_16_A_8.get(v_dir_raw),
            "v_int_kmh": num(val(celdas, COL_FF)),
            "presion_estacion_hpa": num(val(celdas, COL_P0)),
            "presion_nivel_mar_hpa": num(val(celdas, COL_PMAR)),
            "precip_mm": precip_mm,
            "precip_periodo_h": precip_periodo_h,
            "nubosidad_octavos": num(val(celdas, COL_NT)),
            "visibilidad_km": num(val(celdas, COL_VIS)),
            "tiempo_presente_ww": (lambda w: w if w and w.strip() not in ("", "---") else None)(val(celdas, COL_WW)),
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


def fetch_rango(omm, fecha_desde, fecha_hasta, debug_ciudad=None):
    """Todos los reportes de una estación entre fecha_desde y fecha_hasta
    (ambas inclusive, fechas LOCALES Argentina), en uno o más pedidos a
    Ogimet de a lo sumo CHUNK_DIAS días cada uno."""
    payloads = []
    cursor = fecha_desde
    while cursor <= fecha_hasta:
        fin_chunk = min(cursor + datetime.timedelta(days=CHUNK_DIAS - 1), fecha_hasta)
        # Mismo criterio que el uso diario (ndays=4 para pedir 1 día): el
        # punto final del pedido es fin_chunk+1 en UTC, con margen de +4
        # días hacia atrás además del propio ancho del chunk.
        fecha_utc_hasta = fin_chunk + datetime.timedelta(days=1)
        ndays = (fin_chunk - cursor).days + 4
        html_text = fetch_tabla_ogimet(omm, fecha_utc_hasta, ndays=ndays)
        if debug_ciudad:
            print(f"  (debug) {debug_ciudad}: chunk {cursor} a {fin_chunk}, HTML recibido ({len(html_text)} bytes).")

        filas = parsear_filas(html_text, debug_ciudad=debug_ciudad)
        for f in filas:
            dt_local = f["dt_utc"] - datetime.timedelta(hours=3)
            if cursor <= dt_local.date() <= fin_chunk:
                payloads.append(fila_a_payload(f, dt_local.date(), dt_local.strftime("%H:%M")))

        cursor = fin_chunk + datetime.timedelta(days=1)
        if cursor <= fecha_hasta:
            time.sleep(PAUSA_ENTRE_PEDIDOS_SEG)
    return payloads


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


def parse_args():
    p = argparse.ArgumentParser(
        description="Importa observaciones de estaciones desde Ogimet. "
                     "Sin argumentos carga el día de ayer (uso normal del cron diario); "
                     "con --desde (y opcionalmente --hasta) hace un backfill de ese rango."
    )
    p.add_argument("--desde", help="Fecha inicial YYYY-MM-DD (incluida). Si no se pasa, se usa 'ayer'.")
    p.add_argument("--hasta", help="Fecha final YYYY-MM-DD (incluida). Por defecto, igual a --desde.")
    return p.parse_args()


def main():
    team_password = os.environ.get("TEAM_PASSWORD")
    if not team_password:
        print("Falta la variable de entorno TEAM_PASSWORD (Secret de GitHub Actions).", file=sys.stderr)
        sys.exit(1)

    args = parse_args()
    ayer = hoy_ar() - datetime.timedelta(days=1)

    if args.desde:
        fecha_desde = datetime.date.fromisoformat(args.desde)
        fecha_hasta = datetime.date.fromisoformat(args.hasta) if args.hasta else fecha_desde
    else:
        fecha_desde = fecha_hasta = ayer

    # Ogimet rechaza con 400 si se le pide un punto final todavía futuro
    # para su propio reloj -- no se puede pedir "hoy" ni fechas posteriores.
    if fecha_hasta > ayer:
        print(f"--hasta ({fecha_hasta}) es hoy o futuro, se ajusta a {ayer}.", file=sys.stderr)
        fecha_hasta = ayer
    if fecha_desde > fecha_hasta:
        print(f"--desde ({fecha_desde}) es posterior a --hasta ({fecha_hasta}), nada para hacer.", file=sys.stderr)
        sys.exit(1)

    print(f"Importando observaciones de estaciones del {fecha_desde} al {fecha_hasta}.")

    ciudades = list(CIUDADES.items())
    for i, (ciudad, omm) in enumerate(ciudades):
        try:
            payloads = fetch_rango(omm, fecha_desde, fecha_hasta, debug_ciudad=ciudad)
            if not payloads:
                print(f"{ciudad}: sin reportes de Ogimet para {fecha_desde}-{fecha_hasta} (estación {omm}).")
                continue

            resultado = publicar_lote(ciudad, payloads, team_password)
            print(f"{ciudad} ({fecha_desde} a {fecha_hasta}): {len(payloads)} reportes -> {resultado}")
        except Exception as e:
            # No se corta el resto de las ciudades porque una falle.
            print(f"{ciudad}: ERROR -- {e}", file=sys.stderr)
        if i < len(ciudades) - 1:
            time.sleep(PAUSA_ENTRE_PEDIDOS_SEG)


if __name__ == "__main__":
    main()
