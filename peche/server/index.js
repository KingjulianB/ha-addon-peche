import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

import { Trips, Tracks, Settings, getSettings, Users, Expenses, Pannes, Entreprises, Pirogues, Invitations, defaultEntrepriseId, db } from "./db.js";
import { trackDistanceKm, trackDurationH } from "./geo.js";
import { nemoConfigured, fetchNemoTrack } from "./nemo.js";
import { nextcloudConfigured, uploadPhoto, downloadPhoto } from "./nextcloud.js";
import {
  ensureAdminAccount, createUser, verifyPassword, createSession, getSession, destroySession, hashPassword,
} from "./auth.js";
import { sendVerification, smtpConfigured } from "./mailer.js";

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

// Nom de l'entreprise par défaut (la tienne) + email admin, depuis la config.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || "";
// Email(s) super-admin (toi, l'éditeur de la plateforme). Peut gérer toutes les entreprises.
const SUPERADMIN_EMAILS = (process.env.SUPERADMIN_EMAILS || ADMIN_EMAIL || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Nomme l'entreprise par défaut si l'admin l'a personnalisée
if (process.env.ENTREPRISE_NOM) {
  const def = defaultEntrepriseId();
  if (def) { try { db.prepare("UPDATE entreprises SET nom = ? WHERE id = ?").run(process.env.ENTREPRISE_NOM, def); } catch {} }
}

// Compte admin de TON entreprise (connexion par email)
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  ensureAdminAccount({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

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

// Entreprise du compte connecté (fallback : entreprise par défaut).
// Étape 1 : une seule entreprise, donc entOf renvoie toujours la même.
function entOf(req) {
  return (req.user && req.user.entreprise_id) || defaultEntrepriseId();
}
// Vérifie qu'une ligne appartient à l'entreprise du compte connecté.
function sameEnt(row, req) {
  return row && row.entreprise_id && row.entreprise_id === entOf(req);
}


function isSuperAdmin(user) {
  return user && user.email && SUPERADMIN_EMAILS.includes(user.email.toLowerCase());
}

app.post("/api/login", (req, res) => {
  const raw = (req.body?.email || req.body?.username || "").trim().toLowerCase();
  const password = req.body?.password || "";
  // Recherche par email, avec repli sur username (compat comptes existants)
  const user = Users.byEmail.get(raw) || Users.byName.get(raw);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: "Email ou mot de passe incorrect." });
  }
  if (user.actif === 0) {
    return res.status(403).json({ error: "Compte désactivé. Contactez l'administrateur." });
  }
  if (user.email_verifie === 0) {
    return res.status(403).json({ error: "Email non vérifié. Vérifiez votre boîte mail (ou le lien fourni)." });
  }
  // Entreprise suspendue ?
  if (user.entreprise_id) {
    const ent = Entreprises.one.get(user.entreprise_id);
    if (ent && ent.statut === "suspendu") {
      return res.status(403).json({ error: "Entreprise suspendue. Contactez l'éditeur." });
    }
  }
  const token = createSession(user);
  const https = req.secure || req.get("x-forwarded-proto") === "https";
  const cookie = https
    ? `session=${token}; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=2592000`
    : `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`;
  res.setHeader("Set-Cookie", cookie);
  res.json({ username: user.username, email: user.email, role: user.role,
    superadmin: isSuperAdmin(user), token });
});

// --- Inscription d'une nouvelle entreprise (création ouverte) ---
app.post("/api/register", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password || "";
  const nom = (req.body?.entreprise || "").trim();
  if (!email || !password || !nom) {
    return res.status(400).json({ error: "Nom d'entreprise, email et mot de passe sont requis." });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "Adresse email invalide." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Mot de passe trop court (6 caractères minimum)." });
  }
  if (Users.byEmail.get(email)) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
  }
  // Crée l'entreprise (tenant) puis son compte admin non vérifié
  const entId = randomUUID();
  Entreprises.insert.run({ id: entId, nom, statut: "actif", email_contact: email, created_at: Date.now() });
  const user = createUser({ email, password, role: "admin", entreprise_id: entId, verifie: false });
  const mail = await sendVerification(email, nom, user.verif_token);
  res.json({ ok: true, email_envoye: mail.sent,
    // en mode sans SMTP, on renvoie le lien pour que l'utilisateur puisse vérifier
    lien_verification: mail.sent ? undefined : mail.url });
});

// --- Vérification de l'email (lien reçu) ---
app.get("/api/verify", (req, res) => {
  const token = String(req.query.token || "");
  const user = token ? Users.byToken.get(token) : null;
  if (!user) return res.status(400).json({ error: "Lien de vérification invalide ou déjà utilisé." });
  Users.verify.run(user.id);
  res.json({ ok: true, email: user.email });
});

app.post("/api/logout", (req, res) => {
  destroySession(parseCookies(req).session);
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Non connecté." });
  const ent = u.entreprise_id ? Entreprises.one.get(u.entreprise_id) : null;
  res.json({ username: u.username, email: u.email, role: u.role,
    superadmin: isSuperAdmin(u), entreprise: ent ? ent.nom : null });
});

// ---------- SUPER-ADMIN (gestion des entreprises) ----------
function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: "Réservé à l'éditeur de la plateforme." });
  next();
}
app.get("/api/entreprises", requireAuth, requireSuperAdmin, (req, res) => {
  const rows = Entreprises.all.all().map((e) => {
    const admin = db.prepare("SELECT email, email_verifie FROM users WHERE entreprise_id = ? AND role = 'admin' LIMIT 1").get(e.id);
    const nbSorties = db.prepare("SELECT COUNT(*) n FROM trips WHERE entreprise_id = ?").get(e.id).n;
    return { ...e, admin_email: admin?.email, admin_verifie: admin?.email_verifie, nb_sorties: nbSorties };
  });
  res.json(rows);
});
app.post("/api/entreprises/:id/statut", requireAuth, requireSuperAdmin, (req, res) => {
  const statut = req.body?.statut === "suspendu" ? "suspendu" : "actif";
  Entreprises.setStatut.run(statut, req.params.id);
  res.json({ ok: true, statut });
});
// Le super-admin peut vérifier manuellement un compte (utile sans SMTP)
app.post("/api/entreprises/:id/verifier", requireAuth, requireSuperAdmin, (req, res) => {
  const admin = db.prepare("SELECT id FROM users WHERE entreprise_id = ? AND role = 'admin' LIMIT 1").get(req.params.id);
  if (admin) Users.verify.run(admin.id);
  res.json({ ok: true });
});

// ---------- PIROGUES (admin de l'entreprise) ----------
app.get("/api/pirogues", requireAuth, (req, res) => {
  res.json(Pirogues.byEnt.all(entOf(req)));
});
app.post("/api/pirogues", requireAuth, requireAdmin, (req, res) => {
  const nom = (req.body?.nom || "").trim();
  if (!nom) return res.status(400).json({ error: "Nom de la pirogue requis." });
  const row = { id: randomUUID(), entreprise_id: entOf(req), nom, actif: 1, created_at: Date.now() };
  Pirogues.insert.run(row);
  res.json(row);
});
app.delete("/api/pirogues/:id", requireAuth, requireAdmin, (req, res) => {
  const cur = Pirogues.one.get(req.params.id);
  if (cur && !sameEnt(cur, req)) return res.status(403).json({ error: "Accès refusé." });
  Pirogues.del.run(req.params.id);
  res.json({ ok: true });
});

// ---------- INVITATIONS PÊCHEURS (admin) ----------
// Génère un code court à communiquer au pêcheur
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans I,O,0,1 (lisibilité)
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
app.get("/api/invitations", requireAuth, requireAdmin, (req, res) => {
  res.json(Invitations.byEnt.all(entOf(req)));
});
app.post("/api/invitations", requireAuth, requireAdmin, (req, res) => {
  let code;
  do { code = genCode(); } while (Invitations.byCode.get(code)); // unicité
  Invitations.insert.run({ code, entreprise_id: entOf(req), role: "pecheur", created_at: Date.now() });
  res.json({ code });
});
app.delete("/api/invitations/:code", requireAuth, requireAdmin, (req, res) => {
  const inv = Invitations.byCode.get(req.params.code);
  if (inv && inv.entreprise_id !== entOf(req)) return res.status(403).json({ error: "Accès refusé." });
  Invitations.del.run(req.params.code);
  res.json({ ok: true });
});

// ---------- REJOINDRE UNE ENTREPRISE (pêcheur, public) ----------
app.post("/api/join", (req, res) => {
  const code = (req.body?.code || "").trim().toUpperCase();
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password || "";
  if (!code || !email || !password) {
    return res.status(400).json({ error: "Code, email et mot de passe requis." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Mot de passe trop court (6 caractères minimum)." });
  }
  const inv = Invitations.byCode.get(code);
  if (!inv) return res.status(404).json({ error: "Code d'invitation invalide." });
  if (inv.utilise) return res.status(409).json({ error: "Ce code a déjà été utilisé." });
  if (Users.byEmail.get(email)) return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
  const ent = Entreprises.one.get(inv.entreprise_id);
  if (!ent || ent.statut === "suspendu") return res.status(403).json({ error: "Entreprise indisponible." });
  // Crée le compte pêcheur, vérifié d'office (le code fait preuve), rattaché à l'entreprise
  createUser({ email, password, role: "pecheur", entreprise_id: inv.entreprise_id, verifie: true });
  Invitations.markUsed.run(Date.now(), code);
  res.json({ ok: true, entreprise: ent.nom });
});

// ---------- SORTIES ----------
app.get("/api/trips", requireAuth, (req, res) => {
  // admin voit tout ; pêcheur ne voit que SES sorties
  const isAdmin = req.user.role === "admin";
  const ent = entOf(req);
  const rows = (isAdmin ? Trips.allByEnt.all(ent) : Trips.byOwnerEnt.all(req.user.username, ent))
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
    photoRef = await savePhoto(b.photo, entOf(req));
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
    entreprise_id: entOf(req),
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
  if (!sameEnt(cur, req)) return res.status(403).json({ error: "Accès refusé." });
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
  if (cur && !sameEnt(cur, req)) return res.status(403).json({ error: "Accès refusé." });
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
  const sess = getSession(token);
  if (!sess) return res.status(401).end();

  const ref = String(req.query.ref || "");
  // Isolation : la photo doit appartenir à l'entreprise du demandeur.
  // (le super-admin peut tout voir pour le support)
  const mySub = (sess.entreprise_id || "commun").replace(/[^a-zA-Z0-9_-]/g, "");
  const superadmin = sess.email && SUPERADMIN_EMAILS.includes(sess.email.toLowerCase());
  function refBelongsToMe(r) {
    if (superadmin) return true;
    if (r.startsWith("nc:")) {
      // nc:CarnetPeche/<sub>/nom  → le 2e segment est le sous-dossier entreprise
      const parts = r.slice(3).split("/");
      return parts.length >= 3 && parts[1] === mySub;
    }
    // local : "<sub>__nom"
    return r.startsWith(mySub + "__");
  }
  if (!refBelongsToMe(ref)) return res.status(403).end();

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
app.get("/api/tracks", requireAuth, (req, res) => res.json(Tracks.allByEnt.all(entOf(req))));
app.get("/api/tracks/:id", requireAuth, (req, res) => {
  const t = Tracks.one.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Trace introuvable." });
  t.points = JSON.parse(t.points); res.json(t);
});

function saveTrack({ points, date, depart, retour, source, entreprise_id }) {
  if (!Array.isArray(points) || points.length < 2) throw new Error("Trace invalide (moins de 2 points).");
  const row = {
    id: randomUUID(),
    date: date || (points[0].t ? points[0].t.slice(0, 10) : new Date().toISOString().slice(0, 10)),
    depart: depart || "", retour: retour || "",
    points: JSON.stringify(points),
    dist_km: +trackDistanceKm(points).toFixed(2),
    duree_h: +trackDurationH(points).toFixed(2),
    source: source || "manuel", entreprise_id: entreprise_id || null, created_at: Date.now(),
  };
  Tracks.insert.run(row); return row;
}
app.post("/api/tracks", requireAuth, (req, res) => {
  try { const r = saveTrack({ ...req.body, source: "manuel", entreprise_id: entOf(req) }); res.json({ id: r.id, dist_km: r.dist_km, duree_h: r.duree_h, date: r.date }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/tracks/:id", requireAuth, requireAdmin, (req, res) => { const c = Tracks.one.get(req.params.id); if (c && !sameEnt(c, req)) return res.status(403).json({ error: "Accès refusé." }); Tracks.del.run(req.params.id); res.json({ ok: true }); });
app.post("/api/tracks/:id/validate", requireAuth, requireAdmin, (req, res) => { const c = Tracks.one.get(req.params.id); if (c && !sameEnt(c, req)) return res.status(403).json({ error: "Accès refusé." }); Tracks.validate.run(req.params.id); res.json({ ok: true }); });

app.get("/api/nemo/status", requireAuth, (req, res) => res.json({ configured: nemoConfigured() }));
app.post("/api/nemo/sync", requireAuth, async (req, res) => {
  try { const { since, until } = req.body || {}; const points = await fetchNemoTrack(since, until); const r = saveTrack({ points, source: "nemo", entreprise_id: entOf(req) }); res.json({ ok: true, id: r.id, points: points.length, dist_km: r.dist_km }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- RÉGLAGES (admin pour modifier) ----------
app.get("/api/settings", requireAuth, (req, res) => res.json(getSettings()));
app.put("/api/settings", requireAuth, requireAdmin, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) Settings.set.run(k, String(v));
  res.json(getSettings());
});

// ---------- DÉPENSES (admin uniquement) ----------
const EXPENSE_TYPES = ["carburant", "paye", "materiel", "transport", "licence", "panne", "autre"];

app.get("/api/expenses", requireAuth, requireAdmin, (req, res) => {
  res.json(Expenses.allByEnt.all(entOf(req)));
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
    entreprise_id: entOf(req),
    created_at: Date.now(),
  };
  Expenses.insert.run(row);
  res.json(row);
});

app.delete("/api/expenses/:id", requireAuth, requireAdmin, (req, res) => {
  Expenses.del.run(req.params.id);
  res.json({ ok: true });
});

// ---------- PANNES (admin uniquement) ----------
app.get("/api/pannes", requireAuth, requireAdmin, (req, res) => {
  res.json(Pannes.allByEnt.all(entOf(req)).map((p) => ({ ...p, photos: safeParse(p.photos, []) })));
});

app.post("/api/pannes", requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.titre || !b.date) return res.status(400).json({ error: "Titre et date requis." });
  // Enregistre les photos (0..plusieurs), même logique que les prises
  const photoRefs = [];
  try {
    for (const ph of (b.photos || [])) {
      if (ph) photoRefs.push(await savePhoto(ph, entOf(req)));
    }
  } catch (e) { return res.status(400).json({ error: "Photo invalide : " + e.message }); }

  const cout = parseFloat(b.cout) || 0;
  const id = randomUUID();
  const ent = entOf(req);
  const row = {
    id, date: b.date, titre: b.titre.trim(), constat: (b.constat || "").trim(),
    cout, statut: b.statut === "reparee" ? "reparee" : "ouverte",
    photos: JSON.stringify(photoRefs), expense_id: null, entreprise_id: ent, created_at: Date.now(),
  };
  Pannes.insert.run(row);

  // Si un coût est renseigné, crée automatiquement une dépense de type "panne"
  if (cout > 0) {
    const exp = { id: randomUUID(), date: b.date, type: "panne",
      label: "Réparation : " + row.titre, amount: cout, trip_id: null, entreprise_id: ent, created_at: Date.now() };
    Expenses.insert.run(exp);
    Pannes.setExpense.run(exp.id, id);
    row.expense_id = exp.id;
  }
  res.json({ ...row, photos: photoRefs });
});

app.put("/api/pannes/:id", requireAuth, requireAdmin, (req, res) => {
  const cur = Pannes.one.get(req.params.id);
  if (!cur) return res.status(404).json({ error: "Panne introuvable." });
  if (!sameEnt(cur, req)) return res.status(403).json({ error: "Accès refusé." });
  const b = req.body || {};
  const cout = b.cout != null ? (parseFloat(b.cout) || 0) : cur.cout;
  Pannes.update.run({
    id: cur.id, titre: b.titre ?? cur.titre, constat: b.constat ?? cur.constat,
    cout, statut: b.statut ?? cur.statut,
  });
  // synchronise la dépense liée : si coût change et une dépense existe, on la recrée
  if (cur.expense_id) Expenses.del.run(cur.expense_id);
  if (cout > 0) {
    const exp = { id: randomUUID(), date: cur.date, type: "panne",
      label: "Réparation : " + (b.titre ?? cur.titre), amount: cout, trip_id: null, entreprise_id: cur.entreprise_id || entOf(req), created_at: Date.now() };
    Expenses.insert.run(exp);
    Pannes.setExpense.run(exp.id, cur.id);
  } else {
    Pannes.setExpense.run(null, cur.id);
  }
  const updated = Pannes.one.get(cur.id);
  res.json({ ...updated, photos: safeParse(updated.photos, []) });
});

app.delete("/api/pannes/:id", requireAuth, requireAdmin, (req, res) => {
  const cur = Pannes.one.get(req.params.id);
  if (cur && !sameEnt(cur, req)) return res.status(403).json({ error: "Accès refusé." });
  if (cur) {
    // supprime les photos locales et la dépense liée
    safeParse(cur.photos, []).forEach((ph) => {
      if (ph && !ph.startsWith("nc:")) { try { unlinkSync(join(PHOTO_DIR, ph)); } catch {} }
    });
    if (cur.expense_id) Expenses.del.run(cur.expense_id);
  }
  Pannes.del.run(req.params.id);
  res.json({ ok: true });
});

// ---------- TRÉSORERIE (admin) ----------
app.get("/api/tresorerie", requireAuth, requireAdmin, (req, res) => {
  const trips = Trips.allByEnt.all(entOf(req)).map((r) => deserTrip(r, false));
  const recettes = trips.reduce((s, t) =>
    s + (t.prises || []).reduce((a, p) => a + (p.kg || 0) * (p.prix || 0), 0), 0);
  const depenses = Expenses.allByEnt.all(entOf(req)).reduce((s, e) => s + (e.amount || 0), 0);
  res.json({ recettes, depenses, solde: recettes - depenses });
});

// ---------- BILAN (données agrégées par mois, admin) ----------
app.get("/api/bilan", requireAuth, requireAdmin, (req, res) => {
  const trips = Trips.allByEnt.all(entOf(req)).map((r) => deserTrip(r, true));
  const expenses = Expenses.allByEnt.all(entOf(req));
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

    const trips = Trips.allByEnt.all(entOf(req)).map((r) => deserTrip(r, true));
    const expenses = Expenses.allByEnt.all(entOf(req));
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
// La page de vérification (/verifier?token=...) sert l'appli (SPA)
app.get("/verifier", (req, res) => res.sendFile(join(__dirname, "..", "public", "index.html")));
app.use(express.static(join(__dirname, "..", "public")));

// ---------- helpers ----------
async function savePhoto(dataUrl, entrepriseId) {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error("format non reconnu");
  const ext = m[1].toLowerCase().replace("jpeg", "jpg");
  const mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 8 * 1024 * 1024) throw new Error("image trop lourde (max 8 Mo)");
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  // sous-dossier = entreprise (isolation) ; on nettoie l'id pour un chemin sûr
  const sub = (entrepriseId || "commun").replace(/[^a-zA-Z0-9_-]/g, "");

  // 1) Tente Nextcloud si configuré, dans le sous-dossier de l'entreprise
  if (nextcloudConfigured()) {
    try {
      const remotePath = await uploadPhoto(name, buf, mime, sub);
      return "nc:" + remotePath;           // préfixe = stockée sur Nextcloud
    } catch (e) {
      console.warn("Nextcloud indisponible, repli local :", e.message);
      // on continue vers le stockage local
    }
  }
  // 2) Repli local : préfixe le nom par l'entreprise pour tracer l'appartenance
  const localName = `${sub}__${name}`;
  writeFileSync(join(PHOTO_DIR, localName), buf);
  return localName;                          // pas de préfixe nc: = locale
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
