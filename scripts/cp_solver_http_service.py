#!/usr/bin/env python3
"""
HTTP wrapper for solve_schedule_cp_sat.py — run on a Python-capable host (Fly.io, Railway, ECS, VM).

Endpoints:
  GET  /health  — { "ok": true, "service": "cp-sat-solver" }
  POST /solve   — same JSON body as stdin to solve_schedule_cp_sat.py; response = solver JSON stdout

Env:
  CP_SOLVER_SECRET — if set, require Authorization: Bearer <secret>
  PORT             — listen port (Render injects this; default 10000 for local)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(DIR, "solve_schedule_cp_sat.py")
SECRET = os.environ.get("CP_SOLVER_SECRET", "").strip()


def _json_response(handler: BaseHTTPRequestHandler, code: int, obj: dict) -> None:
    b = json.dumps(obj).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(b)))
    handler.end_headers()
    handler.wfile.write(b)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def _auth_ok(self) -> bool:
        if not SECRET:
            return True
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {SECRET}"

    def do_GET(self) -> None:
        p = urlparse(self.path).path
        if p in ("/health", "/"):
            _json_response(self, 200, {"ok": True, "service": "cp-sat-solver"})
            return
        self.send_error(404)

    def do_POST(self) -> None:
        p = urlparse(self.path).path
        if p not in ("/solve", "/"):
            self.send_error(404)
            return
        if not self._auth_ok():
            _json_response(self, 401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length > 0 else b"{}"
        max_sec = 120
        try:
            data = json.loads(body.decode("utf-8"))
            max_sec = int(float(data.get("max_seconds", 90))) + 25
        except (json.JSONDecodeError, ValueError, TypeError):
            max_sec = 115
        try:
            proc = subprocess.run(
                [sys.executable, SCRIPT],
                input=body,
                capture_output=True,
                timeout=max_sec,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
        except subprocess.TimeoutExpired:
            _json_response(self, 504, {"ok": False, "error": "solver_timeout"})
            return
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="replace")[:2000]
            _json_response(self, 500, {"ok": False, "error": "solver_failed", "detail": err})
            return
        try:
            out = proc.stdout.decode("utf-8")
            json.loads(out)  # validate
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            _json_response(self, 500, {"ok": False, "error": "invalid_solver_output", "detail": str(e)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        raw = proc.stdout
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> None:
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "10000"))
    _log("cp-sat Python HTTP service starting")
    _log(f"  bind host: {host}")
    _log(f"  bind port: {port} (from $PORT, default 10000)")
    httpd = HTTPServer((host, port), Handler)
    _log("  routes ready: GET /health, POST /solve")
    _log(f"  listening on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
