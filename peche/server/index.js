import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

import { Trips, Tracks, Settings, getSettings, Users, Expenses } from "./db.js";
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
  // Token via cookie OU via en-tête Authorization: Bearer <token>
  // (le second marche même si le cookie ne traverse pas le proxy Cloudflare).
  let token = parseCookies(req).session;
  const auth = req.get("authorization") || "";
  if (!token && auth.startsWith("Bearer ")) token = auth.slice(7);
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
  // On renvoie aussi le token : le front le stockera et l'enverra en en-tête
  // Authorization, ce qui fonctionne même si le cookie ne passe pas le proxy.
  res.json({ username: user.username, role: user.role, token });
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
  const isAdmin = req.user.role === "admin";
  const rows = (isAdmin ? Trips.all.all() : Trips.byOwner.all(req.user.username))
    .map((r) => deserTrip(r, isAdmin));
  res.json(rows);
});

app.post("/api/trips", requireAuth, async (req, res) => {
  const b = req.body || {};
  // arrivee_date (débarquement) = référence ; départ optionnel (marée pluri-jours)
  const arrivee = b.arrivee_date || b.date;
  const depart = b.depart_date || arrivee;
  if (!arrivee || !Array.isArray(b.prises) || !b.prises.length) {
    return res.status(400).json({ error: "Date de débarquement et au moins une capture sont requises." });
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
    date: arrivee,                    // date de référence = débarquement
    depart_date: depart, arrivee_date: arrivee,
    depart: b.depart || "", retour: b.retour || "",
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
  res.json(deserTrip(row, req.user.role === "admin"));
});

// Modification : ADMIN uniquement
app.put("/api/trips/:id", requireAuth, requireAdmin, (req, res) => {
  const cur = Trips.one.get(req.params.id);
  if (!cur) return res.status(404).json({ error: "Débarquement introuvable." });
  const b = req.body || {};
  const arrivee = b.arrivee_date ?? cur.arrivee_date ?? cur.date;
  const depart = b.depart_date ?? cur.depart_date ?? arrivee;
  Trips.update.run({
    id: cur.id,
    date: arrivee,                       // référence = débarquement
    depart_date: depart, arrivee_date: arrivee,
    depart: b.depart ?? cur.depart, retour: b.retour ?? cur.retour,
    zone: b.zone ?? cur.zone,
    crew: JSON.stringify(b.crew ?? safeParse(cur.crew, [])),
    prises: JSON.stringify(b.prises ?? safeParse(cur.prises, [])),
    par: b.par ?? cur.par, note: b.note ?? cur.note,
  });
  res.json(deserTrip(Trips.one.get(cur.id), true));
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
app.get("/api/photo", async (req, res) => {
  // Auth spéciale : une balise <img> ne peut pas envoyer d'en-tête,
  // donc on accepte le token en query (?t=) en plus du cookie/header.
  let token = parseCookies(req).session;
  const auth = req.get("authorization") || "";
  if (!token && auth.startsWith("Bearer ")) token = auth.slice(7);
  if (!token && req.query.t) token = String(req.query.t);
  if (!getSession(token)) return res.status(401).end();

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
app.post("/api/tracks/:id/validate", requireAuth, requireAdmin, (req, res) => { Tracks.validate.run(req.params.id); res.json({ ok: true }); });

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

// ---------- DÉPENSES (admin uniquement) ----------
const EXPENSE_TYPES = ["carburant", "paye", "materiel", "transport", "licence", "autre"];

app.get("/api/expenses", requireAuth, requireAdmin, (req, res) => {
  res.json(Expenses.all.all());
});

app.post("/api/expenses", requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const amount = parseFloat(b.amount);
  if (!b.date || !b.type || isNaN(amount) || amount < 0) {
    return res.status(400).json({ error: "Date, type et montant sont requis." });
  }
  if (!EXPENSE_TYPES.includes(b.type)) {
    return res.status(400).json({ error: "Type de dépense invalide." });
  }
  const row = {
    id: randomUUID(),
    date: b.date,
    type: b.type,
    label: (b.label || "").trim(),
    amount,
    trip_id: b.trip_id || null,   // lien optionnel vers une sortie
    created_at: Date.now(),
  };
  Expenses.insert.run(row);
  res.json(row);
});

app.delete("/api/expenses/:id", requireAuth, requireAdmin, (req, res) => {
  Expenses.del.run(req.params.id);
  res.json({ ok: true });
});

// ---------- BILAN (données agrégées par mois, admin) ----------
app.get("/api/bilan", requireAuth, requireAdmin, (req, res) => {
  const trips = Trips.all.all().map((r) => deserTrip(r, true));
  const expenses = Expenses.all.all();
  // agrégation par mois (AAAA-MM)
  const months = {};
  const ensureM = (m) => (months[m] = months[m] || { mois: m, recettes: 0, depenses: 0 });
  trips.forEach((t) => {
    const m = (t.date || "").slice(0, 7);
    if (!m) return;
    ensureM(m).recettes += (t.prises || []).reduce((s, p) => s + (p.kg || 0) * (p.prix || 0), 0);
  });
  expenses.forEach((e) => {
    const m = (e.date || "").slice(0, 7);
    if (!m) return;
    ensureM(m).depenses += e.amount || 0;
  });
  const parMois = Object.values(months).sort((a, b) => a.mois.localeCompare(b.mois))
    .map((x) => ({ ...x, marge: x.recettes - x.depenses }));
  // répartition des dépenses par type
  const parType = {};
  expenses.forEach((e) => { parType[e.type] = (parType[e.type] || 0) + e.amount; });
  res.json({ parMois, parType,
    totaux: {
      recettes: parMois.reduce((s, x) => s + x.recettes, 0),
      depenses: parMois.reduce((s, x) => s + x.depenses, 0),
    } });
});

// ---------- EXPORT EXCEL (admin) ----------
app.get("/api/export.xlsx", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = "Fisher Link";
    wb.created = new Date();

    const trips = Trips.all.all().map((r) => deserTrip(r, true));
    const expenses = Expenses.all.all();
    const tripById = {}; trips.forEach((t) => (tripById[t.id] = t));

    const NAVY = "FF12395F", WHITE = "FFFFFFFF";
    const headerStyle = (row) => row.eachCell((c) => {
      c.font = { bold: true, color: { argb: WHITE } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    });

    // Feuille 1 : Sorties
    const s1 = wb.addWorksheet("Sorties");
    s1.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Zone", key: "zone", width: 20 },
      { header: "Équipage", key: "crew", width: 28 },
      { header: "Poids total (kg)", key: "kg", width: 15 },
      { header: "Recettes (FCFA)", key: "recettes", width: 16 },
      { header: "Dépenses liées (FCFA)", key: "depenses", width: 20 },
      { header: "Marge nette (FCFA)", key: "marge", width: 18 },
      { header: "Saisi par", key: "owner", width: 12 },
    ];
    headerStyle(s1.getRow(1));
    trips.forEach((t) => {
      const kg = (t.prises || []).reduce((s, p) => s + (p.kg || 0), 0);
      const recettes = (t.prises || []).reduce((s, p) => s + (p.kg || 0) * (p.prix || 0), 0);
      const dep = t.depenses || 0;
      s1.addRow({ date: t.date, zone: t.zone, crew: (t.crew || []).join(", "),
        kg, recettes, depenses: dep, marge: recettes - dep, owner: t.owner });
    });

    // Feuille 2 : Captures (détail par espèce)
    const s2 = wb.addWorksheet("Captures");
    s2.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Espèce", key: "esp", width: 18 },
      { header: "Poids (kg)", key: "kg", width: 12 },
      { header: "Prix/kg (FCFA)", key: "prix", width: 14 },
      { header: "Total (FCFA)", key: "total", width: 14 },
    ];
    headerStyle(s2.getRow(1));
    trips.forEach((t) => (t.prises || []).forEach((p) =>
      s2.addRow({ date: t.date, esp: p.esp, kg: p.kg, prix: p.prix, total: (p.kg || 0) * (p.prix || 0) })));

    // Feuille 3 : Dépenses
    const s3 = wb.addWorksheet("Dépenses");
    s3.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Type", key: "type", width: 14 },
      { header: "Description", key: "label", width: 24 },
      { header: "Montant (FCFA)", key: "amount", width: 16 },
      { header: "Sortie liée", key: "trip", width: 20 },
    ];
    headerStyle(s3.getRow(1));
    expenses.forEach((e) => {
      const t = e.trip_id ? tripById[e.trip_id] : null;
      s3.addRow({ date: e.date, type: e.type, label: e.label,
        amount: e.amount, trip: t ? `${t.date} ${t.zone || ""}`.trim() : "" });
    });

    // Feuille 4 : Bilan mensuel
    const s4 = wb.addWorksheet("Bilan mensuel");
    s4.columns = [
      { header: "Mois", key: "mois", width: 12 },
      { header: "Recettes (FCFA)", key: "recettes", width: 16 },
      { header: "Dépenses (FCFA)", key: "depenses", width: 16 },
      { header: "Marge nette (FCFA)", key: "marge", width: 18 },
    ];
    headerStyle(s4.getRow(1));
    const months = {};
    trips.forEach((t) => { const m = (t.date || "").slice(0, 7); if (m) { months[m] = months[m] || { recettes: 0, depenses: 0 }; months[m].recettes += (t.prises || []).reduce((s, p) => s + (p.kg || 0) * (p.prix || 0), 0); } });
    expenses.forEach((e) => { const m = (e.date || "").slice(0, 7); if (m) { months[m] = months[m] || { recettes: 0, depenses: 0 }; months[m].depenses += e.amount || 0; } });
    Object.keys(months).sort().forEach((m) =>
      s4.addRow({ mois: m, recettes: months[m].recettes, depenses: months[m].depenses, marge: months[m].recettes - months[m].depenses }));

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="fisher-link-export-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.end(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: "Export échoué : " + e.message });
  }
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
function deserTrip(r, withExpenses) {
  const base = { ...r, crew: safeParse(r.crew, []), prises: safeParse(r.prises, []),
    gps: (r.gps_lat != null) ? { lat: r.gps_lat, lon: r.gps_lon } : null };
  // durée de la marée en jours (débarquement − départ), minimum 1
  const dd = r.depart_date || r.date, ad = r.arrivee_date || r.date;
  if (dd && ad) {
    const ms = Date.parse(ad) - Date.parse(dd);
    base.duree_jours = isNaN(ms) ? 1 : Math.max(1, Math.round(ms / 86400000) + 1);
  }
  if (withExpenses) {
    // Dépenses liées (carburant, paye…) pour la marge nette — admin uniquement.
    const exp = Expenses.byTrip.all(r.id);
    base.depenses = exp.reduce((s, e) => s + (e.amount || 0), 0);
    base.depenses_detail = exp;
  }
  return base;
}
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

app.listen(PORT, () => {
  console.log(`\n  Pêche Port-Gentil — serveur démarré sur le port ${PORT}`);
  console.log(`  Comptes : admin + pecheur (mots de passe définis dans la config)`);
  console.log(`  NEMO : ${nemoConfigured() ? "configuré" : "non configuré (import manuel)"}\n`);
});
