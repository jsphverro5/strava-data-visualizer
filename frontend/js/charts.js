// ── Chart helpers ─────────────────────────────────────────────────────────────

let timelineChart = null;
let routeSpeedChart = null;
let elevationChart = null;

function renderElevationProfile(profile, title) {
  // profile: [[cumulative_m, ele_m], ...]
  const overlay = document.getElementById("elevation-overlay");
  const titleEl = document.getElementById("elevation-title");
  overlay.classList.remove("hidden");
  if (titleEl) titleEl.textContent = title || "Elevation profile";

  const toDist = m => USE_MILES ? m / 1609.344 : m / 1000;
  const toEle  = m => USE_MILES ? m * 3.28084 : m;
  const distUnit = USE_MILES ? "mi" : "km";
  const eleUnit  = USE_MILES ? "ft" : "m";

  const data = profile.map(([d, e]) => ({ x: toDist(d), y: toEle(e) }));

  if (elevationChart) elevationChart.destroy();
  const ctx = document.getElementById("elevation-chart").getContext("2d");
  elevationChart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [{
        data,
        borderColor: "#22d3ee",
        backgroundColor: "rgba(34,211,238,0.12)",
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `${items[0].parsed.x.toFixed(1)} ${distUnit}`,
            label: item => `${Math.round(item.parsed.y).toLocaleString()} ${eleUnit}`,
          },
        },
      },
      scales: {
        x: { type: "linear", ticks: { color: "#64748b", maxTicksLimit: 8,
              callback: v => v.toFixed(0) }, grid: { color: "#1e293b" },
             title: { display: true, text: distUnit, color: "#64748b" } },
        y: { ticks: { color: "#64748b", maxTicksLimit: 5,
              callback: v => Math.round(v).toLocaleString() }, grid: { color: "#1e293b" } },
      },
    },
  });
}

function hideElevationProfile() {
  document.getElementById("elevation-overlay").classList.add("hidden");
  if (elevationChart) { elevationChart.destroy(); elevationChart = null; }
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: "#94a3b8" } } },
  scales: {
    x: { ticks: { color: "#64748b" }, grid: { color: "#1e293b" } },
    y: { ticks: { color: "#64748b" }, grid: { color: "#1e293b" } },
  },
};

function renderTimeline(data) {
  const labels  = data.map(d => d.month);
  const counts  = data.map(d => d.count);
  const km      = data.map(d => Math.round(d.km * 10) / 10);

  if (timelineChart) timelineChart.destroy();

  const ctx = document.getElementById("timeline-chart").getContext("2d");
  timelineChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Activities",
          data: counts,
          backgroundColor: "rgba(251,146,60,0.7)",
          borderColor: "#f97316",
          borderWidth: 1,
          yAxisID: "y",
        },
        {
          label: "km",
          data: km,
          type: "line",
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59,130,246,0.1)",
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.3,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ticks: { color: "#64748b", maxRotation: 45 }, grid: { color: "#1e293b" } },
        y:  { position: "left",  ticks: { color: "#64748b" }, grid: { color: "#1e293b" } },
        y1: { position: "right", ticks: { color: "#3b82f6" }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function renderRouteSpeedChart(activities) {
  // Bar chart: duration per activity date, sorted chronologically
  const sorted = [...activities].sort((a, b) => new Date(a.date) - new Date(b.date));
  const labels  = sorted.map(a => fmtDate(a.date));
  const durs    = sorted.map(a => a.duration_s ? Math.round(a.duration_s / 60) : null);

  if (routeSpeedChart) routeSpeedChart.destroy();

  const ctx = document.getElementById("route-speed-chart").getContext("2d");
  routeSpeedChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Duration (min)",
        data: durs,
        backgroundColor: "rgba(168,85,247,0.65)",
        borderColor: "#a855f7",
        borderWidth: 1,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => fmtDuration(sorted[ctx.dataIndex].duration_s),
          },
        },
      },
      scales: {
        x: { ticks: { color: "#64748b", maxRotation: 45, maxTicksLimit: 12 }, grid: { color: "#1e293b" } },
        y: { ticks: { color: "#64748b" }, grid: { color: "#1e293b" }, title: { display: true, text: "minutes", color: "#64748b" } },
      },
    },
  });
}
