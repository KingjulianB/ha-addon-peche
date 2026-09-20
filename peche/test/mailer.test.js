import { test, describe } from "node:test";
import assert from "node:assert/strict";

// SMTP non configuré = état par défaut (le plus courant) : l'envoi doit être
// "simulé" (jamais bloquant) et fournir le lien utilisable manuellement.
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;
process.env.APP_BASE_URL = "https://peche.example.com/";

const { smtpConfigured, verifyUrl, resetUrl, sendVerification, sendPasswordReset, sendProximityAlert } =
  await import("../server/mailer.js");

describe("smtpConfigured", () => {
  test("faux sans identifiants SMTP", () => {
    assert.equal(smtpConfigured(), false);
  });
});

describe("URLs (avec APP_BASE_URL configuré)", () => {
  test("verifyUrl() construit le lien de vérification, slash final retiré", () => {
    assert.equal(verifyUrl("abc123"), "https://peche.example.com/verifier?token=abc123");
  });
  test("resetUrl() construit le lien de réinitialisation", () => {
    assert.equal(resetUrl("xyz789"), "https://peche.example.com/reset-password?token=xyz789");
  });
  test("les jetons sont encodés dans l'URL", () => {
    assert.equal(verifyUrl("a b/c"), "https://peche.example.com/verifier?token=a%20b%2Fc");
  });
});

describe("envoi simulé (sans SMTP configuré)", () => {
  test("sendVerification renvoie sent:false et le lien, sans planter", async () => {
    const r = await sendVerification("client@test.local", "Ma Pêcherie", "tok1");
    assert.equal(r.sent, false);
    assert.equal(r.url, verifyUrl("tok1"));
  });

  test("sendPasswordReset renvoie sent:false et le lien, sans planter", async () => {
    const r = await sendPasswordReset("client@test.local", "tok2");
    assert.equal(r.sent, false);
    assert.equal(r.url, resetUrl("tok2"));
  });

  test("sendProximityAlert renvoie sent:false sans lien (rien à faire manuellement)", async () => {
    const r = await sendProximityAlert("alerte@test.local", { distanceKm: 1.234, point: { t: "2026-01-01T10:00:00Z" } });
    assert.equal(r.sent, false);
  });

  test("sendProximityAlert gère une distance/point inconnus sans planter", async () => {
    const r = await sendProximityAlert("alerte@test.local", { distanceKm: null, point: null });
    assert.equal(r.sent, false);
  });
});
