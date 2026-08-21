#!/usr/bin/env python3
"""
Chequea si la página pública de la estación Davis (campo) responde y si los
datos que muestra están frescos, y arma/actualiza data/davis-monitor.json con
el historial de caídas. Lo corre GitHub Actions cada 15 minutos, no cada
visitante del sitio.

Se considera "caída" cuando:
- la URL no responde (timeout, error de conexión, HTTP != 200), o
- responde pero el dato más reciente que reporta tiene más de STALE_MINUTES
  minutos de antigüedad.
"""
import json
import os
import re
import urllib.request
from datetime import datetime, timedelta, timezone

DAVIS_URL = "https://meteo.fcaglp.unlp.edu.ar/davis/campo/downld08.txt"
STALE_MINUTES = 60
ARGENTINA_TZ = timezone(timedelta(hours=-3))
MAX_INCIDENTS_KEPT = 200

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
STATE_PATH = os.path.join(DATA_DIR, "davis-monitor.json")

DATE_RE = re.compile(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})")
TIME_RE = re.compile(r"(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?")


def parse_data_timestamp(text):
    """Busca una fecha y hora en el archivo de la Davis y las devuelve como
    datetime tz-aware en hora Argentina. La exportación de WeatherLink suele
    usar MM/DD/YY; si el primer número no puede ser un mes válido, se prueba
    invertido (DD/MM/YY)."""
    date_m = DATE_RE.search(text)
    time_m = TIME_RE.search(text)
    if not date_m or not time_m:
        return None

    a, b, year = (int(x) for x in date_m.groups())
    if year < 100:
        year += 2000

    day = None
    for month_guess, day_guess in ((a, b), (b, a)):
        if 1 <= month_guess <= 12 and 1 <= day_guess <= 31:
            try:
                base_date = datetime(year, month_guess, day_guess)
                day = day_guess
                break
            except ValueError:
                continue
    if day is None:
        return None

    hour = int(time_m.group(1))
    minute = int(time_m.group(2))
    second = int(time_m.group(3) or 0)
    ampm = time_m.group(4)
    if ampm:
        ampm = ampm.upper()
        if ampm == "PM" and hour != 12:
            hour += 12
        if ampm == "AM" and hour == 12:
            hour = 0
    if hour > 23:
        return None

    try:
        return base_date.replace(hour=hour, minute=minute, second=second, tzinfo=ARGENTINA_TZ)
    except ValueError:
        return None


def fmt_age(minutes):
    if minutes < 120:
        return f"{minutes:.0f} min"
    return f"{minutes / 60:.1f}h"


def check_davis():
    """Devuelve (status, reason, last_data_timestamp_iso_or_None)."""
    try:
        req = urllib.request.Request(DAVIS_URL, headers={"User-Agent": "pronostico-unlp-monitor"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status != 200:
                return "down", f"HTTP {resp.status}", None
            body = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        return "down", f"No se pudo conectar: {e}", None

    data_ts = parse_data_timestamp(body)
    if data_ts is None:
        # No se pudo interpretar la fecha del archivo: no penalizamos con una
        # caída "por antigüedad" sin evidencia, solo lo dejamos sin dato.
        return "up", None, None

    now_local = datetime.now(ARGENTINA_TZ)
    age_minutes = (now_local - data_ts).total_seconds() / 60
    data_ts_iso = data_ts.astimezone(timezone.utc).isoformat()
    if age_minutes > STALE_MINUTES:
        return "down", f"Datos desactualizados: último registro hace {fmt_age(age_minutes)}", data_ts_iso
    return "up", None, data_ts_iso


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "monitoring_since": None,
        "current_status": "pending",
        "current_reason": None,
        "down_since": None,
        "last_data_timestamp": None,
        "last_check": None,
        "current_issue_number": 0,
        "incidents": [],
    }


def main():
    state = load_state()
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    status, reason, data_ts_iso = check_davis()
    prev_status = state.get("current_status")

    if state.get("monitoring_since") is None:
        state["monitoring_since"] = now_iso

    incidents = state.setdefault("incidents", [])

    if status == "down" and prev_status != "down":
        state["down_since"] = now_iso
        state["current_issue_number"] = state.get("current_issue_number", 0) + 1
        incidents.append({"start": now_iso, "end": None, "duration_minutes": None, "reason": reason})
    elif status == "down" and prev_status == "down":
        if incidents and incidents[-1]["end"] is None:
            incidents[-1]["reason"] = reason
    elif status == "up" and prev_status == "down":
        if incidents and incidents[-1]["end"] is None:
            start = datetime.fromisoformat(incidents[-1]["start"])
            duration = (now - start).total_seconds() / 60
            incidents[-1]["end"] = now_iso
            incidents[-1]["duration_minutes"] = round(duration, 1)
        state["down_since"] = None

    if len(incidents) > MAX_INCIDENTS_KEPT:
        del incidents[: len(incidents) - MAX_INCIDENTS_KEPT]

    state["current_status"] = status
    state["current_reason"] = reason
    state["last_check"] = now_iso
    if data_ts_iso is not None:
        state["last_data_timestamp"] = data_ts_iso

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    print(f"Estado: {status} ({reason or 'sin novedad'}) — escrito {STATE_PATH}")


if __name__ == "__main__":
    main()
