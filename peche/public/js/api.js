// Client API — authentification par jeton (en-tête Authorization) ET cookie.
// Le jeton en en-tête garantit le fonctionnement même derrière un proxy
// (Cloudflare) où le cookie pourrait ne pas être conservé.
const API = (() => {
  let token = sessionStorage.getItem("token") || "";

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
    async login(username, password) {
      const r = await req("POST", "/api/login", { username, password });
      if (r && r.token) { token = r.token; sessionStorage.setItem("token", token); }
      return r;
    },
    async logout() {
      try { await req("POST", "/api/logout"); } finally {
        token = ""; sessionStorage.removeItem("token");
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

    settings: () => req("GET", "/api/settings"),
    saveSettings: (s) => req("PUT", "/api/settings", s),

    nemoStatus: () => req("GET", "/api/nemo/status"),
    nemoSync: (r) => req("POST", "/api/nemo/sync", r),

    // Pour les images : on ne peut pas mettre d'en-tête sur une balise <img>,
    // donc on expose le token en query pour l'URL des photos.
    photoUrl: (ref) => `/api/photo?ref=${encodeURIComponent(ref)}${token ? "&t=" + encodeURIComponent(token) : ""}`,
  };
})();
