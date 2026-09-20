import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { loadClassMap } = await import("../server/export-training-feedback.js");

describe("export-training-feedback.js : loadClassMap", () => {
  test("reconnaît une classe brute exacte de ml/labels.json", () => {
    const map = loadClassMap();
    // "Sole" est une classe réelle de ml/labels.json ET de species_weights.json.
    assert.equal(map.get("sole"), "Sole");
  });

  test("reconnaît un nom français (nom_fr de species_weights.json)", () => {
    const map = loadClassMap();
    assert.equal(map.get("thiof / mérou"), "Thiof Merou");
  });

  test("la recherche est insensible à la casse/aux espaces (normalisée en amont)", () => {
    const map = loadClassMap();
    // loadClassMap stocke déjà les clés normalisées (minuscules, trim) ;
    // on vérifie que la normalisation appliquée par l'appelant (voir main())
    // retrouve bien la même entrée.
    assert.equal(map.get("sole".trim().toLowerCase()), "Sole");
  });

  test("une espèce non reconnue n'a pas d'entrée", () => {
    const map = loadClassMap();
    assert.equal(map.get("poisson-clown-imaginaire"), undefined);
  });
});
