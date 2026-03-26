import { spawnSync } from "child_process";
import path from "path";
import type { CpSatUnavailableDetail } from "./cpSatRuntime";
import { unavailableFromSpawnFailure } from "./cpSatRuntime";

export type CpSatRawResult =
  | {
      ok: true;
      status: number;
      status_name?: string;
      wall_ms?: number;
      ladder_stage?: number;
      grid?: number[][];
    }
  | {
      ok: false;
      reason: string;
      stderr?: string;
      /** Present for spawn / local runtime failures (e.g. ENOENT) */
      unavailable_detail?: CpSatUnavailableDetail;
    };

const CP_INFEASIBLE = 3;
const CP_OPTIMAL = 4;
const CP_MODEL_INVALID = 2;
const CP_FEASIBLE = 6;

export { CP_FEASIBLE, CP_INFEASIBLE, CP_MODEL_INVALID, CP_OPTIMAL };

function invokeCpSatLocalSync(
  payload: Record<string, unknown>,
  py: string
): CpSatRawResult {
  const scriptPath = path.join(process.cwd(), "scripts", "solve_schedule_cp_sat.py");
  const maxSec =
    typeof payload.max_seconds === "number" && Number.isFinite(payload.max_seconds as number)
      ? (payload.max_seconds as number)
      : 90;

  const res = spawnSync(py, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: maxSec * 1000 + 15_000,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  if (res.error) {
    const msg = res.error.message || String(res.error);
    return {
      ok: false,
      reason: `spawn: ${msg}`,
      unavailable_detail: unavailableFromSpawnFailure(py, msg),
    };
  }
  if (res.status !== 0) {
    const errOut = (res.stderr ?? "").trim() || (res.stdout ?? "").trim();
    return { ok: false, reason: `exit ${res.status}`, stderr: errOut.slice(0, 800) };
  }

  try {
    const parsed = JSON.parse(res.stdout ?? "{}") as {
      status: number;
      grid?: number[][];
      wall_ms?: number;
      status_name?: string;
      ladder_stage?: number;
    };
    return {
      ok: true,
      status: parsed.status,
      status_name: parsed.status_name,
      wall_ms: parsed.wall_ms,
      ladder_stage: parsed.ladder_stage,
      grid: parsed.grid,
    };
  } catch {
    return { ok: false, reason: "invalid JSON from CP-SAT" };
  }
}

async function invokeCpSatRemote(
  baseUrl: string,
  payload: Record<string, unknown>
): Promise<CpSatRawResult> {
  const maxSec =
    typeof payload.max_seconds === "number" && Number.isFinite(payload.max_seconds as number)
      ? (payload.max_seconds as number)
      : 90;
  const url = `${baseUrl.replace(/\/$/, "")}/solve`;
  const secret = process.env.SCHEDULER_CP_SOLVER_SECRET?.trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers,
      signal: AbortSignal.timeout((maxSec + 30) * 1000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail: CpSatUnavailableDetail | undefined;
      if (res.status >= 500 || res.status === 401 || res.status === 403) {
        detail = {
          code: "CP_SAT_RUNTIME_UNAVAILABLE",
          cause: "remote_unreachable",
          message: `CP-SAT remote solver returned HTTP ${res.status}.`,
          stderr_snippet: text.slice(0, 400),
          remediation: [
            "Verify SCHEDULER_CP_SOLVER_URL and SCHEDULER_CP_SOLVER_SECRET match the solver service.",
            "Check solver logs and docs/cp-sat-production.md.",
          ],
        };
      }
      return {
        ok: false,
        reason: `remote HTTP ${res.status}`,
        stderr: text.slice(0, 800),
        unavailable_detail: detail,
      };
    }
    const parsed = JSON.parse(text) as {
      status: number;
      grid?: number[][];
      wall_ms?: number;
      status_name?: string;
      ladder_stage?: number;
    };
    return {
      ok: true,
      status: parsed.status,
      status_name: parsed.status_name,
      wall_ms: parsed.wall_ms,
      ladder_stage: parsed.ladder_stage,
      grid: parsed.grid,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /abort|timeout/i.test(msg);
    if (isTimeout) {
      console.error(`[cp_sat:remote] Request timeout POST ${url}`);
    }
    return {
      ok: false,
      reason: `remote fetch: ${msg}`,
      unavailable_detail: {
        code: "CP_SAT_RUNTIME_UNAVAILABLE",
        cause: "remote_unreachable",
        message: isTimeout
          ? `CP-SAT remote solver request timed out: ${url}`
          : `Could not reach CP-SAT solver at ${url}: ${msg}`,
        remediation: [
          "Confirm SCHEDULER_CP_SOLVER_URL is reachable from the Node runtime (no localhost from Vercel).",
          "Use a public HTTPS URL or internal network URL your host can reach.",
          "See docs/cp-sat-production.md.",
        ],
      },
    };
  }
}

async function invokeCpSatVercelPython(
  baseUrl: string,
  payload: Record<string, unknown>
): Promise<CpSatRawResult> {
  const maxSec =
    typeof payload.max_seconds === "number" && Number.isFinite(payload.max_seconds as number)
      ? (payload.max_seconds as number)
      : 90;
  const url = `${baseUrl.replace(/\/$/, "")}/api/cp_sat_vercel/solve`;
  const secret = process.env.SCHEDULER_CP_VERCEL_PY_SECRET?.trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const bodyStr = JSON.stringify(payload);
  if (bodyStr.length > 4_400_000) {
    console.error(
      `[cp_sat:vercel_python] Payload too large for Vercel function (~${bodyStr.length} chars); shrink problem or use remote solver.`
    );
    return {
      ok: false,
      reason: "payload_too_large",
      unavailable_detail: {
        code: "CP_SAT_RUNTIME_UNAVAILABLE",
        cause: "vercel_python_error",
        message: "CP-SAT JSON payload is too large for the Vercel Python function limit (~4.5MB).",
        remediation: [
          "Reduce schedule size for PoC, or use SCHEDULER_CP_SOLVER_URL with a dedicated solver.",
          "See Vercel function body limits.",
        ],
      },
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      body: bodyStr,
      headers,
      signal: AbortSignal.timeout((maxSec + 35) * 1000),
    });
    const text = await res.text();

    if (res.status === 404) {
      console.error(
        "[cp_sat:vercel_python] POST /api/cp_sat_vercel/solve returned 404 — Python function not deployed or wrong route."
      );
      return {
        ok: false,
        reason: "vercel_python_not_deployed",
        stderr: text.slice(0, 400),
        unavailable_detail: {
          code: "CP_SAT_RUNTIME_UNAVAILABLE",
          cause: "vercel_python_unreachable",
          message: "Vercel Python CP-SAT endpoint not found (404). Deploy api/cp_sat_vercel/solve.py with requirements.txt.",
          stderr_snippet: text.slice(0, 400),
          remediation: [
            "Redeploy with api/cp_sat_vercel/solve.py and root requirements.txt (ortools).",
            "Confirm vercel.json includes Python function config.",
          ],
        },
      };
    }

    if (res.status === 413) {
      console.error("[cp_sat:vercel_python] Python function rejected payload (413 payload_too_large).");
      return {
        ok: false,
        reason: "payload_too_large",
        stderr: text.slice(0, 400),
        unavailable_detail: {
          code: "CP_SAT_RUNTIME_UNAVAILABLE",
          cause: "vercel_python_error",
          message: "Vercel Python solver rejected the body as too large (413).",
          stderr_snippet: text.slice(0, 400),
          remediation: ["Shrink the CP-SAT JSON payload or use a remote solver service."],
        },
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: `HTTP ${res.status}`,
        stderr: text.slice(0, 400),
        unavailable_detail: {
          code: "CP_SAT_RUNTIME_UNAVAILABLE",
          cause: "vercel_python_error",
          message: "Vercel Python solver rejected authorization. Set SCHEDULER_CP_VERCEL_PY_SECRET to match the function env.",
          remediation: [
            "Set SCHEDULER_CP_VERCEL_PY_SECRET in Vercel project env and on the Python runtime if required.",
          ],
        },
      };
    }

    if (!res.ok) {
      let parsed: { ok?: boolean; error?: string; code?: string; detail?: string } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        /* use text */
      }
      const detail = parsed.detail ?? parsed.error ?? text.slice(0, 300);
      if (parsed.code === "solver_exception") {
        console.error(`[cp_sat:vercel_python] Solver exception: ${detail}`);
      }
      return {
        ok: false,
        reason: `vercel_python HTTP ${res.status}`,
        stderr: text.slice(0, 800),
        unavailable_detail: {
          code: "CP_SAT_RUNTIME_UNAVAILABLE",
          cause: "vercel_python_error",
          message: `Vercel Python CP-SAT failed: ${detail}`,
          stderr_snippet: text.slice(0, 400),
          remediation: [
            "Check Vercel function logs for Python tracebacks.",
            "Verify ortools in requirements.txt and function memory (vercel.json).",
          ],
        },
      };
    }

    const parsed = JSON.parse(text) as {
      status: number;
      grid?: number[][];
      wall_ms?: number;
      status_name?: string;
      ladder_stage?: number;
    };
    return {
      ok: true,
      status: parsed.status,
      status_name: parsed.status_name,
      wall_ms: parsed.wall_ms,
      ladder_stage: parsed.ladder_stage,
      grid: parsed.grid,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /abort|timeout/i.test(msg);
    if (isTimeout) {
      console.error(`[cp_sat:vercel_python] Request timeout POST ${url}`);
    }
    return {
      ok: false,
      reason: `vercel_python fetch: ${msg}`,
      unavailable_detail: {
        code: "CP_SAT_RUNTIME_UNAVAILABLE",
        cause: isTimeout ? "vercel_python_error" : "vercel_python_unreachable",
        message: isTimeout
          ? `Vercel Python CP-SAT request timed out (${url}).`
          : `Could not call Vercel Python CP-SAT at ${url}: ${msg}`,
        remediation: [
          "Increase maxDuration in vercel.json for api/cp_sat_vercel/**/*.py",
          "Confirm deployment URL (VERCEL_URL / SCHEDULER_VERCEL_PYTHON_BASE_URL).",
        ],
      },
    };
  }
}

/**
 * Local subprocess only — used by feasibility ladder / probes / tests (no remote URL).
 * Prefer {@link invokeCpSatSolver} in production code paths that may use SCHEDULER_CP_SOLVER_URL.
 */
export function invokeCpSatSolverLocalSync(
  payload: Record<string, unknown>,
  py: string = process.env.PYTHON ?? "python3"
): CpSatRawResult {
  return invokeCpSatLocalSync(payload, py);
}

/**
 * Run CP-SAT: vercel_python (PoC), remote HTTP, or local python3 + script (sync subprocess).
 */
export async function invokeCpSatSolver(
  payload: Record<string, unknown>,
  opts: {
    mode: "local" | "remote" | "vercel_python";
    executable?: string;
    remote_base_url?: string;
    vercel_python_base_url?: string;
  }
): Promise<CpSatRawResult> {
  if (opts.mode === "vercel_python" && opts.vercel_python_base_url) {
    return invokeCpSatVercelPython(opts.vercel_python_base_url, payload);
  }
  if (opts.mode === "remote" && opts.remote_base_url) {
    return invokeCpSatRemote(opts.remote_base_url, payload);
  }
  const py = opts.executable ?? process.env.PYTHON ?? "python3";
  return invokeCpSatLocalSync(payload, py);
}
