import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Aucune variable TELEGRAM_* définie : état par défaut de la plupart des
// installations (bot non créé). Fichier séparé de telegram.test.js car les
// variables d'environnement sont lues une seule fois, au chargement du
// module — impossible de tester les deux états dans le même process
// (même logique que test/nemo-unconfigured.test.js).
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_BOT_USERNAME;
delete process.env.TELEGRAM_WEBHOOK_SECRET;

const { telegramConfigured, telegramBotUsername, sendMessage, verifyInitData } = await import("../server/telegram.js");

describe("telegram.js (non configuré)", () => {
  test("telegramConfigured() est faux sans TELEGRAM_BOT_TOKEN", () => {
    assert.equal(telegramConfigured(), false);
  });

  test("telegramBotUsername() est vide", () => {
    assert.equal(telegramBotUsername(), "");
  });

  test("sendMessage() ne lève jamais (best-effort), même non configuré", async () => {
    await assert.doesNotReject(() => sendMessage("123", "salut"));
  });

  test("verifyInitData() rejette explicitement (jamais silencieux)", () => {
    assert.throws(() => verifyInitData("hash=x"), /non configuré/i);
  });
});
