// Client API — authentification par jeton (en-tête Authorization) ET cookie.
// Le jeton en en-tête garantit le fonctionnement même derrière un proxy
// (Cloudflare) où le cookie pourrait ne pas être conservé.
const API = (() => {
  // Stockage résistant : localStorage si possible, sinon repli en mémoire.
  // Safari iPhone (nav. privée / anti-traçage) peut bloquer le stockage —
  // dans ce cas on garde le jeton en mémoire pour la durée de la session.
  const store = (() => {
    let mem = "";
    let ok = false;
    try {
      localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); ok = true;
    } catch { ok = false; }
    return {
      get() { if (ok) { try { return localStorage.getItem("token") || ""; } catch {} } return mem; },
      set(v) { mem = v; if (ok) { try { localStorage.setItem("token", v); } catch {} } },
      clear() { mem = ""; if (ok) { try { localStorage.removeItem("token"); } catch {} } },
    };
  })();

  let token = store.get();

  async function req(method, path, body) {
    const opt = { method, credentials: "same-origin", headers: {} };
    if (token) opt.headers["Authorization"] = "Bearer " + token;
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(path, opt);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      const err = new Error(e.error || `Erreur ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    login: async (username, password) => {
      const r = await req("POST", "/api/login", { email: username, password });
      if (r && r.token) { token = r.token; store.set(token); }
      return r;
    },
    register: (entreprise, email, password) => req("POST", "/api/register", { entreprise, email, password }),
    verify: (token) => req("GET", `/api/verify?token=${encodeURIComponent(token)}`),
    entreprises: () => req("GET", "/api/entreprises"),
    setEntrepriseStatut: (id, statut) => req("POST", `/api/entreprises/${id}/statut`, { statut }),
    verifierEntreprise: (id) => req("POST", `/api/entreprises/${id}/verifier`),
    async logout() {
      try { await req("POST", "/api/logout"); } finally {
        token = ""; store.clear();
      }
    },
    me: () => req("GET", "/api/me"),

    trips: () => req("GET", "/api/trips"),
    addTrip: (t) => req("POST", "/api/trips", t),
    updateTrip: (id, t) => req("PUT", `/api/trips/${id}`, t),
    delTrip: (id) => req("DELETE", `/api/trips/${id}`),

    tracks: () => req("GET", "/api/tracks"),
    track: (id) => req("GET", `/api/tracks/${id}`),
    addTrack: (t) => req("POST", "/api/tracks", t),
    delTrack: (id) => req("DELETE", `/api/tracks/${id}`),
    validateTrack: (id) => req("POST", `/api/tracks/${id}/validate`),

    settings: () => req("GET", "/api/settings"),
    saveSettings: (s) => req("PUT", "/api/settings", s),

    nemoStatus: () => req("GET", "/api/nemo/status"),
    nemoSync: (r) => req("POST", "/api/nemo/sync", r),

    expenses: () => req("GET", "/api/expenses"),
    addExpense: (e) => req("POST", "/api/expenses", e),
    delExpense: (id) => req("DELETE", `/api/expenses/${id}`),
    bilan: () => req("GET", "/api/bilan"),
    tresorerie: () => req("GET", "/api/tresorerie"),
    pannes: () => req("GET", "/api/pannes"),
    addPanne: (p) => req("POST", "/api/pannes", p),
    updatePanne: (id, p) => req("PUT", `/api/pannes/${id}`, p),
    delPanne: (id) => req("DELETE", `/api/pannes/${id}`),

    // Pour les images : on ne peut pas mettre d'en-tête sur une balise <img>,
    // donc on expose le token en query pour l'URL des photos.
    photoUrl: (ref) => `/api/photo?ref=${encodeURIComponent(ref)}${token ? "&t=" + encodeURIComponent(token) : ""}`,
    getToken: () => token,
  };
})();
