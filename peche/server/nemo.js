// ============================================================
//  POINT DE BRANCHEMENT NEMO / CLS
// ============================================================
// L'accès aux positions de votre balise NEMO passe par l'API de CLS.
// Demandez à CLS (clsfishingteam@groupcls.com) leur documentation
// « accès développeur / API » : URL, méthode d'authentification (clé
// API ou token), et format des positions (souvent GeoJSON ou une liste
// de points {lat, lon, timestamp}).
//
// Quand vous l'aurez, remplissez fetchNemoTrack() ci-dessous. Le reste
// de l'application (carte, distances, carburant, recoupement) fonctionne
// déjà : il suffit que cette fonction renvoie un tableau de points
// au format { lat: Number, lon: Number, t: "AAAA-MM-JJTHH:MM:SSZ" }.
//
// Renseignez ces variables d'environnement au déploiement :
//   NEMO_API_URL   = https://...          (fourni par CLS)
//   NEMO_API_KEY   = votre clé            (fournie par CLS)
//   NEMO_DEVICE_ID = identifiant de votre balise
// ============================================================

const API_URL = process.env.NEMO_API_URL || "";
const API_KEY = process.env.NEMO_API_KEY || "";
const DEVICE_ID = process.env.NEMO_DEVICE_ID || "";

export function nemoConfigured() {
  return Boolean(API_URL && API_KEY && DEVICE_ID);
}

/**
 * Récupère les positions de la balise entre deux dates.
 * @param {string} since - date ISO de début (ex: "2026-09-01")
 * @param {string} until - date ISO de fin
 * @returns {Promise<Array<{lat:number, lon:number, t:string}>>}
 */
export async function fetchNemoTrack(since, until) {
  if (!nemoConfigured()) {
    throw new Error(
      "NEMO non configuré. Renseignez NEMO_API_URL, NEMO_API_KEY et NEMO_DEVICE_ID, " +
      "puis complétez fetchNemoTrack() selon la documentation CLS."
    );
  }

  // ---- EXEMPLE À ADAPTER au format réel de l'API CLS ----
  // (décommentez et ajustez une fois la doc CLS obtenue)
  //
  // const url = `${API_URL}/positions?device=${encodeURIComponent(DEVICE_ID)}`
  //           + `&from=${since}&to=${until}`;
  // const res = await fetch(url, {
  //   headers: { Authorization: `Bearer ${API_KEY}` },
  // });
  // if (!res.ok) throw new Error(`API NEMO: ${res.status}`);
  // const data = await res.json();
  //
  // // Adapter le mapping au format renvoyé par CLS :
  // return data.positions.map((p) => ({
  //   lat: p.latitude,
  //   lon: p.longitude,
  //   t: p.timestamp,
  // }));

  throw new Error("fetchNemoTrack() à compléter avec la documentation CLS.");
}
