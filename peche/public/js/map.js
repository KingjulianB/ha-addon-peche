// Rendu de la carte marine (canvas) : côte, zone de pêche, trajet.
const MapView = (() => {
  function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  function project(p, S, w, h) {
    const kmLat = 111, kmLon = 111 * Math.cos(S.lat * Math.PI / 180);
    const dx = (p.lon - S.lon) * kmLon, dy = (p.lat - S.lat) * kmLat;
    const scale = w / S.span;
    return { x: w / 2 + dx * scale, y: h / 2 - dy * scale };
  }

  function draw(canvas, S, track) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = 440;
    canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sea = css("--paper") ? "#dbeaf3" : "#dbeaf3";
    ctx.fillStyle = getComputedStyle(canvas).backgroundColor || sea;
    ctx.fillRect(0, 0, w, h);

    const scale = w / S.span;
    // côte (masse de terre à droite, Port-Gentil)
    const land = css("--paper-shade") || "#e9e4d4";
    ctx.fillStyle = "#e6e0cf";
    const cx = w * 0.72;
    ctx.beginPath();
    ctx.moveTo(w, 0); ctx.lineTo(cx + 30, 0);
    ctx.bezierCurveTo(cx - 10, h * .25, cx + 40, h * .5, cx - 6, h * .72);
    ctx.bezierCurveTo(cx + 30, h * .85, cx + 10, h, cx + 40, h);
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();

    // grille
    ctx.strokeStyle = "rgba(0,0,0,.08)"; ctx.lineWidth = 1;
    const step = S.span / 6;
    for (let g = -3; g <= 3; g++) {
      let gx = w / 2 + g * step * scale;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
      let gy = h / 2 + g * step * scale;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    // zone de pêche
    const pc = project({ lat: S.lat, lon: S.lon }, S, w, h);
    ctx.strokeStyle = "#0d5c4a"; ctx.setLineDash([6, 5]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(pc.x, pc.y, S.radius * scale, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(13,92,74,.07)";
    ctx.beginPath(); ctx.arc(pc.x, pc.y, S.radius * scale, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#0d5c4a"; ctx.font = "11px Inter, sans-serif";
    ctx.fillText(`Zone de pêche (${S.radius} km)`, pc.x - 42, pc.y - S.radius * scale - 6);

    // port
    ctx.fillStyle = "#1a1d1a";
    ctx.beginPath(); ctx.arc(pc.x, pc.y, 4, 0, 2 * Math.PI); ctx.fill();
    ctx.fillText("Port", pc.x + 8, pc.y + 3);

    // trajet
    if (track && track.points && track.points.length) {
      const pts = track.points;
      ctx.strokeStyle = "#c55a11"; ctx.lineWidth = 2.5; ctx.beginPath();
      pts.forEach((p, i) => { const q = project(p, S, w, h); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.stroke();
      const s = project(pts[0], S, w, h), e = project(pts[pts.length - 1], S, w, h);
      ctx.fillStyle = "#0d5c4a"; ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = "#a8321e"; ctx.beginPath(); ctx.arc(e.x, e.y, 5, 0, 2 * Math.PI); ctx.fill();
    }
  }
  return { draw };
})();
