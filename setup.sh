#!/usr/bin/env bash
# One-time setup: create Python venv and install dependencies.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$SCRIPT_DIR/backend"

echo "▶ Creating Python virtual environment …"
python3 -m venv "$BACKEND/.venv"
source "$BACKEND/.venv/bin/activate"

echo "▶ Installing Python dependencies …"
pip install -q --upgrade pip
pip install -q -r "$BACKEND/requirements.txt"

echo ""
echo "✅ Setup complete."
echo ""
echo "Next steps:"
echo "  1. Export your Strava data at https://www.strava.com/athlete/delete_your_account"
echo "     (Settings → My Account → Download or Delete Your Account → Get Started → Request Your Archive)"
echo "  2. Unzip the export."
echo "  3. Run the ingestion:"
echo "     source backend/.venv/bin/activate"
echo "     python backend/ingest.py /path/to/strava_export"
echo "     # Optional region filter:"
echo "     python backend/ingest.py /path/to/strava_export --region 37.6 -122.6 37.9 -122.2"
echo "  4. Copy frontend/js/config.local.example.js to frontend/js/config.local.js"
echo "     and add your MapBox token + map center there (it's gitignored)"
echo "  5. ./start.sh"
