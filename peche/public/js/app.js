"use strict";
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (id) => document.getElementById(id);

  let state = { trips: [], tracks: [], settings: {}, curTrack: null, openId: null, nemo: false, user: null, expenses: [] };
  const isAdmin = () => state.user && state.user.role === "admin";

  // --- Thème clair / sombre ---
  function currentTheme() {
    try { return localStorage.getItem("theme") || "auto"; } catch { return "auto"; }
  }
  function isDark() {
    const t = currentTheme();
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function applyTheme() {
    const t = currentTheme();
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }
  function toggleTheme() {
    const next = isDark() ? "light" : "dark";
    try { localStorage.setItem("theme", next); } catch {}
    applyTheme();
    renderHead(); // met à jour le libellé du bouton
  }
  applyTheme(); // applique au chargement

  // Libellé de dates d'un débarquement : gère les marées pluri-jours + durée.
  function tripDateLabel(t) {
    const dd = t.depart_date || t.date, ad = t.arrivee_date || t.date;
    const dur = t.duree_jours || 1;
    if (dd === ad) {
      return `${frDate(ad)}${t.depart ? " · " + esc(t.depart) : ""}${t.retour ? "–" + esc(t.retour) : ""}`;
    }
    return `${frDate(dd)}${t.depart ? " " + esc(t.depart) : ""} → ${frDate(ad)}${t.retour ? " " + esc(t.retour) : ""} · ${dur} j en mer`;
  }

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
  async function tryLogin() {
    const username = el("usr").value.trim();
    const password = el("pw").value;
    const btn = el("loginBtn");
    el("loginErr").hidden = true;
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>Connexion…';
    try {
      const me = await API.login(username, password);
      state.user = me;
      // Bascule immédiate vers l'appli (fondu), PUIS chargement des données.
      const loginEl = el("login");
      const appEl = el("app");
      loginEl.classList.add("fade-out");
      setTimeout(() => {
        loginEl.hidden = true;
        loginEl.classList.remove("fade-out");
        appEl.hidden = false;
        appEl.classList.add("fade-in");
        setTimeout(() => appEl.classList.remove("fade-in"), 450);
        // remet le bouton dans son état initial pour une prochaine fois
        btn.disabled = false;
        btn.textContent = btn.dataset.label || "Entrer";
      }, 280);
      boot(true); // charge les données en arrière-plan (sans revenir au login si erreur)
    } catch (e) {
      btn.disabled = false;
      btn.textContent = btn.dataset.label || "Entrer";
      el("loginErr").hidden = false; el("loginErr").textContent = e.message;
    }
  }
  el("loginBtn").addEventListener("click", tryLogin);
  el("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(); });
  el("usr").addEventListener("keydown", (e) => { if (e.key === "Enter") el("pw").focus(); });

  /* ---------- boot ---------- */
  // fromLogin=true : on vient de se connecter, ne pas revenir au login en cas
  // d'erreur réseau (on affiche l'appli quand même et on réessaiera).
  async function boot(fromLogin) {
    try {
      const [trips, tracks, settings, nemo] = await Promise.all([
        API.trips(), API.tracks(), API.settings(), API.nemoStatus().catch(() => ({ configured: false })),
      ]);
      state.trips = trips; state.tracks = tracks; state.settings = settings; state.nemo = nemo.configured;
      if (tracks[0]) state.curTrack = await API.track(tracks[0].id);
      applyRoleUI();
      renderHead();
      renderTab("journal");
    } catch (e) {
      if (fromLogin) {
        // La connexion a réussi mais le chargement a échoué : rester dans l'appli.
        applyRoleUI(); renderHead();
        el("view").innerHTML = `<div class="empty">Connexion établie, mais le chargement des données a échoué.<br>${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">Réessayer</button></div>`;
      } else {
        el("app").hidden = true; el("login").hidden = false;
        el("loginErr").hidden = false; el("loginErr").textContent = e.message;
      }
    }
  }

  // Le pêcheur n'a accès qu'au Journal et à la Nouvelle sortie.
  function applyRoleUI() {
    const adminOnly = ["carte", "controle", "depenses", "bilan", "reglages"];
    document.querySelectorAll(".tab").forEach((t) => {
      if (!isAdmin() && adminOnly.includes(t.dataset.tab)) t.style.display = "none";
      else t.style.display = "";
    });
  }

  // Vérifie s'il y a déjà une session active (cookie)
  (async () => {
    try {
      const me = await API.me();
      state.user = me;
      el("login").hidden = true; el("app").hidden = false;
      boot();
    } catch { /* pas connecté : on reste sur le login */ }
  })();

  function renderHead() {
    el("hBoat").textContent = `Pirogue ${state.settings.boat_id || "—"} · Port‑Gentil`;
    const d = new Date();
    const oneJan = new Date(d.getFullYear(), 0, 1);
    const wk = Math.ceil((((d - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
    el("hWeek").textContent = `Semaine ${wk} · ${d.getFullYear()}`;
    const n = el("hNemo");
    n.className = "nemo" + (state.nemo ? "" : " off");
    el("nemoTxt").textContent = state.nemo ? "NEMO connecté" : "NEMO non relié";
    // Utilisateur connecté + déconnexion
    let uInfo = el("hUser");
    if (!uInfo) {
      uInfo = document.createElement("div");
      uInfo.id = "hUser";
      uInfo.style.cssText = "font-size:11.5px;color:var(--ink-faint);margin-top:5px";
      el("hNemo").parentElement.appendChild(uInfo);
    }
    uInfo.innerHTML = `${esc(state.user.username)} (${state.user.role === "admin" ? "admin" : "pêcheur"}) · <button id="themeBtn" style="background:none;border:none;color:var(--lagoon);cursor:pointer;font-size:11.5px;padding:0;text-decoration:underline">${isDark() ? "☀ mode clair" : "🌙 mode sombre"}</button> · <button id="logoutBtn" style="background:none;border:none;color:var(--lagoon);cursor:pointer;font-size:11.5px;padding:0;text-decoration:underline">déconnexion</button>`;
    el("themeBtn").addEventListener("click", toggleTheme);
    el("logoutBtn").addEventListener("click", async () => {
      await API.logout().catch(() => {});
      location.reload();
    });
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
    if (name === "depenses") return renderDepenses(v);
    if (name === "bilan") return renderBilan(v);
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
              <span class="num muted" style="font-size:12.5px">${tripDateLabel(last)}</span>
            </div>
            <div class="hero-body">
              <div>
                <div class="fr big num">${kg1(tripKg(last))}<small class="fr">kg</small></div>
                <p class="muted" style="font-size:13px;margin:10px 0 0">${esc(last.zone || "—")}${last.crew && last.crew.length ? " · " + last.crew.map(esc).join(", ") : ""}</p>
              </div>
              <div class="figs">
                <div class="fig"><div class="v num">${fcfa(tripCA(last))}<small>FCFA</small></div><div class="l">Valeur</div></div>
                <div class="fig"><div class="v num">${kg1(trackDistForTrip(last))}<small>km</small></div><div class="l">Distance</div></div>
                ${isAdmin() && last.depenses != null
                  ? `<div class="fig"><div class="v num" style="color:${(tripCA(last) - last.depenses) >= 0 ? "var(--lagoon)" : "var(--signal)"}">${fcfa(tripCA(last) - last.depenses)}<small>FCFA</small></div><div class="l">Marge nette</div></div>`
                  : ""}
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
            ${last.photo ? `<img src="${API.photoUrl(last.photo)}" alt="photo des prises" loading="lazy" style="margin-top:14px;max-width:220px;border-radius:4px;border:1px solid var(--line)">` : ""}
            ${isAdmin()
              ? `<div style="margin-top:14px;display:flex;gap:8px">
                   <button class="btn ghost small" data-edit="${last.id}">Modifier</button>
                   <button class="btn ghost small" data-del="${last.id}" style="color:var(--signal);border-color:var(--signal)">Supprimer</button>
                 </div>`
              : ""}
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
    const multi = (t.duree_jours || 1) > 1;
    return `<li class="trip">
      <button class="trip-btn" data-id="${t.id}">
        <span class="fr d num">${frDate(t.arrivee_date || t.date)}${multi ? `<br><span style="font-size:10px;color:var(--ink-faint)">${t.duree_jours} j</span>` : ""}</span>
        <span class="fr k num">${kg1(tripKg(t))}<small> kg</small></span>
        <span class="z">${esc(t.zone || "—")}</span>
        <span class="ca num">${fcfa(tripCA(t))} FCFA</span>
        <span class="chev ${open ? "open" : ""}">›</span>
      </button>
      ${open ? tripDetail(t) : ""}
    </li>`;
  }
  function tripDetail(t) {
    const gps = t.gps ? `<span>GPS : ${t.gps.lat.toFixed(4)}, ${t.gps.lon.toFixed(4)}</span>` : "";
    return `<div class="trip-detail">
      <div class="trip-meta">
        <span>${tripDateLabel(t)}</span>
        <span class="num">${kg1(trackDistForTrip(t))} km</span>
        ${t.crew && t.crew.length ? `<span>Équipage : ${t.crew.map(esc).join(", ")}</span>` : ""}
        ${t.par ? `<span>Pesé/saisi : ${esc(t.par)}</span>` : ""}
        ${t.owner ? `<span>Saisi par : ${esc(t.owner)}</span>` : ""}
        ${gps}
      </div>
      ${(t.prises || []).map((p) => `
        <div class="catch-row">
          <span class="esp">${esc(p.esp)}</span>
          <span class="kg num">${kg1(p.kg)} kg</span>
          <span class="pu num">${fcfa(p.prix)} / kg</span>
          <span class="tot num">${fcfa((+p.kg) * (+p.prix))}</span>
        </div>`).join("")}
      ${isAdmin() && t.depenses != null && t.depenses > 0
        ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--paper-shade)">
             <div class="catch-row"><span class="esp muted">Recettes poisson</span><span class="tot num">${fcfa(tripCA(t))}</span></div>
             ${(t.depenses_detail || []).map((e) => `<div class="catch-row"><span class="esp muted">− ${EXP_LABELS[e.type] || e.type}${e.label ? " (" + esc(e.label) + ")" : ""}</span><span class="tot num" style="color:var(--signal)">−${fcfa(e.amount)}</span></div>`).join("")}
             <div class="catch-row" style="font-weight:600"><span class="esp">Marge nette</span><span class="tot num" style="color:${(tripCA(t) - t.depenses) >= 0 ? "var(--lagoon)" : "var(--signal)"}">${fcfa(tripCA(t) - t.depenses)} FCFA</span></div>
           </div>`
        : ""}
      ${t.photo ? `<img src="${API.photoUrl(t.photo)}" alt="photo des prises" loading="lazy" style="margin-top:12px;max-width:220px;border-radius:4px;border:1px solid var(--line)">` : ""}
      ${isAdmin()
        ? `<div style="margin-top:12px;display:flex;gap:8px">
             <button class="btn ghost small" data-edit="${t.id}">Modifier</button>
             <button class="btn ghost small" data-del="${t.id}" style="color:var(--signal);border-color:var(--signal)">Supprimer</button>
           </div>`
        : `<p class="hint" style="margin-top:12px">🔒 Sortie verrouillée. Seule l'administratrice peut la corriger.</p>`}
    </div>`;
  }
  // délégué pour suppression + édition (admin)
  el("view").addEventListener("click", async (e) => {
    const delId = e.target.getAttribute?.("data-del");
    if (delId) {
      if (!confirm("Supprimer cette sortie ?")) return;
      await API.delTrip(delId);
      state.trips = state.trips.filter((t) => t.id !== delId);
      renderJournal(el("view"));
      return;
    }
    const editId = e.target.getAttribute?.("data-edit");
    if (editId) {
      const trip = state.trips.find((t) => t.id === editId);
      if (trip) openEditModal(trip);
    }
  });

  // ----- Modale d'édition (admin) -----
  function openEditModal(t) {
    const prises = (t.prises || []).length ? t.prises : [{ esp: "", kg: "", prix: "" }];
    const modal = document.createElement("div");
    modal.className = "modal-backdrop";
    modal.innerHTML = `
      <div class="modal">
        <h2 class="fr" style="margin:0 0 4px">Modifier le débarquement</h2>
        <p class="lead" style="margin:0 0 16px">Correction réservée à l'administratrice.</p>
        <div class="two">
          <div><label>Date de départ</label><input type="date" id="e-ddate" value="${esc(t.depart_date || t.date)}"></div>
          <div><label>Heure de départ</label><input type="time" id="e-dep" value="${esc(t.depart || "")}"></div>
        </div>
        <div class="two">
          <div><label>Date de débarquement</label><input type="date" id="e-adate" value="${esc(t.arrivee_date || t.date)}"></div>
          <div><label>Heure de débarquement</label><input type="time" id="e-ret" value="${esc(t.retour || "")}"></div>
        </div>
        <label>Zone</label><input type="text" id="e-zone" value="${esc(t.zone || "")}">
        <label>Captures</label>
        <div id="e-catches">
          ${prises.map((p) => catchInputFilled(p)).join("")}
        </div>
        <button class="btn ghost small" id="e-add" style="margin-top:8px">+ Ajouter une espèce</button>
        <label style="margin-top:14px">Remarque</label><input type="text" id="e-note" value="${esc(t.note || "")}">
        <div style="display:flex;gap:8px;margin-top:20px">
          <button class="btn" id="e-save">Enregistrer les corrections</button>
          <button class="btn ghost" id="e-cancel">Annuler</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.addEventListener("click", (ev) => { if (ev.target === modal) close(); });
    el2(modal, "e-cancel").addEventListener("click", close);
    el2(modal, "e-add").addEventListener("click", () => {
      modal.querySelector("#e-catches").insertAdjacentHTML("beforeend", catchInputFilled({ esp: "", kg: "", prix: "" }));
      bindModalRemovers(modal);
    });
    bindModalRemovers(modal);

    el2(modal, "e-save").addEventListener("click", async () => {
      const prisesNew = [];
      modal.querySelectorAll("#e-catches .catch-input").forEach((row) => {
        const esp = row.querySelector('[data-f="esp"]').value.trim();
        const kg = parseFloat(row.querySelector('[data-f="kg"]').value);
        const prix = parseFloat(row.querySelector('[data-f="prix"]').value) || 0;
        if (esp && kg > 0) prisesNew.push({ esp, kg, prix });
      });
      if (!prisesNew.length) { alert("Ajoutez au moins une capture."); return; }
      const patch = {
        depart_date: el2(modal, "e-ddate").value, arrivee_date: el2(modal, "e-adate").value,
        date: el2(modal, "e-adate").value, depart: el2(modal, "e-dep").value,
        retour: el2(modal, "e-ret").value, zone: el2(modal, "e-zone").value.trim(),
        note: el2(modal, "e-note").value.trim(), prises: prisesNew,
      };
      try {
        const updated = await API.updateTrip(t.id, patch);
        const i = state.trips.findIndex((x) => x.id === t.id);
        if (i >= 0) state.trips[i] = updated;
        close();
        toast("Sortie corrigée");
        renderJournal(el("view"));
      } catch (err) { alert(err.message); }
    });
  }
  function el2(root, id) { return root.querySelector("#" + id); }
  function catchInputFilled(p) {
    return `<div class="catch-input">
      <input placeholder="espèce" data-f="esp" value="${esc(p.esp || "")}">
      <input placeholder="kg" inputmode="decimal" data-f="kg" value="${p.kg ?? ""}" style="max-width:90px">
      <input placeholder="prix" inputmode="numeric" data-f="prix" value="${p.prix ?? ""}" style="max-width:90px">
      <button class="rm" title="retirer">✕</button>
    </div>`;
  }
  function bindModalRemovers(modal) {
    modal.querySelectorAll("#e-catches .rm").forEach((b) => {
      b.onclick = () => { if (modal.querySelectorAll("#e-catches .catch-input").length > 1) b.parentElement.remove(); };
    });
  }

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
        <div id="map" style="height:440px;border-radius:2px;border:1px solid var(--line)"></div>
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
            <button class="btn ghost small" id="clearBtn">Effacer la trace</button>
            ${state.nemo ? `<button class="btn small" id="nemoBtn">Synchroniser NEMO</button>` : ""}
          </div>
          <div class="apibox">
            <b>Brancher NEMO :</b> l'accès aux positions passe par l'API de CLS. Écrivez à <code>clsfishingteam@groupcls.com</code> pour la documentation développeur, puis renseignez <code>NEMO_API_URL</code>, <code>NEMO_API_KEY</code>, <code>NEMO_DEVICE_ID</code> et complétez <code>server/nemo.js</code>. La synchronisation s'activera automatiquement ici.
          </div>
        </div>
      </div>`;

    // Leaflet a besoin que le conteneur soit dans le DOM ; petit délai.
    // Réinitialise l'instance carte (le conteneur DOM a été recréé par le render)
    MapView.reset();
    setTimeout(() => MapView.draw("map", S(), state.curTrack), 50);

    el("fileIn").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => importText(r.result, f.name);
      r.readAsText(f);
    });
    el("parseBtn").addEventListener("click", () => importText(el("pasteIn").value, "paste.csv"));
    el("demoBtn").addEventListener("click", loadDemo);
    el("clearBtn").addEventListener("click", () => {
      state.curTrack = null;
      renderCarte(el("view"));
      toast("Trace effacée de l'affichage");
    });
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
        if (tr.validated) {
          // alerte déjà vérifiée : trace gardée, affichée comme traitée
          return `<div class="info-badge">✓ ${frDate(tr.date)} — sortie détectée (${kg1(tr.dist_km)} km) non déclarée, <b>vérifiée (RAS)</b>.</div>`;
        }
        alerts++;
        return `<div class="alert"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="t">Sortie détectée non déclarée</span><span class="when num">${frDate(tr.date)}</span></div>
          <p>Le bateau a parcouru <span class="num" style="color:var(--ink)">${kg1(tr.dist_km)} km</span> mais aucune sortie n'est déclarée ce jour.</p>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn ghost small" data-valid="${tr.id}">Valider (vu, RAS)</button>
            <button class="btn ghost small" data-deltrack="${tr.id}" style="color:var(--signal);border-color:var(--signal)">Supprimer la trace</button>
          </div></div>`;
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

    v.querySelectorAll("[data-valid]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await API.validateTrack(b.dataset.valid);
        const tr = state.tracks.find((x) => x.id === b.dataset.valid);
        if (tr) tr.validated = 1;
        toast("Alerte validée");
        renderControle(v);
      } catch (e) { toast(e.message); }
    }));
    v.querySelectorAll("[data-deltrack]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer cette trace VMS ?")) return;
      try {
        await API.delTrack(b.dataset.deltrack);
        state.tracks = state.tracks.filter((x) => x.id !== b.dataset.deltrack);
        if (state.curTrack && state.curTrack.id === b.dataset.deltrack) state.curTrack = null;
        toast("Trace supprimée");
        renderControle(v);
      } catch (e) { toast(e.message); }
    }));
  }

  /* ================= DÉPENSES (admin) ================= */
  const EXP_LABELS = {
    carburant: "Carburant", paye: "Paye pêcheurs", materiel: "Matériel",
    transport: "Transport", licence: "Licence", autre: "Autre",
  };
  async function renderDepenses(v) {
    // Charge les dépenses si pas encore fait
    try { state.expenses = await API.expenses(); } catch (e) { /* garde l'existant */ }
    const exps = state.expenses.slice();
    const total = exps.reduce((s, e) => s + (e.amount || 0), 0);
    // total par type
    const byType = {};
    exps.forEach((e) => { byType[e.type] = (byType[e.type] || 0) + e.amount; });
    // options de sorties pour le lien
    const tripOpts = state.trips.map((t) =>
      `<option value="${t.id}">${frDate(t.date)} — ${esc(t.zone || "sortie")} (${kg1(tripKg(t))} kg)</option>`).join("");

    v.innerHTML = `
      <div class="form" style="max-width:640px">
        <h2 class="fr">Dépenses</h2>
        <p class="lead">Suivi des dépenses (réservé à l'administratrice). Reliez le carburant et la paye à une sortie pour calculer sa marge nette.</p>

        <div style="border:1px solid var(--line);border-radius:2px;padding:16px;margin-bottom:20px">
          <label>Type de dépense</label>
          <select id="d-type">
            <option value="carburant">Carburant (avant le voyage)</option>
            <option value="paye">Paye des pêcheurs</option>
            <option value="materiel">Matériel / moteur pirogue</option>
            <option value="transport">Transport de matériel</option>
            <option value="licence">Licence / taxe</option>
            <option value="autre">Autre</option>
          </select>
          <div class="two">
            <div><label>Date</label><input type="date" id="d-date" value="${todayISO()}"></div>
            <div><label>Montant (FCFA)</label><input type="number" id="d-amount" inputmode="numeric" step="100" placeholder="ex : 15000"></div>
          </div>
          <label>Description (optionnel)</label><input type="text" id="d-label" placeholder="ex : 30 L essence">
          <label>Relier à une sortie (optionnel — pour la marge nette)</label>
          <select id="d-trip"><option value="">— Dépense générale (non liée) —</option>${tripOpts}</select>
          <button class="btn" id="d-add">Ajouter la dépense</button>
        </div>

        <div class="stat" style="margin-bottom:16px">
          <div class="fr v num" style="font-size:26px">${fcfa(total)}<small style="font-size:12px">FCFA</small></div>
          <div class="l">Total des dépenses</div>
        </div>
        <table class="mini" style="margin-bottom:20px">
          ${Object.keys(byType).map((t) => `<tr><td>${EXP_LABELS[t] || t}</td><td class="r num">${fcfa(byType[t])} FCFA</td></tr>`).join("") || ""}
        </table>

        <p class="eyebrow" style="margin-bottom:6px">Historique</p>
        <div id="d-list"></div>
      </div>`;

    el("d-add").addEventListener("click", addExpense);
    renderExpenseList();
  }

  function renderExpenseList() {
    const list = el("d-list"); if (!list) return;
    const exps = state.expenses.slice();
    if (!exps.length) { list.innerHTML = `<div class="empty">Aucune dépense enregistrée.</div>`; return; }
    list.innerHTML = exps.map((e) => {
      const trip = e.trip_id ? state.trips.find((t) => t.id === e.trip_id) : null;
      return `<div class="catch-row" style="padding:10px 0">
        <span style="width:150px">${EXP_LABELS[e.type] || e.type}</span>
        <span class="num" style="width:110px">${fcfa(e.amount)} FCFA</span>
        <span class="muted" style="flex:1;font-size:12.5px">${frDate(e.date)}${e.label ? " · " + esc(e.label) : ""}${trip ? " · lié à " + frDate(trip.date) : ""}</span>
        <button class="btn ghost small" data-delexp="${e.id}" style="color:var(--signal);border-color:var(--signal)">Supprimer</button>
      </div>`;
    }).join("");
    list.querySelectorAll("[data-delexp]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer cette dépense ?")) return;
      await API.delExpense(b.dataset.delexp);
      state.expenses = state.expenses.filter((x) => x.id !== b.dataset.delexp);
      // recharge les sorties pour recalculer les marges
      state.trips = await API.trips().catch(() => state.trips);
      renderDepenses(el("view"));
    }));
  }

  async function addExpense() {
    const amount = parseFloat(el("d-amount").value);
    if (isNaN(amount) || amount < 0) { toast("Indiquez un montant valide."); return; }
    const exp = {
      type: el("d-type").value, date: el("d-date").value || todayISO(),
      amount, label: el("d-label").value.trim(), trip_id: el("d-trip").value || null,
    };
    try {
      const saved = await API.addExpense(exp);
      state.expenses.unshift(saved);
      // recharge les sorties pour que la marge nette se mette à jour
      state.trips = await API.trips().catch(() => state.trips);
      toast("Dépense ajoutée");
      renderDepenses(el("view"));
    } catch (e) { toast(e.message); }
  }

  /* ================= BILAN (admin) ================= */
  let charts = [];
  async function renderBilan(v) {
    // détruit les anciens graphes
    charts.forEach((c) => { try { c.destroy(); } catch {} }); charts = [];
    let data;
    try { data = await API.bilan(); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const { parMois, parType, totaux } = data;
    const margeGlobale = (totaux.recettes || 0) - (totaux.depenses || 0);

    v.innerHTML = `
      <div class="map-wrap">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:12px;margin-bottom:20px">
          <div>
            <h2 class="fr" style="margin:0">Bilan</h2>
            <p class="muted" style="font-size:13px;margin:4px 0 0">Vue d'ensemble de la rentabilité</p>
          </div>
          <button class="btn" id="bilan-export" style="margin:0">⬇ Exporter en Excel</button>
        </div>

        <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
          <div class="kpi"><div class="fr v num">${fcfa(totaux.recettes)}<small>FCFA</small></div><div class="l">Recettes totales</div></div>
          <div class="kpi"><div class="fr v num">${fcfa(totaux.depenses)}<small>FCFA</small></div><div class="l">Dépenses totales</div></div>
          <div class="kpi"><div class="fr v num" style="color:${margeGlobale>=0?"var(--lagoon)":"var(--signal)"}">${fcfa(margeGlobale)}<small>FCFA</small></div><div class="l">Marge nette</div></div>
        </div>

        <div style="margin-top:24px">
          <p class="eyebrow" style="margin-bottom:8px">Marge nette par mois</p>
          <div style="height:260px"><canvas id="ch-marge"></canvas></div>
        </div>
        <div style="margin-top:28px">
          <p class="eyebrow" style="margin-bottom:8px">Recettes vs dépenses par mois</p>
          <div style="height:260px"><canvas id="ch-rd"></canvas></div>
        </div>
        <div style="margin-top:28px">
          <p class="eyebrow" style="margin-bottom:8px">Répartition des dépenses par type</p>
          <div style="height:280px"><canvas id="ch-type"></canvas></div>
        </div>
      </div>`;

    el("bilan-export").addEventListener("click", exportExcel);

    if (typeof Chart === "undefined") { toast("Graphiques indisponibles (connexion ?)"); return; }
    const labels = parMois.map((m) => m.mois);
    const LAG = "#0d5c4a", SIG = "#a8321e", BLUE = "#1e5f8f", ACC = "#c55a11";
    const money = (v) => fcfa(v) + " FCFA";
    const commonY = { ticks: { callback: (v) => fcfa(v) } };

    // 1. Marge par mois (barres)
    charts.push(new Chart(el("ch-marge"), {
      type: "bar",
      data: { labels, datasets: [{ label: "Marge nette",
        data: parMois.map((m) => m.marge),
        backgroundColor: parMois.map((m) => m.marge >= 0 ? LAG : SIG) }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.raw) } } },
        scales: { y: commonY } },
    }));

    // 2. Recettes vs dépenses (barres groupées)
    charts.push(new Chart(el("ch-rd"), {
      type: "bar",
      data: { labels, datasets: [
        { label: "Recettes", data: parMois.map((m) => m.recettes), backgroundColor: BLUE },
        { label: "Dépenses", data: parMois.map((m) => m.depenses), backgroundColor: ACC } ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + money(c.raw) } } },
        scales: { y: commonY } },
    }));

    // 3. Répartition dépenses par type (donut)
    const types = Object.keys(parType);
    const TYPE_LABELS = { carburant: "Carburant", paye: "Paye pêcheurs", materiel: "Matériel", transport: "Transport", licence: "Licence", autre: "Autre" };
    charts.push(new Chart(el("ch-type"), {
      type: "doughnut",
      data: { labels: types.map((t) => TYPE_LABELS[t] || t),
        datasets: [{ data: types.map((t) => parType[t]),
          backgroundColor: [ACC, BLUE, LAG, "#7a5195", "#bc5090", "#8b918a"] }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => c.label + ": " + money(c.raw) } } } },
    }));
  }

  async function exportExcel() {
    // Téléchargement authentifié : on récupère le fichier avec le token puis on le sauve.
    const btn = el("bilan-export"); const old = btn.textContent;
    btn.disabled = true; btn.textContent = "Export…";
    try {
      const token = API.getToken();
      const res = await fetch("/api/export.xlsx", { headers: { Authorization: "Bearer " + token }, credentials: "same-origin" });
      if (!res.ok) throw new Error("Export refusé");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `fisher-link-${todayISO()}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast("Fichier Excel téléchargé");
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  /* ================= SAISIE ================= */
  let pendingPhoto = null; // data URL de la photo choisie
  let pendingGps = null;   // {lat, lon} capturé

  function renderSaisie(v) {
    const crew = safeArr(state.settings.crew);
    pendingPhoto = null; pendingGps = null;
    v.innerHTML = `
      <div class="form">
        <h2 class="fr">Nouveau débarquement</h2>
        <p class="lead">À remplir au retour, après la pesée. Une marée peut durer plusieurs jours. Une fois enregistré, seule l'administratrice peut corriger.</p>
        <div class="two">
          <div><label>Date de départ</label><input type="date" id="s-ddate" value="${todayISO()}"></div>
          <div><label>Heure de départ</label><input type="time" id="s-dep"></div>
        </div>
        <div class="two">
          <div><label>Date de débarquement</label><input type="date" id="s-adate" value="${todayISO()}"></div>
          <div><label>Heure de débarquement</label><input type="time" id="s-ret"></div>
        </div>
        <div class="hint" id="s-duree" style="margin-top:4px"></div>
        <label>Zone de pêche</label><input type="text" id="s-zone" placeholder="ex : Cap Lopez – SO">
        <input type="hidden" id="s-date">
        <label>Pêcheurs à bord</label>
        <div id="s-crew">${crew.map((n, i) => `<div class="check"><input type="checkbox" id="cw${i}" checked data-n="${esc(n)}"><label for="cw${i}">${esc(n)}</label></div>`).join("")}</div>

        <div class="divider"></div>
        <label>Captures (espèce · kg · prix FCFA/kg)</label>
        <div id="catches">
          ${catchInput()}
        </div>
        <button class="btn ghost small" id="addCatch" style="margin-top:8px">+ Ajouter une espèce</button>

        <div class="divider"></div>
        <label>Photo des poissons (obligatoire)</label>
        <input type="file" id="s-photo" accept="image/*" capture="environment" style="padding:0;border:none;background:none">
        <div id="s-photo-preview" style="margin-top:10px"></div>

        <label style="margin-top:16px">Position GPS du téléphone</label>
        <div id="s-gps" class="info-badge" style="margin-top:0">Position non capturée.</div>
        <button class="btn ghost small" id="s-gps-btn" style="margin-top:8px">Capturer ma position</button>

        <div class="divider"></div>
        <label>Qui a pesé / saisi ? (contrôle)</label><input type="text" id="s-par" placeholder="nom au débarquement">
        <label>Remarque (optionnel)</label><input type="text" id="s-note" placeholder="mer agitée, panne…">
        <div class="warn" id="s-warn" hidden></div>
        <button class="btn" id="s-save">Enregistrer le débarquement</button>
      </div>`;

    el("addCatch").addEventListener("click", () => {
      el("catches").insertAdjacentHTML("beforeend", catchInput());
      bindRemovers();
    });
    bindRemovers();

    // Affiche la durée de la marée en direct
    function updateDuree() {
      const dd = el("s-ddate").value, ad = el("s-adate").value;
      const box = el("s-duree"); if (!box) return;
      if (!dd || !ad) { box.textContent = ""; return; }
      const ms = Date.parse(ad) - Date.parse(dd);
      if (isNaN(ms) || ms < 0) { box.textContent = "⚠ Le débarquement est avant le départ."; return; }
      const j = Math.max(1, Math.round(ms / 86400000) + 1);
      box.textContent = j === 1 ? "Marée d'une journée." : `Marée de ${j} jours en mer.`;
    }
    el("s-ddate").addEventListener("change", updateDuree);
    el("s-adate").addEventListener("change", updateDuree);
    updateDuree();

    // Photo : compression avant envoi (pour ne pas saturer le stockage)
    el("s-photo").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      compressImage(f, (dataUrl) => {
        pendingPhoto = dataUrl;
        el("s-photo-preview").innerHTML = `<img src="${dataUrl}" alt="aperçu" style="max-width:180px;border-radius:4px;border:1px solid var(--line)">`;
      });
    });

    // GPS : capture automatique dès l'ouverture du formulaire, + bouton manuel
    captureGps();
    el("s-gps-btn").addEventListener("click", captureGps);

    el("s-save").addEventListener("click", saveTrip);
  }

  function captureGps() {
    const box = el("s-gps"); if (!box) return;
    if (!navigator.geolocation) { box.textContent = "GPS non disponible sur cet appareil."; return; }
    box.textContent = "Localisation en cours…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        pendingGps = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        box.textContent = `Position : ${pendingGps.lat.toFixed(5)}, ${pendingGps.lon.toFixed(5)}`;
      },
      (err) => { box.textContent = "Position refusée ou indisponible (" + err.message + ")."; },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  // Compresse/redimensionne l'image côté navigateur (max 1280px, JPEG qualité 0.7)
  function compressImage(file, cb) {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.onload = () => {
      const max = 1280;
      let { width, height } = img;
      if (width > max || height > max) {
        const r = Math.min(max / width, max / height);
        width = Math.round(width * r); height = Math.round(height * r);
      }
      const c = document.createElement("canvas");
      c.width = width; c.height = height;
      c.getContext("2d").drawImage(img, 0, 0, width, height);
      cb(c.toDataURL("image/jpeg", 0.7));
    }; img.src = reader.result; };
    reader.readAsDataURL(file);
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
    const w = el("s-warn");
    if (!prises.length) { w.hidden = false; w.textContent = "Ajoutez au moins une capture (espèce + kg)."; return; }
    if (!pendingPhoto) { w.hidden = false; w.textContent = "La photo des poissons est obligatoire."; return; }
    const crew = []; document.querySelectorAll('#s-crew input:checked').forEach((c) => crew.push(c.dataset.n));
    const ddate = el("s-ddate").value || todayISO();
    const adate = el("s-adate").value || ddate;
    if (Date.parse(adate) < Date.parse(ddate)) { w.hidden = false; w.textContent = "Le débarquement ne peut pas être avant le départ."; return; }
    const trip = {
      depart_date: ddate, arrivee_date: adate,
      date: adate,                    // référence = débarquement
      depart: el("s-dep").value, retour: el("s-ret").value,
      zone: el("s-zone").value.trim(), crew, prises,
      par: el("s-par").value.trim(), note: el("s-note").value.trim(),
      photo: pendingPhoto, gps: pendingGps,
    };
    const btn = el("s-save"); btn.disabled = true; btn.textContent = "Enregistrement…";
    try {
      const saved = await API.addTrip(trip);
      state.trips.unshift(saved);
      pendingPhoto = null; pendingGps = null;
      toast("Débarquement enregistré");
      document.querySelector('.tab[data-tab="journal"]').click();
    } catch (e) { w.hidden = false; w.textContent = e.message; btn.disabled = false; btn.textContent = "Enregistrer le débarquement"; }
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
