import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { haversine, trackDistanceKm, trackDurationH, decideProximityAlert } from "../server/geo.js";

describe("haversine", () => {
  test("distance nulle entre un point et lui-même", () => {
    assert.equal(haversine({ lat: -0.72, lon: 8.78 }, { lat: -0.72, lon: 8.78 }), 0);
  });

  test("distance connue (1° de longitude à l'équateur ≈ 111.2 km)", () => {
    const d = haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    assert.ok(Math.abs(d - 111.19) < 0.5, `attendu ~111.19 km, obtenu ${d}`);
  });

  test("est symétrique (a→b == b→a)", () => {
    const a = { lat: -0.72, lon: 8.78 };
    const b = { lat: -1.1, lon: 9.2 };
    assert.equal(haversine(a, b), haversine(b, a));
  });
});

describe("trackDistanceKm", () => {
  test("tableau vide → 0", () => {
    assert.equal(trackDistanceKm([]), 0);
  });

  test("un seul point → 0", () => {
    assert.equal(trackDistanceKm([{ lat: 0, lon: 0 }]), 0);
  });

  test("somme les distances entre points consécutifs", () => {
    const p1 = { lat: 0, lon: 0 };
    const p2 = { lat: 0, lon: 1 };
    const p3 = { lat: 0, lon: 2 };
    const expected = haversine(p1, p2) + haversine(p2, p3);
    assert.equal(trackDistanceKm([p1, p2, p3]), expected);
  });
});

describe("trackDurationH", () => {
  test("moins de 2 points → 0", () => {
    assert.equal(trackDurationH([]), 0);
    assert.equal(trackDurationH([{ t: "2026-01-01T00:00:00Z" }]), 0);
  });

  test("dates invalides → 0", () => {
    assert.equal(trackDurationH([{ t: "pas une date" }, { t: "2026-01-01T00:00:00Z" }]), 0);
  });

  test("calcule la durée en heures entre le premier et le dernier point", () => {
    const points = [
      { t: "2026-01-01T08:00:00Z" },
      { t: "2026-01-01T10:30:00Z" },
      { t: "2026-01-01T12:00:00Z" },
    ];
    assert.equal(trackDurationH(points), 4);
  });

  test("ne descend jamais sous 0 (dernier point antérieur au premier)", () => {
    const points = [{ t: "2026-01-01T12:00:00Z" }, { t: "2026-01-01T08:00:00Z" }];
    assert.equal(trackDurationH(points), 0);
  });
});

describe("decideProximityAlert", () => {
  const settings = { zone_lat: "0", zone_lon: "0", alerte_debarquement_km: "5" };

  test("pas de dernier point connu → pas de notification, état inchangé", () => {
    const r = decideProximityAlert(null, settings, true);
    assert.deepEqual(r, { isNear: true, shouldNotify: false, distanceKm: null });
  });

  test("réglages de zone invalides (NaN) → repli sans planter", () => {
    const r = decideProximityAlert({ lat: 0, lon: 0 }, { zone_lat: "?", zone_lon: "0", alerte_debarquement_km: "5" }, false);
    assert.deepEqual(r, { isNear: false, shouldNotify: false, distanceKm: null });
  });

  test("rayon nul ou négatif → repli sans planter", () => {
    const r = decideProximityAlert({ lat: 0, lon: 0 }, { ...settings, alerte_debarquement_km: "0" }, false);
    assert.equal(r.shouldNotify, false);
    assert.equal(r.distanceKm, null);
  });

  test("rayon par défaut (3 km) si non renseigné", () => {
    const near = decideProximityAlert({ lat: 0, lon: 0.02 }, { zone_lat: "0", zone_lon: "0" }, false);
    assert.equal(near.isNear, true); // 0.02° ≈ 2.2 km < 3 km par défaut
  });

  test("entrée dans le rayon (pas encore proche) → notifie", () => {
    const r = decideProximityAlert({ lat: 0, lon: 0.01 }, settings, false);
    assert.equal(r.isNear, true);
    assert.equal(r.shouldNotify, true);
  });

  test("déjà proche au sondage précédent → ne renotifie pas", () => {
    const r = decideProximityAlert({ lat: 0, lon: 0.01 }, settings, true);
    assert.equal(r.isNear, true);
    assert.equal(r.shouldNotify, false);
  });

  test("hors du rayon → pas de notification", () => {
    const r = decideProximityAlert({ lat: 10, lon: 10 }, settings, false);
    assert.equal(r.isNear, false);
    assert.equal(r.shouldNotify, false);
  });
});
