"""Local REST API and scanning engine for Seahare.

The implementation intentionally uses only the Python standard library so it
can be bundled into a Windows desktop application without a dependency tree.
"""
from __future__ import annotations

import csv
import hashlib
import io
import itertools
import json
import os
import sqlite3
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
FROZEN = bool(getattr(sys, "frozen", False))
RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", ROOT.parent))
DEFAULT_DATA_DIR = Path(os.environ.get("LOCALAPPDATA", ROOT)) / "Seahare" if FROZEN else ROOT
DATA_DIR = Path(os.environ.get("SEAHARE_DATA_DIR", DEFAULT_DATA_DIR))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.environ.get("SEAHARE_DB", DATA_DIR / "seahare.db"))
DICTIONARY_DIR = RESOURCE_ROOT / "backend" / "dictionaries" if FROZEN else ROOT / "dictionaries"


def custom_dictionary_path(data_dir: Path, builtin_dir: Path) -> Path:
    candidate = data_dir / "dictionaries"
    # In development data_dir defaults to ROOT (backend), which is also the
    # source directory for built-in dictionaries.
    return data_dir / "custom-dictionaries" if candidate.resolve() == builtin_dir.resolve() else candidate


CUSTOM_DICTIONARY_DIR = custom_dictionary_path(DATA_DIR, DICTIONARY_DIR)
CUSTOM_DICTIONARY_DIR.mkdir(parents=True, exist_ok=True)
HOST = os.environ.get("SEAHARE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SEAHARE_PORT", "8765"))

PRESETS: dict[str, dict[str, Any]] = {
    "quick": {
        "name": "快速探测", "description": "优先速度，适合首次确认暴露面",
        "dictionary": "api.txt", "threads": 48, "timeout": 4.0,
    },
    "balanced": {
        "name": "均衡扫描", "description": "速度与稳定性兼顾的默认策略",
        "dictionary": "common.txt", "threads": 24, "timeout": 8.0,
    },
    "careful": {
        "name": "谨慎扫描", "description": "降低并发并延长超时，适合不稳定目标",
        "dictionary": "common.txt", "threads": 8, "timeout": 15.0,
    },
}

DEFAULT_PLACEHOLDER = "{fuzz}"
MAX_ENUM_WORDS = 500_000
MAX_ENUM_LEN = 6
REQUEST_METHODS = {"AUTO", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
AUTO_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
METHODS_WITH_BODY = {"POST", "PUT", "PATCH", "DELETE"}
TARGET_TYPES = {"web", "api", "h5"}

SENSITIVE_PATH_TOKENS = {
    "admin", "backup", "config", "database", "db", "dump", "env", "git",
    "password", "secret", "server-status", "settings", "swagger",
}
AUTH_PATH_TOKENS = {"auth", "login", "oauth", "signin", "sso"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def inspect_response(body: bytes) -> tuple[str, str, int | None, str]:
    """Return a bounded preview, fingerprint, and common JSON business fields."""
    digest = hashlib.sha256(body).hexdigest()[:16] if body else ""
    text = body.decode("utf-8", errors="replace")
    preview = " ".join(text.split())[:240]
    business_code: int | None = None
    business_message = ""
    try:
        payload = json.loads(text) if text else None
    except (TypeError, ValueError):
        payload = None
    if isinstance(payload, dict):
        raw_code = payload.get("errno", payload.get("code"))
        if isinstance(raw_code, bool):
            business_code = int(raw_code)
        elif isinstance(raw_code, (int, float)):
            business_code = int(raw_code)
        elif isinstance(raw_code, str) and raw_code.strip().lstrip("-").isdigit():
            business_code = int(raw_code.strip())
        raw_message = payload.get("errmsg", payload.get("message", ""))
        if raw_message is not None:
            business_message = str(raw_message)[:160]
    return preview, digest, business_code, business_message


def classify_result(
    path: str, status: int, business_code: int | None = None,
    spa_fallback: bool = False,
) -> tuple[str, str]:
    tokens = {token for token in path.lower().replace(".", "/").replace("-", "/").split("/") if token}
    if spa_fallback:
        return "spa_fallback", "info"
    if tokens & SENSITIVE_PATH_TOKENS:
        return "sensitive", "high" if status < 400 or status in (401, 403, 500) else "medium"
    if status >= 500:
        return "server_error", "high"
    if business_code not in (None, 0):
        return "business_error", "medium"
    if tokens & AUTH_PATH_TOKENS:
        return "authentication", "medium"
    if status in (401, 403):
        return "protected", "medium"
    if 300 <= status < 400:
        return "redirect", "info"
    return "accessible", "low"


def public_result(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    result["spa_fallback"] = bool(result.get("spa_fallback", 0))
    return result


def public_scan(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    raw_headers = result.get("request_headers", {})
    if isinstance(raw_headers, str):
        try:
            parsed = json.loads(raw_headers or "{}")
        except (TypeError, ValueError):
            parsed = {}
        result["request_headers"] = parsed if isinstance(parsed, dict) else {}
    return result


def dictionary_files() -> dict[str, Path]:
    files = {path.name: path for path in DICTIONARY_DIR.glob("*.txt")}
    files.update({path.name: path for path in CUSTOM_DICTIONARY_DIR.glob("*.txt")})
    return files


def resolve_dictionary(name: str) -> Path | None:
    safe_name = Path(name).name
    if safe_name != name or not safe_name.endswith(".txt"):
        return None
    return dictionary_files().get(safe_name)


def dictionary_metadata() -> list[dict[str, Any]]:
    items = []
    for name, path in sorted(dictionary_files().items()):
        try:
            entries = sum(
                1 for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            )
            size = path.stat().st_size
        except OSError:
            entries, size = 0, 0
        items.append({
            "name": name, "entries": entries, "size": size,
            "builtin": path.parent.resolve() == DICTIONARY_DIR.resolve(),
        })
    return items


def enum_total(charset_len: int, min_len: int, max_len: int, count: int = 1) -> int:
    # Each {fuzz} placeholder expands the request space independently.
    return sum(charset_len ** (n * count) for n in range(min_len, max_len + 1))


def enum_words(charset: str, min_len: int, max_len: int, count: int = 1):
    """Yield tuples of `count` words — one per {fuzz} placeholder — for each length."""
    for length in range(min_len, max_len + 1):
        for combo in itertools.product(charset, repeat=length * count):
            yield tuple("".join(combo[i * length:(i + 1) * length]) for i in range(count))


@dataclass
class ScanJob:
    id: str
    target: str
    dictionary: str
    threads: int
    timeout: float
    target_type: str = "web"
    request_method: str = "GET"
    request_headers: dict[str, str] = field(default_factory=dict)
    request_body: str = ""
    preset: str = "custom"
    mode: str = "dictionary"
    charset: str = ""
    min_len: int = 1
    max_len: int = 1
    placeholder: str = DEFAULT_PLACEHOLDER
    status: str = "queued"
    progress: float = 0.0
    requests: int = 0
    found: int = 0
    created_at: str = field(default_factory=now)
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    pause_event: threading.Event = field(default_factory=threading.Event, repr=False)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "target": self.target, "dictionary": self.dictionary,
            "threads": self.threads, "timeout": self.timeout, "preset": self.preset,
            "target_type": self.target_type, "request_method": self.request_method,
            "request_headers": self.request_headers, "request_body": self.request_body,
            "mode": self.mode, "charset": self.charset,
            "min_len": self.min_len, "max_len": self.max_len, "placeholder": self.placeholder,
            "status": self.status,
            "progress": self.progress, "requests": self.requests, "found": self.found,
            "created_at": self.created_at, "started_at": self.started_at,
            "finished_at": self.finished_at, "error": self.error,
        }


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with self.conn:
            self.conn.executescript("""
              CREATE TABLE IF NOT EXISTS scans (
                id TEXT PRIMARY KEY, target TEXT NOT NULL, dictionary TEXT NOT NULL,
                threads INTEGER NOT NULL, timeout REAL NOT NULL, preset TEXT NOT NULL DEFAULT 'custom',
                mode TEXT NOT NULL DEFAULT 'dictionary',
                charset TEXT NOT NULL DEFAULT '', min_len INTEGER NOT NULL DEFAULT 1,
                max_len INTEGER NOT NULL DEFAULT 1, placeholder TEXT NOT NULL DEFAULT '{fuzz}',
                target_type TEXT NOT NULL DEFAULT 'web', request_method TEXT NOT NULL DEFAULT 'GET',
                request_headers TEXT NOT NULL DEFAULT '{}', request_body TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                progress REAL NOT NULL, requests INTEGER NOT NULL, found INTEGER NOT NULL,
                created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT
              );
              CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id TEXT NOT NULL,
                path TEXT NOT NULL, url TEXT NOT NULL, request_method TEXT NOT NULL DEFAULT 'GET', status INTEGER NOT NULL,
                length INTEGER NOT NULL, content_type TEXT, response_time REAL NOT NULL,
                discovered_at TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'accessible',
                severity TEXT NOT NULL DEFAULT 'low', redirect_location TEXT NOT NULL DEFAULT '',
                business_code INTEGER, business_message TEXT NOT NULL DEFAULT '',
                response_preview TEXT NOT NULL DEFAULT '', body_hash TEXT NOT NULL DEFAULT '',
                spa_fallback INTEGER NOT NULL DEFAULT 0,
                UNIQUE(scan_id, path, request_method)
              );
              CREATE INDEX IF NOT EXISTS idx_results_scan ON results(scan_id, id);
            """)
            self._ensure_column("scans", "preset", "TEXT NOT NULL DEFAULT 'custom'")
            self._ensure_column("scans", "mode", "TEXT NOT NULL DEFAULT 'dictionary'")
            self._ensure_column("scans", "charset", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column("scans", "min_len", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column("scans", "max_len", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column("scans", "placeholder", f"TEXT NOT NULL DEFAULT '{DEFAULT_PLACEHOLDER}'")
            self._ensure_column("scans", "target_type", "TEXT NOT NULL DEFAULT 'web'")
            self._ensure_column("scans", "request_method", "TEXT NOT NULL DEFAULT 'GET'")
            self._ensure_column("scans", "request_headers", "TEXT NOT NULL DEFAULT '{}'")
            self._ensure_column("scans", "request_body", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column("results", "category", "TEXT NOT NULL DEFAULT 'accessible'")
            self._ensure_column("results", "severity", "TEXT NOT NULL DEFAULT 'low'")
            self._ensure_column("results", "redirect_location", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column("results", "request_method", "TEXT NOT NULL DEFAULT 'GET'")
            self._ensure_column("results", "business_code", "INTEGER")
            self._ensure_column("results", "business_message", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column("results", "response_preview", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column("results", "body_hash", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column("results", "spa_fallback", "INTEGER NOT NULL DEFAULT 0")
            self._migrate_result_key()
            self.conn.execute(
                """UPDATE scans SET status='interrupted', finished_at=?,
                   error=COALESCE(error, 'Application exited before the scan completed.')
                   WHERE status IN ('queued','running','paused','cancelling')""",
                (now(),),
            )
            for row in self.conn.execute("SELECT id,path,status,business_code,spa_fallback FROM results"):
                category, severity = classify_result(
                    row["path"], row["status"], row["business_code"], bool(row["spa_fallback"])
                )
                self.conn.execute(
                    "UPDATE results SET category=?,severity=? WHERE id=?",
                    (category, severity, row["id"]),
                )

    def _ensure_column(self, table: str, column: str, declaration: str) -> None:
        columns = {row["name"] for row in self.conn.execute(f"PRAGMA table_info({table})")}
        if column not in columns:
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")

    def _migrate_result_key(self) -> None:
        """Allow one path to retain evidence for each AUTO method."""
        pair_unique = False
        for index in self.conn.execute("PRAGMA index_list(results)"):
            if not index[2]:
                continue
            name = str(index[1]).replace('"', '""')
            columns = [row[2] for row in self.conn.execute(f'PRAGMA index_info("{name}")')]
            if columns == ["scan_id", "path"]:
                pair_unique = True
                break
        if not pair_unique:
            return
        self.conn.execute("""
          CREATE TABLE results_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id TEXT NOT NULL,
            path TEXT NOT NULL, url TEXT NOT NULL, request_method TEXT NOT NULL DEFAULT 'GET',
            status INTEGER NOT NULL, length INTEGER NOT NULL, content_type TEXT,
            response_time REAL NOT NULL, discovered_at TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'accessible', severity TEXT NOT NULL DEFAULT 'low',
            redirect_location TEXT NOT NULL DEFAULT '', business_code INTEGER,
            business_message TEXT NOT NULL DEFAULT '', response_preview TEXT NOT NULL DEFAULT '',
            body_hash TEXT NOT NULL DEFAULT '', spa_fallback INTEGER NOT NULL DEFAULT 0,
            UNIQUE(scan_id, path, request_method)
          )
        """)
        self.conn.execute("""
          INSERT INTO results_v2
            (id,scan_id,path,url,request_method,status,length,content_type,response_time,
             discovered_at,category,severity,redirect_location,business_code,business_message,
             response_preview,body_hash,spa_fallback)
          SELECT id,scan_id,path,url,request_method,status,length,content_type,response_time,
             discovered_at,category,severity,redirect_location,business_code,business_message,
             response_preview,body_hash,spa_fallback
          FROM results
        """)
        self.conn.execute("DROP TABLE results")
        self.conn.execute("ALTER TABLE results_v2 RENAME TO results")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_results_scan ON results(scan_id, id)")

    def save_scan(self, job: ScanJob) -> None:
        with self.lock, self.conn:
            self.conn.execute("""INSERT OR REPLACE INTO scans
              (id,target,dictionary,threads,timeout,preset,mode,charset,min_len,max_len,placeholder,target_type,request_method,request_headers,request_body,status,progress,requests,found,created_at,started_at,finished_at,error)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                job.id, job.target, job.dictionary, job.threads, job.timeout,
                job.preset, job.mode, job.charset, job.min_len, job.max_len, job.placeholder,
                job.target_type, job.request_method, json.dumps(job.request_headers, ensure_ascii=False), job.request_body,
                job.status, job.progress, job.requests, job.found,
                job.created_at, job.started_at, job.finished_at, job.error,
              ))

    def update_scan(self, job: ScanJob) -> None:
        with self.lock, self.conn:
            self.conn.execute("""UPDATE scans SET status=?,progress=?,requests=?,found=?,started_at=?,finished_at=?,error=? WHERE id=?""",
              (job.status, job.progress, job.requests, job.found, job.started_at, job.finished_at, job.error, job.id))

    def add_result(self, scan_id: str, item: dict[str, Any]) -> bool:
        category, severity = classify_result(
            item["path"], item["status"], item.get("business_code"), item.get("spa_fallback", False)
        )
        with self.lock, self.conn:
            cursor = self.conn.execute("""INSERT OR IGNORE INTO results
              (scan_id,path,url,request_method,status,length,content_type,response_time,discovered_at,category,severity,redirect_location,business_code,business_message,response_preview,body_hash,spa_fallback)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                scan_id, item["path"], item["url"], item.get("request_method", "GET"), item["status"], item["length"],
                item["content_type"], item["response_time"], now(), category, severity,
                item.get("redirect_location", ""),
                item.get("business_code"), item.get("business_message", ""),
                item.get("response_preview", ""), item.get("body_hash", ""),
                int(bool(item.get("spa_fallback", False))),
            ))
            return cursor.rowcount > 0

    def list_scans(self) -> list[dict[str, Any]]:
        with self.lock:
            return [public_scan(dict(row)) for row in self.conn.execute("SELECT * FROM scans ORDER BY created_at DESC")]

    def delete_scan(self, scan_id: str) -> bool:
        with self.lock, self.conn:
            exists = self.conn.execute("SELECT 1 FROM scans WHERE id=?", (scan_id,)).fetchone()
            if not exists:
                return False
            self.conn.execute("DELETE FROM results WHERE scan_id=?", (scan_id,))
            self.conn.execute("DELETE FROM scans WHERE id=?", (scan_id,))
            return True

    def scan(self, scan_id: str) -> dict[str, Any] | None:
        with self.lock:
            row = self.conn.execute("SELECT * FROM scans WHERE id=?", (scan_id,)).fetchone()
            return dict(row) if row else None

    def results(self, scan_id: str, category: str = "all") -> list[dict[str, Any]]:
        return self.result_page(scan_id, category=category, limit=100_000)["results"]

    def result_page(
        self, scan_id: str, category: str = "all", severity: str = "all",
        after_id: int = 0, limit: int = 500,
    ) -> dict[str, Any]:
        clauses = ["scan_id=?", "id>?"]
        params: list[Any] = [scan_id, max(0, after_id)]
        if category == "redirect":
            clauses.append("status>=300 AND status<400")
        elif category == "interesting":
            clauses.append("(status<300 OR status IN (401,403,500))")
        elif category not in ("all", ""):
            clauses.append("category=?")
            params.append(category)
        if severity in ("high", "medium", "low", "info"):
            clauses.append("severity=?")
            params.append(severity)
        limit = max(1, min(int(limit), 500))
        where = " AND ".join(clauses)
        with self.lock:
            rows = [public_result(dict(row)) for row in self.conn.execute(
                f"SELECT * FROM results WHERE {where} ORDER BY id LIMIT ?",
                (*params, limit + 1),
            )]
            total = self.conn.execute(
                f"SELECT COUNT(*) FROM results WHERE {where}", tuple(params)
            ).fetchone()[0]
        has_more = len(rows) > limit
        rows = rows[:limit]
        return {
            "results": rows, "total": total, "returned": len(rows),
            "next_cursor": rows[-1]["id"] if rows else after_id, "has_more": has_more,
        }

    def result_summary(self, scan_id: str) -> dict[str, Any]:
        with self.lock:
            total, max_id = self.conn.execute(
                "SELECT COUNT(*),COALESCE(MAX(id),0) FROM results WHERE scan_id=?", (scan_id,)
            ).fetchone()
            severity = {row[0]: row[1] for row in self.conn.execute(
                "SELECT severity,COUNT(*) FROM results WHERE scan_id=? GROUP BY severity", (scan_id,)
            )}
            categories = {row[0]: row[1] for row in self.conn.execute(
                "SELECT category,COUNT(*) FROM results WHERE scan_id=? GROUP BY category", (scan_id,)
            )}
        return {
            "total": total, "max_id": max_id,
            "severity": {name: severity.get(name, 0) for name in ("high", "medium", "low", "info")},
            "categories": categories,
        }

    def close(self) -> None:
        with self.lock:
            self.conn.close()


class ScanManager:
    def __init__(self, store: Store):
        self.store = store
        self.jobs: dict[str, ScanJob] = {}
        self.lock = threading.RLock()

    def create(
        self, target: str, dictionary: str = "", threads: int = 16, timeout: float = 8.0,
        preset: str = "custom", enum: dict[str, Any] | None = None,
        target_type: str = "web", request_method: str = "GET",
        request_headers: dict[str, str] | None = None, request_body: str = "",
    ) -> ScanJob:
        parsed = urlparse(target if "://" in target else f"https://{target}")
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("target must be a valid http or https URL")
        target = f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}" or f"{parsed.scheme}://{parsed.netloc}"
        threads = max(1, min(int(threads), 128)); timeout = max(1.0, min(float(timeout), 60.0))
        preset = preset if preset in PRESETS else "custom"
        target_type = str(target_type or "web").lower()
        if target_type not in TARGET_TYPES:
            raise ValueError(f"target_type must be one of {', '.join(sorted(TARGET_TYPES))}")
        request_method = str(request_method or "GET").upper()
        if request_method not in REQUEST_METHODS:
            raise ValueError(f"request_method must be one of {', '.join(sorted(REQUEST_METHODS))}")
        if request_headers is None:
            request_headers = {}
        if not isinstance(request_headers, dict):
            raise ValueError("request_headers must be an object")
        normalized_headers: dict[str, str] = {}
        for key, value in request_headers.items():
            name = str(key).strip()
            if not name or "\r" in name or "\n" in name or "\r" in str(value) or "\n" in str(value):
                raise ValueError("request headers must not contain empty names or newlines")
            normalized_headers[name] = str(value)
        request_body = str(request_body or "")
        if len(request_body.encode("utf-8")) > 1_000_000:
            raise ValueError("request_body is too large")
        if enum is not None:
            charset = "".join(dict.fromkeys(str(enum.get("charset") or "")))
            min_len = int(enum.get("min_len", 1)); max_len = int(enum.get("max_len", 1))
            placeholder = str(enum.get("placeholder") or DEFAULT_PLACEHOLDER)
            if not charset:
                raise ValueError("charset must not be empty")
            if placeholder not in target:
                raise ValueError(f"target must contain the {placeholder} placeholder")
            if not (1 <= min_len <= max_len <= MAX_ENUM_LEN):
                raise ValueError(f"length range must satisfy 1 <= min <= max <= {MAX_ENUM_LEN}")
            placeholder_count = target.count(placeholder)
            total = enum_total(len(charset), min_len, max_len, placeholder_count)
            if total > MAX_ENUM_WORDS:
                raise ValueError(f"combination count {total} exceeds the limit of {MAX_ENUM_WORDS}; shrink the charset or lengths")
            job = ScanJob(
                uuid.uuid4().hex, target, "", threads, timeout, preset=preset,
                target_type=target_type, request_method=request_method,
                request_headers=normalized_headers, request_body=request_body,
                mode="enum", charset=charset, min_len=min_len, max_len=max_len,
                placeholder=placeholder,
            )
        else:
            path = resolve_dictionary(dictionary)
            if not path:
                raise ValueError("dictionary not found")
            job = ScanJob(
                uuid.uuid4().hex, target, path.name, threads, timeout, preset=preset,
                target_type=target_type, request_method=request_method,
                request_headers=normalized_headers, request_body=request_body,
            )
        with self.lock:
            self.jobs[job.id] = job
        self.store.save_scan(job)
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def get(self, scan_id: str) -> ScanJob | None:
        with self.lock: return self.jobs.get(scan_id)

    def _run(self, job: ScanJob) -> None:
        try:
            if job.mode == "enum":
                placeholder_count = job.target.count(job.placeholder)
                word_total = enum_total(len(job.charset), job.min_len, job.max_len, placeholder_count)
                words = enum_words(job.charset, job.min_len, job.max_len, placeholder_count)
            else:
                dictionary_path = resolve_dictionary(job.dictionary)
                if not dictionary_path:
                    raise ValueError("dictionary not found")
                words = [line.strip() for line in dictionary_path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
                word_total = len(words)
            method_candidates = AUTO_METHODS if job.request_method == "AUTO" else (job.request_method,)
            total = word_total * len(method_candidates)
            job.status = "running"; job.started_at = now(); self.store.update_scan(job)
            class NoRedirect(HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    return None

            opener = build_opener(NoRedirect)

            def perform_request(url: str, method: str, body_text: str = "") -> dict[str, Any]:
                headers = dict(job.request_headers)
                if not any(name.lower() == "user-agent" for name in headers):
                    headers["User-Agent"] = "Seahare/2.0"
                if job.target_type == "h5" and not any(name.lower() == "accept" for name in headers):
                    headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                if body_text and not any(name.lower() == "content-type" for name in headers):
                    headers["Content-Type"] = "application/json"
                data = body_text.encode("utf-8") if body_text else None
                started = time.perf_counter()
                try:
                    req = Request(url, data=data, headers=headers, method=method)
                    with opener.open(req, timeout=job.timeout) as response:
                        raw_body = response.read(65536)
                        preview, body_hash, business_code, business_message = inspect_response(raw_body)
                        return {
                            "status": response.status,
                            "content_type": response.headers.get_content_type(),
                            "length": int(response.headers.get("Content-Length") or len(raw_body)),
                            "redirect_location": response.headers.get("Location", ""),
                            "response_preview": preview, "body_hash": body_hash,
                            "business_code": business_code, "business_message": business_message,
                            "response_time": round((time.perf_counter() - started) * 1000, 1),
                        }
                except HTTPError as exc:
                    raw_body = exc.read(65536)
                    preview, body_hash, business_code, business_message = inspect_response(raw_body)
                    return {
                        "status": exc.code,
                        "content_type": exc.headers.get_content_type() if exc.headers else "",
                        "length": int(exc.headers.get("Content-Length") or len(raw_body)) if exc.headers else len(raw_body),
                        "redirect_location": exc.headers.get("Location", "") if exc.headers else "",
                        "response_preview": preview, "body_hash": body_hash,
                        "business_code": business_code, "business_message": business_message,
                        "response_time": round((time.perf_counter() - started) * 1000, 1),
                    }

            baseline_hash = ""
            baseline_path = urlparse(job.target).path or "/"
            if job.request_method in ("GET", "AUTO"):
                try:
                    baseline = perform_request(job.target, "GET")
                    if baseline["status"] < 300 and baseline["content_type"] == "text/html":
                        baseline_hash = baseline["body_hash"]
                except (URLError, TimeoutError, OSError):
                    pass

            def probe(request) -> None:
                word, request_method = request
                while job.pause_event.is_set() and not job.cancel_event.is_set(): time.sleep(.1)
                if job.cancel_event.is_set(): return
                replacement = "".join(word) if isinstance(word, tuple) else str(word)
                if job.mode == "enum":
                    # `word` is a tuple of parts when the target has several
                    # {fuzz} placeholders; replace them one at a time.
                    url = job.target
                    if isinstance(word, tuple):
                        for part in word:
                            url = url.replace(job.placeholder, part, 1)
                    else:
                        url = url.replace(job.placeholder, word, 1)
                    path = urlparse(url).path
                else:
                    path = "/" + word.lstrip("/"); url = job.target.rstrip("/") + path
                body_text = job.request_body.replace(job.placeholder, replacement)
                if request_method in METHODS_WITH_BODY and not body_text.strip():
                    body_text = json.dumps({"value": replacement}, ensure_ascii=False, separators=(",", ":"))
                error = None
                details = None
                try:
                    request_payload = body_text if request_method in METHODS_WITH_BODY else ""
                    details = perform_request(url, request_method, request_payload)
                except (URLError, TimeoutError, OSError) as exc: error = str(exc)
                finally:
                    with self.lock: job.requests += 1
                    if error is None and details is not None and details["status"] and (details["status"] < 400 or details["status"] in (401, 403, 500)):
                        spa_fallback = bool(
                            baseline_hash and details["body_hash"] == baseline_hash
                            and details["content_type"] == "text/html"
                            and (urlparse(url).path or "/") != baseline_path
                        )
                        item = {
                            "path": path, "url": url, "status": details["status"],
                            "request_method": request_method,
                            "length": details["length"], "content_type": details["content_type"],
                            "redirect_location": details["redirect_location"],
                            "response_time": details["response_time"],
                            "response_preview": details["response_preview"],
                            "body_hash": details["body_hash"],
                            "business_code": details["business_code"],
                            "business_message": details["business_message"],
                            "spa_fallback": spa_fallback,
                        }
                        if self.store.add_result(job.id, item):
                            with self.lock: job.found += 1
                    with self.lock: job.progress = job.requests / total if total else 1.0
                    self.store.update_scan(job)
            requests = ((word, method) for word in words for method in method_candidates)
            with ThreadPoolExecutor(max_workers=job.threads) as pool: list(pool.map(probe, requests))
            job.status = "cancelled" if job.cancel_event.is_set() else "completed"; job.progress = 1.0 if job.status == "completed" else job.progress
        except Exception as exc: job.status = "failed"; job.error = str(exc)
        finally: job.finished_at = now(); self.store.update_scan(job)

    def action(self, scan_id: str, action: str) -> ScanJob:
        job = self.get(scan_id)
        if not job: raise KeyError(scan_id)
        if action == "pause" and job.status == "running": job.pause_event.set(); job.status = "paused"
        elif action == "resume" and job.status == "paused": job.pause_event.clear(); job.status = "running"
        elif action == "cancel" and job.status in ("queued", "running", "paused"): job.cancel_event.set(); job.pause_event.clear(); job.status = "cancelling"
        self.store.update_scan(job); return job

    def delete(self, scan_id: str) -> None:
        job = self.get(scan_id)
        if job and job.status not in ("completed", "cancelled", "failed", "interrupted"):
            raise ValueError("cannot delete an active scan; cancel it first")
        if not self.store.delete_scan(scan_id):
            raise KeyError(scan_id)
        with self.lock:
            self.jobs.pop(scan_id, None)

    def retry(self, scan_id: str) -> ScanJob:
        saved = self.store.scan(scan_id)
        if not saved:
            raise KeyError(scan_id)
        if saved.get("mode") == "enum":
            return self.create(
                saved["target"], "", saved["threads"], saved["timeout"],
                saved.get("preset", "custom"),
                enum={
                    "charset": saved["charset"], "min_len": saved["min_len"],
                    "max_len": saved["max_len"], "placeholder": saved["placeholder"],
                },
                target_type=saved.get("target_type", "web"),
                request_method=saved.get("request_method", "GET"),
                request_headers=json.loads(saved.get("request_headers") or "{}"),
                request_body=saved.get("request_body", ""),
            )
        return self.create(
            saved["target"], saved["dictionary"], saved["threads"], saved["timeout"],
            saved.get("preset", "custom"),
            target_type=saved.get("target_type", "web"),
            request_method=saved.get("request_method", "GET"),
            request_headers=json.loads(saved.get("request_headers") or "{}"),
            request_body=saved.get("request_body", ""),
        )


STORE = Store(DB_PATH); MANAGER = ScanManager(STORE)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *_: Any) -> None: pass
    def send_json(self, data: Any, status: int = 200) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode(); self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(raw))); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(raw)
    def do_OPTIONS(self) -> None:
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "Content-Type"); self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS"); self.end_headers()
    def body(self) -> dict[str, Any]:
        size = min(int(self.headers.get("Content-Length", "0")), 1_000_000); return json.loads(self.rfile.read(size) or b"{}")

    def send_events(self, scan_id: str, after_id: int) -> None:
        saved = MANAGER.get(scan_id)
        if not saved and not STORE.scan(scan_id):
            self.send_json({"error": "scan not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        cursor = max(0, after_id)
        last_signature: tuple[Any, ...] | None = None
        deadline = time.time() + 30
        terminal = {"completed", "cancelled", "failed", "interrupted"}
        try:
            while time.time() < deadline:
                job = MANAGER.get(scan_id)
                stored = STORE.scan(scan_id) if not job else None
                scan = job.public() if job else public_scan(stored or {})
                page = STORE.result_page(scan_id, after_id=cursor, limit=500)
                summary = STORE.result_summary(scan_id)
                signature = (
                    scan["status"], scan["requests"], scan["found"],
                    round(float(scan["progress"]), 4), summary["max_id"],
                )
                if signature != last_signature or page["results"]:
                    cursor = page["next_cursor"]
                    payload = {
                        "scan": scan, "results": page["results"], "cursor": cursor,
                        "has_more": page["has_more"], "summary": summary,
                    }
                    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                    self.wfile.write(f"event: snapshot\ndata: {raw}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    last_signature = signature
                if scan["status"] in terminal and cursor >= summary["max_id"]:
                    break
                time.sleep(.35)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.close_connection = True

    def do_GET(self) -> None:
        parsed = urlparse(self.path); parts = parsed.path.strip("/").split("/")
        try:
            if parsed.path == "/api/health": return self.send_json({"ok": True, "service": "seahare", "version": "2.0"})
            if parsed.path == "/api/presets": return self.send_json({"presets": [{"id": key, **value} for key, value in PRESETS.items()]})
            if parsed.path == "/api/dictionaries":
                items = dictionary_metadata()
                return self.send_json({"dictionaries": [item["name"] for item in items], "items": items})
            if parsed.path == "/api/scans": return self.send_json({"scans": STORE.list_scans()})
            if len(parts) >= 3 and parts[:2] == ["api", "scans"]:
                job = MANAGER.get(parts[2])
                if job:
                    saved = job.public()
                else:
                    stored = STORE.scan(parts[2])
                    saved = public_scan(stored) if stored else None
                if not saved: return self.send_json({"error": "scan not found"}, 404)
                if len(parts) == 3: return self.send_json(saved)
                query = parse_qs(parsed.query)
                if parts[3] == "results":
                    page = STORE.result_page(
                        parts[2], category=query.get("status", ["all"])[0],
                        severity=query.get("severity", ["all"])[0],
                        after_id=int(query.get("after_id", ["0"])[0]),
                        limit=int(query.get("limit", ["500"])[0]),
                    )
                    page["summary"] = STORE.result_summary(parts[2])
                    return self.send_json(page)
                if parts[3] == "summary": return self.send_json(STORE.result_summary(parts[2]))
                if parts[3] == "events":
                    return self.send_events(parts[2], int(query.get("after_id", ["0"])[0]))
                if parts[3] == "export.csv":
                    rows = STORE.results(parts[2]); output = io.StringIO(); fields = [
                        "path", "url", "request_method", "status", "severity", "category", "redirect_location",
                        "business_code", "business_message", "response_preview", "body_hash",
                        "spa_fallback", "length", "content_type", "response_time", "discovered_at",
                    ]; writer = csv.DictWriter(output, fieldnames=fields); writer.writeheader(); writer.writerows({key: row[key] for key in fields} for row in rows); raw = output.getvalue().encode(); self.send_response(200); self.send_header("Content-Type", "text/csv; charset=utf-8"); self.send_header("Content-Disposition", f"attachment; filename=seahare-{parts[2]}.csv"); self.send_header("Content-Length", str(len(raw))); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(raw); return
            self.send_json({"error": "not found"}, 404)
        except Exception as exc: self.send_json({"error": str(exc)}, 500)
    def do_POST(self) -> None:
        parsed = urlparse(self.path); parts = parsed.path.strip("/").split("/")
        try:
            if parsed.path == "/api/scans":
                payload = self.body()
                preset_id = str(payload.get("preset", "custom"))
                preset = PRESETS.get(preset_id, {})
                enum = payload.get("enum")
                if enum is not None:
                    job = MANAGER.create(
                        str(payload.get("target", "")), "",
                        int(payload.get("threads", preset.get("threads", 16))),
                        float(payload.get("timeout", preset.get("timeout", 8))),
                        preset_id, enum=enum,
                        target_type=payload.get("target_type", "web"),
                        request_method=payload.get("request_method", "GET"),
                        request_headers=payload.get("request_headers", {}),
                        request_body=payload.get("request_body", ""),
                    )
                else:
                    job = MANAGER.create(
                        str(payload.get("target", "")),
                        str(payload.get("dictionary") or preset.get("dictionary", "common.txt")),
                        int(payload.get("threads", preset.get("threads", 16))),
                        float(payload.get("timeout", preset.get("timeout", 8))),
                        preset_id,
                        target_type=payload.get("target_type", "web"),
                        request_method=payload.get("request_method", "GET"),
                        request_headers=payload.get("request_headers", {}),
                        request_body=payload.get("request_body", ""),
                    )
                return self.send_json(job.public(), 201)
            if parsed.path == "/api/dictionaries":
                payload = self.body(); name = str(payload.get("name", "")).strip(); content = str(payload.get("content", ""))
                safe_name = Path(name).name
                if safe_name != name or not safe_name.endswith(".txt") or not safe_name[:-4] or not all(ch.isalnum() or ch in "-_" for ch in safe_name[:-4]):
                    raise ValueError("dictionary name must use letters, numbers, dashes or underscores and end in .txt")
                if (DICTIONARY_DIR / safe_name).is_file():
                    raise ValueError("built-in dictionary cannot be replaced")
                if not content.strip(): raise ValueError("dictionary content cannot be empty")
                (CUSTOM_DICTIONARY_DIR / safe_name).write_text(content, encoding="utf-8")
                return self.send_json({"dictionary": next(item for item in dictionary_metadata() if item["name"] == safe_name)}, 201)
            if len(parts) == 4 and parts[:2] == ["api", "scans"] and parts[3] in ("pause", "resume", "cancel"):
                return self.send_json(MANAGER.action(parts[2], parts[3]).public())
            if len(parts) == 4 and parts[:2] == ["api", "scans"] and parts[3] == "retry":
                return self.send_json(MANAGER.retry(parts[2]).public(), 201)
            self.send_json({"error": "not found"}, 404)
        except KeyError: self.send_json({"error": "scan not found"}, 404)
        except ValueError as exc: self.send_json({"error": str(exc)}, 400)
        except Exception as exc: self.send_json({"error": str(exc)}, 500)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path); parts = parsed.path.strip("/").split("/")
        try:
            if len(parts) == 3 and parts[:2] == ["api", "scans"]:
                MANAGER.delete(parts[2])
                return self.send_json({"deleted": parts[2]})
            if len(parts) == 3 and parts[:2] == ["api", "dictionaries"]:
                name = unquote(parts[2]); safe_name = Path(name).name
                if safe_name != name: raise ValueError("invalid dictionary name")
                path = CUSTOM_DICTIONARY_DIR / safe_name
                if not path.is_file(): return self.send_json({"error": "custom dictionary not found"}, 404)
                path.unlink(); return self.send_json({"deleted": safe_name})
            self.send_json({"error": "not found"}, 404)
        except ValueError as exc: self.send_json({"error": str(exc)}, 400)
        except Exception as exc: self.send_json({"error": str(exc)}, 500)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler); print(f"Seahare backend listening on http://{HOST}:{PORT}", flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close(); STORE.close()


if __name__ == "__main__": main()
