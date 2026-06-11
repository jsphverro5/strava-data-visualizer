"""
Flask API server for Strava Data Visualizer.
Run: python app.py
"""

import json
import os

from flask import Flask, jsonify, request

from flask_cors import CORS

from models import get_conn, init_db

app = Flask(__name__)
CORS(app)


def row_to_dict(row):
    return dict(row)


# ── Activities ────────────────────────────────────────────────────────────────

@app.get("/api/activities")
def list_activities():
    """Return activity list, optionally filtered by type."""
    atype = request.args.get("type")
    limit = int(request.args.get("limit", 500))
    conn = get_conn()
    q = "SELECT * FROM activities WHERE 1=1"
    params = []
    if atype:
        q += " AND type=?"
        params.append(atype)
    q += " ORDER BY date DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


@app.get("/api/activities/types")
def activity_types():
    conn = get_conn()
    rows = conn.execute(
        "SELECT DISTINCT type, COUNT(*) as cnt FROM activities GROUP BY type ORDER BY cnt DESC"
    ).fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


@app.get("/api/activities/<act_id>/track")
def get_track(act_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT lat, lon, ele FROM track_points WHERE activity_id=? ORDER BY seq",
        (act_id,)
    ).fetchall()
    conn.close()
    return jsonify([[r["lat"], r["lon"]] for r in rows])


# ── Heatmap ───────────────────────────────────────────────────────────────────

# Cache: type → GeoJSON dict. Cleared on restart (data only changes at ingest).
_heatmap_cache = {}

def _build_heatmap(atype):
    conn = get_conn()
    q = """
        SELECT a.id, a.name, a.type, a.date,
               tp.lat, tp.lon, tp.seq
        FROM activities a
        JOIN track_points tp ON tp.activity_id = a.id
        WHERE a.gpx_loaded=1
    """
    params = []
    if atype:
        q += " AND a.type=?"
        params.append(atype)
    q += " ORDER BY a.id, tp.seq"
    rows = conn.execute(q, params).fetchall()
    conn.close()

    tracks = {}
    for r in rows:
        aid = r["id"]
        if aid not in tracks:
            tracks[aid] = {"name": r["name"], "type": r["type"], "date": r["date"], "coords": []}
        tracks[aid]["coords"].append([r["lon"], r["lat"]])

    # Frequency scoring server-side: grid cells ~55m, count distinct activities
    # per cell, then tag each track with the max cell count it passes through.
    CELL = 0.0005
    freq = {}
    for aid, data in tracks.items():
        seen = set()
        for lon, lat in data["coords"]:
            key = (round(lon / CELL), round(lat / CELL))
            if key not in seen:
                seen.add(key)
                freq[key] = freq.get(key, 0) + 1

    features = []
    for aid, data in tracks.items():
        if len(data["coords"]) < 2:
            continue
        max_f = 1
        for lon, lat in data["coords"]:
            f = freq.get((round(lon / CELL), round(lat / CELL)), 1)
            if f > max_f:
                max_f = f
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": data["coords"]},
            "properties": {
                "activity_id": aid,
                "name": data["name"],
                "type": data["type"],
                "date": data["date"],
                "frequency": max_f,
            }
        })

    return {"type": "FeatureCollection", "features": features}


@app.get("/api/heatmap")
def heatmap():
    """Track lines as GeoJSON, with per-track `frequency` precomputed and cached."""
    atype = request.args.get("type") or ""
    if atype not in _heatmap_cache:
        # Cache the serialized string — re-serializing 600k+ coords per request is slow
        _heatmap_cache[atype] = json.dumps(_build_heatmap(atype or None))
    return app.response_class(_heatmap_cache[atype], mimetype="application/json")


# ── Route clusters ────────────────────────────────────────────────────────────

@app.get("/api/routes")
def list_routes():
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM route_clusters ORDER BY count DESC"
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = row_to_dict(r)
        d["activity_ids"] = json.loads(d["activity_ids"]) if d["activity_ids"] else []
        result.append(d)
    return jsonify(result)


@app.get("/api/routes/<int:route_id>/track")
def route_track(route_id):
    """Return the representative track for a route cluster."""
    conn = get_conn()
    row = conn.execute(
        "SELECT representative_activity_id FROM route_clusters WHERE id=?", (route_id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "not found"}), 404
    act_id = row["representative_activity_id"]
    pts = conn.execute(
        "SELECT lat, lon FROM track_points WHERE activity_id=? ORDER BY seq", (act_id,)
    ).fetchall()
    conn.close()
    return jsonify([[r["lat"], r["lon"]] for r in pts])


@app.get("/api/routes/<int:route_id>/activities")
def route_activities(route_id):
    """Return all activities in a route cluster with full stats."""
    conn = get_conn()
    row = conn.execute(
        "SELECT activity_ids FROM route_clusters WHERE id=?", (route_id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "not found"}), 404
    ids = json.loads(row["activity_ids"])
    placeholders = ",".join("?" * len(ids))
    acts = conn.execute(
        f"SELECT * FROM activities WHERE id IN ({placeholders}) ORDER BY date DESC", ids
    ).fetchall()
    conn.close()
    return jsonify([row_to_dict(a) for a in acts])


@app.post("/api/activities/<act_id>/name")
def rename_activity(act_id):
    """Set a custom activity name (used by Big Days). Survives re-ingest."""
    name = ((request.get_json(silent=True) or {}).get("name") or "").strip()
    conn = get_conn()
    cur = conn.execute("UPDATE activities SET custom_name=? WHERE id=?",
                       (name or None, act_id))
    conn.commit()
    found = cur.rowcount > 0
    conn.close()
    if not found:
        return jsonify({"error": "not found"}), 404
    return jsonify({"id": act_id, "name": name})


@app.post("/api/routes/<int:route_id>/name")
def rename_route(route_id):
    """Set a custom route name. Persisted by coordinates so it survives re-ingest."""
    name = ((request.get_json(silent=True) or {}).get("name") or "").strip()
    conn = get_conn()
    row = conn.execute(
        "SELECT start_lat, start_lon, end_lat, end_lon FROM route_clusters WHERE id=?",
        (route_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "not found"}), 404

    conn.execute("UPDATE route_clusters SET custom_name=? WHERE id=?",
                 (name or None, route_id))
    key = f'{row["start_lat"]:.3f},{row["start_lon"]:.3f},{row["end_lat"]:.3f},{row["end_lon"]:.3f}'
    if name:
        conn.execute("INSERT OR REPLACE INTO route_names (coord_key, name) VALUES (?,?)",
                     (key, name))
    else:
        conn.execute("DELETE FROM route_names WHERE coord_key=?", (key,))
    conn.commit()
    conn.close()
    return jsonify({"id": route_id, "name": name})


# ── Stats ─────────────────────────────────────────────────────────────────────

@app.get("/api/stats/summary")
def stats_summary():
    conn = get_conn()
    totals = conn.execute("""
        SELECT
            COUNT(*) as total_activities,
            SUM(distance_m)/1000 as total_km,
            SUM(duration_s)/3600.0 as total_hours,
            SUM(elevation_m) as total_elevation_m,
            AVG(avg_hr) as avg_hr,
            COUNT(DISTINCT date(date)) as active_days
        FROM activities
    """).fetchone()
    by_type = conn.execute("""
        SELECT type, COUNT(*) as count, SUM(distance_m)/1000 as km
        FROM activities GROUP BY type ORDER BY count DESC
    """).fetchall()
    top_routes = conn.execute("""
        SELECT id, COALESCE(custom_name, name) as name, count,
               total_distance_m, best_duration_s, avg_duration_s
        FROM route_clusters ORDER BY count DESC LIMIT 10
    """).fetchall()
    conn.close()
    return jsonify({
        "totals": row_to_dict(totals),
        "by_type": [row_to_dict(r) for r in by_type],
        "top_routes": [row_to_dict(r) for r in top_routes],
    })


@app.get("/api/stats/timeline")
def stats_timeline():
    """Monthly activity counts and km for charting."""
    atype = request.args.get("type")
    conn = get_conn()
    q = """
        SELECT strftime('%Y-%m', date) as month,
               COUNT(*) as count,
               SUM(distance_m)/1000 as km,
               SUM(elevation_m) as elevation_m
        FROM activities
        WHERE 1=1
    """
    params = []
    if atype:
        q += " AND type=?"
        params.append(atype)
    q += " GROUP BY month ORDER BY month"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


# ── Activity track ────────────────────────────────────────────────────────────

@app.get("/api/activities/<act_id>/track")
def get_activity_track(act_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT lat, lon FROM track_points WHERE activity_id=? ORDER BY seq",
        (act_id,)
    ).fetchall()
    conn.close()
    return jsonify([[r["lat"], r["lon"]] for r in rows])


# ── Segments ──────────────────────────────────────────────────────────────────

@app.get("/api/segments")
def list_segments():
    """Segments filtered/sorted. Shows all with any attempts; completions-only have PR/avg."""
    q            = request.args.get("q", "").strip()
    starred_only = request.args.get("starred") == "1"
    conn         = get_conn()

    sql = """
        SELECT s.*,
               ss.segment_id IS NOT NULL as is_starred
        FROM segments s
        LEFT JOIN starred_segments ss ON ss.segment_id = s.uuid
        WHERE s.attempt_count > 0
    """
    params = []
    if q:
        sql += " AND s.name LIKE ?"
        params.append(f"%{q}%")
    if starred_only:
        sql += " AND ss.segment_id IS NOT NULL"
    sql += " ORDER BY s.attempt_count DESC"

    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


@app.get("/api/segments/<uuid>/efforts")
def segment_efforts(uuid):
    """All efforts on a given segment with activity metadata. Completions first."""
    conn = get_conn()
    rows = conn.execute("""
        SELECT se.*, a.name as activity_name, a.date, a.type,
               CASE WHEN se.status='end' AND se.elapsed_time_s > 10 THEN 1 ELSE 0 END as completed
        FROM segment_efforts se
        JOIN activities a ON a.id = se.activity_id
        WHERE se.segment_uuid = ?
        ORDER BY completed DESC, se.elapsed_time_s ASC
    """, (uuid,)).fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


@app.get("/api/segments/<uuid>/track")
def segment_track(uuid):
    """
    Best-guess track for a segment: pull points from the activity that has
    the PR effort, cropping to the segment's approximate bounding box.
    """
    conn = get_conn()

    # Get segment bounds and PR effort activity
    seg = conn.execute("SELECT * FROM segments WHERE uuid=?", (uuid,)).fetchone()
    if not seg:
        conn.close()
        return jsonify([])

    # PR effort = shortest elapsed time
    effort = conn.execute("""
        SELECT activity_id FROM segment_efforts
        WHERE segment_uuid=? AND elapsed_time_s IS NOT NULL
        ORDER BY elapsed_time_s ASC LIMIT 1
    """, (uuid,)).fetchone()

    if not effort:
        conn.close()
        return jsonify([])

    act_id = effort["activity_id"]
    # Pull track points near the segment start/end box (with buffer)
    buf = 0.005
    rows = conn.execute("""
        SELECT lat, lon FROM track_points
        WHERE activity_id=?
          AND lat BETWEEN ? AND ?
          AND lon BETWEEN ? AND ?
        ORDER BY seq
    """, (act_id,
          min(seg["start_lat"] or 0, seg["end_lat"] or 0) - buf,
          max(seg["start_lat"] or 0, seg["end_lat"] or 0) + buf,
          min(seg["start_lon"] or 0, seg["end_lon"] or 0) - buf,
          max(seg["start_lon"] or 0, seg["end_lon"] or 0) + buf,
         )).fetchall()
    conn.close()
    return jsonify([[r["lat"], r["lon"]] for r in rows])


# ── Scramble checklist ────────────────────────────────────────────────────────

SCRAMBLES_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "scrambles.json")

@app.get("/api/scrambles")
def get_scrambles():
    with open(SCRAMBLES_PATH, "r") as f:
        scrambles = json.load(f)

    # Attach segment effort stats for any linked segment
    conn = get_conn()
    for s in scrambles:
        uuid = s.get("segment_uuid")
        if uuid:
            row = conn.execute(
                "SELECT attempt_count, effort_count, pr_time_s, avg_time_s FROM segments WHERE uuid=?",
                (uuid,)
            ).fetchone()
            if row:
                s["seg_attempts"]  = row["attempt_count"]
                s["seg_finishes"]  = row["effort_count"]
                s["seg_pr_s"]      = row["pr_time_s"]
                s["seg_avg_s"]     = row["avg_time_s"]
    conn.close()
    return jsonify(scrambles)


@app.get("/api/scrambles/<scr_id>/track")
def scramble_track(scr_id):
    """Return GPS track for a scramble.
    Strategy: linked segment → use that activity's track.
    No segment → find the activity with track points nearest to the scramble coords.
    """
    with open(SCRAMBLES_PATH, "r") as f:
        scrambles = json.load(f)
    scr = next((s for s in scrambles if s["id"] == scr_id), None)
    if not scr:
        return jsonify([])

    conn = get_conn()

    # Strategy 1: linked segment → activity with PR effort
    if scr.get("segment_uuid"):
        effort = conn.execute("""
            SELECT activity_id FROM segment_efforts
            WHERE segment_uuid = ? AND elapsed_time_s IS NOT NULL
            ORDER BY elapsed_time_s ASC LIMIT 1
        """, (scr["segment_uuid"],)).fetchone()
        if effort:
            pts = conn.execute(
                "SELECT lat, lon FROM track_points WHERE activity_id=? ORDER BY seq",
                (effort["activity_id"],)
            ).fetchall()
            conn.close()
            return jsonify([[r["lat"], r["lon"]] for r in pts])

    # Strategy 2: best-matching activity = most track points close to the route.
    # A tight radius (~200m) plus a point-count score avoids picking a trail
    # that merely passes through the area.
    lat, lon = scr.get("lat"), scr.get("lon")
    if not lat or not lon:
        conn.close()
        return jsonify([])

    buf = 0.002  # ~200m
    best = conn.execute("""
        SELECT activity_id, COUNT(*) as pts
        FROM track_points
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
        GROUP BY activity_id
        ORDER BY pts DESC
        LIMIT 1
    """, (lat - buf, lat + buf, lon - buf, lon + buf)).fetchone()

    if not best:
        conn.close()
        return jsonify([])

    pts = conn.execute(
        "SELECT lat, lon FROM track_points WHERE activity_id=? ORDER BY seq",
        (best["activity_id"],)
    ).fetchall()
    conn.close()
    return jsonify([[r["lat"], r["lon"]] for r in pts])


# Ascent detection: an activity "visits" a scramble if it has >=3 downsampled
# track points within ~200m of the route coords (passing trails rarely linger).
_VISIT_BUF   = 0.002
_VISIT_MIN_PTS = 3

def _scramble_visits(conn, lat, lon):
    return conn.execute("""
        SELECT tp.activity_id, COUNT(*) as pts, a.name, a.date, a.type,
               a.duration_s, a.distance_m, a.elevation_m
        FROM track_points tp
        JOIN activities a ON a.id = tp.activity_id
        WHERE tp.lat BETWEEN ? AND ? AND tp.lon BETWEEN ? AND ?
        GROUP BY tp.activity_id
        HAVING pts >= ?
        ORDER BY a.date DESC
    """, (lat - _VISIT_BUF, lat + _VISIT_BUF,
          lon - _VISIT_BUF, lon + _VISIT_BUF, _VISIT_MIN_PTS)).fetchall()


@app.get("/api/scrambles/nearby")
def scrambles_nearby():
    """Per-scramble count of likely ascents (activities lingering near the route)."""
    with open(SCRAMBLES_PATH, "r") as f:
        scrambles = json.load(f)
    conn = get_conn()
    result = []
    for scr in scrambles:
        lat, lon = scr.get("lat"), scr.get("lon")
        if not lat or not lon:
            continue
        visits = _scramble_visits(conn, lat, lon)
        if visits:
            result.append({"id": scr["id"], "nearby_count": len(visits)})
    conn.close()
    return jsonify(result)


@app.get("/api/scrambles/<scr_id>/visits")
def scramble_visits(scr_id):
    """Likely ascent dates for one scramble, newest first."""
    with open(SCRAMBLES_PATH, "r") as f:
        scrambles = json.load(f)
    scr = next((s for s in scrambles if s["id"] == scr_id), None)
    if not scr or not scr.get("lat"):
        return jsonify([])
    conn = get_conn()
    visits = _scramble_visits(conn, scr["lat"], scr["lon"])
    conn.close()
    return jsonify([row_to_dict(v) for v in visits])


# ── Scramble checklist (persisted server-side) ────────────────────────────────

@app.get("/api/checklist")
def get_checklist():
    conn = get_conn()
    rows = conn.execute(
        "SELECT scramble_id FROM scramble_checklist WHERE done=1").fetchall()
    conn.close()
    return jsonify([r["scramble_id"] for r in rows])


@app.post("/api/checklist/<scr_id>")
def set_checklist(scr_id):
    done = bool((request.get_json(silent=True) or {}).get("done", True))
    conn = get_conn()
    if done:
        conn.execute("""
            INSERT OR REPLACE INTO scramble_checklist (scramble_id, done, done_date)
            VALUES (?, 1, datetime('now'))
        """, (scr_id,))
    else:
        conn.execute("DELETE FROM scramble_checklist WHERE scramble_id=?", (scr_id,))
    conn.commit()
    conn.close()
    return jsonify({"id": scr_id, "done": done})


# ── Elevation profile ─────────────────────────────────────────────────────────

@app.get("/api/activities/<act_id>/profile")
def activity_profile(act_id):
    """Elevation profile: list of [cumulative_distance_m, elevation_m]."""
    import math
    conn = get_conn()
    rows = conn.execute(
        "SELECT lat, lon, ele FROM track_points WHERE activity_id=? ORDER BY seq",
        (act_id,)
    ).fetchall()
    conn.close()

    profile = []
    dist = 0.0
    prev = None
    for r in rows:
        if r["ele"] is None:
            continue
        if prev is not None:
            p = math.pi / 180
            a = (math.sin((r["lat"] - prev[0]) * p / 2) ** 2
                 + math.cos(prev[0] * p) * math.cos(r["lat"] * p)
                 * math.sin((r["lon"] - prev[1]) * p / 2) ** 2)
            dist += 2 * 6371000 * math.asin(math.sqrt(a))
        prev = (r["lat"], r["lon"])
        profile.append([round(dist), round(r["ele"], 1)])
    return jsonify(profile)


# ── Big days (significant outings) ────────────────────────────────────────────

@app.get("/api/bigdays")
def big_days():
    """
    Rank calendar days by an 'epic score'. Same-day activities are merged
    (multi-recording mountain days count once). Each day is scored against
    the athlete's own history *within its dominant activity type*, so a long
    run ranks alongside a much longer ride.
    score = 40% duration percentile + 30% distance + 30% vert, 0–100.
    """
    limit = int(request.args.get("limit", 75))
    conn = get_conn()
    rows = conn.execute("""
        SELECT date(date) as day,
               COUNT(*) as n_activities,
               SUM(distance_m)  as distance_m,
               SUM(duration_s)  as duration_s,
               SUM(elevation_m) as elevation_m,
               MAX(avg_hr)      as max_avg_hr
        FROM activities
        WHERE date != ''
        GROUP BY day
        HAVING duration_s >= 7200      -- at least 2h out; cuts noise
    """).fetchall()

    # Headline activity per day = the longest one (its name + type label the day)
    headliners = {}
    for h in conn.execute("""
        SELECT date(date) as day, id, COALESCE(custom_name, name) as name,
               type, duration_s
        FROM activities WHERE date != ''
        ORDER BY duration_s ASC
    """).fetchall():
        headliners[h["day"]] = h   # last (longest) wins
    conn.close()

    days = []
    for r in rows:
        h = headliners.get(r["day"])
        if not h:
            continue
        days.append({
            "day": r["day"],
            "name": h["name"],
            "type": h["type"],
            "activity_id": h["id"],
            "n_activities": r["n_activities"],
            "distance_m": r["distance_m"] or 0,
            "duration_s": r["duration_s"] or 0,
            "elevation_m": r["elevation_m"] or 0,
        })

    # Percentile rank within dominant type
    def pct_rank(sorted_vals, v):
        if not sorted_vals:
            return 0
        import bisect
        return 100.0 * bisect.bisect_left(sorted_vals, v) / len(sorted_vals)

    by_type = {}
    for d in days:
        by_type.setdefault(d["type"], {"dur": [], "dist": [], "ele": []})
        by_type[d["type"]]["dur"].append(d["duration_s"])
        by_type[d["type"]]["dist"].append(d["distance_m"])
        by_type[d["type"]]["ele"].append(d["elevation_m"])
    for t in by_type.values():
        for k in t:
            t[k].sort()

    for d in days:
        t = by_type[d["type"]]
        d["score"] = round(
            0.40 * pct_rank(t["dur"],  d["duration_s"]) +
            0.30 * pct_rank(t["dist"], d["distance_m"]) +
            0.30 * pct_rank(t["ele"],  d["elevation_m"]), 1)

    days.sort(key=lambda d: -d["score"])
    return jsonify(days[:limit])


# ── Year-over-year stats ──────────────────────────────────────────────────────

@app.get("/api/stats/years")
def stats_years():
    atype = request.args.get("type")
    conn = get_conn()
    q = """
        SELECT strftime('%Y', date) as year,
               COUNT(*) as count,
               SUM(distance_m)/1000.0 as km,
               SUM(elevation_m) as elevation_m,
               SUM(duration_s)/3600.0 as hours
        FROM activities
        WHERE date != ''
    """
    params = []
    if atype:
        q += " AND type=?"
        params.append(atype)
    q += " GROUP BY year ORDER BY year DESC"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


def _prewarm_heatmap():
    """Build the all-types heatmap cache in the background so the first page
    load doesn't wait ~10s for it."""
    try:
        _heatmap_cache[""] = json.dumps(_build_heatmap(None))
        print("Heatmap cache pre-warmed.")
    except Exception as e:
        print(f"Heatmap pre-warm failed (will build on first request): {e}")


if __name__ == "__main__":
    import threading
    init_db()
    threading.Thread(target=_prewarm_heatmap, daemon=True).start()
    print("Starting Strava Visualizer API on http://localhost:5050")
    # host=0.0.0.0 → reachable from other devices on your LAN (e.g. your phone)
    app.run(host="0.0.0.0", port=5050, debug=False)
