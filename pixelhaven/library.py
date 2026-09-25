"""The image library: files on disk plus metadata in SQLite."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, UnidentifiedImageError

from . import tagger

try:  # AVIF/HEIC support if the plugin is installed
    import pillow_avif  # noqa: F401
except ImportError:
    pass

DATA_DIR = Path(os.environ.get("PIXELHAVEN_DATA", Path(__file__).resolve().parent.parent / "data"))
MIN_SIDE = int(os.environ.get("PIXELHAVEN_MIN_SIDE", "150"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    source_url    TEXT NOT NULL,
    page_url      TEXT,
    page_title    TEXT,
    title         TEXT,
    description   TEXT,
    width         INTEGER,
    height        INTEGER,
    format        TEXT,
    size_bytes    INTEGER,
    sha256        TEXT NOT NULL UNIQUE,
    tagged_by     TEXT,
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (image_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
"""

FORMAT_EXT = {"JPEG": "jpg", "PNG": "png", "GIF": "gif", "WEBP": "webp", "AVIF": "avif",
              "BMP": "bmp", "TIFF": "tif", "MPO": "jpg", "HEIF": "heic"}


class SkipImage(Exception):
    """Raised for images that are not worth keeping (duplicates, icons, broken)."""


class Library:
    def __init__(self, root: Path | str = DATA_DIR):
        self.root = Path(root)
        self.images_dir = self.root / "images"
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "library.db"
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ------------------------------------------------------------ ingest

    def add(self, data: bytes, source_url: str, original_name: str, page_url: str = "",
            page_title: str = "", alt: str = "") -> dict:
        sha = hashlib.sha256(data).hexdigest()
        with self._conn() as c:
            row = c.execute("SELECT id FROM images WHERE sha256 = ?", (sha,)).fetchone()
        if row:
            raise SkipImage(f"duplicate of image #{row['id']}")

        try:
            img = Image.open(io.BytesIO(data))
            img.load()
        except (UnidentifiedImageError, OSError) as e:
            raise SkipImage(f"not a readable image ({e})") from e
        w, h = img.size
        if min(w, h) < MIN_SIDE:
            raise SkipImage(f"too small ({w}x{h})")

        fmt = (img.format or "").upper()
        ext = FORMAT_EXT.get(fmt) or Path(original_name).suffix.lstrip(".").lower() or "img"

        analysis = tagger.analyze(img, source_url=source_url, page_url=page_url,
                                  page_title=page_title, alt=alt)

        stem = analysis.suggested_name or self._fallback_stem(original_name, analysis, source_url, page_url)
        filename = f"{stem}-{sha[:8]}.{ext}"

        with self._lock:
            with self._conn() as c:
                row = c.execute("SELECT id FROM images WHERE sha256 = ?", (sha,)).fetchone()
                if row:  # another worker stored the same image while we were tagging
                    raise SkipImage(f"duplicate of image #{row['id']}")
                if c.execute("SELECT 1 FROM images WHERE filename = ?", (filename,)).fetchone():
                    filename = f"{stem}-{sha[:16]}.{ext}"
            (self.images_dir / filename).write_bytes(data)
            with self._conn() as c:
                cur = c.execute(
                    """INSERT INTO images (filename, original_name, source_url, page_url, page_title,
                           title, description, width, height, format, size_bytes, sha256, tagged_by, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (filename, original_name, source_url, page_url, page_title, analysis.title,
                     analysis.description, w, h, fmt or ext.upper(), len(data), sha, analysis.tagged_by,
                     datetime.now(timezone.utc).isoformat(timespec="seconds")),
                )
                image_id = cur.lastrowid
                c.executemany("INSERT OR IGNORE INTO tags (image_id, tag) VALUES (?, ?)",
                              [(image_id, t) for t in analysis.tags])
        return self.get(image_id)

    @staticmethod
    def _fallback_stem(original_name: str, analysis, source_url: str, page_url: str) -> str:
        # Site name: "www.pinterest.com" -> "pinterest"; skip bare IPs / localhost.
        host = urlparse(page_url or source_url).hostname or ""
        labels = host.split(".")
        site = "" if host.replace(".", "").isdigit() or len(labels) < 2 else labels[-2]
        base = tagger.slugify(Path(original_name).stem, 6)
        # CDN names like "a1b2c3d4e5f6..." or "123456789_n" say nothing; use the title instead.
        if (not base or re.fullmatch(r"[0-9a-f_-]{12,}|[0-9_n-]+", base)) and analysis.title:
            base = tagger.slugify(analysis.title, 6)
        parts = [p for p in (site, base) if p]
        return "-".join(parts)[:80].strip("-") or "image"

    # ------------------------------------------------------------ queries

    def _with_tags(self, c, rows) -> list[dict]:
        out = []
        for r in rows:
            d = dict(r)
            d["tags"] = [t["tag"] for t in c.execute(
                "SELECT tag FROM tags WHERE image_id = ? ORDER BY tag", (r["id"],))]
            out.append(d)
        return out

    def get(self, image_id: int) -> dict | None:
        with self._conn() as c:
            rows = c.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchall()
            res = self._with_tags(c, rows)
        return res[0] if res else None

    def search(self, q: str = "", tags: list[str] | None = None, limit: int = 200, offset: int = 0) -> list[dict]:
        sql = "SELECT * FROM images WHERE 1=1"
        args: list = []
        for t in tags or []:
            sql += " AND id IN (SELECT image_id FROM tags WHERE tag = ?)"
            args.append(t.lower())
        for word in q.lower().split():
            like = f"%{word}%"
            sql += (" AND (lower(title) LIKE ? OR lower(description) LIKE ? OR lower(filename) LIKE ?"
                    " OR lower(original_name) LIKE ? OR lower(source_url) LIKE ? OR lower(page_url) LIKE ?"
                    " OR id IN (SELECT image_id FROM tags WHERE tag LIKE ?))")
            args += [like] * 7
        sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
        args += [limit, offset]
        with self._conn() as c:
            return self._with_tags(c, c.execute(sql, args).fetchall())

    def tag_counts(self, limit: int = 60) -> list[tuple[str, int]]:
        with self._conn() as c:
            rows = c.execute("SELECT tag, COUNT(*) n FROM tags GROUP BY tag ORDER BY n DESC, tag LIMIT ?",
                             (limit,)).fetchall()
        return [(r["tag"], r["n"]) for r in rows]

    def count(self) -> int:
        with self._conn() as c:
            return c.execute("SELECT COUNT(*) FROM images").fetchone()[0]

    # ------------------------------------------------------------ edits

    def set_tags(self, image_id: int, tags: list[str]) -> dict | None:
        tags = tagger.normalize_tags(tags)
        with self._conn() as c:
            c.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
            c.executemany("INSERT OR IGNORE INTO tags (image_id, tag) VALUES (?, ?)",
                          [(image_id, t) for t in tags])
        return self.get(image_id)

    def update(self, image_id: int, **fields) -> dict | None:
        allowed = {k: v for k, v in fields.items() if k in ("title", "description")}
        if allowed:
            sets = ", ".join(f"{k} = ?" for k in allowed)
            with self._conn() as c:
                c.execute(f"UPDATE images SET {sets} WHERE id = ?", (*allowed.values(), image_id))
        return self.get(image_id)

    def rename(self, image_id: int, new_stem: str) -> dict | None:
        img = self.get(image_id)
        if not img:
            return None
        stem = tagger.slugify(new_stem, 12)
        if not stem:
            raise ValueError("name is empty")
        ext = Path(img["filename"]).suffix
        new = f"{stem}-{img['sha256'][:8]}{ext}"
        if new != img["filename"]:
            with self._lock:
                (self.images_dir / img["filename"]).rename(self.images_dir / new)
                with self._conn() as c:
                    c.execute("UPDATE images SET filename = ? WHERE id = ?", (new, image_id))
        return self.get(image_id)

    def retag(self, image_id: int) -> dict | None:
        img = self.get(image_id)
        if not img:
            return None
        with Image.open(self.images_dir / img["filename"]) as pil:
            pil.load()
            analysis = tagger.analyze(pil, img["source_url"], img["page_url"] or "",
                                      img["page_title"] or "", img["title"] or "")
        with self._conn() as c:
            c.execute("UPDATE images SET title = ?, description = ?, tagged_by = ? WHERE id = ?",
                      (analysis.title or img["title"], analysis.description or img["description"],
                       analysis.tagged_by, image_id))
        self.set_tags(image_id, analysis.tags)
        if analysis.suggested_name:
            return self.rename(image_id, analysis.suggested_name)
        return self.get(image_id)

    def delete(self, image_id: int) -> bool:
        img = self.get(image_id)
        if not img:
            return False
        with self._lock:
            (self.images_dir / img["filename"]).unlink(missing_ok=True)
            with self._conn() as c:
                c.execute("DELETE FROM images WHERE id = ?", (image_id,))
        return True

    def export_json(self) -> str:
        return json.dumps(self.search(limit=1_000_000), indent=2)
