import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// server/secrets.js persiste sa clé de chiffrement à côté de DB_PATH : on
// isole ce test dans un dossier temporaire pour ne jamais toucher une vraie
// clé/installation.
const tmpDir = mkdtempSync(join(tmpdir(), "peche-secrets-test-"));
process.env.DB_PATH = join(tmpDir, "peche.db");

const { encryptSecret, decryptSecret } = await import("../server/secrets.js");

after(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("encryptSecret / decryptSecret", () => {
  test("chiffre puis déchiffre fidèlement", () => {
    const enc = encryptSecret("clé-api-très-secrète-123");
    assert.notEqual(enc, "clé-api-très-secrète-123");
    assert.equal(decryptSecret(enc), "clé-api-très-secrète-123");
  });

  test("deux chiffrements de la même valeur produisent des résultats différents (IV aléatoire)", () => {
    const a = encryptSecret("même-clé");
    const b = encryptSecret("même-clé");
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), "même-clé");
    assert.equal(decryptSecret(b), "même-clé");
  });

  test("une entrée vide/absente renvoie null sans planter", () => {
    assert.equal(encryptSecret(""), null);
    assert.equal(encryptSecret(null), null);
    assert.equal(encryptSecret(undefined), null);
    assert.equal(decryptSecret(""), null);
    assert.equal(decryptSecret(null), null);
  });

  test("une valeur chiffrée altérée est rejetée (auth tag GCM)", () => {
    const enc = encryptSecret("valeur-authentique");
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 0xff; // altère un octet du texte chiffré
    const tampered = buf.toString("base64");
    assert.throws(() => decryptSecret(tampered));
  });
});
