#!/usr/bin/env python3
"""
Arma data/forecasts.json consultando Apps Script una vez por ciudad.
Lo corre GitHub Actions (al publicarse un pronóstico + corridas de
respaldo), no cada visitante del portal.
"""
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone

APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyKbRPl7kgOPJWsDtq_2eb7Da6P8iDGvF75_-D55Rwo0xn3WSv_eJnQe2Azgwj4i3XS/exec"

CITIES = ["La Plata", "Junín", "Mar del Plata", "Bolívar", "Tandil", "Bahía Blanca"]

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "forecasts.json")


def fetch_city(city):
    url = f"{APPS_SCRIPT_URL}?city={urllib.parse.quote(city)}"
    try:
        with urllib.request.urlopen(url, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"error": f"No se pudo consultar {city}: {e}"}


def main():
    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cities": {city: fetch_city(city) for city in CITIES},
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"Escrito {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
