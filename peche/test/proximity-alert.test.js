import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// NEMO non configuré (état par défaut) : le sondage ne doit jamais démarrer.
delete process.env.NEMO_API_URL;
delete process.env.NEMO_API_KEY;
delete process.env.NEMO_DEVICE_ID;

const { startProximityWatcher, stopProximityWatcher, decideProximityAlert } =
  await import("../server/proximity-alert.js");

describe("proximity-alert.js (NEMO non configuré)", () => {
  test("réexporte decideProximityAlert (logique pure testée dans geo.test.js)", () => {
    assert.equal(typeof decideProximityAlert, "function");
  });

  test("startProximityWatcher() ne programme aucun sondage périodique", () => {
    const spy = mock.method(global, "setInterval");
    try {
      startProximityWatcher();
      assert.equal(spy.mock.callCount(), 0);
    } finally {
      spy.mock.restore();
      stopProximityWatcher();
    }
  });
});
