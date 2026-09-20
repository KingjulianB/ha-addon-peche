import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "peche-db-test-"));
process.env.DB_PATH = join(tmpDir, "peche.db");

const {
  db, randomUUID, defaultEntrepriseId,
  Entreprises, Users, Trips, Expenses, Settings, getSettings,
} = await import("../server/db.js");

after(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("initialisation du schéma", () => {
  test("une entreprise par défaut est créée au premier lancement", () => {
    const id = defaultEntrepriseId();
    assert.ok(id);
    const ent = Entreprises.one.get(id);
    assert.equal(ent.nom, "Mon entreprise");
    assert.equal(ent.statut, "actif");
  });

  test("les réglages par défaut sont semés (fuel, zone, équipage...)", () => {
    const s = getSettings();
    assert.equal(s.fuel_mode, "hour");
    assert.equal(s.zone_lat, "-0.72");
    assert.deepEqual(JSON.parse(s.crew), ["Ndong", "Mavoungou", "Ekomi", "Boussougou"]);
  });

  test("ensureColumn est idempotent : ré-ouvrir/relire le schéma ne casse rien", () => {
    // Les colonnes ajoutées par migration (ex: entreprise_id) doivent exister
    // sans dupliquer ni planter, même après plusieurs lancements du serveur.
    const cols = db.prepare("PRAGMA table_info(trips)").all().map((c) => c.name);
    assert.ok(cols.includes("entreprise_id"));
    assert.ok(cols.includes("depart_date"));
    assert.ok(cols.includes("arrivee_date"));
  });
});

describe("Settings", () => {
  test("set() insère puis met à jour (upsert) la même clé", () => {
    Settings.set.run("test_key", "v1");
    assert.equal(getSettings().test_key, "v1");
    Settings.set.run("test_key", "v2");
    assert.equal(getSettings().test_key, "v2");
  });
});

describe("isolation multi-tenant : Expenses.byTrip", () => {
  test("ne renvoie que les dépenses de la sortie ET de l'entreprise demandées", () => {
    const entA = randomUUID();
    const entB = randomUUID();
    Entreprises.insert.run({ id: entA, nom: "Entreprise A", statut: "actif", email_contact: "a@test.local", created_at: Date.now() });
    Entreprises.insert.run({ id: entB, nom: "Entreprise B", statut: "actif", email_contact: "b@test.local", created_at: Date.now() });

    const tripId = randomUUID();
    Trips.insert.run({
      id: tripId, date: "2026-01-01", depart: null, retour: null,
      depart_date: "2026-01-01", arrivee_date: "2026-01-01",
      zone: null, crew: "[]", prises: "[]", par: "cap", note: null,
      owner: "cap", locked: 1, photo: null, gps_lat: null, gps_lon: null,
      entreprise_id: entA, created_at: Date.now(),
    });

    // Dépense légitime, même entreprise que la sortie.
    Expenses.insert.run({
      id: randomUUID(), date: "2026-01-01", type: "carburant", label: "plein",
      amount: 5000, trip_id: tripId, entreprise_id: entA, created_at: Date.now(),
    });
    // Dépense fabriquée par l'entreprise B mais pointant sur la sortie de A
    // (c'est exactement le scénario corrigé côté API : POST /api/expenses
    // valide maintenant que trip_id appartient à la même entreprise avant
    // d'accepter la donnée — ce test protège la requête elle-même en
    // défense en profondeur).
    Expenses.insert.run({
      id: randomUUID(), date: "2026-01-01", type: "autre", label: "intruse",
      amount: 999999, trip_id: tripId, entreprise_id: entB, created_at: Date.now(),
    });

    // index.js appelle toujours Expenses.byTrip avec l'entreprise_id RÉELLE
    // de la sortie (celle du propriétaire, jamais celle appelante) : la
    // vue détail de la sortie A ne doit donc jamais faire apparaître la
    // dépense fabriquée par l'entreprise B, même si celle-ci pointe sur
    // le même trip_id.
    const forA = Expenses.byTrip.all(tripId, entA);
    assert.equal(forA.length, 1);
    assert.equal(forA[0].label, "plein");
    assert.ok(!forA.some((e) => e.label === "intruse"));
  });
});

describe("Users", () => {
  test("username est unique", () => {
    const row = { id: randomUUID(), username: "dup@test.local", email: "dup@test.local",
      password: "x:y", role: "admin", entreprise_id: null, email_verifie: 1, verif_token: null, actif: 1, created_at: Date.now() };
    Users.insert.run(row);
    assert.throws(() => Users.insert.run({ ...row, id: randomUUID() }));
  });
});
