import { spawnSync } from "child_process";
import path from "path";

export type CpSatRawResult =
  | {
      ok: true;
      status: number;
      status_name?: string;
      wall_ms?: number;
      ladder_stage?: number;
      grid?: number[][];
    }
  | { ok: false; reason: string; stderr?: string };

const CP_INFEASIBLE = 3;
const CP_OPTIMAL = 4;
const CP_MODEL_INVALID = 2;
const CP_FEASIBLE = 6;

export { CP_FEASIBLE, CP_INFEASIBLE, CP_MODEL_INVALID, CP_OPTIMAL };

/** Spawn Python CP-SAT once; no validation. */
export function invokeCpSatSolver(payload: Record<string, unknown>): CpSatRawResult {
  const scriptPath = path.join(process.cwd(), "scripts", "solve_schedule_cp_sat.py");
  const py = process.env.PYTHON ?? "python3";
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
    return { ok: false, reason: `spawn: ${res.error.message}` };
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
