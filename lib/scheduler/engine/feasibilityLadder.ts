import type { LoadedSchedulerStaticData } from "../generateSchedule";
import {
  buildCpSatJsonPayload,
  countPayloadStats,
  readCpSatHardFlagsFromEnv,
  readRequirementsModeFromEnv,
  type BuildCpSatOptions,
} from "./buildCpSatPayload";
import { FEASIBILITY_LADDER_STAGE_NAMES, type CpConstraintMask } from "./cpConstraintMask";
import { CP_FEASIBLE, CP_INFEASIBLE, CP_MODEL_INVALID, CP_OPTIMAL, invokeCpSatSolver } from "./cpSatInvoke";
import { normalizeSchedulerInput } from "./normalizeInput";
import type { NormalizedSchedulerInput } from "./types";

export type LadderStepResult = {
  stage: number;
  stageName: string;
  activeMask: CpConstraintMask;
  domainLayerNote: string;
  stats: ReturnType<typeof countPayloadStats>;
  solverStatus: number;
  solverStatusName?: string;
  wallMs?: number;
  feasible: boolean;
};

function layerNote(stage: number): string {
  if (stage <= 1) return "domain_layer=1 (unrestricted 0..K)";
  if (stage <= 3) return "domain_layer=2 (vacation forced null only)";
  if (stage <= 8) return "domain_layer=3 (vacation + PGY; fixed rules not collapsed)";
  return "domain_layer=4 (production domains + fixed)";
}

/**
 * Run CP-SAT once per ladder stage (1..9) with cumulative constraints.
 * First stage where status is INFEASIBLE (or MODEL_INVALID) pinpoints the rule group to inspect.
 */
export function runFeasibilityLadder(
  staticData: LoadedSchedulerStaticData,
  options?: Pick<BuildCpSatOptions, "requirementsMode" | "maxSecondsOverride">
): { steps: LadderStepResult[]; firstFailingStage: number | null } {
  const n = normalizeSchedulerInput(staticData);
  return runFeasibilityLadderInternal(n, options);
}

/** Multi-line report for console / API. */
export function formatFeasibilityLadderReport(result: ReturnType<typeof runFeasibilityLadder>): string {
  const lines: string[] = [];
  lines.push("=== SCHEDULER FEASIBILITY LADDER ===");
  if (result.firstFailingStage != null) {
    lines.push(
      `FIRST_FAILING_STAGE=${result.firstFailingStage} (${FEASIBILITY_LADDER_STAGE_NAMES[result.firstFailingStage]})`
    );
  } else {
    lines.push("FIRST_FAILING_STAGE=none (all stages feasible)");
  }
  for (const s of result.steps) {
    lines.push(`---`);
    lines.push(`stage=${s.stage} name=${s.stageName}`);
    lines.push(`  domain: ${s.domainLayerNote}`);
    lines.push(
      `  active_mask: capacity=${s.activeMask.capacity} required=${s.activeMask.required} fixed=${s.activeMask.fixed_triples} sameB2B=${s.activeMask.b2b_same} strB2B=${s.activeMask.b2b_strenuous} txpB2B=${s.activeMask.b2b_transplant}`
    );
    lines.push(
      `  counts: R=${s.stats.residents} M=${s.stats.months} K=${s.stats.rotations} requiredTriples(nonzero)=${s.stats.requiredTriples} fixedTriples=${s.stats.fixedTriples} vacationForcedCells=${s.stats.vacationForcedCells}`
    );
    lines.push(
      `  solver: status=${s.solverStatus} ${s.solverStatusName ?? ""} wall_ms=${s.wallMs ?? "?"} feasible=${s.feasible}`
    );
  }
  return lines.join("\n");
}

/** Ladder against an already-normalized input (tests / advanced). */
export function runFeasibilityLadderNormalized(
  n: NormalizedSchedulerInput,
  options?: Pick<BuildCpSatOptions, "requirementsMode" | "maxSecondsOverride">
): { steps: LadderStepResult[]; firstFailingStage: number | null } {
  return runFeasibilityLadderInternal(n, options);
}

function runFeasibilityLadderInternal(
  n: NormalizedSchedulerInput,
  options?: Pick<BuildCpSatOptions, "requirementsMode" | "maxSecondsOverride">
): { steps: LadderStepResult[]; firstFailingStage: number | null } {
  const flags = readCpSatHardFlagsFromEnv();
  const reqMode = options?.requirementsMode ?? readRequirementsModeFromEnv();
  const steps: LadderStepResult[] = [];
  let firstFailingStage: number | null = null;

  for (let stage = 1; stage <= 9; stage++) {
    const payload = buildCpSatJsonPayload(n, flags, {
      ladderStage: stage,
      requirementsMode: reqMode,
      maxSecondsOverride: options?.maxSecondsOverride,
    });
    const mask = payload.constraint_mask as CpConstraintMask;
    const raw = invokeCpSatSolver(payload as Record<string, unknown>);
    const stats = countPayloadStats(n, payload as Record<string, unknown>);

    if (!raw.ok) {
      steps.push({
        stage,
        stageName: FEASIBILITY_LADDER_STAGE_NAMES[stage] ?? `stage_${stage}`,
        activeMask: mask,
        domainLayerNote: layerNote(stage),
        stats,
        solverStatus: -1,
        solverStatusName: "SPAWN_ERROR",
        feasible: false,
      });
      if (firstFailingStage == null) firstFailingStage = stage;
      break;
    }

    const feasible =
      raw.grid != null && (raw.status === CP_OPTIMAL || raw.status === CP_FEASIBLE);
    const failed = raw.status === CP_INFEASIBLE || raw.status === CP_MODEL_INVALID || !feasible;

    steps.push({
      stage,
      stageName: FEASIBILITY_LADDER_STAGE_NAMES[stage] ?? `stage_${stage}`,
      activeMask: mask,
      domainLayerNote: layerNote(stage),
      stats,
      solverStatus: raw.status,
      solverStatusName: raw.status_name,
      wallMs: raw.wall_ms,
      feasible,
    });

    if (failed && firstFailingStage == null) firstFailingStage = stage;
    if (failed) break;
  }

  return { steps, firstFailingStage };
}
