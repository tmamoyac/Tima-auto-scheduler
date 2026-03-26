"""
Vercel Python Function — run CP-SAT from JSON body (PoC).

Route: POST /api/cp_sat_vercel/solve
Optional: Authorization: Bearer <SCHEDULER_CP_VERCEL_PY_SECRET> when that env var is set on the function.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

# ~4.5MB typical Vercel body ceiling; stay under for clear diagnostics
MAX_BODY_BYTES = 4_500_000


def _scripts_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", ".."))
    return os.path.join(root, "scripts")


def _json_body(handler: BaseHTTPRequestHandler, code: int, obj: dict) -> None:
    raw = json.dumps(obj).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


class handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))
        sys.stderr.flush()

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path not in ("/", "/solve"):
            self.send_error(404)
            return

        secret = os.environ.get("SCHEDULER_CP_VERCEL_PY_SECRET", "").strip()
        if secret:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {secret}":
                _json_body(self, 401, {"ok": False, "error": "unauthorized", "code": "unauthorized"})
                return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        if length > MAX_BODY_BYTES:
            print(
                f"[cp_sat_vercel:solve] payload too large: Content-Length={length} max={MAX_BODY_BYTES}",
                file=sys.stderr,
                flush=True,
            )
            _json_body(
                self,
                413,
                {
                    "ok": False,
                    "error": "payload_too_large",
                    "code": "payload_too_large",
                    "detail": f"Content-Length {length} exceeds max {MAX_BODY_BYTES} bytes",
                },
            )
            return

        body = self.rfile.read(length) if length > 0 else b"{}"

        try:
            data = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            _json_body(
                self,
                400,
                {"ok": False, "error": "invalid_json", "code": "invalid_json", "detail": str(e)},
            )
            return

        if not isinstance(data, dict):
            _json_body(self, 400, {"ok": False, "error": "expected_object", "code": "invalid_json"})
            return

        sys.path.insert(0, _scripts_dir())
        try:
            from cp_sat_solve_core import solve_cp_sat_from_dict

            out = solve_cp_sat_from_dict(data)
        except Exception as e:
            tb = traceback.format_exc()
            print(f"[cp_sat_vercel:solve] solver exception:\n{tb}", file=sys.stderr, flush=True)
            _json_body(
                self,
                500,
                {
                    "ok": False,
                    "error": "solver_exception",
                    "code": "solver_exception",
                    "detail": f"{type(e).__name__}: {e}",
                },
            )
            return

        raw = json.dumps(out).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
