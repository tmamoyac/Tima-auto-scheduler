import { spawnSync } from "child_process";

/** Stable API contract for 503 / generate failures when CP-SAT cannot run. */
export type CpSatUnavailableDetail = {
  code: "CP_SAT_RUNTIME_UNAVAILABLE";
  /** Machine-oriented subtype */
  cause: "executable_not_found" | "ortools_import_failed" | "spawn_failed" | "remote_unreachable";
  /** Interpreter used for local mode (e.g. python3) */
  executable?: string;
  /** Node errno, e.g. ENOENT */
  os_error?: string;
  stderr_snippet?: string;
  message: string;
  remediation: string[];
};

export type CpSatCapabilities = {
  mode: "local" | "remote";
  /** False only for local mode when probe failed */
  can_invoke: boolean;
  executable?: string;
  remote_base_url?: string;
  unavailable?: CpSatUnavailableDetail;
  probed_at_ms: number;
};

let cache: { cap: CpSatCapabilities; at: number } | null = null;
const CAP_CACHE_MS = 60_000;

function remediationForProd(): string[] {
  return [
    "Deploy a Python 3 runtime with OR-Tools on the same host as Node and set PYTHON=/path/to/python3 if needed, or",
    "Set SCHEDULER_CP_SOLVER_URL to a dedicated solver service (see docs/cp-sat-production.md), or",
    "Only as a last resort set SCHEDULER_ENGINE=heuristic (legacy search; not recommended for production quality).",
  ];
}

function buildLocalUnavailable(
  cause: CpSatUnavailableDetail["cause"],
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
 * Probe how CP-SAT can run: remote URL (preferred for serverless) or local python3 + OR-Tools.
 * Cached briefly to avoid repeated spawns per warm instance.
 */
export function getCpSatCapabilities(forceRefresh = false): CpSatCapabilities {
  if (!forceRefresh && cache && Date.now() - cache.at < CAP_CACHE_MS) {
    return cache.cap;
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
