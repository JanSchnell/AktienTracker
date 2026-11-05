"use strict";

// ------------------------------------------------------------ Hilfsfunktionen

const $app = document.getElementById("app");
const nf = (d) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (v, d = 2) => (v == null || isNaN(v) ? "–" : nf(d).format(v));
const fmtPct = (v, d = 1, sign = true) =>
  v == null || isNaN(v) ? "–" : (sign && v > 0 ? "+" : "") + nf(d).format(Math.abs(v) < 0.5 * 10 ** -d ? 0 : v) + " %";
const fmtRatio = (v, d = 1) => (v == null ? "–" : fmtPct(v * 100, d, false));
const cls = (v) => (v == null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safe = (s) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const big = (v) => {
  if (v == null) return "–";
  const a = Math.abs(v);
  if (a >= 1e12) return fmt(v / 1e12, 2) + " Bio.";
  if (a >= 1e9) return fmt(v / 1e9, 2) + " Mrd.";
  if (a >= 1e6) return fmt(v / 1e6, 1) + " Mio.";
  return fmt(v, 0);
};
const date = (s) => (s ? new Date(s).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "–");
const daysUntil = (s) => (s ? Math.ceil((new Date(s) - new Date()) / 864e5) : null);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const EMPFEHLUNG = { strong_buy: "Starker Kauf", buy: "Kaufen", hold: "Halten", underperform: "Untergewichten", sell: "Verkaufen", none: "–" };

let OV = null;   // overview.json
let INV = null;  // investoren.json
let ENT = null;  // entdecken.json
let charts = [];

async function getJSON(url) {
  const r = await fetch(url + "?t=" + Date.now());
  if (!r.ok) throw new Error(url + ": " + r.status);
  return r.json();
}

// Beträge je Stufe: eigene Eingabe auf diesem Gerät, sonst Vorgabe aus config/rules.json
function betraege() {
  const r = OV.regeln, eigene = store.get("betraege", {}) || {};
  const liste = (typ) => r.stufen.map((s, i) => { const v = (eigene[typ] || [])[i]; return v != null ? v : r.grundbetrag[typ] * s.faktor; });
  return { etf: liste("etf"), aktie: liste("aktie") };
}
const betragFuer = (w) => (w.stufe ? betraege()[w.typ === "etf" ? "etf" : "aktie"][w.stufe - 1] : 0);
function applyBetraege() { OV.werte.forEach((w) => { w.zusatzkauf = betragFuer(w); }); }

function tierBadge(w) {
  if (!w.stufe) return `<span class="tier tier-0">–</span>`;
  const s = OV.regeln.stufen[w.stufe - 1];
  return `<span class="tier tier-${w.stufe}" title="ab −${s.ab_prozent} % unter Allzeithoch">${esc(s.name)}</span>`;
}

function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }

function heatBadge(w) {
  if (!w.heiss) return "";
  return w.heiss === 2
    ? `<span class="badge hot2" title="Sehr weit über der 200-Tage-Linie – Gewinnmitnahme/Positionsgröße prüfen">🔥🔥 sehr heiß</span>`
    : `<span class="badge hot" title="Deutlich über der 200-Tage-Linie oder RSI hoch">🔥 heiß</span>`;
}

function checkBadge(w) {
  if (!w.pruefung_anzahl) return "–";
  const r = w.pruefung_gruen / w.pruefung_anzahl;
  const f = r >= 0.6 && !w.pruefung_rot ? "gruen" : r >= 0.6 || w.pruefung_rot <= 1 ? "gelb" : "rot";
  return `<span class="dot ${f}"></span> ${w.pruefung_gruen}/${w.pruefung_anzahl}`;
}

const repo = () => OV.repo || "JanSchnell/AktienTracker";
function issueUrl(title, lines) {
  return `https://github.com/${repo()}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

// ------------------------------------------------------------ Begriffe antippen

const term = (id, label) => `<button type="button" class="term" data-term="${id}">${label}</button>`;
const LEX_INDEX = {};
LEXIKON.forEach((g) => g.eintraege.forEach((e) => { LEX_INDEX[e.id] = e; }));

function showTerm(btn) {
  const e = LEX_INDEX[btn.dataset.term];
  if (!e) return;
  let pop = document.getElementById("pop");
  if (!pop) { pop = document.createElement("div"); pop.id = "pop"; pop.className = "pop"; document.body.appendChild(pop); }
  pop.innerHTML = `<strong>${esc(e.name)}</strong><p>${esc(e.kurz)}</p>${e.faust ? `<p class="muted">Faustregel: ${esc(e.faust)}</p>` : ""}
    <a href="#/lexikon/${e.id}">Im Lexikon lesen →</a>`;
  pop.hidden = false;
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - w - 8)) + "px";
  pop.style.top = (r.bottom + h + 12 > innerHeight ? r.top + scrollY - h - 6 : r.bottom + scrollY + 6) + "px";
}
const hideTerm = () => { const pop = document.getElementById("pop"); if (pop) pop.hidden = true; };
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest && ev.target.closest(".term");
  if (btn) { ev.preventDefault(); ev.stopPropagation(); showTerm(btn); return; }
  if (!ev.target.closest || !ev.target.closest("#pop") || ev.target.closest("a")) hideTerm();
}, true);

// ------------------------------------------------------------ Entfernen und Ausblenden

const versteckt = () => store.get("versteckt", []);
const sichtbar = () => OV.werte.filter((w) => !versteckt().includes(w.symbol));

function removeDialog(sym, name, nachher) {
  const dlg = document.createElement("dialog");
  dlg.className = "dlg";
  dlg.innerHTML = `<h3>${esc(name)} entfernen</h3>
    <p class="small"><strong>Ausblenden</strong> wirkt sofort, aber nur auf diesem Gerät und lässt sich jederzeit rückgängig machen.</p>
    <p class="small"><strong>Dauerhaft entfernen</strong> löscht den Wert für alle Geräte und stoppt seine Alarme. Dafür öffnet sich GitHub, dort nur noch auf „Create“ tippen.</p>
    <div class="dlg-actions">
      <button class="chip on" data-a="hide">Ausblenden</button>
      <a class="chip" data-a="perm" target="_blank" rel="noopener" href="${issueUrl(`Watchlist: entfernen ${sym}`, ["aktion: entfernen", `symbol: ${sym}`])}">Dauerhaft entfernen</a>
      <button class="chip" data-a="close">Abbrechen</button>
    </div>`;
  document.body.appendChild(dlg);
  const zu = () => { dlg.close(); dlg.remove(); };
  const ausblenden = () => { store.set("versteckt", [...new Set([...versteckt(), sym])]); zu(); nachher(); };
  dlg.addEventListener("click", (ev) => {
    const a = ev.target.dataset.a;
    if (a === "hide" || a === "perm") ausblenden();
    else if (a === "close" || ev.target === dlg) zu();
  });
  dlg.showModal();
}

// ------------------------------------------------------------ Übersicht

const state = {
  kat: store.get("kat", "Alle"),
  sort: store.get("sort", { key: "rueckgang_ath", asc: false }),
  q: "",
  fokus: null,
};

const FOKUS = {
  stufe: { label: "In einer Kaufstufe", test: (w) => w.stufe > 0 },
  ath: { label: "Nahe Allzeithoch (unter 3 %)", test: (w) => w.rueckgang_ath < 3 },
  heiss: { label: "Heiß gelaufen", test: (w) => w.heiss > 0 },
  zahlen: { label: "Quartalszahlen in den nächsten 14 Tagen", test: (w) => { const d = daysUntil(w.naechste_zahlen); return d != null && d >= 0 && d <= 14; } },
  insider: { label: "Insider-Käufe in den letzten 90 Tagen", test: (w) => w.insider_kaeufe_90t > 0 },
};

const COLS = [
  { key: "name", label: "Wert", get: (w) => w.name.toLowerCase() },
  { key: "kurs", label: "Kurs", get: (w) => w.kurs },
  { key: "tag_pct", label: "Heute", get: (w) => w.tag_pct },
  { key: "rueckgang_ath", label: "vom ATH", get: (w) => w.rueckgang_ath },
  { key: "stufe", label: "Stufe", get: (w) => w.stufe },
  { key: "zusatzkauf", label: "Mein Betrag", get: (w) => w.zusatzkauf, hide: true },
  { key: "abstand_sma200", label: "vs. 200-Tage", get: (w) => w.abstand_sma200, hide: true },
  { key: "perf_1j", label: "1 Jahr", get: (w) => w.perf_1j, hide: true },
  { key: "kgv_erwartet", label: "KGV erw.", get: (w) => w.kgv_erwartet, hide: true },
  { key: "ampel", label: "Ampel", get: (w) => (w.ampel ? w.ampel.punkte : null), hide: true },
  { key: "pruefung_gruen", label: "Check", get: (w) => (w.pruefung_anzahl ? w.pruefung_gruen / w.pruefung_anzahl : null), hide: true },
  { key: "score", label: "Score", get: (w) => (w.screen ? w.screen.score : null), hide: true },
  { key: "naechste_zahlen", label: "Zahlen am", get: (w) => w.naechste_zahlen || "9999", hide: true },
];

function statTile(key, label, value, sub) {
  return `<button type="button" class="card stat ${state.fokus === key ? "on" : ""}" data-fokus="${key}"><div class="label">${label}</div><div class="value">${value}</div>
    <div class="sub">${esc(sub)}</div></button>`;
}

function renderOverview() {
  const werte = sichtbar();
  const kats = ["Alle", ...new Set(werte.map((w) => w.kategorie))];
  if (!kats.includes(state.kat)) state.kat = "Alle";
  const namen = (f, n = 3) => werte.filter(FOKUS[f].test).slice(0, n).map((w) => w.name).join(", ") || "keine";
  const zahl = (f) => werte.filter(FOKUS[f].test).length;
  const tiefste = [...werte].sort((a, b) => b.rueckgang_ath - a.rueckgang_ath)[0];
  const weg = versteckt().filter((s) => OV.werte.some((w) => w.symbol === s)).length;

  $app.innerHTML = `
    <div class="grid stats">
      ${statTile("stufe", "In einer Kaufstufe", `${zahl("stufe")} / ${werte.length}`, `mindestens ${OV.regeln.stufen[0].ab_prozent} % unter Allzeithoch`)}
      ${tiefste ? `<a class="card stat" href="#/wert/${encodeURIComponent(tiefste.symbol)}"><div class="label">Größter Rückgang</div><div class="value neg">${fmtPct(-tiefste.rueckgang_ath)}</div>
        <div class="sub">${esc(tiefste.name)} öffnen →</div></a>` : ""}
      ${statTile("ath", "Nahe Allzeithoch (&lt; 3 %)", zahl("ath"), namen("ath"))}
      ${statTile("heiss", "Heiß gelaufen 🔥", zahl("heiss"), namen("heiss"))}
      ${statTile("zahlen", "Quartalszahlen in 14 Tagen", zahl("zahlen"), namen("zahlen"))}
      ${statTile("insider", "Insider-Käufe (90 Tage)", zahl("insider"), namen("insider"))}
    </div>

    <div class="toolbar filter">
      <select id="katWahl" class="${state.kat !== "Alle" ? "aktiv" : ""}" aria-label="Nach Branche filtern">
        ${kats.map((k) => `<option value="${esc(k)}" ${k === state.kat ? "selected" : ""}>${k === "Alle" ? "Alle Branchen" : esc(k)} (${k === "Alle" ? werte.length : werte.filter((w) => w.kategorie === k).length})</option>`).join("")}
      </select>
      <input type="search" id="q" placeholder="Suchen: Name, Ticker …" value="${esc(state.q)}">
      <button class="chip add" id="addBtn">＋ Wert hinzufügen</button>
    </div>
    <div class="card" id="addForm" hidden style="margin-bottom:12px">
      <h3>Wert zur Watchlist hinzufügen</h3>
      <div class="form">
        <label>Name oder Ticker<input id="fQ" placeholder="z. B. Coca-Cola, KO, Rheinmetall, RHM.DE"></label>
        <label>Kategorie<select id="fKat">${[...kats.slice(1), "Eigene Auswahl"].filter((v, i, a) => a.indexOf(v) === i).map((k) => `<option ${k === "Eigene Auswahl" ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></label>
        <label>Typ<select id="fTyp"><option value="">automatisch</option><option value="aktie">Aktie</option><option value="etf">ETF</option></select></label>
        <button class="chip on" id="fGo">Weiter zu GitHub →</button>
      </div>
      <p class="muted small" style="margin:10px 0 0">Es öffnet sich GitHub mit einer vorausgefüllten Anfrage. Dort nur noch auf <strong>„Create“</strong> tippen (du musst bei GitHub angemeldet sein).
        Der Ticker wird automatisch gesucht, nach ca. 3–5 Minuten erscheint der Wert hier. Bei Unklarheiten den genauen Yahoo-Ticker angeben (z. B. <code>RHM.DE</code>).</p>
    </div>
    ${state.fokus ? `<div class="filterbar"><span>Filter: <strong>${FOKUS[state.fokus].label}</strong></span><button class="chip" id="fokusAus">Filter aufheben ✕</button></div>` : ""}
    <div class="tbl-wrap" id="tblBox"><table id="tbl"><thead></thead><tbody></tbody></table></div>
    <p class="muted small">Rückgang und Stufe beziehen sich auf den höchsten Schlusskurs der gesamten Historie in Handelswährung.
      „Mein Betrag“ = dein Betrag für diese Stufe, einstellbar unter <a href="#/regeln">Kaufregeln</a>.
      Klick auf eine Zeile öffnet die Analyse, ✕ entfernt den Wert.
      ${weg ? `<button class="linkbtn" id="showAll">${weg} ausgeblendet, wieder einblenden</button>` : ""}</p>
    ${ideenTeaser()}`;

  document.getElementById("katWahl").addEventListener("change", (ev) => { state.kat = ev.target.value; store.set("kat", state.kat); renderOverview(); });
  $app.querySelectorAll("[data-fokus]").forEach((b) => b.addEventListener("click", () => {
    state.fokus = state.fokus === b.dataset.fokus ? null : b.dataset.fokus;
    state.kat = "Alle";
    renderOverview();
    if (state.fokus) document.querySelector(".filterbar").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  const aus = document.getElementById("fokusAus");
  if (aus) aus.addEventListener("click", () => { state.fokus = null; renderOverview(); });
  const alle = document.getElementById("showAll");
  if (alle) alle.addEventListener("click", () => { store.set("versteckt", []); renderOverview(); });
  const q = document.getElementById("q");
  q.addEventListener("input", () => { state.q = q.value; renderRows(); });
  const form = document.getElementById("addForm");
  document.getElementById("addBtn").addEventListener("click", () => { form.hidden = !form.hidden; if (!form.hidden) document.getElementById("fQ").focus(); });
  document.getElementById("fGo").addEventListener("click", () => {
    const v = document.getElementById("fQ").value.trim();
    if (!v) return document.getElementById("fQ").focus();
    window.open(issueUrl(`Watchlist: hinzufügen ${v}`, [
      "aktion: hinzufuegen", `suche: ${v}`,
      `kategorie: ${document.getElementById("fKat").value}`, `typ: ${document.getElementById("fTyp").value}`,
    ]), "_blank", "noopener");
  });
  renderRows();
}

function renderRows() {
  const col = COLS.find((c) => c.key === state.sort.key) || COLS[3];
  const q = state.q.trim().toLowerCase();
  let rows = sichtbar().filter((w) => (state.kat === "Alle" || w.kategorie === state.kat) &&
    (!state.fokus || FOKUS[state.fokus].test(w)) &&
    (!q || [w.name, w.symbol, w.langname, w.kategorie, w.sektor, w.branche].join(" ").toLowerCase().includes(q)));
  rows.sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    if (x == null) return 1; if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * (state.sort.asc ? 1 : -1);
  });
  const tbl = document.getElementById("tbl");
  tbl.querySelector("thead").innerHTML = "<tr>" + COLS.map((c) =>
    `<th data-k="${c.key}" class="${c.hide ? "hide-m" : ""} ${c.key === col.key ? "sorted" + (state.sort.asc ? " asc" : "") : ""}">${c.label}</th>`).join("") + `<th class="x-col"></th></tr>`;
  const cur = OV.regeln.waehrung_grundbetrag || "EUR";
  tbl.querySelector("tbody").innerHTML = rows.map((w) => {
    const z = daysUntil(w.naechste_zahlen);
    return `<tr data-s="${esc(w.symbol)}">
      <td><div class="name">${esc(w.name)} ${heatBadge(w)} ${w.insider_kaeufe_90t ? `<span class="badge buy" title="Insider-Käufe in den letzten 90 Tagen">Insider</span>` : ""}
          ${w.politiker_90t ? `<span class="badge" title="Politiker-Trades in den letzten 90 Tagen gemeldet">🏛 ${w.politiker_90t}</span>` : ""}
          ${aktiveAlarme(w.symbol).length ? `<span title="Preisalarm aktiv" aria-label="Preisalarm aktiv">🔔</span>` : ""}</div>
          <div class="sym">${esc(w.symbol)} · ${esc(w.kategorie)}</div></td>
      <td>${fmt(w.kurs)} <span class="sym">${esc(w.waehrung || "")}</span></td>
      <td class="${cls(w.tag_pct)}">${fmtPct(w.tag_pct, 2)}</td>
      <td><div class="dd"><span class="${w.rueckgang_ath > 0.05 ? "neg" : ""}">${fmtPct(-w.rueckgang_ath)}</span>
          <span class="ddbar hide-m"><i style="width:${Math.min(100, w.rueckgang_ath * 2)}%"></i></span></div></td>
      <td>${tierBadge(w)}</td>
      <td class="hide-m">${w.zusatzkauf ? fmt(w.zusatzkauf, 0) + " " + cur : "–"}</td>
      <td class="hide-m ${cls(w.abstand_sma200)}">${fmtPct(w.abstand_sma200)}</td>
      <td class="hide-m ${cls(w.perf_1j)}">${fmtPct(w.perf_1j)}</td>
      <td class="hide-m">${fmt(w.kgv_erwartet, 1)}</td>
      <td class="hide-m">${w.ampel ? `<span class="dot ${w.ampel.farbe}" title="${esc((w.ampel.basis === "jahr" ? `Geschäftsjahr ${w.ampel.jahr}: ` : "") + w.ampel.gruende.join(" · "))}"></span>` : "–"}</td>
      <td class="hide-m" title="Grüne Antworten im Kennzahlen-Check">${checkBadge(w)}</td>
      <td class="hide-m" title="Daten-Score, siehe Lexikon">${w.screen && w.screen.score != null ? w.screen.score : "–"}</td>
      <td class="hide-m">${z != null && z >= 0 ? (w.naechste_zahlen_geschaetzt ? "ca. " : "") + date(w.naechste_zahlen) + (z <= 14 ? ` <span class="badge watch">${z} T</span>` : "") : w.typ === "etf" ? "–" : "noch offen"}</td>
      <td class="x-col"><button class="x-btn" data-rm="${esc(w.symbol)}" title="${esc(w.name)} entfernen" aria-label="${esc(w.name)} entfernen">✕</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="${COLS.length + 1}" class="muted">Keine Treffer</td></tr>`;

  tbl.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k;
    state.sort = { key: k, asc: state.sort.key === k ? !state.sort.asc : k === "name" || k === "naechste_zahlen" };
    store.set("sort", state.sort);
    renderRows();
  }));
  tbl.querySelectorAll("tbody tr[data-s]").forEach((tr) =>
    tr.addEventListener("click", () => { location.hash = "#/wert/" + encodeURIComponent(tr.dataset.s); }));
  tbl.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const w = OV.werte.find((x) => x.symbol === b.dataset.rm);
    removeDialog(w.symbol, w.name, renderOverview);
  }));
}

function ideenTeaser() {
  if (!ENT) return "";
  const neu = ENT.werte.filter((x) => !x.in_watchlist && x.bekannt === false && x.score != null).slice(0, 4);
  if (!neu.length) return "";
  return `<h2>Vielleicht noch nicht auf deinem Radar</h2>
    <div class="grid teaser">${neu.map((x) => `<a class="card idee" href="#/entdecken">
      <div class="idee-kopf"><strong>${esc(x.name)}</strong><span class="score" title="Daten-Score">${x.score}</span></div>
      <div class="small muted">${esc(x.kategorie)}</div><div class="small" style="margin-top:6px">${esc(x.kurz || "")}</div></a>`).join("")}</div>
    <p class="muted small">Weniger bekannte Unternehmen mit der höchsten Punktzahl im <a href="#/entdecken">Entdecken-Tab</a>. Keine Kaufempfehlung.</p>`;
}

// ------------------------------------------------------------ Detailseite

const kv = (k, v, c = "") => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`;

async function renderDetail(sym) {
  $app.innerHTML = `<p class="muted">Lade ${esc(sym)} …</p>`;
  let d;
  try { d = await getJSON("data/werte/" + safe(sym) + ".json"); }
  catch { $app.innerHTML = `<a class="back" href="#/">← Übersicht</a><p>Keine Daten für ${esc(sym)}.</p>`; return; }
  const w = d.item, f = d.fundamentaldaten, cur = w.waehrung || "";
  w.zusatzkauf = betragFuer(w);

  const sections = [
    f && ["kennzahlen", "Kennzahlen", "Bewertung & Kennzahlen", valuationSection(w, f, cur)],
    ["kurs", "Kurs", "Kursverlauf & Kaufstufe", priceSection(w, d)],
    f && ["zahlen", "Geschäftszahlen", "Geschäftszahlen", businessSection(f, cur)],
    d.profil && ["firma", "Unternehmen", w.typ === "etf" ? "Was steckt drin?" : "Das Unternehmen verstehen", profileSection(d.profil, w)],
    !d.profil && w.typ !== "etf" && ["firma", "Unternehmen", "Das Unternehmen verstehen", profileSection(null, w)],
    f && ["mgmt", "Management", "Management & CEO", mgmtSection(f, d.profil, cur)],
    w.typ !== "etf" && ["bewegungen", "Insider & Investoren", "Insider, Investoren & Politiker", movesSection(d, w)],
    ["quellen", "Quellen", "Quellen & Links", sourcesSection(w, f, d.profil)],
  ].filter((s) => s && s[3]);

  $app.innerHTML = `
    <a class="back" href="#/">← Übersicht</a>
    <div class="head">
      <div>
        <h1>${esc(w.langname || w.name)}</h1>
        <div class="muted">${esc(w.symbol)} · ${esc(w.kategorie)}${f && f.branche ? " · " + esc(f.branche) : ""}${f && f.land ? " · " + esc(f.land) : ""}</div>
      </div>
      <div class="head-preis">
        <div class="price">${fmt(w.kurs)} <span class="muted small">${esc(cur)}</span></div>
        <div class="${cls(w.tag_pct)}">${fmtPct(w.tag_pct, 2)} heute · Stand ${date(w.datum)}</div>
      </div>
    </div>
    <div class="head-aktionen small"><a href="#/vergleich/${encodeURIComponent(w.symbol)}/">Vergleichen</a> · <button class="linkbtn" id="alarmBtn">Preisalarm setzen</button>${aktiveAlarme(w.symbol).length ? ` · <a href="#/alarme">🔔 ${aktiveAlarme(w.symbol).length} aktiv</a>` : ""}</div>
    ${glance(w, f, d.profil)}
    ${w.heiss ? `<div class="note hotnote">${heatBadge(w)} <strong>${esc(w.name)} liegt ${fmtPct(w.abstand_sma200, 0)} über der ${term("sma200", "200-Tage-Linie")}</strong> (${term("rsi", "RSI")} ${fmt(w.rsi, 0)}).
      Kein Verkaufssignal, aber ein guter Moment, die eigene These und die Positionsgröße zu prüfen. Mehr dazu unter <a href="#/regeln">Regeln</a>.</div>` : ""}
    <nav class="secnav">${sections.map(([id, nav]) => `<button class="chip" data-goto="s-${id}">${nav}</button>`).join("")}</nav>
    ${sections.map(([id, , titel, body]) => `<section id="s-${id}"><h2>${titel}</h2>${body}</section>`).join("")}`;

  $app.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () =>
    document.getElementById(b.dataset.goto).scrollIntoView({ behavior: "smooth" })));
  const desc = document.getElementById("desc");
  if (desc) document.getElementById("more").addEventListener("click", (e) => { desc.classList.toggle("open"); e.target.textContent = desc.classList.contains("open") ? "Weniger" : "Mehr anzeigen"; });
  document.getElementById("alarmBtn").addEventListener("click", () => alarmDialog(w));
  $app.querySelectorAll("[data-firma]").forEach((b) => b.addEventListener("click", () => {
    $app.querySelectorAll("[data-firma]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", String(x === b)); });
    $app.querySelectorAll(".firma-gruppe").forEach((g) => g.classList.toggle("aktiv", g.dataset.gruppe === b.dataset.firma));
  }));
  document.getElementById("rmDetail").addEventListener("click", () => removeDialog(w.symbol, w.name, () => { location.hash = "#/"; }));

  drawPrice(d, gueltigerRange(store.get("range", "1J")));
  $app.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
    store.set("range", b.dataset.r);
    drawPrice(d, b.dataset.r);
  }));
  if (f && f.quartale && f.quartale.length) drawQuarters(f.quartale, cur);
}

// ------------------------------------------------------------ Detail-Bausteine

function glance(w, f, p) {
  const ceo = f && (f.management || []).find((o) => o.ceo);
  const net = f && f.schulden != null && f.cash != null ? f.schulden - f.cash : null;
  const lev = net != null && f.ebitda > 0 ? net / f.ebitda : null;
  const cur = w.waehrung || "";
  const bw = f && f.bilanzwaehrung && f.bilanzwaehrung !== cur ? f.bilanzwaehrung : cur;
  const row = (k, v) => `<div class="g-row"><span class="muted">${k}</span><span>${v}</span></div>`;
  if (!f && !p) return "";
  return `<div class="card glance">
    ${p && p.kurz ? `<p class="g-kurz">${esc(p.kurz)}</p>` : ""}
    ${p && p.was_macht ? `<p class="small" style="margin:0 0 10px">${esc(p.was_macht)}</p>` : ""}
    ${f ? `<div class="g-grid">
      ${ceo ? row("CEO", `${esc(ohneAnrede(ceo.name))}${ceo.alter ? ` <span class="muted small">(${ceo.alter})</span>` : ""}`) : ""}
      ${f.mitarbeiter ? row("Mitarbeiter", fmt(f.mitarbeiter, 0)) : ""}
      ${f.schulden != null ? row(term("schulden", "Schulden"), big(f.schulden) + " " + esc(bw)) : ""}
      ${f.cash != null ? row(term("cash", "Cash"), big(f.cash) + " " + esc(bw)) : ""}
      ${net != null ? row(term("nettoschulden", net > 0 ? "Nettoschulden" : "Nettocash"), `<span class="${net > 0 ? "" : "pos"}">${big(Math.abs(net))} ${esc(bw)}</span>` + (lev != null && net > 0 ? ` <span class="small muted">(${fmt(lev, 1)}× ${term("ebitda", "EBITDA")})</span>` : "")) : ""}
      ${f.insider_anteil != null ? row(term("insider_anteil", "Anteil Insider"), fmt(f.insider_anteil * 100, 1) + " %") : ""}
      ${w.pruefung_anzahl ? row(term("check", "Kennzahlen-Check"), `${checkBadge(w)} grün`) : ""}
      ${row("Status", w.heiss ? heatBadge(w) : w.stufe ? tierBadge(w) : `<span class="muted">normal</span>`)}
    </div>` : ""}</div>`;
}

function fcfRendite(f, cur) {
  const letzte = (f.jahre || []).slice(-1)[0];
  const gleich = !f.bilanzwaehrung || f.bilanzwaehrung === cur;
  return letzte && letzte.fcf != null && f.marktkap && gleich && f.sektor !== "Financial Services" ? letzte.fcf / f.marktkap * 100 : null;
}

function valuationSection(w, f, cur) {
  const zTage = daysUntil(f.naechste_zahlen);
  const fcfR = fcfRendite(f, cur);
  const hinweis = (v) => { const u = kgvUrteil(v); return u ? ` <span class="small muted">${u[1]}</span>` : ""; };
  return `
    ${kgvBox(f)}
    <div class="grid kv">
      ${kv(term("marktkap", "Börsenwert"), big(f.marktkap) + " " + esc(cur))}
      ${kv(term("kgv", "KGV"), fmt(f.kgv, 1) + hinweis(f.kgv))}
      ${kv(term("kgv_erw", "KGV erwartet"), fmt(f.kgv_erwartet, 1) + hinweis(f.kgv_erwartet))}
      ${kv(term("peg", "PEG"), fmt(f.peg, 2))}
      ${kv(term("kuv", "KUV"), fmt(f.kuv, 1))}
      ${kv(term("fcf_rendite", "Free-Cashflow-Rendite"), fcfR == null ? "–" : fmt(fcfR, 1) + " %", cls(fcfR))}
      ${kv(term("jj", "Umsatzwachstum (ggü. Vorjahr)"), fmtRatio(f.umsatzwachstum), cls(f.umsatzwachstum))}
      ${kv(term("gewinnwachstum", "Gewinnwachstum (ggü. Vorjahr)"), fmtRatio(f.gewinnwachstum), cls(f.gewinnwachstum))}
      ${kv(term("bruttomarge", "Bruttomarge"), fmtRatio(f.bruttomarge, 0))}
      ${kv(term("op_marge", "Operative Marge"), fmtRatio(f.operative_marge, 0), cls(f.operative_marge))}
      ${kv(term("ekr", "Eigenkapitalrendite"), fmtRatio(f.eigenkapitalrendite, 0), cls(f.eigenkapitalrendite))}
      ${kv(term("dividende", "Dividendenrendite"), f.dividendenrendite != null ? fmt(f.dividendenrendite, 2) + " %" : "keine")}
      ${kv(term("kursziel", "Analysten-Kursziel"), f.kursziel ? `${fmt(f.kursziel)} <span class="small ${cls(f.kursziel - w.kurs)}">${fmtPct((f.kursziel / w.kurs - 1) * 100, 0)}</span>` : "–")}
      ${kv(term("konsens", "Analysten-Konsens"), `${esc(EMPFEHLUNG[f.analysten_empfehlung] || f.analysten_empfehlung || "–")} <span class="small muted">${f.analysten_anzahl ? f.analysten_anzahl + " Analysten" : ""}</span>`)}
      ${kv(f.berichtsrhythmus ? "Nächste Zahlen" : "Nächste Quartalszahlen", zTage != null && zTage >= 0 ? (f.naechste_zahlen_geschaetzt ? "ca. " : "") + date(f.naechste_zahlen) + ` <span class="small muted">in ${zTage} T.${f.naechste_zahlen_geschaetzt ? ", geschätzt" : ""}</span>` : "noch offen")}
      ${kv(term("eps", "Erwarteter EPS, nächstes Quartal"), f.erwartung_eps ? `${fmt(f.erwartung_eps)} <span class="small muted">${esc(cur)}</span>` : "–")}
    </div>
    <p class="muted small">Tipp: Blaue, unterstrichene Begriffe antippen, dann erscheint eine kurze Erklärung. Alle Begriffe stehen im <a href="#/lexikon">Lexikon</a>.
      ${f.erwartung_umsatz ? `Erwarteter Umsatz im nächsten Quartal: ${big(f.erwartung_umsatz)} ${esc(cur)}.` : ""}</p>`;
}

function priceSection(w, d) {
  const naechste = OV.regeln.stufen.find((s) => s.ab_prozent > w.rueckgang_ath);
  const kursNaechste = naechste ? w.ath * (1 - naechste.ab_prozent / 100) : null;
  return `
    <div class="card">
      <div class="ranges" id="ranges">${RANGES.map(([r]) => {
        const c = rangeChange(d.historie, r);
        return `<button class="chip range" data-r="${r}"><span>${r}</span><small class="${cls(c)}">${c == null ? "–" : fmtPct(c, Math.abs(c) < 100 ? 1 : 0)}</small></button>`;
      }).join("")}</div>
      <div class="chart-box"><canvas id="cPrice"></canvas></div>
      <p class="muted small" style="margin:8px 0 0">Gestrichelt: Allzeithoch und die Kurse, bei denen deine Stufen beginnen, soweit sie im gewählten Zeitraum liegen. Kurse älter als 2 Jahre sind Wochenkurse.</p>
    </div>
    <div class="grid kv" style="margin-top:12px">
      ${kv(term("ath", "Rückgang vom Allzeithoch"), fmtPct(-w.rueckgang_ath), w.rueckgang_ath > 0.05 ? "neg" : "")}
      ${kv(term("ath", "Allzeithoch"), `${fmt(w.ath)} <span class="small muted">${date(w.ath_datum)}</span>`)}
      ${kv(term("stufe", "Kaufstufe"), tierBadge(w) + (w.zusatzkauf ? ` <span class="small">${fmt(w.zusatzkauf, 0)} ${esc(OV.regeln.waehrung_grundbetrag)}</span>` : ""))}
      ${kv(term("stufe", "Nächste Stufe bei"), naechste ? `${fmt(kursNaechste)} <span class="small muted">(−${naechste.ab_prozent} %)</span>` : "höchste erreicht")}
      ${kv(term("w52", "vom 52-Wochen-Hoch"), fmtPct(-w.rueckgang_52w), w.rueckgang_52w > 0.05 ? "neg" : "")}
      ${kv("52-Wochen-Spanne", `${fmt(w.tief52)} – ${fmt(w.hoch52)}`)}
      ${kv(term("sma200", "Abstand 200-Tage-Linie"), fmtPct(w.abstand_sma200), cls(w.abstand_sma200))}
      ${kv(term("rsi", "RSI (14 Tage)"), `${fmt(w.rsi, 0)} <span class="small muted">${w.rsi >= 70 ? "überkauft" : w.rsi <= 30 ? "überverkauft" : "neutral"}</span>`)}
    </div>`;
}

function businessSection(f, cur) {
  const q = f.quartale || [];
  const jahrBasis = f.ampel && f.ampel.basis === "jahr";
  return `
    ${f.ampel ? `<div class="card ampel-box"><span class="dot ${f.ampel.farbe}" style="width:16px;height:16px;margin-top:3px"></span>
      <div><strong>${{ gruen: "Starkes", gelb: "Gemischtes", rot: "Schwaches" }[f.ampel.farbe]} ${jahrBasis ? "Geschäftsjahr" : "Quartal"}</strong>
      <span class="muted small">(${term("ampel", "Ampel")}, ${jahrBasis ? `Geschäftsjahr ${f.ampel.jahr}` : `Quartal bis ${esc(date(q[q.length - 1].periode))}`})</span>
      <ul class="clean small">${f.ampel.gruende.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div></div>` : ""}
    ${f.berichtsrhythmus ? `<p class="muted small">${esc(f.berichtsrhythmus)}.${jahrBasis ? " Yahoo liefert hier keine Zwischenzahlen, deshalb bewertet die Ampel das letzte volle Geschäftsjahr und nicht das letzte Halbjahr." : ""}</p>` : ""}
    ${yearsSection(f, cur)}
    ${q.length ? `
    <h3 class="sub-h">Quartale</h3>
    <div class="grid two">
      <div class="card"><h3>Umsatz & Nettogewinn</h3><div class="chart-box sm"><canvas id="cRev"></canvas></div></div>
      <div class="card"><h3>Margen</h3><div class="chart-box sm"><canvas id="cMarg"></canvas></div></div>
    </div>
    <div class="tbl-wrap" style="margin-top:12px"><table class="plain">
      <thead><tr><th>Quartal bis</th><th>${term("umsatz", "Umsatz")}</th><th>${term("jj", "vs. Vorjahr")}</th><th>${term("qq", "vs. Vorquartal")}</th><th>${term("bruttomarge", "Bruttomarge")}</th><th>${term("op_marge", "Op. Marge")}</th><th>${term("nettogewinn", "Nettogewinn")}</th><th>${term("eps", "EPS")}</th><th>${term("jj", "EPS vs. Vorjahr")}</th><th>${term("fcf", "Free Cashflow")}</th></tr></thead>
      <tbody>${[...q].reverse().map((e) => `<tr>
        <td>${date(e.periode)}</td><td>${big(e.umsatz)}</td>
        <td class="${cls(e.umsatz_yoy)}">${fmtPct(e.umsatz_yoy)}</td><td class="${cls(e.umsatz_qoq)}">${fmtPct(e.umsatz_qoq)}</td>
        <td>${fmtRatio(e.bruttomarge)}</td><td>${fmtRatio(e.operative_marge)}</td>
        <td class="${cls(e.nettogewinn)}">${big(e.nettogewinn)}</td><td>${fmt(e.eps)}</td>
        <td class="${cls(e.eps_yoy)}">${fmtPct(e.eps_yoy)}</td><td class="${cls(e.fcf)}">${big(e.fcf)}</td></tr>`).join("")}</tbody>
    </table></div>
    <p class="muted small">Beträge in ${esc(f.bilanzwaehrung || cur)} laut Yahoo Finance. „vs. Vorjahr“ vergleicht mit demselben Quartal ein Jahr zuvor, „vs. Vorquartal“ mit dem Quartal direkt davor.</p>` : ""}
    ${checkSection(f)}`;
}

const PROFIL_GRUPPEN = [
  ["Das Geschäft", [
    ["geld", "Womit verdient es Geld?"],
    ["warum_kunden", "Warum entscheiden sich Kunden dafür?"],
  ]],
  ["Wettbewerb", [
    ["unterschied", "Was hebt es von der Konkurrenz ab?"],
    ["markt", "Wie groß ist der Markt und wächst er?"],
  ]],
  ["Die Zukunft", [
    ["zukunft", "Warum dürfte es in 10 Jahren noch relevant sein?"],
    ["plaene", "Was hat das Unternehmen als Nächstes vor?"],
  ]],
];

function profileSection(p, w) {
  if (!p) {
    return `<div class="card muted small">Für diesen Wert gibt es noch kein ausführliches Profil.
      Bitte Claude, eins zu ergänzen (Datei <code>config/profiles/</code>). Die Kennzahlen werden trotzdem automatisch ausgewertet.</div>`;
  }
  const gefuellt = PROFIL_GRUPPEN.map(([titel, fragen]) => [titel, fragen.filter(([k]) => p[k]).map(([k, q]) => `<div class="qa"><div class="q">${q}</div><div class="a">${esc(p[k])}</div></div>`).join("")]).filter(([, qa]) => qa);
  const gruppen = gefuellt.map(([titel, qa], i) => `<div class="card firma-gruppe ${i === 0 ? "aktiv" : ""}" data-gruppe="${i}"><h3 class="gruppe">${titel}</h3><div class="qa-liste">${qa}</div></div>`).join("");
  return `<div class="firma-tabs" role="tablist">${gefuellt.map(([titel], i) => `<button type="button" class="chip ${i === 0 ? "on" : ""}" role="tab" aria-selected="${i === 0}" data-firma="${i}">${titel}</button>`).join("")}</div>
    <div class="grid drei">${gruppen}</div>
    <div class="grid two" style="margin-top:12px">
      <div class="card contra"><h3>Gegenargumente & Risiken</h3>
        <ul class="clean small">${(p.risiken || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        ${p.these_falsch_wenn ? `<p class="small" style="margin:10px 0 0"><strong>Die These wäre falsch, wenn …</strong> ${esc(p.these_falsch_wenn)}</p>` : ""}</div>
      <div class="card"><h3>Warum dieses Unternehmen und nicht einfach ein ETF?</h3>
        <p class="small" style="margin:0">${esc(p.warum_nicht_etf || "–")}</p></div>
    </div>
    <p class="muted small">Quelle dieser Texte: von Claude zusammengefasst aus Wissen bis etwa Mitte 2026 (Profil-Stand ${esc(p.stand || "–")}), nicht live recherchiert. Marktgrößen und Pläne können sich geändert haben. Qualitative Einschätzung, keine Anlageberatung. Wichtige Punkte bitte im Geschäftsbericht prüfen, Links dazu stehen unter „Quellen & Links“.</p>`;
}

function checkSection(f) {
  const p = f.pruefung || [];
  if (!p.length) return "";
  return `<h3 class="sub-h">${term("check", "Kennzahlen-Check")}</h3>
    <div class="card"><div class="checks">${p.map((x) => `<div class="check"><span class="dot ${x.farbe}"></span>
      <div><div class="q">${esc(x.frage)}</div><div class="small">${esc(x.antwort)}</div></div></div>`).join("")}</div></div>
    <p class="muted small">Automatisch aus den Jahreszahlen berechnet (Grün = günstig, Gelb = neutral, Rot = genauer hinschauen). Grenzwerte sind Faustregeln, je nach Branche ist anderes normal.</p>`;
}

const ohneAnrede = (s) => String(s || "").replace(/^(Mr|Mrs|Ms|Dr|Prof)\.\s+/i, "");
// Vergleich für Namensabgleich: Akzente und Umschreibungen (ö/oe) spielen keine Rolle
const nameNorm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/([aou])e/g, "$1");
function ceoGenannt(f, text) {
  const live = (f.management || []).filter((o) => o.ceo);
  if (!live.length) return true;
  const t = nameNorm(text);
  return live.some((o) => nameNorm(o.name).split(/[\s.,]+/).some((x) => x.length >= 3 && t.includes(x)));
}

function mgmtSection(f, p, cur) {
  const m = f.management || [];
  if (!m.length && !(p && (p.ceo || p.management))) return "";
  const bw = f.bilanzwaehrung || cur;
  const liveCeo = m.filter((o) => o.ceo).map((o) => ohneAnrede(o.name)).join(" & ");
  const bio = p && p.ceo_bio && ceoGenannt(f, p.ceo_bio.name) ? p.ceo_bio : null;
  const stale = p && p.ceo && !ceoGenannt(f, p.ceo);
  return `
    <div class="card">
      ${bio ? `<h3>CEO: ${esc(bio.name)}</h3><p class="small" style="margin:0 0 10px">${esc(bio.bio)}</p>` : liveCeo ? `<h3>CEO: ${esc(liveCeo)}</h3>` : ""}
      ${p && p.ceo && !stale && !bio ? `<p class="small" style="margin:0 0 10px">${esc(p.ceo)}</p>` : ""}
      ${stale && !bio ? `<p class="small muted" style="margin:0 0 10px">Yahoo Finance nennt inzwischen ${esc(liveCeo)} als CEO. Der Profiltext dazu wird aktualisiert.</p>` : ""}
      ${p && p.management ? `<div class="q">Was hat das Management bisher erreicht, wie setzt es Kapital ein?</div><p class="small" style="margin:3px 0 0">${esc(p.management)}</p>` : ""}
    </div>
    ${m.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="plain"><thead><tr><th>Name</th><th class="wrap-text">Position</th><th>Alter</th><th>Vergütung/Jahr</th></tr></thead><tbody>
    ${m.map((o) => `<tr><td>${esc(ohneAnrede(o.name))} ${o.ceo ? `<span class="badge watch">CEO</span>` : ""}</td><td class="wrap-text">${esc(o.titel)}</td><td>${o.alter || "–"}</td><td>${o.verguetung ? big(o.verguetung) + " " + esc(bw) : "–"}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
    <p class="muted small">Personen, Alter und Vergütung live von Yahoo Finance. Texte zum Werdegang von Claude (Stand etwa Mitte 2026). Der Text erscheint nur, wenn der Name zur aktuellen Yahoo-Angabe passt.</p>`;
}

function yearsSection(f, cur) {
  const j = f.jahre || [];
  if (!j.length) return "";
  const bw = f.bilanzwaehrung || cur;
  const abs = (v) => (v == null ? null : Math.abs(v));
  const betrag = (key, label, opt = {}) => ({ key, label, wert: (e) => big(opt.abs ? abs(e[key]) : e[key]), roh: (e) => (opt.abs ? abs(e[key]) : e[key]), farbe: opt.farbe, inv: opt.inv });
  const marge = (key, label) => ({ key, label, marge: true, wert: (e) => fmtRatio(e[key]), roh: (e) => e[key] });
  const zeilen = [
    betrag("umsatz", term("umsatz", "Umsatz")),
    betrag("nettogewinn", term("nettogewinn", "Nettogewinn"), { farbe: true }),
    { key: "eps", label: term("eps", "EPS (Gewinn je Aktie)"), wert: (e) => fmt(e.eps), roh: (e) => e.eps },
    marge("bruttomarge", term("bruttomarge", "Bruttomarge")),
    marge("operative_marge", term("op_marge", "Operative Marge")),
    marge("nettomarge", term("nettomarge", "Nettomarge")),
    betrag("fcf", term("fcf", "Free Cashflow"), { farbe: true }),
    betrag("capex", term("capex", "CapEx (Investitionen)"), { abs: true, inv: null }),
    betrag("schulden", term("schulden", "Schulden"), { inv: true }),
    betrag("cash", term("cash", "Cash")),
    { key: "aktien", label: term("verwaesserung", "Aktien (Mio.)"), wert: (e) => fmt(e.aktien == null ? null : e.aktien / 1e6, 0), roh: (e) => e.aktien, inv: true },
    betrag("rueckkaeufe", term("rueckkaeufe", "Rückkäufe"), { abs: true, inv: null }),
  ].filter((z) => j.some((e) => z.roh(e) != null));
  const delta = (z, e, vor) => {
    if (!vor) return "";
    const a = z.roh(e), b = z.roh(vor);
    if (a == null || b == null) return "";
    if (z.marge) { const d = (a - b) * 100; return `<div class="delta ${cls(d)}">${d > 0 ? "+" : ""}${fmt(d, 1)} Pp.</div>`; }
    if (b <= 0) return "";
    const d = (a / b - 1) * 100;
    if (Math.abs(d) >= 1000) return "";
    const farbe = z.inv === null ? "" : cls(z.inv ? -d : d);
    return `<div class="delta ${farbe}">${fmtPct(d, 0)}</div>`;
  };
  return `<h3 class="sub-h">Jahreszahlen</h3>
    <div class="tbl-wrap"><table class="plain years"><thead><tr><th>Geschäftsjahr</th>${j.map((e) => `<th>${e.jahr}</th>`).join("")}</tr></thead>
    <tbody>${zeilen.map((z) => `<tr><td>${z.label}</td>${j.map((e, i) => `<td><span class="${z.farbe ? cls(z.roh(e)) : ""}">${z.wert(e)}</span>${delta(z, e, j[i - 1])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="muted small">Beträge in ${esc(bw)}. Darunter klein die Veränderung zum Vorjahr, bei Margen in ${term("pp", "Prozentpunkten")}. Yahoo liefert kostenlos die letzten ~4 Geschäftsjahre. Für 10 Jahre: Geschäftsberichte auf der Investor-Relations-Seite.</p>`;
}

const POS_DE = {
  "Officer": "Führungskraft", "Director": "Board-Mitglied (Aufsicht)", "Chief Executive Officer": "CEO (Unternehmenschef)", "Chief Financial Officer": "CFO (Finanzchef)",
  "Chief Operating Officer": "COO (operativer Chef)", "Chief Technology Officer": "CTO (Technikchef)", "General Counsel": "Chefjurist/in", "President": "President (Präsident/in)",
  "Beneficial Owner of more than 10% of a Class of Security": "Großaktionär (über 10 %)", "Officer and Director": "Führungskraft und Board-Mitglied", "Chairman of the Board": "Vorsitz im Board",
};
const posDe = (p) => POS_DE[p] || p || "–";

function insiderArt(x) {
  if (x.art === "kauf") return { label: "Kauf", cls: "buy", term: "ins_kauf" };
  if (x.art === "verkauf") return { label: "Verkauf", cls: "sell", term: "ins_verkauf" };
  const t = x.text || "";
  if (/award|grant/i.test(t)) return { label: "Zuteilung", cls: "", term: "ins_zuteilung" };
  if (/gift/i.test(t)) return { label: "Schenkung", cls: "", term: "ins_geschenk" };
  if (/exercise|conversion/i.test(t)) return { label: "Optionsausübung", cls: "", term: "ins_option" };
  return { label: "Ohne Angabe", cls: "", term: "ins_ohne" };
}

function insiderSection(d) {
  const list = d.insider || [];
  if (!list.length) return "";
  const bestand = new Map((d.insider_bestand || []).map((b) => [b.person.toLowerCase().split(" ").slice(0, 2).join(" "), b]));
  const hat = (x) => bestand.get(String(x.person).toLowerCase().split(" ").slice(0, 2).join(" "));
  const seit = new Date(Date.now() - 182 * 864e5).toISOString().slice(0, 10);
  const neu = list.filter((x) => x.datum >= seit);
  const summe = (a) => neu.filter((x) => x.art === a).reduce((s, x) => s + (x.wert || 0), 0);
  const n = (a) => neu.filter((x) => x.art === a).length;
  const andere = neu.length - n("kauf") - n("verkauf");
  const zeigeBestand = list.some(hat);
  const arten = [...new Set(list.map((x) => insiderArt(x).term))];
  return `<h3 class="sub-h">${term("insider", "Insider-Transaktionen")}</h3>
    <div class="card small" style="margin-bottom:12px"><strong>Letzte 6 Monate:</strong>
      <span class="pos">${n("kauf")} Käufe${summe("kauf") ? ` (${big(summe("kauf"))} $)` : ""}</span> ·
      <span class="neg">${n("verkauf")} Verkäufe${summe("verkauf") ? ` (${big(summe("verkauf"))} $)` : ""}</span> ·
      ${andere} Vorgänge ohne Handel am Markt.
      ${n("kauf") === 0 && n("verkauf") > 0 ? `<span class="muted">Niemand hat zugekauft. Das ist bei großen Konzernen üblich und für sich allein kein Warnsignal.</span>` : ""}</div>
    <div class="tbl-wrap"><table class="plain">
      <thead><tr><th>Datum</th><th>Person</th><th>Position</th><th>Art</th><th>Aktien</th><th>Wert ($)</th>${zeigeBestand ? `<th>Hält noch (Aktien)</th>` : ""}</tr></thead>
      <tbody>${list.map((x) => { const a = insiderArt(x), b = hat(x); return `<tr>
        <td>${date(x.datum)}</td><td>${esc(x.person)}</td><td class="trunc" title="${esc(x.position)}">${esc(posDe(x.position))}</td>
        <td><button type="button" class="term badge ${a.cls}" data-term="${a.term}" title="${esc(x.text)}">${a.label}</button></td>
        <td>${fmt(x.aktien, 0)}</td><td>${big(x.wert)}</td>${zeigeBestand ? `<td title="${b && b.datum ? "Stand " + date(b.datum) : ""}">${b && b.aktien != null ? fmt(b.aktien, 0) : "–"}</td>` : ""}</tr>`; }).join("")}</tbody>
    </table></div>
    <div class="legende small">${arten.map((id) => { const e = LEX_INDEX[id]; return `<div><strong>${esc(e.name.replace("Insider: ", ""))}:</strong> ${esc(e.kurz)}</div>`; }).join("")}</div>
    ${zeigeBestand ? `<p class="muted small">„Hält noch“ = direkt gehaltene Aktien laut letzter Meldung. Bestände über Familie oder Stiftungen sind oft nicht enthalten.</p>` : ""}
    <p class="muted small">Käufe aus eigener Tasche gelten als aussagekräftiger als Verkäufe, denn verkauft wird oft aus steuerlichen oder privaten Gründen oder nach festem Plan.
      Mehrere Insider, die kurz nacheinander kaufen („Cluster“), sind das stärkste Signal.</p>`;
}

function movesSection(d, w) {
  const halter = holdersOf(w);
  const teile = [
    halter.length ? `<h3 class="sub-h">Gehalten von großen Investoren (${term("f13", "13F")})</h3>
    <div class="tbl-wrap"><table class="plain"><thead><tr><th>Investor</th><th>Wert</th><th>Anteil Depot</th><th>Veränderung</th><th>${term("stichtag", "Stichtag")}</th></tr></thead>
    <tbody>${halter.map(({ inv, p }) => `<tr><td class="wrap-text"><strong>${esc(inv.name)}</strong> <span class="sym">${esc(inv.person || "")}</span>${inv.kurz ? `<div class="sym">${esc(inv.kurz)}</div>` : ""}</td>
      <td>${big(p.wert)} $</td><td>${fmt(p.anteil, 1)} %</td><td>${changeBadge(p)}</td><td>${date(inv.stichtag)}</td></tr>`).join("")}</tbody></table></div>
    <p class="muted small">„Veränderung“ vergleicht den Stichtag mit dem Vorquartal. Der Investor kann seitdem bereits gehandelt haben. Mehr über die Personen im Tab <a href="#/investoren">Investoren</a>.</p>` : "",
    insiderSection(d),
    d.politiker && d.politiker.length ? `<h3 class="sub-h">${term("politiker", "Politiker-Trades (US-Kongress)")}</h3>${politikTable(d.politiker, false)}` : "",
  ].filter(Boolean);
  return teile.join("");
}

function sourcesSection(w, f, p) {
  const usTicker = !w.symbol.includes(".");
  return `<div class="card small"><ul class="clean quellen">
      <li><strong>Kurse, Kennzahlen, Bilanzen, Management, Analysten:</strong> Yahoo Finance, automatisch mehrmals täglich. Für Yahoo gilt keine Garantie auf Richtigkeit, vor allem bei Werten außerhalb der USA.</li>
      ${usTicker && w.typ !== "etf" ? `<li><strong>Insider:</strong> SEC-Formular 4, über Yahoo Finance. <strong>Investoren:</strong> 13F-Meldungen direkt von SEC EDGAR. <strong>Politiker:</strong> STOCK-Act-Meldungen über die freie Bargo-API.</li>` : ""}
      ${p ? `<li><strong>Texte zu Geschäft, Risiken und Management:</strong> von Claude zusammengefasst aus Wissen bis etwa Mitte 2026 (Stand ${esc(p.stand || "–")}), nicht aus einem einzelnen Dokument und nicht live geprüft.</li>` : ""}
      <li><strong>Ampel, Check, Stufen, Daten-Score:</strong> feste Regeln dieses Tools, berechnet aus den Zahlen oben.</li>
    </ul></div>
    ${f && f.beschreibung ? `<div class="card" style="margin-top:12px"><h3>Offizielle Kurzbeschreibung <span class="muted small">(Yahoo, englisch)</span></h3><div class="desc small" id="desc">${esc(f.beschreibung)}</div>
      <button class="chip" id="more" style="margin-top:8px">Mehr anzeigen</button></div>` : ""}
    <div class="card links" style="margin-top:12px">
    <a href="https://finance.yahoo.com/quote/${encodeURIComponent(w.symbol)}" target="_blank" rel="noopener">Yahoo Finance</a>
    ${f && f.website ? `<a href="${esc(f.website)}" target="_blank" rel="noopener">Website des Unternehmens</a>` : ""}
    ${w.typ !== "etf" ? `<a href="https://www.google.com/search?q=${encodeURIComponent((w.langname || w.name) + " investor relations quarterly results")}" target="_blank" rel="noopener">Investor Relations</a>` : ""}
    ${usTicker && w.typ !== "etf" ? `<a href="http://openinsider.com/search?q=${encodeURIComponent(w.symbol)}" target="_blank" rel="noopener">OpenInsider</a>
      <a href="https://www.capitoltrades.com/issuers?search=${encodeURIComponent(w.symbol)}" target="_blank" rel="noopener">Politiker-Trades (Capitol Trades)</a>
      <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(w.name)}&type=10-Q" target="_blank" rel="noopener">SEC-Filings</a>` : ""}
    ${w.typ === "etf" ? `<a href="https://www.justetf.com/de/search.html?query=${encodeURIComponent(w.langname || w.name)}" target="_blank" rel="noopener">justETF</a>` : ""}
    </div>
    <p class="small" style="margin-top:20px"><button class="linkbtn neg" id="rmDetail">${esc(w.name)} entfernen …</button></p>`;
}

function politikTable(list, withName) {
  return `<div class="tbl-wrap"><table class="plain"><thead><tr><th>Gemeldet</th>${withName ? "<th>Wert</th>" : ""}<th>Politiker</th><th>Art</th><th>Betrag ($)</th><th>Handelstag</th></tr></thead><tbody>
    ${list.map((x) => `<tr><td>${date(x.gemeldet)}</td>
      ${withName ? `<td><a href="#/wert/${encodeURIComponent(x.symbol)}">${esc(x.name || x.symbol)}</a></td>` : ""}
      <td>${esc(x.person)} <span class="sym">${esc((x.kammer || "").replace("house", "Repräsentantenhaus").replace("senate", "Senat"))} ${esc(x.staat || "")}</span></td>
      <td><span class="badge ${x.art === "kauf" ? "buy" : x.art === "verkauf" ? "sell" : ""}">${x.art === "kauf" ? "Kauf" : x.art === "verkauf" ? "Verkauf" : esc(x.art || "–")}</span></td>
      <td>${esc(x.betrag || "–")}</td><td>${date(x.datum)}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted small">Quelle: STOCK-Act-Meldungen (House Clerk / Senate eFD) über die freie Bargo-API. Meldung bis zu 45 Tage nach dem Handel, Beträge nur als Spanne.
      Auffälliges Timing ist kein Beweis für Insiderwissen und kein Kaufsignal.</p>`;
}

function chartDefaults() {
  Chart.defaults.color = css("--muted");
  Chart.defaults.borderColor = css("--line");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
}

const RANGES = [["1W", 7], ["1M", 30], ["6M", 182], ["1J", 365], ["Max", 1e6]];
const gueltigerRange = (r) => (RANGES.some(([x]) => x === r) ? r : "1J");

function rangePoints(hist, range) {
  if (!hist.length) return [];
  const days = RANGES.find(([r]) => r === range)[1];
  const last = new Date(hist[hist.length - 1][0]);
  // Letzter Kurs vor dem Zeitraum als Ausgangspunkt, damit z. B. 1W wirklich eine Woche umfasst
  const cut = new Date(last.getTime() - days * 864e5).toISOString().slice(0, 10);
  let i = hist.findIndex((p) => p[0] >= cut);
  if (i < 0) return [];
  if (i > 0 && hist[i][0] > cut) i -= 1;
  return hist.slice(i);
}
function rangeChange(hist, range) {
  const pts = rangePoints(hist, range);
  return pts.length > 1 ? (pts[pts.length - 1][1] / pts[0][1] - 1) * 100 : null;
}

let priceChart = null;
function drawPrice(d, range) {
  if (priceChart) { priceChart.destroy(); charts = charts.filter((c) => c !== priceChart); }
  $app.querySelectorAll("[data-r]").forEach((b) => b.classList.toggle("on", b.dataset.r === range));
  const pts = rangePoints(d.historie, range);
  const kurz = ["1W", "1M", "6M"].includes(range);
  const w = d.item;
  const line = (y, label, color) => ({ label, data: pts.map(() => y), borderColor: color, borderWidth: 1, borderDash: [5, 4], pointRadius: 0, fill: false });
  const accent = css("--accent");
  const minP = Math.min(...pts.map((p) => p[1])), maxP = Math.max(...pts.map((p) => p[1]));
  // Kurze Zeiträume: Linien weit außerhalb würden die Kursbewegung platt drücken
  const passt = (y) => (kurz ? y >= minP * 0.95 && y <= maxP * 1.05 : y >= minP * 0.9);
  const ds = [{
    label: "Kurs", data: pts.map((p) => p[1]), borderColor: accent, borderWidth: 1.8, pointRadius: range === "1W" ? 2.5 : 0, pointBackgroundColor: accent, tension: 0.1,
    fill: true, backgroundColor: accent + "14",
  }];
  if (!kurz || passt(w.ath)) ds.push(line(w.ath, "Allzeithoch", css("--muted")));
  const colors = ["--t1-text", "--t2-text", "--t3-text", "--t4-text", "--t5-text"];
  OV.regeln.stufen.forEach((s, i) => {
    const y = w.ath * (1 - s.ab_prozent / 100);
    if (passt(y)) ds.push(line(y, `${s.name} (−${s.ab_prozent} %)`, css(colors[Math.min(i, 4)])));
  });
  const span = maxP - minP;
  const dez = span < 5 ? 2 : span < 50 ? 1 : 0;
  chartDefaults();
  priceChart = new Chart(document.getElementById("cPrice"), {
    type: "line",
    data: { labels: pts.map((p) => p[0]), datasets: ds },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (it) => date(it[0].label), label: (it) => `${it.dataset.label}: ${fmt(it.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 7, callback(v) { const l = this.getLabelForValue(v); return kurz ? l.slice(8, 10) + "." + l.slice(5, 7) + "." : range === "1J" ? l.slice(5, 7) + "/" + l.slice(2, 4) : l.slice(0, 4); } }, grid: { display: false } },
        y: { ticks: { callback: (v) => fmt(v, dez) } },
      },
    },
  });
  charts.push(priceChart);
}

function drawQuarters(q, cur) {
  chartDefaults();
  const labels = q.map((e) => { const d = new Date(e.periode); return "Q" + (Math.floor(d.getMonth() / 3) + 1) + " " + String(d.getFullYear()).slice(2); });
  const scale = Math.max(...q.map((e) => Math.abs(e.umsatz || 0))) >= 1e9 ? 1e9 : 1e6;
  const unit = scale === 1e9 ? "Mrd." : "Mio.";
  charts.push(new Chart(document.getElementById("cRev"), {
    type: "bar",
    data: { labels, datasets: [
      { label: `Umsatz (${unit} ${cur})`, data: q.map((e) => e.umsatz / scale), backgroundColor: css("--accent") },
      { label: `Nettogewinn (${unit} ${cur})`, data: q.map((e) => e.nettogewinn / scale), backgroundColor: css("--bar") },
    ] },
    options: { maintainAspectRatio: false, animation: false, plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } },
      tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${fmt(it.parsed.y, 2)}` } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: (v) => fmt(v, 0) } } } },
  }));
  const pc = (k) => q.map((e) => (e[k] == null ? null : e[k] * 100));
  charts.push(new Chart(document.getElementById("cMarg"), {
    type: "line",
    data: { labels, datasets: [
      { label: "Bruttomarge", data: pc("bruttomarge"), borderColor: css("--accent"), backgroundColor: css("--accent"), tension: 0.2 },
      { label: "Op. Marge", data: pc("operative_marge"), borderColor: css("--bar"), backgroundColor: css("--bar"), tension: 0.2 },
      { label: "Nettomarge", data: pc("nettomarge"), borderColor: css("--green"), backgroundColor: css("--green"), tension: 0.2 },
    ] },
    options: { maintainAspectRatio: false, animation: false, plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } },
      tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${fmt(it.parsed.y, 1)} %` } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: (v) => v + " %" } } } },
  }));
}

// ------------------------------------------------------------ Investoren (13F)

// Grober Abgleich Watchlist <-> Emittentenname im 13F (dort stehen keine Ticker)
const ALIAS = { TSM: "TAIWAN SEMICONDUCTOR", GOOGL: "ALPHABET", META: "META PLATFORMS", V: "VISA INC", JPM: "JPMORGAN", NEE: "NEXTERA", AVGO: "BROADCOM", CRM: "SALESFORCE", NOW: "SERVICENOW", "ASML.AS": "ASML", "NOVO-B.CO": "NOVO-NORDISK",
  GEV: "GE VERNOVA", LRCX: "LAM RESEARCH", SPCX: "SPACE EXPLORATION", MA: "MASTERCARD", "6861.T": "KEYENCE", "000660.KS": "SK HYNIX",
  LLY: "ELI LILLY", JNJ: "JOHNSON & JOHNSON", KO: "COCA COLA CO ", UNP: "UNION PAC", GE: "GE AEROSPACE", RTX: "RTX", LMT: "LOCKHEED", AXP: "AMERICAN EXPRESS", TMUS: "T-MOBILE", DIS: "DISNEY", PG: "PROCTER", WMT: "WALMART", AMT: "AMERICAN TOWER" };
function issuerKey(w) { return (ALIAS[w.symbol] || w.name.split(" ")[0]).toUpperCase(); }
function matchWatch(name) {
  const n = (name || "").toUpperCase();
  return OV.werte.find((w) => w.typ !== "etf" && (n + " ").startsWith(issuerKey(w)));
}
function holdersOf(w) {
  if (!INV || w.typ === "etf") return [];
  const key = issuerKey(w), out = [];
  INV.investoren.forEach((inv) => inv.positionen.forEach((p) => {
    if (((p.name || "").toUpperCase() + " ").startsWith(key) && (p.wert > 0 || p.aenderung === "verkauft")) out.push({ inv, p });
  }));
  return out.sort((a, b) => b.p.wert - a.p.wert);
}
function changeBadge(p) {
  if (p.aenderung === "neu") return `<span class="badge buy">Neu</span>`;
  if (p.aenderung === "verkauft") return `<span class="badge sell">Verkauft</span>`;
  if (p.aenderung === "aufgestockt") return `<span class="badge buy">+${fmt(p.delta_stueck_pct, 0)} %</span>`;
  if (p.aenderung === "reduziert") return `<span class="badge sell">${fmt(p.delta_stueck_pct, 0)} %</span>`;
  return `<span class="badge">=</span>`;
}

// Unternehmen, die mehrere der beobachteten Investoren gleichzeitig halten
function multiHolders() {
  const map = new Map();
  INV.investoren.forEach((inv) => inv.positionen.filter((p) => p.wert > 0 && p.anteil >= 0.5).forEach((p) => {
    const key = (p.name || "").toUpperCase().replace(/\b(INC|CORP|CORPORATION|CO|LTD|PLC|HLDGS?|HOLDINGS?|COM|CL [A-C]|NEW)\b\.?/g, "").replace(/\s+/g, " ").trim();
    if (!map.has(key)) map.set(key, { name: p.name, inv: [] });
    if (!map.get(key).inv.includes(inv.name)) map.get(key).inv.push(inv.name);
  }));
  const rows = [...map.values()].filter((x) => x.inv.length >= 2).sort((a, b) => b.inv.length - a.inv.length).slice(0, 20);
  if (!rows.length) return "";
  return `<h2>Von mehreren Investoren gehalten</h2>
    <p class="muted small prose">Positionen mit mindestens 0,5 % Depotanteil, die mindestens zwei der beobachteten Investoren unabhängig voneinander halten.</p>
    <div class="tbl-wrap"><table><thead><tr><th>Unternehmen</th><th>Anzahl</th><th>Investoren</th></tr></thead><tbody>
    ${rows.map((x) => { const m = matchWatch(x.name); return `<tr style="cursor:default"><td>${m ? `<a href="#/wert/${encodeURIComponent(m.symbol)}">${esc(x.name)}</a> <span class="badge watch">Watchlist</span>` : esc(x.name)}</td>
      <td>${x.inv.length}</td><td style="white-space:normal">${esc(x.inv.join(", "))}</td></tr>`; }).join("")}
    </tbody></table></div>`;
}

function renderInvestors() {
  if (!INV || (!INV.investoren.length && !(INV.politiker || []).length)) { $app.innerHTML = `<p>Noch keine Investoren-Daten – der nächste Lauf lädt sie.</p>`; return; }
  const filt = store.get("invFilt", "aenderungen");
  const blocks = INV.investoren.map((inv) => {
    const alt = inv.stichtag < new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
    let pos = inv.positionen;
    if (filt === "aenderungen") pos = pos.filter((p) => p.aenderung !== "unveraendert");
    if (filt === "watchlist") pos = pos.filter((p) => matchWatch(p.name));
    const top = pos.slice(0, filt === "top" ? 15 : 25);
    const cnt = (a) => inv.positionen.filter((p) => p.aenderung === a).length;
    return `<div class="card">
      <h3>${esc(inv.name)}</h3>
      ${inv.beschreibung ? `<p class="small" style="margin:4px 0 8px">${esc(inv.beschreibung)}</p>` : ""}
      <div class="muted small">${esc(inv.person || "")} · ${term("stichtag", "Stichtag")} ${date(inv.stichtag)} · gemeldet ${date(inv.filing_datum)}
        ${alt ? ` · <span class="neg">veraltet, keine neueren 13F</span>` : ""}</div>
      <div class="small" style="margin:8px 0">Depot: <strong>${big(inv.gesamtwert)} $</strong> in ${inv.positionen.filter((p) => p.wert > 0).length} Positionen ·
        <span class="pos">${cnt("neu")} neu</span>, <span class="pos">${cnt("aufgestockt")} aufgestockt</span>,
        <span class="neg">${cnt("reduziert")} reduziert</span>, <span class="neg">${cnt("verkauft")} verkauft</span></div>
      ${top.length ? `<div class="tbl-wrap"><table><thead><tr><th>Position</th><th>Wert</th><th>Anteil</th><th>Änderung</th></tr></thead><tbody>
        ${top.map((p) => { const m = matchWatch(p.name); return `<tr><td class="trunc" title="${esc(p.name)} ${esc(p.klasse || "")}">${m ? `<a href="#/wert/${encodeURIComponent(m.symbol)}">${esc(p.name)}</a> <span class="badge watch">Watchlist</span>` : esc(p.name)}</td>
          <td>${big(p.wert)}</td><td>${p.wert ? fmt(p.anteil, 1) + " %" : "–"}</td><td>${changeBadge(p)}</td></tr>`; }).join("")}
      </tbody></table></div>` : `<p class="muted small">Keine Einträge für diesen Filter.</p>`}
      <p class="small" style="margin:8px 0 0"><a href="${esc(inv.link)}" target="_blank" rel="noopener">Alle Filings bei der SEC →</a></p>
    </div>`;
  }).join("");

  $app.innerHTML = `
    <h1>Große Investoren</h1>
    <p class="muted prose">Fonds mit über 100 Mio. $ müssen ihre US-Aktienpositionen quartalsweise per ${term("f13", "13F")} an die SEC melden, und zwar bis zu 45 Tage nach Quartalsende.
      Die Daten sind also verzögert und zeigen nur US-Aktien (keine Leerverkäufe). Verglichen wird jeweils mit dem Vorquartal.</p>
    <div class="toolbar">
      ${[["aenderungen", "Nur Änderungen"], ["watchlist", "Meine Watchlist"], ["top", "Größte Positionen"]]
        .map(([k, l]) => `<button class="chip ${k === filt ? "on" : ""}" data-f="${k}">${l}</button>`).join("")}
    </div>
    <div class="grid inv-grid">${blocks}</div>
    ${multiHolders()}
    <h2>Politiker-Trades in deiner Watchlist (letzte 90 Tage)</h2>
    <p class="muted small prose">US-Kongressmitglieder (inkl. Ehepartner) müssen Aktiengeschäfte über 1.000 $ nach dem STOCK Act melden.
      Spannend als Ideenquelle, aber laut den Notizen deines Freundes: Hintergründe verstehen, nicht blind folgen.</p>
    ${INV.politiker && INV.politiker.length ? politikTable(INV.politiker.slice(0, 60), true) : `<p class="muted">Keine gemeldeten Trades in den letzten 90 Tagen.</p>`}`;
  $app.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { store.set("invFilt", b.dataset.f); renderInvestors(); }));
}

// ------------------------------------------------------------ Entdecken

const entState = { lens: store.get("entLens", "alle"), kat: "Alle", thema: "Alle", nurNeu: store.get("entNeu", true), q: "", n: 24 };
const m = (x, k) => (x.m ? x.m[k] : null);
const LENSES = [
  { id: "alle", label: "Höchster Score", info: "Alle Werte, sortiert nach Daten-Score.", test: () => true },
  { id: "qualitaet", label: "Wachstum & Qualität", info: "Umsatz wächst mindestens 10 %, operative Marge mindestens 15 %.", test: (x) => m(x, "umsatzwachstum") >= 10 && m(x, "op_marge") >= 15 },
  { id: "ruecksetzer", label: "Gute Zahlen, gefallener Kurs", info: "Mindestens 20 % unter dem Allzeithoch, aber Umsatz wächst mindestens 5 % und das Geschäft ist profitabel. Der Kurs kann trotzdem einen guten Grund haben.", test: (x) => x.rueckgang_ath >= 20 && m(x, "umsatzwachstum") >= 5 && m(x, "op_marge") > 0 },
  { id: "guenstig", label: "Günstig bewertet", info: "Erwartetes KGV bis 20 oder PEG bis 1,2, dazu Umsatz nicht schrumpfend.", test: (x) => m(x, "umsatzwachstum") >= 0 && ((m(x, "kgv_erwartet") > 0 && m(x, "kgv_erwartet") <= 20) || (m(x, "peg") > 0 && m(x, "peg") <= 1.2)) },
  { id: "trend", label: "Läuft aktuell gut", info: "Über 200-Tage-Linie und mindestens 15 % Plus in 6 Monaten, nicht sehr heiß gelaufen.", test: (x) => x.abstand_sma200 > 0 && x.perf_6m >= 15 && x.heiss !== 2 },
  { id: "dividende", label: "Dividende", info: "Dividendenrendite mindestens 2,5 %, profitables Geschäft.", test: (x) => m(x, "dividende") >= 2.5 && m(x, "op_marge") > 0 },
  { id: "unbekannt", label: "Weniger bekannt", info: "Unternehmen, die viele Privatanleger kaum kennen.", test: (x) => x.bekannt === false },
];
const BAUSTEINE = [["wachstum", "Wachstum"], ["profit", "Marge"], ["bewertung", "Bewertung"], ["trend", "Trend"], ["bilanz", "Bilanz"]];

function ideaCard(x) {
  const addUrl = issueUrl(`Watchlist: hinzufügen ${x.symbol}`, ["aktion: hinzufuegen", `symbol: ${x.symbol}`, `name: ${x.name}`, `kategorie: ${x.kategorie}`, "typ: aktie"]);
  const b = x.bausteine || {};
  return `<article class="card idee-card">
    <div class="idee-kopf">
      <div><h3>${x.in_watchlist ? `<a href="#/wert/${encodeURIComponent(x.symbol)}">${esc(x.name)}</a>` : esc(x.name)}
        ${x.in_watchlist ? `<span class="badge watch">Watchlist</span>` : x.bekannt === false ? `<span class="badge">wenig bekannt</span>` : ""}</h3>
        <div class="sym">${esc(x.symbol)} · ${esc(x.kategorie)}${x.thema ? " · " + esc(x.thema) : ""}</div></div>
      <div class="score" title="Daten-Score von 100">${x.score == null ? "–" : x.score}</div>
    </div>
    ${x.kurz ? `<p class="small" style="margin:8px 0">${esc(x.kurz)}</p>` : ""}
    <div class="mini-bars">${BAUSTEINE.map(([k, l]) => `<div class="mini"><span>${l}</span><i class="meter"><b style="width:${b[k] == null ? 0 : b[k] * 5}%"></b></i></div>`).join("")}</div>
    <div class="fakten small">
      <span>Umsatz <b class="${cls(m(x, "umsatzwachstum"))}">${fmtPct(m(x, "umsatzwachstum"), 0)}</b></span>
      <span>Op. Marge <b>${m(x, "op_marge") == null ? "–" : fmt(m(x, "op_marge"), 0) + " %"}</b></span>
      <span>KGV erw. <b>${fmt(m(x, "kgv_erwartet"), 1)}</b></span>
      <span>vom ATH <b class="neg">${fmtPct(-x.rueckgang_ath, 0)}</b></span>
      <span>6 Mon. <b class="${cls(x.perf_6m)}">${fmtPct(x.perf_6m, 0)}</b></span>
      <span>Analysten <b>${esc(EMPFEHLUNG[x.analysten] || "–")}</b></span>
    </div>
    ${(x.plus || []).length ? `<ul class="plus small">${x.plus.slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    ${(x.minus || []).length ? `<ul class="minus small">${x.minus.slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    ${x.these ? `<p class="small" style="margin:8px 0 0"><strong>Mögliche These:</strong> ${esc(x.these)}</p>` : ""}
    ${x.risiko ? `<p class="small" style="margin:4px 0 0"><strong>Was dagegen spricht:</strong> ${esc(x.risiko)}</p>` : ""}
    <div class="idee-links">
      ${x.in_watchlist ? `<a class="chip" href="#/wert/${encodeURIComponent(x.symbol)}">Analyse öffnen</a>` : `<a class="chip on" href="${addUrl}" target="_blank" rel="noopener">＋ Zur Watchlist</a>`}
      <a class="chip" href="https://finance.yahoo.com/quote/${encodeURIComponent(x.symbol)}" target="_blank" rel="noopener">Yahoo Finance</a>
    </div>
  </article>`;
}

function renderEntdeckenListe() {
  const s = entState, lens = LENSES.find((l) => l.id === s.lens) || LENSES[0];
  const q = s.q.trim().toLowerCase();
  const rows = ENT.werte.filter((x) => lens.test(x) && (!s.nurNeu || !x.in_watchlist) && (s.kat === "Alle" || x.kategorie === s.kat) && (s.thema === "Alle" || x.thema === s.thema) &&
    (!q || [x.name, x.symbol, x.kategorie, x.thema, x.sektor, x.branche, x.kurz].join(" ").toLowerCase().includes(q)));
  document.getElementById("entInfo").textContent = `${lens.info} ${rows.length} Treffer.`;
  const box = document.getElementById("entListe");
  box.innerHTML = rows.slice(0, s.n).map(ideaCard).join("") || `<p class="muted">Keine Treffer. Lockere die Filter oder zeige auch Watchlist-Werte.</p>`;
  const mehr = document.getElementById("entMehr");
  mehr.hidden = rows.length <= s.n;
}

function renderEntdecken() {
  if (!ENT || !ENT.werte.length) { $app.innerHTML = `<p>Noch keine Daten, der nächste automatische Lauf lädt sie.</p>`; return; }
  const kats = [...new Set(ENT.werte.map((x) => x.kategorie))].sort();
  const themen = [...new Set(ENT.werte.map((x) => x.thema).filter(Boolean))].sort();
  const opt = (a, sel) => ["Alle", ...a].map((k) => `<option ${k === sel ? "selected" : ""}>${esc(k)}</option>`).join("");
  $app.innerHTML = `
    <h1>Entdecken</h1>
    <p class="muted prose">Ideen für die weitere Recherche, nach festen Regeln aus aktuellen Zahlen gefiltert. Jeder Wert bekommt einen ${term("score", "Daten-Score")} aus Wachstum, Marge, Bewertung, Kurstrend und Bilanz. Dazu stehen immer auch die Gegenargumente.</p>
    <div class="note small"><strong>Das sind keine Kaufempfehlungen.</strong> Claude ist kein zugelassener Anlageberater und kennt deine finanzielle Situation nicht. Der Score zeigt, wie die Zahlen heute aussehen, nicht wie die Aktie künftig läuft. Die Thesen sind Vermutungen, die falsch sein können.</div>
    <div class="toolbar">${LENSES.map((l) => `<button class="chip ${l.id === entState.lens ? "on" : ""}" data-lens="${l.id}">${l.label}</button>`).join("")}</div>
    <div class="toolbar">
      <input type="search" id="entQ" placeholder="Suchen: Name, Branche, Thema …" value="${esc(entState.q)}">
      <label class="feld">Branche <select id="entKat">${opt(kats, entState.kat)}</select></label>
      <label class="feld">Zukunftsthema <select id="entThema">${opt(themen, entState.thema)}</select></label>
      <label class="feld"><input type="checkbox" id="entNeu" ${entState.nurNeu ? "checked" : ""}> nur außerhalb meiner Watchlist</label>
    </div>
    <p class="muted small" id="entInfo"></p>
    <div class="grid idee-grid" id="entListe"></div>
    <p style="text-align:center;margin-top:14px"><button class="chip" id="entMehr" hidden>Mehr anzeigen</button></p>
    <p class="muted small">Ein Klick auf „Zur Watchlist“ öffnet GitHub, dort nur noch „Create“ tippen. Nach 3–5 Minuten erscheint der Wert mit allen Daten in der Übersicht. Quelle der Zahlen: Yahoo Finance. Kurzbeschreibungen und Thesen: Claude, Wissen bis etwa Mitte 2026.</p>`;
  $app.querySelectorAll("[data-lens]").forEach((b) => b.addEventListener("click", () => {
    entState.lens = b.dataset.lens; store.set("entLens", entState.lens); entState.n = 24;
    $app.querySelectorAll("[data-lens]").forEach((x) => x.classList.toggle("on", x === b));
    renderEntdeckenListe();
  }));
  const neu = (id, fn) => document.getElementById(id).addEventListener(id === "entQ" ? "input" : "change", (e) => { fn(e.target); entState.n = 24; renderEntdeckenListe(); });
  neu("entQ", (t) => { entState.q = t.value; });
  neu("entKat", (t) => { entState.kat = t.value; });
  neu("entThema", (t) => { entState.thema = t.value; });
  neu("entNeu", (t) => { entState.nurNeu = t.checked; store.set("entNeu", t.checked); });
  document.getElementById("entMehr").addEventListener("click", () => { entState.n += 24; renderEntdeckenListe(); });
  renderEntdeckenListe();
}

// ------------------------------------------------------------ Lexikon

function renderLexikon(ziel) {
  $app.innerHTML = `<div class="prose lex">
    <h1>Lexikon</h1>
    <p class="muted">Die wichtigsten Begriffe kurz erklärt, zum Nachschlagen. Faustregeln sind nur grobe Anhaltspunkte, je nach Branche ist anderes normal.</p>
    <input type="search" id="lexQ" placeholder="Begriff suchen, z. B. PEG, KUV, Free Cashflow …">
    <nav class="toolbar lex-nav">${LEXIKON.map((g, i) => `<button class="chip" data-g="g${i}">${esc(g.gruppe.split(":")[0])}</button>`).join("")}</nav>
    ${LEXIKON.map((g, i) => `<section id="g${i}" class="lex-gruppe"><h2>${esc(g.gruppe)}</h2>
      ${g.eintraege.map((e) => `<div class="card lex-e" id="lex-${e.id}" data-such="${esc((e.name + " " + e.kurz + " " + e.text).toLowerCase())}">
        <h3>${esc(e.name)}</h3><p class="lex-kurz">${esc(e.kurz)}</p><p class="small">${esc(e.text)}</p>
        ${e.faust ? `<p class="small muted"><strong>Faustregel:</strong> ${esc(e.faust)}</p>` : ""}</div>`).join("")}</section>`).join("")}
  </div>`;
  $app.querySelectorAll("[data-g]").forEach((b) => b.addEventListener("click", () => document.getElementById(b.dataset.g).scrollIntoView({ behavior: "smooth" })));
  document.getElementById("lexQ").addEventListener("input", (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    $app.querySelectorAll(".lex-e").forEach((c) => { c.hidden = !!q && !c.dataset.such.includes(q); });
    $app.querySelectorAll(".lex-gruppe").forEach((s) => { s.hidden = !s.querySelector(".lex-e:not([hidden])"); });
  });
  const el = ziel && document.getElementById("lex-" + ziel);
  if (el) { el.classList.add("treffer"); el.scrollIntoView({ block: "center" }); }
}

// ------------------------------------------------------------ Regeln

function renderRules() {
  const r = OV.regeln, cur = r.waehrung_grundbetrag || "EUR";
  const b = betraege();
  $app.innerHTML = `<div class="prose">
    <h1>Deine Kaufregeln</h1>
    <p>Lege fest, wie viel du in jeder Stufe zusätzlich investieren möchtest. Die Beträge werden sofort überall in der App übernommen und nur auf diesem Gerät gespeichert.</p>
    <div class="tbl-wrap"><table class="plain betrag-tab">
      <thead><tr><th>Stufe</th><th>Rückgang vom Allzeithoch</th><th>Betrag ETF (${cur})</th><th>Betrag Aktie (${cur})</th></tr></thead>
      <tbody>${r.stufen.map((s, i) => `<tr><td><span class="tier tier-${i + 1}">${esc(s.name)}</span></td>
        <td>ab −${s.ab_prozent} %</td>
        <td><input class="betrag" inputmode="decimal" data-typ="etf" data-i="${i}" value="${b.etf[i]}" aria-label="${esc(s.name)} Betrag ETF"></td>
        <td><input class="betrag" inputmode="decimal" data-typ="aktie" data-i="${i}" value="${b.aktie[i]}" aria-label="${esc(s.name)} Betrag Aktie"></td></tr>`).join("")}</tbody>
    </table></div>
    <p class="small" id="betragSumme"></p>
    <details class="card"><summary>Alle Stufen schnell aus einem Grundbetrag berechnen</summary>
      <p class="small">Trage den Betrag für Stufe 1 ein. Die höheren Stufen werden damit vervielfacht (${r.stufen.map((s) => s.faktor + "×").join(", ")}).</p>
      <div class="form">
        <label>Grundbetrag ETF<input id="grundEtf" inputmode="decimal" value="${b.etf[0]}"></label>
        <label>Grundbetrag Aktie<input id="grundAktie" inputmode="decimal" value="${b.aktie[0]}"></label>
        <button class="chip on" id="grundGo">Stufen berechnen</button>
        <button class="chip" id="grundReset">Auf Vorgabe zurücksetzen</button>
      </div>
    </details>
    <p class="muted small">Die Prozent-Grenzen der Stufen stehen in <code>config/rules.json</code> und lassen sich dort auf GitHub ändern. Neu erreichte Stufen stehen im Telegram-Wochenbericht. Das Tool kauft nichts, die Beträge sind nur deine eigene Merkhilfe.</p>

    <h2>Was die Forschung zu „Buy the Dip“ sagt</h2>
    <ul>
      <li><strong>Reines Warten auf Rücksetzer schneidet meist schlechter ab als ein fester Sparplan.</strong>
        In langfristigen Rückrechnungen für den US-Markt lag selbst ein Anleger, der jeden Tiefpunkt kennt, in über 70 % der 40-Jahres-Zeiträume hinter dem monatlichen Sparplan.
        Der Grund: Märkte steigen meist, und das Geld liegt beim Warten ungenutzt herum.</li>
      <li><strong>Auch wissenschaftliche Studien finden keinen verlässlichen Vorteil</strong> von Dip-Strategien gegenüber passivem Investieren.</li>
      <li><strong>Gängig ist deshalb eine Kombination:</strong> Der Sparplan läuft immer weiter. Zusätzlich wird eine <em>Reserve</em> gestaffelt eingesetzt, wenn ein Wert X % unter dem Allzeithoch steht.
        So nutzt du Rücksetzer, ohne den Sparplan zu verpassen. Genau das bildet dieses Tool ab: Die Stufe zeigt, wie viel <em>zusätzlich</em> die Regel vorsieht.</li>
      <li><strong>Einzelaktien sind anders als Indizes.</strong> Ein Index erholt sich historisch immer, eine Einzelaktie nicht unbedingt.
        Ein Rückgang von 50 % bei einer Aktie kann auch einen echten Grund haben. Deshalb stehen die Quartalszahlen und die Trend-Ampel direkt daneben.
        Fallender Kurs <em>und</em> gute Zahlen ist eine andere Lage als fallender Kurs <em>und</em> schrumpfender Umsatz.</li>
      <li><strong>Normale Schwankung:</strong> Rückgänge von 10 % kommen bei breiten Indizes etwa einmal im Jahr vor, 20 % und mehr seltener, 30 %+ nur in echten Krisen.
        Bei Einzelaktien sind 30–50 % deutlich häufiger. Deshalb sind getrennte Grundbeträge für ETFs und Aktien sinnvoll.</li>
      <li><strong>Insider-Käufe</strong> (Manager kaufen eigene Aktien mit eigenem Geld) zeigen in Studien eine Überrendite, besonders wenn mehrere gleichzeitig kaufen.
        Verkäufe sagen dagegen wenig aus.</li>
    </ul>
    <h2>Wann verkaufen? Hinweise bei Überhitzung</h2>
    <p>Das Tool markiert Werte als <span class="badge hot">🔥 heiß</span> bzw. <span class="badge hot2">🔥🔥 sehr heiß</span>, wenn sie weit über ihrer 200-Tage-Linie liegen
      oder der RSI sehr hoch ist. Diese Werte stehen auch im Telegram-Wochenbericht. Aktuelle Grenzen:</p>
    <div class="tbl-wrap"><table><thead><tr><th>Typ</th><th>🔥 heiß ab</th><th>🔥🔥 sehr heiß ab</th></tr></thead><tbody>
      ${["aktie", "etf"].map((t) => { const g = ((r.ueberhitzung || {})[t] || {}).abstand_sma200 || [30, 50];
        return `<tr style="cursor:default"><td>${t === "etf" ? "ETF" : "Aktie"}</td><td>+${g[0]} % über 200-Tage-Linie</td><td>+${g[1]} %</td></tr>`; }).join("")}
      <tr style="cursor:default"><td>Zusätzlich</td><td colspan="2">RSI(14) ≥ ${(r.ueberhitzung || {}).rsi_ueber || 75} (stark überkauft)</td></tr>
    </tbody></table></div>
    <p><strong>Wichtig: Das ist bewusst kein Verkaufssignal.</strong> Was Forschung und Praxis dazu sagen:</p>
    <ul>
      <li><strong>Gewinner zu früh zu verkaufen ist einer der häufigsten Anlegerfehler</strong> („Dispositionseffekt“). In einer bekannten Studie (Odean, 1998) entwickelten sich die verkauften Gewinneraktien
        im Folgejahr besser als die behaltenen Verliereraktien. Starke Unternehmen bleiben oft lange „überkauft“.</li>
      <li><strong>Steuern:</strong> Jeder Verkauf mit Gewinn kostet in Deutschland ~26,4 % Abgeltungsteuer inkl. Soli (über dem Freibetrag von 1.000 €).
        Wer hält, lässt den Steuerbetrag weiter mitarbeiten.</li>
      <li><strong>Breite ETFs</strong> verkauft man in der Regel nicht wegen hoher Kurse, sondern erst, wenn man das Geld braucht (oder zum Umschichten).</li>
      <li><strong>Gute Gründe für einen (Teil-)Verkauf einer Aktie</strong> sind eher:
        <ol>
          <li>Die Investmentthese ist kaputt (Umsatz bricht ein, Burggraben weg, Management enttäuscht). Steht im Profil unter „Die These wäre falsch, wenn …“.</li>
          <li>Die Position ist durch den Anstieg zu groß geworden, z. B. über 10–15 % des Depots. Dann ist <em>Rebalancing</em> (teilweise zurückschneiden) ein bewährter Ansatz.</li>
          <li>Die Bewertung ist extrem geworden (z. B. KGV weit über dem eigenen Durchschnitt und dem der Konkurrenz), während das Wachstum nachlässt.</li>
          <li>Es gibt eine klar bessere Verwendung für das Geld.</li>
        </ol></li>
      <li>Eine einfache Faustregel mancher Anleger: Bei „sehr heiß“ einen <em>kleinen Teil</em> (z. B. 10–25 %) mitnehmen und den Rest laufen lassen. Das ist ein Kompromiss zwischen Gier und Angst, keine optimale Strategie.</li>
    </ul>

    <div class="note small">Dieses Tool zeigt Daten und wendet deine selbst gewählten Regeln an. Es ist keine Anlageberatung und kauft oder verkauft nichts.
      Die Beträge legst du selbst fest, entscheide, was zu deiner Situation passt.</div>
  </div>`;
  const summe = () => {
    const betroffen = sichtbar().filter((w) => w.stufe > 0);
    document.getElementById("betragSumme").innerHTML = `Aktuell stehen <strong>${betroffen.length} Werte</strong> in einer Stufe. Würdest du überall deinen Betrag einsetzen, wären das <strong>${fmt(betroffen.reduce((a, w) => a + betragFuer(w), 0), 0)} ${cur}</strong>. Das soll zeigen, wie weit dein freies Geld reicht. Es ist kein Vorschlag, alles zu kaufen.`;
  };
  $app.querySelectorAll(".betrag").forEach((f) => f.addEventListener("input", () => {
    const akt = betraege();
    const v = zahl(f.value);
    if (v == null || v < 0) return;
    akt[f.dataset.typ][+f.dataset.i] = v;
    store.set("betraege", akt);
    applyBetraege();
    summe();
  }));
  document.getElementById("grundGo").addEventListener("click", () => {
    const e = zahl(document.getElementById("grundEtf").value), a = zahl(document.getElementById("grundAktie").value);
    if (e == null || a == null) return;
    store.set("betraege", { etf: r.stufen.map((s) => e * s.faktor), aktie: r.stufen.map((s) => a * s.faktor) });
    applyBetraege();
    renderRules();
  });
  document.getElementById("grundReset").addEventListener("click", () => { store.set("betraege", {}); applyBetraege(); renderRules(); });
  summe();
}

// ------------------------------------------------------------ Router

let warUebersicht = false, ovScroll = 0;
const GRUPPE_MEHR = ["alarme", "vergleich", "lexikon", "regeln"];

function route() {
  destroyCharts(); priceChart = null; hideTerm();
  const h = location.hash || "#/";
  // Position in der Übersicht merken, damit „zurück“ nicht wieder oben landet
  if (warUebersicht) ovScroll = scrollY;
  const zurueck = h.startsWith("#/wert/") ? false : ovScroll;
  const tab = ["investoren", "regeln", "entdecken", "lexikon", "vergleich", "alarme"].find((t) => h.startsWith("#/" + t)) || "uebersicht";
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  document.getElementById("mehrBtn").classList.toggle("active", GRUPPE_MEHR.includes(tab));
  document.getElementById("mehrMenu").hidden = true;
  const teile = h.split("/").map(decodeURIComponent);
  warUebersicht = false;
  window.scrollTo(0, 0);
  if (h.startsWith("#/wert/")) return renderDetail(decodeURIComponent(h.slice(7)));
  if (tab === "investoren") return renderInvestors();
  if (tab === "regeln") return renderRules();
  if (tab === "entdecken") return renderEntdecken();
  if (tab === "lexikon") return renderLexikon(teile[2]);
  if (tab === "vergleich") return renderVergleich(teile[2], teile[3]);
  if (tab === "alarme") return renderAlarme();
  renderOverview();
  warUebersicht = true;
  if (zurueck) window.scrollTo(0, zurueck);
}

async function init() {
  try {
    OV = await getJSON("data/overview.json");
  } catch (e) {
    $app.innerHTML = `<div class="card"><h3>Noch keine Daten</h3><p class="muted">Die Datei <code>data/overview.json</code> fehlt. Der erste automatische Lauf hat vermutlich noch nicht stattgefunden.</p></div>`;
    return;
  }
  try { INV = await getJSON("data/investoren.json"); } catch { INV = null; }
  try { ENT = await getJSON("data/entdecken.json"); } catch { ENT = null; }
  applyBetraege();
  setupNav();
  document.getElementById("stand").textContent = "Stand: " + new Date(OV.aktualisiert).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) +
    (OV.fehler && OV.fehler.length ? ` · ${OV.fehler.length} Werte nicht geladen: ${OV.fehler.map((f) => f.symbol).join(", ")}` : "");
  addEventListener("hashchange", route);
  route();
}

init();
