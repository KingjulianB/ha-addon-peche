import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { Trips, Tracks, Settings, getSettings } from "./db.js";
import { trackDistanceKm, trackDurationH } from "./geo.js";
import { nemoConfigured, fetchNemoTrack } from "./nemo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Mot de passe partagé (vous + votre partenaire). À définir au déploiement
// via la variable APP_PASSWORD. Par défaut : "peche" (à changer !).
const APP_PASSWORD = process.env.APP_PASSWORD || "peche";

app.use(express.json({ limit: "5mb" }));

// --- Auth minimale : un en-tête x-app-key doit correspondre au mot de passe ---
function auth(req, res, next) {
  const key = req.get("x-app-key");
  if (key !== APP_PASSWORD) {
    return res.status(401).json({ error: "Clé d'accès invalide." });
  }
  next();
}

// Vérification du mot de passe (l'appli l'appelle à la connexion)
app.post("/api/login", (req, res) => {
  if ((req.body?.password || "") === APP_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: "Mot de passe incorrect." });
});

// ---------- SORTIES (déclarations) ----------
app.get("/api/trips", auth, (req, res) => {
  const rows = Trips.all.all().map(deserTrip);
  res.json(rows);
});

app.post("/api/trips", auth, (req, res) => {
  const b = req.body || {};
  if (!b.date || !Array.isArray(b.prises)) {
    return res.status(400).json({ error: "date et prises sont requis." });
  }
  const row = {
    id: b.id || randomUUID(),
    date: b.date,
    depart: b.depart || "",
    retour: b.retour || "",
    zone: b.zone || "",
    crew: JSON.stringify(b.crew || []),
    prises: JSON.stringify(b.prises || []),
    par: b.par || "",
    note: b.note || "",
    created_at: Date.now(),
  };
  Trips.insert.run(row);
  res.json(deserTrip(row));
});

app.delete("/api/trips/:id", auth, (req, res) => {
  Trips.del.run(req.params.id);
  res.json({ ok: true });
});

// ---------- TRACES VMS ----------
app.get("/api/tracks", auth, (req, res) => {
  res.json(Tracks.all.all());
});

app.get("/api/tracks/:id", auth, (req, res) => {
  const t = Tracks.one.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Trace introuvable." });
  t.points = JSON.parse(t.points);
  res.json(t);
});

// Enregistre une trace (import manuel ou, plus tard, flux NEMO)
function saveTrack({ points, date, depart, retour, source }) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("Trace invalide (moins de 2 points).");
  }
  const row = {
    id: randomUUID(),
    date: date || (points[0].t ? points[0].t.slice(0, 10) : new Date().toISOString().slice(0, 10)),
    depart: depart || "",
    retour: retour || "",
    points: JSON.stringify(points),
    dist_km: +trackDistanceKm(points).toFixed(2),
    duree_h: +trackDurationH(points).toFixed(2),
    source: source || "manuel",
    created_at: Date.now(),
  };
  Tracks.insert.run(row);
  return row;
}

app.post("/api/tracks", auth, (req, res) => {
  try {
    const row = saveTrack({ ...req.body, source: "manuel" });
    res.json({ id: row.id, dist_km: row.dist_km, duree_h: row.duree_h, date: row.date });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/tracks/:id", auth, (req, res) => {
  Tracks.del.run(req.params.id);
  res.json({ ok: true });
});

// Synchronisation NEMO (active une fois l'API CLS configurée)
app.get("/api/nemo/status", auth, (req, res) => {
  res.json({ configured: nemoConfigured() });
});

app.post("/api/nemo/sync", auth, async (req, res) => {
  try {
    const { since, until } = req.body || {};
    const points = await fetchNemoTrack(since, until);
    const row = saveTrack({ points, source: "nemo" });
    res.json({ ok: true, id: row.id, points: points.length, dist_km: row.dist_km });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- RÉGLAGES ----------
app.get("/api/settings", auth, (req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", auth, (req, res) => {
  const b = req.body || {};
  const tx = Object.entries(b);
  for (const [k, v] of tx) Settings.set.run(k, String(v));
  res.json(getSettings());
});

// ---------- Fichiers statiques (l'appli web) ----------
app.use(express.static(join(__dirname, "..", "public")));

function deserTrip(r) {
  return {
    ...r,
    crew: safeParse(r.crew, []),
    prises: safeParse(r.prises, []),
  };
}
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

app.listen(PORT, () => {
  console.log(`\n  Pêche Port-Gentil — serveur démarré`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Mot de passe d'accès : ${APP_PASSWORD === "peche" ? '"peche" (⚠ à changer via APP_PASSWORD)' : "(défini via APP_PASSWORD)"}`);
  console.log(`  → NEMO : ${nemoConfigured() ? "configuré" : "non configuré (import manuel actif)"}\n`);
});
