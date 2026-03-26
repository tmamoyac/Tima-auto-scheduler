/** Types, constants, and UI strings shared with client components (no Node-only APIs). */

export type ScheduleAudit = {
  requirementViolations: {
    residentName: string;
    rotationName: string;
    required: number;
    assigned: number;
  }[];
  softRuleViolations: {
    residentName: string;
    monthLabel: string;
    rule: string;
  }[];
};

export type FeasibilityReport = {
  summary: string;
  suggestions: string[];
  checks: Array<{ label: string; ok: boolean; detail?: string }>;
};

/**
 * Legacy: global audit-line count threshold; primary goal is now per-resident B2B cap (see {@link StrenuousConsultB2bBestEffortMeta.residentsOverOne}).
 */
export const STRENUOUS_B2B_BEST_EFFORT_TARGET_MAX_EXCLUSIVE = 2;

/** Generation succeeds immediately when soft-rule count is strictly below this (0–4). */
export const SOFT_RULE_TARGET_MAX_EXCLUSIVE = 5;

/** Wall-clock budget for the outer search loop (ms). */
export const SCHEDULE_SEARCH_BUDGET_MS = 90_000;

export type StrenuousConsultB2bBestEffortMeta = {
  /** Total month-boundaries where a resident has consecutive strenuous consult months. */
  totalStrenuousB2bEdges: number;
  /** Residents with more than one such boundary in the year (goal: 0). */
  residentsOverOne: number;
  /** @deprecated use totalStrenuousB2bEdges */
  violationCount: number;
  targetMaxExclusive: number;
};

/** Post-solve counts from the saved assignment grid (not CP soft flags). */
export type VacationOverlapSummary = {
  prohibited_violation_count: number;
  avoid_used_count: number;
};

export type VacationOverlapDetailRow = {
  resident_id: string;
  resident_name: string;
  month_id: string;
  month_label: string;
  rotation_id: string;
  rotation_name: string;
  policy: "Avoid" | "Prohibited";
  overlapping_vacation_start: string;
  overlapping_vacation_end: string;
  /** True when a fixed_assignment_rules row pins this resident/month to this rotation. */
  from_fixed_rule: boolean;
  /** DB row id for DELETE / deep-link; set when `from_fixed_rule`. */
  fixed_rule_id?: string | null;
};

/** Returned with HTTP 503 when CP-SAT cannot run (matches API `cp_sat_unavailable`). */
export type CpSatUnavailableDetail = {
  code: "CP_SAT_RUNTIME_UNAVAILABLE";
  cause: string;
  executable?: string;
  os_error?: string;
  stderr_snippet?: string;
  message: string;
  remediation: string[];
};

/** Fixed pin conflicts with rotation `prohibited` vacation-overlap policy (generate blocked before solve). */
export type VacationOverlapBlocked = {
  resident_id: string;
  resident_name: string;
  month_id: string;
  month_label: string;
  rotation_id: string;
  rotation_name: string;
  message: string;
  reason: string;
  /** `fixed_assignment_rules.id` for the conflicting pin (empty if unavailable). */
  fixed_rule_id: string;
};

export type GenerateScheduleResult = {
  scheduleVersionId: string;
  audit: ScheduleAudit;
  /** Which engine produced this result (`cp_sat` only when OR-Tools ran and succeeded). */
  schedulerEngineUsed?: "cp_sat" | "heuristic";
  /**
   * Present when the best schedule still has back-to-back strenuous consult violations
   * despite construction-time avoidance, cross-resident swaps, and the full search budget.
   */
  strenuousConsultB2bBestEffort?: StrenuousConsultB2bBestEffortMeta;
  /** How to rebalance setup when constraints look tight or partly unmet. */
  feasibilityReport?: FeasibilityReport;
  vacation_overlap_summary: VacationOverlapSummary;
  vacation_overlap_details: VacationOverlapDetailRow[];
};

/** UX copy when a best-effort schedule is returned for strenuous spacing. */
export function formatStrenuousBestEffortBanner(meta: StrenuousConsultB2bBestEffortMeta): string {
  const { totalStrenuousB2bEdges, residentsOverOne, violationCount, targetMaxExclusive } = meta;
  const edges = totalStrenuousB2bEdges ?? violationCount;
  const parts: string[] = [];
  if (residentsOverOne > 0) {
    parts.push(
      `${residentsOverOne} resident(s) have more than one back-to-back strenuous consult stretch (goal: at most one per resident).`
    );
  }
  if (edges > 0) {
    parts.push(`${edges} total strenuous back-to-back month edge(s) (minimize).`);
  }
  if (parts.length > 0) {
    return parts.join(" ") + " See soft-rule warnings below.";
  }
  if (edges < targetMaxExclusive) {
    return `${edges} strenuous consult spacing edge(s)—under legacy goal < ${targetMaxExclusive}. Review details below.`;
  }
  return `Best schedule in search time has ${edges} strenuous B2B edge(s) (goal: fewer than ${targetMaxExclusive}). Review the audit, or adjust and generate again.`;
}
