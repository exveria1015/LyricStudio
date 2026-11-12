#!/usr/bin/env python3
"""Loopback-only, dependency-minimal reading observations and optional static UI.

No input is logged or sent to another service. Each POST runs only the requested
lookup or split mode; scheduling and accepting candidates belong to the client.
"""

from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
import json
import mimetypes
from pathlib import Path
import socket
import sys
import threading
import time
from typing import Any
from urllib.parse import unquote, urlsplit


SERVICE_ID = "lyrics-studio-readings"
ENGINE_VERSION = "0.7.0"
DICTIONARY_VERSION = "20261015"
MAX_BODY_BYTES = 16 * 1024
MAX_TEXT_UTF16 = 1024
MAX_EXACT_ENTRIES = 128
LOOPBACK_NAMES = {"127.0.0.1", "localhost", "::1"}


class InvalidRequest(ValueError):
    """A safe error code, never containing input text."""


def utf16_offsets(text: str) -> list[int]:
    """Map Python code-point boundaries to JavaScript string boundaries."""
    offsets = [0]
    for character in text:
        code = ord(character)
        if 0xD800 <= code <= 0xDFFF:
            raise InvalidRequest("invalid_unicode")
        offsets.append(offsets[-1] + (2 if code > 0xFFFF else 1))
    return offsets


def validate_observation(payload: Any) -> tuple[str, str, str]:
    if not isinstance(payload, dict) or set(payload) - {"kind", "text", "mode"}:
        raise InvalidRequest("invalid_request")
    kind, text, mode = payload.get("kind"), payload.get("text"), payload.get("mode", "C")
    if kind not in ("exact", "context") or not isinstance(text, str):
        raise InvalidRequest("invalid_request")
    if not text or "\0" in text or utf16_offsets(text)[-1] > MAX_TEXT_UTF16:
        raise InvalidRequest("invalid_text_length")
    if mode not in ("A", "B", "C") or (kind == "exact" and "mode" in payload):
        raise InvalidRequest("invalid_mode")
    return kind, text, mode


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidRequest("duplicate_json_key")
        result[key] = value
    return result


class SudachiProvider:
    def __init__(self) -> None:
        from sudachipy import Dictionary, SplitMode

        engine_version = version("SudachiPy")
        dictionary_version = version("SudachiDict-full")
        if (engine_version, dictionary_version) != (ENGINE_VERSION, DICTIONARY_VERSION):
            raise RuntimeError("dependency_version_mismatch")
        self.metadata = {
            "id": "sudachi-full",
            "edition": "full",
            "version": f"full-{dictionary_version}+sudachipy-{engine_version}",
            "engineVersion": engine_version,
            "dictionaryVersion": dictionary_version,
        }
        # Explicit Full prevents silently using the default Core dictionary.
        self.dictionary = Dictionary(dict="full")
        self.tokenizer = self.dictionary.tokenizer()
        self.modes = {"A": SplitMode.A, "B": SplitMode.B, "C": SplitMode.C}
        self.lock = threading.Lock()

    def entry(self, morpheme: Any, surface: str | None = None) -> dict[str, Any]:
        dictionary_id, word_id = morpheme.dictionary_id(), morpheme.word_id()
        is_oov = morpheme.is_oov()
        result = {
            "surface": morpheme.surface() if surface is None else surface,
            "reading": morpheme.reading_form(),
            "normalizedForm": morpheme.normalized_form(),
            "dictionaryForm": morpheme.dictionary_form(),
            "partOfSpeech": list(morpheme.part_of_speech()),
            "dictionaryId": dictionary_id,
            "wordId": word_id,
            "isOov": is_oov,
        }
        identity = f"{self.metadata['version']}:{dictionary_id}:{word_id}"
        if is_oov:
            # OOV word IDs describe a category, not a unique dictionary entry.
            digest = hashlib.sha256(json.dumps(result, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]
            identity += f":oov:{digest}"
        return {"id": identity, **result}

    def observe(self, payload: Any) -> dict[str, Any]:
        kind, text, mode = validate_observation(payload)
        started = time.perf_counter()
        entries, tokens, notes = [], [], []
        truncated = False
        with self.lock:
            if kind == "exact":
                matches = self.dictionary.lookup(text)
                truncated = len(matches) > MAX_EXACT_ENTRIES
                entries = [self.entry(matches[index]) for index in range(min(len(matches), MAX_EXACT_ENTRIES))]
                # lookup normalizes its query and excludes unindexed entries.
                # The client must compare surfaces before claiming literal equality.
                notes.append("lookup_indexed_entries_only")
                if any(entry["surface"] != text for entry in entries):
                    notes.append("lookup_input_normalized")
                if truncated:
                    notes.append("exact_entry_limit_128")
            else:
                offsets = utf16_offsets(text)
                previous_end = 0
                for morpheme in self.tokenizer.tokenize(text, self.modes[mode]):
                    begin, end = morpheme.begin(), morpheme.end()
                    if not 0 <= previous_end == begin < end <= len(text):
                        raise RuntimeError("token_alignment_failed")
                    surface = morpheme.raw_surface()
                    if surface != text[begin:end]:
                        raise RuntimeError("token_surface_mismatch")
                    tokens.append({**self.entry(morpheme, surface), "from": offsets[begin], "to": offsets[end]})
                    previous_end = end
                if previous_end != len(text):
                    raise RuntimeError("token_coverage_failed")
        return {
            "provider": self.metadata,
            "entries": entries,
            "tokens": tokens,
            "elapsedMs": round((time.perf_counter() - started) * 1000, 3),
            "truncated": truncated,
            "notes": notes,
        }


def is_loopback_authority(authority: str, *, origin: bool = False) -> bool:
    try:
        parsed = urlsplit(authority if origin else "//" + authority)
        if parsed.hostname not in LOOPBACK_NAMES or parsed.username or parsed.password:
            return False
        if origin and parsed.scheme not in ("http", "https"):
            return False
        if parsed.path or parsed.query or parsed.fragment:
            return False
        # Evaluating .port rejects malformed or out-of-range ports.
        return parsed.port is None or 1 <= parsed.port <= 65535
    except ValueError:
        return False


class ReadingServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, provider: SudachiProvider | None, static_dir: Path | None = None):
        self.provider = provider
        self.static_dir = static_dir.resolve() if static_dir else None
        super().__init__(("127.0.0.1", port), ReadingHandler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Default http.server tracebacks could include user input in exceptions.
        print("Reading service request failed.", file=sys.stderr)


class ReadingHandler(BaseHTTPRequestHandler):
    server: ReadingServer
    server_version = "LyricsStudioLocal"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format: str, *args: Any) -> None:
        # No request URL, source text, or document information is logged.
        pass

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self.respond(code, {"error": "request_rejected"})

    def end_headers(self) -> None:
        # Host/Origin checks do not stop cross-origin iframe navigations. The
        # editing UI must never be operated through another page's overlay.
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def respond(self, status: int, payload: dict[str, Any], *, head: bool = False) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def permitted(self) -> bool:
        hosts = self.headers.get_all("Host", [])
        origins = self.headers.get_all("Origin", [])
        if len(hosts) != 1 or not is_loopback_authority(hosts[0]):
            self.respond(403, {"error": "host_not_allowed"})
            return False
        if origins and (len(origins) != 1 or not is_loopback_authority(origins[0], origin=True)):
            self.respond(403, {"error": "origin_not_allowed"})
            return False
        if not self.path.startswith("/") or self.path.startswith("//"):
            self.respond(400, {"error": "invalid_path"})
            return False
        return True

    def do_GET(self) -> None:
        self.get_or_head()

    def do_HEAD(self) -> None:
        self.get_or_head(head=True)

    def get_or_head(self, *, head: bool = False) -> None:
        if not self.permitted():
            return
        path = urlsplit(self.path).path
        if path == "/api/readings/health":
            provider = self.server.provider
            self.respond(200 if provider else 503, {
                "service": SERVICE_ID,
                "available": provider is not None,
                "provider": provider.metadata if provider else None,
                **({} if provider else {"error": "dictionary_unavailable"}),
            }, head=head)
        elif path.startswith("/api/") or path == "/api":
            status = 405 if path == "/api/readings/observe" else 404
            self.respond(status, {"error": "method_not_allowed" if status == 405 else "not_found"}, head=head)
        else:
            self.serve_static(path, head=head)

    def serve_static(self, path: str, *, head: bool) -> None:
        root = self.server.static_dir
        if root is None:
            self.respond(404, {"error": "not_found"}, head=head)
            return
        try:
            decoded = unquote(path, errors="strict")
            if "\0" in decoded or "\\" in decoded or ".." in Path(decoded).parts:
                raise ValueError("invalid_path")
            target = (root / decoded.lstrip("/")).resolve()
            if not target.is_relative_to(root):
                raise ValueError("invalid_path")
            if target.is_dir():
                target = target / "index.html"
            if not target.is_file() and not Path(decoded).suffix:
                target = root / "index.html"
            target = target.resolve()
            if not target.is_relative_to(root):
                raise ValueError("invalid_path")
            if not target.is_file():
                self.respond(404, {"error": "not_found"}, head=head)
                return
            data = target.read_bytes()
        except (ValueError, UnicodeError, OSError):
            self.respond(404, {"error": "not_found"}, head=head)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js":
            content_type = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def do_POST(self) -> None:
        if not self.permitted():
            return
        if urlsplit(self.path).path != "/api/readings/observe":
            self.respond(404, {"error": "not_found"})
            return
        if self.headers.get_content_type() != "application/json":
            self.respond(415, {"error": "json_required"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            self.respond(411, {"error": "content_length_required"})
            return
        if len(lengths[0]) > 10:
            self.respond(413, {"error": "request_too_large"})
            return
        length = int(lengths[0])
        if length > MAX_BODY_BYTES:
            self.respond(413, {"error": "request_too_large"})
            return
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise InvalidRequest("incomplete_request")
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
            validate_observation(payload)
        except (ValueError, UnicodeError, RecursionError) as error:
            self.respond(400, {"error": str(error) if isinstance(error, InvalidRequest) else "invalid_json"})
            return
        except (socket.timeout, OSError):
            self.respond(408, {"error": "request_timeout"})
            return
        provider = self.server.provider
        if provider is None:
            self.respond(503, {"error": "dictionary_unavailable"})
            return
        try:
            result = provider.observe(payload)
        except Exception:
            self.respond(500, {"error": "observation_failed"})
            return
        self.respond(200, result)

    def do_OPTIONS(self) -> None:
        self.respond(405, {"error": "method_not_allowed"})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--static", type=Path, help="Serve the built UI from this directory.")
    parser.add_argument("--check", action="store_true", help="Verify the pinned Full dictionary and exit.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if args.static and not (args.static / "index.html").is_file():
        parser.error("static directory must contain index.html")
    try:
        provider = SudachiProvider()
    except Exception:
        provider = None
    if args.check:
        print(json.dumps({"service": SERVICE_ID, "available": provider is not None, "provider": provider.metadata if provider else None}))
        return 0 if provider else 1
    try:
        server = ReadingServer(args.port, provider, args.static)
    except OSError:
        print("Cannot bind the local reading service port.", file=sys.stderr)
        return 1
    print(f"Lyrics Studio local service: http://127.0.0.1:{args.port}", flush=True)
    if provider is None:
        print("Sudachi Full is unavailable. Run npm run setup:readings.", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
