// Vraie carte marine (Leaflet + OpenStreetMap + OpenSeaMap seamarks).
// Affiche le trajet de la sortie, la zone de pêche et le port.
const MapView = (() => {
  let map = null, baseLayer = null, seaLayer = null;
  let trackLayer = null, zoneLayer = null, portMarker = null, ptsMarkers = [];

  function ensureMap(S) {
    if (map) return;
    map = L.map("map", { zoomControl: true, attributionControl: true })
      .setView([S.lat, S.lon], 10);

    // Fond de carte OpenStreetMap
    baseLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    // Couche nautique OpenSeaMap (amers, bouées, phares…)
    seaLayer = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
      maxZoom: 18, opacity: 0.9,
      attribution: '&copy; OpenSeaMap',
    }).addTo(map);
  }

  function draw(_containerId, S, track) {
    ensureMap(S);

    // Nettoyage des couches précédentes
    if (trackLayer) { map.removeLayer(trackLayer); trackLayer = null; }
    if (zoneLayer) { map.removeLayer(zoneLayer); zoneLayer = null; }
    if (portMarker) { map.removeLayer(portMarker); portMarker = null; }
    ptsMarkers.forEach((m) => map.removeLayer(m)); ptsMarkers = [];

    // Zone de pêche (cercle) + port au centre
    zoneLayer = L.circle([S.lat, S.lon], {
      radius: S.radius * 1000, // km -> m
      color: "#0d5c4a", weight: 2, dashArray: "6 5",
      fillColor: "#0d5c4a", fillOpacity: 0.06,
    }).addTo(map).bindTooltip(`Zone de pêche (${S.radius} km)`);

    portMarker = L.circleMarker([S.lat, S.lon], {
      radius: 5, color: "#1a1d1a", fillColor: "#1a1d1a", fillOpacity: 1,
    }).addTo(map).bindTooltip("Port");

    // Trajet
    if (track && track.points && track.points.length) {
      const latlngs = track.points.map((p) => [p.lat, p.lon]);
      trackLayer = L.polyline(latlngs, { color: "#c55a11", weight: 3 }).addTo(map);
      const s = latlngs[0], e = latlngs[latlngs.length - 1];
      ptsMarkers.push(L.circleMarker(s, { radius: 6, color: "#0d5c4a", fillColor: "#0d5c4a", fillOpacity: 1 }).addTo(map).bindTooltip("Départ"));
      ptsMarkers.push(L.circleMarker(e, { radius: 6, color: "#a8321e", fillColor: "#a8321e", fillOpacity: 1 }).addTo(map).bindTooltip("Retour"));
      map.fitBounds(trackLayer.getBounds().pad(0.3));
    } else {
      map.setView([S.lat, S.lon], 10);
    }
    // Leaflet doit recalculer sa taille quand l'onglet devient visible
    setTimeout(() => map && map.invalidateSize(), 100);
  }

  function reset() { if (map) { map.remove(); map = null; } }

  return { draw, reset };
})();
