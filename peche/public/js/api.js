// Client API. La clé (mot de passe) est gardée en mémoire pour la session.
const API = (() => {
  let key = sessionStorage.getItem("appkey") || "";

  async function req(method, path, body) {
    const opt = { method, headers: { "x-app-key": key } };
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(path, opt);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Erreur ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    setKey(k) { key = k; sessionStorage.setItem("appkey", k); },
    hasKey() { return Boolean(key); },
    login: (password) => fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((r) => r.ok),

    trips: () => req("GET", "/api/trips"),
    addTrip: (t) => req("POST", "/api/trips", t),
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
