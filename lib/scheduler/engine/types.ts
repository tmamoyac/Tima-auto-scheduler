import type { FeasibilityReport, ScheduleAudit } from "../scheduleClientShare";
import type { LoadedSchedulerStaticData } from "../generateSchedule";

export type RuleGroup =
  | "requirements"
  | "capacity"
  | "pgy"
  | "spacing_same_rotation"
  | "spacing_strenuous_b2b"
  | "spacing_transplant_b2b"
  | "vacation_null"
  | "vacation_overlap_policy"
  | "fixed_rules"
  | "completeness";

/** HARD = must hold for a schedule we persist. SOFT = preference / audit only. */
export type ConstraintSeverity = "hard" | "soft";

export type RuleViolation = {
  group: RuleGroup;
  severity: ConstraintSeverity;
  code: string;
  message: string;
  /** Optional structured detail for debugging */
  meta?: Record<string, string | number | boolean | null>;
};

export type ValidationResult = {
  ok: boolean;
  hardViolations: RuleViolation[];
  softViolations: RuleViolation[];
  /** ms spent in last operation if applicable */
  timingMs?: number;
};

export type NormalizedSchedulerInput = {
  staticData: LoadedSchedulerStaticData;
  residentsOrdered: LoadedSchedulerStaticData["residentsList"];
  monthsOrdered: LoadedSchedulerStaticData["monthsList"];
  rotationsOrdered: LoadedSchedulerStaticData["rotationsList"];
  /** Inclusive calendar overlap: any vacation range intersects academic month window */
  vacationResidentMonthKeys: Set<string>;
  monthWindows: Map<string, { start: string; end: string }>;
  initialRequired: Map<string, number>;
  rotIndexById: Map<string, number>;
  residentIndexById: Map<string, number>;
  monthIndexById: Map<string, number>;
};

export type CpSatHardFlags = {
  /** When false, CP-SAT omits strenuous B2B constraints (feasibility probe only). */
  hardStrenuousB2b: boolean;
  /** When false, CP-SAT omits transplant B2B constraints (feasibility probe only). */
  hardTransplantB2b: boolean;
};

export type SolveFeasibilityDebug = {
  lines: string[];
  wallMs?: number;
  cpStatus?: number;
  cpStatusName?: string;
};

export type CpSatGenerateResult =
  | {
      kind: "ok";
      assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[];
      audit: ScheduleAudit;
    }
  | { kind: "infeasible"; feasibilityReport: FeasibilityReport }
  | { kind: "unavailable"; reason: string };
