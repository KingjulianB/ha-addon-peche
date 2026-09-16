// Client API — authentification par cookie de session (géré par le navigateur).
const API = (() => {
  async function req(method, path, body) {
    const opt = { method, credentials: "same-origin", headers: {} };
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
    login: (username, password) => req("POST", "/api/login", { username, password }),
    logout: () => req("POST", "/api/logout"),
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
  };
})();
