import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// server/auth.js importe server/db.js, qui ouvre la base SQLite au chargement
// du module : on pointe DB_PATH vers un fichier temporaire AVANT tout import,
// pour ne jamais toucher à une vraie base et isoler ce fichier de test.
const tmpDir = mkdtempSync(join(tmpdir(), "peche-auth-test-"));
process.env.DB_PATH = join(tmpDir, "peche.db");

const {
  hashPassword, verifyPassword, DUMMY_PASSWORD_HASH,
  createPhotoToken, getPhotoSession,
  createSession, getSession, destroySession, destroySessionsForUser,
  createResetToken, resetPasswordWithToken,
  ensureAdminAccount, createUser,
} = await import("../server/auth.js");
const { Users, defaultEntrepriseId, db } = await import("../server/db.js");

after(() => {
  db.close(); // sinon le fichier .db reste verrouillé sous Windows (EBUSY)
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("hashPassword / verifyPassword", () => {
  test("un mot de passe correct est vérifié", () => {
    const stored = hashPassword("motDePasse123");
    assert.equal(verifyPassword("motDePasse123", stored), true);
  });

  test("un mot de passe incorrect est rejeté", () => {
    const stored = hashPassword("motDePasse123");
    assert.equal(verifyPassword("autreChose", stored), false);
  });

  test("deux hachages du même mot de passe diffèrent (sel aléatoire)", () => {
    assert.notEqual(hashPassword("abc"), hashPassword("abc"));
  });

  test("une valeur stockée malformée (pas de sel) est rejetée sans planter", () => {
    assert.equal(verifyPassword("abc", "pas-de-separateur"), false);
  });

  test("DUMMY_PASSWORD_HASH est un hachage valide mais ne correspond à aucun mot de passe réel", () => {
    assert.equal(verifyPassword("n'importe quoi", DUMMY_PASSWORD_HASH), false);
    assert.equal(verifyPassword("", DUMMY_PASSWORD_HASH), false);
  });
});

describe("sessions", () => {
  const user = { id: "u1", username: "u1@test.local", email: "u1@test.local", role: "admin", entreprise_id: "ent1" };

  test("createSession puis getSession renvoie les infos utilisateur", () => {
    const token = createSession(user);
    const sess = getSession(token);
    assert.equal(sess.id, user.id);
    assert.equal(sess.email, user.email);
    assert.equal(sess.role, user.role);
    assert.equal(sess.entreprise_id, user.entreprise_id);
  });

  test("getSession avec un jeton inconnu ou vide renvoie une valeur fausse", () => {
    assert.ok(!getSession("jeton-inexistant"));
    assert.ok(!getSession(""));
    assert.ok(!getSession(undefined));
  });

  test("destroySession invalide le jeton", () => {
    const token = createSession(user);
    assert.ok(getSession(token));
    destroySession(token);
    assert.ok(!getSession(token));
  });

  test("destroySessionsForUser ne touche que les sessions de cet utilisateur", () => {
    const other = { ...user, id: "u2", username: "u2@test.local" };
    const tA = createSession(user);
    const tB = createSession(other);
    destroySessionsForUser(user.id);
    assert.ok(!getSession(tA));
    assert.ok(getSession(tB));
  });
});

describe("jetons photo (courte durée)", () => {
  const user = { id: "u1", username: "u1@test.local", email: "u1@test.local", role: "pecheur", entreprise_id: "ent1" };

  test("createPhotoToken puis getPhotoSession renvoie l'utilisateur associé", () => {
    const t = createPhotoToken(user);
    const sess = getPhotoSession(t);
    assert.equal(sess.id, user.id);
    assert.equal(sess.entreprise_id, user.entreprise_id);
  });

  test("un jeton photo inconnu renvoie null", () => {
    assert.equal(getPhotoSession("bidon"), null);
    assert.equal(getPhotoSession(""), null);
  });

  test("un jeton photo expiré n'est plus valide", (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const token = createPhotoToken(user);
    assert.ok(getPhotoSession(token)); // valide juste après création
    t.mock.timers.tick(10 * 60 * 1000 + 1); // > 10 min de TTL
    assert.equal(getPhotoSession(token), null);
  });

  test("un jeton photo n'est jamais accepté comme jeton de session", () => {
    const photoT = createPhotoToken(user);
    assert.equal(getSession(photoT), undefined);
  });
});

describe("réinitialisation de mot de passe", () => {
  let ent, user;
  before(() => {
    ent = defaultEntrepriseId();
    user = createUser({ email: "reset@test.local", password: "ancienMdp1", role: "admin", entreprise_id: ent, verifie: true });
  });

  test("un jeton inconnu est refusé", () => {
    const r = resetPasswordWithToken("jeton-bidon", "nouveauMdp1");
    assert.equal(r.ok, false);
    assert.match(r.error, /invalide/i);
  });

  test("un jeton valide change le mot de passe et révoque les sessions", () => {
    const token = createResetToken(user);
    const session = createSession(user);
    assert.ok(getSession(session));

    const r = resetPasswordWithToken(token, "nouveauMdp1");
    assert.equal(r.ok, true);

    const row = Users.byEmail.get(user.email);
    assert.equal(verifyPassword("nouveauMdp1", row.password), true);
    assert.equal(verifyPassword("ancienMdp1", row.password), false);
    // resetPasswordWithToken doit invalider les sessions ouvertes de l'utilisateur
    assert.ok(!getSession(session));
  });

  test("un jeton déjà consommé ne fonctionne plus (usage unique)", () => {
    const token = createResetToken(user);
    resetPasswordWithToken(token, "premierChangement1");
    const r2 = resetPasswordWithToken(token, "secondChangement1");
    assert.equal(r2.ok, false);
  });

  test("un jeton expiré est refusé", (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const token = createResetToken(user);
    t.mock.timers.tick(60 * 60 * 1000 + 1); // > 1h de TTL
    const r = resetPasswordWithToken(token, "trotard1");
    assert.equal(r.ok, false);
    assert.match(r.error, /expiré/i);
  });
});

describe("ensureAdminAccount", () => {
  test("ne fait rien si email ou mot de passe manquant", () => {
    assert.doesNotThrow(() => ensureAdminAccount({ email: "", password: "" }));
    assert.equal(Users.byEmail.get("incomplet@test.local"), undefined);
  });

  test("crée le compte admin au premier appel", () => {
    ensureAdminAccount({ email: "admin-boot@test.local", password: "bootMdp1" });
    const row = Users.byEmail.get("admin-boot@test.local");
    assert.ok(row);
    assert.equal(row.role, "admin");
    assert.equal(verifyPassword("bootMdp1", row.password), true);
  });

  test("met à jour le mot de passe si le compte existe déjà", () => {
    ensureAdminAccount({ email: "admin-boot@test.local", password: "nouveauBootMdp1" });
    const row = Users.byEmail.get("admin-boot@test.local");
    assert.equal(verifyPassword("nouveauBootMdp1", row.password), true);
    assert.equal(verifyPassword("bootMdp1", row.password), false);
  });
});

describe("createUser", () => {
  test("compte vérifié d'office (ex: pêcheur via code d'invitation) : pas de jeton", () => {
    const u = createUser({ email: "verifie@test.local", password: "mdpValide1", role: "pecheur", entreprise_id: "entX", verifie: true });
    assert.equal(u.verif_token, null);
    const row = Users.byEmail.get("verifie@test.local");
    assert.equal(row.email_verifie, 1);
  });

  test("compte non vérifié (inscription libre) : jeton de vérification généré", () => {
    const u = createUser({ email: "nonverifie@test.local", password: "mdpValide1", role: "admin", entreprise_id: "entY", verifie: false });
    assert.ok(u.verif_token && u.verif_token.length > 0);
    const row = Users.byEmail.get("nonverifie@test.local");
    assert.equal(row.email_verifie, 0);
    assert.equal(row.verif_token, u.verif_token);
  });
});
