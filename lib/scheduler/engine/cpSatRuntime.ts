import { spawnSync } from "child_process";

/** Stable API contract for 503 / generate failures when CP-SAT cannot run. */
export type CpSatUnavailableDetail = {
  code: "CP_SAT_RUNTIME_UNAVAILABLE";
  /** Machine-oriented subtype */
  cause:
    | "executable_not_found"
    | "ortools_import_failed"
    | "spawn_failed"
    | "remote_unreachable"
    | "vercel_python_not_configured"
    | "vercel_python_unreachable"
    | "vercel_python_error";
  /** Interpreter used for local mode (e.g. python3) */
  executable?: string;
  /** Node errno, e.g. ENOENT */
  os_error?: string;
  stderr_snippet?: string;
  message: string;
  remediation: string[];
};

export type CpSatCapabilities = {
  mode: "local" | "remote" | "vercel_python";
  /** False only for local mode when probe failed, or vercel_python when base URL missing / health bad */
  can_invoke: boolean;
  executable?: string;
  remote_base_url?: string;
  /** Absolute base URL used for GET/POST /api/cp_sat_vercel/* (no trailing slash) */
  vercel_python_base_url?: string;
  unavailable?: CpSatUnavailableDetail;
  probed_at_ms: number;
};

let cache: { cap: CpSatCapabilities; at: number } | null = null;
const CAP_CACHE_MS = 60_000;

function remediationForProd(): string[] {
  return [
    "Deploy a Python 3 runtime with OR-Tools on the same host as Node and set PYTHON=/path/to/python3 if needed, or",
    "Set SCHEDULER_CP_SOLVER_URL to a dedicated solver service (see docs/cp-sat-production.md), or",
    "For Vercel PoC: set SCHEDULER_CP_MODE=vercel_python and deploy with root requirements.txt + api/cp_sat_vercel/*.py, or",
    "Only as a last resort set SCHEDULER_ENGINE=heuristic (legacy search; not recommended for production quality).",
  ];
}

function buildLocalUnavailable(
  cause: "executable_not_found" | "ortools_import_failed" | "spawn_failed",
  py: string,
  opts: { os_error?: string; stderr?: string; message: string }
): CpSatUnavailableDetail {
  return {
    code: "CP_SAT_RUNTIME_UNAVAILABLE",
    cause,
    executable: py,
    os_error: opts.os_error,
    stderr_snippet: opts.stderr?.slice(0, 400),
    message: opts.message,
    remediation: remediationForProd(),
  };
}

/**
 * Base URL for same-deployment Vercel Python CP-SAT functions (server-side fetch).
 * Prefer VERCEL_URL; else SCHEDULER_VERCEL_PYTHON_BASE_URL; else NEXT_PUBLIC_APP_URL.
 */
export function resolveVercelPythonBaseUrl(): string | null {
  const explicit = process.env.SCHEDULER_VERCEL_PYTHON_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vu = process.env.VERCEL_URL?.trim();
  if (vu) return `https://${vu}`;
  const app = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (app) return app.replace(/\/$/, "");
  return null;
}

/**
 * Probe how CP-SAT can run: vercel_python (PoC), remote URL, or local python3 + OR-Tools.
 * Cached briefly to avoid repeated spawns per warm instance.
 */
export function getCpSatCapabilities(forceRefresh = false): CpSatCapabilities {
  if (!forceRefresh && cache && Date.now() - cache.at < CAP_CACHE_MS) {
    return cache.cap;
  }

  const cpMode = process.env.SCHEDULER_CP_MODE?.trim().toLowerCase();
  if (cpMode === "vercel_python") {
    const base = resolveVercelPythonBaseUrl();
    if (!base) {
      const cap: CpSatCapabilities = {
        mode: "vercel_python",
        can_invoke: false,
        unavailable: {
          code: "CP_SAT_RUNTIME_UNAVAILABLE",
          cause: "vercel_python_not_configured",
          message:
            "SCHEDULER_CP_MODE=vercel_python but no deployment base URL: set VERCEL_URL (automatic on Vercel), SCHEDULER_VERCEL_PYTHON_BASE_URL, or NEXT_PUBLIC_APP_URL.",
          remediation: [
            "On Vercel, VERCEL_URL is injected automatically — ensure this code runs in the Vercel runtime.",
            "Locally use `vercel dev` or set NEXT_PUBLIC_APP_URL=http://localhost:3000",
            "Or set SCHEDULER_VERCEL_PYTHON_BASE_URL=https://your-deployment.vercel.app",
          ],
        },
        probed_at_ms: Date.now(),
      };
      cache = { cap, at: Date.now() };
      return cap;
    }
    const cap: CpSatCapabilities = {
      mode: "vercel_python",
      can_invoke: true,
      vercel_python_base_url: base,
      probed_at_ms: Date.now(),
    };
    cache = { cap, at: Date.now() };
    return cap;
  }

  const remoteRaw = process.env.SCHEDULER_CP_SOLVER_URL?.trim();
  if (remoteRaw) {
    const cap: CpSatCapabilities = {
      mode: "remote",
      can_invoke: true,
      remote_base_url: remoteRaw.replace(/\/$/, ""),
      probed_at_ms: Date.now(),
    };
    cache = { cap, at: Date.now() };
    return cap;
  }

  const py = process.env.PYTHON ?? "python3";
  const r = spawnSync(py, ["-c", "import ortools.constraint_solver.pywrapcp"], {
    encoding: "utf-8",
    timeout: 12_000,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  let cap: CpSatCapabilities;

  if (r.error) {
    const err = r.error as NodeJS.ErrnoException;
    const cause: CpSatUnavailableDetail["cause"] =
      err.code === "ENOENT" ? "executable_not_found" : "spawn_failed";
    const message =
      cause === "executable_not_found"
        ? `CP-SAT runtime missing: cannot find Python interpreter "${py}" (ENOENT). Serverless hosts often omit Python from PATH.`
        : `CP-SAT runtime error spawning "${py}": ${err.message}`;
    cap = {
      mode: "local",
      can_invoke: false,
      executable: py,
      unavailable: buildLocalUnavailable(cause, py, {
        os_error: err.code,
        message,
      }),
      probed_at_ms: Date.now(),
    };
  } else if (r.status !== 0) {
    cap = {
      mode: "local",
      can_invoke: false,
      executable: py,
      unavailable: buildLocalUnavailable("ortools_import_failed", py, {
        stderr: r.stderr ?? undefined,
        message: `Python at "${py}" does not have OR-Tools installed (import failed). Run: ${py} -m pip install -r scripts/requirements-cp.txt`,
      }),
      probed_at_ms: Date.now(),
    };
  } else {
    cap = {
      mode: "local",
      can_invoke: true,
      executable: py,
      probed_at_ms: Date.now(),
    };
  }

  cache = { cap, at: Date.now() };
  return cap;
}

/** For tests / forcing a fresh probe after env changes */
export function clearCpSatCapabilitiesCache(): void {
  cache = null;
}

export function unavailableFromSpawnFailure(
  py: string,
  spawnMessage: string
): CpSatUnavailableDetail {
  const isENOENT = /ENOENT|enoent|not found/i.test(spawnMessage);
  return buildLocalUnavailable(isENOENT ? "executable_not_found" : "spawn_failed", py, {
    os_error: isENOENT ? "ENOENT" : undefined,
    message: `CP-SAT could not start: ${spawnMessage}`,
  });
}

/** Optional reachability check for remote solver (GET /health). */
export async function checkRemoteCpSatHealth(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/health`;
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type VercelPythonHealth = {
  ok: boolean;
  ortools_import_ok?: boolean;
  error?: string;
  http_status?: number;
};

/** GET /api/cp_sat_vercel/health — OR-Tools import probe inside the Python function. */
export async function checkVercelPythonCpSatHealth(baseUrl: string): Promise<VercelPythonHealth> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/cp_sat_vercel/health`;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(12_000) });
    const http_status = res.status;
    if (res.status === 404) {
      console.error(
        "[cp_sat:vercel_python] Python function not deployed or wrong path: GET /api/cp_sat_vercel/health returned 404."
      );
      return {
        ok: false,
        error: "Python function not deployed (404). Add api/cp_sat_vercel/health.py and root requirements.txt, then redeploy.",
        http_status,
      };
    }
    let body: { ortools_import_ok?: boolean; ortools_error?: string | null } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { ok: false, error: `Non-JSON response (HTTP ${res.status})`, http_status };
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, http_status };
    }
    if (body.ortools_import_ok !== true) {
      const detail = body.ortools_error ?? "ortools_import_ok is false";
      console.error(`[cp_sat:vercel_python] OR-Tools import failed inside Python function: ${detail}`);
      return {
        ok: false,
        ortools_import_ok: false,
        error: `OR-Tools not usable: ${detail}`,
        http_status,
      };
    }
    return { ok: true, ortools_import_ok: true, http_status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /abort|timeout/i.test(msg);
    console.error(
      `[cp_sat:vercel_python] Health request failed${isTimeout ? " (timeout)" : ""}: ${msg}`
    );
    return {
      ok: false,
      error: isTimeout ? `Request timeout reaching ${url}` : msg,
    };
  }
}
