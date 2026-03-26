import path from "path";
import type { FeasibilityReport } from "../scheduleClientShare";
import {
  buildAuditForAssignmentRows,
  buildFeasibilityReport,
  type LoadedSchedulerStaticData,
} from "../generateSchedule";
import { buildCpSatJsonPayload, gridToAssignmentRows, readCpSatHardFlagsFromEnv } from "./buildCpSatPayload";
import { CP_INFEASIBLE, CP_MODEL_INVALID, invokeCpSatSolver } from "./cpSatInvoke";
import { debugLog } from "./debug";
import { buildInfeasibilityDiagnostics } from "./feasibilityDiagnostics";
import { formatFeasibilityLadderReport, runFeasibilityLadder } from "./feasibilityLadder";
import { normalizeSchedulerInput } from "./normalizeInput";
import type { CpSatGenerateResult } from "./types";
import { formatValidationReport, validateSchedule } from "./validateSchedule";
import type { SolveFeasibilityDebug } from "./types";
import { getFirstFixedProhibitedVacationOverlapError } from "./fixedVacationOverlapCheck";

function buildCpSatInfeasibilityReport(): FeasibilityReport {
  return {
    summary:
      "CP-SAT proved there is no assignment satisfying the current hard model (see ladder + diagnostics logs for which constraint group; check SCHEDULER_REQ_MODE=minimum vs exact and B2B flags).",
    suggestions: [
      "Run: npm run debug:scheduler-ladder (with SCHEDULER_STATIC_JSON pointing at exported setup JSON).",
      "Try SCHEDULER_REQ_MODE=minimum if min_months_required was modeled as exact.",
      "Try SCHEDULER_B2B_HARD=0 to treat spacing as soft and confirm B2B was the bottleneck.",
      "Try SCHEDULER_CP_HARD_STRENUOUS_B2B=0 / SCHEDULER_CP_HARD_TRANSPLANT_B2B=0 for solver-only probes.",
    ],
    checks: [
      { label: "CP-SAT", ok: false, detail: "Status INFEASIBLE." },
    ],
  };
}

/**
 * Feasibility-only CP-SAT run with structured logging and engine validation (single source of truth).
 */
export function solveScheduleFeasibilityCpSat(staticData: LoadedSchedulerStaticData): {
  result: CpSatGenerateResult;
  debug: SolveFeasibilityDebug;
} {
  const lines: string[] = [];
  const t0 = Date.now();
  const fixedVacErr = getFirstFixedProhibitedVacationOverlapError(staticData);
  if (fixedVacErr) {
    lines.push(`fixed_vacation_overlap_policy_block=1`);
    lines.push(fixedVacErr);
    console.warn("[scheduler:cp_sat]\n" + lines.join("\n"));
    return {
      result: { kind: "unavailable", reason: fixedVacErr },
      debug: { lines, wallMs: Date.now() - t0 },
    };
  }
  const normalized = normalizeSchedulerInput(staticData);
  const flags = readCpSatHardFlagsFromEnv();
  lines.push(
    `cp_hard_flags strenuous_b2b=${flags.hardStrenuousB2b} transplant_b2b=${flags.hardTransplantB2b}`
  );
  debugLog(
    "requirements",
    `residents=${normalized.residentsOrdered.length} months=${normalized.monthsOrdered.length} rots=${normalized.rotationsOrdered.length}`
  );

  const payload = buildCpSatJsonPayload(normalized, flags) as Record<string, unknown>;
  const hf = (payload.hard_flags as Record<string, unknown> | undefined) ?? {};
  if (typeof hf.vacation_overlap_soft_triple_count === "number") {
    lines.push(`vacation_overlap_soft_triple_count=${hf.vacation_overlap_soft_triple_count}`);
  }
  if (hf.vacation_overlap_policy_rotations != null) {
    lines.push(`vacation_overlap_policy_rotations=${JSON.stringify(hf.vacation_overlap_policy_rotations)}`);
  }
  const scriptPath = path.join(process.cwd(), "scripts", "solve_schedule_cp_sat.py");
  const py = process.env.PYTHON ?? "python3";
  lines.push(`python=${py} script=${scriptPath}`);

  const parsed = invokeCpSatSolver(payload);

  const wallMs = Date.now() - t0;
  lines.push(`wall_ms=${wallMs}`);

  if (!parsed.ok) {
    lines.push(`invoke_failed=${parsed.reason}`);
    if (parsed.stderr) lines.push(parsed.stderr.slice(0, 400));
    console.info("[scheduler:cp_sat]\n" + lines.join("\n"));
    return {
      result: {
        kind: "unavailable",
        reason: `Could not run CP-SAT (${py}): ${parsed.reason}. Install Python 3 and run: python3 -m pip install -r scripts/requirements-cp.txt`,
      },
      debug: { lines, wallMs },
    };
  }

  if (typeof parsed.wall_ms === "number") lines.push(`solver_wall_ms=${parsed.wall_ms}`);
  if (parsed.status_name) lines.push(`status_name=${parsed.status_name}`);
  lines.push(`status=${parsed.status}`);

  const debug: SolveFeasibilityDebug = {
    lines,
    wallMs,
    cpStatus: parsed.status,
    cpStatusName: parsed.status_name,
  };

  if (parsed.status === CP_INFEASIBLE) {
    const diag = buildInfeasibilityDiagnostics(normalized);
    for (const d of diag) lines.push(`diag: ${d}`);

    if (process.env.SCHEDULER_FEASIBILITY_LADDER_ON_FAIL === "1") {
      lines.push("[ladder] SCHEDULER_FEASIBILITY_LADDER_ON_FAIL=1 running cumulative ladder...");
      const ladder = runFeasibilityLadder(staticData);
      lines.push(formatFeasibilityLadderReport(ladder));
    }

    const core = buildCpSatInfeasibilityReport();
    const staticHints = buildFeasibilityReport(staticData, null);
    console.warn("[scheduler:cp_sat]\n" + lines.join("\n"));
    return {
      result: {
        kind: "infeasible",
        feasibilityReport: {
          summary: core.summary,
          suggestions: core.suggestions,
          checks: [...core.checks, ...staticHints.checks],
        },
      },
      debug,
    };
  }

  if (parsed.status === CP_MODEL_INVALID) {
    const diag = buildInfeasibilityDiagnostics(normalized);
    for (const d of diag) lines.push(`diag: ${d}`);
    console.warn("[scheduler:cp_sat]\n" + lines.join("\n"));
    return {
      result: {
        kind: "unavailable",
        reason: "CP-SAT reported MODEL_INVALID (empty domain or bad input).",
      },
      debug,
    };
  }

  if (parsed.grid == null) {
    console.info("[scheduler:cp_sat]\n" + lines.join("\n"));
    return {
      result: {
        kind: "unavailable",
        reason:
          "CP-SAT stopped without a feasible assignment (time limit or UNKNOWN). Raise CP_SAT_MAX_SECONDS or relax constraints.",
      },
      debug,
    };
  }

  const assignmentRows = gridToAssignmentRows(normalized, parsed.grid);
  const validation = validateSchedule(normalized, assignmentRows);
  lines.push(formatValidationReport(validation));
  if (!validation.ok) {
    lines.push("post_validate_failed=1");
    console.warn("[scheduler:cp_sat]\n" + lines.join("\n"));
    return {
      result: {
        kind: "unavailable",
        reason: `CP-SAT returned a grid that failed engine validation (model/decoder mismatch). Debug:\n${formatValidationReport(validation)}`,
      },
      debug,
    };
  }

  if (validation.softViolations.length > 0) {
    lines.push(`soft_penalty_count=${validation.softViolations.length}`);
    for (const s of validation.softViolations.slice(0, 8)) {
      lines.push(`[soft] ${s.code}: ${s.message}`);
    }
  }

  const audit = buildAuditForAssignmentRows(staticData, assignmentRows);
  console.info("[scheduler:cp_sat]\n" + lines.join("\n"));
  return {
    result: { kind: "ok", assignmentRows, audit },
    debug,
  };
}
