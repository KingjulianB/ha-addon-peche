"use strict";
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (id) => document.getElementById(id);

  let state = { trips: [], tracks: [], settings: {}, curTrack: null, openId: null, nemo: false };

  /* ---------- helpers ---------- */
  const fcfa = (n) => Math.round(n || 0).toLocaleString("fr-FR");
  const kg1 = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString("fr-FR");
  const frDate = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    const mo = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
    return `${+d} ${mo[+m - 1]}`;
  };
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tripKg = (t) => (t.prises || []).reduce((s, p) => s + (+p.kg || 0), 0);
  const tripCA = (t) => (t.prises || []).reduce((s, p) => s + (+p.kg || 0) * (+p.prix || 0), 0);

  function S() {
    const s = state.settings;
    return {
      lat: +s.zone_lat || -0.72, lon: +s.zone_lon || 8.78,
      radius: +s.zone_radius || 15, span: +s.map_span || 60,
    };
  }
  function fuelForHours(h, distKm) {
    const s = state.settings;
    const conso = +s.fuel_conso || 7, prix = +s.fuel_prix || 700;
    const liters = (s.fuel_mode === "dist") ? conso * distKm / 100 : conso * h;
    return liters * prix;
  }
  function toast(msg) {
    let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1600);
  }

  /* ---------- login ---------- */
  async function tryLogin(pw) {
    const ok = await API.login(pw);
    if (!ok) { el("loginErr").hidden = false; el("loginErr").textContent = "Mot de passe incorrect."; return; }
    API.setKey(pw);
    el("login").hidden = true; el("app").hidden = false;
    boot();
  }
  el("loginBtn").addEventListener("click", () => tryLogin(el("pw").value));
  el("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(el("pw").value); });

  /* ---------- boot ---------- */
  async function boot() {
    try {
      const [trips, tracks, settings, nemo] = await Promise.all([
        API.trips(), API.tracks(), API.settings(), API.nemoStatus().catch(() => ({ configured: false })),
      ]);
      state.trips = trips; state.tracks = tracks; state.settings = settings; state.nemo = nemo.configured;
      if (tracks[0]) state.curTrack = await API.track(tracks[0].id);
      renderHead();
      renderTab("journal");
    } catch (e) {
      // clé invalide → retour login
      el("app").hidden = true; el("login").hidden = false;
      el("loginErr").hidden = false; el("loginErr").textContent = e.message;
    }
  }
  if (API.hasKey()) { el("login").hidden = true; el("app").hidden = false; boot(); }

  function renderHead() {
    el("hBoat").textContent = `Pirogue ${state.settings.boat_id || "—"} · Port‑Gentil`;
    const d = new Date();
    const oneJan = new Date(d.getFullYear(), 0, 1);
    const wk = Math.ceil((((d - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
    el("hWeek").textContent = `Semaine ${wk} · ${d.getFullYear()}`;
    const n = el("hNemo");
    n.className = "nemo" + (state.nemo ? "" : " off");
    el("nemoTxt").textContent = state.nemo ? "NEMO connecté" : "NEMO non relié";
  }

  /* ---------- tabs ---------- */
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      renderTab(t.dataset.tab);
    })
  );

  function renderTab(name) {
    const v = el("view");
    if (name === "journal") return renderJournal(v);
    if (name === "carte") return renderCarte(v);
    if (name === "controle") return renderControle(v);
    if (name === "saisie") return renderSaisie(v);
    if (name === "reglages") return renderReglages(v);
  }

  /* ================= JOURNAL ================= */
  function renderJournal(v) {
    const trips = state.trips.slice().sort((a, b) => (b.date + (b.depart || "")).localeCompare(a.date + (a.depart || "")));
    const last = trips[0];
    const crew = safeArr(state.settings.crew);

    // bilan de la semaine (7 derniers jours enregistrés)
    const wk = trips.slice(0, 7);
    const tK = wk.reduce((s, t) => s + tripKg(t), 0);
    const tCA = wk.reduce((s, t) => s + tripCA(t), 0);
    const tFuel = tracksFuelForTrips(wk);
    const tDist = wk.reduce((s, t) => s + trackDistForTrip(t), 0);

    // anomalies : traces sans déclaration le même jour
    const anomalies = state.tracks.filter((tr) => !trips.some((t) => t.date === tr.date));

    if (!last) {
      v.innerHTML = `<div class="split"><div class="min0"><div class="empty">Aucune sortie enregistrée.<br>Ouvrez « Nouvelle sortie » pour commencer.</div></div></div>`;
      return;
    }

    v.innerHTML = `
      <div class="split">
        <div class="min0">
          <section class="hero">
            <div class="hero-top">
              <p class="eyebrow">Dernière sortie enregistrée</p>
              <span class="num muted" style="font-size:12.5px">${frDate(last.date)} · ${esc(last.depart || "")}${last.retour ? "–" + esc(last.retour) : ""}</span>
            </div>
            <div class="hero-body">
              <div>
                <div class="fr big num">${kg1(tripKg(last))}<small class="fr">kg</small></div>
                <p class="muted" style="font-size:13px;margin:10px 0 0">${esc(last.zone || "—")}${last.crew && last.crew.length ? " · " + last.crew.map(esc).join(", ") : ""}</p>
              </div>
              <div class="figs">
                <div class="fig"><div class="v num">${fcfa(tripCA(last))}<small>FCFA</small></div><div class="l">Valeur</div></div>
                <div class="fig"><div class="v num">${kg1(trackDistForTrip(last))}<small>km</small></div><div class="l">Distance</div></div>
              </div>
            </div>
            <div style="margin-top:28px">
              ${(last.prises || []).map((p) => `
                <div class="catch-row">
                  <span class="esp">${esc(p.esp)}</span>
                  <span class="kg num">${kg1(p.kg)} kg</span>
                  <span class="pu num">${fcfa(p.prix)} / kg</span>
                  <span class="tot num">${fcfa((+p.kg) * (+p.prix))}</span>
                </div>`).join("")}
            </div>
          </section>

          <section style="padding-top:32px">
            <p class="eyebrow" style="margin-bottom:6px">Sorties précédentes</p>
            <ul style="list-style:none;padding:0;margin:0" id="tripList">
              ${trips.slice(1).map(tripRow).join("") || `<li class="muted" style="padding:14px 0;font-size:14px">Aucune autre sortie.</li>`}
            </ul>
          </section>
        </div>

        <aside class="aside min0">
          ${anomalies.map((a) => `
            <div class="alert">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <span class="t">Sortie non déclarée</span><span class="when num">${frDate(a.date)}</span>
              </div>
              <p>La balise a relevé <span class="num" style="color:var(--ink)">${kg1(a.dist_km)} km</span> parcourus${a.depart ? " (" + esc(a.depart) + (a.retour ? "–" + esc(a.retour) : "") + ")" : ""} sans capture consignée. À vérifier auprès de l'équipage.</p>
            </div>`).join("")}

          <div class="stat-hd stat">
            <h3>Cette semaine</h3>
            <div class="row"><div class="fr v num">${kg1(tK)}<small>kg</small></div><div class="l">Poissons pêchés</div></div>
            <div class="row"><div class="fr v num">${fcfa(tCA)}<small>FCFA</small></div><div class="l">Chiffre d'affaires</div></div>
            <div class="grid2">
              <div class="row"><div class="fr v sm num">${wk.length}</div><div class="l">Sorties</div></div>
              <div class="row"><div class="fr v sm num">${kg1(tDist)}<small>km</small></div><div class="l">Distance</div></div>
              <div class="row"><div class="fr v sm num">${fcfa(tFuel)}<small>FCFA</small></div><div class="l">Carburant</div></div>
              <div class="row"><div class="fr v sm acc num">${fcfa(tCA - tFuel)}<small>FCFA</small></div><div class="l">Marge nette</div></div>
            </div>
          </div>

          <div class="crew-hd">
            <h3 class="stat" style="margin:0 0 12px;font-size:12.5px;color:var(--ink-faint)">Présence équipage</h3>
            ${crew.map((name) => {
              const n = wk.filter((t) => (t.crew || []).includes(name)).length;
              return `<div class="crew-row">
                <span class="n">${esc(name)}</span>
                <span class="crew-bars">${wk.map((t) => `<span class="${(t.crew || []).includes(name) ? "on" : ""}"></span>`).join("")}</span>
                <span class="c num">${n}/${wk.length}</span>
              </div>`;
            }).join("")}
          </div>

          <button class="cta" id="goSaisie">Enregistrer une sortie</button>
          <p class="foot-note">Les captures se recoupent avec les traces de la balise NEMO dans l'onglet Contrôle.</p>
        </aside>
      </div>`;

    el("goSaisie").addEventListener("click", () => { document.querySelector('.tab[data-tab="saisie"]').click(); });
    v.querySelectorAll(".trip-btn").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.id;
      state.openId = state.openId === id ? null : id;
      renderJournal(v);
    }));
  }

  function tripRow(t) {
    const open = state.openId === t.id;
    return `<li class="trip">
      <button class="trip-btn" data-id="${t.id}">
        <span class="fr d num">${frDate(t.date)}</span>
        <span class="fr k num">${kg1(tripKg(t))}<small> kg</small></span>
        <span class="z">${esc(t.zone || "—")}</span>
        <span class="ca num">${fcfa(tripCA(t))} FCFA</span>
        <span class="chev ${open ? "open" : ""}">›</span>
      </button>
      ${open ? tripDetail(t) : ""}
    </li>`;
  }
  function tripDetail(t) {
    return `<div class="trip-detail">
      <div class="trip-meta">
        ${t.depart ? `<span>${esc(t.depart)}${t.retour ? "–" + esc(t.retour) : ""}</span>` : ""}
        <span class="num">${kg1(trackDistForTrip(t))} km</span>
        ${t.crew && t.crew.length ? `<span>Équipage : ${t.crew.map(esc).join(", ")}</span>` : ""}
        ${t.par ? `<span>Pesé/saisi : ${esc(t.par)}</span>` : ""}
      </div>
      ${(t.prises || []).map((p) => `
        <div class="catch-row">
          <span class="esp">${esc(p.esp)}</span>
          <span class="kg num">${kg1(p.kg)} kg</span>
          <span class="pu num">${fcfa(p.prix)} / kg</span>
          <span class="tot num">${fcfa((+p.kg) * (+p.prix))}</span>
        </div>`).join("")}
      <button class="btn ghost small" style="margin-top:12px" data-del="${t.id}">Supprimer</button>
    </div>`;
  }
  // délégué pour suppression
  el("view").addEventListener("click", async (e) => {
    const id = e.target.getAttribute?.("data-del");
    if (!id) return;
    if (!confirm("Supprimer cette sortie ?")) return;
    await API.delTrip(id);
    state.trips = state.trips.filter((t) => t.id !== id);
    renderJournal(el("view"));
  });

  // associe une trace du même jour à une sortie (pour la distance)
  function trackDistForTrip(t) {
    const tr = state.tracks.find((x) => x.date === t.date);
    return tr ? tr.dist_km : 0;
  }
  function trackDurForTrip(t) {
    const tr = state.tracks.find((x) => x.date === t.date);
    return tr ? tr.duree_h : 0;
  }
  function tracksFuelForTrips(trips) {
    return trips.reduce((s, t) => s + fuelForHours(trackDurForTrip(t), trackDistForTrip(t)), 0);
  }

  /* ================= CARTE & CARBURANT ================= */
  function renderCarte(v) {
    const tr = state.curTrack;
    const dist = tr ? tr.dist_km : 0;
    const dur = tr ? tr.duree_h : 0;
    v.innerHTML = `
      <div class="map-wrap">
        <div class="kpis">
          <div class="kpi"><div class="fr v num">${tr ? kg1(dist) : "–"}<small>km</small></div><div class="l">Distance</div></div>
          <div class="kpi"><div class="fr v num">${tr ? fcfa(fuelForHours(dur, dist)) : "–"}<small>FCFA</small></div><div class="l">Carburant estimé</div></div>
          <div class="kpi"><div class="fr v num">${tr && dur ? kg1(dur) : "–"}<small>h</small></div><div class="l">Durée en mer</div></div>
          <div class="kpi"><div class="fr v num">${tr ? tr.points.length : "–"}</div><div class="l">Points GPS</div></div>
        </div>
        <canvas id="map"></canvas>
        <div class="legend">
          <span><span class="sw" style="background:#c55a11"></span>Trajet</span>
          <span><span class="sw dot" style="background:#0d5c4a"></span>Départ</span>
          <span><span class="sw dot" style="background:#a8321e"></span>Retour</span>
          <span><span class="sw dot" style="background:rgba(13,92,74,.5)"></span>Zone de pêche</span>
        </div>

        <div style="margin-top:24px">
          <p class="eyebrow" style="margin-bottom:10px">Importer une trace GPS <span class="muted">(export NEMO : GPX / GeoJSON / CSV lat,lon,heure)</span></p>
          <input type="file" id="fileIn" accept=".gpx,.json,.geojson,.csv,.txt" class="form" style="padding:0">
          <label class="muted" style="display:block;font-size:12.5px;margin:14px 0 5px">… ou coller les points (lat,lon,AAAA-MM-JJTHH:MM par ligne)</label>
          <textarea id="pasteIn" rows="4" class="form" placeholder="-0.740,8.700,2026-09-15T05:30&#10;-0.760,8.640,2026-09-15T06:10" style="padding:11px"></textarea>
          <div style="display:flex;gap:10px;margin-top:12px">
            <button class="btn small" id="parseBtn">Analyser</button>
            <button class="btn ghost small" id="demoBtn">Charger une démo</button>
            ${state.nemo ? `<button class="btn small" id="nemoBtn">Synchroniser NEMO</button>` : ""}
          </div>
          <div class="apibox">
            <b>Brancher NEMO :</b> l'accès aux positions passe par l'API de CLS. Écrivez à <code>clsfishingteam@groupcls.com</code> pour la documentation développeur, puis renseignez <code>NEMO_API_URL</code>, <code>NEMO_API_KEY</code>, <code>NEMO_DEVICE_ID</code> et complétez <code>server/nemo.js</code>. La synchronisation s'activera automatiquement ici.
          </div>
        </div>
      </div>`;

    const canvas = el("map");
    const redraw = () => MapView.draw(canvas, S(), state.curTrack);
    redraw();
    window.addEventListener("resize", redraw);

    el("fileIn").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => importText(r.result, f.name);
      r.readAsText(f);
    });
    el("parseBtn").addEventListener("click", () => importText(el("pasteIn").value, "paste.csv"));
    el("demoBtn").addEventListener("click", loadDemo);
    if (state.nemo) el("nemoBtn").addEventListener("click", syncNemo);
  }

  async function importText(txt, name) {
    const pts = parseTrack(txt, name);
    if (pts.length < 2) { toast("Aucun point GPS reconnu."); return; }
    await pushTrack(pts);
  }
  async function pushTrack(points, date) {
    try {
      const r = await API.addTrack({ points, date });
      const full = await API.track(r.id);
      state.tracks.unshift({ id: r.id, date: r.date, dist_km: r.dist_km, duree_h: r.duree_h, source: "manuel" });
      state.curTrack = full;
      toast("Trace enregistrée");
      renderCarte(el("view"));
    } catch (e) { toast(e.message); }
  }
  function loadDemo() {
    const s = S(), base = { lat: s.lat, lon: s.lon }, pts = [], t0 = Date.parse("2026-09-15T05:30:00");
    const kmLat = 111, kmLon = 111 * Math.cos(s.lat * Math.PI / 180);
    const P = (dla, dlo, min) => pts.push({ lat: base.lat + dla / kmLat, lon: base.lon + dlo / kmLon, t: new Date(t0 + min * 60000).toISOString() });
    P(0, 0, 0); P(-4, -6, 25); P(-9, -13, 55); P(-12, -18, 80); P(-11, -22, 110); P(-7, -20, 140); P(-3, -14, 170); P(0, -5, 200); P(0, 0, 225);
    pushTrack(pts, "2026-09-15");
  }
  async function syncNemo() {
    try {
      toast("Synchronisation NEMO…");
      const r = await API.nemoSync({});
      const full = await API.track(r.id);
      state.tracks.unshift({ id: r.id, date: full.date, dist_km: r.dist_km, duree_h: full.duree_h, source: "nemo" });
      state.curTrack = full;
      renderCarte(el("view"));
    } catch (e) { toast(e.message); }
  }

  /* ---- parsers ---- */
  function parseTrack(txt, name) {
    name = (name || "").toLowerCase();
    if (name.includes(".gpx") || txt.includes("<trkpt")) return parseGPX(txt);
    if (name.includes("json") || txt.trim()[0] === "{") return parseGeo(txt);
    return parseCSV(txt);
  }
  function parseGPX(txt) {
    const pts = []; let m;
    const re = /<trkpt[^>]*lat="([-0-9.]+)"[^>]*lon="([-0-9.]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
    while ((m = re.exec(txt))) { const tm = /<time>([^<]+)<\/time>/i.exec(m[3]); pts.push({ lat: +m[1], lon: +m[2], t: tm ? tm[1] : "" }); }
    if (!pts.length) { const re2 = /<trkpt[^>]*lat="([-0-9.]+)"[^>]*lon="([-0-9.]+)"/gi; while ((m = re2.exec(txt))) pts.push({ lat: +m[1], lon: +m[2], t: "" }); }
    return pts;
  }
  function parseGeo(txt) {
    try {
      const j = JSON.parse(txt), pts = [];
      const walk = (c) => c.forEach((x) => Array.isArray(x[0]) ? walk(x) : pts.push({ lat: +x[1], lon: +x[0], t: "" }));
      if (j.type === "FeatureCollection") j.features.forEach((f) => f.geometry && walk(f.geometry.coordinates));
      else if (j.geometry) walk(j.geometry.coordinates);
      else if (j.coordinates) walk(j.coordinates);
      return pts;
    } catch { return []; }
  }
  function parseCSV(txt) {
    const pts = [];
    txt.trim().split(/\r?\n/).forEach((line) => {
      const p = line.split(/[,;\t]/); if (p.length < 2) return;
      const lat = parseFloat(p[0]), lon = parseFloat(p[1]); if (isNaN(lat) || isNaN(lon)) return;
      pts.push({ lat, lon, t: (p[2] || "").trim() });
    });
    return pts;
  }

  /* ================= CONTRÔLE ================= */
  function renderControle(v) {
    const trips = state.trips;
    const tracks = state.tracks.slice().sort((a, b) => b.created_at - a.created_at);
    const trackDays = {}; tracks.forEach((t) => (trackDays[t.date] = true));

    let alerts = 0;
    const rows = tracks.map((tr) => {
      const decl = trips.filter((t) => t.date === tr.date);
      if (!decl.length) {
        alerts++;
        return `<div class="alert"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="t">Sortie détectée non déclarée</span><span class="when num">${frDate(tr.date)}</span></div>
          <p>Le bateau a parcouru <span class="num" style="color:var(--ink)">${kg1(tr.dist_km)} km</span> mais aucune sortie n'est déclarée ce jour.</p></div>`;
      }
      const k = decl.reduce((s, t) => s + tripKg(t), 0);
      return `<div class="ok-badge">✓ ${frDate(tr.date)} — trace VMS (${kg1(tr.dist_km)} km) et déclaration (${kg1(k)} kg) concordent.</div>`;
    });
    const declOnly = trips.filter((t) => !trackDays[t.date]).map((t) =>
      `<div class="info-badge">${frDate(t.date)} — sortie déclarée (${kg1(tripKg(t))} kg) sans trace VMS chargée. Importez la trace pour confirmer.</div>`);

    v.innerHTML = `
      <div class="recon">
        <p class="eyebrow" style="margin-bottom:6px">Recoupement VMS ↔ déclarations</p>
        <p class="muted" style="font-size:13px;margin:0 0 18px;max-width:560px">Chaque trace de la balise est comparée aux sorties déclarées le même jour. Une trace sans déclaration signale une sortie non consignée.</p>
        ${alerts ? `<p class="muted" style="font-size:13px;margin-bottom:10px">${alerts} alerte(s) à vérifier.</p>` : ""}
        ${(rows.join("") + declOnly.join("")) || `<div class="empty">Aucune trace VMS enregistrée. Importez une trace dans l'onglet Carte.</div>`}
      </div>`;
  }

  /* ================= SAISIE ================= */
  function renderSaisie(v) {
    const crew = safeArr(state.settings.crew);
    v.innerHTML = `
      <div class="form">
        <h2 class="fr">Nouvelle sortie</h2>
        <p class="lead">À remplir au retour, après la pesée au débarquement.</p>
        <label>Date</label><input type="date" id="s-date" value="${todayISO()}">
        <div class="two">
          <div><label>Heure départ</label><input type="time" id="s-dep"></div>
          <div><label>Heure retour</label><input type="time" id="s-ret"></div>
        </div>
        <label>Zone de pêche</label><input type="text" id="s-zone" placeholder="ex : Cap Lopez – SO">
        <label>Pêcheurs à bord</label>
        <div id="s-crew">${crew.map((n, i) => `<div class="check"><input type="checkbox" id="cw${i}" checked data-n="${esc(n)}"><label for="cw${i}">${esc(n)}</label></div>`).join("")}</div>

        <div class="divider"></div>
        <label>Captures (espèce · kg · prix FCFA/kg)</label>
        <div id="catches">
          ${catchInput()}
        </div>
        <button class="btn ghost small" id="addCatch" style="margin-top:8px">+ Ajouter une espèce</button>

        <div class="divider"></div>
        <label>Qui a pesé / saisi ? (contrôle)</label><input type="text" id="s-par" placeholder="nom au débarquement">
        <label>Remarque (optionnel)</label><input type="text" id="s-note" placeholder="mer agitée, panne…">
        <div class="warn" id="s-warn" hidden></div>
        <button class="btn" id="s-save">Enregistrer la sortie</button>
      </div>`;

    el("addCatch").addEventListener("click", () => {
      el("catches").insertAdjacentHTML("beforeend", catchInput());
      bindRemovers();
    });
    bindRemovers();
    el("s-save").addEventListener("click", saveTrip);
  }
  function catchInput() {
    return `<div class="catch-input">
      <input placeholder="espèce" data-f="esp">
      <input placeholder="kg" inputmode="decimal" data-f="kg" style="max-width:90px">
      <input placeholder="prix" inputmode="numeric" data-f="prix" style="max-width:90px">
      <button class="rm" title="retirer">✕</button>
    </div>`;
  }
  function bindRemovers() {
    document.querySelectorAll("#catches .rm").forEach((b) => {
      b.onclick = () => { if (document.querySelectorAll("#catches .catch-input").length > 1) b.parentElement.remove(); };
    });
  }
  async function saveTrip() {
    const prises = [];
    document.querySelectorAll("#catches .catch-input").forEach((row) => {
      const esp = row.querySelector('[data-f="esp"]').value.trim();
      const kg = parseFloat(row.querySelector('[data-f="kg"]').value);
      const prix = parseFloat(row.querySelector('[data-f="prix"]').value) || 0;
      if (esp && kg > 0) prises.push({ esp, kg, prix });
    });
    if (!prises.length) { const w = el("s-warn"); w.hidden = false; w.textContent = "Ajoutez au moins une capture (espèce + kg)."; return; }
    const crew = []; document.querySelectorAll('#s-crew input:checked').forEach((c) => crew.push(c.dataset.n));
    const trip = {
      date: el("s-date").value || todayISO(),
      depart: el("s-dep").value, retour: el("s-ret").value,
      zone: el("s-zone").value.trim(), crew, prises,
      par: el("s-par").value.trim(), note: el("s-note").value.trim(),
    };
    try {
      const saved = await API.addTrip(trip);
      state.trips.unshift(saved);
      toast("Sortie enregistrée");
      document.querySelector('.tab[data-tab="journal"]').click();
    } catch (e) { toast(e.message); }
  }

  /* ================= RÉGLAGES ================= */
  function renderReglages(v) {
    const s = state.settings;
    v.innerHTML = `
      <div class="form">
        <h2 class="fr">Réglages</h2>
        <p class="lead">Paramètres du carburant, de la zone et de l'équipage.</p>

        <label>Identifiant de la pirogue</label><input id="r-boat" value="${esc(s.boat_id || "")}">

        <div class="divider"></div>
        <label>Calcul du carburant</label>
        <select id="r-mode">
          <option value="hour" ${s.fuel_mode === "hour" ? "selected" : ""}>Par heure de sortie (L/h)</option>
          <option value="dist" ${s.fuel_mode === "dist" ? "selected" : ""}>Par distance (L/100 km)</option>
        </select>
        <div class="two">
          <div><label>Consommation</label><input id="r-conso" type="number" step="0.5" value="${esc(s.fuel_conso || "7")}"></div>
          <div><label>Prix carburant (FCFA/L)</label><input id="r-prix" type="number" step="10" value="${esc(s.fuel_prix || "700")}"></div>
        </div>
        <p class="hint">Valeur par défaut 7 L/h (hors-bord de pirogue). Relevez votre consommation réelle et corrigez-la ici.</p>

        <div class="divider"></div>
        <label>Zone de pêche (centre)</label>
        <div class="two">
          <div><label>Latitude</label><input id="r-lat" type="number" step="0.01" value="${esc(s.zone_lat || "-0.72")}"></div>
          <div><label>Longitude</label><input id="r-lon" type="number" step="0.01" value="${esc(s.zone_lon || "8.78")}"></div>
        </div>
        <div class="two">
          <div><label>Rayon zone (km)</label><input id="r-rad" type="number" step="1" value="${esc(s.zone_radius || "15")}"></div>
          <div><label>Échelle carte (km)</label><input id="r-span" type="number" step="5" value="${esc(s.map_span || "60")}"></div>
        </div>

        <div class="divider"></div>
        <label>Équipage (un nom par ligne)</label>
        <textarea id="r-crew" rows="4" style="font-family:inherit">${safeArr(s.crew).join("\n")}</textarea>

        <button class="btn" id="r-save">Enregistrer les réglages</button>
      </div>`;

    el("r-save").addEventListener("click", async () => {
      const crew = el("r-crew").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const patch = {
        boat_id: el("r-boat").value.trim(),
        fuel_mode: el("r-mode").value, fuel_conso: el("r-conso").value, fuel_prix: el("r-prix").value,
        zone_lat: el("r-lat").value, zone_lon: el("r-lon").value, zone_radius: el("r-rad").value, map_span: el("r-span").value,
        crew: JSON.stringify(crew),
      };
      try {
        state.settings = await API.saveSettings(patch);
        renderHead();
        toast("Réglages enregistrés");
      } catch (e) { toast(e.message); }
    });
  }

  function safeArr(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } }
})();
