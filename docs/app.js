"use strict";

// ------------------------------------------------------------ Hilfsfunktionen

const $app = document.getElementById("app");
const nf = (d) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (v, d = 2) => (v == null || isNaN(v) ? "–" : nf(d).format(v));
const fmtPct = (v, d = 1, sign = true) =>
  v == null || isNaN(v) ? "–" : (sign && v > 0 ? "+" : "") + nf(d).format(v) + " %";
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
let charts = [];

async function getJSON(url) {
  const r = await fetch(url + "?t=" + Date.now());
  if (!r.ok) throw new Error(url + ": " + r.status);
  return r.json();
}

function tierBadge(w) {
  if (!w.stufe) return `<span class="tier tier-0">–</span>`;
  const s = OV.regeln.stufen[w.stufe - 1];
  return `<span class="tier tier-${w.stufe}" title="ab −${s.ab_prozent} % · Faktor ${s.faktor}×">${esc(s.name)}</span>`;
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

// ------------------------------------------------------------ Übersicht

const state = {
  kat: store.get("kat", "Alle"),
  sort: store.get("sort", { key: "rueckgang_ath", asc: false }),
  q: "",
};

const COLS = [
  { key: "name", label: "Wert", get: (w) => w.name.toLowerCase() },
  { key: "kurs", label: "Kurs", get: (w) => w.kurs },
  { key: "tag_pct", label: "Heute", get: (w) => w.tag_pct },
  { key: "rueckgang_ath", label: "vom ATH", get: (w) => w.rueckgang_ath },
  { key: "stufe", label: "Stufe", get: (w) => w.stufe },
  { key: "zusatzkauf", label: "Regel-Betrag", get: (w) => w.zusatzkauf, hide: true },
  { key: "abstand_sma200", label: "vs. 200-Tage", get: (w) => w.abstand_sma200, hide: true },
  { key: "perf_1j", label: "1 Jahr", get: (w) => w.perf_1j, hide: true },
  { key: "kgv_erwartet", label: "KGV erw.", get: (w) => w.kgv_erwartet, hide: true },
  { key: "ampel", label: "Quartal", get: (w) => (w.ampel ? w.ampel.punkte : null), hide: true },
  { key: "pruefung_gruen", label: "Check", get: (w) => (w.pruefung_anzahl ? w.pruefung_gruen / w.pruefung_anzahl : null), hide: true },
  { key: "naechste_zahlen", label: "Zahlen am", get: (w) => w.naechste_zahlen || "9999", hide: true },
];

function renderOverview() {
  const werte = OV.werte;
  const kats = ["Alle", ...new Set(werte.map((w) => w.kategorie))];
  if (!kats.includes(state.kat)) state.kat = "Alle";

  const inStufe = werte.filter((w) => w.stufe > 0);
  const tiefste = [...werte].sort((a, b) => b.rueckgang_ath - a.rueckgang_ath)[0];
  const bald = werte.filter((w) => { const d = daysUntil(w.naechste_zahlen); return d != null && d >= 0 && d <= 14; });
  const insider = werte.filter((w) => w.insider_kaeufe_90t > 0);
  const nahAth = werte.filter((w) => w.rueckgang_ath < 3);
  const heiss = werte.filter((w) => w.heiss > 0);

  $app.innerHTML = `
    <div class="grid stats">
      <div class="card stat"><div class="label">In einer Kaufstufe</div><div class="value">${inStufe.length} / ${werte.length}</div>
        <div class="sub">≥ ${OV.regeln.stufen[0].ab_prozent} % unter Allzeithoch</div></div>
      <div class="card stat"><div class="label">Größter Rückgang</div><div class="value neg">${fmtPct(-tiefste.rueckgang_ath)}</div>
        <div class="sub">${esc(tiefste.name)}</div></div>
      <div class="card stat"><div class="label">Nahe Allzeithoch (&lt; 3 %)</div><div class="value">${nahAth.length}</div>
        <div class="sub">${esc(nahAth.slice(0, 3).map((w) => w.name).join(", ") || "–")}</div></div>
      <div class="card stat"><div class="label">Heiß gelaufen 🔥</div><div class="value">${heiss.length}</div>
        <div class="sub">${esc(heiss.slice(0, 3).map((w) => w.name).join(", ") || "keine")}</div></div>
      <div class="card stat"><div class="label">Quartalszahlen in 14 Tagen</div><div class="value">${bald.length}</div>
        <div class="sub">${esc(bald.slice(0, 3).map((w) => w.name).join(", ") || "–")}</div></div>
      <div class="card stat"><div class="label">Insider-Käufe (90 Tage)</div><div class="value">${insider.length}</div>
        <div class="sub">${esc(insider.map((w) => w.name).join(", ") || "keine")}</div></div>
    </div>

    <div class="toolbar">
      ${kats.map((k) => `<button class="chip ${k === state.kat ? "on" : ""}" data-kat="${esc(k)}">${esc(k)}</button>`).join("")}
      <input type="search" id="q" placeholder="Suchen …" value="${esc(state.q)}">
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
    <div class="tbl-wrap"><table id="tbl"><thead></thead><tbody></tbody></table></div>
    <p class="muted small">Rückgang und Stufe beziehen sich auf den höchsten Schlusskurs der gesamten Historie in Handelswährung.
      „Regel-Betrag“ = Grundbetrag × Faktor der Stufe laut <a href="#/regeln">deinen Regeln</a>.
      Klick auf eine Zeile öffnet die Analyse.</p>`;

  $app.querySelectorAll("[data-kat]").forEach((b) =>
    b.addEventListener("click", () => { state.kat = b.dataset.kat; store.set("kat", state.kat); renderOverview(); }));
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
  let rows = OV.werte.filter((w) => (state.kat === "Alle" || w.kategorie === state.kat) &&
    (!q || (w.name + " " + w.symbol + " " + (w.langname || "")).toLowerCase().includes(q)));
  rows.sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    if (x == null) return 1; if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * (state.sort.asc ? 1 : -1);
  });
  const tbl = document.getElementById("tbl");
  tbl.querySelector("thead").innerHTML = "<tr>" + COLS.map((c) =>
    `<th data-k="${c.key}" class="${c.hide ? "hide-m" : ""} ${c.key === col.key ? "sorted" + (state.sort.asc ? " asc" : "") : ""}">${c.label}</th>`).join("") + "</tr>";
  const cur = OV.regeln.waehrung_grundbetrag || "EUR";
  tbl.querySelector("tbody").innerHTML = rows.map((w) => {
    const z = daysUntil(w.naechste_zahlen);
    return `<tr data-s="${esc(w.symbol)}">
      <td><div class="name">${esc(w.name)} ${heatBadge(w)} ${w.insider_kaeufe_90t ? `<span class="badge buy" title="Insider-Käufe in den letzten 90 Tagen">Insider</span>` : ""}
          ${w.politiker_90t ? `<span class="badge" title="Politiker-Trades in den letzten 90 Tagen gemeldet">🏛 ${w.politiker_90t}</span>` : ""}</div>
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
      <td class="hide-m">${w.ampel ? `<span class="dot ${w.ampel.farbe}" title="${esc(w.ampel.gruende.join(" · "))}"></span>` : "–"}</td>
      <td class="hide-m" title="Grüne Antworten im Kennzahlen-Check">${checkBadge(w)}</td>
      <td class="hide-m">${w.naechste_zahlen ? date(w.naechste_zahlen) + (z != null && z >= 0 && z <= 14 ? ` <span class="badge watch">${z} T</span>` : "") : "–"}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="${COLS.length}" class="muted">Keine Treffer</td></tr>`;

  tbl.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k;
    state.sort = { key: k, asc: state.sort.key === k ? !state.sort.asc : k === "name" || k === "naechste_zahlen" };
    store.set("sort", state.sort);
    renderRows();
  }));
  tbl.querySelectorAll("tbody tr[data-s]").forEach((tr) =>
    tr.addEventListener("click", () => { location.hash = "#/wert/" + encodeURIComponent(tr.dataset.s); }));
}

// ------------------------------------------------------------ Detailseite

async function renderDetail(sym) {
  $app.innerHTML = `<p class="muted">Lade ${esc(sym)} …</p>`;
  let d;
  try { d = await getJSON("data/werte/" + safe(sym) + ".json"); }
  catch { $app.innerHTML = `<a class="back" href="#/">← Übersicht</a><p>Keine Daten für ${esc(sym)}.</p>`; return; }
  const w = d.item, f = d.fundamentaldaten, cur = w.waehrung || "";
  const stufen = OV.regeln.stufen;
  const naechste = stufen.find((s) => s.ab_prozent > w.rueckgang_ath);
  const kursNaechste = naechste ? w.ath * (1 - naechste.ab_prozent / 100) : null;

  const kv = (k, v, c = "") => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`;

  let html = `
    <a class="back" href="#/">← Übersicht</a>
    <div class="head">
      <div>
        <h1>${esc(w.langname || w.name)}</h1>
        <div class="muted">${esc(w.symbol)} · ${esc(w.kategorie)}${f && f.sektor ? " · " + esc(f.sektor) : ""}${f && f.land ? " · " + esc(f.land) : ""}</div>
      </div>
      <div style="text-align:right">
        <div class="price">${fmt(w.kurs)} <span class="muted small">${esc(cur)}</span></div>
        <div class="${cls(w.tag_pct)}">${fmtPct(w.tag_pct, 2)} heute · Stand ${date(w.datum)}</div>
      </div>
    </div>

    <div class="grid kv">
      ${kv("Rückgang vom Allzeithoch", fmtPct(-w.rueckgang_ath), w.rueckgang_ath > 0.05 ? "neg" : "")}
      ${kv("Kaufstufe", tierBadge(w) + (w.zusatzkauf ? ` <span class="small">${fmt(w.zusatzkauf, 0)} ${esc(OV.regeln.waehrung_grundbetrag)}</span>` : ""))}
      ${kv("Allzeithoch", `${fmt(w.ath)} <span class="small muted">${date(w.ath_datum)}</span>`)}
      ${kv("Nächste Stufe", naechste ? `${fmt(kursNaechste)} <span class="small muted">(−${naechste.ab_prozent} %)</span>` : "höchste erreicht")}
      ${kv("vom 52-Wochen-Hoch", fmtPct(-w.rueckgang_52w), w.rueckgang_52w > 0.05 ? "neg" : "")}
      ${kv("Abstand 200-Tage-Linie", fmtPct(w.abstand_sma200), cls(w.abstand_sma200))}
      ${kv("Seit Jahresbeginn", fmtPct(w.perf_ytd), cls(w.perf_ytd))}
      ${kv("1 Jahr / 5 Jahre", `<span class="${cls(w.perf_1j)}">${fmtPct(w.perf_1j, 0)}</span> / <span class="${cls(w.perf_5j)}">${fmtPct(w.perf_5j, 0)}</span>`)}
      ${kv("RSI (14 Tage)", `${fmt(w.rsi, 0)} <span class="small muted">${w.rsi >= 70 ? "überkauft" : w.rsi <= 30 ? "überverkauft" : "neutral"}</span>`)}
    </div>
    ${w.heiss ? `<div class="note hotnote">${heatBadge(w)} <strong>${esc(w.name)} liegt ${fmtPct(w.abstand_sma200, 0)} über der 200-Tage-Linie</strong> (RSI ${fmt(w.rsi, 0)}).
      Kein Verkaufssignal, aber ein guter Moment, die eigene These und die Positionsgröße zu prüfen. Mehr dazu unter <a href="#/regeln">Regeln</a>.</div>` : ""}
    ${glance(w, f, d.profil)}

    <h2>Kursverlauf</h2>
    <div class="card">
      <div class="ranges">${["1J", "3J", "5J", "Max"].map((r) => `<button class="chip ${r === "5J" ? "on" : ""}" data-r="${r}">${r}</button>`).join("")}</div>
      <div class="chart-box"><canvas id="cPrice"></canvas></div>
      <p class="muted small" style="margin:8px 0 0">Gestrichelt: Allzeithoch und die Kurse, bei denen deine Stufen beginnen. Ältere Daten als Wochenkurse.</p>
    </div>`;

  html += profileSection(d.profil, w);
  if (f) html += checkSection(f) + mgmtSection(f);

  if (f) {
    const q = f.quartale || [];
    const zTage = daysUntil(f.naechste_zahlen);
    html += `
    <h2>Bewertung & Kennzahlen</h2>
    <div class="grid kv">
      ${kv("Marktkapitalisierung", big(f.marktkap) + " " + esc(cur))}
      ${kv("KGV / erwartet", `${fmt(f.kgv, 1)} / ${fmt(f.kgv_erwartet, 1)}`)}
      ${kv("PEG / KUV", `${fmt(f.peg, 2)} / ${fmt(f.kuv, 1)}`)}
      ${kv("Umsatzwachstum (J/J)", fmtRatio(f.umsatzwachstum), cls(f.umsatzwachstum))}
      ${kv("Bruttomarge / op. Marge", `${fmtRatio(f.bruttomarge, 0)} / ${fmtRatio(f.operative_marge, 0)}`)}
      ${kv("Eigenkapitalrendite", fmtRatio(f.eigenkapitalrendite, 0))}
      ${kv("Dividendenrendite", f.dividendenrendite != null ? fmt(f.dividendenrendite, 2) + " %" : "–")}
      ${kv("Nächste Quartalszahlen", f.naechste_zahlen ? date(f.naechste_zahlen) + (zTage != null && zTage >= 0 ? ` <span class="small muted">in ${zTage} T.</span>` : "") : "–")}
      ${kv("Analysten-Kursziel", f.kursziel ? `${fmt(f.kursziel)} <span class="small ${cls(f.kursziel - w.kurs)}">${fmtPct((f.kursziel / w.kurs - 1) * 100, 0)}</span>` : "–")}
      ${kv("Analysten-Konsens", `${esc(EMPFEHLUNG[f.analysten_empfehlung] || f.analysten_empfehlung || "–")} <span class="small muted">${f.analysten_anzahl ? f.analysten_anzahl + " Analysten" : ""}</span>`)}
    </div>
    ${f.erwartung_eps ? `<div class="note small">Erwartung für die nächsten Zahlen: Gewinn je Aktie ${fmt(f.erwartung_eps)} ${esc(cur)}, Umsatz ${big(f.erwartung_umsatz)} ${esc(cur)}.</div>` : ""}

    ${f.ampel ? `<h2>Letztes Quartal</h2>
    <div class="card ampel-box"><span class="dot ${f.ampel.farbe}" style="width:16px;height:16px;margin-top:3px"></span>
      <div><strong>${{ gruen: "Starkes Quartal", gelb: "Gemischtes Quartal", rot: "Schwaches Quartal" }[f.ampel.farbe]}</strong>
      <span class="muted small">(${esc(date(q[q.length - 1].periode))})</span>
      <ul class="clean small">${f.ampel.gruende.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div></div>` : ""}

    ${yearsSection(f, cur)}

    ${q.length ? `
    <h2>Quartale</h2>
    <div class="grid two" style="margin-top:12px">
      <div class="card"><h3>Umsatz & Nettogewinn</h3><div class="chart-box sm"><canvas id="cRev"></canvas></div></div>
      <div class="card"><h3>Margen</h3><div class="chart-box sm"><canvas id="cMarg"></canvas></div></div>
    </div>
    <div class="tbl-wrap" style="margin-top:12px"><table>
      <thead><tr><th>Quartal</th><th>Umsatz</th><th>J/J</th><th>Q/Q</th><th>Brutto-M.</th><th>Op. Marge</th><th>Nettogewinn</th><th>EPS</th><th>EPS J/J</th><th>Free Cashflow</th></tr></thead>
      <tbody>${[...q].reverse().map((e) => `<tr style="cursor:default">
        <td>${date(e.periode)}</td><td>${big(e.umsatz)}</td>
        <td class="${cls(e.umsatz_yoy)}">${fmtPct(e.umsatz_yoy)}</td><td class="${cls(e.umsatz_qoq)}">${fmtPct(e.umsatz_qoq)}</td>
        <td>${fmtRatio(e.bruttomarge)}</td><td>${fmtRatio(e.operative_marge)}</td>
        <td class="${cls(e.nettogewinn)}">${big(e.nettogewinn)}</td><td>${fmt(e.eps)}</td>
        <td class="${cls(e.eps_yoy)}">${fmtPct(e.eps_yoy)}</td><td class="${cls(e.fcf)}">${big(e.fcf)}</td></tr>`).join("")}</tbody>
    </table></div>
    <p class="muted small">Beträge in ${esc(cur)} laut Yahoo Finance. J/J = ggü. Vorjahresquartal, Q/Q = ggü. Vorquartal.</p>` : ""}`;
  }

  if (d.insider && d.insider.length) {
    html += `
    <h2>Insider-Transaktionen</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Datum</th><th>Person</th><th>Position</th><th>Art</th><th>Aktien</th><th>Wert ($)</th></tr></thead>
      <tbody>${d.insider.map((x) => `<tr style="cursor:default">
        <td>${date(x.datum)}</td><td>${esc(x.person)}</td><td class="trunc">${esc(x.position)}</td>
        <td><span class="badge ${x.art === "kauf" ? "buy" : x.art === "verkauf" ? "sell" : ""}" title="${esc(x.text)}">${{ kauf: "Kauf", verkauf: "Verkauf", sonstiges: "Sonstiges" }[x.art]}</span></td>
        <td>${fmt(x.aktien, 0)}</td><td>${big(x.wert)}</td></tr>`).join("")}</tbody>
    </table></div>
    <p class="muted small">Käufe aus eigener Tasche gelten als aussagekräftiger als Verkäufe, denn verkauft wird oft aus steuerlichen oder privaten Gründen oder nach festem Plan.
      Mehrere Insider, die kurz nacheinander kaufen („Cluster“), sind das stärkste Signal.</p>`;
  }

  if (d.politiker && d.politiker.length) {
    html += `<h2>Politiker-Trades (US-Kongress)</h2>${politikTable(d.politiker, false)}`;
  }

  // 13F: Wer von den beobachteten Investoren hält diesen Wert?
  const halter = holdersOf(w);
  if (halter.length) {
    html += `<h2>Gehalten von großen Investoren (13F)</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Investor</th><th>Wert</th><th>Anteil Depot</th><th>Veränderung</th><th>Stichtag</th></tr></thead>
    <tbody>${halter.map(({ inv, p }) => `<tr style="cursor:default"><td>${esc(inv.name)} <span class="sym">${esc(inv.person || "")}</span></td>
      <td>${big(p.wert)} $</td><td>${fmt(p.anteil, 1)} %</td><td>${changeBadge(p)}</td><td>${date(inv.stichtag)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  if (f && f.beschreibung) {
    html += `<h2>Offizielle Kurzbeschreibung <span class="muted small">(Yahoo, englisch)</span></h2><div class="card"><div class="desc small" id="desc">${esc(f.beschreibung)}</div>
      <button class="chip" id="more" style="margin-top:8px">Mehr anzeigen</button></div>`;
  }

  const usTicker = !w.symbol.includes(".");
  html += `<h2>Links</h2><div class="card links">
    <a href="https://finance.yahoo.com/quote/${encodeURIComponent(w.symbol)}" target="_blank" rel="noopener">Yahoo Finance</a>
    ${w.typ !== "etf" ? `<a href="https://www.google.com/search?q=${encodeURIComponent((w.langname || w.name) + " investor relations quarterly results")}" target="_blank" rel="noopener">Investor Relations</a>` : ""}
    ${usTicker && w.typ !== "etf" ? `<a href="http://openinsider.com/search?q=${encodeURIComponent(w.symbol)}" target="_blank" rel="noopener">OpenInsider</a>
      <a href="https://www.capitoltrades.com/issuers?search=${encodeURIComponent(w.symbol)}" target="_blank" rel="noopener">Politiker-Trades (Capitol Trades)</a>
      <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(w.name)}&type=10-Q" target="_blank" rel="noopener">SEC-Filings</a>` : ""}
    ${w.typ === "etf" ? `<a href="https://www.justetf.com/de/search.html?query=${encodeURIComponent(w.langname || w.name)}" target="_blank" rel="noopener">justETF</a>` : ""}
  </div>
  <p class="small" style="margin-top:20px"><a class="neg" href="${issueUrl(`Watchlist: entfernen ${w.symbol}`, ["aktion: entfernen", `symbol: ${w.symbol}`])}" target="_blank" rel="noopener">${esc(w.name)} aus der Watchlist entfernen …</a>
    <span class="muted">(öffnet GitHub, dort „Create“ tippen)</span></p>`;

  $app.innerHTML = html;
  const desc = document.getElementById("desc");
  if (desc) document.getElementById("more").addEventListener("click", (e) => { desc.classList.toggle("open"); e.target.textContent = desc.classList.contains("open") ? "Weniger" : "Mehr anzeigen"; });

  drawPrice(d, "5J");
  $app.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
    $app.querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("on", x === b));
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
  return `<h2>Auf einen Blick</h2><div class="card glance">
    ${p && p.kurz ? `<p style="margin:0 0 10px"><strong>${esc(p.kurz)}</strong></p>` : ""}
    <div class="g-grid">
      ${ceo ? row("CEO", `${esc(ceo.name)}${ceo.alter ? ` <span class="muted small">(${ceo.alter})</span>` : ""}`) : ""}
      ${f && f.mitarbeiter ? row("Mitarbeiter", fmt(f.mitarbeiter, 0)) : ""}
      ${f && f.marktkap ? row("Börsenwert", big(f.marktkap) + " " + esc(cur)) : ""}
      ${f && f.schulden != null ? row("Schulden", big(f.schulden) + " " + esc(bw)) : ""}
      ${f && f.cash != null ? row("Cash", big(f.cash) + " " + esc(bw)) : ""}
      ${net != null ? row(net > 0 ? "Nettoschulden" : "Nettocash", `<span class="${net > 0 ? "" : "pos"}">${big(Math.abs(net))} ${esc(bw)}</span>` + (lev != null && net > 0 ? ` <span class="small muted">(${fmt(lev, 1)}× EBITDA)</span>` : "")) : ""}
      ${f && f.insider_anteil != null ? row("Anteil Insider", fmt(f.insider_anteil * 100, 1) + " %") : ""}
      ${w.pruefung_anzahl ? row("Kennzahlen-Check", `${checkBadge(w)} grün`) : ""}
      ${row("Status", w.heiss ? heatBadge(w) : w.stufe ? tierBadge(w) : `<span class="muted">normal</span>`)}
    </div></div>`;
}

const PROFIL_FRAGEN = [
  ["was_macht", "Was macht das Unternehmen?"],
  ["geld", "Wie verdient es sein Geld?"],
  ["warum_kunden", "Warum kaufen Kunden dort?"],
  ["zukunft", "Warum gibt es das Unternehmen in 5–10 Jahren noch?"],
  ["unterschied", "Was unterscheidet es von der Konkurrenz?"],
  ["markt", "Wie groß ist der Markt – und wächst er?"],
  ["plaene", "Welche Pläne hat das Unternehmen?"],
  ["ceo", "Wer ist der CEO?"],
  ["management", "Was hat das Management bisher gemacht? Wie setzt es Kapital ein?"],
];

function profileSection(p, w) {
  if (!p) {
    return w.typ === "etf" ? "" : `<h2>Das Unternehmen verstehen</h2><div class="card muted small">Für diesen Wert gibt es noch kein ausführliches Profil.
      Bitte Claude, eins zu ergänzen (Datei <code>config/profiles/</code>). Die Kennzahlen unten werden trotzdem automatisch ausgewertet.</div>`;
  }
  const qa = PROFIL_FRAGEN.filter(([k]) => p[k]).map(([k, q]) =>
    `<div class="qa"><div class="q">${q}</div><div class="a">${esc(p[k])}</div></div>`).join("");
  return `<h2>${w.typ === "etf" ? "Was steckt drin?" : "Das Unternehmen verstehen"}</h2>
    <div class="card"><div class="qa-grid">${qa}</div></div>
    <div class="grid two" style="margin-top:12px">
      <div class="card contra"><h3>Gegenargumente & Risiken</h3>
        <ul class="clean small">${(p.risiken || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        ${p.these_falsch_wenn ? `<p class="small" style="margin:10px 0 0"><strong>Die These wäre falsch, wenn …</strong> ${esc(p.these_falsch_wenn)}</p>` : ""}</div>
      <div class="card"><h3>Warum dieses Unternehmen – und nicht einfach ein ETF?</h3>
        <p class="small" style="margin:0">${esc(p.warum_nicht_etf || "–")}</p></div>
    </div>
    <p class="muted small">Profil Stand ${esc(p.stand || "–")}, von Claude zusammengestellt. Qualitative Einschätzung, keine Anlageberatung. Prüfe wichtige Punkte in den Originalquellen (Geschäftsbericht, Investor Relations).</p>`;
}

function checkSection(f) {
  const p = f.pruefung || [];
  if (!p.length) return "";
  return `<h2>Kennzahlen-Check</h2>
    <div class="card"><div class="checks">${p.map((x) => `<div class="check"><span class="dot ${x.farbe}"></span>
      <div><div class="q">${esc(x.frage)}</div><div class="small">${esc(x.antwort)}</div></div></div>`).join("")}</div></div>
    <p class="muted small">Automatisch aus den Jahreszahlen berechnet (Grün = günstig, Gelb = neutral, Rot = genauer hinschauen). Grenzwerte sind Faustregeln, je nach Branche ist anderes normal.</p>`;
}

function mgmtSection(f) {
  const m = f.management || [];
  if (!m.length) return "";
  return `<h2>Management</h2><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Position</th><th>Alter</th></tr></thead><tbody>
    ${m.map((o) => `<tr style="cursor:default"><td>${esc(o.name)} ${o.ceo ? `<span class="badge watch">CEO</span>` : ""}</td><td class="trunc" style="max-width:420px" title="${esc(o.titel)}">${esc(o.titel)}</td><td>${o.alter || "–"}</td></tr>`).join("")}
    </tbody></table></div><p class="muted small">Live-Daten von Yahoo Finance.</p>`;
}

function yearsSection(f, cur) {
  const j = f.jahre || [];
  if (!j.length) return "";
  const bw = f.bilanzwaehrung || cur;
  const cols = [
    ["Umsatz", (e) => big(e.umsatz)], ["Nettogewinn", (e) => `<span class="${cls(e.nettogewinn)}">${big(e.nettogewinn)}</span>`],
    ["EPS", (e) => fmt(e.eps)], ["Op. Marge", (e) => fmtRatio(e.operative_marge)],
    ["Free Cashflow", (e) => `<span class="${cls(e.fcf)}">${big(e.fcf)}</span>`], ["CapEx", (e) => big(e.capex == null ? null : Math.abs(e.capex))],
    ["Schulden", (e) => big(e.schulden)], ["Cash", (e) => big(e.cash)],
    ["Aktien (Mio.)", (e) => fmt(e.aktien == null ? null : e.aktien / 1e6, 0)], ["Rückkäufe", (e) => big(e.rueckkaeufe == null ? null : Math.abs(e.rueckkaeufe))],
  ];
  return `<h2>Jahreszahlen</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Geschäftsjahr</th>${cols.map(([c]) => `<th>${c}</th>`).join("")}</tr></thead>
    <tbody>${[...j].reverse().map((e) => `<tr style="cursor:default"><td>${e.jahr}</td>${cols.map(([, g]) => `<td>${g(e)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="muted small">Beträge in ${esc(bw)}. Yahoo liefert kostenlos die letzten ~4 Geschäftsjahre. Für 10 Jahre: Geschäftsberichte auf der Investor-Relations-Seite.</p>`;
}

function politikTable(list, withName) {
  return `<div class="tbl-wrap"><table><thead><tr><th>Gemeldet</th>${withName ? "<th>Wert</th>" : ""}<th>Politiker</th><th>Art</th><th>Betrag ($)</th><th>Handelstag</th></tr></thead><tbody>
    ${list.map((x) => `<tr style="cursor:default"><td>${date(x.gemeldet)}</td>
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

let priceChart = null;
function drawPrice(d, range) {
  if (priceChart) { priceChart.destroy(); charts = charts.filter((c) => c !== priceChart); }
  const years = { "1J": 1, "3J": 3, "5J": 5, Max: 200 }[range];
  const cut = new Date(); cut.setFullYear(cut.getFullYear() - years);
  const cutS = cut.toISOString().slice(0, 10);
  const pts = d.historie.filter((p) => p[0] >= cutS);
  const w = d.item;
  const line = (y, label, color) => ({ label, data: pts.map(() => y), borderColor: color, borderWidth: 1, borderDash: [5, 4], pointRadius: 0, fill: false });
  const accent = css("--accent");
  const ds = [{
    label: "Kurs", data: pts.map((p) => p[1]), borderColor: accent, borderWidth: 1.8, pointRadius: 0, tension: 0.1,
    fill: { target: "origin" }, backgroundColor: accent + "14",
  }, line(w.ath, "Allzeithoch", css("--muted"))];
  const colors = ["--t1-text", "--t2-text", "--t3-text", "--t4-text", "--t5-text"];
  const minP = Math.min(...pts.map((p) => p[1]));
  OV.regeln.stufen.forEach((s, i) => {
    const y = w.ath * (1 - s.ab_prozent / 100);
    if (y >= minP * 0.9) ds.push(line(y, `${s.name} (−${s.ab_prozent} %)`, css(colors[Math.min(i, 4)])));
  });
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
        x: { ticks: { maxTicksLimit: 7, callback(v) { const l = this.getLabelForValue(v); return range === "1J" ? l.slice(5, 7) + "/" + l.slice(2, 4) : l.slice(0, 4); } }, grid: { display: false } },
        y: { ticks: { callback: (v) => fmt(v, 0) } },
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
  GEV: "GE VERNOVA", LRCX: "LAM RESEARCH", SPCX: "SPACE EXPLORATION", MA: "MASTERCARD", "6861.T": "KEYENCE", "000660.KS": "SK HYNIX" };
function issuerKey(w) { return (ALIAS[w.symbol] || w.name.split(" ")[0]).toUpperCase(); }
function matchWatch(name) {
  const n = (name || "").toUpperCase();
  return OV.werte.find((w) => w.typ !== "etf" && n.startsWith(issuerKey(w)));
}
function holdersOf(w) {
  if (!INV || w.typ === "etf") return [];
  const key = issuerKey(w), out = [];
  INV.investoren.forEach((inv) => inv.positionen.forEach((p) => {
    if ((p.name || "").toUpperCase().startsWith(key) && (p.wert > 0 || p.aenderung === "verkauft")) out.push({ inv, p });
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
      <div class="muted small">${esc(inv.person || "")} · Stichtag ${date(inv.stichtag)} · gemeldet ${date(inv.filing_datum)}
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
    <p class="muted prose">Fonds mit über 100 Mio. $ müssen ihre US-Aktienpositionen quartalsweise per <strong>13F</strong> an die SEC melden, und zwar bis zu 45 Tage nach Quartalsende.
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

// ------------------------------------------------------------ Regeln

function renderRules() {
  const r = OV.regeln, cur = r.waehrung_grundbetrag || "EUR";
  $app.innerHTML = `<div class="prose">
    <h1>Deine Kaufregeln</h1>
    <p>Die Regeln stehen in <code>config/rules.json</code> und gelten für alle Werte. Ändern kannst du sie direkt auf GitHub (Datei öffnen → Stift-Symbol).
      Beim nächsten Lauf werden sie übernommen.</p>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Stufe</th><th>Rückgang vom ATH</th><th>Faktor</th><th>Betrag ETF</th><th>Betrag Aktie</th></tr></thead>
      <tbody>${r.stufen.map((s, i) => `<tr style="cursor:default"><td><span class="tier tier-${i + 1}">${esc(s.name)}</span></td>
        <td>ab −${s.ab_prozent} %</td><td>${s.faktor}×</td><td>${fmt(r.grundbetrag.etf * s.faktor, 0)} ${cur}</td><td>${fmt(r.grundbetrag.aktie * s.faktor, 0)} ${cur}</td></tr>`).join("")}</tbody>
    </table></div>

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
      oder der RSI sehr hoch ist. Dafür gibt es auch eine Telegram-Nachricht. Aktuelle Grenzen:</p>
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
      Die Beträge sind Beispielwerte, entscheide selbst, was zu deiner Situation passt.</div>
  </div>`;
}

// ------------------------------------------------------------ Router

function route() {
  destroyCharts(); priceChart = null;
  const h = location.hash || "#/";
  const tab = h.startsWith("#/investoren") ? "investoren" : h.startsWith("#/regeln") ? "regeln" : "uebersicht";
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  window.scrollTo(0, 0);
  if (h.startsWith("#/wert/")) return renderDetail(decodeURIComponent(h.slice(7)));
  if (tab === "investoren") return renderInvestors();
  if (tab === "regeln") return renderRules();
  renderOverview();
}

async function init() {
  try {
    OV = await getJSON("data/overview.json");
  } catch (e) {
    $app.innerHTML = `<div class="card"><h3>Noch keine Daten</h3><p class="muted">Die Datei <code>data/overview.json</code> fehlt. Der erste automatische Lauf hat vermutlich noch nicht stattgefunden.</p></div>`;
    return;
  }
  try { INV = await getJSON("data/investoren.json"); } catch { INV = null; }
  document.getElementById("stand").textContent = "Stand: " + new Date(OV.aktualisiert).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) +
    (OV.fehler && OV.fehler.length ? ` · ${OV.fehler.length} Werte nicht geladen: ${OV.fehler.map((f) => f.symbol).join(", ")}` : "");
  addEventListener("hashchange", route);
  route();
}

init();
