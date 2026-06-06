#!/usr/bin/env bash
# Start the Strava Visualizer backend and open the frontend.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$SCRIPT_DIR/backend"
FRONTEND="$SCRIPT_DIR/frontend"

# Activate venv if present
if [ -f "$BACKEND/.venv/bin/activate" ]; then
  source "$BACKEND/.venv/bin/activate"
fi

# Ensure DB exists
if [ ! -f "$SCRIPT_DIR/data/strava.db" ]; then
  echo "⚠️  No database found at data/strava.db"
  echo "   Run: python backend/ingest.py /path/to/your/strava_export"
  echo "   Then re-run this script."
  exit 1
fi

echo "▶ Starting API server on http://localhost:5050 …"
cd "$BACKEND"
python app.py &
API_PID=$!

sleep 1

echo "▶ Opening dashboard …"
open "$FRONTEND/index.html" 2>/dev/null || xdg-open "$FRONTEND/index.html" 2>/dev/null || echo "Open $FRONTEND/index.html in your browser."

echo "   Press Ctrl+C to stop."
trap "kill $API_PID 2>/dev/null; echo 'Stopped.'" EXIT INT TERM
wait $API_PID
