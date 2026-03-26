# CP-SAT in production

## Runtime reality

- **Vercel / AWS Lambda / many Node PaaS images** do not ship `python3` on `PATH`. Spawning `python3` returns **ENOENT**.
- The app defaults to **CP-SAT** (`SCHEDULER_ENGINE` unset or `cp_sat`). **Heuristic** (`SCHEDULER_ENGINE=heuristic`) is only an optional fallback, not a substitute for a proper solver deployment.

## Recommended architecture

1. **Preferred on serverless (e.g. Vercel):** run CP-SAT in a **separate Python service** (Fly.io, Railway, ECS, Cloud Run, a small VM). Set:
   - `SCHEDULER_CP_SOLVER_URL` — base URL, e.g. `https://cp-sat.yourdomain.com`
   - `SCHEDULER_CP_SOLVER_SECRET` — optional shared secret; sent as `Authorization: Bearer <secret>` to `POST /solve`
2. **Preferred on a single VM / Docker / Kubernetes** where you control the image: install **Python 3** and dependencies from `scripts/requirements-cp.txt`, ensure `python3` is on `PATH` (or set `PYTHON` to the interpreter path). No remote URL needed.

## Reference Python HTTP service

Repo includes `scripts/cp_solver_http_service.py`:

```bash
python3 -m pip install -r scripts/requirements-cp.txt
export CP_SOLVER_SECRET='your-long-random-secret'   # optional but recommended
python3 scripts/cp_solver_http_service.py
```

- `GET /health` — liveness
- `POST /solve` — body = same JSON the CLI script reads from stdin; response = solver JSON

Match Node env: `SCHEDULER_CP_SOLVER_SECRET` = `CP_SOLVER_SECRET`.

## Health checks

- **Dedicated:** `GET /api/scheduler/cp-sat-health` (requires same auth as other scheduler APIs) — returns `ok`, `cp_sat.mode`, `can_invoke`, and remote health when applicable. HTTP **503** when CP-SAT is not usable.
- **Bundled:** `GET /api/scheduler/check` includes a **CP-SAT runtime** step.

Example (session cookie / Bearer per your app):

```bash
curl -sS "https://YOUR_APP/api/scheduler/cp-sat-health" -H "Cookie: ..."
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `SCHEDULER_CP_SOLVER_URL` | Base URL of remote solver (omit for local `python3`) |
| `SCHEDULER_CP_SOLVER_SECRET` | Bearer token for remote `POST /solve` |
| `PYTHON` | Override interpreter for local mode (default `python3`) |
| `SCHEDULER_ENGINE=heuristic` | Last-resort legacy search only |

See `.env.example`.

## Generate API errors

When CP-SAT cannot run, `POST /api/scheduler/generate` may respond with **503** and JSON:

```json
{
  "error": "<human message>",
  "cp_sat_unavailable": {
    "code": "CP_SAT_RUNTIME_UNAVAILABLE",
    "cause": "executable_not_found | ortools_import_failed | spawn_failed | remote_unreachable",
    "executable": "python3",
    "os_error": "ENOENT",
    "message": "...",
    "remediation": ["..."]
  }
}
```
