"""
Strava bulk-export ingestion script.

Usage:
    python ingest.py /path/to/strava_export_directory [--region lat_min lon_min lat_max lon_max]
    python ingest.py /path/to/strava_export_directory --workers 8

The export directory should contain:
  - activities.csv
  - activities/ folder with GPX / FIT / TCX files (plain or .gz)
"""

import argparse
import csv
import gzip
import io
import json
import math
import multiprocessing as mp
import os
import sys
import time
import xml.etree.ElementTree as ET

import gpxpy
import numpy as np
from fitparse import FitFile

from models import get_conn, init_db

# ── helpers ───────────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p)
         * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))


def parse_date_iso(s):
    """Normalize Strava CSV dates ('Sep 9, 2023, 7:25:02 PM' or ISO) to ISO 8601."""
    if not s:
        return ""
    s = s.strip()
    from datetime import datetime
    for fmt in ("%b %d, %Y, %I:%M:%S %p", "%B %d, %Y, %I:%M:%S %p"):
        try:
            return datetime.strptime(s, fmt).isoformat()
        except ValueError:
            pass
    return s  # already ISO or unknown format — store as-is


def parse_duration(s):
    if not s:
        return None
    if ":" in str(s):
        parts = list(map(int, str(s).split(":")))
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
        return int(parts[0])
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return None


def safe_float(v):
    try:
        return float(v) if v not in (None, "", "0") else None
    except (ValueError, TypeError):
        return None


def safe_int(v):
    try:
        return int(float(v)) if v not in (None, "") else None
    except (ValueError, TypeError):
        return None


# ── File loaders (run in worker processes) ────────────────────────────────────

def _open_file(filepath):
    if filepath.endswith(".gz"):
        return gzip.open(filepath, "rb")
    return open(filepath, "rb")


def load_gpx_points(filepath):
    try:
        with _open_file(filepath) as raw:
            gpx = gpxpy.parse(io.TextIOWrapper(raw, encoding="utf-8", errors="ignore"))
        points = []
        for track in gpx.tracks:
            for seg in track.segments:
                for pt in seg.points:
                    points.append((pt.latitude, pt.longitude, pt.elevation,
                                   pt.time.isoformat() if pt.time else None))
        return points
    except Exception:
        return []


def load_fit_points(filepath):
    try:
        with _open_file(filepath) as raw:
            data = raw.read()          # read into memory first (safer with gz)
        fitfile = FitFile(io.BytesIO(data))
        points = []
        for record in fitfile.get_messages("record"):
            fields = {f.name: f.value for f in record}
            lat = fields.get("position_lat")
            lon = fields.get("position_long")
            if lat is None or lon is None:
                continue
            lat = lat * (180.0 / 2**31)
            lon = lon * (180.0 / 2**31)
            ele = fields.get("altitude")
            ts  = fields.get("timestamp")
            points.append((lat, lon, ele, ts.isoformat() if ts else None))
        return points
    except Exception:
        return []


def load_tcx_points(filepath):
    NS = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
    try:
        with _open_file(filepath) as raw:
            tree = ET.parse(raw)
        points = []
        for tp in tree.iter(f"{{{NS}}}Trackpoint"):
            pos = tp.find(f"{{{NS}}}Position")
            if pos is None:
                continue
            lat_el = pos.find(f"{{{NS}}}LatitudeDegrees")
            lon_el = pos.find(f"{{{NS}}}LongitudeDegrees")
            if lat_el is None or lon_el is None:
                continue
            try:
                lat, lon = float(lat_el.text), float(lon_el.text)
            except (ValueError, TypeError):
                continue
            ele_el  = tp.find(f"{{{NS}}}AltitudeMeters")
            time_el = tp.find(f"{{{NS}}}Time")
            points.append((lat, lon,
                           float(ele_el.text) if ele_el is not None else None,
                           time_el.text if time_el is not None else None))
        return points
    except Exception:
        return []


def _parse_worker(task):
    """Top-level function so it's picklable for multiprocessing."""
    act_id, filepath = task
    name = filepath.lower()
    if ".gpx" in name:
        pts = load_gpx_points(filepath)
    elif ".fit" in name:
        pts = load_fit_points(filepath)
    elif ".tcx" in name:
        pts = load_tcx_points(filepath)
    else:
        pts = []

    # Downsample to ≤500 pts right here in the worker (saves IPC bandwidth)
    if len(pts) > 500:
        step = len(pts) // 500
        pts = pts[::step]

    return act_id, pts


def resolve_activity_file(export_dir, filename):
    if not filename:
        return None
    for path in (
        os.path.join(export_dir, filename),
        os.path.join(export_dir, os.path.basename(filename)),
    ):
        if os.path.exists(path):
            return path
    return None


# ── Route clustering ──────────────────────────────────────────────────────────

CLUSTER_RADIUS_M = 150
MIN_DISTANCE_M   = 500


def cluster_routes(conn):
    cur = conn.cursor()
    rows = cur.execute("""
        SELECT a.id, a.name, a.date, a.type, a.distance_m, a.duration_s,
               a.elevation_m, a.avg_speed_ms,
               (SELECT lat FROM track_points WHERE activity_id=a.id ORDER BY seq LIMIT 1) AS slat,
               (SELECT lon FROM track_points WHERE activity_id=a.id ORDER BY seq LIMIT 1) AS slon,
               (SELECT lat FROM track_points WHERE activity_id=a.id ORDER BY seq DESC LIMIT 1) AS elat,
               (SELECT lon FROM track_points WHERE activity_id=a.id ORDER BY seq DESC LIMIT 1) AS elon
        FROM activities a
        WHERE a.gpx_loaded=1 AND a.distance_m >= ?
    """, (MIN_DISTANCE_M,)).fetchall()

    if not rows:
        print("  No GPS-loaded activities to cluster.")
        return

    acts = [dict(r) for r in rows]
    acts = [a for a in acts if a["slat"] and a["slon"] and a["elat"] and a["elon"]]
    coords = np.array([[a["slat"], a["slon"], a["elat"], a["elon"]] for a in acts])

    visited = [False] * len(acts)
    clusters = []

    for i in range(len(acts)):
        if visited[i]:
            continue
        visited[i] = True
        group = [i]
        for j in range(i + 1, len(acts)):
            if visited[j]:
                continue
            if (haversine(coords[i,0], coords[i,1], coords[j,0], coords[j,1]) <= CLUSTER_RADIUS_M and
                haversine(coords[i,2], coords[i,3], coords[j,2], coords[j,3]) <= CLUSTER_RADIUS_M):
                visited[j] = True
                group.append(j)
        clusters.append(group)

    cur.execute("DELETE FROM route_clusters")
    for group in clusters:
        members  = [acts[i] for i in group]
        ids      = [m["id"] for m in members]
        durs     = [m["duration_s"] for m in members if m["duration_s"]]
        speeds   = [m["avg_speed_ms"] for m in members if m["avg_speed_ms"]]
        eles     = [m["elevation_m"] for m in members if m["elevation_m"]]
        names    = [m["name"] for m in members]
        rep      = members[0]

        cur.execute("""
            INSERT INTO route_clusters
              (name, activity_ids, count, total_distance_m, best_duration_s,
               avg_duration_s, best_speed_ms, avg_elevation_m,
               start_lat, start_lon, end_lat, end_lon, representative_activity_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            max(set(names), key=names.count),
            json.dumps(ids), len(members), rep["distance_m"],
            min(durs) if durs else None,
            int(sum(durs)/len(durs)) if durs else None,
            max(speeds) if speeds else None,
            sum(eles)/len(eles) if eles else None,
            rep["slat"], rep["slon"], rep["elat"], rep["elon"], rep["id"],
        ))

    # Restore saved custom names (keyed by rounded start/end coords) so user
    # renames survive re-ingest/re-clustering.
    try:
        saved = {r["coord_key"]: r["name"]
                 for r in cur.execute("SELECT coord_key, name FROM route_names").fetchall()}
        if saved:
            restored = 0
            for row in cur.execute(
                "SELECT id, start_lat, start_lon, end_lat, end_lon FROM route_clusters"
            ).fetchall():
                key = (f'{row["start_lat"]:.3f},{row["start_lon"]:.3f},'
                       f'{row["end_lat"]:.3f},{row["end_lon"]:.3f}')
                if key in saved:
                    cur.execute("UPDATE route_clusters SET custom_name=? WHERE id=?",
                                (saved[key], row["id"]))
                    restored += 1
            print(f"  Restored {restored} custom route names.")
    except Exception as e:
        print(f"  [warn] could not restore route names: {e}")

    conn.commit()
    print(f"  Clustered {len(acts)} activities into {len(clusters)} route groups.")


# ── Main ingest ───────────────────────────────────────────────────────────────

def ingest(export_dir, region=None, workers=None):
    csv_path = os.path.join(export_dir, "activities.csv")
    if not os.path.exists(csv_path):
        sys.exit(f"ERROR: activities.csv not found in {export_dir}")

    init_db()
    conn = get_conn()
    cur  = conn.cursor()

    print(f"Reading {csv_path} …", flush=True)
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    print(f"Found {len(rows)} activities in CSV.", flush=True)

    # ── Phase 1: insert activity metadata rows ────────────────────────────────
    act_meta = {}   # act_id → filename
    for row in rows:
        act_id = str(row.get("Activity ID", "")).strip()
        if not act_id:
            continue
        name     = row.get("Activity Name") or row.get("Name") or ""
        date_str = parse_date_iso(row.get("Activity Date") or row.get("Date") or "")
        atype    = row.get("Activity Type") or row.get("Type") or ""
        dist     = safe_float(row.get("Distance") or "0")
        # Strava CSV exports distance already in meters — no conversion needed
        dur      = parse_duration(row.get("Elapsed Time") or row.get("Moving Time") or "")
        ele      = safe_float(row.get("Elevation Gain") or "0")
        avg_spd  = safe_float(row.get("Average Speed") or "0")
        max_spd  = safe_float(row.get("Max Speed") or "0")
        avg_hr   = safe_float(row.get("Average Heart Rate") or "0")
        max_hr   = safe_float(row.get("Max Heart Rate") or "0")
        avg_w    = safe_float(row.get("Average Watts") or "0")
        kudos    = safe_int(row.get("Kudos") or "0")
        commute  = 1 if str(row.get("Commute", "")).lower() in ("true","1","yes") else 0
        private  = 1 if str(row.get("Private", "")).lower() in ("true","1","yes") else 0
        filename = row.get("Filename") or ""

        cur.execute("""
            INSERT OR REPLACE INTO activities
              (id,name,date,type,distance_m,duration_s,elevation_m,
               avg_speed_ms,max_speed_ms,avg_hr,max_hr,avg_watts,
               kudos,commute,private,filename,gpx_loaded)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
        """, (act_id, name, date_str, atype, dist, dur, ele,
              avg_spd, max_spd, avg_hr, max_hr, avg_w,
              kudos, commute, private, filename))
        act_meta[act_id] = filename

    conn.commit()
    print(f"Inserted {len(act_meta)} activity records.", flush=True)

    # ── Phase 2: build list of GPS files to parse ─────────────────────────────
    tasks = []
    for act_id, filename in act_meta.items():
        ext = filename.lower()
        if not any(fmt in ext for fmt in (".gpx", ".fit", ".tcx")):
            continue
        fpath = resolve_activity_file(export_dir, filename)
        if fpath:
            tasks.append((act_id, fpath))

    print(f"Parsing {len(tasks)} GPS files across {workers or mp.cpu_count()} workers …", flush=True)

    # ── Phase 3: parallel parse ───────────────────────────────────────────────
    n_workers = workers or mp.cpu_count()
    BATCH     = 100
    gpx_loaded = 0
    skipped    = 0
    t0 = time.time()

    with mp.Pool(processes=n_workers) as pool:
        for batch_start in range(0, len(tasks), BATCH):
            batch = tasks[batch_start:batch_start + BATCH]
            results = pool.map(_parse_worker, batch)

            for act_id, pts in results:
                if not pts:
                    continue

                # Region filter on first point
                if region:
                    lat0, lon0 = pts[0][0], pts[0][1]
                    lat_min, lon_min, lat_max, lon_max = region
                    if not (lat_min <= lat0 <= lat_max and lon_min <= lon0 <= lon_max):
                        cur.execute("DELETE FROM activities WHERE id=?", (act_id,))
                        skipped += 1
                        continue

                cur.execute("DELETE FROM track_points WHERE activity_id=?", (act_id,))
                cur.executemany(
                    "INSERT INTO track_points (activity_id,seq,lat,lon,ele,time) VALUES (?,?,?,?,?,?)",
                    [(act_id, i, p[0], p[1], p[2], p[3]) for i, p in enumerate(pts)]
                )
                cur.execute("UPDATE activities SET gpx_loaded=1 WHERE id=?", (act_id,))
                gpx_loaded += 1

            conn.commit()
            done = min(batch_start + BATCH, len(tasks))
            elapsed = time.time() - t0
            rate = done / elapsed if elapsed > 0 else 0
            eta  = (len(tasks) - done) / rate if rate > 0 else 0
            print(f"  {done}/{len(tasks)} files  |  {gpx_loaded} with GPS  |  "
                  f"{elapsed:.0f}s elapsed  |  ETA {eta:.0f}s", flush=True)

    print(f"\nDone: {gpx_loaded} GPS tracks loaded, {skipped} region-filtered.", flush=True)
    print("Clustering routes …", flush=True)
    cluster_routes(conn)
    conn.close()
    print("Ingest complete.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingest Strava export into local DB")
    parser.add_argument("export_dir", help="Path to unzipped Strava export folder")
    parser.add_argument("--region", nargs=4, type=float,
                        metavar=("LAT_MIN","LON_MIN","LAT_MAX","LON_MAX"),
                        help="Only load activities starting within this bounding box")
    parser.add_argument("--workers", type=int, default=None,
                        help="Number of parallel workers (default: CPU count)")
    args = parser.parse_args()
    ingest(args.export_dir,
           tuple(args.region) if args.region else None,
           args.workers)
