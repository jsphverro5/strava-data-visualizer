// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtDist(meters) {
  if (meters == null) return "—";
  if (USE_MILES) {
    const miles = meters / 1609.344;
    return miles.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + " mi";
  }
  const km = meters / 1000;
  return km.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + " km";
}

function fmtDuration(seconds) {
  if (seconds == null) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,"0")}m`;
  return `${m}m ${String(s).padStart(2,"0")}s`;
}

function fmtPace(metersPerSec, type = "") {
  if (!metersPerSec || metersPerSec <= 0) return "—";
  const isBike = type && (type.includes("Ride") || type.includes("Bike") || type.includes("Cycling") || type.includes("Virtual"));
  if (isBike) {
    const speed = USE_MILES
      ? (metersPerSec * 2.23694).toFixed(1) + " mph"
      : (metersPerSec * 3.6).toFixed(1) + " km/h";
    return speed;
  }
  // Run: pace per unit
  if (USE_MILES) {
    const secPerMile = 1609.344 / metersPerSec;
    const m = Math.floor(secPerMile / 60);
    const s = Math.round(secPerMile % 60);
    return `${m}:${String(s).padStart(2,"0")} /mi`;
  }
  const secPerKm = 1000 / metersPerSec;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2,"0")} /km`;
}

function fmtDate(str) {
  if (!str) return "—";
  return new Date(str).toLocaleDateString(undefined, {year:"numeric",month:"short",day:"numeric"});
}

function fmtEle(m) {
  if (m == null) return "—";
  if (USE_MILES) return Math.round(m * 3.28084) + " ft";
  return Math.round(m) + " m";
}

function fmtHR(bpm) {
  if (!bpm) return "—";
  return Math.round(bpm) + " bpm";
}

// Compute bounding box for GeoJSON FeatureCollection
function geojsonBounds(geojson) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const f of geojson.features) {
    for (const [lng, lat] of f.geometry.coordinates) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
