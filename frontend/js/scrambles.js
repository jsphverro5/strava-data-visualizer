// ── Scrambles checklist ───────────────────────────────────────────────────────
// Checked state persists in localStorage keyed by route id.

const STORAGE_KEY = "scrambles_done";

let _allScrambles   = [];
let _scrambleSort   = { col: "area", dir: "asc", type: "str" };
let _scrambleFilter = { text: "", state: "", area: "", cls: "", doneOnly: false, undoneOnly: false };

// ── Persistence ───────────────────────────────────────────────────────────────

function getDoneSet() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]")); }
  catch { return new Set(); }
}

function saveDoneSet(set) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
}

function toggleDone(id) {
  const done = getDoneSet();
  done.has(id) ? done.delete(id) : done.add(id);
  saveDoneSet(done);
  renderScrambles();
}

// ── Load & render ─────────────────────────────────────────────────────────────

async function loadScrambles() {
  try {
    _allScrambles = await apiFetch("/scrambles");
    _populateAreaFilter();
    renderScrambles();
    bindScramblesControls();
  } catch (e) { console.warn("scrambles:", e); }
}

function _populateAreaFilter() {
  const areas = [...new Set(_allScrambles.map(s => s.area))].sort();
  const sel   = document.getElementById("scramble-area-filter");
  areas.forEach(a => {
    const opt = document.createElement("option");
    opt.value = a; opt.textContent = a;
    sel.appendChild(opt);
  });
}

function renderScrambles() {
  const done = getDoneSet();
  const f    = _scrambleFilter;

  let data = _allScrambles.filter(s => {
    if (f.text && ![s.formation, s.route, s.area, s.state].join(" ").toLowerCase().includes(f.text)) return false;
    if (f.state && s.state !== f.state) return false;
    if (f.area  && s.area  !== f.area)  return false;
    if (f.cls) {
      if (f.cls === "5" && !s.class.startsWith("5")) return false;
      if (f.cls === "4" && s.class !== "4")          return false;
      if (f.cls === "3" && s.class !== "3")          return false;
    }
    if (f.doneOnly   && !done.has(s.id)) return false;
    if (f.undoneOnly &&  done.has(s.id)) return false;
    return true;
  });

  // Sort
  data = [...data].sort((a, b) => {
    let av = a[_scrambleSort.col], bv = b[_scrambleSort.col];
    if (_scrambleSort.type === "num") { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; }
    else { av = (av || "").toLowerCase(); bv = (bv || "").toLowerCase(); }
    if (av < bv) return _scrambleSort.dir === "asc" ? -1 : 1;
    if (av > bv) return _scrambleSort.dir === "asc" ? 1  : -1;
    return 0;
  });

  // Progress bar
  const totalDone = _allScrambles.filter(s => done.has(s.id)).length;
  const total     = _allScrambles.length;
  const pct       = total ? (totalDone / total) * 100 : 0;
  document.getElementById("scrambles-progress-fill").style.width = pct.toFixed(1) + "%";
  document.getElementById("scrambles-progress-label").textContent =
    `${totalDone} / ${total} completed`;
  document.getElementById("scrambles-count").textContent =
    `Showing ${data.length} of ${total}`;

  // Render rows
  const tbody = document.getElementById("scrambles-tbody");
  tbody.innerHTML = "";

  // Group by area for visual separation
  let lastArea = null;
  data.forEach(s => {
    const isDone = done.has(s.id);

    if (s.area !== lastArea) {
      const groupRow = document.createElement("tr");
      groupRow.className = "group-header-row";
      groupRow.innerHTML = `<td colspan="7">${s.area} · ${s.state}</td>`;
      tbody.appendChild(groupRow);
      lastArea = s.area;
    }

    const tr = document.createElement("tr");
    tr.className = isDone ? "scramble-done" : "";
    tr.innerHTML = `
      <td class="check-col">
        <input type="checkbox" class="scramble-check" data-id="${s.id}" ${isDone ? "checked" : ""} />
      </td>
      <td>${s.formation}</td>
      <td class="route-name-col">${s.route}</td>
      <td>${s.area}</td>
      <td>${s.state}</td>
      <td><span class="class-badge class-${s.class.replace(".","")}">${s.class}</span></td>
      <td>${s.elev_ft ? s.elev_ft.toLocaleString() + " ft" : "—"}</td>`;
    tbody.appendChild(tr);
  });

  // Bind checkboxes
  tbody.querySelectorAll(".scramble-check").forEach(cb => {
    cb.addEventListener("change", e => toggleDone(e.target.dataset.id));
  });

  updateScramblesSort();
}

function updateScramblesSort() {
  const table = document.getElementById("scrambles-table");
  if (!table) return;
  table.querySelectorAll("th[data-col]").forEach(th => {
    const icon = th.querySelector(".sort-icon");
    if (!icon) return;
    if (th.dataset.col === _scrambleSort.col) {
      icon.textContent = _scrambleSort.dir === "asc" ? "▲" : "▼";
      th.classList.add("sorted");
    } else {
      icon.textContent = "";
      th.classList.remove("sorted");
    }
  });
}

// ── Controls ──────────────────────────────────────────────────────────────────

function bindScramblesControls() {
  document.getElementById("scramble-search").addEventListener("input", e => {
    _scrambleFilter.text = e.target.value.toLowerCase();
    renderScrambles();
  });
  document.getElementById("scramble-state-filter").addEventListener("change", e => {
    _scrambleFilter.state = e.target.value;
    // Reset area filter when state changes
    document.getElementById("scramble-area-filter").value = "";
    _scrambleFilter.area = "";
    renderScrambles();
  });
  document.getElementById("scramble-area-filter").addEventListener("change", e => {
    _scrambleFilter.area = e.target.value;
    renderScrambles();
  });
  document.getElementById("scramble-class-filter").addEventListener("change", e => {
    _scrambleFilter.cls = e.target.value;
    renderScrambles();
  });
  document.getElementById("scramble-done-only").addEventListener("change", e => {
    _scrambleFilter.doneOnly = e.target.checked;
    if (e.target.checked) {
      document.getElementById("scramble-undone-only").checked = false;
      _scrambleFilter.undoneOnly = false;
    }
    renderScrambles();
  });
  document.getElementById("scramble-undone-only").addEventListener("change", e => {
    _scrambleFilter.undoneOnly = e.target.checked;
    if (e.target.checked) {
      document.getElementById("scramble-done-only").checked = false;
      _scrambleFilter.doneOnly = false;
    }
    renderScrambles();
  });

  // Column sort
  document.getElementById("scrambles-table").querySelectorAll("th[data-col]").forEach(th => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const col  = th.dataset.col;
      const type = th.dataset.type || "str";
      _scrambleSort = {
        col,
        type,
        dir: _scrambleSort.col === col && _scrambleSort.dir === "asc" ? "desc" : "asc",
      };
      renderScrambles();
    });
  });
}
