import { test, describe } from "node:test";
import assert from "node:assert/strict";

// nemo.js lit les variables d'environnement au chargement du module : on les
// fixe AVANT l'import pour tester le cas "configuré".
process.env.NEMO_API_URL = "https://cls.example/api";
process.env.NEMO_API_KEY = "clef-test";
process.env.NEMO_DEVICE_ID = "balise-test";

const { nemoConfigured, fetchNemoTrack } = await import("../server/nemo.js");

describe("nemo.js", () => {
  test("nemoConfigured() est vrai quand les 3 variables sont renseignées", () => {
    assert.equal(nemoConfigured(), true);
  });

  test("fetchNemoTrack() n'est pas encore implémentée : rejette explicitement", async () => {
    // La fonction est un point de branchement en attente de la doc CLS —
    // même configurée, elle doit échouer proprement (pas planter le serveur,
    // voir server/proximity-alert.js qui journalise cette erreur en warning).
    await assert.rejects(() => fetchNemoTrack("2026-01-01", "2026-01-02"), /à compléter/i);
  });
});
