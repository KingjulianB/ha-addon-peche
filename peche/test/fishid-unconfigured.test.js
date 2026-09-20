import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Simule une installation sans modèle entraîné déposé (ml/model.onnx absent) :
// c'est l'état par défaut pour un nouvel utilisateur de l'add-on.
process.env.FISHID_MODEL_PATH = "/chemin/inexistant/model.onnx";

const { fishIdConfigured, identifyPhoto } = await import("../server/fishid.js");

describe("fishid.js (non configuré : pas de modèle)", () => {
  test("fishIdConfigured() est faux si model.onnx est introuvable", () => {
    assert.equal(fishIdConfigured(), false);
  });

  test("identifyPhoto() rejette explicitement, la saisie manuelle reste possible", async () => {
    await assert.rejects(() => identifyPhoto("data:image/jpeg;base64,AAAA"), /non configurée/i);
  });
});
