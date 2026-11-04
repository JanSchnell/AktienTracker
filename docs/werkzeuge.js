"use strict";

// Preisalarme, Aktienvergleich, KGV-Einschätzung sowie Menü und Suche.

const SEKTOR_DE = {
  "Technology": "Technologie", "Financial Services": "Finanzen", "Healthcare": "Gesundheit", "Consumer Cyclical": "Konsum (zyklisch)",
  "Consumer Defensive": "Konsum (Basisgüter)", "Industrials": "Industrie", "Energy": "Energie", "Basic Materials": "Rohstoffe",
  "Communication Services": "Medien & Telekom", "Utilities": "Versorger", "Real Estate": "Immobilien",
};
const zahl = (v) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? null : n; };

// ------------------------------------------------------------ Preisalarme

const alleAlarme = () => (OV.alarme || []);
const aktiveAlarme = (sym) => alleAlarme().filter((a) => a.symbol === sym && !a.ausgeloest);
const ALARM_ARTEN = [
  ["kurs_unter", "Kurs fällt auf …", "Kurs"],
  ["fall_heute", "Kurs fällt um … % ab heute", "Prozent"],
  ["rueckgang_ath", "Kurs liegt … % unter Allzeithoch", "Prozent"],
  ["kurs_ueber", "Kurs steigt auf …", "Kurs"],
];
function alarmBeschreibung(a, cur) {
  if (a.art === "kurs_unter") return `Kurs fällt auf ${fmt(a.wert)} ${cur}`;
  if (a.art === "kurs_ueber") return `Kurs steigt auf ${fmt(a.wert)} ${cur}`;
  return `Kurs ${fmt(a.wert, 0)} % unter Allzeithoch`;
}

function alarmDialog(w) {
  const cur = w.waehrung || "";
  const dlg = document.createElement("dialog");
  dlg.className = "dlg";
  dlg.innerHTML = `<h3>Preisalarm für ${esc(w.name)}</h3>
    <p class="small muted" style="margin:0 0 10px">Aktuell ${fmt(w.kurs)} ${esc(cur)}, ${fmt(w.rueckgang_ath, 0)} % unter dem Allzeithoch.</p>
    <div class="form alarm-form">
      <label>Wann möchtest du benachrichtigt werden?<select id="aArt">${ALARM_ARTEN.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <label><span id="aWertLabel">Kurs in ${esc(cur)}</span><input id="aWert" inputmode="decimal" autocomplete="off"></label>
      <label>Notiz für dich (optional)<input id="aNotiz" maxlength="200" placeholder="z. B. Hier würde ich nachkaufen wollen"></label>
    </div>
    <p class="small" id="aInfo" style="margin:8px 0 0"></p>
    <p class="muted small" style="margin:8px 0 0">Es öffnet sich GitHub, dort nur noch auf „Create“ tippen. Nach ca. 5 Minuten ist der Alarm aktiv. Dein GitHub-Projekt ist öffentlich, also sind Alarm und Notiz dort einsehbar.</p>
    <div class="dlg-actions"><button class="chip on" id="aGo">Weiter zu GitHub →</button><button class="chip" id="aZu">Abbrechen</button></div>`;
  document.body.appendChild(dlg);
  const el = (id) => dlg.querySelector("#" + id);
  const zu = () => { dlg.close(); dlg.remove(); };
  // Liefert den zu speichernden Alarm oder eine Fehlermeldung
  const pruefe = () => {
    const art = el("aArt").value, v = zahl(el("aWert").value);
    if (!(v > 0)) return { fehler: "" };
    if (art === "kurs_unter" && v >= w.kurs) return { fehler: `Der Kurs liegt schon bei ${fmt(w.kurs)} ${cur}. Trage einen niedrigeren Wert ein.` };
    if (art === "kurs_ueber" && v <= w.kurs) return { fehler: `Der Kurs liegt schon bei ${fmt(w.kurs)} ${cur}. Trage einen höheren Wert ein.` };
    if (art !== "kurs_unter" && art !== "kurs_ueber" && v >= 100) return { fehler: "Bitte einen Wert unter 100 % eintragen." };
    if (art === "rueckgang_ath" && v <= w.rueckgang_ath) return { fehler: `Der Kurs liegt schon ${fmt(w.rueckgang_ath, 0)} % unter dem Hoch. Trage einen höheren Wert ein.` };
    if (art === "fall_heute") {
      const ziel = Math.round(w.kurs * (1 - v / 100) * 100) / 100;
      return { art: "kurs_unter", wert: ziel, info: `Das entspricht einem Kurs von ${fmt(ziel)} ${cur}.` };
    }
    if (art === "rueckgang_ath") return { art, wert: v, info: `Das entspricht heute einem Kurs von etwa ${fmt(w.ath * (1 - v / 100))} ${cur}. Steigt das Hoch, steigt auch diese Grenze.` };
    return { art, wert: v, info: `Das sind ${fmtPct((v / w.kurs - 1) * 100)} gegenüber heute.` };
  };
  const zeige = () => { const r = pruefe(); el("aInfo").textContent = r.fehler ?? r.info; el("aInfo").className = "small" + (r.fehler ? " neg" : ""); };
  el("aArt").addEventListener("change", () => {
    const eintrag = ALARM_ARTEN.find(([k]) => k === el("aArt").value);
    el("aWertLabel").textContent = eintrag[2] === "Prozent" ? "Prozent" : `Kurs in ${cur}`;
    zeige();
  });
  el("aWert").addEventListener("input", zeige);
  el("aZu").addEventListener("click", zu);
  el("aGo").addEventListener("click", () => {
    const r = pruefe();
    if (r.fehler !== undefined) { el("aInfo").textContent = r.fehler || "Bitte einen Wert eintragen."; el("aInfo").className = "small neg"; el("aWert").focus(); return; }
    const notiz = el("aNotiz").value.replace(/\s+/g, " ").trim();
    window.open(issueUrl(`Alarm: ${w.name} (${alarmBeschreibung(r, cur)})`, ["aktion: alarm_neu", `symbol: ${w.symbol}`, `art: ${r.art}`, `wert: ${r.wert}`, `notiz: ${notiz}`]), "_blank", "noopener");
    zu();
  });
  dlg.showModal();
  el("aWert").focus();
}

function renderAlarme() {
  const info = (a) => OV.werte.find((w) => w.symbol === a.symbol);
  const aktiv = alleAlarme().filter((a) => !a.ausgeloest && info(a));
  const fertig = alleAlarme().filter((a) => a.ausgeloest && info(a)).slice().reverse();
  const loeschen = (a) => `<a class="x-btn" title="Alarm löschen" aria-label="Alarm löschen" target="_blank" rel="noopener" href="${issueUrl(`Alarm: löschen ${a.symbol}`, ["aktion: alarm_loeschen", `id: ${a.id}`])}">✕</a>`;
  const abstand = (a, w) => {
    if (a.art === "rueckgang_ath") return `aktuell ${fmt(w.rueckgang_ath, 0)} %`;
    return `noch ${fmtPct((a.wert / w.kurs - 1) * 100)}`;
  };
  const optionen = [...OV.werte].sort((x, y) => x.name.localeCompare(y.name, "de")).map((w) => `<option value="${esc(w.symbol)}">${esc(w.name)}</option>`).join("");
  $app.innerHTML = `<div class="prose">
    <h1>Preisalarme</h1>
    <p class="muted">Lege selbst fest, wann du sofort per Telegram eine Nachricht bekommst. Jeder Alarm meldet sich nur einmal. Alles andere kommt gesammelt im Wochenbericht am Sonntag.</p>
    <div class="form" style="margin-bottom:12px"><label>Neuer Alarm für<select id="neuWert"><option value="">Wert auswählen …</option>${optionen}</select></label></div>
    ${aktiv.length ? `<div class="tbl-wrap"><table class="plain alarm-tab"><thead><tr><th>Wert</th><th>Alarm</th><th>Abstand</th><th class="x-col"></th></tr></thead><tbody>
      ${aktiv.map((a) => { const w = info(a); return `<tr><td><a href="#/wert/${encodeURIComponent(a.symbol)}">${esc(w.name)}</a>${a.notiz ? `<div class="sym">${esc(a.notiz)}</div>` : ""}</td>
        <td>${esc(alarmBeschreibung(a, w.waehrung || ""))}</td><td>${abstand(a, w)}</td><td class="x-col">${loeschen(a)}</td></tr>`; }).join("")}
    </tbody></table></div>` : `<div class="card muted small">Noch keine aktiven Alarme.</div>`}
    ${fertig.length ? `<h2>Bereits ausgelöst</h2><div class="tbl-wrap"><table class="plain alarm-tab"><thead><tr><th>Wert</th><th>Alarm</th><th>Ausgelöst</th><th class="x-col"></th></tr></thead><tbody>
      ${fertig.map((a) => { const w = info(a); return `<tr><td><a href="#/wert/${encodeURIComponent(a.symbol)}">${esc(w.name)}</a></td><td>${esc(alarmBeschreibung(a, w.waehrung || ""))}</td><td>${date(a.ausgeloest)}</td><td class="x-col">${loeschen(a)}</td></tr>`; }).join("")}
    </tbody></table></div>` : ""}
    <p class="muted small">Geprüft wird bei jedem automatischen Lauf, also viermal an Handelstagen. Die Nachricht kann daher einige Stunden später kommen als die Kursbewegung. Es zählen auch das Tagestief und Tageshoch. Löschen öffnet GitHub, dort auf „Create“ tippen. Das Tool kauft und verkauft nichts.</p>
  </div>`;
  document.getElementById("neuWert").addEventListener("change", (ev) => {
    const w = OV.werte.find((x) => x.symbol === ev.target.value);
    if (w) alarmDialog(w);
    ev.target.value = "";
  });
}

// ------------------------------------------------------------ Aktienvergleich

const VERGLEICH_ZEILEN = (cur) => [
  { label: "Branche", text: (d) => (d.f ? d.f.branche : "ETF") || "–" },
  { label: term("marktkap", "Börsenwert in €"), wert: (d) => (d.f && d.f.marktkap && OV.fx ? d.f.marktkap * (OV.fx[d.w.waehrung] || NaN) : null), zeige: (v) => big(v) + " €" },
  { label: term("kgv_erw", "KGV erwartet"), wert: (d) => d.f && d.f.kgv_erwartet, zeige: (v) => fmt(v, 1), besser: "tief", nurPositiv: true },
  { label: term("peg", "PEG"), wert: (d) => d.f && d.f.peg, zeige: (v) => fmt(v, 2), besser: "tief", nurPositiv: true },
  { label: term("kuv", "KUV"), wert: (d) => d.f && d.f.kuv, zeige: (v) => fmt(v, 1), besser: "tief", nurPositiv: true },
  { label: term("fcf_rendite", "Free-Cashflow-Rendite"), wert: (d) => d.f && fcfRendite(d.f, d.w.waehrung), zeige: (v) => fmt(v, 1) + " %", besser: "hoch" },
  { label: term("jj", "Umsatzwachstum"), wert: (d) => d.f && d.f.umsatzwachstum != null ? d.f.umsatzwachstum * 100 : null, zeige: (v) => fmtPct(v), besser: "hoch" },
  { label: term("gewinnwachstum", "Gewinnwachstum"), wert: (d) => d.f && d.f.gewinnwachstum != null ? d.f.gewinnwachstum * 100 : null, zeige: (v) => fmtPct(v), besser: "hoch" },
  { label: term("bruttomarge", "Bruttomarge"), wert: (d) => d.f && d.f.bruttomarge != null ? d.f.bruttomarge * 100 : null, zeige: (v) => fmt(v, 0) + " %", besser: "hoch" },
  { label: term("op_marge", "Operative Marge"), wert: (d) => d.f && d.f.operative_marge != null ? d.f.operative_marge * 100 : null, zeige: (v) => fmt(v, 0) + " %", besser: "hoch" },
  { label: term("ekr", "Eigenkapitalrendite"), wert: (d) => d.f && d.f.eigenkapitalrendite != null ? d.f.eigenkapitalrendite * 100 : null, zeige: (v) => fmt(v, 0) + " %", besser: "hoch" },
  { label: term("dividende", "Dividendenrendite"), wert: (d) => d.f && d.f.dividendenrendite, zeige: (v) => fmt(v, 2) + " %" },
  { label: term("ebitda", "Nettoschulden ÷ EBITDA"), wert: (d) => (d.f && d.f.schulden != null && d.f.cash != null && d.f.ebitda > 0 ? (d.f.schulden - d.f.cash) / d.f.ebitda : null), zeige: (v) => (v <= 0 ? "Nettocash" : fmt(v, 1) + "×"), besser: "tief" },
  { label: term("ath", "Rückgang vom Allzeithoch"), wert: (d) => -d.w.rueckgang_ath, zeige: (v) => fmtPct(v) },
  { label: "Kurs 1 Jahr", wert: (d) => d.w.perf_1j, zeige: (v) => fmtPct(v, 0), besser: "hoch" },
  { label: "Kurs 5 Jahre", wert: (d) => d.w.perf_5j, zeige: (v) => fmtPct(v, 0), besser: "hoch" },
  { label: term("score", "Daten-Score"), wert: (d) => d.w.screen && d.w.screen.score, zeige: (v) => fmt(v, 0), besser: "hoch" },
  { label: term("konsens", "Analysten-Konsens"), text: (d) => (d.f && EMPFEHLUNG[d.f.analysten_empfehlung]) || "–" },
];

let vergleichChart = null;
function zeichneVergleich(a, b, range) {
  if (vergleichChart) { vergleichChart.destroy(); charts = charts.filter((c) => c !== vergleichChart); }
  $app.querySelectorAll("[data-vr]").forEach((x) => x.classList.toggle("on", x.dataset.vr === range));
  const pa = rangePoints(a.historie, range), pb = new Map(rangePoints(b.historie, range));
  const gemeinsam = pa.filter((p) => pb.has(p[0]));
  if (!gemeinsam.length) return;
  const basisA = gemeinsam[0][1], basisB = pb.get(gemeinsam[0][0]);
  chartDefaults();
  const serie = (d, data, farbe) => ({ label: d.item.name, data, borderColor: farbe, backgroundColor: farbe, borderWidth: 2, pointRadius: 0, tension: 0.1 });
  const kurz = ["1W", "1M", "6M"].includes(range);
  vergleichChart = new Chart(document.getElementById("cVergleich"), {
    type: "line",
    data: { labels: gemeinsam.map((p) => p[0]), datasets: [
      serie(a, gemeinsam.map((p) => (p[1] / basisA - 1) * 100), css("--accent")),
      serie(b, gemeinsam.map((p) => (pb.get(p[0]) / basisB - 1) * 100), css("--bar")),
    ] },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 18, boxHeight: 2 } },
        tooltip: { callbacks: { title: (it) => date(it[0].label), label: (it) => `${it.dataset.label}: ${fmtPct(it.parsed.y)}` } } },
      scales: {
        x: { ticks: { maxTicksLimit: 7, callback(v) { const l = this.getLabelForValue(v); return kurz ? l.slice(8, 10) + "." + l.slice(5, 7) + "." : range === "1J" ? l.slice(5, 7) + "/" + l.slice(2, 4) : l.slice(0, 4); } }, grid: { display: false } },
        y: { ticks: { callback: (v) => fmt(v, 0) + " %" } },
      },
    },
  });
  charts.push(vergleichChart);
}

async function renderVergleich(symA, symB) {
  const optionen = (sel) => `<option value="">auswählen …</option>` + [...OV.werte].sort((x, y) => x.name.localeCompare(y.name, "de"))
    .map((w) => `<option value="${esc(w.symbol)}" ${w.symbol === sel ? "selected" : ""}>${esc(w.name)}</option>`).join("");
  $app.innerHTML = `
    <h1>Aktien vergleichen</h1>
    <div class="vergleich-wahl">
      <select id="vA" aria-label="Erster Wert">${optionen(symA)}</select><span class="muted">gegen</span><select id="vB" aria-label="Zweiter Wert">${optionen(symB)}</select>
    </div>
    <div id="vErgebnis"><p class="muted">Wähle zwei Werte aus deiner Watchlist. Ideen aus „Entdecken“ nimmst du dafür zuerst in die Watchlist auf.</p></div>`;
  const wechsel = () => { location.hash = `#/vergleich/${encodeURIComponent(document.getElementById("vA").value)}/${encodeURIComponent(document.getElementById("vB").value)}`; };
  document.getElementById("vA").addEventListener("change", wechsel);
  document.getElementById("vB").addEventListener("change", wechsel);
  if (!symA || !symB) return;
  let a, b;
  try { [a, b] = await Promise.all([symA, symB].map((s) => getJSON("data/werte/" + safe(s) + ".json"))); }
  catch { document.getElementById("vErgebnis").innerHTML = `<p>Daten konnten nicht geladen werden.</p>`; return; }
  const da = { w: a.item, f: a.fundamentaldaten }, db = { w: b.item, f: b.fundamentaldaten };
  const zeilen = VERGLEICH_ZEILEN().map((z) => {
    if (z.text) return `<tr><td>${z.label}</td><td class="wrap-rechts">${esc(z.text(da))}</td><td class="wrap-rechts">${esc(z.text(db))}</td></tr>`;
    const x = z.wert(da), y = z.wert(db);
    const ok = (v) => v != null && !isNaN(v) && (!z.nurPositiv || v > 0);
    const xs = ok(x) ? z.zeige(x) : "–", ys = ok(y) ? z.zeige(y) : "–";
    const vorn = z.besser && ok(x) && ok(y) && x !== y ? ((x > y) === (z.besser === "hoch") ? "x" : "y") : null;
    return `<tr><td>${z.label}</td><td class="${vorn === "x" ? "vorn" : ""}">${xs}</td><td class="${vorn === "y" ? "vorn" : ""}">${ys}</td></tr>`;
  }).join("");
  document.getElementById("vErgebnis").innerHTML = `
    <div class="card">
      <div class="ranges">${RANGES.map(([r]) => `<button class="chip" data-vr="${r}">${r}</button>`).join("")}</div>
      <div class="chart-box"><canvas id="cVergleich"></canvas></div>
      <p class="muted small" style="margin:8px 0 0">Kursentwicklung in Prozent ab Beginn des Zeitraums, jeweils in Handelswährung und ohne Dividenden.</p>
    </div>
    <div class="tbl-wrap" style="margin-top:12px"><table class="plain"><thead><tr><th>Kennzahl</th><th><a href="#/wert/${encodeURIComponent(symA)}">${esc(a.item.name)}</a></th><th><a href="#/wert/${encodeURIComponent(symB)}">${esc(b.item.name)}</a></th></tr></thead>
      <tbody>${zeilen}</tbody></table></div>
    <p class="muted small">Fett = in dieser Zeile rechnerisch der günstigere oder stärkere Wert. Das ist kein Gesamturteil, und Firmen aus verschiedenen Branchen sind nur bedingt vergleichbar.</p>`;
  zeichneVergleich(a, b, gueltigerRange(store.get("range", "1J")));
  $app.querySelectorAll("[data-vr]").forEach((x) => x.addEventListener("click", () => zeichneVergleich(a, b, x.dataset.vr)));
}

// ------------------------------------------------------------ Einschätzung des KGV

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const KGV_STUFEN = [[4, "auffällig niedrig", "gelb"], [15, "niedrig", "gruen"], [25, "üblich", "gruen"], [40, "hoch", "gelb"], [Infinity, "sehr hoch", "rot"]];
const kgvUrteil = (v) => (v > 0 ? KGV_STUFEN.find(([g]) => v < g) : null);

function kgvBox(f) {
  const kgv = f.kgv_erwartet > 0 ? f.kgv_erwartet : f.kgv > 0 ? f.kgv : null;
  if (!kgv) return `<div class="card kgv-box"><h3>Ist das KGV hoch?</h3><p class="small" style="margin:0">Hier gibt es kein sinnvolles KGV, weil aktuell oder für das nächste Jahr Verluste erwartet werden. Der Blick auf ${term("kuv", "KUV")} und ${term("fcf", "Free Cashflow")} hilft dann eher.</p></div>`;
  const u = kgvUrteil(kgv);
  const vergleich = (ENT ? ENT.werte : []).filter((x) => x.m && x.m.kgv_erwartet >= 4 && x.m.kgv_erwartet < 200);
  const alle = median(vergleich.map((x) => x.m.kgv_erwartet));
  const branche = vergleich.filter((x) => x.sektor && x.sektor === f.sektor);
  const bm = branche.length >= 5 ? median(branche.map((x) => x.m.kgv_erwartet)) : null;
  const pos = Math.min(100, kgv / 60 * 100);
  const noetig = kgv > 20 ? ((kgv / 20) ** (1 / 5) - 1) * 100 : null;
  const aktuell = f.gewinnwachstum != null ? f.gewinnwachstum * 100 : null;
  const pegText = f.peg > 0 ? (f.peg < 1 ? "für das erwartete Wachstum eher günstig" : f.peg < 2 ? "im Verhältnis zum Wachstum etwa fair" : "selbst für das erwartete Wachstum eher teuer") : null;
  return `<div class="card kgv-box">
    <div class="kgv-kopf"><h3>Ist das KGV hoch?</h3><span class="kgv-urteil"><span class="dot ${u[2]}"></span> ${fmt(kgv, 1)}: ${u[1]}</span></div>
    <div class="kgv-skala" aria-hidden="true"><i class="s1"></i><i class="s2"></i><i class="s3"></i><i class="s4"></i><b style="left:${pos}%"></b></div>
    <div class="kgv-labels small muted"><span>0</span><span style="left:25%">15</span><span style="left:41.7%">25</span><span style="left:66.7%">40</span><span style="left:100%">60+</span></div>
    <ul class="clean small">
      <li><strong>In Worten:</strong> Du zahlst heute etwa ${fmt(kgv, 0)} erwartete Jahresgewinne. Blieben die Gewinne gleich, entspräche das rund ${fmt(100 / kgv, 1)} % Gewinn pro Jahr auf den Kaufpreis.</li>
      ${alle ? `<li><strong>Vergleich:</strong> Der mittlere Wert aller hier beobachteten Aktien liegt bei ${fmt(alle, 0)}${bm ? `, in der Branche ${esc(SEKTOR_DE[f.sektor] || f.sektor)} bei ${fmt(bm, 0)}` : ""}.</li>` : ""}
      ${pegText ? `<li><strong>Wachstum:</strong> ${term("peg", "PEG")} ${fmt(f.peg, 2)}, also ${pegText}.</li>` : ""}
      ${noetig ? `<li><strong>Was eintreten müsste:</strong> Damit das KGV bei gleichem Kurs in 5 Jahren bei 20 liegt, müsste der Gewinn um etwa ${fmt(noetig, 0)} % pro Jahr steigen.${aktuell != null ? ` Zuletzt lag das Gewinnwachstum bei ${fmtPct(aktuell, 0)}.` : ""}</li>`
        : `<li><strong>Einordnung:</strong> Ein niedriges KGV kann günstig sein oder bedeuten, dass der Markt mit sinkenden Gewinnen rechnet. Prüfe, was dahintersteckt.</li>`}
    </ul>
    <p class="small muted" style="margin:8px 0 0">Ein hohes KGV schließt eine gute Aktie nicht aus, es bedeutet aber, dass hohe Erwartungen eintreten müssen. Bewertungsgrenzen sind Faustregeln, keine Kaufsignale. ${f.sektor === "Financial Services" ? "Bei Banken und Versicherungen sind eher niedrige Werte üblich." : ""}</p>
  </div>`;
}

// ------------------------------------------------------------ Menü und Suche

function setupNav() {
  const btn = document.getElementById("mehrBtn"), menu = document.getElementById("mehrMenu");
  btn.addEventListener("click", (ev) => { ev.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); });
  document.addEventListener("click", () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); });

  const sBtn = document.getElementById("suchBtn"), panel = document.getElementById("suchPanel"), input = document.getElementById("suchFeld"), liste = document.getElementById("suchListe");
  const schliessen = () => { panel.hidden = true; input.value = ""; liste.innerHTML = ""; };
  sBtn.addEventListener("click", () => { panel.hidden = !panel.hidden; if (!panel.hidden) input.focus(); else schliessen(); });
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { liste.innerHTML = ""; return; }
    const ideen = ENT ? ENT.werte.filter((x) => !x.in_watchlist) : [];
    const treffer = [...OV.werte, ...ideen].filter((w) => [w.name, w.symbol, w.langname, w.kategorie, w.branche].join(" ").toLowerCase().includes(q)).slice(0, 8);
    liste.innerHTML = treffer.map((w) => OV.werte.includes(w)
      ? `<a href="#/wert/${encodeURIComponent(w.symbol)}"><strong>${esc(w.name)}</strong> <span class="sym">${esc(w.symbol)} · ${esc(w.kategorie)}</span></a>`
      : `<a href="#/entdecken" data-idee="${esc(w.name)}"><strong>${esc(w.name)}</strong> <span class="sym">Idee in „Entdecken“ · ${esc(w.kategorie)}</span></a>`).join("") || `<div class="muted small" style="padding:8px">Keine Treffer. Über „Wert hinzufügen“ in der Übersicht lässt sich jede Aktie aufnehmen.</div>`;
  });
  liste.addEventListener("click", (ev) => {
    const a = ev.target.closest("a");
    if (!a) return;
    if (a.dataset.idee) { entState.q = a.dataset.idee; entState.nurNeu = false; if (location.hash === "#/entdecken") renderEntdecken(); }
    schliessen();
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") schliessen(); });
}
