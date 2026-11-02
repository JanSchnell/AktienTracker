# Aktien-Tracker

Dein persönlicher Analyst für die Watchlist. Mehrmals täglich werden automatisch geladen:

- **Kurse** und **Rückgang vom Allzeithoch** mit Einstufung nach deinen Kaufstufen (‑10 / ‑20 / ‑30 % …)
- **Quartalszahlen**: Umsatz, Margen, Gewinn je Aktie, Free Cashflow, Wachstum, Trend-Ampel, Termin der nächsten Zahlen, Analysten-Kursziele
- **Insider-Trades** (US-Werte): Manager, die eigene Aktien kaufen oder verkaufen
- **13F-Filings großer Investoren**: Berkshire Hathaway, Pershing Square (Ackman), Duquesne (Druckenmiller) usw. Neu, aufgestockt, reduziert, verkauft
- **Telegram-Nachricht**, wenn ein Wert eine neue Kaufstufe erreicht, ein Insider kauft oder ein neues 13F erscheint

Das Tool **kauft und verkauft nichts** und ist keine Anlageberatung. Es zeigt Daten und wendet deine eigenen Regeln an.

## Dateien

| Datei | Zweck |
|---|---|
| `config/watchlist.json` | Deine Werte (Yahoo-Ticker, Name, Typ, Kategorie) |
| `config/rules.json` | Kaufstufen und Grundbeträge |
| `config/investors.json` | Beobachtete Investoren (SEC-CIK-Nummer) |
| `scripts/update.py` | Lädt alle Daten und schickt Telegram-Nachrichten |
| `docs/` | Die Webseite (Dashboard) |
| `.github/workflows/update.yml` | Automatischer Lauf 4× pro Werktag |

## Einrichtung (einmalig, ca. 15 Minuten)

### 1. GitHub-Repository anlegen
1. Auf [github.com](https://github.com) ein kostenloses Konto anlegen.
2. Oben rechts **+ → New repository**, Name z. B. `aktien-tracker`, Sichtbarkeit **Public**, dann **Create repository**.
   (Die Seite ist kostenlos nur mit öffentlichem Repository. Jeder mit dem Link kann dann deine Watchlist sehen, aber keine Depotdaten, denn die gibt es hier nicht.)
3. Dateien hochladen, z. B. mit diesen Befehlen in diesem Ordner (Adresse anpassen):
   ```bash
   git init -b main
   git add .
   git commit -m "Aktien-Tracker"
   git remote add origin https://github.com/DEIN-NAME/aktien-tracker.git
   git push -u origin main
   ```

### 2. Webseite aktivieren
Im Repository: **Settings → Pages → Source: „GitHub Actions“**.

### 3. Telegram-Bot (für Benachrichtigungen)
1. In Telegram **@BotFather** öffnen, `/newbot` senden, Namen vergeben. Du bekommst einen **Token**.
2. Deinem neuen Bot eine beliebige Nachricht schicken (z. B. „Hallo“).
3. Im Browser `https://api.telegram.org/bot<TOKEN>/getUpdates` öffnen. Bei `"chat":{"id":…}` steht deine **Chat-ID**.
4. Im Repository: **Settings → Secrets and variables → Actions → New repository secret**:
   - `TELEGRAM_BOT_TOKEN` = der Token
   - `TELEGRAM_CHAT_ID` = die Chat-ID
   - `SEC_USER_AGENT` = `AktienTracker deine@email.de` (die SEC verlangt eine Kontaktangabe für ihre Datenschnittstelle)

### 4. Erster Lauf
**Actions → „Daten aktualisieren“ → Run workflow.** Nach 2–4 Minuten ist die Seite erreichbar unter
`https://DEIN-NAME.github.io/aktien-tracker/`. Auf dem Handy über „Zum Startbildschirm hinzufügen“ wie eine App nutzen.

Der erste Lauf merkt sich nur den Ausgangszustand und schickt keine Nachrichten. Ab dann meldet er nur **Neues**.

## Anpassen

- **Watchlist ändern:** `config/watchlist.json` auf GitHub öffnen → Stift-Symbol → bearbeiten → „Commit changes“. Die Seite aktualisiert sich automatisch.
  Ticker findest du auf [finance.yahoo.com](https://finance.yahoo.com) (z. B. `SAP.DE`, `ASML.AS`, `NVDA`).
- **Regeln ändern:** `config/rules.json`, Felder `ab_prozent`, `faktor`, `grundbetrag`.
- **Zeiten ändern:** `cron`-Zeilen in `.github/workflows/update.yml` (Zeiten in UTC).

## Lokal testen

```bash
pip install -r requirements.txt
python scripts/update.py
python -m http.server 8765 --directory docs
```
Dann `http://localhost:8765` öffnen.

## Grenzen

- Yahoo Finance ist eine inoffizielle, kostenlose Quelle. Gelegentlich fehlen Werte oder ein Lauf schlägt fehl. Der nächste Lauf holt das nach.
- Quartalszahlen gibt es für die letzten ~5 Quartale. Insider-Daten nur für US-Werte.
- 13F-Daten erscheinen bis zu 45 Tage nach Quartalsende und enthalten nur US-Aktien.
- Politiker-Trades: Dafür gibt es keine verlässliche kostenlose Schnittstelle. Auf jeder Unternehmensseite ist ein Link zu Capitol Trades.
