// Calculs géographiques : distance et durée d'une trace GPS.

export function haversine(a, b) {
  const R = 6371; // km
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function trackDistanceKm(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

export function trackDurationH(points) {
  if (points.length < 2) return 0;
  const t0 = Date.parse(points[0].t);
  const t1 = Date.parse(points[points.length - 1].t);
  if (isNaN(t0) || isNaN(t1)) return 0;
  return Math.max(0, (t1 - t0) / 3600000);
}

/**
 * Décide s'il faut déclencher l'alerte "pirogue proche du débarquement"
 * (voir server/proximity-alert.js), à partir du dernier point connu et
 * de l'état précédent ("wasNear"). Pure — aucune I/O — pour rester
 * testable indépendamment de NEMO/du réseau/de la base de données.
 *
 * @param {{lat:number, lon:number, t?:string}|null} lastPoint
 * @param {{zone_lat:string, zone_lon:string, alerte_debarquement_km:string}} settings
 * @param {boolean} wasNear  état du sondage précédent (anti-répétition)
 * @returns {{isNear:boolean, shouldNotify:boolean, distanceKm:number|null}}
 */
export function decideProximityAlert(lastPoint, settings, wasNear) {
  const zoneLat = parseFloat(settings.zone_lat);
  const zoneLon = parseFloat(settings.zone_lon);
  const rayonKm = parseFloat(settings.alerte_debarquement_km ?? "3");
  if (!lastPoint || !Number.isFinite(zoneLat) || !Number.isFinite(zoneLon) || !Number.isFinite(rayonKm) || rayonKm <= 0) {
    return { isNear: wasNear, shouldNotify: false, distanceKm: null };
  }
  const distanceKm = haversine({ lat: zoneLat, lon: zoneLon }, { lat: lastPoint.lat, lon: lastPoint.lon });
  const isNear = distanceKm <= rayonKm;
  // Ne notifie qu'à l'ENTRÉE dans le rayon, pas à chaque sondage tant qu'on y reste.
  const shouldNotify = isNear && !wasNear;
  return { isNear, shouldNotify, distanceKm };
}
