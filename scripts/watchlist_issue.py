"""Verarbeitet ein GitHub-Issue „Watchlist: …“ und ändert config/watchlist.json.

Das Issue wird von der Webseite (Button „Wert hinzufügen“ / „Entfernen“) vorausgefüllt.
Body-Format (eine Angabe pro Zeile):
    aktion: hinzufuegen | entfernen
    suche: Coca-Cola          (Name oder Ticker)
    symbol: KO                (optional, hat Vorrang vor „suche“)
    kategorie: Konsum         (optional)
    typ: aktie | etf          (optional, wird sonst erkannt)

Preisalarme („Alarm: …“) ändern config/alarme.json:
    aktion: alarm_neu
    symbol: NVDA
    art: kurs_unter | kurs_ueber | rueckgang_ath
    wert: 150.5
    notiz: Eigener Text (optional)
oder
    aktion: alarm_loeschen
    id: 3

Liest ISSUE_TITLE und ISSUE_BODY aus der Umgebung, schreibt eine Antwort nach issue_result.md.
"""
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
WATCH = ROOT / "config" / "watchlist.json"
ALARME = ROOT / "config" / "alarme.json"
RESULT = ROOT / "issue_result.md"


def parse(body):
    out = {}
    for line in (body or "").splitlines():
        m = re.match(r"\s*([a-zA-ZäöüÄÖÜ_]+)\s*:\s*(.*?)\s*$", line)
        if m:
            out[m.group(1).lower()] = m.group(2)
    return out


def resolve(query):
    """Name oder Ticker -> (symbol, name, typ) über die Yahoo-Suche."""
    query = query.strip()
    hits = []
    try:
        hits = [q for q in yf.Search(query, max_results=8).quotes if q.get("quoteType") in ("EQUITY", "ETF")]
    except Exception:
        pass
    exact = [q for q in hits if q.get("symbol", "").upper() == query.upper()]
    pick = (exact or hits or [None])[0]
    if pick:
        return pick["symbol"], pick.get("longname") or pick.get("shortname") or pick["symbol"], \
            "etf" if pick.get("quoteType") == "ETF" else "aktie"
    return query.upper(), None, None


def lade_alarme():
    return json.loads(ALARME.read_text(encoding="utf-8")) if ALARME.exists() else {"alarme": []}


def speichere_alarme(daten):
    ALARME.write_text(json.dumps(daten, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def alarm_aktion(p, aktion, werte):
    daten = lade_alarme()
    if aktion == "alarm_loeschen":
        vorher = len(daten["alarme"])
        daten["alarme"] = [a for a in daten["alarme"] if str(a["id"]) != (p.get("id") or "").strip()]
        if len(daten["alarme"]) == vorher:
            RESULT.write_text("❌ Diesen Alarm gibt es nicht mehr, nichts geändert.", encoding="utf-8")
            return 1
        speichere_alarme(daten)
        RESULT.write_text("🗑️ Der Alarm wurde gelöscht.", encoding="utf-8")
        return 0
    sym = (p.get("symbol") or "").strip()
    art = (p.get("art") or "").strip()
    try:
        wert = float((p.get("wert") or "").replace(",", "."))
    except ValueError:
        wert = 0
    if not any(w["symbol"].upper() == sym.upper() for w in werte):
        RESULT.write_text(f"❌ `{sym}` steht nicht in der Watchlist. Bitte den Wert zuerst hinzufügen.", encoding="utf-8")
        return 1
    if art not in ("kurs_unter", "kurs_ueber", "rueckgang_ath") or wert <= 0:
        RESULT.write_text("❌ Art oder Wert des Alarms ist ungültig, nichts geändert.", encoding="utf-8")
        return 1
    neu = {"id": max([a["id"] for a in daten["alarme"]], default=0) + 1, "symbol": sym, "art": art, "wert": wert,
           "notiz": (p.get("notiz") or "").strip()[:200], "erstellt": date.today().isoformat(), "ausgeloest": None}
    daten["alarme"].append(neu)
    speichere_alarme(daten)
    RESULT.write_text(f"🔔 Der Alarm für `{sym}` ist gespeichert. Sobald er erreicht ist, kommt einmalig eine Telegram-Nachricht.", encoding="utf-8")
    return 0


def main():
    title = os.environ.get("ISSUE_TITLE", "")
    p = parse(os.environ.get("ISSUE_BODY", ""))
    aktion = (p.get("aktion") or ("entfernen" if "entfern" in title.lower() else "hinzufuegen")).lower()
    data = json.loads(WATCH.read_text(encoding="utf-8"))
    werte = data["werte"]
    if aktion in ("alarm_neu", "alarm_loeschen"):
        return alarm_aktion(p, aktion, werte)

    if aktion.startswith("entf"):
        sym = (p.get("symbol") or p.get("suche") or "").strip()
        vorher = len(werte)
        data["werte"] = [w for w in werte if w["symbol"].upper() != sym.upper()]
        if len(data["werte"]) == vorher:
            RESULT.write_text(f"❌ `{sym}` steht nicht in der Watchlist – nichts geändert.", encoding="utf-8")
            return 1
        alarme = lade_alarme()
        if any(a["symbol"].upper() == sym.upper() for a in alarme["alarme"]):
            alarme["alarme"] = [a for a in alarme["alarme"] if a["symbol"].upper() != sym.upper()]
            speichere_alarme(alarme)
        msg = f"🗑️ `{sym}` wurde aus der Watchlist entfernt. Die Seite aktualisiert sich in wenigen Minuten."
    else:
        query = (p.get("symbol") or p.get("suche") or "").strip()
        if not query:
            RESULT.write_text("❌ Kein Name oder Ticker angegeben.", encoding="utf-8")
            return 1
        sym, name, typ = resolve(query)
        if any(w["symbol"].upper() == sym.upper() for w in werte):
            RESULT.write_text(f"ℹ️ `{sym}` ist bereits in der Watchlist.", encoding="utf-8")
            return 1
        hist = yf.Ticker(sym).history(period="1mo")
        if hist is None or hist.empty:
            RESULT.write_text(f"❌ Für `{sym}` (Suche: „{query}“) wurden keine Kursdaten gefunden. "
                              f"Bitte den genauen Yahoo-Ticker angeben, z. B. `KO`, `SAP.DE`, `ASML.AS`.", encoding="utf-8")
            return 1
        typ = (p.get("typ") or typ or "aktie").lower()
        typ = "etf" if typ == "etf" else "aktie"
        kategorie = p.get("kategorie") or ("ETF" if typ == "etf" else "Eigene Auswahl")
        anzeige = p.get("name") or (name or sym)
        anzeige = re.sub(r"\s+(Inc\.?|Corporation|Corp\.?|AG|SE|plc|N\.V\.|S\.A\.|Holdings?)$", "", anzeige).strip()
        werte.append({"symbol": sym, "name": anzeige, "typ": typ, "kategorie": kategorie})
        msg = (f"✅ **{anzeige}** (`{sym}`, {typ}, Kategorie „{kategorie}“) wurde zur Watchlist hinzugefügt.\n\n"
               f"Die Daten erscheinen in wenigen Minuten auf der Seite. Ein ausführliches Unternehmensprofil "
               f"(Geschäftsmodell, CEO, Burggraben …) kann Claude bei Bedarf ergänzen – die Kennzahlen-Prüfung läuft automatisch.")

    WATCH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    RESULT.write_text(msg, encoding="utf-8")
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
