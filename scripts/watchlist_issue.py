"""Verarbeitet ein GitHub-Issue „Watchlist: …“ und ändert config/watchlist.json.

Das Issue wird von der Webseite (Button „Wert hinzufügen“ / „Entfernen“) vorausgefüllt.
Body-Format (eine Angabe pro Zeile):
    aktion: hinzufuegen | entfernen
    suche: Coca-Cola          (Name oder Ticker)
    symbol: KO                (optional, hat Vorrang vor „suche“)
    kategorie: Konsum         (optional)
    typ: aktie | etf          (optional, wird sonst erkannt)

Liest ISSUE_TITLE und ISSUE_BODY aus der Umgebung, schreibt eine Antwort nach issue_result.md.
"""
import json
import os
import re
import sys
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
WATCH = ROOT / "config" / "watchlist.json"
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


def main():
    title = os.environ.get("ISSUE_TITLE", "")
    p = parse(os.environ.get("ISSUE_BODY", ""))
    aktion = (p.get("aktion") or ("entfernen" if "entfern" in title.lower() else "hinzufuegen")).lower()
    data = json.loads(WATCH.read_text(encoding="utf-8"))
    werte = data["werte"]

    if aktion.startswith("entf"):
        sym = (p.get("symbol") or p.get("suche") or "").strip()
        vorher = len(werte)
        data["werte"] = [w for w in werte if w["symbol"].upper() != sym.upper()]
        if len(data["werte"]) == vorher:
            RESULT.write_text(f"❌ `{sym}` steht nicht in der Watchlist – nichts geändert.", encoding="utf-8")
            return 1
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
