// ============================================================
//  ALERTE "PIROGUE PROCHE DU DÉBARQUEMENT"
// ============================================================
// Sonde périodiquement la balise NEMO (voir nemo.js) et envoie un
// email dès que la pirogue entre dans le rayon "proche du
// débarquement" (réglages : alerte_debarquement_km, autour du centre
// de la zone de pêche zone_lat/zone_lon) — plus petit que zone_radius,
// qui couvre toute la zone de pêche.
//
// Ne fait RIEN tant que NEMO n'est pas configuré (nemoConfigured()) —
// et échouera silencieusement (juste un avertissement journalisé) tant
// que fetchNemoTrack() n'est pas complété avec la vraie API CLS (voir
// nemo.js) : c'est le même blocage que la synchro NEMO manuelle, pas
// un nouveau. L'algorithme de décision (distance, seuil,
// anti-répétition) est isolé dans geo.js (decideProximityAlert), pur
// et testable dès maintenant avec des points GPS de test, sans
// dépendre de NEMO ni de la base de données.
// ============================================================

import { decideProximityAlert } from "./geo.js";
import { nemoConfigured, fetchNemoTrack } from "./nemo.js";
import { sendProximityAlert } from "./mailer.js";
import { getSettings } from "./db.js";

export { decideProximityAlert };

const POLL_MS = (parseInt(process.env.NEMO_POLL_MINUTES || "5", 10) || 5) * 60000;
const LOOKBACK_MIN = 30; // fenêtre interrogée à chaque sondage (couvre un sondage manqué)

let timer = null;
let wasNear = false; // état courant, remis à jour à chaque sondage

async function tick() {
  try {
    const until = new Date().toISOString();
    const since = new Date(Date.now() - LOOKBACK_MIN * 60000).toISOString();
    const points = await fetchNemoTrack(since, until);
    if (!points || !points.length) return;
    const lastPoint = points[points.length - 1];
    const settings = getSettings();
    const { isNear, shouldNotify, distanceKm } = decideProximityAlert(lastPoint, settings, wasNear);
    wasNear = isNear;
    if (!shouldNotify) return;

    const to = (settings.alerte_email || "").trim();
    if (!to) {
      console.log(`[alerte proximité] pirogue à ${distanceKm.toFixed(1)} km du débarquement — aucun "alerte_email" renseigné dans les réglages, email non envoyé.`);
      return;
    }
    await sendProximityAlert(to, { distanceKm, point: lastPoint });
  } catch (e) {
    // Normal tant que fetchNemoTrack() n'est pas complété (voir nemo.js) :
    // ne doit jamais faire planter le serveur, juste être journalisé.
    console.warn("[alerte proximité] sondage NEMO échoué :", e.message);
  }
}

/** Démarre le sondage périodique. Sans effet si NEMO n'est pas configuré. */
export function startProximityWatcher() {
  if (!nemoConfigured()) return;
  if (timer) return; // déjà démarré
  wasNear = false;
  timer = setInterval(tick, POLL_MS);
  tick(); // premier sondage immédiat, pas d'attente du premier intervalle
  console.log(`[alerte proximité] sondage NEMO actif (toutes les ${POLL_MS / 60000} min).`);
}

export function stopProximityWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}
