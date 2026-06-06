// ── User configuration ────────────────────────────────────────────────────────
// Set your MapBox public token here.
// Get one free at https://account.mapbox.com/
// ⚠️  Replace with your own free MapBox token from https://account.mapbox.com
// After creating your token, restrict it to http://localhost/* in the token settings.
//
// 👉 Do NOT put your real token in this file (it's committed to git).
//    Instead, copy frontend/js/config.local.example.js to frontend/js/config.local.js
//    and put your token there. That file is gitignored and overrides the value below.
let MAPBOX_TOKEN = "YOUR_MAPBOX_TOKEN_HERE";

// API base URL (Flask backend)
let API_BASE = "http://localhost:5050/api";

// Default map center & zoom (override in config.local.js for your region)
let MAP_CENTER = [-105.2705, 40.0150]; // Boulder, CO
let MAP_ZOOM   = 12;

// Heatmap color ramp: low-freq → high-freq
const HEATMAP_COLORS = {
  low:    "#3b82f6",   // blue
  mid:    "#a855f7",   // purple
  high:   "#f97316",   // orange
  peak:   "#ef4444",   // red
};

// Route cluster marker color
const CLUSTER_COLOR = "#22c55e";

// Unit system — toggled at runtime via the sidebar switch
let USE_MILES = false;
