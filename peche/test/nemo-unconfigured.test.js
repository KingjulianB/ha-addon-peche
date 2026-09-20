import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Aucune variable NEMO_* définie : c'est l'état par défaut de la plupart des
// installations (balise VMS non câblée). Fichier séparé de nemo.test.js car
// les variables d'environnement sont lues une seule fois, au chargement du
// module — impossible de tester les deux états dans le même process.
delete process.env.NEMO_API_URL;
delete process.env.NEMO_API_KEY;
delete process.env.NEMO_DEVICE_ID;

const { nemoConfigured, fetchNemoTrack } = await import("../server/nemo.js");

describe("nemo.js (non configuré)", () => {
  test("nemoConfigured() est faux sans les 3 variables", () => {
    assert.equal(nemoConfigured(), false);
  });

  test("fetchNemoTrack() rejette avec un message explicite (jamais silencieux)", async () => {
    await assert.rejects(() => fetchNemoTrack("2026-01-01", "2026-01-02"), /non configuré/i);
  });
});
