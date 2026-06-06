import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "strava.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_conn()
    c = conn.cursor()

    c.executescript("""
        CREATE TABLE IF NOT EXISTS activities (
            id              TEXT PRIMARY KEY,
            name            TEXT,
            date            TEXT,
            type            TEXT,
            distance_m      REAL,
            duration_s      INTEGER,
            elevation_m     REAL,
            avg_speed_ms    REAL,
            max_speed_ms    REAL,
            avg_hr          REAL,
            max_hr          REAL,
            avg_watts       REAL,
            kudos           INTEGER,
            commute         INTEGER DEFAULT 0,
            private         INTEGER DEFAULT 0,
            filename        TEXT,
            gpx_loaded      INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS track_points (
            activity_id     TEXT,
            seq             INTEGER,
            lat             REAL,
            lon             REAL,
            ele             REAL,
            time            TEXT,
            PRIMARY KEY (activity_id, seq),
            FOREIGN KEY (activity_id) REFERENCES activities(id)
        );

        CREATE TABLE IF NOT EXISTS route_clusters (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT,
            activity_ids    TEXT,   -- JSON array of activity IDs
            count           INTEGER,
            total_distance_m REAL,
            best_duration_s  INTEGER,
            avg_duration_s   INTEGER,
            best_speed_ms    REAL,
            avg_elevation_m  REAL,
            start_lat       REAL,
            start_lon       REAL,
            end_lat         REAL,
            end_lon         REAL,
            representative_activity_id TEXT
        );

        CREATE TABLE IF NOT EXISTS athletes (
            id              TEXT PRIMARY KEY,
            name            TEXT
        );

        CREATE TABLE IF NOT EXISTS activity_athletes (
            activity_id     TEXT,
            athlete_id      TEXT,
            PRIMARY KEY (activity_id, athlete_id),
            FOREIGN KEY (activity_id) REFERENCES activities(id),
            FOREIGN KEY (athlete_id) REFERENCES athletes(id)
        );

        CREATE TABLE IF NOT EXISTS segments (
            uuid            TEXT PRIMARY KEY,   -- Strava internal segment ID (from FIT)
            name            TEXT,
            sport           TEXT,
            start_lat       REAL,
            start_lon       REAL,
            end_lat         REAL,
            end_lon         REAL,
            effort_count    INTEGER DEFAULT 0,
            pr_time_s       REAL,               -- best elapsed time
            avg_time_s      REAL,
            total_distance_m REAL
        );

        CREATE TABLE IF NOT EXISTS segment_efforts (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_uuid    TEXT,
            activity_id     TEXT,
            start_time      TEXT,
            elapsed_time_s  REAL,
            distance_m      REAL,
            avg_speed_ms    REAL,
            avg_hr          INTEGER,
            max_hr          INTEGER,
            avg_cadence     INTEGER,
            status          TEXT,               -- 'success' = PR attempt
            FOREIGN KEY (segment_uuid) REFERENCES segments(uuid),
            FOREIGN KEY (activity_id)  REFERENCES activities(id)
        );

        CREATE TABLE IF NOT EXISTS starred_segments (
            segment_id      TEXT PRIMARY KEY,
            starred_date    TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_tp_activity    ON track_points(activity_id);
        CREATE INDEX IF NOT EXISTS idx_act_date       ON activities(date);
        CREATE INDEX IF NOT EXISTS idx_act_type       ON activities(type);
        CREATE INDEX IF NOT EXISTS idx_eff_segment    ON segment_efforts(segment_uuid);
        CREATE INDEX IF NOT EXISTS idx_eff_activity   ON segment_efforts(activity_id);
    """)

    conn.commit()
    conn.close()
    print(f"Database initialized at {DB_PATH}")
