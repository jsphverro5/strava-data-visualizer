"""
Extract segment effort data from FIT files and populate the segments tables.
Run after ingest.py has already populated the activities table.

Usage:
    python extract_segments.py /path/to/strava_export
"""

import argparse
import csv
import gzip
import io
import multiprocessing as mp
import os
import time

from fitparse import FitFile

from models import get_conn, init_db

SEMI_TO_DEG = 180.0 / 2**31


def _extract_worker(task):
    """Parse one FIT(.gz) file and return its segment_lap records."""
    act_id, filepath = task
    efforts = []
    try:
        if filepath.endswith(".gz"):
            with gzip.open(filepath, "rb") as f:
                data = f.read()
        else:
            with open(filepath, "rb") as f:
                data = f.read()

        fitfile = FitFile(io.BytesIO(data))
        for msg in fitfile.get_messages("segment_lap"):
            fields = {fld.name: fld.value for fld in msg if fld.value is not None}

            uuid = str(fields.get("uuid", "")).strip()
            name = fields.get("name", "")
            if not uuid or not name:
                continue

            slat = fields.get("start_position_lat")
            slon = fields.get("start_position_long")
            elat = fields.get("end_position_lat")
            elon = fields.get("end_position_long")

            efforts.append({
                "act_id":      act_id,
                "uuid":        uuid,
                "name":        name,
                "sport":       str(fields.get("sport", "")),
                "start_lat":   slat * SEMI_TO_DEG if slat else None,
                "start_lon":   slon * SEMI_TO_DEG if slon else None,
                "end_lat":     elat * SEMI_TO_DEG if elat else None,
                "end_lon":     elon * SEMI_TO_DEG if elon else None,
                "start_time":  fields.get("start_time").isoformat() if fields.get("start_time") else None,
                "elapsed_s":   fields.get("total_elapsed_time"),
                "distance_m":  fields.get("total_distance"),
                "avg_speed":   fields.get("avg_speed"),
                "avg_hr":      fields.get("avg_heart_rate"),
                "max_hr":      fields.get("max_heart_rate"),
                "avg_cadence": fields.get("avg_cadence"),
                "status":      str(fields.get("status", "")),
            })
    except Exception:
        pass
    return efforts


def extract(export_dir, workers=None):
    init_db()
    conn = get_conn()
    cur  = conn.cursor()

    # Load starred segment IDs
    starred_path = os.path.join(export_dir, "starred_segments.csv")
    if os.path.exists(starred_path):
        with open(starred_path, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                seg_id = str(row.get("Segment ID", "")).strip()
                date   = row.get("Date", "")
                if seg_id:
                    cur.execute(
                        "INSERT OR IGNORE INTO starred_segments (segment_id, starred_date) VALUES (?,?)",
                        (seg_id, date)
                    )
        conn.commit()
        n_starred = cur.execute("SELECT COUNT(*) FROM starred_segments").fetchone()[0]
        print(f"Loaded {n_starred} starred segments.", flush=True)

    # Find all FIT activity files that have a matching activity record
    rows = cur.execute(
        "SELECT id, filename FROM activities WHERE filename != ''"
    ).fetchall()

    tasks = []
    for row in rows:
        fn = row["filename"]
        if ".fit" not in fn.lower():
            continue
        for path in (
            os.path.join(export_dir, fn),
            os.path.join(export_dir, os.path.basename(fn)),
        ):
            if os.path.exists(path):
                tasks.append((row["id"], path))
                break

    n_workers = workers or mp.cpu_count()
    print(f"Scanning {len(tasks)} FIT files for segment efforts across {n_workers} workers …", flush=True)

    # Clear old segment data so re-runs are idempotent
    cur.execute("DELETE FROM segment_efforts")
    cur.execute("DELETE FROM segments")
    conn.commit()

    BATCH       = 100
    total_efforts = 0
    t0          = time.time()
    seg_meta    = {}   # uuid → metadata dict
    seg_times   = {}   # uuid → [elapsed_s, ...]
    all_efforts = []   # flat list of all effort dicts

    with mp.Pool(processes=n_workers) as pool:
        for batch_start in range(0, len(tasks), BATCH):
            batch   = tasks[batch_start:batch_start + BATCH]
            results = pool.map(_extract_worker, batch)

            for efforts in results:
                for e in efforts:
                    uuid = e["uuid"]
                    if uuid not in seg_meta:
                        seg_meta[uuid] = {k: e[k] for k in
                            ("name", "sport", "start_lat", "start_lon", "end_lat", "end_lon")}
                        seg_times[uuid] = []
                    if e["elapsed_s"]:
                        seg_times[uuid].append(e["elapsed_s"])
                    all_efforts.append(e)
                    total_efforts += 1

            done    = min(batch_start + BATCH, len(tasks))
            elapsed = time.time() - t0
            rate    = done / elapsed if elapsed > 0 else 1
            eta     = (len(tasks) - done) / rate
            print(f"  {done}/{len(tasks)} files  |  {total_efforts} efforts found  |  ETA {eta:.0f}s", flush=True)

    # Insert segments FIRST (FK parent rows)
    for uuid, meta in seg_meta.items():
        times = seg_times[uuid]
        cur.execute("""
            INSERT OR REPLACE INTO segments
              (uuid, name, sport, start_lat, start_lon, end_lat, end_lon,
               effort_count, pr_time_s, avg_time_s, total_distance_m)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (
            uuid, meta["name"], meta["sport"],
            meta["start_lat"], meta["start_lon"],
            meta["end_lat"],   meta["end_lon"],
            len(times),
            min(times) if times else None,
            sum(times)/len(times) if times else None,
            None,
        ))
    conn.commit()

    # Insert efforts SECOND (FK child rows)
    for e in all_efforts:
        cur.execute("""
            INSERT OR IGNORE INTO segment_efforts
              (segment_uuid, activity_id, start_time, elapsed_time_s,
               distance_m, avg_speed_ms, avg_hr, max_hr, avg_cadence, status)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (e["uuid"], e["act_id"], e["start_time"], e["elapsed_s"],
              e["distance_m"], e["avg_speed"], e["avg_hr"],
              e["max_hr"], e["avg_cadence"], e["status"]))
    conn.commit()

    print(f"\nDone: {len(seg_meta)} unique segments, {total_efforts} total efforts.", flush=True)
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract segment efforts from FIT files")
    parser.add_argument("export_dir", help="Path to unzipped Strava export folder")
    parser.add_argument("--workers", type=int, default=None)
    args = parser.parse_args()
    extract(args.export_dir, args.workers)
