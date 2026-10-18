"""Saved experiment runs (SQLite file next to the backend)."""
import json
import os
import sqlite3
from datetime import datetime
from typing import Dict, List, Optional

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "controllab.db")


def _conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute(
        """CREATE TABLE IF NOT EXISTS runs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               created TEXT NOT NULL,
               operator TEXT, title TEXT, source TEXT,
               controller TEXT, kp REAL, ki REAL, kd REAL,
               metrics TEXT, model TEXT, samples TEXT)"""
    )
    return c


def save_run(run: Dict) -> int:
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO runs (created, operator, title, source, controller, kp, ki, kd, metrics, model, samples)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (datetime.now().isoformat(timespec="seconds"), run.get("operator"), run.get("title"),
             run.get("source"), run.get("controller"), run.get("kp"), run.get("ki"), run.get("kd"),
             json.dumps(run.get("metrics", {})), json.dumps(run.get("model", {})),
             json.dumps(run.get("samples", []))),
        )
        return int(cur.lastrowid)


def _row(r: sqlite3.Row, with_samples: bool) -> Dict:
    d = dict(r)
    d["metrics"] = json.loads(d["metrics"] or "{}")
    d["model"] = json.loads(d["model"] or "{}")
    samples = json.loads(d.pop("samples") or "[]")
    d["n_samples"] = len(samples)
    if with_samples:
        d["samples"] = samples
    return d


def list_runs() -> List[Dict]:
    with _conn() as c:
        return [_row(r, False) for r in c.execute("SELECT * FROM runs ORDER BY id DESC")]


def get_run(run_id: int) -> Optional[Dict]:
    with _conn() as c:
        r = c.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return _row(r, True) if r else None


def delete_run(run_id: int) -> bool:
    with _conn() as c:
        return c.execute("DELETE FROM runs WHERE id = ?", (run_id,)).rowcount > 0


def count() -> int:
    with _conn() as c:
        return int(c.execute("SELECT COUNT(*) FROM runs").fetchone()[0])
