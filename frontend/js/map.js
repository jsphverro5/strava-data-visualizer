// ── Map module ────────────────────────────────────────────────────────────────

let map, mapReady = false;
let heatmapVisible  = true;
let clustersVisible = true;

// Track lines loaded per activity for frequency scoring
let _lineFrequency = {}; // segmentKey → count  (built client-side)

// ── MapBox load counter ───────────────────────────────────────────────────────
const MB_LIMIT       = 50000;
const MB_WARN_AT     = 45000; // warn at 90%
const MB_STORAGE_KEY = "mb_load_counter";

function _trackMapLoad() {
  const now    = new Date();
  const month  = `${now.getFullYear()}-${now.getMonth()}`;
  const raw    = JSON.parse(localStorage.getItem(MB_STORAGE_KEY) || "{}");

  if (raw.month !== month) {
    raw.month = month;
    raw.count = 0;
  }
  raw.count += 1;
  localStorage.setItem(MB_STORAGE_KEY, JSON.stringify(raw));

  if (raw.count >= MB_LIMIT) {
    // Hard block — swap in a free fallback message instead of loading MapBox
    document.getElementById("map").innerHTML =
      `<div style="display:flex;align-items:center;justify-content:center;height:100%;
         background:#0f172a;color:#ef4444;font-size:14px;text-align:center;padding:24px;">
        <div>
          <strong>MapBox free tier limit reached (${MB_LIMIT.toLocaleString()} loads this month).</strong><br><br>
          The map will resume on the 1st of next month.<br>
          All other dashboard features still work normally.
        </div>
      </div>`;
    return false;
  }

  if (raw.count === MB_WARN_AT) {
    console.warn(`MapBox: ${raw.count.toLocaleString()} map loads used this month — approaching the ${MB_LIMIT.toLocaleString()} free tier limit.`);
    showMapLoadWarning(raw.count);
  }

  return true;
}

function showMapLoadWarning(count) {
  const banner = document.createElement("div");
  banner.style.cssText = `position:absolute;top:10px;left:50%;transform:translateX(-50%);
    background:#7c2d12;color:#fed7aa;padding:8px 16px;border-radius:8px;font-size:12px;
    z-index:100;display:flex;align-items:center;gap:10px;`;
  banner.innerHTML = `⚠ ${count.toLocaleString()} / ${MB_LIMIT.toLocaleString()} MapBox map loads used this month.
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;cursor:pointer;font-size:14px;">✕</button>`;
  document.getElementById("map-container").appendChild(banner);
}

function getMapLoadStats() {
  const now   = new Date();
  const month = `${now.getFullYear()}-${now.getMonth()}`;
  const raw   = JSON.parse(localStorage.getItem(MB_STORAGE_KEY) || "{}");
  return raw.month === month ? raw.count : 0;
}

function initMap() {
  if (!_trackMapLoad()) return; // blocked at limit
  mapboxgl.accessToken = MAPBOX_TOKEN;
  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
    antialias: true,
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");
  map.addControl(new mapboxgl.ScaleControl(), "bottom-right");

  // Use "style.load" (fires when the style JSON is parsed) rather than "load"
  // (which waits for full tile rendering and can stall in some environments).
  const onStyleReady = () => {
    if (mapReady) return;            // run once
    mapReady = true;
    _setupSources();
    document.dispatchEvent(new Event("mapReady"));
  };
  map.on("style.load", onStyleReady);
  // Fallback: if the style was already loaded before the handler attached.
  if (map.isStyleLoaded && map.isStyleLoaded()) onStyleReady();
}

function _setupSources() {
  // Satellite underlay — toggled independently, sits below all custom layers
  map.addSource("satellite-source", {
    type: "raster",
    url: "mapbox://mapbox.satellite",
    tileSize: 256,
  });
  map.addLayer({
    id: "satellite-layer",
    type: "raster",
    source: "satellite-source",
    layout: { visibility: "none" },
    paint: { "raster-opacity": 1 },
  });

  // Heatmap source: all raw GPX tracks
  map.addSource("heatmap-source", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // Heatmap line layer — stacked translucent lines create density effect
  map.addLayer({
    id: "heatmap-lines",
    type: "line",
    source: "heatmap-source",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-width": 2,
      "line-opacity": 0.35,
      "line-color": [
        "interpolate", ["linear"],
        ["coalesce", ["get", "frequency"], 1],
        1,  HEATMAP_COLORS.low,
        3,  HEATMAP_COLORS.mid,
        6,  HEATMAP_COLORS.high,
        12, HEATMAP_COLORS.peak,
      ],
    },
  });

  // Selected route highlight
  map.addSource("selected-route", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "selected-route-line",
    type: "line",
    source: "selected-route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-width": 4,
      "line-color": "#facc15",
      "line-opacity": 0.9,
    },
  });

  // Selected activity highlight (cyan — distinct from route yellow)
  map.addSource("selected-activity", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "selected-activity-line",
    type: "line",
    source: "selected-activity",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-width": 3,
      "line-color": "#22d3ee",   // cyan
      "line-opacity": 0.95,
    },
  });

  // Selected segment highlight (lime green)
  map.addSource("selected-segment", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "selected-segment-line",
    type: "line",
    source: "selected-segment",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-width": 4,
      "line-color": "#a3e635",   // lime
      "line-opacity": 0.95,
      "line-dasharray": [2, 1],
    },
  });

  // Scramble markers — color coded by completion
  map.addSource("scramble-markers", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  // Outer circle (color = status)
  map.addLayer({
    id: "scramble-circles",
    type: "circle",
    source: "scramble-markers",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 7,
      "circle-color": [
        "match", ["get", "status"],
        "done",      "#22c55e",   // green
        "attempted", "#f59e0b",   // amber
                     "#6b7280",   // gray = not yet
      ],
      "circle-opacity": 0.9,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#fff",
    },
  });
  // Class label inside circle
  map.addLayer({
    id: "scramble-labels",
    type: "symbol",
    source: "scramble-markers",
    layout: {
      visibility: "none",
      "text-field": ["get", "class"],
      "text-size": 8,
      "text-font": ["DIN Offc Pro Bold", "Arial Unicode MS Bold"],
    },
    paint: { "text-color": "#fff" },
  });

  map.on("click", "scramble-circles", (e) => {
    const props = e.features[0].properties;
    document.dispatchEvent(new CustomEvent("scrambleMarkerClick", { detail: props }));
  });
  map.on("mouseenter", "scramble-circles", () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", "scramble-circles", () => map.getCanvas().style.cursor = "");

  // Route cluster start markers source
  map.addSource("route-markers", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "route-markers-circle",
    type: "circle",
    source: "route-markers",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1,5, 5,8, 20,12],
      "circle-color": CLUSTER_COLOR,
      "circle-opacity": 0.85,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#fff",
    },
  });

  // Cluster marker click → highlight route
  map.on("click", "route-markers-circle", (e) => {
    const props = e.features[0].properties;
    document.dispatchEvent(new CustomEvent("routeMarkerClick", { detail: props }));
  });

  map.on("mouseenter", "route-markers-circle", () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", "route-markers-circle", () => map.getCanvas().style.cursor = "");
}

// ── Public API ────────────────────────────────────────────────────────────────

function loadHeatmap(geojson) {
  if (!mapReady) return;

  // Frequency is precomputed server-side (properties.frequency); use as-is.
  map.getSource("heatmap-source").setData(geojson);

  if (geojson.features.length > 0) {
    try {
      const bounds = geojsonBounds(geojson);
      map.fitBounds(bounds, { padding: 60, maxZoom: 14 });
    } catch (_) {}
  }
}

function loadRouteMarkers(routes) {
  if (!mapReady) return;
  const features = routes
    .filter(r => r.start_lat && r.start_lon)
    .map(r => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.start_lon, r.start_lat] },
      properties: {
        id: r.id,
        name: r.name,
        count: r.count,
        best_duration_s: r.best_duration_s,
        avg_duration_s: r.avg_duration_s,
        total_distance_m: r.total_distance_m,
      },
    }));
  map.getSource("route-markers").setData({ type: "FeatureCollection", features });
}

function highlightRoute(coords) {
  if (!mapReady || !coords || coords.length < 2) return;
  const geojsonCoords = coords.map(([lat, lng]) => [lng, lat]);
  map.getSource("selected-route").setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: geojsonCoords },
    }],
  });
  // Fly to route
  const lats = coords.map(c => c[0]);
  const lngs = coords.map(c => c[1]);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 80, maxZoom: 15 }
  );
}

function clearRouteHighlight() {
  if (!mapReady) return;
  map.getSource("selected-route").setData({ type: "FeatureCollection", features: [] });
}

function _coordsToGeoJSON(coords) {
  // coords may be [lat,lon] or [lon,lat] — detect by magnitude
  // Longitudes in Boulder are ~ -105, latitudes ~ 40
  // If first element is negative it's likely lon-first (already GeoJSON order)
  const first = coords[0];
  const isLatLon = first && Math.abs(first[0]) <= 90 && Math.abs(first[1]) > 90;
  return isLatLon
    ? coords.map(([lat, lon]) => [lon, lat])
    : coords;
}

function highlightActivity(coords) {
  if (!mapReady || !coords || coords.length < 2) return;
  const geojsonCoords = _coordsToGeoJSON(coords);
  map.getSource("selected-activity").setData({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "LineString", coordinates: geojsonCoords } }],
  });
  const lats = geojsonCoords.map(c => c[1]);
  const lngs = geojsonCoords.map(c => c[0]);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 80, maxZoom: 15 }
  );
}

function clearActivityHighlight() {
  if (!mapReady) return;
  map.getSource("selected-activity").setData({ type: "FeatureCollection", features: [] });
}

function highlightSegment(coords) {
  if (!mapReady || !coords || coords.length < 2) return;
  const geojsonCoords = _coordsToGeoJSON(coords);
  map.getSource("selected-segment").setData({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "LineString", coordinates: geojsonCoords } }],
  });
  const lats = geojsonCoords.map(c => c[1]);
  const lngs = geojsonCoords.map(c => c[0]);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 100, maxZoom: 16 }
  );
}

function clearSegmentHighlight() {
  if (!mapReady) return;
  map.getSource("selected-segment").setData({ type: "FeatureCollection", features: [] });
}

function loadScramblesOnMap(scrambles, checked) {
  if (!mapReady) return;
  const features = scrambles
    .filter(s => s.lat && s.lon)
    .map(s => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        id:       s.id,
        name:     s.route,
        formation:s.formation,
        area:     s.area,
        class:    s.class,
        elev_ft:  s.elev_ft,
        has_track: !!s.segment_uuid,
        seg_pr_s:  s.seg_pr_s || null,
        status: checked.has(s.id) ? "done"
               : (s.nearby_count > 0 || s.seg_attempts > 0) ? "attempted"
               : "not-yet",
      },
    }));
  map.getSource("scramble-markers").setData({ type: "FeatureCollection", features });
}

function setScramblesVisible(visible) {
  if (!mapReady) return;
  ["scramble-circles", "scramble-labels"].forEach(id =>
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none")
  );
}

function setLayerVisibility(layerId, visible) {
  if (!mapReady) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

function fitAll() {
  const src = map.getSource("heatmap-source");
  if (!src) return;
  const data = src._data;
  if (!data || !data.features || data.features.length === 0) return;
  try {
    map.fitBounds(geojsonBounds(data), { padding: 60, maxZoom: 14 });
  } catch (_) {}
}
