import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

import { Trips, Tracks, Settings, getSettings, Users } from "./db.js";
import { trackDistanceKm, trackDurationH } from "./geo.js";
import { nemoConfigured, fetchNemoTrack } from "./nemo.js";
import { nextcloudConfigured, uploadPhoto, downloadPhoto } from "./nextcloud.js";
import {
  ensureUsers, verifyPassword, createSession, getSession, destroySession,
} from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Derrière le tunnel Cloudflare / proxy HA : faire confiance aux en-têtes
// X-Forwarded-* pour détecter le HTTPS et fixer le cookie correctement.
app.set("trust proxy", true);

// Dossier des photos (dans /data pour être persistant + sauvegardé par HA)
const DB_PATH = process.env.DB_PATH || "./data/peche.db";
const PHOTO_DIR = join(dirname(DB_PATH), "photos");
mkdirSync(PHOTO_DIR, { recursive: true });

// Comptes : mots de passe fournis par les options de l'add-on
ensureUsers({
  adminPassword: process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || "admin",
  pecheurPassword: process.env.PECHEUR_PASSWORD || "pecheur",
});

app.use(express.json({ limit: "12mb" })); // 12mb pour accepter une photo en base64

// --- Cookies simples (lecture du token de session) ---
function parseCookies(req) {
  const h = req.headers.cookie || "";
  const out = {};
  h.split(";").forEach((c) => {
    const i = c.indexOf("="); if (i < 0) return;
    out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).session;
  return getSession(token);
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Non connecté." });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Réservé à l'administrateur." });
  next();
}

// ---------- AUTH ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = Users.byName.get((username || "").trim());
  if (!user || !verifyPassword(password || "", user.password)) {
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  }
  const token = createSession(user);
  // Cookie sécurisé si on est en HTTPS (via Cloudflare), sinon cookie simple
  // pour que l'accès local http://IP:3000 continue de fonctionner.
  const https = req.secure || req.get("x-forwarded-proto") === "https";
  const cookie = https
    ? `session=${token}; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=2592000`
    : `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`;
  res.setHeader("Set-Cookie", cookie);
  res.json({ username: user.username, role: user.role });
});

app.post("/api/logout", (req, res) => {
  destroySession(parseCookies(req).session);
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Non connecté." });
  res.json({ username: u.username, role: u.role });
});

// ---------- SORTIES ----------
app.get("/api/trips", requireAuth, (req, res) => {
  // admin voit tout ; pêcheur ne voit que SES sorties
  const rows = (req.user.role === "admin" ? Trips.all.all() : Trips.byOwner.all(req.user.username))
    .map(deserTrip);
  res.json(rows);
});

app.post("/api/trips", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.date || !Array.isArray(b.prises) || !b.prises.length) {
    return res.status(400).json({ error: "Date et au moins une capture sont requises." });
  }
  if (!b.photo) {
    return res.status(400).json({ error: "La photo des poissons est obligatoire." });
  }
  // Enregistre la photo : Nextcloud si configuré et joignable, sinon local.
  let photoRef = null;
  try {
    photoRef = await savePhoto(b.photo);
  } catch (e) {
    return res.status(400).json({ error: "Photo invalide : " + e.message });
  }
  const row = {
    id: randomUUID(),
    date: b.date, depart: b.depart || "", retour: b.retour || "",
    zone: b.zone || "", crew: JSON.stringify(b.crew || []),
    prises: JSON.stringify(b.prises || []), par: b.par || "", note: b.note || "",
    owner: req.user.username,
    locked: 1, // verrouillé dès la création : le pêcheur ne peut plus modifier
    photo: photoRef,
    gps_lat: (b.gps && typeof b.gps.lat === "number") ? b.gps.lat : null,
    gps_lon: (b.gps && typeof b.gps.lon === "number") ? b.gps.lon : null,
    created_at: Date.now(),
  };
  Trips.insert.run(row);
  res.json(deserTrip(row));
});

// Modification : ADMIN uniquement
app.put("/api/trips/:id", requireAuth, requireAdmin, (req, res) => {
  const cur = Trips.one.get(req.params.id);
  if (!cur) return res.status(404).json({ error: "Sortie introuvable." });
  const b = req.body || {};
  Trips.update.run({
    id: cur.id,
    date: b.date ?? cur.date, depart: b.depart ?? cur.depart, retour: b.retour ?? cur.retour,
    zone: b.zone ?? cur.zone,
    crew: JSON.stringify(b.crew ?? safeParse(cur.crew, [])),
    prises: JSON.stringify(b.prises ?? safeParse(cur.prises, [])),
    par: b.par ?? cur.par, note: b.note ?? cur.note,
  });
  res.json(deserTrip(Trips.one.get(cur.id)));
});

// Suppression : ADMIN uniquement
app.delete("/api/trips/:id", requireAuth, requireAdmin, (req, res) => {
  const cur = Trips.one.get(req.params.id);
  if (cur && cur.photo && !cur.photo.startsWith("nc:")) {
    try { unlinkSync(join(PHOTO_DIR, cur.photo)); } catch {}
  }
  Trips.del.run(req.params.id);
  res.json({ ok: true });
});

// Sert une photo. La référence passe en paramètre de requête (?ref=...) car
// une référence Nextcloud contient des "/" qui posent problème dans un chemin.
app.get("/api/photo", requireAuth, async (req, res) => {
  const ref = String(req.query.ref || "");
  if (ref.startsWith("nc:")) {
    try {
      const { buffer, mime } = await downloadPhoto(ref.slice(3));
      res.setHeader("Content-Type", mime);
      return res.end(buffer);
    } catch (e) {
      return res.status(502).json({ error: "Photo Nextcloud indisponible." });
    }
  }
  const p = join(PHOTO_DIR, ref.replace(/[^a-zA-Z0-9._-]/g, ""));
  if (!existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ---------- TRACES VMS ----------
app.get("/api/tracks", requireAuth, (req, res) => res.json(Tracks.all.all()));
app.get("/api/tracks/:id", requireAuth, (req, res) => {
  const t = Tracks.one.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Trace introuvable." });
  t.points = JSON.parse(t.points); res.json(t);
});

function saveTrack({ points, date, depart, retour, source }) {
  if (!Array.isArray(points) || points.length < 2) throw new Error("Trace invalide (moins de 2 points).");
  const row = {
    id: randomUUID(),
    date: date || (points[0].t ? points[0].t.slice(0, 10) : new Date().toISOString().slice(0, 10)),
    depart: depart || "", retour: retour || "",
    points: JSON.stringify(points),
    dist_km: +trackDistanceKm(points).toFixed(2),
    duree_h: +trackDurationH(points).toFixed(2),
    source: source || "manuel", created_at: Date.now(),
  };
  Tracks.insert.run(row); return row;
}
app.post("/api/tracks", requireAuth, (req, res) => {
  try { const r = saveTrack({ ...req.body, source: "manuel" }); res.json({ id: r.id, dist_km: r.dist_km, duree_h: r.duree_h, date: r.date }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/tracks/:id", requireAuth, requireAdmin, (req, res) => { Tracks.del.run(req.params.id); res.json({ ok: true }); });

app.get("/api/nemo/status", requireAuth, (req, res) => res.json({ configured: nemoConfigured() }));
app.post("/api/nemo/sync", requireAuth, async (req, res) => {
  try { const { since, until } = req.body || {}; const points = await fetchNemoTrack(since, until); const r = saveTrack({ points, source: "nemo" }); res.json({ ok: true, id: r.id, points: points.length, dist_km: r.dist_km }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- RÉGLAGES (admin pour modifier) ----------
app.get("/api/settings", requireAuth, (req, res) => res.json(getSettings()));
app.put("/api/settings", requireAuth, requireAdmin, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) Settings.set.run(k, String(v));
  res.json(getSettings());
});

// ---------- statiques ----------
app.use(express.static(join(__dirname, "..", "public")));

// ---------- helpers ----------
async function savePhoto(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error("format non reconnu");
  const ext = m[1].toLowerCase().replace("jpeg", "jpg");
  const mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 8 * 1024 * 1024) throw new Error("image trop lourde (max 8 Mo)");
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

  // 1) Tente Nextcloud si configuré
  if (nextcloudConfigured()) {
    try {
      const remotePath = await uploadPhoto(name, buf, mime);
      return "nc:" + remotePath;           // préfixe = stockée sur Nextcloud
    } catch (e) {
      console.warn("Nextcloud indisponible, repli local :", e.message);
      // on continue vers le stockage local
    }
  }
  // 2) Repli local (ou si Nextcloud non configuré)
  writeFileSync(join(PHOTO_DIR, name), buf);
  return name;                              // pas de préfixe = locale
}
function deserTrip(r) {
  return { ...r, crew: safeParse(r.crew, []), prises: safeParse(r.prises, []),
    gps: (r.gps_lat != null) ? { lat: r.gps_lat, lon: r.gps_lon } : null };
}
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

app.listen(PORT, () => {
  console.log(`\n  Pêche Port-Gentil — serveur démarré sur le port ${PORT}`);
  console.log(`  Comptes : admin + pecheur (mots de passe définis dans la config)`);
  console.log(`  NEMO : ${nemoConfigured() ? "configuré" : "non configuré (import manuel)"}\n`);
});
