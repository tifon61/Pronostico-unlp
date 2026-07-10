#!/usr/bin/env python3
"""
Arma data/forecasts.json (una consulta por ciudad) y data/novedades.json
(Informes Especiales / Extensión Universitaria / Agenda) consultando
Apps Script. Lo corre GitHub Actions (al publicarse algo + corridas de
respaldo), no cada visitante del portal.
"""
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone

APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyKbRPl7kgOPJWsDtq_2eb7Da6P8iDGvF75_-D55Rwo0xn3WSv_eJnQe2Azgwj4i3XS/exec"

CITIES = ["La Plata", "Junín", "Mar del Plata", "Bolívar", "Tandil", "Bahía Blanca"]

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
FORECASTS_PATH = os.path.join(DATA_DIR, "forecasts.json")
NOVEDADES_PATH = os.path.join(DATA_DIR, "novedades.json")


def fetch_city(city):
    url = f"{APPS_SCRIPT_URL}?city={urllib.parse.quote(city)}"
    try:
        with urllib.request.urlopen(url, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"error": f"No se pudo consultar {city}: {e}"}


def fetch_novedades():
    url = f"{APPS_SCRIPT_URL}?type=novedades"
    try:
        with urllib.request.urlopen(url, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"items": [], "error": f"No se pudieron consultar las novedades: {e}"}


def main():
    forecasts = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cities": {city: fetch_city(city) for city in CITIES},
    }
    novedades = fetch_novedades()
    novedades["generated_at"] = datetime.now(timezone.utc).isoformat()

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(FORECASTS_PATH, "w", encoding="utf-8") as f:
        json.dump(forecasts, f, ensure_ascii=False, indent=2)
    with open(NOVEDADES_PATH, "w", encoding="utf-8") as f:
        json.dump(novedades, f, ensure_ascii=False, indent=2)

    print(f"Escrito {FORECASTS_PATH}")
    print(f"Escrito {NOVEDADES_PATH}")


if __name__ == "__main__":
    main()
