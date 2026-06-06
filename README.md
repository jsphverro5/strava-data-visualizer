# Strava Data Visualizer

A local dashboard for visualizing your Strava activity history. Runs entirely on your own machine — no cloud, no subscriptions, no live API access required.

![Dashboard preview](https://img.shields.io/badge/local-only-brightgreen) ![Python](https://img.shields.io/badge/Python-3.9%2B-blue) ![MapBox GL JS](https://img.shields.io/badge/MapBox-GL%20JS-purple)

## Features

- **Heatmap** — all your GPS tracks overlaid on a map, color-coded by frequency of travel
- **Routes** — auto-clusters repeated routes, shows PR, avg time, pace, elevation
- **Segments** — extracts Strava segment efforts embedded in your FIT files (times, PRs, DNFs)
- **Activities** — full sortable/searchable activity table; click any row to highlight its track on the map
- **Scrambles checklist** — curated list of classic CO/WY/CA scramble routes with completion tracking
- **Satellite toggle**, miles/km switch, resizable panels

## Requirements

- Python 3.9+
- A free [MapBox account](https://account.mapbox.com) (public token — free tier is ~50,000 map loads/month, plenty for personal use)
- Your Strava data export (instructions below)

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/jsphverro5/strava-data-visualizer.git
cd strava-data-visualizer
```

### 2. Install Python dependencies

```bash
./setup.sh
```

This creates a virtual environment at `backend/.venv` and installs all packages.

### 3. Export your Strava data

1. Go to [strava.com](https://www.strava.com) → **Settings** → **My Account**
2. Scroll to **Download or Delete Your Account** → **Get Started**
3. Click **Request Your Archive** — Strava will email you a download link (usually within a few minutes)
4. Download and **unzip** the archive

### 4. Ingest your data

```bash
source backend/.venv/bin/activate

# Basic ingest (all activities)
python backend/ingest.py /path/to/your/strava_export

# Optional: filter to a geographic region (saves time if you only care about one area)
# python backend/ingest.py /path/to/export --region LAT_MIN LON_MIN LAT_MAX LON_MAX
# Example for Boulder, CO:
# python backend/ingest.py /path/to/export --region 39.9 -105.4 40.1 -105.1
```

This takes 15–30 minutes depending on how many FIT files you have (uses all CPU cores).

Then extract segment effort data from your FIT files:

```bash
python backend/extract_segments.py /path/to/your/strava_export
```

### 5. Add your MapBox token

1. Go to [account.mapbox.com](https://account.mapbox.com) and copy your **Default public token**
2. Open `frontend/js/config.js` and replace `YOUR_MAPBOX_TOKEN_HERE` with your token
3. **Recommended:** In MapBox token settings, add a URL restriction: `http://localhost/*`

### 6. Set your map center

In `frontend/js/config.js`, update `MAP_CENTER` to your region:

```js
const MAP_CENTER = [-105.2705, 40.0150]; // [longitude, latitude]
const MAP_ZOOM   = 12;
```

### 7. Launch

```bash
./start.sh
```

This starts the API server and opens the dashboard in your browser. Press `Ctrl+C` to stop.

---

## Re-ingesting after a new Strava export

Every 6–12 months when you get a fresh export, just re-run steps 4a and 4b. The database is fully rebuilt from scratch each time.

---

## Project structure

```
strava-data-visualizer/
├── backend/
│   ├── ingest.py           # Parses Strava export → SQLite DB
│   ├── extract_segments.py # Extracts segment efforts from FIT files
│   ├── app.py              # Flask REST API (port 5050)
│   └── models.py           # SQLite schema
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── config.js       # ← Put your MapBox token + map center here
│       ├── app.js          # UI controller
│       ├── map.js          # MapBox GL layers
│       ├── charts.js       # Chart.js graphs
│       ├── api.js          # API client
│       └── utils.js        # Formatting helpers
├── data/
│   └── scrambles.json      # Editable scramble checklist
├── setup.sh                # One-time install
└── start.sh                # Launch script
```

## Customizing the scrambles checklist

`data/scrambles.json` is a plain JSON array. Add your own routes:

```json
{
  "id":        "unique-id",
  "route":     "Northeast Ridge",
  "formation": "My Peak",
  "area":      "My Range",
  "state":     "CO",
  "class":     "4",
  "elev_ft":   13500,
  "lat":        40.1234,
  "lon":       -105.4567
}
```

Checked routes are saved in your browser's `localStorage` — they don't sync between computers.

---

## Notes

- All data stays on your machine. The only external requests are MapBox tile fetches (for the basemap) and CDN loads for Chart.js.
- The backend runs on `http://localhost:5050`. If that port is in use, change it in `backend/app.py`.
- GPX, FIT, and TCX files are all supported (plain and `.gz` compressed).
