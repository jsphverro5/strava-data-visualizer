# Strava Data Visualizer

A local dashboard for visualizing your Strava activity history. Runs entirely on your own machine — no cloud, no subscriptions, no live API access required.

![Dashboard preview](https://img.shields.io/badge/local-only-brightgreen) ![Python](https://img.shields.io/badge/Python-3.9%2B-blue) ![MapBox GL JS](https://img.shields.io/badge/MapBox-GL%20JS-purple)

## Features

- **Heatmap** — all your GPS tracks overlaid on a map, color-coded by frequency of travel (precomputed server-side, cached)
- **Routes** — auto-clusters repeated routes with PR / avg time / pace / vert. Routes are auto-named from your own Strava segments where possible, and you can rename any route (hover a name → ✏️). Names survive re-imports.
- **Big Days** — automatically ranks your most significant outings (ultras, big mountain link-ups, double centuries) by scoring each day against your own history within its activity type
- **Segments** — segment efforts extracted from your FIT files: times, PRs, completions vs DNFs
- **Activities** — sortable/searchable table; click a row to highlight its track and see an **elevation profile** overlay
- **Scrambles checklist** — curated classic CO/WY/CA scramble routes (Flatirons per Gerry Roach's classics) with:
  - completion checkboxes persisted in the local database
  - **GPS ascent detection** — click the ⚡/📍 chip to see the dates you likely climbed it, straight from your own tracks
  - grade pyramid progress, per-state/area/class filters, Mountain Project links
- **Year-over-year stats**, monthly timeline, satellite layer, miles/km switch, resizable panels

## Requirements

- Python 3.9+
- A free [MapBox account](https://account.mapbox.com) (public token — free tier is ~50,000 map loads/month; the dashboard tracks your usage in the sidebar)
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

# Optional: filter to a geographic region
# python backend/ingest.py /path/to/export --region LAT_MIN LON_MIN LAT_MAX LON_MAX
# Example for Boulder, CO:
# python backend/ingest.py /path/to/export --region 39.9 -105.4 40.1 -105.1
```

This takes 15–30 minutes depending on how many FIT files you have (uses all CPU cores, prints live progress).

Then extract segment effort data from your FIT files:

```bash
python backend/extract_segments.py /path/to/your/strava_export
```

### 5. Add your MapBox token (local override file)

Your token lives in a **gitignored local file**, so you can't accidentally commit it:

```bash
cp frontend/js/config.local.example.js frontend/js/config.local.js
```

Then edit `frontend/js/config.local.js`:

```js
MAPBOX_TOKEN = "pk.your_token_here";        // from account.mapbox.com
MAP_CENTER   = [-105.2705, 40.0150];        // [longitude, latitude] of your region
MAP_ZOOM     = 12;
```

**Recommended:** in your MapBox token settings, add a URL restriction `http://localhost/*` so the token is useless anywhere else.

### 6. Launch

```bash
./start.sh
```

This starts the API server and opens the dashboard. Press `Ctrl+C` to stop.

Alternatively, serve the frontend over HTTP (avoids any `file://` browser quirks):

```bash
python3 -m http.server 8080 --directory frontend   # in a second terminal
# then open http://localhost:8080
```

---

## Re-ingesting after a new Strava export

Every 6–12 months when you get a fresh export, re-run step 4 (both commands). Things that **survive** re-import automatically:

- Custom route names (keyed by GPS coordinates)
- Custom activity / Big Day names
- Your scrambles checklist (stored in the database, not the browser)

---

## Project structure

```
strava-data-visualizer/
├── backend/
│   ├── ingest.py           # Parses Strava export → SQLite DB (parallel)
│   ├── extract_segments.py # Extracts segment efforts from FIT files
│   ├── app.py              # Flask REST API (port 5050)
│   └── models.py           # SQLite schema
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── config.js               # Defaults (committed)
│       ├── config.local.example.js # Copy to config.local.js for your token
│       ├── app.js                  # UI controller
│       ├── map.js                  # MapBox GL layers
│       ├── charts.js               # Chart.js graphs
│       ├── api.js                  # API client
│       └── utils.js                # Formatting helpers
├── data/
│   └── scrambles.json      # Editable scramble checklist
├── setup.sh                # One-time install
└── start.sh                # Launch script
```

## Customizing the scrambles checklist

`data/scrambles.json` is a plain JSON array — edit it freely, the API reads it live. Add your own routes:

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

`lat`/`lon` enable the map marker, GPS ascent detection, and track highlighting for that route. Checked-off routes are stored in the local database (`data/strava.db`), so they survive browser data clears and re-imports.

---

## Notes

- All data stays on your machine. The only external requests are MapBox tile fetches (basemap/satellite) and CDN loads for Chart.js / MapBox GL JS.
- The backend runs on `http://localhost:5050`. If that port is in use, change it in `backend/app.py`.
- GPX, FIT, and TCX files are all supported (plain and `.gz` compressed).
- The MapBox usage bar in the sidebar tracks map loads against the 50k/month free tier and blocks the map (only) if you somehow hit it.
