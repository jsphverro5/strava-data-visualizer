#!/usr/bin/env bash
# Start the Strava Visualizer backend + frontend and open the dashboard.
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

echo "▶ Starting frontend on http://localhost:8080 …"
cd "$SCRIPT_DIR"
python3 -m http.server 8080 --directory "$FRONTEND" --bind 0.0.0.0 &>/dev/null &
WEB_PID=$!

sleep 1

# Figure out the LAN IP so you can open the dashboard from your phone
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo "  Dashboard:   http://localhost:8080"
if [ -n "$LAN_IP" ]; then
  echo "  📱 On phone:  http://$LAN_IP:8080   (same Wi-Fi network)"
fi
echo ""

open "http://localhost:8080" 2>/dev/null || xdg-open "http://localhost:8080" 2>/dev/null || true

echo "   Press Ctrl+C to stop."
trap "kill $API_PID $WEB_PID 2>/dev/null; echo 'Stopped.'" EXIT INT TERM
wait $API_PID
