"""Integration checks use the real, pinned Full dictionary, never a fixture lexicon."""

from concurrent.futures import ThreadPoolExecutor
import contextlib
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest

from backend.server import (
    DICTIONARY_VERSION,
    ENGINE_VERSION,
    InvalidRequest,
    ReadingServer,
    SudachiProvider,
    is_loopback_authority,
    utf16_offsets,
    validate_observation,
)


class ReadingBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.provider = SudachiProvider()
        cls.temp = tempfile.TemporaryDirectory(prefix="lyrics-backend-test-")
        cls.root = Path(cls.temp.name)
        cls.static = cls.root / "dist"
        cls.static.mkdir()
        (cls.static / "index.html").write_text("<!doctype html><title>Fixture</title>")
        (cls.static / "app.js").write_text("export const fixture = true")
        (cls.root / "private.txt").write_text("outside static root")
        cls.server = ReadingServer(0, cls.provider, cls.static)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method="POST", path="/api/readings/observe", payload=None, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            if raw is None and payload is not None:
                raw = json.dumps(payload, ensure_ascii=False).encode()
            request_headers = {"Content-Type": "application/json", **(headers or {})}
            connection.request(method, path, raw, request_headers)
            response = connection.getresponse()
            body = response.read()
            return response.status, dict(response.getheaders()), body
        finally:
            connection.close()

    def observe(self, payload):
        status, headers, body = self.request(payload=payload)
        self.assertEqual(status, 200, body)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        return json.loads(body)

    def test_health_identifies_actual_full_dictionary(self):
        status, _, body = self.request("GET", "/api/readings/health")
        health = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(health["service"], "lyrics-studio-readings")
        self.assertTrue(health["available"])
        self.assertEqual(health["provider"]["edition"], "full")
        self.assertEqual(health["provider"]["engineVersion"], ENGINE_VERSION)
        self.assertEqual(health["provider"]["dictionaryVersion"], DICTIONARY_VERSION)

    def test_exact_lookup_keeps_distinct_real_readings_and_ids(self):
        response = self.observe({"kind": "exact", "text": "明日"})
        entries = response["entries"]
        self.assertEqual({entry["reading"] for entry in entries}, {"アス", "アシタ", "ミョウニチ"})
        self.assertEqual(len({entry["id"] for entry in entries}), 3)
        self.assertTrue(all(entry["surface"] == "明日" and entry["dictionaryId"] == 0 and not entry["isOov"] for entry in entries))
        self.assertEqual(response["tokens"], [])
        self.assertFalse(response["truncated"])
        self.assertGreaterEqual(response["elapsedMs"], 0)

    def test_context_exposes_conjugated_kana_anchor(self):
        response = self.observe({"kind": "context", "text": "届かない", "mode": "A"})
        first, second = response["tokens"]
        self.assertEqual((first["surface"], first["reading"], first["dictionaryForm"], first["from"], first["to"]), ("届か", "トドカ", "届く", 0, 2))
        self.assertEqual(second["surface"], "ない")
        self.assertEqual(response["entries"], [])

    def test_modes_are_separate_observations(self):
        results = {}
        for mode in "ABC":
            result = self.observe({"kind": "context", "text": "国家公務員", "mode": mode})
            results[mode] = [token["surface"] for token in result["tokens"]]
        self.assertEqual(results, {"A": ["国家", "公務", "員"], "B": ["国家", "公務員"], "C": ["国家公務員"]})

    def test_offsets_are_utf16_and_raw_surface_is_exact(self):
        for text in ("𠮷野😀届かない", "ＡＢＣが届く", "  明日\tへ\n届かない", "か\u3099く"):
            response = self.observe({"kind": "context", "text": text, "mode": "A"})
            encoded = text.encode("utf-16-le")
            previous_end = 0
            for token in response["tokens"]:
                self.assertEqual(token["from"], previous_end)
                self.assertEqual(encoded[token["from"] * 2: token["to"] * 2].decode("utf-16-le"), token["surface"])
                previous_end = token["to"]
            self.assertEqual(previous_end, len(encoded) // 2)
        response = self.observe({"kind": "context", "text": "𠮷届かない", "mode": "A"})
        self.assertEqual(response["tokens"][0]["to"], 2)

    def test_oov_is_explicit_and_identity_does_not_alias_category(self):
        first = self.observe({"kind": "context", "text": "𠮷", "mode": "C"})["tokens"][0]
        second = self.observe({"kind": "context", "text": "𠮷𠮷", "mode": "C"})["tokens"][0]
        self.assertTrue(first["isOov"])
        self.assertEqual(first["dictionaryId"], -1)
        self.assertNotEqual(first["id"], second["id"])

    def test_normalization_is_exposed_not_claimed_literal(self):
        response = self.observe({"kind": "exact", "text": "ＡＢＣ"})
        self.assertIn("lookup_input_normalized", response["notes"])
        self.assertTrue(all(entry["surface"] == "abc" for entry in response["entries"]))

    def test_empty_exact_result_is_not_fabricated(self):
        response = self.observe({"kind": "exact", "text": "届かない"})
        self.assertEqual(response["entries"], [])

    def test_exact_limit_is_explicit(self):
        provider = SudachiProvider()
        real_dictionary = provider.dictionary
        # Only cardinality control is synthetic; values are real dictionary entries.
        matches = real_dictionary.lookup("明日")
        provider.dictionary = SimpleNamespace(lookup=lambda _text: [matches[0]] * 129)
        response = provider.observe({"kind": "exact", "text": "明日"})
        self.assertEqual(len(response["entries"]), 128)
        self.assertTrue(response["truncated"])
        self.assertIn("exact_entry_limit_128", response["notes"])

    def test_concurrent_requests_keep_observations_independent(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda mode: self.observe({"kind": "context", "text": "国家公務員", "mode": mode}), "ABCABC"))
        self.assertEqual([len(result["tokens"]) for result in results], [3, 2, 1, 3, 2, 1])

    def test_validation_checks_utf16_not_python_length(self):
        self.assertEqual(utf16_offsets("𠮷あ😀"), [0, 2, 3, 5])
        validate_observation({"kind": "exact", "text": "あ" * 1024})
        validate_observation({"kind": "exact", "text": "😀" * 512})
        for text in ("あ" * 1025, "😀" * 513, "", "\ud800", "\0"):
            with self.assertRaises(InvalidRequest):
                validate_observation({"kind": "exact", "text": text})

    def test_bad_payloads_have_no_input_in_error(self):
        private = "synthetic-private-input"
        for payload in ([private], {"kind": private, "text": "明日"}, {"kind": "context", "text": private, "mode": []}, {"kind": "exact", "text": private, "mode": "A"}, {"kind": "exact", "text": 123}, {"kind": "exact", "text": private, "extra": True}):
            status, _, body = self.request(payload=payload)
            self.assertEqual(status, 400)
            self.assertNotIn(private.encode(), body)

    def test_rejects_bad_json_duplicate_fields_and_wrong_content_type(self):
        for raw in (b"{not json", b'{"kind":"exact","kind":"context","text":"a"}', b"\xff", b'"\\ud800"'):
            self.assertEqual(self.request(raw=raw)[0], 400)
        self.assertEqual(self.request(raw=b"{}", headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request(raw=b" " * 16385)[0], 413)

    def test_origin_host_and_preflight_restrictions(self):
        for origin in ("https://example.com", "null", "http://localhost.evil.test", "http://localhost@evil.test"):
            self.assertEqual(self.request(payload={"kind": "exact", "text": "明日"}, headers={"Origin": origin})[0], 403)
        self.assertEqual(self.request(payload={"kind": "exact", "text": "明日"}, headers={"Origin": "http://localhost:5173"})[0], 200)
        self.assertEqual(self.request("GET", "/api/readings/health", headers={"Host": "evil.test"})[0], 403)
        self.assertEqual(self.request("OPTIONS")[0], 405)
        self.assertFalse(is_loopback_authority("localhost:999999"))

    def test_static_content_api_failures_and_traversal(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Fixture", body)
        self.assertEqual(headers["Cache-Control"], "no-cache")
        status, headers, _ = self.request("GET", "/app.js")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/javascript")
        for path in ("/../private.txt", "/%2e%2e/private.txt", "/%5c..%5cprivate.txt", "/missing.js", "/api/unknown", "/api/readings/observe"):
            status, headers, body = self.request("GET", path)
            self.assertIn(status, (404, 405), path)
            self.assertIn("application/json", headers["Content-Type"])
            self.assertNotIn(b"outside static root", body)
            self.assertNotIn(b"Fixture", body)

    def test_all_responses_prevent_framing(self):
        for method, path in (("GET", "/"), ("HEAD", "/"), ("GET", "/api/readings/health"), ("GET", "/missing.js"), ("OPTIONS", "/api/readings/observe")):
            with self.subTest(method=method, path=path):
                _, headers, _ = self.request(method, path)
                self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
                self.assertEqual(headers["X-Frame-Options"], "DENY")

    def test_static_symlinks_cannot_escape_root(self):
        # Windows normally requires Developer Mode or elevated privileges for
        # symlinks. Only this check is skipped; all other HTTP tests still run.
        try:
            (self.static / "link.txt").symlink_to(self.root / "private.txt")
            (self.static / "nested").mkdir()
            (self.static / "nested" / "index.html").symlink_to(self.root / "private.txt")
        except OSError as error:
            if getattr(error, "winerror", None) == 1314:
                self.skipTest("Windows symlink privilege is unavailable")
            raise
        for path in ("/link.txt", "/nested/"):
            status, headers, body = self.request("GET", path)
            self.assertEqual(status, 404)
            self.assertIn("application/json", headers["Content-Type"])
            self.assertNotIn(b"outside static root", body)
            self.assertNotIn(b"Fixture", body)

    def test_no_request_or_source_logs(self):
        log = io.StringIO()
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            self.observe({"kind": "context", "text": "秘密の歌詞", "mode": "A"})
        self.assertEqual(log.getvalue(), "")

    def test_unavailable_engine_returns_json_and_never_static_html(self):
        server = ReadingServer(0, None, self.static)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        previous = self.port
        self.port = server.server_address[1]
        try:
            status, _, body = self.request("GET", "/api/readings/health")
            self.assertEqual(status, 503)
            self.assertFalse(json.loads(body)["available"])
            self.assertEqual(self.request(payload={"kind": "exact", "text": "明日"})[0], 503)
        finally:
            self.port = previous
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
