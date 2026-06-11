// ── App controller ────────────────────────────────────────────────────────────

// ── Scramble checklist persistence (server-backed) ────────────────────────────
// In-memory set, synced to the backend. Survives browser data clears.
const SCRAMBLE_KEY = "scramble_checked"; // legacy localStorage key (migrated once)
let _checkedSet = new Set();

function getChecked() { return _checkedSet; }

async function initChecklist() {
  try {
    _checkedSet = new Set(await API.checklist());
    // One-time migration of any legacy localStorage state
    const legacy = JSON.parse(localStorage.getItem(SCRAMBLE_KEY) || "[]");
    if (legacy.length) {
      for (const id of legacy) {
        if (!_checkedSet.has(id)) {
          _checkedSet.add(id);
          API.setChecklist(id, true).catch(() => {});
        }
      }
      localStorage.removeItem(SCRAMBLE_KEY);
    }
  } catch (e) {
    // Backend unreachable — fall back to localStorage so the UI still works
    _checkedSet = new Set(JSON.parse(localStorage.getItem(SCRAMBLE_KEY) || "[]"));
    console.warn("checklist: using localStorage fallback", e);
  }
}

function toggleChecked(id) {
  const nowDone = !_checkedSet.has(id);
  nowDone ? _checkedSet.add(id) : _checkedSet.delete(id);
  API.setChecklist(id, nowDone).catch(() => {
    // Persist locally if the backend is down
    localStorage.setItem(SCRAMBLE_KEY, JSON.stringify([..._checkedSet]));
  });
  return _checkedSet;
}

let state = {
  type: null,
  routes: [],
  activities: [],
  segments: [],
  scrambles: [],
  selectedRouteId:   null,
  selectedActivityId: null,
  selectedSegmentUuid: null,
  routeSort:      { col: "count",       dir: "desc", type: "num" },
  activitySort:   { col: "date",        dir: "desc", type: "date" },
  segmentSort:    { col: "effort_count", dir: "desc", type: "num" },
  scrambleSort:   { col: "area",         dir: "asc",  type: "str" },
  bigDays:        [],
  bigDaySort:     null,  // null = server's score order
  effortSort:     { col: "start_time",  dir: "desc", type: "date" },
  routeFilter:    "",
  activityFilter: "",
  segmentFilter:  "",
  starredOnly:    false,
  detailSort:     { col: "date", dir: "desc", type: "date" },
  detailActivities: [],
  detailEfforts:    [],
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Map layers draw when (and if) the map becomes ready — but the dashboard
  // data and tables load immediately, independent of MapBox. This way a slow,
  // blocked, or rate-limited map never leaves the whole page blank.
  document.addEventListener("mapReady", drawMapLayers);
  initApp();
  initMap();
  // If the map happened to load before the listener attached, draw now.
  if (typeof mapReady !== "undefined" && mapReady) drawMapLayers();
});

let _appInitialized = false;
async function initApp() {
  if (_appInitialized) return;
  _appInitialized = true;

  // Controls and layout first so the UI is interactive even while data loads.
  bindControls();
  initResizeHandle();

  await Promise.all([loadTypeFilter(), initChecklist()]);
  await Promise.all([
    loadSummary(),
    loadHeatmapData(),
    loadRoutes(),
    loadActivities(),
    loadTimeline(),
    loadSegments(),
    loadYearStats(),
    loadBigDays(),
  ]);
  renderMapboxQuota();
  await loadScramblesData();

  // Data is fully loaded now — (re)draw map layers in case the map became
  // ready before the data arrived.
  drawMapLayers();
}

// (Re)push map layers from whatever state is currently loaded. Safe to call
// repeatedly — runs on map-ready and again after data finishes loading, so it
// doesn't matter which finishes first.
function drawMapLayers() {
  if (typeof mapReady === "undefined" || !mapReady) return;
  if (state.heatmapGeo)       loadHeatmap(state.heatmapGeo);
  if (state.routes.length)    loadRouteMarkers(state.routes);
  if (state.scrambles.length) loadScramblesOnMap(state.scrambles, getChecked());
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadTypeFilter() {
  try {
    const types = await API.activityTypes();
    const sel = document.getElementById("type-filter");
    types.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.type;
      opt.textContent = `${t.type} (${t.cnt})`;
      sel.appendChild(opt);
    });
  } catch (e) { console.warn("types:", e); }
}

async function loadSummary() {
  try {
    const s = await API.summary();
    const t = s.totals;
    const grid = document.getElementById("stat-grid");
    grid.innerHTML = "";
    const items = [
      ["Activities", t.total_activities?.toLocaleString()],
      ["Distance",   t.total_km ? fmtDist(t.total_km * 1000) : "—"],
      ["Hours",      t.total_hours ? Math.round(t.total_hours).toLocaleString() : "—"],
      ["Elevation",  t.total_elevation_m ? (USE_MILES
          ? Math.round(t.total_elevation_m * 3.28084).toLocaleString() + " ft"
          : Math.round(t.total_elevation_m).toLocaleString() + " m") : "—"],
      ["Active Days",t.active_days?.toLocaleString()],
      ["Avg HR",     t.avg_hr ? Math.round(t.avg_hr) + " bpm" : "—"],
    ];
    items.forEach(([label, val]) => {
      const div = el("div", "stat-item");
      div.appendChild(el("span", "stat-val", val ?? "—"));
      div.appendChild(el("span", "stat-lbl", label));
      grid.appendChild(div);
    });

    // Top routes sidebar list
    const ul = document.getElementById("top-routes-list");
    ul.innerHTML = "";
    (s.top_routes || []).forEach((r, i) => {
      const li = el("li", "top-route-item");
      li.dataset.routeId = r.id;
      li.innerHTML = `<span class="rank">${i+1}</span>
        <span class="route-info">
          <span class="route-name">${r.name}</span>
          <span class="route-meta">${r.count}× · ${fmtDist(r.total_distance_m)}</span>
        </span>`;
      li.addEventListener("click", () => selectRoute(r.id));
      ul.appendChild(li);
    });
  } catch (e) { console.warn("summary:", e); }
}

async function loadHeatmapData() {
  try {
    const geo = await API.heatmap(state.type);
    state.heatmapGeo = geo;   // cache so the map can (re)draw it when ready
    loadHeatmap(geo);         // no-ops if map not ready yet
  } catch (e) { console.warn("heatmap:", e); }
}

async function loadRoutes() {
  try {
    state.routes = await API.routes();
    renderRoutesTable();
    loadRouteMarkers(state.routes);
  } catch (e) { console.warn("routes:", e); }
}

async function loadActivities() {
  try {
    state.activities = await API.activities(state.type);
    renderActivitiesTable();
  } catch (e) { console.warn("activities:", e); }
}

async function loadTimeline() {
  try {
    const data = await API.timeline(state.type);
    renderTimeline(data);
  } catch (e) { console.warn("timeline:", e); }
}

async function loadSegments() {
  try {
    state.segments = await API.segments(state.segmentFilter, state.starredOnly);
    renderSegmentsTable();
  } catch (e) { console.warn("segments:", e); }
}

async function loadBigDays() {
  try {
    state.bigDays = await API.bigDays();
    renderBigDaysTable();
  } catch (e) { console.warn("bigdays:", e); }
}

function renderBigDaysTable() {
  const sort = state.bigDaySort;
  let data = state.bigDays || [];
  if (sort) data = sortData(data, sort.col, sort.dir, sort.type || "num");

  const tbody = document.getElementById("bigdays-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  data.forEach((d, i) => {
    const tr = document.createElement("tr");
    tr.dataset.actId = d.activity_id;
    const multi = d.n_activities > 1 ? ` <span class="multi-badge" title="${d.n_activities} activities this day">×${d.n_activities}</span>` : "";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><span class="score-badge ${d.score >= 95 ? "score-epic" : d.score >= 85 ? "score-big" : ""}">${d.score.toFixed(0)}</span></td>
      <td>${fmtDate(d.day)}</td>
      <td class="name-cell">${d.name}${multi}</td>
      <td><span class="type-badge type-${(d.type||"").replace(/\s+/g,"")}">${d.type}</span></td>
      <td>${fmtDuration(d.duration_s)}</td>
      <td>${fmtDist(d.distance_m)}</td>
      <td>${fmtEle(d.elevation_m)}</td>`;
    tr.addEventListener("click", () => selectActivity(d.activity_id));
    tbody.appendChild(tr);
  });
  updateSortIcons(document.getElementById("bigdays-table"), sort || {});
}

async function loadYearStats() {
  try {
    const years = await API.yearStats(state.type);
    renderYearStats(years);
  } catch (e) { console.warn("years:", e); }
}

function renderYearStats(years) {
  const tbody = document.getElementById("year-stats-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  years.forEach(y => {
    const vert = y.elevation_m
      ? (USE_MILES ? Math.round(y.elevation_m * 3.28084).toLocaleString() + " ft"
                   : Math.round(y.elevation_m).toLocaleString() + " m")
      : "—";
    const dist = USE_MILES
      ? Math.round(y.km * 0.621371).toLocaleString() + " mi"
      : Math.round(y.km).toLocaleString() + " km";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${y.year}</td><td>${y.count}</td><td>${dist}</td><td>${vert}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadScramblesData() {
  try {
    state.scrambles = await API.scrambles();
    // Enrich with nearby activity counts (determines "attempted" vs "not-yet" on map)
    try {
      const nearby = await API.scramblesNearby();
      const nearbyMap = Object.fromEntries(nearby.map(n => [n.id, n.nearby_count]));
      state.scrambles.forEach(s => {
        s.nearby_count = nearbyMap[s.id] || s.seg_attempts || 0;
      });
    } catch (_) {}
    populateScramblesAreaFilter();
    renderScramblesTable();
    loadScramblesOnMap(state.scrambles, getChecked());
  } catch (e) { console.warn("scrambles:", e); }
}

function populateScramblesAreaFilter() {
  const sel = document.getElementById("scramble-area-filter");
  const areas = [...new Set(state.scrambles.map(s => s.area))].sort();
  sel.innerHTML = '<option value="">All areas</option>';
  areas.forEach(a => {
    const opt = document.createElement("option");
    opt.value = a; opt.textContent = a;
    sel.appendChild(opt);
  });
}

function renderScramblesTable() {
  const checked   = getChecked();
  const search    = (document.getElementById("scramble-search")?.value || "").toLowerCase();
  const stateF    = document.getElementById("scramble-state-filter")?.value || "";
  const areaF     = document.getElementById("scramble-area-filter")?.value || "";
  const classF    = document.getElementById("scramble-class-filter")?.value || "";
  const doneOnly  = document.getElementById("scramble-done-only")?.checked;
  const undoneOnly= document.getElementById("scramble-undone-only")?.checked;

  let data = state.scrambles;
  if (search)    data = data.filter(s => `${s.formation} ${s.route} ${s.area}`.toLowerCase().includes(search));
  if (stateF)    data = data.filter(s => s.state === stateF);
  if (areaF)     data = data.filter(s => s.area === areaF);
  if (classF) {
    if (classF === "5") data = data.filter(s => String(s.class).startsWith("5"));
    else                data = data.filter(s => String(s.class) === classF);
  }
  if (doneOnly)  data = data.filter(s => checked.has(s.id));
  if (undoneOnly)data = data.filter(s => !checked.has(s.id));

  const tbody = document.getElementById("scrambles-tbody");
  tbody.innerHTML = "";
  data.forEach(s => {
    const done = checked.has(s.id);
    const hasStrava = s.seg_attempts > 0;
    const tr = document.createElement("tr");
    tr.className = `scramble-row ${done ? "done-row" : ""}`;
    tr.dataset.id = s.id;

    const stravaChip = hasStrava
      ? `<span class="strava-chip" data-visits="${s.id}" title="${s.seg_attempts} Strava segment attempts${s.seg_pr_s ? ', PR: '+fmtDuration(Math.round(s.seg_pr_s)) : ''} — click for ascent dates">⚡ ${s.seg_attempts}</span>`
      : (s.nearby_count > 0
        ? `<span class="strava-chip nearby" data-visits="${s.id}" title="${s.nearby_count} likely ascents — click for dates">📍 ${s.nearby_count}</span>`
        : "");

    const infoUrl = scrambleInfoUrl(s);

    tr.innerHTML = `
      <td class="check-col">
        <input type="checkbox" class="scramble-check" data-id="${s.id}" ${done ? "checked" : ""} />
      </td>
      <td>${s.formation}${stravaChip}</td>
      <td>${s.route} <a href="${infoUrl}" target="_blank" class="info-link" title="Search Mountain Project" onclick="event.stopPropagation()">↗</a></td>
      <td>${s.area}</td>
      <td>${s.state}</td>
      <td><span class="class-badge cls-${String(s.class).replace(".","_")}">${s.class}</span></td>
      <td>${s.elev_ft ? s.elev_ft.toLocaleString() + " ft" : "—"}</td>`;

    // Checkbox toggle
    tr.querySelector(".scramble-check").addEventListener("change", (e) => {
      e.stopPropagation();
      const newChecked = toggleChecked(s.id);
      tr.classList.toggle("done-row", newChecked.has(s.id));
      loadScramblesOnMap(state.scrambles, newChecked);
      updateScramblesProgress();
    });

    // Row click → fly map to route
    tr.addEventListener("click", (e) => {
      if (e.target.type === "checkbox") return;
      if (e.target.dataset && e.target.dataset.visits) return; // chip handles itself
      flyToScramble(s);
    });

    // Visits chip click → expand likely ascent dates inline
    const chip = tr.querySelector("[data-visits]");
    if (chip) {
      chip.style.cursor = "pointer";
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleVisitsRow(tr, s);
      });
    }

    tbody.appendChild(tr);
  });

  const countEl = document.getElementById("scrambles-count");
  if (countEl) countEl.textContent = `${data.length} of ${state.scrambles.length}`;
  updateScramblesProgress();
}

async function toggleVisitsRow(tr, s) {
  // Collapse if already open
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("visits-row")) {
    next.remove();
    return;
  }
  // Remove any other open visits row
  document.querySelectorAll(".visits-row").forEach(r => r.remove());

  const row = document.createElement("tr");
  row.className = "visits-row";
  const td = document.createElement("td");
  td.colSpan = 7;
  td.innerHTML = `<div class="visits-loading">Loading ascent history…</div>`;
  row.appendChild(td);
  tr.after(row);

  try {
    const visits = await API.scrambleVisits(s.id);
    if (!visits.length) {
      td.innerHTML = `<div class="visits-empty">No GPS-detected ascents.</div>`;
      return;
    }
    const items = visits.slice(0, 12).map(v => {
      const date = fmtDate(v.date);
      const dur  = v.duration_s ? ` · ${fmtDuration(v.duration_s)}` : "";
      return `<span class="visit-item" data-act="${v.activity_id}" title="Click to show on map">
        ${date} <span class="visit-name">${v.name || ""}${dur}</span></span>`;
    }).join("");
    const more = visits.length > 12 ? `<span class="visits-more">+${visits.length - 12} more</span>` : "";
    td.innerHTML = `<div class="visits-list">
      <span class="visits-label">${visits.length} likely ascent${visits.length > 1 ? "s" : ""}:</span>
      ${items}${more}</div>`;

    // Click a visit → highlight that activity on the map
    td.querySelectorAll(".visit-item").forEach(el => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const coords = await API.activityTrack(el.dataset.act);
          if (coords.length > 1) highlightActivity(coords);
        } catch (_) {}
      });
    });
  } catch (e) {
    td.innerHTML = `<div class="visits-empty">Could not load visits.</div>`;
  }
}

function renderGradePyramid() {
  const el = document.getElementById("grade-pyramid");
  if (!el) return;
  const checked = getChecked();
  // Bucket: 3, 4, 5.0–5.4, 5.5+
  const buckets = [
    { label: "Cl.3",   match: c => c === "3" },
    { label: "Cl.4",   match: c => c === "4" },
    { label: "5.0–5.4",match: c => /^5\.[0-4]$/.test(c) },
    { label: "5.5+",   match: c => /^5\.[5-9]/.test(c) },
  ];
  el.innerHTML = buckets.map(b => {
    const all  = state.scrambles.filter(s => b.match(String(s.class)));
    const done = all.filter(s => checked.has(s.id)).length;
    const pct  = all.length ? (done / all.length) * 100 : 0;
    return `<span class="pyramid-item" title="${done}/${all.length} ${b.label} done">
      <span class="pyramid-label">${b.label}</span>
      <span class="pyramid-bar"><span class="pyramid-fill" style="width:${pct}%"></span></span>
      <span class="pyramid-count">${done}/${all.length}</span></span>`;
  }).join("");
}

function updateScramblesProgress() {
  renderGradePyramid();
  const checked = getChecked();
  const total   = state.scrambles.length;
  const done    = state.scrambles.filter(s => checked.has(s.id)).length;
  const pct     = total ? (done / total) * 100 : 0;
  const fill    = document.getElementById("scrambles-progress-fill");
  const label   = document.getElementById("scrambles-progress-label");
  if (fill)  fill.style.width = pct + "%";
  if (label) label.textContent = `${done} / ${total} completed`;
}

async function flyToScramble(s) {
  if (!s.lat || !s.lon) return;

  // Highlight row
  document.querySelectorAll(".scramble-row").forEach(r =>
    r.classList.toggle("active", r.dataset.id === s.id));

  // Fly map to the scramble
  if (typeof map !== "undefined" && map) {
    map.flyTo({ center: [s.lon, s.lat], zoom: 14, speed: 1.4 });
  }

  // Always try to fetch and highlight a track (segment-linked or nearest)
  clearSegmentHighlight();
  try {
    const coords = await API.scrambleTrack(s.id);
    if (coords && coords.length > 1) {
      highlightSegment(coords);
    }
  } catch (_) {}
}

function scrambleInfoUrl(s) {
  // Generate a Mountain Project search URL for the route
  const q = encodeURIComponent(`${s.formation} ${s.route}`);
  return `https://www.mountainproject.com/search?q=${q}&type=route`;
}

// ── Sorting helpers ───────────────────────────────────────────────────────────

function sortData(data, col, dir, type) {
  return [...data].sort((a, b) => {
    let av = a[col], bv = b[col];
    if (type === "date") { av = new Date(av || 0); bv = new Date(bv || 0); }
    else if (type === "num") { av = av ?? -Infinity; bv = bv ?? -Infinity; }
    else { av = (av || "").toLowerCase(); bv = (bv || "").toLowerCase(); }
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

function updateSortIcons(table, sortState) {
  table.querySelectorAll("th[data-col]").forEach(th => {
    const icon = th.querySelector(".sort-icon");
    if (!icon) return;
    if (th.dataset.col === sortState.col) {
      icon.textContent = sortState.dir === "asc" ? "▲" : "▼";
      th.classList.add("sorted");
    } else {
      icon.textContent = "";
      th.classList.remove("sorted");
    }
  });
}

function bindTableSort(tableId, sortStateKey, renderFn) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.querySelectorAll("th[data-col]").forEach(th => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const col  = th.dataset.col;
      const type = th.dataset.type || "str";
      const cur  = state[sortStateKey] || {};
      state[sortStateKey] = {
        col,
        dir: cur.col === col && cur.dir === "asc" ? "desc" : "asc",
        type,
      };
      updateSortIcons(table, state[sortStateKey]);
      renderFn();
    });
  });
}

// ── Table renderers ───────────────────────────────────────────────────────────

function routeDisplayName(r) {
  return r.custom_name || r.name;
}

function startRouteRename(cell, route) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = routeDisplayName(route);
  cell.innerHTML = "";
  cell.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener("click", e => e.stopPropagation());

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    if (save && newName && newName !== routeDisplayName(route)) {
      try {
        await API.renameRoute(route.id, newName);
        route.custom_name = newName;
        loadSummary(); // refresh top-routes sidebar
      } catch (e) { showToast("Rename failed"); }
    }
    renderRoutesTable();
  };

  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function renderRoutesTable() {
  const filter  = state.routeFilter.toLowerCase();
  const sort    = state.routeSort;

  let data = state.routes;
  if (filter) data = data.filter(r => routeDisplayName(r).toLowerCase().includes(filter));
  data = sortData(data, sort.col, sort.dir, sort.type || "num");

  const tbody = document.getElementById("routes-tbody");
  tbody.innerHTML = "";
  data.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.routeId = r.id;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="name-cell" title="Double-click to rename">${routeDisplayName(r)}${r.custom_name ? ' <span class="renamed-dot" title="Custom name">●</span>' : ""}</td>
      <td><span class="count-badge">${r.count}</span></td>
      <td>${fmtDist(r.total_distance_m)}</td>
      <td>${fmtDuration(r.best_duration_s)}</td>
      <td>${fmtDuration(r.avg_duration_s)}</td>
      <td>${fmtPace(r.best_speed_ms)}</td>
      <td>${fmtEle(r.avg_elevation_m)}</td>`;
    tr.addEventListener("click", () => selectRoute(r.id));

    // Double-click name cell → inline rename
    const nameCell = tr.querySelector(".name-cell");
    nameCell.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRouteRename(nameCell, r);
    });

    tbody.appendChild(tr);
  });

  const countEl = document.getElementById("routes-count");
  if (countEl) countEl.textContent = `${data.length} of ${state.routes.length}`;

  updateSortIcons(document.getElementById("routes-table"), sort);
}

function renderActivitiesTable() {
  const filter = state.activityFilter.toLowerCase();
  const sort   = state.activitySort;

  let data = state.activities;
  if (filter) data = data.filter(a =>
    (a.name || "").toLowerCase().includes(filter) ||
    (a.type || "").toLowerCase().includes(filter)
  );
  data = sortData(data, sort.col, sort.dir, sort.type || "str");

  const tbody = document.getElementById("activities-tbody");
  tbody.innerHTML = "";
  data.forEach(a => {
    const tr = document.createElement("tr");
    tr.dataset.actId = a.id;
    tr.classList.toggle("active", a.id === state.selectedActivityId);
    tr.innerHTML = `
      <td>${fmtDate(a.date)}</td>
      <td>${a.name}</td>
      <td><span class="type-badge type-${(a.type||"").replace(/\s+/g,"")}">${a.type}</span></td>
      <td>${fmtDist(a.distance_m)}</td>
      <td>${fmtDuration(a.duration_s)}</td>
      <td>${fmtEle(a.elevation_m)}</td>
      <td>${fmtHR(a.avg_hr)}</td>
      <td>${fmtPace(a.avg_speed_ms, a.type)}</td>`;
    tr.addEventListener("click", () => selectActivity(a.id));
    tbody.appendChild(tr);
  });

  const countEl = document.getElementById("activities-count");
  if (countEl) countEl.textContent = `${data.length} of ${state.activities.length}`;

  updateSortIcons(document.getElementById("activities-table"), sort);
}

function renderSegmentsTable() {
  const sort = state.segmentSort;
  let data = state.segments;
  if (state.segmentFilter) data = data.filter(s => s.name.toLowerCase().includes(state.segmentFilter.toLowerCase()));
  if (state.starredOnly)   data = data.filter(s => s.is_starred);
  data = sortData(data, sort.col, sort.dir, sort.type || "num");

  const tbody = document.getElementById("segments-tbody");
  tbody.innerHTML = "";
  data.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.dataset.uuid = s.uuid;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="name-cell">${s.name}</td>
      <td><span class="count-badge">${s.attempt_count}</span></td>
      <td>${s.effort_count > 0 ? s.effort_count : "—"}</td>
      <td>${fmtDuration(s.pr_time_s)}</td>
      <td>${fmtDuration(s.avg_time_s)}</td>
      <td><span class="type-badge">${s.sport || "—"}</span></td>
      <td>${s.is_starred ? "⭐" : ""}</td>`;
    tr.addEventListener("click", () => selectSegment(s.uuid));
    tbody.appendChild(tr);
  });

  const countEl = document.getElementById("segments-count");
  if (countEl) countEl.textContent = `${data.length} of ${state.segments.length}`;
  updateSortIcons(document.getElementById("segments-table"), sort);
}

function renderEffortsTable(efforts) {
  const sort = state.effortSort;
  const data = sortData(efforts, sort.col, sort.dir, sort.type || "date");
  const prTime = Math.min(...efforts.map(e => e.elapsed_time_s).filter(Boolean));

  const tbody = document.getElementById("segment-efforts-tbody");
  tbody.innerHTML = "";
  data.forEach(e => {
    const isComplete = e.completed === 1 || e.completed === true;
    const isPR = isComplete && e.elapsed_time_s && e.elapsed_time_s === prTime;
    const tr = document.createElement("tr");
    if (isPR) tr.classList.add("pr-row");
    if (!isComplete) tr.classList.add("dnf-row");
    tr.innerHTML = `
      <td>${fmtDate(e.start_time || e.date)}</td>
      <td class="name-cell">${e.activity_name || "—"}</td>
      <td>${fmtDuration(e.elapsed_time_s)}</td>
      <td>${fmtDist(e.distance_m)}</td>
      <td>${isComplete ? fmtPace(e.avg_speed_ms, e.type) : "—"}</td>
      <td>${fmtHR(e.avg_hr)}</td>
      <td>${isPR ? "🥇 PR" : isComplete ? "✓" : "DNF"}</td>`;
    tbody.appendChild(tr);
  });
  updateSortIcons(document.getElementById("segment-efforts-table"), sort);
}

async function selectSegment(uuid) {
  state.selectedSegmentUuid = uuid;
  clearActivityHighlight();

  document.querySelectorAll("#segments-tbody tr").forEach(tr =>
    tr.classList.toggle("active", tr.dataset.uuid === uuid));

  // Load and highlight segment track
  try {
    const coords = await API.segmentTrack(uuid);
    if (coords.length > 1) highlightSegment(coords);
  } catch (e) { console.warn("segment track:", e); }

  // Load efforts
  try {
    const efforts = await API.segmentEfforts(uuid);
    const seg = state.segments.find(s => s.uuid === uuid);
    state.detailEfforts = efforts;
    showSegmentDetail(seg, efforts);
  } catch (e) { console.warn("segment efforts:", e); }
}

function showSegmentDetail(seg, efforts) {
  const detail = document.getElementById("segment-detail");
  const wrap   = document.getElementById("segments-list-wrap");
  detail.classList.remove("hidden");
  wrap.classList.add("hidden");

  const header = document.getElementById("segment-detail-header");
  header.innerHTML = `
    <button id="back-to-segments">← All Segments</button>
    <h2>${seg?.name ?? "Segment"}</h2>
    <div class="route-summary-chips">
      <span class="chip">${seg?.attempt_count ?? "?"} attempts</span>
      ${seg?.effort_count > 0 ? `<span class="chip">✓ ${seg.effort_count} finished</span>` : ""}
      ${seg?.pr_time_s ? `<span class="chip">🥇 PR: ${fmtDuration(seg.pr_time_s)}</span>` : ""}
      ${seg?.avg_time_s ? `<span class="chip">Avg: ${fmtDuration(seg.avg_time_s)}</span>` : ""}
      <span class="chip">${seg?.sport || ""}</span>
      ${seg?.is_starred ? '<span class="chip">⭐ Starred</span>' : ""}
      <a class="chip chip-link" href="https://www.strava.com/segments/${seg?.uuid}" target="_blank">View on Strava ↗</a>
    </div>`;

  document.getElementById("back-to-segments").addEventListener("click", () => {
    detail.classList.add("hidden");
    wrap.classList.remove("hidden");
    clearSegmentHighlight();
    state.selectedSegmentUuid = null;
  });

  renderEffortsTable(efforts);
  bindTableSort("segment-efforts-table", "effortSort", () => renderEffortsTable(state.detailEfforts));
}

function renderDetailTable(acts) {
  const sort = state.detailSort;
  const data = sortData(acts, sort.col, sort.dir, sort.type || "str");
  const tbody = document.querySelector("#route-acts-table tbody");
  tbody.innerHTML = "";
  data.forEach(a => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(a.date)}</td>
      <td>${a.name}</td>
      <td>${fmtDist(a.distance_m)}</td>
      <td>${fmtDuration(a.duration_s)}</td>
      <td>${fmtEle(a.elevation_m)}</td>
      <td>${fmtHR(a.avg_hr)}</td>
      <td>${fmtPace(a.avg_speed_ms, a.type)}</td>`;
    tbody.appendChild(tr);
  });
  updateSortIcons(document.getElementById("route-acts-table"), sort);
}

// ── MapBox quota ──────────────────────────────────────────────────────────────

function renderMapboxQuota() {
  const count  = getMapLoadStats();
  const pct    = (count / MB_LIMIT) * 100;
  const fill   = document.getElementById("mb-quota-fill");
  const label  = document.getElementById("mb-quota-label");
  fill.style.width = Math.min(pct, 100) + "%";
  fill.classList.toggle("warn",   pct >= 80 && pct < 95);
  fill.classList.toggle("danger", pct >= 95);
  label.textContent = `${count.toLocaleString()} / ${MB_LIMIT.toLocaleString()}`;
}

// ── Route detail ──────────────────────────────────────────────────────────────

async function selectRoute(routeId) {
  state.selectedRouteId = routeId;

  document.querySelectorAll(".top-route-item").forEach(li =>
    li.classList.toggle("active", +li.dataset.routeId === routeId));
  document.querySelectorAll("#routes-tbody tr").forEach(tr =>
    tr.classList.toggle("active", +tr.dataset.routeId === routeId));

  try {
    const coords = await API.routeTrack(routeId);
    highlightRoute(coords);
  } catch (e) { console.warn("route track:", e); }

  try {
    const acts = await API.routeActivities(routeId);
    const route = state.routes.find(r => r.id === routeId);
    state.detailActivities = acts;
    showRouteDetail(route, acts);
    switchTab("routes");
  } catch (e) { console.warn("route acts:", e); }
}

function showRouteDetail(route, acts) {
  const detail = document.getElementById("route-detail");
  const wrap   = document.getElementById("routes-table-wrap");
  detail.classList.remove("hidden");
  wrap.classList.add("hidden");

  const header = document.getElementById("route-detail-header");
  header.innerHTML = `
    <button id="back-to-routes">← All Routes</button>
    <h2>${route ? routeDisplayName(route) : "Route"}</h2>
    <div class="route-summary-chips">
      <span class="chip">${route?.count ?? "?"} runs</span>
      <span class="chip">Best: ${fmtDuration(route?.best_duration_s)}</span>
      <span class="chip">Avg: ${fmtDuration(route?.avg_duration_s)}</span>
      <span class="chip">${fmtDist(route?.total_distance_m)}</span>
      <span class="chip">Best pace: ${fmtPace(route?.best_speed_ms)}</span>
    </div>`;

  document.getElementById("back-to-routes").addEventListener("click", () => {
    detail.classList.add("hidden");
    wrap.classList.remove("hidden");
    clearRouteHighlight();
    state.selectedRouteId = null;
  });

  renderDetailTable(acts);
  renderRouteSpeedChart(acts);

  // Bind sort on detail table
  bindTableSort("route-acts-table", "detailSort", () => renderDetailTable(state.detailActivities));
}

// ── Activity selection → map ──────────────────────────────────────────────────

async function selectActivity(actId) {
  // Toggle off if clicking the same one
  if (state.selectedActivityId === actId) {
    state.selectedActivityId = null;
    clearActivityHighlight();
    hideElevationProfile();
    document.querySelectorAll("#activities-tbody tr").forEach(tr => tr.classList.remove("active"));
    return;
  }
  state.selectedActivityId = actId;
  clearSegmentHighlight();

  document.querySelectorAll("#activities-tbody tr").forEach(tr =>
    tr.classList.toggle("active", tr.dataset.actId === actId));

  try {
    const coords = await API.activityTrack(actId);
    if (coords.length > 1) {
      highlightActivity(coords);
    } else {
      // No GPS track — just show a toast
      showToast("No GPS track available for this activity");
    }
  } catch (e) { console.warn("activity track:", e); }

  // Elevation profile overlay
  try {
    const profile = await API.activityProfile(actId);
    if (profile.length > 5) {
      const act = state.activities.find(a => a.id === actId);
      renderElevationProfile(profile, act ? `${act.name} — ${fmtDate(act.date)}` : "Elevation");
    } else {
      hideElevationProfile();
    }
  } catch (e) { console.warn("profile:", e); }
}

function showToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2500);
}

// ── Unit refresh — re-render all visible data with new units ──────────────────

function refreshUnits() {
  loadSummary();
  renderRoutesTable();
  renderActivitiesTable();
  renderBigDaysTable();
  loadYearStats();
  if (state.selectedRouteId && state.detailActivities.length) {
    const route = state.routes.find(r => r.id === state.selectedRouteId);
    showRouteDetail(route, state.detailActivities);
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────

function bindControls() {
  // Type filter
  document.getElementById("type-filter").addEventListener("change", async e => {
    state.type = e.target.value || null;
    await Promise.all([
      loadHeatmapData(),
      loadRoutes(),
      loadActivities(),
      loadTimeline(),
      loadYearStats(),
    ]);
  });

  // Elevation overlay close
  document.getElementById("elevation-close").addEventListener("click", hideElevationProfile);

  // Unit toggle
  document.getElementById("unit-toggle").addEventListener("change", e => {
    USE_MILES = e.target.checked;
    document.getElementById("unit-km").classList.toggle("active", !USE_MILES);
    document.getElementById("unit-mi").classList.toggle("active",  USE_MILES);
    refreshUnits();
  });

  // Fit button
  document.getElementById("btn-fit").addEventListener("click", fitAll);

  // Layer toggles
  document.getElementById("toggle-heatmap").addEventListener("change", e =>
    setLayerVisibility("heatmap-lines", e.target.checked));
  document.getElementById("toggle-clusters").addEventListener("change", e =>
    setLayerVisibility("route-markers-circle", e.target.checked));
  document.getElementById("toggle-satellite").addEventListener("change", e =>
    setLayerVisibility("satellite-layer", e.target.checked));

  document.getElementById("toggle-scrambles").addEventListener("change", e => {
    setScramblesVisible(e.target.checked);
  });

  // Scramble marker click → fly to it and show track
  document.addEventListener("scrambleMarkerClick", async (e) => {
    const { id } = e.detail;
    const scr = state.scrambles.find(s => s.id === id);
    if (scr) {
      await flyToScramble(scr);
      switchTab("scrambles");
      // Scroll the row into view
      const row = document.querySelector(`.scramble-row[data-id="${id}"]`);
      if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });

  // Tab switching
  document.querySelectorAll(".tab-btn").forEach(btn =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  // Sidebar collapse
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("collapsed");
    document.getElementById("sidebar-toggle").textContent =
      document.getElementById("sidebar").classList.contains("collapsed") ? "▶" : "◀";
  });

  // Route search
  document.getElementById("route-search").addEventListener("input", e => {
    state.routeFilter = e.target.value;
    renderRoutesTable();
  });

  // Activity search
  document.getElementById("activity-search").addEventListener("input", e => {
    state.activityFilter = e.target.value;
    renderActivitiesTable();
  });

  // Scramble filters
  ["scramble-search","scramble-state-filter","scramble-area-filter",
   "scramble-class-filter","scramble-done-only","scramble-undone-only"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", renderScramblesTable);
    if (el && el.tagName === "INPUT" && el.type === "text")
      el.addEventListener("input", renderScramblesTable);
  });
  bindTableSort("scrambles-table", "scrambleSort", renderScramblesTable);

  // Table sort bindings
  bindTableSort("routes-table",     "routeSort",    renderRoutesTable);
  bindTableSort("activities-table", "activitySort", renderActivitiesTable);
  bindTableSort("segments-table",   "segmentSort",  renderSegmentsTable);
  bindTableSort("bigdays-table",    "bigDaySort",   renderBigDaysTable);

  // Segment search + starred filter
  document.getElementById("segment-search").addEventListener("input", e => {
    state.segmentFilter = e.target.value;
    renderSegmentsTable();
  });
  document.getElementById("toggle-starred").addEventListener("change", e => {
    state.starredOnly = e.target.checked;
    renderSegmentsTable();
  });

  // Route marker clicks from map
  document.addEventListener("routeMarkerClick", e => selectRoute(e.detail.id));
}

// ── Resizable panel ───────────────────────────────────────────────────────────

function initResizeHandle() {
  const handle      = document.getElementById("resize-handle");
  const bottomPanel = document.getElementById("bottom-panel");
  const main        = document.getElementById("main");
  const MIN_H = 80;   // bottom panel minimum height px
  const MAX_H = 0.85; // bottom panel max = 85% of main height

  let startY, startH;

  handle.addEventListener("mousedown", e => {
    startY = e.clientY;
    startH = bottomPanel.offsetHeight;
    handle.classList.add("dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    function onMove(e) {
      const delta  = startY - e.clientY;          // drag up = bigger panel
      const mainH  = main.offsetHeight;
      const newH   = Math.min(
        Math.max(startH + delta, MIN_H),
        Math.floor(mainH * MAX_H)
      );
      bottomPanel.style.height = newH + "px";
      // Trigger map resize so MapBox redraws correctly
      if (typeof map !== "undefined" && map && map.resize) map.resize();
    }

    function onUp() {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",  onUp);
      // Save preference
      localStorage.setItem("bottomPanelH", bottomPanel.offsetHeight);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
    e.preventDefault();
  });

  // Restore saved height
  const saved = localStorage.getItem("bottomPanelH");
  if (saved) bottomPanel.style.height = parseInt(saved) + "px";

  // Double-click resets to default
  handle.addEventListener("dblclick", () => {
    bottomPanel.style.height = "";
    localStorage.removeItem("bottomPanelH");
    if (typeof map !== "undefined" && map && map.resize) map.resize();
  });
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-content").forEach(c =>
    c.classList.toggle("active", c.id === `tab-${tab}`));
}
