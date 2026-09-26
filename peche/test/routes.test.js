import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests d'intégration : on démarre le VRAI serveur Express (server/index.js,
// export par défaut `app`, écoute gardée par un contrôle "exécuté en script
// direct" — voir en bas de ce fichier) en process, sur une base SQLite
// temporaire, et on l'interroge en HTTP comme le ferait le frontend. Zéro
// mock des routes : c'est l'app réelle, juste sur un port de test.
const tmpDir = mkdtempSync(join(tmpdir(), "peche-routes-test-"));

const ADMIN_EMAIL = "admin@test.local";
const ADMIN_PASSWORD = "AdminPass1";
// PNG 1×1 minimal (transparent) : suffisant, /api/trips exige juste un data URL valide.
const PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

process.env.DB_PATH = join(tmpDir, "peche.db");
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.SUPERADMIN_EMAILS = "";
process.env.APP_BASE_URL = "";
// Simulé (pas de vraie intégration externe) pour ce test de routes :
process.env.SMTP_HOST = ""; process.env.SMTP_USER = ""; process.env.SMTP_PASSWORD = "";
process.env.NEXTCLOUD_URL = ""; process.env.NEXTCLOUD_USER = ""; process.env.NEXTCLOUD_PASSWORD = "";
process.env.NEMO_API_URL = ""; process.env.NEMO_API_KEY = ""; process.env.NEMO_DEVICE_ID = "";
process.env.TELEGRAM_BOT_TOKEN = ""; process.env.TELEGRAM_BOT_USERNAME = ""; process.env.TELEGRAM_WEBHOOK_SECRET = "";

const { default: app } = await import("../server/index.js");
const { db } = await import("../server/db.js");

let server, BASE;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close(); // sinon le fichier .db reste verrouillé sous Windows (EBUSY)
  rmSync(tmpDir, { recursive: true, force: true });
});

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// État partagé entre les tests, construit progressivement (inscription,
// vérification, connexions...) — reflète un vrai scénario multi-entreprises.
const ctx = {};

describe("authentification", () => {
  test("sans jeton, les routes protégées répondent 401", async () => {
    const r = await api("GET", "/api/me");
    assert.equal(r.status, 401);
  });

  test("mauvais mot de passe → message générique (anti-énumération)", async () => {
    const r = await api("POST", "/api/login", { body: { email: ADMIN_EMAIL, password: "mauvais" } });
    assert.equal(r.status, 401);
    ctx.genericLoginError = r.json.error;
    assert.ok(ctx.genericLoginError);
  });

  test("email inconnu → EXACTEMENT le même message (pas d'énumération d'emails)", async () => {
    const r = await api("POST", "/api/login", { body: { email: "personne@test.local", password: "mauvais" } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, ctx.genericLoginError);
  });

  test("identifiants corrects (bootstrap ADMIN_EMAIL/ADMIN_PASSWORD) → jeton", async () => {
    const r = await api("POST", "/api/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
    assert.equal(r.json.superadmin, true); // SUPERADMIN_EMAILS retombe sur ADMIN_EMAIL par défaut
    ctx.tokenA = r.json.token;
  });

  test("/api/me avec un jeton valide renvoie l'identité", async () => {
    const r = await api("GET", "/api/me", { token: ctx.tokenA });
    assert.equal(r.status, 200);
    assert.equal(r.json.email, ADMIN_EMAIL);
  });
});

describe("validation de l'inscription", () => {
  test("champs manquants → 400", async () => {
    const r = await api("POST", "/api/register", { body: { entreprise: "", email: "", password: "" } });
    assert.equal(r.status, 400);
  });
  test("email invalide → 400", async () => {
    const r = await api("POST", "/api/register", { body: { entreprise: "X", email: "pas-un-email", password: "azertyui" } });
    assert.equal(r.status, 400);
  });
  test("mot de passe trop court → 400", async () => {
    const r = await api("POST", "/api/register", { body: { entreprise: "X", email: "court@test.local", password: "abc" } });
    assert.equal(r.status, 400);
  });
});

describe("compte désactivé", () => {
  test("un compte désactivé (actif=0) ne peut pas se connecter", async () => {
    const { Users } = await import("../server/db.js");
    const row = Users.byEmail.get(ADMIN_EMAIL);
    Users.setActif.run(0, row.id);
    const r = await api("POST", "/api/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    assert.equal(r.status, 403);
    Users.setActif.run(1, row.id); // remis en état pour la suite des tests
  });
});

describe("multi-entreprises (tenant B)", () => {
  test("inscription d'une nouvelle entreprise (non vérifiée)", async () => {
    const r = await api("POST", "/api/register", {
      body: { entreprise: "Entreprise B", email: "adminb@test.local", password: "AdminBPass1" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.email_envoye, false); // SMTP non configuré → simulé
    assert.ok(r.json.lien_verification); // lien fourni manuellement
  });

  test("le super-admin voit la nouvelle entreprise, non vérifiée", async () => {
    const r = await api("GET", "/api/entreprises", { token: ctx.tokenA });
    assert.equal(r.status, 200);
    const entB = r.json.find((e) => e.nom === "Entreprise B");
    assert.ok(entB);
    assert.equal(entB.admin_verifie, 0);
    ctx.entB = entB;
  });

  test("le super-admin peut vérifier manuellement le compte (sans SMTP)", async () => {
    const r = await api("POST", `/api/entreprises/${ctx.entB.id}/verifier`, { token: ctx.tokenA });
    assert.equal(r.status, 200);
  });

  test("l'admin B peut maintenant se connecter", async () => {
    const r = await api("POST", "/api/login", { body: { email: "adminb@test.local", password: "AdminBPass1" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.superadmin, false);
    ctx.tokenB = r.json.token;
  });
});

describe("isolation multi-tenant : dépenses liées à une sortie", () => {
  test("l'entreprise A crée une sortie (avec photo)", async () => {
    const r = await api("POST", "/api/trips", {
      token: ctx.tokenA,
      body: { arrivee_date: "2026-01-10", prises: [{ esp: "Sole", kg: 3 }], photo: PIXEL_PNG },
    });
    assert.equal(r.status, 200);
    ctx.tripA = r.json;
  });

  test("l'entreprise B ne peut PAS rattacher une dépense à la sortie de l'entreprise A", async () => {
    const r = await api("POST", "/api/expenses", {
      token: ctx.tokenB,
      body: { date: "2026-01-10", type: "carburant", amount: 1000, trip_id: ctx.tripA.id },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /sortie invalide/i);
  });

  test("l'entreprise A peut normalement rattacher une dépense à SA propre sortie", async () => {
    const r = await api("POST", "/api/expenses", {
      token: ctx.tokenA,
      body: { date: "2026-01-10", type: "carburant", amount: 1000, trip_id: ctx.tripA.id },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.trip_id, ctx.tripA.id);
    ctx.expenseA = r.json;
  });

  test("validation à la création d'une dépense (champs requis, type valide)", async () => {
    const missing = await api("POST", "/api/expenses", { token: ctx.tokenA, body: { type: "carburant", amount: 1 } });
    assert.equal(missing.status, 400);
    const badType = await api("POST", "/api/expenses", { token: ctx.tokenA, body: { date: "2026-01-10", type: "bidon", amount: 1 } });
    assert.equal(badType.status, 400);
  });

  test("l'entreprise B ne peut pas supprimer une dépense de l'entreprise A", async () => {
    const r = await api("DELETE", `/api/expenses/${ctx.expenseA.id}`, { token: ctx.tokenB });
    assert.equal(r.status, 403);
  });
});

describe("validation et cycle de vie d'une sortie", () => {
  test("date de débarquement et captures requises", async () => {
    const r = await api("POST", "/api/trips", { token: ctx.tokenA, body: { photo: PIXEL_PNG, prises: [] } });
    assert.equal(r.status, 400);
  });

  test("photo obligatoire", async () => {
    const r = await api("POST", "/api/trips", { token: ctx.tokenA, body: { arrivee_date: "2026-01-11", prises: [{ esp: "Sole", kg: 1 }] } });
    assert.equal(r.status, 400);
  });

  test("photo mal formée → 400", async () => {
    const r = await api("POST", "/api/trips", { token: ctx.tokenA, body: { arrivee_date: "2026-01-11", prises: [{ esp: "Sole", kg: 1 }], photo: "pas-une-data-url" } });
    assert.equal(r.status, 400);
  });

  test("un admin peut modifier une sortie de son entreprise", async () => {
    const r = await api("PUT", `/api/trips/${ctx.tripA.id}`, { token: ctx.tokenA, body: { zone: "Zone corrigée" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.zone, "Zone corrigée");
  });

  test("l'entreprise B ne peut ni modifier ni supprimer la sortie de A", async () => {
    const put = await api("PUT", `/api/trips/${ctx.tripA.id}`, { token: ctx.tokenB, body: { zone: "Piraté" } });
    assert.equal(put.status, 403);
    const del = await api("DELETE", `/api/trips/${ctx.tripA.id}`, { token: ctx.tokenB });
    assert.equal(del.status, 403);
  });

  test("modifier une sortie inexistante → 404", async () => {
    const r = await api("PUT", "/api/trips/inexistant", { token: ctx.tokenA, body: { zone: "x" } });
    assert.equal(r.status, 404);
  });

  test("la photo de la sortie est servie via /api/photo avec le bon jeton", async () => {
    const trip = await api("GET", "/api/trips", { token: ctx.tokenA });
    const t = trip.json.find((x) => x.id === ctx.tripA.id);
    const res = await fetch(`${BASE}/api/photo?ref=${encodeURIComponent(t.photo)}`, { headers: { Authorization: "Bearer " + ctx.tokenA } });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0);
  });
});

describe("codes d'invitation et rôle pêcheur", () => {
  test("le code généré respecte l'alphabet lisible (sans I,O,0,1)", async () => {
    const r = await api("POST", "/api/invitations", { token: ctx.tokenA });
    assert.equal(r.status, 200);
    assert.match(r.json.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    ctx.inviteCode = r.json.code;
  });

  test("un code bidon est refusé", async () => {
    const r = await api("POST", "/api/join", { body: { code: "ZZZZZZ", email: "x@test.local", password: "PecheurPass1" } });
    assert.equal(r.status, 404);
  });

  test("un code valide crée le compte pêcheur (vérifié d'office)", async () => {
    const r = await api("POST", "/api/join", { body: { code: ctx.inviteCode, email: "pecheur@test.local", password: "PecheurPass1" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.entreprise, "Mon entreprise");
  });

  test("le pêcheur peut se connecter", async () => {
    const r = await api("POST", "/api/login", { body: { email: "pecheur@test.local", password: "PecheurPass1" } });
    assert.equal(r.status, 200);
    ctx.tokenPecheur = r.json.token;
  });

  test("un pêcheur ne peut pas créer de dépense (réservé admin)", async () => {
    const r = await api("POST", "/api/expenses", { token: ctx.tokenPecheur, body: { date: "2026-01-10", type: "autre", amount: 1 } });
    assert.equal(r.status, 403);
  });

  test("un pêcheur n'est pas super-admin", async () => {
    const r = await api("GET", "/api/entreprises", { token: ctx.tokenPecheur });
    assert.equal(r.status, 403);
  });

  test("l'entreprise B ne peut pas supprimer un code d'invitation de l'entreprise A", async () => {
    const code = await api("POST", "/api/invitations", { token: ctx.tokenA });
    const r = await api("DELETE", `/api/invitations/${code.json.code}`, { token: ctx.tokenB });
    assert.equal(r.status, 403);
  });

  test("l'entreprise A peut supprimer son propre code d'invitation", async () => {
    const code = await api("POST", "/api/invitations", { token: ctx.tokenA });
    const r = await api("DELETE", `/api/invitations/${code.json.code}`, { token: ctx.tokenA });
    assert.equal(r.status, 200);
  });
});

describe("jeton photo à portée réduite", () => {
  test("un utilisateur authentifié peut obtenir un jeton photo", async () => {
    const r = await api("GET", "/api/photo-token", { token: ctx.tokenB });
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
    ctx.photoTokenB = r.json.token;
  });

  test("le jeton photo est accepté par /api/photo (403 pour mauvaise référence = auth OK, isolation appliquée)", async () => {
    const res = await fetch(`${BASE}/api/photo?ref=bidon__x.jpg&t=${encodeURIComponent(ctx.photoTokenB)}`);
    assert.equal(res.status, 403); // pas 401 : le jeton photo est bien reconnu
  });

  test("le jeton photo n'est PAS accepté comme jeton de session ailleurs", async () => {
    const r = await api("GET", "/api/trips", { token: ctx.photoTokenB });
    assert.equal(r.status, 401);
  });

  test("sans jeton du tout, /api/photo répond 401", async () => {
    const res = await fetch(`${BASE}/api/photo?ref=bidon__x.jpg`);
    assert.equal(res.status, 401);
  });
});

describe("pirogues", () => {
  test("liste vide au départ, puis création", async () => {
    const empty = await api("GET", "/api/pirogues", { token: ctx.tokenA });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.length, 0);

    const created = await api("POST", "/api/pirogues", { token: ctx.tokenA, body: { nom: "GA-PG-0001" } });
    assert.equal(created.status, 200);
    assert.equal(created.json.nom, "GA-PG-0001");
    ctx.pirogue = created.json;
  });

  test("nom vide refusé", async () => {
    const r = await api("POST", "/api/pirogues", { token: ctx.tokenA, body: { nom: "  " } });
    assert.equal(r.status, 400);
  });

  test("l'entreprise B ne peut pas supprimer une pirogue de l'entreprise A", async () => {
    const r = await api("DELETE", `/api/pirogues/${ctx.pirogue.id}`, { token: ctx.tokenB });
    assert.equal(r.status, 403);
  });

  test("l'entreprise A peut supprimer sa propre pirogue", async () => {
    const r = await api("DELETE", `/api/pirogues/${ctx.pirogue.id}`, { token: ctx.tokenA });
    assert.equal(r.status, 200);
  });
});

describe("config NEMO par pirogue (super-admin uniquement)", () => {
  test("prépare une pirogue pour l'entreprise B", async () => {
    const r = await api("POST", "/api/pirogues", { token: ctx.tokenB, body: { nom: "GA-PG-9999" } });
    assert.equal(r.status, 200);
    ctx.pirogueB = r.json;
  });

  test("un admin d'entreprise (non super-admin) n'y a pas accès", async () => {
    const get = await api("GET", `/api/entreprises/${ctx.entB.id}/pirogues`, { token: ctx.tokenB });
    assert.equal(get.status, 403);
    const put = await api("PUT", `/api/entreprises/${ctx.entB.id}/pirogues/${ctx.pirogueB.id}/nemo`, {
      token: ctx.tokenB, body: { nemo_api_key: "x" },
    });
    assert.equal(put.status, 403);
  });

  test("un pêcheur n'y a pas accès", async () => {
    const r = await api("GET", `/api/entreprises/${ctx.entB.id}/pirogues`, { token: ctx.tokenPecheur });
    assert.equal(r.status, 403);
  });

  test("le super-admin liste les pirogues d'une AUTRE entreprise, sans clé configurée au départ", async () => {
    const r = await api("GET", `/api/entreprises/${ctx.entB.id}/pirogues`, { token: ctx.tokenA });
    assert.equal(r.status, 200);
    const p = r.json.find((x) => x.id === ctx.pirogueB.id);
    assert.ok(p);
    assert.equal(p.nemo_api_key_set, false);
  });

  test("le super-admin configure la balise NEMO de cette pirogue", async () => {
    const r = await api("PUT", `/api/entreprises/${ctx.entB.id}/pirogues/${ctx.pirogueB.id}/nemo`, {
      token: ctx.tokenA,
      body: { nemo_api_url: "https://cls.example/api", nemo_api_key: "secret-clef-nemo", nemo_device_id: "BALISE-42" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.nemo_api_key_set, true);
  });

  test("la clé en clair n'apparaît JAMAIS dans la réponse (seulement un booléen)", async () => {
    const res = await fetch(`${BASE}/api/entreprises/${ctx.entB.id}/pirogues`, { headers: { Authorization: "Bearer " + ctx.tokenA } });
    const text = await res.text();
    assert.ok(!text.includes("secret-clef-nemo"));
    const json = JSON.parse(text);
    const p = json.find((x) => x.id === ctx.pirogueB.id);
    assert.equal(p.nemo_api_key_set, true);
    assert.equal(p.nemo_api_url, "https://cls.example/api");
    assert.equal(p.nemo_device_id, "BALISE-42");
  });

  test("un PUT avec une clé vide conserve la clé déjà enregistrée", async () => {
    const r = await api("PUT", `/api/entreprises/${ctx.entB.id}/pirogues/${ctx.pirogueB.id}/nemo`, {
      token: ctx.tokenA,
      body: { nemo_api_url: "https://cls.example/api-v2", nemo_api_key: "", nemo_device_id: "BALISE-42" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.nemo_api_key_set, true); // toujours configurée, pas effacée par le champ vide

    const list = await api("GET", `/api/entreprises/${ctx.entB.id}/pirogues`, { token: ctx.tokenA });
    const p = list.json.find((x) => x.id === ctx.pirogueB.id);
    assert.equal(p.nemo_api_url, "https://cls.example/api-v2"); // les autres champs, eux, sont bien mis à jour
  });

  test("pirogue d'une autre entreprise que celle de l'URL → 404", async () => {
    const r = await api("PUT", `/api/entreprises/${ctx.entB.id}/pirogues/${ctx.tripA.id}/nemo`, {
      token: ctx.tokenA, body: { nemo_api_key: "x" },
    });
    assert.equal(r.status, 404);
  });
});

describe("traces VMS (tracks)", () => {
  test("une trace de moins de 2 points est invalide", async () => {
    const r = await api("POST", "/api/tracks", { token: ctx.tokenA, body: { points: [{ lat: 0, lon: 0, t: "2026-01-01T00:00:00Z" }] } });
    assert.equal(r.status, 400);
  });

  test("crée une trace manuelle et calcule distance/durée", async () => {
    const points = [
      { lat: 0, lon: 0, t: "2026-01-01T08:00:00Z" },
      { lat: 0, lon: 0.1, t: "2026-01-01T09:00:00Z" },
    ];
    const r = await api("POST", "/api/tracks", { token: ctx.tokenA, body: { points, date: "2026-01-01" } });
    assert.equal(r.status, 200);
    assert.ok(r.json.dist_km > 0);
    assert.equal(r.json.duree_h, 1);
    ctx.trackA = r.json;
  });

  test("liste et détail de la trace", async () => {
    const list = await api("GET", "/api/tracks", { token: ctx.tokenA });
    assert.equal(list.status, 200);
    assert.ok(list.json.some((t) => t.id === ctx.trackA.id));

    const one = await api("GET", `/api/tracks/${ctx.trackA.id}`, { token: ctx.tokenA });
    assert.equal(one.status, 200);
    assert.equal(Array.isArray(one.json.points), true);
  });

  test("l'entreprise B ne peut ni voir ni valider/supprimer la trace de A", async () => {
    const get = await api("GET", `/api/tracks/${ctx.trackA.id}`, { token: ctx.tokenB });
    assert.equal(get.status, 403);
    const val = await api("POST", `/api/tracks/${ctx.trackA.id}/validate`, { token: ctx.tokenB });
    assert.equal(val.status, 403);
    const del = await api("DELETE", `/api/tracks/${ctx.trackA.id}`, { token: ctx.tokenB });
    assert.equal(del.status, 403);
  });

  test("l'admin propriétaire peut valider puis supprimer sa trace", async () => {
    const val = await api("POST", `/api/tracks/${ctx.trackA.id}/validate`, { token: ctx.tokenA });
    assert.equal(val.status, 200);
    const del = await api("DELETE", `/api/tracks/${ctx.trackA.id}`, { token: ctx.tokenA });
    assert.equal(del.status, 200);
  });

  test("NEMO non configuré dans ce test → /api/nemo/status et /sync le reflètent", async () => {
    const status = await api("GET", "/api/nemo/status", { token: ctx.tokenA });
    assert.equal(status.status, 200);
    assert.equal(status.json.configured, false);
    const sync = await api("POST", "/api/nemo/sync", { token: ctx.tokenA, body: {} });
    assert.equal(sync.status, 400);
  });
});

describe("réglages", () => {
  test("valeurs par défaut lisibles par tout compte authentifié", async () => {
    const r = await api("GET", "/api/settings", { token: ctx.tokenPecheur });
    assert.equal(r.status, 200);
    assert.equal(r.json.fuel_mode, "hour");
  });

  test("un pêcheur ne peut pas modifier les réglages", async () => {
    const r = await api("PUT", "/api/settings", { token: ctx.tokenPecheur, body: { fuel_prix: "999" } });
    assert.equal(r.status, 403);
  });

  test("l'admin peut modifier les réglages", async () => {
    const r = await api("PUT", "/api/settings", { token: ctx.tokenA, body: { fuel_prix: "800" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.fuel_prix, "800");
  });
});

describe("identification automatique et estimation de poids", () => {
  test("/api/identify-photo/status reflète la présence du modèle", async () => {
    const r = await api("GET", "/api/identify-photo/status", { token: ctx.tokenA });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.configured, "boolean");
  });

  test("/api/identify-photo sans photo → 400", async () => {
    const r = await api("POST", "/api/identify-photo", { token: ctx.tokenA, body: {} });
    assert.equal(r.status, 400);
  });

  test("/api/estimate-weight calcule un poids par allométrie", async () => {
    const r = await api("POST", "/api/estimate-weight", { token: ctx.tokenA, body: { espece: "Ethmalose", longueur_cm: 20 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.methode, "allometrie");
  });

  test("/api/estimate-weight sans paramètres → 400", async () => {
    const r = await api("POST", "/api/estimate-weight", { token: ctx.tokenA, body: {} });
    assert.equal(r.status, 400);
  });
});

describe("pannes (avec dépense liée automatique)", () => {
  test("une panne avec coût crée une dépense liée", async () => {
    const r = await api("POST", "/api/pannes", { token: ctx.tokenA, body: { date: "2026-01-15", titre: "Moteur", constat: "Fuite", cout: 5000 } });
    assert.equal(r.status, 200);
    assert.ok(r.json.expense_id);
    ctx.panne = r.json;
  });

  test("la liste des dépenses inclut bien la dépense de type panne", async () => {
    const r = await api("GET", "/api/expenses", { token: ctx.tokenA });
    assert.equal(r.status, 200);
    assert.ok(r.json.some((e) => e.id === ctx.panne.expense_id && e.type === "panne"));
  });

  test("modifier le coût resynchronise la dépense liée", async () => {
    const r = await api("PUT", `/api/pannes/${ctx.panne.id}`, { token: ctx.tokenA, body: { cout: 7000, statut: "reparee" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.statut, "reparee");
    assert.notEqual(r.json.expense_id, ctx.panne.expense_id); // recréée, pas juste modifiée
    const exp = await api("GET", "/api/expenses", { token: ctx.tokenA });
    const linked = exp.json.find((e) => e.id === r.json.expense_id);
    assert.equal(linked.amount, 7000);
    assert.equal(exp.json.some((e) => e.id === ctx.panne.expense_id), false); // l'ancienne dépense a été supprimée
    ctx.panne = r.json;
  });

  test("l'entreprise B ne peut pas voir/modifier la panne de A", async () => {
    const r = await api("PUT", `/api/pannes/${ctx.panne.id}`, { token: ctx.tokenB, body: { cout: 1 } });
    assert.equal(r.status, 403);
  });

  test("supprimer la panne supprime aussi la dépense liée", async () => {
    const del = await api("DELETE", `/api/pannes/${ctx.panne.id}`, { token: ctx.tokenA });
    assert.equal(del.status, 200);
    const exp = await api("GET", "/api/expenses", { token: ctx.tokenA });
    assert.equal(exp.json.some((e) => e.id === ctx.panne.expense_id), false);
  });
});

describe("trésorerie, bilan et export", () => {
  test("/api/tresorerie agrège recettes/dépenses/solde", async () => {
    const r = await api("GET", "/api/tresorerie", { token: ctx.tokenA });
    assert.equal(r.status, 200);
    assert.equal(r.json.solde, r.json.recettes - r.json.depenses);
  });

  test("/api/bilan agrège par mois et par type de dépense", async () => {
    const r = await api("GET", "/api/bilan", { token: ctx.tokenA });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.parMois));
    assert.ok(r.json.parType.carburant > 0);
  });

  test("/api/export.xlsx renvoie un classeur Excel", async () => {
    const res = await fetch(`${BASE}/api/export.xlsx`, { headers: { Authorization: "Bearer " + ctx.tokenA } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /spreadsheetml/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0);
  });
});

describe("vérification d'email et réinitialisation de mot de passe", () => {
  test("cycle complet : inscription → lien de vérification → connexion possible", async () => {
    const reg = await api("POST", "/api/register", { body: { entreprise: "Entreprise C", email: "adminc@test.local", password: "AdminCPass1" } });
    assert.equal(reg.status, 200);
    const token = new URL(reg.json.lien_verification, "http://x").searchParams.get("token");
    assert.ok(token);

    const before = await api("POST", "/api/login", { body: { email: "adminc@test.local", password: "AdminCPass1" } });
    assert.equal(before.status, 403); // email pas encore vérifié

    const verify = await api("GET", `/api/verify?token=${encodeURIComponent(token)}`);
    assert.equal(verify.status, 200);

    const after = await api("POST", "/api/login", { body: { email: "adminc@test.local", password: "AdminCPass1" } });
    assert.equal(after.status, 200);
  });

  test("un jeton de vérification bidon est refusé", async () => {
    const r = await api("GET", "/api/verify?token=bidon");
    assert.equal(r.status, 400);
  });

  test("cycle complet de réinitialisation de mot de passe", async () => {
    const forgot = await api("POST", "/api/forgot-password", { body: { email: "adminc@test.local" } });
    assert.equal(forgot.status, 200);
    assert.ok(forgot.json.lien_reinitialisation);
    const token = new URL(forgot.json.lien_reinitialisation, "http://x").searchParams.get("token");

    const reset = await api("POST", "/api/reset-password", { body: { token, password: "NouveauPass1" } });
    assert.equal(reset.status, 200);

    const oldPw = await api("POST", "/api/login", { body: { email: "adminc@test.local", password: "AdminCPass1" } });
    assert.equal(oldPw.status, 401);
    const newPw = await api("POST", "/api/login", { body: { email: "adminc@test.local", password: "NouveauPass1" } });
    assert.equal(newPw.status, 200);
  });

  test("email inconnu → réponse générique identique (pas d'énumération)", async () => {
    const r = await api("POST", "/api/forgot-password", { body: { email: "personne@test.local" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.lien_reinitialisation, undefined);
  });
});

describe("Telegram (non configuré dans ce test) + rattachement d'une photo en attente", () => {
  test("/api/telegram/status reflète l'absence de configuration", async () => {
    const r = await api("GET", "/api/telegram/status", { token: ctx.tokenA });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { configured: false, botUsername: "", linked: false });
  });

  test("/api/telegram/pairing-code refuse tant que le bot n'est pas configuré", async () => {
    const r = await api("POST", "/api/telegram/pairing-code", { token: ctx.tokenA });
    assert.equal(r.status, 400);
  });

  test("le webhook répond 404 tant que le bot n'est pas configuré", async () => {
    const r = await api("POST", "/api/telegram/webhook", { body: { message: {} } });
    assert.equal(r.status, 404);
  });

  test("l'identification depuis la Mini App refuse tant que le bot n'est pas configuré", async () => {
    const r = await api("POST", "/api/telegram/miniapp-identify", { body: { initData: "x", photo: "x" } });
    assert.equal(r.status, 400);
  });

  test("POST /api/trips avec un photoRef inconnu → 400", async () => {
    const r = await api("POST", "/api/trips", {
      token: ctx.tokenA,
      body: { arrivee_date: "2026-02-01", prises: [{ esp: "Bar", kg: 2, prix: 1000 }], photoRef: "inconnu" },
    });
    assert.equal(r.status, 400);
  });

  test("POST /api/trips avec un photoRef valide consomme la photo en attente", async () => {
    const { Users, PendingPhotos } = await import("../server/db.js");
    const admin = Users.byEmail.get(ADMIN_EMAIL);
    const pendingId = "pp-test-1";
    PendingPhotos.insert.run({ id: pendingId, entreprise_id: admin.entreprise_id, user_id: admin.id, photo_ref: "commun__deja-stockee.jpg", created_at: Date.now() });

    const r = await api("POST", "/api/trips", {
      token: ctx.tokenA,
      body: { arrivee_date: "2026-02-01", prises: [{ esp: "Bar", kg: 2, prix: 1000 }], photoRef: pendingId },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.photo, "commun__deja-stockee.jpg");
    assert.equal(PendingPhotos.one.get(pendingId, admin.id), undefined); // consommée, pas réutilisable
  });
});

describe("anti-bruteforce (dernier : partage le même quota que les tests ci-dessus)", () => {
  test("suffisamment de tentatives de connexion échouées finit par déclencher le 429", async () => {
    let sawRateLimited = false;
    for (let i = 0; i < 20; i++) {
      const r = await api("POST", "/api/login", { body: { email: ADMIN_EMAIL, password: "mauvais" } });
      assert.ok([401, 429].includes(r.status), `statut inattendu : ${r.status}`);
      if (r.status === 429) { sawRateLimited = true; break; }
    }
    assert.ok(sawRateLimited, "le rate-limit anti-bruteforce ne s'est jamais déclenché");

    // Une fois déclenché, une autre route d'authentification (quota partagé
    // par IP, voir server/index.js authRateLimit) est elle aussi bloquée.
    const r2 = await api("POST", "/api/register", { body: { entreprise: "X", email: "y@test.local", password: "zzzzzzzz" } });
    assert.equal(r2.status, 429);
  });
});
