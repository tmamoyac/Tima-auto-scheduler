"""
Vercel Python Function — CP-SAT / OR-Tools health (PoC).

Route: GET /api/cp_sat_vercel/health
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse


def _scripts_dir() -> str:
    import os

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", ".."))
    return os.path.join(root, "scripts")


class handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))
        sys.stderr.flush()

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path not in ("/", "/health"):
            self.send_error(404)
            return

        sys.path.insert(0, _scripts_dir())

        ortools_import_ok = False
        ortools_error: str | None = None
        try:
            from ortools.sat.python import cp_model  # noqa: F401

            ortools_import_ok = True
        except Exception as e:
            ortools_error = f"{type(e).__name__}: {e}"
            print(f"[cp_sat_vercel:health] OR-Tools import failed: {ortools_error}", file=sys.stderr, flush=True)

        body = {
            "ok": True,
            "service": "cp-sat-vercel-python-poc",
            "python_version": sys.version.split()[0],
            "ortools_import_ok": ortools_import_ok,
            "ortools_error": ortools_error,
        }
        raw = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
