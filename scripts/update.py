"""Holt Kurse, Kennzahlen, Insider-Trades und 13F-Filings und schreibt sie als JSON nach docs/data/.

Aufruf:  python scripts/update.py
Umgebungsvariablen (optional):
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  -> Benachrichtigungen per Telegram
  SEC_USER_AGENT                        -> Kontaktangabe für SEC-Abfragen, z. B. "AktienTracker max@example.com"
"""
import html
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

_SEC_RAW = os.environ.get("SEC_USER_AGENT") or ""
# Zeilenumbrüche/Tabs aus dem Secret entfernen, sonst lehnt requests den Header ab
SEC_UA = " ".join(_SEC_RAW.split()) or "AktienTracker research-tool admin@aktientracker.invalid"
TG_TOKEN = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
TG_CHAT = (os.environ.get("TELEGRAM_CHAT_ID") or "").strip()
CONGRESS_API = "https://www.bargo.ai/free-apis/congress/v1"


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


def fmt_pct(v):
    return "–" if v is None else f"{v:+.1f} %"


def load_profiles():
    """Unternehmensprofile aus config/profiles/*.json zu {symbol: profil} zusammenführen."""
    out = {}
    for p in sorted((CONFIG / "profiles").glob("*.json")):
        try:
            out.update({k: v for k, v in load_json(p, {}).items() if not k.startswith("_")})
        except Exception as e:
            print("Profil-Datei fehlerhaft:", p.name, e)
    for sym, ceo in (load_json(CONFIG / "ceos.json", {}) or {}).items():
        if sym in out:
            out[sym]["ceo_bio"] = ceo
    return out


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


def scrub(msg):
    """Geheimnisse (z. B. E-Mail aus SEC_USER_AGENT) aus Fehlermeldungen entfernen – die landen öffentlich."""
    msg = str(msg)
    for s in {_SEC_RAW, SEC_UA, TG_TOKEN, *(_SEC_RAW.split())}:
        if s and len(s) > 3:
            msg = msg.replace(s, "***").replace(repr(s)[1:-1], "***")
    return re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "***", msg)[:300]


def cagr(first, last, years):
    if first is None or last is None or years <= 0 or first <= 0 or last <= 0:
        return None
    return ((last / first) ** (1 / years) - 1) * 100


def rsi(close, n=14):
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    down = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / down
    v = float((100 - 100 / (1 + rs)).iloc[-1])
    return None if math.isnan(v) else v


# ---------------------------------------------------------------- Telegram

def telegram(text):
    """Sendet eine Nachricht, liefert True nur bei Erfolg."""
    if not (TG_TOKEN and TG_CHAT):
        print("[telegram aus]", text.replace("\n", " | "))
        return False
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json={"chat_id": TG_CHAT, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True},
            timeout=20,
        )
        r.raise_for_status()
        return True
    except Exception as e:
        print("Telegram-Fehler:", scrub(e))
        return False


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
        "rsi": rsi(close),
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
        "perf_1w": pct(last, back(7)),
        "perf_1m": pct(last, back(30)),
        "perf_3m": pct(last, back(91)),
        "perf_6m": pct(last, back(182)),
        "perf_1j": pct(last, back(365)),
        "perf_5j": pct(last, back(5 * 365)),
        "perf_ytd": pct(last, float(ytd.iloc[-1])) if len(ytd) else None,
        "stufe": tier_for(drawdown, stufen),
        "tag_tief": clean(hist["Low"].dropna().iloc[-1]) if "Low" in hist else None,
        "tag_hoch": clean(hist["High"].dropna().iloc[-1]) if "High" in hist else None,
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


def by_year(df, names):
    """{jahr: wert} aus einer Jahresbilanz-Zeile."""
    row = pick_row(df, names)
    if row is None:
        return {}
    return {c.year: clean(v) for c, v in row.items() if clean(v) is not None}


def annual(t):
    """Jahreszahlen der letzten ~4 Geschäftsjahre (mehr liefert Yahoo kostenlos nicht)."""
    try:
        inc, bs, cf = t.income_stmt, t.balance_sheet, t.cashflow
    except Exception:
        return []
    if inc is None or inc.empty:
        return []
    f = {
        "umsatz": by_year(inc, ROWS_INCOME["umsatz"]),
        "bruttogewinn": by_year(inc, ROWS_INCOME["bruttogewinn"]),
        "operatives_ergebnis": by_year(inc, ROWS_INCOME["operatives_ergebnis"]),
        "nettogewinn": by_year(inc, ROWS_INCOME["nettogewinn"]),
        "eps": by_year(inc, ROWS_INCOME["eps"]),
        "ebitda": by_year(inc, ["EBITDA", "Normalized EBITDA"]),
        "schulden": by_year(bs, ["Total Debt"]),
        "cash": by_year(bs, ["Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"]),
        "eigenkapital": by_year(bs, ["Stockholders Equity", "Common Stock Equity"]),
        "aktien": by_year(bs, ["Ordinary Shares Number", "Share Issued"]) or by_year(inc, ["Diluted Average Shares"]),
        "ocf": by_year(cf, ["Operating Cash Flow"]),
        "capex": by_year(cf, ["Capital Expenditure"]),
        "fcf": by_year(cf, ["Free Cash Flow"]),
        "rueckkaeufe": by_year(cf, ["Repurchase Of Capital Stock"]),
        "dividenden": by_year(cf, ["Cash Dividends Paid", "Common Stock Dividend Paid"]),
        "sbc": by_year(cf, ["Stock Based Compensation"]),
    }
    jahre = sorted({y for v in f.values() for y in v})
    out = []
    for y in jahre:
        e = {"jahr": y, **{k: v.get(y) for k, v in f.items()}}
        if e["umsatz"] is None and e["nettogewinn"] is None:
            continue
        u = e["umsatz"]
        e["bruttomarge"] = e["bruttogewinn"] / u if u and e["bruttogewinn"] is not None else None
        e["operative_marge"] = e["operatives_ergebnis"] / u if u and e["operatives_ergebnis"] is not None else None
        e["nettomarge"] = e["nettogewinn"] / u if u and e["nettogewinn"] is not None else None
        e["capex_quote"] = abs(e["capex"]) / u if u and e["capex"] is not None else None
        e["netto_schulden"] = (e["schulden"] or 0) - (e["cash"] or 0) if e["schulden"] is not None or e["cash"] is not None else None
        out.append(e)
    return out


def pruefung(jahre, info, sektor):
    """Beantwortet die Kennzahlen-Fragen automatisch: Liste aus {frage, antwort, farbe}."""
    out = []

    def add(frage, antwort, farbe):
        out.append({"frage": frage, "antwort": antwort, "farbe": farbe})

    if len(jahre) >= 2:
        a, b = jahre[0], jahre[-1]
        n = b["jahr"] - a["jahr"]
        zr = f"{a['jahr']}–{b['jahr']}"
        g = cagr(a["umsatz"], b["umsatz"], n)
        if g is not None:
            add("Steigt der Umsatz?", f"{g:+.1f} % pro Jahr ({zr})", "gruen" if g >= 8 else "gelb" if g >= 0 else "rot")
        gn = cagr(a["nettogewinn"], b["nettogewinn"], n)
        if g is not None and gn is not None:
            add("Wächst der Gewinn schneller als der Umsatz?",
                f"Gewinn {gn:+.1f} % vs. Umsatz {g:+.1f} % pro Jahr",
                "gruen" if gn > g + 1 else "gelb" if gn >= g - 3 else "rot")
        elif b["nettogewinn"] is not None and b["nettogewinn"] < 0:
            add("Wächst der Gewinn schneller als der Umsatz?", "Unternehmen schreibt aktuell Verluste", "rot")
        if a["operative_marge"] is not None and b["operative_marge"] is not None:
            d = (b["operative_marge"] - a["operative_marge"]) * 100
            add("Verbessern sich die Margen?",
                f"op. Marge {a['operative_marge'] * 100:.1f} % → {b['operative_marge'] * 100:.1f} % ({d:+.1f} Pp.)",
                "gruen" if d >= 2 else "gelb" if d > -2 else "rot")
        if a["schulden"] is not None and b["schulden"] is not None and a["schulden"] > 0:
            d = pct(b["schulden"], a["schulden"])
            add("Steigen die Schulden?", f"{d:+.0f} % seit {a['jahr']}", "gruen" if d <= 0 else "gelb" if d <= 30 else "rot")
        sh = cagr(a["aktien"], b["aktien"], n)
        if sh is not None:
            add("Werden Aktionäre verwässert?",
                f"Aktienanzahl {sh:+.1f} % pro Jahr" + (" (Rückkäufe)" if sh <= -0.5 else ""),
                "gruen" if sh <= -0.5 else "gelb" if sh <= 1 else "rot")

    finanz = (sektor or "") == "Financial Services"
    if jahre and not finanz:
        b = jahre[-1]
        if b["fcf"] is not None:
            ni = b["nettogewinn"]
            if b["fcf"] < 0:
                add("Erzeugt das Unternehmen echten Cashflow?", "Nein, Free Cashflow negativ (verbrennt Geld)", "rot")
                if b["cash"]:
                    add("Wie lange reicht das Geld?", f"Cash reicht beim aktuellen Verbrauch ca. {b['cash'] / abs(b['fcf']):.1f} Jahre", "gelb")
            else:
                q = b["fcf"] / ni if ni and ni > 0 else None
                add("Erzeugt das Unternehmen echten Cashflow?",
                    "Ja, Free Cashflow positiv" + (f", {q * 100:.0f} % des Gewinns kommen als Cash an" if q else ""),
                    "gruen" if q is None or q >= 0.8 else "gelb")
        if b["capex_quote"] is not None:
            c = b["capex_quote"] * 100
            add("Muss es viel investieren, um zu wachsen?", f"Investitionen (CapEx) = {c:.1f} % vom Umsatz",
                "gruen" if c < 5 else "gelb" if c < 15 else "rot")

    ebitda = clean(info.get("ebitda"))
    debt, cash = clean(info.get("totalDebt")), clean(info.get("totalCash"))
    if finanz:
        add("Wie hoch sind die Schulden?", "Bei Banken/Versicherungen nicht aussagekräftig (Schulden sind Teil des Geschäfts)", "gelb")
    elif debt is not None and cash is not None:
        net = debt - cash
        if net <= 0:
            add("Wie hoch sind die Schulden?", "Mehr Cash als Schulden (Nettocash)", "gruen")
        elif ebitda and ebitda > 0:
            x = net / ebitda
            add("Wie hoch sind die Schulden?", f"Nettoschulden = {x:.1f}× EBITDA (in {x:.1f} Jahren tilgbar)",
                "gruen" if x < 2 else "gelb" if x < 3.5 else "rot")
        else:
            add("Wie hoch sind die Schulden?", "Nettoschulden bei negativem operativem Ergebnis", "rot")

    mc = clean(info.get("marketCap"))
    fcf = jahre[-1]["fcf"] if jahre and not finanz else None
    same_ccy = (info.get("financialCurrency") or info.get("currency")) == info.get("currency")
    fpe = clean(info.get("forwardPE"))
    teile = []
    farbe = "gelb"
    if mc and fcf is not None and same_ccy:
        fy = fcf / mc * 100
        teile.append(f"FCF-Rendite {fy:.1f} %")
        farbe = "gruen" if fy >= 4 else "gelb" if fy >= 2 else "rot"
    if fpe:
        teile.append(f"KGV erwartet {fpe:.1f}")
        if not teile[:-1]:
            farbe = "gruen" if 0 < fpe <= 18 else "gelb" if 0 < fpe <= 35 else "rot"
    if teile:
        add("Welchen Preis zahle ich für das Wachstum?", ", ".join(teile), farbe)

    ins = clean(info.get("heldPercentInsiders"))
    if ins is not None:
        add("Besitzt das Management selbst Aktien?",
            f"Insider halten {ins * 100:.1f} %" + (" (bei Großkonzernen üblich niedrig)" if ins < 0.01 else ""),
            "gruen" if ins >= 0.05 else "gelb")
    return out


def officers(info):
    out = []
    for o in (info.get("companyOfficers") or [])[:8]:
        title = o.get("title") or ""
        out.append({
            "name": re.sub(r"\s+", " ", o.get("name") or "").strip(),
            "titel": title,
            "alter": o.get("age"),
            "verguetung": clean(o.get("totalPay")),
            "ceo": bool(re.search(r"\bCEO\b|Chief Executive|Vorstandsvorsitz", title, re.I)),
        })
    return out


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
    out["jahre"] = annual(t)
    out["pruefung"] = pruefung(out["jahre"], info, out["sektor"])
    out["management"] = officers(info)
    out["mitarbeiter"] = clean(info.get("fullTimeEmployees"))
    out["website"] = info.get("website")
    out["schulden"] = clean(info.get("totalDebt"))
    out["cash"] = clean(info.get("totalCash"))
    out["ebitda"] = clean(info.get("ebitda"))
    out["insider_anteil"] = clean(info.get("heldPercentInsiders"))
    out["institutionen_anteil"] = clean(info.get("heldPercentInstitutions"))
    out["bilanzwaehrung"] = info.get("financialCurrency")
    return out


def overheat_level(p, typ, rules):
    """0 = normal, 1 = heiß, 2 = sehr heiß (stark über der 200-Tage-Linie bzw. RSI hoch)."""
    cfg = rules.get("ueberhitzung") or {}
    grenzen = (cfg.get(typ) or {}).get("abstand_sma200", [30, 50])
    a = p.get("abstand_sma200")
    lvl = 0
    if a is not None:
        lvl = 2 if a >= grenzen[1] else 1 if a >= grenzen[0] else 0
    if lvl == 0 and p.get("rsi") is not None and p["rsi"] >= cfg.get("rsi_ueber", 75):
        lvl = 1
    return lvl


def congress_trades(sym):
    """Aktiengeschäfte von US-Kongressmitgliedern (STOCK Act) über die freie Bargo-API."""
    try:
        r = requests.get(f"{CONGRESS_API}/trades/{sym}", params={"limit": 20}, timeout=20)
        r.raise_for_status()
        time.sleep(0.3)
    except Exception:
        return None
    out = []
    for x in r.json().get("trades", []):
        out.append({
            "person": x.get("member"), "kammer": x.get("chamber"), "staat": x.get("state"),
            "art": "kauf" if x.get("type") == "purchase" else "verkauf" if str(x.get("type", "")).startswith("sale") else x.get("type"),
            "betrag": x.get("amount_range"), "betrag_min": x.get("amount_low"),
            "datum": x.get("transaction_date"), "gemeldet": x.get("disclosure_date"),
            "symbol": sym,
        })
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
        art = "kauf" if re.search(r"purchase|bought", text + tx, re.I) else \
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


def insider_bestand(t):
    """Aktueller Aktienbestand der Insider laut letzter Meldung (nur US-Werte)."""
    try:
        df = t.insider_roster_holders
    except Exception:
        return []
    if df is None or df.empty:
        return []
    out = []
    for _, r in df.iterrows():
        d = r.get("Latest Transaction Date")
        out.append({
            "person": str(r.get("Name") or "").title(),
            "position": str(r.get("Position") or ""),
            "aktien": clean(r.get("Shares Owned Directly")),
            "letzte_art": str(r.get("Most Recent Transaction") or ""),
            "datum": d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else None,
        })
    return sorted(out, key=lambda x: -(x["aktien"] or 0))


def stufe_wert(v, leiter, sonst=0):
    """Erste Stufe der Leiter [(schwelle, punkte), ...], die v erreicht."""
    for schwelle, punkte in leiter:
        if v >= schwelle:
            return punkte
    return sonst


def screen(info, p):
    """Regelbasierter Daten-Score (0-100) aus fünf Bausteinen je 0-20, mit Begründungen.
    Beschreibt nur die aktuelle Datenlage, ist keine Prognose und keine Kaufempfehlung."""
    pc = lambda k: None if clean(info.get(k)) is None else clean(info.get(k)) * 100
    wachstum, gewinn, marge, roe = pc("revenueGrowth"), pc("earningsGrowth"), pc("operatingMargins"), pc("returnOnEquity")
    fpe, peg, kuv = clean(info.get("forwardPE")), clean(info.get("trailingPegRatio")), clean(info.get("priceToSalesTrailing12Months"))
    mc, fcf = clean(info.get("marketCap")), clean(info.get("freeCashflow"))
    debt, cash, ebitda = clean(info.get("totalDebt")), clean(info.get("totalCash")), clean(info.get("ebitda"))
    same_ccy = (info.get("financialCurrency") or info.get("currency")) == info.get("currency")
    finanz = info.get("sector") == "Financial Services"
    fcf_rendite = fcf / mc * 100 if fcf is not None and mc and same_ccy and not finanz else None
    plus, minus = [], []
    b = {}

    if wachstum is not None:
        b["wachstum"] = stufe_wert(wachstum, [(25, 20), (15, 16), (8, 11), (0, 5)])
        if wachstum >= 15:
            plus.append(f"Umsatz wächst stark ({wachstum:+.0f} % ggü. Vorjahr)")
        elif wachstum < 0:
            minus.append(f"Umsatz schrumpft ({wachstum:+.0f} % ggü. Vorjahr)")
    if marge is not None:
        b["profit"] = stufe_wert(marge, [(30, 20), (20, 16), (10, 11), (0, 5)])
        if marge >= 25:
            plus.append(f"Hohe operative Marge ({marge:.0f} %)")
        elif marge < 0:
            minus.append(f"Operativ im Minus (Marge {marge:.0f} %)")
    if fpe is not None and 0 < fpe < 4:
        minus.append(f"KGV erwartet auffällig niedrig ({fpe:.1f}): Datenfehler oder einmalige Gewinnspitze möglich")
    elif fpe is not None and fpe > 0:
        b["bewertung"] = stufe_wert(-fpe, [(-15, 20), (-22, 16), (-30, 11), (-45, 6)], 2)
        if fcf_rendite is not None and fcf_rendite >= 4:
            b["bewertung"] = min(20, b["bewertung"] + 3)
        if fpe <= 18:
            plus.append(f"Niedrige Bewertung (KGV erwartet {fpe:.0f})")
        elif fpe >= 45:
            minus.append(f"Hohe Bewertung (KGV erwartet {fpe:.0f})")
        if peg is not None and 0 < peg <= 1.2 and fpe > 18:
            plus.append(f"Bewertung im Verhältnis zum Wachstum moderat (PEG {peg:.1f})")
    elif fpe is not None:
        minus.append("Für das nächste Jahr werden Verluste erwartet")
    a, p6, p12 = p.get("abstand_sma200"), p.get("perf_6m"), p.get("perf_1j")
    if a is not None or p6 is not None or p12 is not None:
        b["trend"] = (8 if (a or 0) > 0 else 0) + (6 if (p6 or 0) > 0 else 0) + (6 if (p12 or 0) > 0 else 0)
        if a is not None and a >= 50:
            b["trend"] = max(0, b["trend"] - 6)
            minus.append(f"Heiß gelaufen ({a:+.0f} % über der 200-Tage-Linie)")
        elif (p6 or 0) >= 20 and (a or 0) > 0:
            plus.append(f"Kurstrend intakt ({p6:+.0f} % in 6 Monaten)")
        if p.get("rueckgang_ath", 0) >= 40:
            minus.append(f"{p['rueckgang_ath']:.0f} % unter dem Allzeithoch, Ursache prüfen")
    if not finanz and debt is not None and cash is not None:
        net = debt - cash
        if net <= 0:
            b["bilanz"] = 20
            plus.append("Mehr Cash als Schulden")
        elif ebitda and ebitda > 0:
            x = net / ebitda
            b["bilanz"] = stufe_wert(-x, [(-1, 16), (-2, 13), (-3.5, 7)], 2)
            if x >= 3.5:
                minus.append(f"Hohe Verschuldung ({x:.1f}× EBITDA)")
        else:
            b["bilanz"] = 0
            minus.append("Schulden bei negativem operativem Ergebnis")
    if fcf_rendite is not None:
        if fcf_rendite >= 4:
            plus.append(f"Viel Free Cashflow im Verhältnis zum Börsenwert ({fcf_rendite:.1f} %)")
        elif fcf_rendite < 0:
            minus.append("Free Cashflow negativ")
    return {
        "score": round(sum(b.values()) / len(b) * 5) if len(b) >= 3 else None,
        "bausteine": b, "plus": plus, "minus": minus,
        "m": {"umsatzwachstum": wachstum, "gewinnwachstum": gewinn, "op_marge": marge, "roe": roe, "kgv": clean(info.get("trailingPE")), "kgv_erwartet": fpe, "peg": peg,
              "kuv": kuv, "dividende": clean(info.get("dividendYield")), "fcf_rendite": fcf_rendite},
        "marktkap": mc, "sektor": info.get("sector"), "branche": info.get("industry"),
        "analysten": info.get("recommendationKey"), "kursziel": clean(info.get("targetMeanPrice")),
    }


def entdecken_eintrag(entry, p, s, waehrung, in_watchlist, heiss):
    keys = ("kurs", "tag_pct", "rueckgang_ath", "abstand_sma200", "rsi", "perf_1m", "perf_6m", "perf_1j")
    return {k: entry.get(k) for k in ("symbol", "name", "kategorie", "thema", "bekannt", "kurz", "these", "risiko")} | \
        {k: p.get(k) for k in keys} | s | {"waehrung": waehrung, "in_watchlist": in_watchlist, "heiss": heiss}


def scan_universe(watch, rules, profiles, items):
    """Daten-Score für die Watchlist und die zusätzlichen Ideen aus config/universe.json."""
    out = []
    for w in items:
        if w.get("screen"):
            prof = profiles.get(w["symbol"]) or {}
            risiko = " · ".join((prof.get("risiken") or [])[:2])
            out.append(entdecken_eintrag({**w, "kurz": prof.get("kurz"), "these": prof.get("zukunft"), "risiko": risiko},
                                         w, w["screen"], w.get("waehrung"), True, w.get("heiss")))
    im_tracker = {w["symbol"].upper() for w in watch}
    for e in (load_json(CONFIG / "universe.json", {}) or {}).get("werte", []):
        if e["symbol"].upper() in im_tracker:
            continue
        try:
            t = yf.Ticker(e["symbol"])
            hist = t.history(period="max", auto_adjust=False)
            if hist is None or hist.empty:
                raise RuntimeError("keine Kursdaten")
            p = price_block(hist, rules["stufen"])
            info = t.info or {}
            out.append(entdecken_eintrag(e, p, screen(info, p), info.get("currency"), False, overheat_level(p, "aktie", rules)))
            print("ok    Idee", e["symbol"])
        except Exception as ex:
            print("FEHLER Idee", e["symbol"], scrub(ex))
    return sorted(out, key=lambda x: -(x["score"] or 0))


def process_ticker(entry, rules, state, meldungen, profiles, politik):
    sym = entry["symbol"]
    # Neu aufgenommene Werte: Ausgangszustand speichern, aber nichts für den Wochenbericht vormerken
    bekannt = state.setdefault("bekannt", [])
    tg_name = html.escape(entry["name"])
    meldungen_start = len(meldungen)
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
    bestand = [] if is_etf or "." in sym else insider_bestand(t)
    since = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")
    ins_kaeufe_90 = [x for x in ins if x["art"] == "kauf" and x["datum"] >= since]
    us_aktie = not is_etf and "." not in sym
    pol = congress_trades(sym) if us_aktie else None
    pol_90 = [x for x in (pol or []) if (x.get("gemeldet") or "") >= since]
    politik.extend(pol_90)
    heiss = overheat_level(p, entry.get("typ"), rules)

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
        "politiker_90t": len(pol_90),
        "heiss": heiss,
        "pruefung_gruen": sum(1 for x in (f or {}).get("pruefung", []) if x["farbe"] == "gruen"),
        "pruefung_rot": sum(1 for x in (f or {}).get("pruefung", []) if x["farbe"] == "rot"),
        "pruefung_anzahl": len((f or {}).get("pruefung", [])),
        "ceo": next((o["name"] for o in (f or {}).get("management", []) if o["ceo"]), None),
        "sektor": (f or {}).get("sektor"),
        "branche": (f or {}).get("branche"),
        "screen": None if is_etf else screen(info, p),
    }
    detail = {"item": item, "historie": history_series(hist), "fundamentaldaten": f, "insider": ins, "insider_bestand": bestand,
              "politiker": pol, "profil": profiles.get(sym)}
    save_json(OUT / "werte" / f"{safe_name(sym)}.json", detail)

    # Bewegungen landen gesammelt im Wochenbericht, sofort kommen nur eigene Preisalarme
    seen_p = state.setdefault("politiker_gemeldet", {})
    for x in pol_90:
        key = f"{sym}|{x['person']}|{x['datum']}|{x['art']}|{x['betrag']}"
        if key not in seen_p:
            seen_p[key] = x["gemeldet"]
            if state.get("initialisiert") and state.get("politiker_init"):
                art = "Kauf" if x["art"] == "kauf" else "Verkauf"
                meldungen.append({"art": "politiker", "text": f"{tg_name}: {art} von {html.escape(str(x['person']))} ({html.escape(str(x['betrag']))})"})

    seen = state.setdefault("insider_gemeldet", {})
    for x in ins_kaeufe_90:
        key = f"{sym}|{x['datum']}|{x['person']}|{x['aktien']}"
        if key not in seen:
            seen[key] = x["datum"]
            if state.get("initialisiert"):
                wert = f" für {de_zahl(x['wert'] / 1e6)} Mio. $" if x["wert"] else ""
                meldungen.append({"art": "insider", "text": f"{tg_name}: {html.escape(x['person'])} ({html.escape(x['position'])}){wert}"})
    if sym not in bekannt:
        del meldungen[meldungen_start:]
        bekannt.append(sym)
    return item


def wechselkurse(items, entdecken):
    """Kurs in Euro je Währungseinheit, für den Größenvergleich zwischen Aktien."""
    out = {"EUR": 1.0}
    for c in sorted({x.get("waehrung") for x in [*items, *entdecken] if x.get("waehrung")} - {"EUR"}):
        basis, faktor = ("GBP", 0.01) if c in ("GBp", "GBX") else (c, 1)
        try:
            kurs = yf.Ticker(f"{basis}EUR=X").history(period="5d")["Close"].dropna()
            out[c] = float(kurs.iloc[-1]) * faktor
        except Exception as ex:
            print("FEHLER Wechselkurs", c, scrub(ex))
    return out


# ---------------------------------------------------------------- Eigene Preisalarme

ALARM_DATEI = CONFIG / "alarme.json"


def de_zahl(v, d=2):
    return f"{v:,.{d}f}".replace(",", "§").replace(".", ",").replace("§", ".")


def alarm_erreicht(a, w):
    """Auch ein Tagestief oder -hoch zwischen zwei Läufen zählt, damit kurze Ausschläge nicht untergehen."""
    if a["art"] == "kurs_unter":
        return (w.get("tag_tief") or w["kurs"]) <= a["wert"]
    if a["art"] == "kurs_ueber":
        return (w.get("tag_hoch") or w["kurs"]) >= a["wert"]
    return a["art"] == "rueckgang_ath" and w["rueckgang_ath"] >= a["wert"]


def alarm_text(a, w):
    cur = w.get("waehrung") or ""
    grund = {
        "kurs_unter": f"Der Kurs ist auf deine Grenze von {de_zahl(a['wert'])} {cur} gefallen.",
        "kurs_ueber": f"Der Kurs ist auf deine Grenze von {de_zahl(a['wert'])} {cur} gestiegen.",
        "rueckgang_ath": f"Der Kurs liegt mindestens {de_zahl(a['wert'], 0)} % unter dem Allzeithoch.",
    }[a["art"]]
    z = [f"🔔 <b>Preisalarm: {html.escape(w['name'])}</b>", grund, "",
         f"Aktuell: <b>{de_zahl(w['kurs'])} {cur}</b> ({fmt_pct(w.get('tag_pct')).replace('.', ',')} heute)",
         f"{de_zahl(w['rueckgang_ath'], 0)} % unter dem Allzeithoch"]
    if (w.get("ampel") or {}).get("farbe"):
        z.append("Letztes Quartal: " + {"gruen": "stark", "gelb": "gemischt", "rot": "schwach"}[w["ampel"]["farbe"]])
    if (w.get("naechste_zahlen") or "") >= datetime.now().strftime("%Y-%m-%d"):
        n = w["naechste_zahlen"]
        z.append(f"Nächste Quartalszahlen: {n[8:10]}.{n[5:7]}.{n[:4]}")
    if a.get("notiz"):
        z += ["", f"Deine Notiz: {html.escape(a['notiz'])}"]
    repo = os.environ.get("GITHUB_REPOSITORY") or "JanSchnell/AktienTracker"
    owner, name_repo = repo.split("/")
    z += ["", "Prüfe vor einer Entscheidung, warum sich der Kurs so bewegt hat.",
          f"https://{owner.lower()}.github.io/{name_repo}/#/wert/{w['symbol']}"]
    return "\n".join(z)


def alarme_pruefen(items, now):
    """Löst jeden Alarm einmal aus. Scheitert das Senden, bleibt er aktiv und wird beim nächsten Lauf wiederholt."""
    daten = load_json(ALARM_DATEI, {"alarme": []}) or {"alarme": []}
    werte = {w["symbol"]: w for w in items}
    geaendert = False
    for a in daten["alarme"]:
        w = werte.get(a["symbol"])
        if a.get("ausgeloest") or not w or not alarm_erreicht(a, w):
            continue
        if telegram(alarm_text(a, w)):
            a["ausgeloest"] = now.strftime("%Y-%m-%d")
            a["kurs_ausloesung"] = w["kurs"]
            geaendert = True
    if geaendert:
        ALARM_DATEI.write_text(json.dumps(daten, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return daten["alarme"]


# ---------------------------------------------------------------- Wochenbericht

def woche_key(now):
    """Montag der Berichtswoche: Sonntag und der Montag danach ergeben denselben Schlüssel."""
    tag = now.date() + timedelta(days=1)
    return (tag - timedelta(days=tag.weekday())).isoformat()


def wochenbericht(items, entdecken, state, now):
    """Telegram-Zusammenfassung. Liefert (text, neuer Stand für den nächsten Vergleich)."""
    zeilen = [f"🗓 <b>Wochenrückblick</b> {now.strftime('%d.%m.%Y')}"]
    name = lambda w: html.escape(w["name"])

    bew = sorted((w for w in items if w.get("perf_1w") is not None), key=lambda w: w["perf_1w"], reverse=True)
    if bew:
        zeilen += ["", "<b>Stärkste Kursbewegungen (1 Woche)</b>"]
        zeilen += [f"📈 {name(w)} {fmt_pct(w["perf_1w"]).replace(".", ",")}" for w in bew[:3] if w["perf_1w"] > 0]
        zeilen += [f"📉 {name(w)} {fmt_pct(w["perf_1w"]).replace(".", ",")}" for w in bew[::-1][:3] if w["perf_1w"] < 0]

    heute, bis = now.strftime("%Y-%m-%d"), (now + timedelta(days=8)).strftime("%Y-%m-%d")
    zahlen = sorted((w for w in items if heute <= (w.get("naechste_zahlen") or "")[:10] <= bis), key=lambda w: w["naechste_zahlen"])
    if zahlen:
        zeilen += ["", "<b>Quartalszahlen in den nächsten Tagen</b>"]
        zeilen += [f"• {w['naechste_zahlen'][8:10]}.{w['naechste_zahlen'][5:7]}. {name(w)}" for w in zahlen[:12]]
        if len(zahlen) > 12:
            zeilen.append(f"… und {len(zahlen) - 12} weitere")

    stufen_alt = state.get("woche_stufen")
    stufen_neu = {w["symbol"]: w.get("stufe") or 0 for w in items}
    if stufen_alt:
        neu_in_stufe = [w for w in items if (w.get("stufe") or 0) > stufen_alt.get(w["symbol"], w.get("stufe") or 0)]
        if neu_in_stufe:
            zeilen += ["", "<b>Neu in einer höheren Kaufstufe</b>"]
            zeilen += [f"• {name(w)}: {w['rueckgang_ath']:.0f} % unter Allzeithoch" for w in neu_in_stufe[:8]]
    heiss = [w for w in items if w.get("heiss")]
    if heiss:
        zeilen += ["", f"🔥 <b>Heiß gelaufen:</b> {', '.join(name(w) for w in heiss[:6])}"]

    log = state.get("woche_log", [])
    for art, titel, n in (("insider", "🟢 <b>Insider-Käufe</b>", 6), ("politiker", "🏛 <b>Politiker-Trades</b>", 5), ("13f", "🏦 <b>Neue Meldungen großer Investoren</b>", 4)):
        eintraege = [m["text"] for m in log if m["art"] == art]
        if eintraege:
            zeilen += ["", titel] + [f"• {t}" for t in eintraege[:n]]
            if len(eintraege) > n:
                zeilen.append(f"… und {len(eintraege) - n} weitere")

    schon = state.get("woche_ideen", [])
    ideen = [x for x in entdecken if not x.get("in_watchlist") and (x.get("score") or 0) >= 70 and x["symbol"] not in schon][:3]
    if ideen:
        zeilen += ["", "<b>Neue Ideen für deine Recherche</b>"]
        for x in ideen:
            grund = html.escape((x.get("plus") or [x.get("kurz") or ""])[0])
            zeilen.append(f"💡 <b>{html.escape(x['name'])}</b> ({html.escape(x['kategorie'])}, Score {x['score']}): {grund}")

    repo = os.environ.get("GITHUB_REPOSITORY") or "JanSchnell/AktienTracker"
    owner, name_repo = repo.split("/")
    fuss = ["", "Automatisch aus festen Regeln erstellt, keine Kaufempfehlung.", f"https://{owner.lower()}.github.io/{name_repo}/"]
    # Telegram erlaubt 4096 Zeichen. Zeilenweise kürzen, damit keine Formatierung zerschnitten wird.
    while len("\n".join(zeilen + fuss)) > 3900:
        zeilen.pop()
    # Ideen rotieren: bereits genannte erst wieder nach längerer Zeit
    stand = {"woche_stufen": stufen_neu, "woche_ideen": (schon + [x["symbol"] for x in ideen])[-30:]}
    return "\n".join(zeilen + fuss), stand


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


def investor_holdings(inv, state, meldungen):
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
        # Lange Depots kurz halten: je Art nur wenige Namen
        kurz = []
        for titel, art in (("neu", "neu"), ("komplett verkauft", "verkauft")):
            namen = [html.escape(x["name"]) for x in pos if x["aenderung"] == art]
            if namen:
                kurz.append(f"{titel} {', '.join(namen[:4])}" + (f" +{len(namen) - 4}" if len(namen) > 4 else ""))
        meldungen.append({"art": "13f", "text": f"{html.escape(inv['name'])} (Stichtag {rdat}): " + ("; ".join(kurz) or "nur Änderungen an bestehenden Positionen")})
    cache[cik] = {"acc": acc_neu, "ergebnis": ergebnis}
    return ergebnis


# ---------------------------------------------------------------- Hauptprogramm

def main():
    watch = load_json(CONFIG / "watchlist.json")["werte"]
    rules = load_json(CONFIG / "rules.json")
    investors = (load_json(CONFIG / "investors.json", {}) or {}).get("investoren", [])
    state = load_json(STATE_FILE, {}) or {}
    profiles = load_profiles()
    meldungen, fehler, items, politik = [], [], [], []
    # Frühere Alarm-Stände ablösen: die Stufen dienen einmalig als Vergleich für den ersten Bericht
    alte_stufen = state.pop("stufen", None)
    if alte_stufen and "woche_stufen" not in state:
        state["woche_stufen"] = alte_stufen
    state.pop("heiss", None)

    for e in watch:
        try:
            items.append(process_ticker(e, rules, state, meldungen, profiles, politik))
            print("ok   ", e["symbol"])
        except Exception as ex:
            fehler.append({"symbol": e["symbol"], "fehler": scrub(ex)})
            print("FEHLER", e["symbol"], scrub(ex))
    state["politiker_init"] = True

    inv_out = []
    for inv in investors:
        try:
            # Beschreibung frisch aus der Konfiguration, das Filing-Ergebnis kann aus dem Cache kommen
            inv_out.append({**investor_holdings(inv, state, meldungen), "person": inv.get("person"), "kurz": inv.get("kurz"), "beschreibung": inv.get("beschreibung")})
            print("ok    13F", inv["name"])
        except Exception as ex:
            fehler.append({"symbol": f"13F {inv['name']}", "fehler": scrub(ex)})
            print("FEHLER 13F", inv["name"], scrub(ex))

    entdecken = scan_universe(watch, rules, profiles, items)
    alarme = alarme_pruefen(items, datetime.now(timezone.utc))
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    namen = {e["symbol"]: e["name"] for e in watch}
    for x in politik:
        x["name"] = namen.get(x["symbol"], x["symbol"])
    politik.sort(key=lambda x: (x.get("gemeldet") or "", x.get("datum") or ""), reverse=True)
    save_json(OUT / "overview.json", {"aktualisiert": now, "regeln": rules, "werte": items, "fehler": fehler, "fx": wechselkurse(items, entdecken), "alarme": alarme,
                                      "repo": os.environ.get("GITHUB_REPOSITORY") or "JanSchnell/AktienTracker"})
    save_json(OUT / "investoren.json", {"aktualisiert": now, "investoren": inv_out, "politiker": politik})
    save_json(OUT / "entdecken.json", {"aktualisiert": now, "werte": entdecken})

    if state.get("initialisiert"):
        state["woche_log"] = (state.get("woche_log", []) + meldungen)[-200:]
    jetzt = datetime.now(timezone.utc)
    erzwungen = os.environ.get("WOCHENBERICHT") == "true"
    if erzwungen or (state.get("initialisiert") and jetzt.weekday() in (6, 0) and state.get("woche_gesendet") != woche_key(jetzt)):
        text, stand = wochenbericht(items, entdecken, state, jetzt)
        # Scheitert das Senden, bleibt alles gesammelt und der nächste Lauf versucht es erneut.
        # Ein manueller Test ändert nichts am regulären Bericht.
        if telegram(text) and not erzwungen:
            state.update(stand, woche_gesendet=woche_key(jetzt), woche_log=[])
    state["initialisiert"] = True
    save_json(STATE_FILE, state)
    print(f"Fertig: {len(items)} Werte, {len(inv_out)} Investoren, {len(fehler)} Fehler, {len(meldungen)} neue Meldungen für den Wochenbericht.")
    return 0 if items else 1


if __name__ == "__main__":
    sys.exit(main())
