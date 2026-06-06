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

@app.get("/api/heatmap")
def heatmap():
    """
    Return all track lines as GeoJSON FeatureCollection.
    Each feature has `activity_id`, `count` (cluster size), and `name`.
    Filtered by activity type if ?type= is provided.
    """
    atype = request.args.get("type")
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

    # Group by activity
    tracks = {}
    for r in rows:
        aid = r["id"]
        if aid not in tracks:
            tracks[aid] = {"name": r["name"], "type": r["type"], "date": r["date"], "coords": []}
        tracks[aid]["coords"].append([r["lon"], r["lat"]])

    features = []
    for aid, data in tracks.items():
        if len(data["coords"]) < 2:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": data["coords"]},
            "properties": {
                "activity_id": aid,
                "name": data["name"],
                "type": data["type"],
                "date": data["date"],
            }
        })

    return jsonify({"type": "FeatureCollection", "features": features})


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
            COUNT(DISTINCT substr(date,1,instr(date,',')+instr(substr(date,instr(date,',')+1),',')-1)) as active_days
        FROM activities
    """).fetchone()
    by_type = conn.execute("""
        SELECT type, COUNT(*) as count, SUM(distance_m)/1000 as km
        FROM activities GROUP BY type ORDER BY count DESC
    """).fetchall()
    top_routes = conn.execute("""
        SELECT id, name, count, total_distance_m, best_duration_s, avg_duration_s
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
    """Return GPS track for a scramble via its linked segment."""
    with open(SCRAMBLES_PATH, "r") as f:
        scrambles = json.load(f)
    scr = next((s for s in scrambles if s["id"] == scr_id), None)
    if not scr or not scr.get("segment_uuid"):
        return jsonify([])
    conn = get_conn()
    pts = conn.execute("""
        SELECT tp.lat, tp.lon FROM track_points tp
        JOIN segment_efforts se ON se.activity_id = tp.activity_id
        JOIN segments s ON s.uuid = se.segment_uuid
        WHERE s.uuid = ?
          AND se.elapsed_time_s = s.pr_time_s
        ORDER BY tp.seq
    """, (scr["segment_uuid"],)).fetchall()
    conn.close()
    return jsonify([[r["lat"], r["lon"]] for r in pts])


if __name__ == "__main__":
    init_db()
    print("Starting Strava Visualizer API on http://localhost:5050")
    app.run(port=5050, debug=True)
