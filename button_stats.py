"""Daily aggregated README button-click statistics (no personal data)."""

import os
import sqlite3
from datetime import date

from view_counter import get_db_path, DB_TIMEOUT


def _ensure_table(path):
    """Create the button_stats table if it is missing."""
    dirpath = os.path.dirname(path)
    if dirpath:
        os.makedirs(dirpath, exist_ok=True)
    conn = sqlite3.connect(path, timeout=DB_TIMEOUT)
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS button_stats (
                stat_date TEXT NOT NULL,
                button_id TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (stat_date, button_id)
            )
        """)
        conn.commit()
    finally:
        conn.close()


ALLOWED_BUTTON_IDS = frozenset([
    "generate_readme",
    "anonymous_readme",
    "json_file",
    "send_to_dataverse",
    "send_to_figshare",
])


def record_click(app, button_id):
    """Increment today's count for button_id. Unknown ids are ignored."""
    if button_id not in ALLOWED_BUTTON_IDS:
        return
    path = get_db_path(app)
    _ensure_table(path)
    today = date.today().isoformat()
    conn = sqlite3.connect(path, timeout=DB_TIMEOUT)
    try:
        conn.execute("""
            INSERT INTO button_stats (stat_date, button_id, count)
            VALUES (?, ?, 1)
            ON CONFLICT(stat_date, button_id) DO UPDATE SET count = count + 1
        """, (today, button_id))
        conn.commit()
    finally:
        conn.close()


def get_button_stats(app):
    """Return [{date, button_id, count}, ...] ordered by date."""
    path = get_db_path(app)
    _ensure_table(path)
    conn = sqlite3.connect(path, timeout=DB_TIMEOUT)
    try:
        rows = conn.execute("""
            SELECT stat_date, button_id, count
            FROM button_stats
            ORDER BY stat_date, button_id
        """).fetchall()
        return [
            {"date": row[0], "button_id": row[1], "count": row[2]}
            for row in rows
        ]
    finally:
        conn.close()
