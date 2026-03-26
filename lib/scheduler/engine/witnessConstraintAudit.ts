/**
 * Line-by-line hard-constraint audit for witness schedules (delegates to validateWitnessSchedule).
 * @deprecated Prefer importing validateWitnessSchedule from ./witnessValidate
 */
import type { LoadedSchedulerStaticData } from "../generateSchedule";
import type { RequirementsMode } from "./buildCpSatPayload";
import { validateWitnessSchedule, type WitnessRow } from "./witnessValidate";

type Row = WitnessRow;

/** Legacy “Source:” one-liners (audit report). Prefer WITNESS_RULE_META in witnessValidate. */
export const WITNESS_RULE_SOURCE: Record<string, string> = {
  monthly_capacity: "lib/scheduler/engine/validateSchedule.ts — capacity loop",
  one_assignment_per_month: "lib/scheduler/engine/validateSchedule.ts — completeness",
  pgy_domain_eligibility: "lib/scheduler/engine/validateSchedule.ts — PGY loop",
  vacation_conflict: "lib/scheduler/engine/validateSchedule.ts — vacation forced null",
  fixed_rules: "lib/scheduler/engine/validateSchedule.ts — fixed rules",
  exact_rotation_count: "lib/scheduler/engine/validateSchedule.ts — requirement counts",
  below_minimum_rotation_months: "lib/scheduler/engine/validateSchedule.ts — requirement counts (minimum)",
  same_rotation_b2b: "lib/scheduler/generateSchedule.ts — assignmentHasHardSpacingViolations",
  strenuous_consult_b2b:
    "lib/scheduler/generateSchedule.ts — buildStrenuousConsultRotationIds + assignmentHasHardSpacingViolations",
  transplant_b2b: "lib/scheduler/generateSchedule.ts — assignmentHasHardSpacingViolations (transplant)",
  hidden_full_year_assignment: "(no engine rule: CP one variable per cell; null allowed)",
};

export type WitnessAuditOptions = {
  requirementsMode?: RequirementsMode;
};

export function runWitnessHardConstraintAudit(
  staticData: LoadedSchedulerStaticData,
  rows: Row[],
  options?: WitnessAuditOptions
): { lines: string[]; allPassed: boolean } {
  const r = validateWitnessSchedule(rows, staticData, {
    requirementsMode: options?.requirementsMode,
    firstFailureOnly: false,
  });
  return { lines: r.lines, allPassed: r.allPassed };
}

export function formatWitnessAuditReport(staticData: LoadedSchedulerStaticData, rows: Row[], options?: WitnessAuditOptions): string {
  const { lines, allPassed } = runWitnessHardConstraintAudit(staticData, rows, options);
  const tail = allPassed ? "\nOVERALL: PASS (all listed hard constraints)" : "\nOVERALL: FAIL";
  return lines.join("\n") + tail;
}
