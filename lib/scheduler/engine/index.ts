/**
 * Rebuilt scheduling engine layer (validation, normalization, CP-SAT payload).
 *
 * ## Hard vs soft (persistence contract)
 * - **HARD**: completeness; PGY eligibility; capacity per (month, rotation); requirement counts (see `SCHEDULER_REQ_MODE`);
 *   vacation-forced null when `noConsultWhenVacationInMonth === false` and calendar overlap;
 *   rotation `vacation_overlap_policy === prohibited` forbids that rotation in vacation-overlap months (CP + validateSchedule);
 *   fixed rules when {@link validateSchedule.fixedRuleIsEnforced} says they apply;
 *   B2B spacing when `SCHEDULER_B2B_HARD=1` (default) and program toggles are on.
 * - **SOFT**: consult/strenuous on vacation when `noConsultWhenVacationInMonth === true`; rotation `vacation_overlap_policy === avoid` (CP objective + validateSchedule warning);
 *   months above `min_months_required` when `SCHEDULER_REQ_MODE=minimum`;
 *   B2B violations when `SCHEDULER_B2B_HARD=0`; audit-only preferences in generateSchedule.
 *
 * ## Debug
 * - `SCHEDULER_DEBUG_RULES=all` or comma-separated: requirements,capacity,pgy,spacing_*,vacation_null,fixed_rules,completeness
 * - `SCHEDULER_DEBUG_CP=1` — Python solver stderr model summary + status
 * - `SCHEDULER_REQ_MODE=minimum|exact` — DB `min_months_required` as lower bound vs legacy equality (default **minimum**)
 * - `SCHEDULER_B2B_HARD=0` — same/strenuous/transplant B2B become soft and are omitted from CP
 * - `SCHEDULER_FEASIBILITY_LADDER_ON_FAIL=1` — on CP INFEASIBLE, log cumulative 9-stage ladder
 * - `npm run debug:scheduler-ladder` — run ladder on fixture or `SCHEDULER_STATIC_JSON`
 * - `npm run debug:scheduler-real-case` — ladder + bottleneck; defaults to `debug/current-scheduler-setup.json` (from Export in admin or `npm run export:scheduler-setup`)
 * - `SCHEDULER_WITNESS_ASSIGNMENTS_JSON` — path to witness rows JSON; on generate UNSAT, API may return `witnessFirstFailure` (first hard-rule mismatch)
 * - `npm run debug:witness-schedule` — validate witness rows vs static (`SCHEDULER_STATIC_JSON` / fixture); prints first failure; exit 1 on fail
 * - `SCHEDULER_CP_HARD_STRENUOUS_B2B=0` — drop strenuous B2B from CP model only
 * - `SCHEDULER_CP_HARD_TRANSPLANT_B2B=0` — same for transplant
 */

export type * from "./types";
export { normalizeSchedulerInput, residentMonthKey, reqKey, vacationOverlapDaysInclusive } from "./normalizeInput";
export {
  validateSchedule,
  formatValidationReport,
  fixedRuleIsEnforced,
} from "./validateSchedule";
export { explainInfeasibility } from "./explainInfeasibility";
export { scoreSoftViolations } from "./scoreSchedule";
export {
  buildCpSatJsonPayload,
  buildAllowedValuesAndFixed,
  gridToAssignmentRows,
  isStrenuousConsultB2bHardInModel,
  isTransplantB2bHardInModel,
  readCpSatHardFlagsFromEnv,
  readRequirementsModeFromEnv,
  readB2bHardFromEnv,
  countPayloadStats,
  type AllowedValuesAndFixedResult,
  type BuildCpSatOptions,
  type RequirementsMode,
} from "./buildCpSatPayload";
export { solveScheduleFeasibilityCpSat } from "./solveFeasibility";
export { runFeasibilityLadder, runFeasibilityLadderNormalized, formatFeasibilityLadderReport } from "./feasibilityLadder";
export { formatExecutiveBottleneckTop3, formatFirstFailingStageBottleneck } from "./feasibilityBottleneckReport";
export { buildInfeasibilityDiagnostics } from "./feasibilityDiagnostics";
export {
  validateHumanScheduleDetailed,
  formatDetailedValidationReport,
  formatFirstFailingRuleHumanReadable,
  getFirstFailingFailure,
  academicMonthLabelFromIndex,
  ACADEMIC_MONTH_LABELS,
  type DetailedValidationReport,
} from "./validateScheduleDetailed";
export { invokeCpSatSolver } from "./cpSatInvoke";
export { FEASIBILITY_LADDER_STAGE_NAMES, CP_MASK_ALL_TRUE, type CpConstraintMask } from "./cpConstraintMask";
export {
  witnessProgramStaticData,
  witnessHannahAssignmentRows,
  witnessMonthsList,
  WITNESS_ROTATION_IDS,
  WITNESS_RESIDENT_HANNAH,
  WITNESS_PROGRAM_ID,
} from "./witnessProgram.fixture";
export {
  runWitnessHardConstraintAudit,
  formatWitnessAuditReport,
  WITNESS_RULE_SOURCE,
} from "./witnessConstraintAudit";
export {
  validateWitnessSchedule,
  WITNESS_RULE_META,
  type WitnessRow,
  type WitnessValidationResult,
  type ValidateWitnessOptions,
} from "./witnessValidate";
export { computeWitnessFirstFailureIfConfigured } from "./witnessFromEnv";
export { isRuleGroupDebugEnabled, debugLog, listRuleGroups } from "./debug";
export * from "./fixtures";
export { runDebugFixture, type DebugFixtureName } from "./runDebugFixture";
