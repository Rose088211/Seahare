import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import backend.server as server_module
from backend.server import Handler, ScanManager, Store


class TargetHandler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.server.request_paths.append(self.path)
        code = 301 if self.path == "/docs" else (200 if self.path in ("/admin", "/robots.txt") else 404)
        body = b"found" if code == 200 else b"missing"
        self.send_response(code)
        if code == 301: self.send_header("Location", "/admin")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


class EvidenceTargetHandler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        if self.path == "/":
            body = b"<html><body>app shell</body></html>"
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body)))
        elif self.path == "/same":
            body = b"<html><body>app shell</body></html>"
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body)))
        elif self.path == "/login":
            body = b'{"errno":502,"errmsg":"internal error"}'
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
        else:
            body = b"missing"; self.send_response(404); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)


class AutoMethodTargetHandler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def _record(self, method: str, status: int = 200):
        self.server.request_methods.append((method, self.path))
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if body:
            self.server.request_bodies.append((method, body, self.headers.get("Content-Type")))
        payload = b'{"ok":true}' if status == 200 else b"missing"
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(payload)

    def do_GET(self):
        self._record("GET", 404)

    def do_POST(self):
        self._record("POST")

    do_PUT = lambda self: self._record("PUT")
    do_PATCH = lambda self: self._record("PATCH")
    do_DELETE = lambda self: self._record("DELETE")
    do_HEAD = lambda self: self._record("HEAD")
    do_OPTIONS = lambda self: self._record("OPTIONS")


class BackendTests(unittest.TestCase):
    def test_development_dictionary_directory_is_separate(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            self.assertEqual(
                server_module.custom_dictionary_path(data_dir, data_dir / "dictionaries"),
                data_dir / "custom-dictionaries",
            )
            self.assertEqual(
                server_module.custom_dictionary_path(data_dir, data_dir / "builtin"),
                data_dir / "dictionaries",
            )

    def test_scan_lifecycle_and_persistence(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
        server.request_paths = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as folder:
                store = Store(Path(folder) / "test.db")
                try:
                    manager = ScanManager(store)
                    job = manager.create(f"http://127.0.0.1:{server.server_port}", "common.txt", 4, 2)
                    deadline = time.time() + 5
                    while job.status not in ("completed", "failed") and time.time() < deadline: time.sleep(.05)
                    self.assertEqual(job.status, "completed")
                    self.assertEqual(job.requests, 14)
                    self.assertEqual({row["path"] for row in store.results(job.id)}, {"/admin", "/docs", "/robots.txt"})
                    docs = next(row for row in store.results(job.id) if row["path"] == "/docs")
                    self.assertEqual(docs["redirect_location"], "/admin")
                    self.assertEqual(server.request_paths.count("/admin"), 1)
                    summary = store.result_summary(job.id)
                    self.assertEqual(summary["total"], 3)
                    self.assertEqual(summary["severity"]["high"], 1)
                    page = store.result_page(job.id, after_id=0, limit=1)
                    self.assertEqual(page["returned"], 1)
                    self.assertTrue(page["has_more"])
                    next_page = store.result_page(job.id, after_id=page["next_cursor"], limit=10)
                    self.assertEqual(next_page["returned"], 2)
                    self.assertEqual(store.scan(job.id)["status"], "completed")
                finally:
                    store.close()
        finally:
            server.shutdown(); server.server_close()

    def test_http_api_matches_frontend_contract(self):
        target = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
        target.request_paths = []
        threading.Thread(target=target.serve_forever, daemon=True).start()
        old_store, old_manager = server_module.STORE, server_module.MANAGER
        old_custom_dir = server_module.CUSTOM_DICTIONARY_DIR
        try:
            with tempfile.TemporaryDirectory() as folder:
                store = Store(Path(folder) / "api.db")
                server_module.CUSTOM_DICTIONARY_DIR = Path(folder) / "dictionaries"
                server_module.CUSTOM_DICTIONARY_DIR.mkdir()
                server_module.STORE = store
                server_module.MANAGER = ScanManager(store)
                api = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                threading.Thread(target=api.serve_forever, daemon=True).start()
                base = f"http://127.0.0.1:{api.server_port}"
                try:
                    health = self._json(f"{base}/api/health")
                    self.assertTrue(health["ok"])
                    self.assertEqual(health["version"], "2.0")
                    dictionaries = self._json(f"{base}/api/dictionaries")
                    self.assertIn("common.txt", dictionaries["dictionaries"])
                    self.assertTrue(dictionaries["items"][0]["entries"] > 0)
                    presets = self._json(f"{base}/api/presets")["presets"]
                    self.assertEqual({item["id"] for item in presets}, {"quick", "balanced", "careful"})

                    dictionary_request = Request(
                        f"{base}/api/dictionaries",
                        data=server_module.json.dumps({"name": "custom-api.txt", "content": "health\nmetrics\n"}).encode(),
                        headers={"Content-Type": "application/json"}, method="POST",
                    )
                    with urlopen(dictionary_request) as response:
                        self.assertEqual(response.status, 201)
                    self.assertIn("custom-api.txt", self._json(f"{base}/api/dictionaries")["dictionaries"])

                    payload = {
                        "target": f"http://127.0.0.1:{target.server_port}",
                        "dictionary": "common.txt", "threads": 4, "timeout": 2,
                    }
                    request = Request(
                        f"{base}/api/scans", data=server_module.json.dumps(payload).encode(),
                        headers={"Content-Type": "application/json"}, method="POST",
                    )
                    with urlopen(request) as response:
                        self.assertEqual(response.status, 201)
                        scan = server_module.json.load(response)

                    deadline = time.time() + 5
                    while scan["status"] not in ("completed", "failed") and time.time() < deadline:
                        time.sleep(.05)
                        scan = self._json(f"{base}/api/scans/{scan['id']}")
                    self.assertEqual(scan["status"], "completed")
                    self.assertEqual(scan["request_headers"], {})

                    results = self._json(f"{base}/api/scans/{scan['id']}/results?status=all")["results"]
                    self.assertEqual({row["path"] for row in results}, {"/admin", "/docs", "/robots.txt"})
                    self.assertEqual(next(row for row in results if row["path"] == "/admin")["severity"], "high")
                    self.assertEqual(next(row for row in results if row["path"] == "/docs")["redirect_location"], "/admin")
                    self.assertEqual(target.request_paths.count("/admin"), 1)
                    incremental = self._json(f"{base}/api/scans/{scan['id']}/results?after_id=0&limit=1")
                    self.assertEqual(incremental["returned"], 1)
                    self.assertTrue(incremental["has_more"])
                    self.assertEqual(incremental["summary"]["total"], 3)
                    with urlopen(f"{base}/api/scans/{scan['id']}/events?after_id=0", timeout=3) as response:
                        event_body = response.read().decode()
                    self.assertIn("event: snapshot", event_body)
                    self.assertIn('"summary":{"total":3', event_body)
                    self.assertIn(scan["id"], {row["id"] for row in self._json(f"{base}/api/scans")["scans"]})

                    retry_request = Request(f"{base}/api/scans/{scan['id']}/retry", data=b"{}", method="POST")
                    with urlopen(retry_request) as response:
                        self.assertEqual(response.status, 201)
                        retried = server_module.json.load(response)
                    self.assertNotEqual(retried["id"], scan["id"])
                    retry_deadline = time.time() + 5
                    while retried["status"] not in ("completed", "failed") and time.time() < retry_deadline:
                        time.sleep(.05)
                        retried = self._json(f"{base}/api/scans/{retried['id']}")
                    self.assertEqual(retried["status"], "completed")

                    with urlopen(f"{base}/api/scans/{scan['id']}/export.csv") as response:
                        csv_body = response.read().decode()
                        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
                    self.assertIn("path,url,request_method,status", csv_body)
                    self.assertIn("severity,category", csv_body)
                    self.assertIn("redirect_location", csv_body)
                    self.assertIn("/admin", csv_body)

                    delete_request = Request(f"{base}/api/dictionaries/custom-api.txt", method="DELETE")
                    with urlopen(delete_request) as response:
                        self.assertEqual(response.status, 200)
                    self.assertNotIn("custom-api.txt", self._json(f"{base}/api/dictionaries")["dictionaries"])
                finally:
                    api.shutdown(); api.server_close(); store.close()
        finally:
            server_module.STORE, server_module.MANAGER = old_store, old_manager
            server_module.CUSTOM_DICTIONARY_DIR = old_custom_dir
            target.shutdown(); target.server_close()

    def test_active_scans_are_recovered_as_interrupted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "recovery.db"
            store = Store(path)
            job = server_module.ScanJob("recovery", "http://example.test", "common.txt", 1, 2)
            job.status = "running"
            store.save_scan(job)
            store.close()

            reopened = Store(path)
            try:
                recovered = reopened.scan(job.id)
                self.assertEqual(recovered["status"], "interrupted")
                self.assertIn("exited", recovered["error"])
                self.assertIsNotNone(recovered["finished_at"])
            finally:
                reopened.close()

    def test_enumeration_scan_mode(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
        server.request_paths = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as folder:
                store = Store(Path(folder) / "enum.db")
                try:
                    manager = ScanManager(store)
                    job = manager.create(
                        f"http://127.0.0.1:{server.server_port}/{{fuzz}}", "", 4, 2,
                        enum={"charset": "ab", "min_len": 1, "max_len": 2},
                    )
                    self.assertEqual(job.mode, "enum")
                    deadline = time.time() + 5
                    while job.status not in ("completed", "failed") and time.time() < deadline:
                        time.sleep(.05)
                    self.assertEqual(job.status, "completed")
                    # a, b, aa, ab, ba, bb -> 6 requests, all 404 against TargetHandler
                    self.assertEqual(job.requests, 6)
                    self.assertEqual(set(store.results(job.id)), set())
                    for expected in ("/a", "/b", "/aa", "/ab", "/ba", "/bb"):
                        self.assertIn(expected, server.request_paths)
                    saved = store.scan(job.id)
                    self.assertEqual(saved["mode"], "enum")
                    self.assertEqual(saved["charset"], "ab")
                    self.assertEqual((saved["min_len"], saved["max_len"]), (1, 2))

                    with self.assertRaises(ValueError):
                        manager.create(f"http://127.0.0.1:{server.server_port}/{{fuzz}}", "", 4, 2,
                                       enum={"charset": "", "min_len": 1, "max_len": 1})
                    with self.assertRaises(ValueError):
                        manager.create(f"http://127.0.0.1:{server.server_port}/{{fuzz}}", "", 4, 2,
                                       enum={"charset": "ab", "min_len": 3, "max_len": 1})
                    with self.assertRaises(ValueError):
                        manager.create(f"http://127.0.0.1:{server.server_port}/", "", 4, 2,
                                       enum={"charset": "ab", "min_len": 1, "max_len": 1})
                    with self.assertRaises(ValueError):
                        manager.create(f"http://127.0.0.1:{server.server_port}/{{fuzz}}", "", 4, 2,
                                       enum={"charset": "a", "min_len": 1, "max_len": server_module.MAX_ENUM_LEN + 1})

                    retried = manager.retry(job.id)
                    self.assertEqual(retried.mode, "enum")
                    deadline = time.time() + 5
                    while retried.status not in ("completed", "failed") and time.time() < deadline:
                        time.sleep(.05)
                    self.assertEqual(retried.status, "completed")
                    self.assertEqual(retried.requests, 6)
                finally:
                    store.close()
        finally:
            server.shutdown(); server.server_close()

    def test_response_evidence_and_request_profile(self):
        target = ThreadingHTTPServer(("127.0.0.1", 0), EvidenceTargetHandler)
        threading.Thread(target=target.serve_forever, daemon=True).start()
        old_custom_dir = server_module.CUSTOM_DICTIONARY_DIR
        try:
            with tempfile.TemporaryDirectory() as folder:
                server_module.CUSTOM_DICTIONARY_DIR = Path(folder) / "dictionaries"
                server_module.CUSTOM_DICTIONARY_DIR.mkdir()
                (server_module.CUSTOM_DICTIONARY_DIR / "evidence.txt").write_text("login\nsame\n", encoding="utf-8")
                store = Store(Path(folder) / "evidence.db")
                try:
                    manager = ScanManager(store)
                    job = manager.create(
                        f"http://127.0.0.1:{target.server_port}", "evidence.txt", 2, 2,
                        target_type="api", request_method="GET", request_headers={"X-Test": "yes"},
                    )
                    deadline = time.time() + 5
                    while job.status not in ("completed", "failed") and time.time() < deadline: time.sleep(.05)
                    self.assertEqual(job.status, "completed")
                    saved = store.scan(job.id)
                    self.assertEqual(saved["target_type"], "api")
                    self.assertEqual(saved["request_method"], "GET")
                    self.assertEqual(server_module.json.loads(saved["request_headers"]), {"X-Test": "yes"})
                    rows = {row["path"]: row for row in store.results(job.id)}
                    self.assertEqual(rows["/login"]["business_code"], 502)
                    self.assertEqual(rows["/login"]["category"], "business_error")
                    self.assertEqual(rows["/login"]["business_message"], "internal error")
                    self.assertFalse(rows["/login"]["spa_fallback"])
                    self.assertTrue(rows["/same"]["spa_fallback"])
                    self.assertEqual(rows["/same"]["category"], "spa_fallback")
                    self.assertEqual(len(rows["/same"]["body_hash"]), 16)
                finally:
                    store.close()
        finally:
            server_module.CUSTOM_DICTIONARY_DIR = old_custom_dir
            target.shutdown(); target.server_close()

    def test_auto_request_method_tries_all_methods(self):
        target = ThreadingHTTPServer(("127.0.0.1", 0), AutoMethodTargetHandler)
        target.request_methods = []
        target.request_bodies = []
        threading.Thread(target=target.serve_forever, daemon=True).start()
        old_custom_dir = server_module.CUSTOM_DICTIONARY_DIR
        try:
            with tempfile.TemporaryDirectory() as folder:
                server_module.CUSTOM_DICTIONARY_DIR = Path(folder) / "dictionaries"
                server_module.CUSTOM_DICTIONARY_DIR.mkdir()
                (server_module.CUSTOM_DICTIONARY_DIR / "auto.txt").write_text("login\n", encoding="utf-8")
                store = Store(Path(folder) / "auto.db")
                try:
                    manager = ScanManager(store)
                    job = manager.create(
                        f"http://127.0.0.1:{target.server_port}", "auto.txt", 1, 2,
                        request_method="AUTO",
                    )
                    deadline = time.time() + 5
                    while job.status not in ("completed", "failed") and time.time() < deadline: time.sleep(.05)
                    self.assertEqual(job.status, "completed")
                    self.assertEqual(store.scan(job.id)["request_method"], "AUTO")
                    methods = [method for method, path in target.request_methods if path == "/login"]
                    self.assertEqual(methods, ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
                    self.assertEqual(job.requests, 7)
                    self.assertEqual(job.found, 6)
                    self.assertEqual(
                        {row["request_method"] for row in store.results(job.id)},
                        {"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"},
                    )
                    self.assertEqual(
                        {(method, body, content_type) for method, body, content_type in target.request_bodies},
                        {
                            (method, b'{"value":"login"}', "application/json")
                            for method in ("POST", "PUT", "PATCH", "DELETE")
                        },
                    )
                finally:
                    store.close()
        finally:
            server_module.CUSTOM_DICTIONARY_DIR = old_custom_dir
            target.shutdown(); target.server_close()

    def test_result_classification_survives_reopen(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "classification.db"
            store = Store(path)
            try:
                self.assertTrue(store.add_result("scan", {
                    "path": "/auth/login", "url": "http://target/auth/login", "status": 200,
                    "length": 43, "content_type": "application/json", "response_time": 1.0,
                    "business_code": 502, "business_message": "internal error",
                    "response_preview": '{"errno":502}', "body_hash": "bizhash",
                }))
                self.assertTrue(store.add_result("scan", {
                    "path": "/unknown", "url": "http://target/unknown", "status": 200,
                    "length": 24, "content_type": "text/html", "response_time": 1.0,
                    "response_preview": "<html>shell</html>", "body_hash": "spahash",
                    "spa_fallback": True,
                }))
            finally:
                store.close()

            reopened = Store(path)
            try:
                rows = {row["path"]: row for row in reopened.results("scan")}
                self.assertEqual(rows["/auth/login"]["category"], "business_error")
                self.assertEqual(rows["/auth/login"]["business_code"], 502)
                self.assertEqual(rows["/unknown"]["category"], "spa_fallback")
                self.assertTrue(rows["/unknown"]["spa_fallback"])
            finally:
                reopened.close()

    @staticmethod
    def _json(url):
        with urlopen(url) as response:
            return server_module.json.load(response)


if __name__ == "__main__": unittest.main()
