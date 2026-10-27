"""Memory and chat history in one SQLite file. Facts are plain sentences the user can read, edit and delete (the desktop app shows them).
Retrieval is keyword overlap, not embeddings: no model download, predictable, good enough for a few thousand short facts."""
from __future__ import annotations

import re
import sqlite3
import threading
import time
from pathlib import Path

_WORD = re.compile(r"[a-z0-9']{3,}")
_STOP = frozenset("the and for that this with you your have not are was but what when where who how can about from they them there their will would just like".split())
MAX_FACT = 400


def _words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP}


class Memory:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._db.executescript(
                """CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact', source TEXT NOT NULL DEFAULT 'chat', created REAL NOT NULL, updated REAL NOT NULL);
                   CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, created REAL NOT NULL, turn_id TEXT);"""
            )

    # ── facts ──
    def add_fact(self, text: str, kind: str = "fact", source: str = "chat") -> int | None:
        text = re.sub(r"\s+", " ", text or "").strip()[:MAX_FACT]
        if len(text) < 3:
            return None
        now = time.time()
        with self._lock:
            row = self._db.execute("SELECT id FROM facts WHERE lower(text)=lower(?)", (text,)).fetchone()
            if row:
                self._db.execute("UPDATE facts SET updated=? WHERE id=?", (now, row["id"]))
                self._db.commit()
                return row["id"]
            cur = self._db.execute("INSERT INTO facts(text,kind,source,created,updated) VALUES(?,?,?,?,?)", (text, kind[:20], source[:20], now, now))
            self._db.commit()
            return cur.lastrowid

    def list_facts(self, limit: int = 200) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._db.execute("SELECT * FROM facts ORDER BY updated DESC LIMIT ?", (limit,))]

    def update_fact(self, fact_id: int, text: str) -> bool:
        text = re.sub(r"\s+", " ", text or "").strip()[:MAX_FACT]
        if len(text) < 3:
            return False
        with self._lock:
            cur = self._db.execute("UPDATE facts SET text=?, updated=? WHERE id=?", (text, time.time(), fact_id))
            self._db.commit()
            return cur.rowcount > 0

    def delete_fact(self, fact_id: int) -> bool:
        with self._lock:
            cur = self._db.execute("DELETE FROM facts WHERE id=?", (fact_id,))
            self._db.commit()
            return cur.rowcount > 0

    def forget_matching(self, text: str) -> int:
        """Delete facts that mention every meaningful word of `text` (used by the 'forget' tool). Returns how many."""
        want = _words(text)
        if not want:
            return 0
        with self._lock:
            ids = [r["id"] for r in self._db.execute("SELECT id, text FROM facts") if want <= _words(r["text"])]
            for i in ids:
                self._db.execute("DELETE FROM facts WHERE id=?", (i,))
            self._db.commit()
        return len(ids)

    def search_facts(self, query: str, k: int = 6) -> list[dict]:
        q = _words(query)
        with self._lock:
            rows = [dict(r) for r in self._db.execute("SELECT * FROM facts")]
        scored = [(len(q & _words(r["text"])), r["updated"], r) for r in rows]
        hits = [t for t in scored if t[0] > 0]
        hits.sort(key=lambda t: (t[0], t[1]), reverse=True)
        return [t[2] for t in hits[:k]]

    def clear_facts(self) -> int:
        with self._lock:
            cur = self._db.execute("DELETE FROM facts")
            self._db.commit()
            return cur.rowcount

    # ── messages ──
    def add_message(self, role: str, text: str, turn_id: str | None = None) -> int:
        with self._lock:
            cur = self._db.execute("INSERT INTO messages(role,text,created,turn_id) VALUES(?,?,?,?)", (role, text[:8000], time.time(), turn_id))
            self._db.commit()
            return cur.lastrowid

    def history(self, limit: int = 30, before_id: int | None = None) -> tuple[list[dict], bool]:
        """Oldest first. `has_more` says whether older rows exist."""
        with self._lock:
            rows = [dict(r) for r in self._db.execute(
                "SELECT * FROM messages WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?", (before_id, before_id, limit + 1))]
        more = len(rows) > limit
        return list(reversed(rows[:limit])), more

    def recent(self, n: int = 12) -> list[dict]:
        return self.history(n)[0]

    def close(self) -> None:
        with self._lock:
            self._db.close()
