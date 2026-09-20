import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// On isole estimateWeightFromLength() d'un vrai ml/species_weights.json
// (susceptible de changer côté data science) avec un petit jeu de données
// contrôlé qui couvre explicitement chaque branche de la fonction.
const tmpDir = mkdtempSync(join(tmpdir(), "peche-fishid-test-"));
const weightsPath = join(tmpDir, "species_weights.json");
writeFileSync(weightsPath, JSON.stringify({
  _readme: "ignoré",
  "AvecAllometrie": { nom_fr: "Avec allométrie", poids_kg: 1, a: 0.01, b: 3 },
  "SansAllometrie": { nom_fr: "Sans allométrie (poids moyen seul)", poids_kg: 0.5 },
  "SansDonnee": { nom_fr: "Aucune donnée de poids exploitable" },
}));
process.env.FISHID_WEIGHTS_PATH = weightsPath;

after(() => rmSync(tmpDir, { recursive: true, force: true }));

const { fishIdConfigured, estimateWeightFromLength } = await import("../server/fishid.js");

describe("fishIdConfigured", () => {
  test("vrai quand model.onnx et labels.json sont présents (cas de ce dépôt)", () => {
    assert.equal(fishIdConfigured(), true);
  });
});

describe("estimateWeightFromLength", () => {
  test("utilise la relation allométrique quand a/b sont renseignés", () => {
    const r = estimateWeightFromLength("AvecAllometrie", 20);
    // W(g) = 0.01 × 20^3 = 80 g → 0.08 kg
    assert.equal(r.methode, "allometrie");
    assert.equal(r.fiable, false);
    assert.ok(Math.abs(r.poidsKg - 0.08) < 1e-9);
  });

  test("se replie sur le poids moyen si a/b absents", () => {
    const r = estimateWeightFromLength("SansAllometrie", 15);
    assert.deepEqual(r, { poidsKg: 0.5, methode: "moyenne_espece", fiable: false });
  });

  test("échoue si aucune donnée de poids n'est exploitable", () => {
    assert.throws(() => estimateWeightFromLength("SansDonnee", 15), /Aucune donnée de poids/);
  });

  test("échoue pour une espèce inconnue", () => {
    assert.throws(() => estimateWeightFromLength("Inconnue", 15), /Espèce inconnue/);
  });

  test("échoue pour une longueur invalide (nulle ou négative)", () => {
    assert.throws(() => estimateWeightFromLength("AvecAllometrie", 0), /Longueur invalide/);
    assert.throws(() => estimateWeightFromLength("AvecAllometrie", -5), /Longueur invalide/);
  });
});
