"""Holt Kurse, Kennzahlen, Insider-Trades und 13F-Filings und schreibt sie als JSON nach docs/data/.

Aufruf:  python scripts/update.py
Umgebungsvariablen (optional):
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  -> Benachrichtigungen per Telegram
  SEC_USER_AGENT                        -> Kontaktangabe für SEC-Abfragen, z. B. "AktienTracker max@example.com"
"""
import json
import math
import os
import re
import sys
import time
import traceback
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
OUT = ROOT / "docs" / "data"
STATE_FILE = ROOT / "state" / "state.json"

SEC_UA = os.environ.get("SEC_USER_AGENT") or "AktienTracker research-tool admin@aktientracker.invalid"
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID")

# Hysterese: eine Stufe gilt erst wieder als "verlassen", wenn der Rückgang
# so viele Prozentpunkte unter ihre Schwelle fällt. Verhindert Alarm-Spam.
HYSTERESE = 3.0


def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str), encoding="utf-8")


def clean(x):
    """NaN/inf -> None, numpy -> python."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return x
    return None if math.isnan(f) or math.isinf(f) else f


def safe_name(symbol):
    return re.sub(r"[^A-Za-z0-9_-]", "_", symbol)


def tier_for(drawdown, stufen):
    """Höchste Stufe, deren Schwelle der Rückgang erreicht (Index ab 1, 0 = keine)."""
    tier = 0
    for i, s in enumerate(stufen, start=1):
        if drawdown >= s["ab_prozent"]:
            tier = i
    return tier


def pct(a, b):
    if a is None or b in (None, 0):
        return None
    return (a / b - 1) * 100


# ---------------------------------------------------------------- Telegram

def telegram(text):
    if not (TG_TOKEN and TG_CHAT):
        print("[telegram aus]", text.replace("\n", " | "))
        return
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json={"chat_id": TG_CHAT, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True},
            timeout=20,
        )
        r.raise_for_status()
    except Exception as e:
        print("Telegram-Fehler:", e)


# ---------------------------------------------------------------- Kurse & Kennzahlen

def price_block(hist, stufen):
    close = hist["Close"].dropna()
    last = float(close.iloc[-1])
    last_date = close.index[-1]
    ath = float(close.max())
    ath_date = close.idxmax()
    year = close[close.index >= last_date - pd.Timedelta(days=365)]
    high52 = float(year.max())
    sma200 = float(close.iloc[-200:].mean()) if len(close) >= 200 else None
    prev = float(close.iloc[-2]) if len(close) > 1 else None

    def back(days):
        s = close[close.index <= last_date - pd.Timedelta(days=days)]
        return float(s.iloc[-1]) if len(s) else None

    ytd = close[close.index.year < last_date.year]
    drawdown = (1 - last / ath) * 100
    return {
        "kurs": last,
        "datum": last_date.strftime("%Y-%m-%d"),
        "tag_pct": pct(last, prev),
        "ath": ath,
        "ath_datum": ath_date.strftime("%Y-%m-%d"),
        "rueckgang_ath": drawdown,
        "hoch52": high52,
        "rueckgang_52w": (1 - last / high52) * 100,
        "tief52": float(year.min()),
        "sma200": sma200,
        "abstand_sma200": pct(last, sma200),
        "perf_1m": pct(last, back(30)),
        "perf_6m": pct(last, back(182)),
        "perf_1j": pct(last, back(365)),
        "perf_5j": pct(last, back(5 * 365)),
        "perf_ytd": pct(last, float(ytd.iloc[-1])) if len(ytd) else None,
        "stufe": tier_for(drawdown, stufen),
    }


def history_series(hist):
    """Tageskurse der letzten 2 Jahre, davor Wochenkurse (hält die Dateien klein)."""
    close = hist["Close"].dropna()
    close.index = close.index.tz_localize(None) if close.index.tz is not None else close.index
    cut = close.index[-1] - pd.Timedelta(days=730)
    older = close[close.index < cut].resample("W-FRI").last().dropna()
    recent = close[close.index >= cut]
    s = pd.concat([older, recent])
    return [[d.strftime("%Y-%m-%d"), round(float(v), 4)] for d, v in s.items()]


ROWS_INCOME = {
    "umsatz": ["Total Revenue", "Operating Revenue"],
    "bruttogewinn": ["Gross Profit"],
    "operatives_ergebnis": ["Operating Income", "Total Operating Income As Reported"],
    "nettogewinn": ["Net Income", "Net Income Common Stockholders"],
    "eps": ["Diluted EPS", "Basic EPS"],
}


def pick_row(df, names):
    for n in names:
        if df is not None and n in df.index:
            return df.loc[n]
    return None


def fundamentals(t, info):
    out = {
        "sektor": info.get("sector"),
        "branche": info.get("industry"),
        "land": info.get("country"),
        "marktkap": clean(info.get("marketCap")),
        "kgv": clean(info.get("trailingPE")),
        "kgv_erwartet": clean(info.get("forwardPE")),
        "peg": clean(info.get("trailingPegRatio") or info.get("pegRatio")),
        "kuv": clean(info.get("priceToSalesTrailing12Months")),
        "dividendenrendite": clean(info.get("dividendYield")),
        "bruttomarge": clean(info.get("grossMargins")),
        "operative_marge": clean(info.get("operatingMargins")),
        "nettomarge": clean(info.get("profitMargins")),
        "umsatzwachstum": clean(info.get("revenueGrowth")),
        "gewinnwachstum": clean(info.get("earningsGrowth")),
        "eigenkapitalrendite": clean(info.get("returnOnEquity")),
        "verschuldung_ek": clean(info.get("debtToEquity")),
        "kursziel": clean(info.get("targetMeanPrice")),
        "kursziel_hoch": clean(info.get("targetHighPrice")),
        "kursziel_tief": clean(info.get("targetLowPrice")),
        "analysten_empfehlung": info.get("recommendationKey"),
        "analysten_anzahl": clean(info.get("numberOfAnalystOpinions")),
        "beschreibung": info.get("longBusinessSummary"),
        "quartale": [],
        "naechste_zahlen": None,
    }

    try:
        q = t.quarterly_income_stmt
        cf = t.quarterly_cashflow
    except Exception:
        q, cf = None, None

    if q is not None and not q.empty:
        rows = {k: pick_row(q, v) for k, v in ROWS_INCOME.items()}
        fcf = pick_row(cf, ["Free Cash Flow"]) if cf is not None and not cf.empty else None
        cols = sorted(q.columns)  # alt -> neu
        quartale = []
        for c in cols:
            e = {"periode": c.strftime("%Y-%m-%d")}
            for k, row in rows.items():
                e[k] = clean(row.get(c)) if row is not None else None
            e["fcf"] = clean(fcf.get(c)) if fcf is not None and c in fcf.index else None
            u = e["umsatz"]
            e["bruttomarge"] = e["bruttogewinn"] / u if u and e["bruttogewinn"] is not None else None
            e["operative_marge"] = e["operatives_ergebnis"] / u if u and e["operatives_ergebnis"] is not None else None
            e["nettomarge"] = e["nettogewinn"] / u if u and e["nettogewinn"] is not None else None
            quartale.append(e)
        # Wachstum ggü. Vorjahresquartal (gleiche Periode ~1 Jahr früher)
        by_date = {pd.Timestamp(e["periode"]): e for e in quartale}
        for d, e in by_date.items():
            prev = [x for dd, x in by_date.items() if 330 <= (d - dd).days <= 400]
            if prev:
                p = prev[0]
                e["umsatz_yoy"] = pct(e["umsatz"], p["umsatz"])
                e["eps_yoy"] = pct(e["eps"], p["eps"]) if (p["eps"] or 0) > 0 else None
        # Wachstum ggü. Vorquartal
        for a, b in zip(quartale, quartale[1:]):
            b["umsatz_qoq"] = pct(b["umsatz"], a["umsatz"])
        out["quartale"] = quartale

    try:
        cal = t.calendar or {}
        ed = cal.get("Earnings Date")
        if ed:
            out["naechste_zahlen"] = str(ed[0])
            out["erwartung_eps"] = clean(cal.get("Earnings Average"))
            out["erwartung_umsatz"] = clean(cal.get("Revenue Average"))
    except Exception:
        pass

    out["ampel"] = ampel(out)
    return out


def ampel(f):
    """Einfache Trend-Ampel aus dem letzten Quartal: grün / gelb / rot + Begründungen."""
    q = f.get("quartale") or []
    if not q:
        return None
    last = q[-1]
    punkte, gruende = 0, []
    uy = last.get("umsatz_yoy")
    if uy is not None:
        if uy >= 10:
            punkte += 1; gruende.append(f"Umsatz +{uy:.0f} % ggü. Vorjahr")
        elif uy < 0:
            punkte -= 1; gruende.append(f"Umsatz {uy:.0f} % ggü. Vorjahr")
        else:
            gruende.append(f"Umsatz +{uy:.0f} % ggü. Vorjahr")
    ey = last.get("eps_yoy")
    if ey is not None:
        if ey >= 10:
            punkte += 1; gruende.append(f"Gewinn/Aktie +{ey:.0f} %")
        elif ey < 0:
            punkte -= 1; gruende.append(f"Gewinn/Aktie {ey:.0f} %")
    if len(q) >= 2 and last.get("operative_marge") is not None and q[-2].get("operative_marge") is not None:
        d = (last["operative_marge"] - q[-2]["operative_marge"]) * 100
        if d >= 1:
            punkte += 1; gruende.append(f"op. Marge +{d:.1f} Pp.")
        elif d <= -2:
            punkte -= 1; gruende.append(f"op. Marge {d:.1f} Pp.")
    if last.get("fcf") is not None and last["fcf"] < 0:
        punkte -= 1; gruende.append("negativer Free Cashflow")
    farbe = "gruen" if punkte >= 2 else "rot" if punkte <= -1 else "gelb"
    return {"farbe": farbe, "punkte": punkte, "gruende": gruende}


def insider_trades(t):
    """Insider-Transaktionen (nur US-Werte liefern Daten). Käufe sind das stärkere Signal."""
    try:
        df = t.insider_transactions
    except Exception:
        return []
    if df is None or df.empty:
        return []
    out = []
    for _, r in df.head(25).iterrows():
        text = str(r.get("Text") or "")
        tx = str(r.get("Transaction") or "")
        art = "kauf" if re.search(r"purchase", text + tx, re.I) else \
              "verkauf" if re.search(r"sale", text + tx, re.I) else "sonstiges"
        d = r.get("Start Date")
        out.append({
            "datum": d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10],
            "person": str(r.get("Insider") or "").title(),
            "position": str(r.get("Position") or ""),
            "art": art,
            "text": text,
            "aktien": clean(r.get("Shares")),
            "wert": clean(r.get("Value")),
        })
    return out


def process_ticker(entry, rules, state, alerts):
    sym = entry["symbol"]
    t = yf.Ticker(sym)
    hist = t.history(period="max", auto_adjust=False)
    if hist is None or hist.empty:
        raise RuntimeError("keine Kursdaten")
    stufen = rules["stufen"]
    p = price_block(hist, stufen)
    try:
        info = t.info or {}
    except Exception:
        info = {}

    is_etf = entry.get("typ") == "etf"
    f = None if is_etf else fundamentals(t, info)
    ins = [] if is_etf else insider_trades(t)
    since = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")
    ins_kaeufe_90 = [x for x in ins if x["art"] == "kauf" and x["datum"] >= since]

    grund = rules["grundbetrag"].get(entry.get("typ"), 0)
    faktor = stufen[p["stufe"] - 1]["faktor"] if p["stufe"] else 0
    item = {
        **entry,
        "langname": info.get("longName") or info.get("shortName"),
        "waehrung": info.get("currency"),
        **p,
        "zusatzkauf": grund * faktor,
        "naechste_stufe": next((s["ab_prozent"] for s in stufen if s["ab_prozent"] > p["rueckgang_ath"]), None),
        "ampel": (f or {}).get("ampel"),
        "kgv": (f or {}).get("kgv"),
        "kgv_erwartet": (f or {}).get("kgv_erwartet"),
        "naechste_zahlen": (f or {}).get("naechste_zahlen"),
        "kursziel": (f or {}).get("kursziel"),
        "insider_kaeufe_90t": len(ins_kaeufe_90),
    }
    detail = {"item": item, "historie": history_series(hist), "fundamentaldaten": f, "insider": ins}
    save_json(OUT / "werte" / f"{safe_name(sym)}.json", detail)

    # --- Alarm-Logik mit Hysterese
    tiers = state.setdefault("stufen", {})
    alt = tiers.get(sym, 0)
    neu = p["stufe"]
    if neu > alt:
        s = stufen[neu - 1]
        alerts.append(
            f"📉 <b>{entry['name']}</b> ({sym}) hat <b>{s['name']}</b> erreicht\n"
            f"Rückgang vom Allzeithoch: <b>{p['rueckgang_ath']:.1f} %</b> "
            f"(ATH {p['ath']:.2f} am {p['ath_datum']}, jetzt {p['kurs']:.2f} {item['waehrung'] or ''})\n"
            f"Regel: Faktor {s['faktor']}× → {grund * s['faktor']:.0f} {rules.get('waehrung_grundbetrag', 'EUR')}"
        )
        tiers[sym] = neu
    elif neu < alt and p["rueckgang_ath"] < stufen[alt - 1]["ab_prozent"] - HYSTERESE:
        tiers[sym] = neu

    seen = state.setdefault("insider_gemeldet", {})
    for x in ins_kaeufe_90:
        key = f"{sym}|{x['datum']}|{x['person']}|{x['aktien']}"
        if key not in seen:
            seen[key] = x["datum"]
            if state.get("initialisiert"):
                wert = f" für {x['wert'] / 1e6:.2f} Mio. $" if x["wert"] else ""
                alerts.append(f"🟢 Insider-Kauf bei <b>{entry['name']}</b>: {x['person']} ({x['position']}) "
                              f"kauft {x['aktien']:,.0f} Aktien{wert} am {x['datum']}")
    return item


# ---------------------------------------------------------------- 13F-Filings großer Investoren

def sec_get(url, as_json=True):
    r = requests.get(url, headers={"User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate"}, timeout=30)
    r.raise_for_status()
    time.sleep(0.15)  # SEC erlaubt max. 10 Anfragen/Sekunde
    return r.json() if as_json else r.content


def parse_13f_table(cik, acc):
    folder = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}"
    idx = sec_get(f"{folder}/index.json")
    xmls = [i["name"] for i in idx["directory"]["item"]
            if i["name"].lower().endswith(".xml") and "primary_doc" not in i["name"].lower()]
    if not xmls:
        return {}
    root = ET.fromstring(sec_get(f"{folder}/{xmls[0]}", as_json=False))
    ns = {"n": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    p = "n:" if ns else ""
    pos = {}
    for it in root.findall(f".//{p}infoTable", ns):
        def g(tag):
            el = it.find(f".//{p}{tag}", ns)
            return el.text.strip() if el is not None and el.text else None
        if g("putCall"):
            continue  # Optionen auslassen, nur Aktienpositionen
        cusip = g("cusip")
        e = pos.setdefault(cusip, {"name": g("nameOfIssuer"), "klasse": g("titleOfClass"), "wert": 0, "stueck": 0})
        e["wert"] += float(g("value") or 0)
        e["stueck"] += float(g("sshPrnamt") or 0)
    # Manche Filer melden trotz SEC-Regel (seit 2023 in Dollar) noch in Tausend Dollar.
    preise = sorted(x["wert"] / x["stueck"] for x in pos.values() if x["stueck"])
    if preise and preise[len(preise) // 2] < 1:
        for x in pos.values():
            x["wert"] *= 1000
    return pos


def investor_holdings(inv, state, alerts):
    cik = str(inv["cik"]).zfill(10)
    sub = sec_get(f"https://data.sec.gov/submissions/CIK{cik}.json")
    r = sub["filings"]["recent"]
    filings = [(r["accessionNumber"][i], r["filingDate"][i], r["reportDate"][i])
               for i in range(len(r["form"])) if r["form"][i] == "13F-HR"]
    if len(filings) < 1:
        raise RuntimeError("keine 13F-HR-Filings")
    (acc_neu, fdat, rdat) = filings[0]
    cache = state.setdefault("13f_cache", {})
    cached = cache.get(cik)
    if cached and cached.get("acc") == acc_neu:
        return cached["ergebnis"]

    neu = parse_13f_table(cik, acc_neu)
    alt = parse_13f_table(cik, filings[1][0]) if len(filings) > 1 else {}
    gesamt = sum(x["wert"] for x in neu.values()) or 1
    pos = []
    for cusip in set(neu) | set(alt):
        n, a = neu.get(cusip), alt.get(cusip)
        if n and not a:
            aenderung, delta = "neu", None
        elif a and not n:
            aenderung, delta = "verkauft", -100.0
        else:
            delta = pct(n["stueck"], a["stueck"])
            aenderung = "aufgestockt" if delta and delta > 0.5 else "reduziert" if delta and delta < -0.5 else "unveraendert"
        src = n or a
        pos.append({
            "name": src["name"], "cusip": cusip, "aenderung": aenderung, "delta_stueck_pct": delta,
            "wert": n["wert"] if n else 0, "anteil": (n["wert"] / gesamt * 100) if n else 0,
            "stueck": n["stueck"] if n else 0, "stueck_vorher": a["stueck"] if a else 0,
        })
    pos.sort(key=lambda x: (-x["wert"], x["name"]))
    ergebnis = {
        "name": inv["name"], "person": inv.get("person"), "cik": cik,
        "filing_datum": fdat, "stichtag": rdat, "vorheriger_stichtag": filings[1][2] if len(filings) > 1 else None,
        "gesamtwert": gesamt, "positionen": pos,
        "link": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=13F-HR",
    }
    if cached and state.get("initialisiert"):
        n_neu = [x["name"] for x in pos if x["aenderung"] == "neu"][:5]
        n_auf = [x["name"] for x in pos if x["aenderung"] == "aufgestockt"][:5]
        n_weg = [x["name"] for x in pos if x["aenderung"] == "verkauft"][:5]
        alerts.append(
            f"🏦 Neues 13F von <b>{inv['name']}</b> (Stichtag {rdat})\n"
            + (f"Neu: {', '.join(n_neu)}\n" if n_neu else "")
            + (f"Aufgestockt: {', '.join(n_auf)}\n" if n_auf else "")
            + (f"Komplett verkauft: {', '.join(n_weg)}" if n_weg else "")
        )
    cache[cik] = {"acc": acc_neu, "ergebnis": ergebnis}
    return ergebnis


# ---------------------------------------------------------------- Hauptprogramm

def main():
    watch = load_json(CONFIG / "watchlist.json")["werte"]
    rules = load_json(CONFIG / "rules.json")
    investors = (load_json(CONFIG / "investors.json", {}) or {}).get("investoren", [])
    state = load_json(STATE_FILE, {}) or {}
    alerts, fehler, items = [], [], []

    for e in watch:
        try:
            items.append(process_ticker(e, rules, state, alerts))
            print("ok   ", e["symbol"])
        except Exception as ex:
            fehler.append({"symbol": e["symbol"], "fehler": str(ex)})
            print("FEHLER", e["symbol"], ex)
            traceback.print_exc(limit=1)

    inv_out = []
    for inv in investors:
        try:
            inv_out.append(investor_holdings(inv, state, alerts))
            print("ok    13F", inv["name"])
        except Exception as ex:
            fehler.append({"symbol": f"13F {inv['name']}", "fehler": str(ex)})
            print("FEHLER 13F", inv["name"], ex)

    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    save_json(OUT / "overview.json", {"aktualisiert": now, "regeln": rules, "werte": items, "fehler": fehler})
    save_json(OUT / "investoren.json", {"aktualisiert": now, "investoren": inv_out})

    if alerts and state.get("initialisiert"):
        for a in alerts:
            telegram(a)
    elif alerts:
        print(f"Erster Lauf: {len(alerts)} Meldungen nicht gesendet (nur Ausgangszustand gespeichert).")
    state["initialisiert"] = True
    save_json(STATE_FILE, state)
    print(f"Fertig: {len(items)} Werte, {len(inv_out)} Investoren, {len(fehler)} Fehler, {len(alerts)} Meldungen.")
    return 0 if items else 1


if __name__ == "__main__":
    sys.exit(main())
