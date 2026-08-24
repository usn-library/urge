"""Anonymous page-view counter stored in SQLite under instance_folder."""

import os
import sqlite3


DB_TIMEOUT = 5.0


def get_db_path(app):
    """Return the path to instance_folder/viewcount.db."""
    return os.path.join(app.instance_path, "viewcount.db")


def _ensure_db(path):
    """Create the DB file and the single counter row if missing."""
    dirpath = os.path.dirname(path)
    if dirpath:
        os.makedirs(dirpath, exist_ok=True)
    conn = sqlite3.connect(path, timeout=DB_TIMEOUT)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS view_count (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0)"
        )
        conn.execute("INSERT OR IGNORE INTO view_count (id, n) VALUES (1, 0)")
        conn.commit()
    finally:
        conn.close()


def increment(path):
    """Increment the view count by 1. Atomic across workers."""
    _ensure_db(path)
    conn = sqlite3.connect(path, timeout=DB_TIMEOUT)
    try:
        conn.execute("UPDATE view_count SET n = n + 1 WHERE id = 1")
        conn.commit()
    finally:
        conn.close()


def get_count(path):
    """Return the current total without incrementing."""
    _ensure_db(path)
    conn = sqlite3.connect(path, timeout=DB_TIMEOUT)
    try:
        row = conn.execute("SELECT n FROM view_count WHERE id = 1").fetchone()
        return int(row[0]) if row else 0
    finally:
        conn.close()
