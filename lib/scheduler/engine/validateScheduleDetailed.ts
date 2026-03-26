import {
  buildStrenuousConsultRotationIds,
  type LoadedSchedulerStaticData,
} from "../generateSchedule";
import {
  readB2bHardFromEnv,
  readRequirementsModeFromEnv,
  type RequirementsMode,
} from "./buildCpSatPayload";
import { normalizeSchedulerInput, residentMonthKey, reqKey } from "./normalizeInput";
import { fixedRuleIsEnforced } from "./validateSchedule";
import type { NormalizedSchedulerInput } from "./types";

type AssignmentRow = { resident_id: string; month_id: string; rotation_id: string | null };
type Rotation = LoadedSchedulerStaticData["rotationsList"][number];

export type DetailedCheckFailure = {
  pass: false;
  reason: string;
  residentId?: string;
  monthId?: string;
  rotationId?: string | null;
  meta?: Record<string, string | number | boolean | null>;
};

export type DetailedCheck = {
  ruleId: string;
  label: string;
  passed: boolean;
  failures: DetailedCheckFailure[];
};

export type DetailedValidationReport = {
  checks: DetailedCheck[];
  allPassed: boolean;
};

function lookupMap(rows: AssignmentRow[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const row of rows) {
    m.set(residentMonthKey(row.resident_id, row.month_id), row.rotation_id);
  }
  return m;
}

/**
 * Per-rule PASS/FAIL with resident/month/rotation detail (for human schedule auditing).
 */
export function validateHumanScheduleDetailed(
  staticDataOrNormalized: LoadedSchedulerStaticData | NormalizedSchedulerInput,
  assignmentRows: AssignmentRow[],
  options?: { requirementsMode?: RequirementsMode }
): DetailedValidationReport {
  const n =
    "vacationResidentMonthKeys" in staticDataOrNormalized
      ? staticDataOrNormalized
      : normalizeSchedulerInput(staticDataOrNormalized);

  const reqMode = options?.requirementsMode ?? readRequirementsModeFromEnv();
  const b2bHard = readB2bHardFromEnv();
  const { staticData, residentsOrdered, monthsOrdered, rotationsOrdered, initialRequired } = n;
  const lookup = lookupMap(assignmentRows);
  const rotById = new Map<string, Rotation>(rotationsOrdered.map((r) => [r.id, r]));
  const checks: DetailedCheck[] = [];

  const pushCheck = (c: DetailedCheck) => checks.push(c);

  // --- completeness ---
  const miss: DetailedCheckFailure[] = [];
  for (const res of residentsOrdered) {
    for (const month of monthsOrdered) {
      const k = residentMonthKey(res.id, month.id);
      if (!lookup.has(k)) {
        miss.push({
          pass: false,
          reason: "Missing assignment cell",
          residentId: res.id,
          monthId: month.id,
        });
      }
    }
  }
  pushCheck({ ruleId: "completeness", label: "Every resident × month has a row", passed: miss.length === 0, failures: miss });

  // --- PGY ---
  const pgyFail: DetailedCheckFailure[] = [];
  for (const res of residentsOrdered) {
    for (const month of monthsOrdered) {
      const rid = lookup.get(residentMonthKey(res.id, month.id));
      if (rid == null) continue;
      const rot = rotById.get(rid);
      if (!rot) {
        pgyFail.push({
          pass: false,
          reason: "Unknown rotation id",
          residentId: res.id,
          monthId: month.id,
          rotationId: rid,
        });
        continue;
      }
      if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) {
        pgyFail.push({
          pass: false,
          reason: `PGY ${res.pgy} outside eligible range ${rot.eligible_pgy_min}–${rot.eligible_pgy_max}`,
          residentId: res.id,
          monthId: month.id,
          rotationId: rid,
          meta: { eligibleMin: rot.eligible_pgy_min, eligibleMax: rot.eligible_pgy_max },
        });
      }
    }
  }
  pushCheck({ ruleId: "pgy_eligibility", label: "PGY within rotation eligible_pgy range", passed: pgyFail.length === 0, failures: pgyFail });

  // --- vacation forced null ---
  const vacFail: DetailedCheckFailure[] = [];
  if (!staticData.noConsultWhenVacationInMonth) {
    for (const res of residentsOrdered) {
      for (const month of monthsOrdered) {
        const k = residentMonthKey(res.id, month.id);
        if (!n.vacationResidentMonthKeys.has(k)) continue;
        const assigned = lookup.get(k);
        if (assigned != null) {
          vacFail.push({
            pass: false,
            reason: "Vacation-overlap month must be null (off) when noConsultWhenVacationInMonth is false",
            residentId: res.id,
            monthId: month.id,
            rotationId: assigned,
          });
        }
      }
    }
  }
  pushCheck({
    ruleId: "vacation_forced_off",
    label: "Vacation calendar overlap → null when program forces off-month",
    passed: vacFail.length === 0,
    failures: vacFail,
  });

  // --- fixed rules ---
  const fixedFail: DetailedCheckFailure[] = [];
  for (const res of residentsOrdered) {
    for (let mi = 0; mi < monthsOrdered.length; mi++) {
      const month = monthsOrdered[mi];
      const fixedRot = staticData.fixedRuleMap.get(residentMonthKey(res.id, month.id));
      if (!fixedRot) continue;
      if (!fixedRuleIsEnforced(n, res.id, month.id, mi, fixedRot)) continue;
      const actual = lookup.get(residentMonthKey(res.id, month.id)) ?? null;
      if (actual !== fixedRot) {
        fixedFail.push({
          pass: false,
          reason: `Fixed rule expects rotation ${fixedRot}`,
          residentId: res.id,
          monthId: month.id,
          rotationId: actual,
          meta: { expectedRotationId: fixedRot },
        });
      }
    }
  }
  pushCheck({ ruleId: "fixed_rules", label: "Enforced fixed rules match assignment", passed: fixedFail.length === 0, failures: fixedFail });

  // --- capacity ---
  const counts = new Map<string, number>();
  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const k = `${row.month_id}_${row.rotation_id}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const capFail: DetailedCheckFailure[] = [];
  for (const month of monthsOrdered) {
    for (const rot of rotationsOrdered) {
      const nAss = counts.get(`${month.id}_${rot.id}`) ?? 0;
      if (nAss > rot.capacity_per_month) {
        capFail.push({
          pass: false,
          reason: `Capacity exceeded (${nAss} > ${rot.capacity_per_month})`,
          monthId: month.id,
          rotationId: rot.id,
          meta: { assigned: nAss, cap: rot.capacity_per_month },
        });
      }
    }
  }
  pushCheck({ ruleId: "capacity", label: "Per month × rotation capacity", passed: capFail.length === 0, failures: capFail });

  // --- requirements (min or exact) ---
  const assignedByReq = new Map<string, number>();
  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const k = reqKey(row.resident_id, row.rotation_id);
    assignedByReq.set(k, (assignedByReq.get(k) ?? 0) + 1);
  }
  const reqFail: DetailedCheckFailure[] = [];
  for (const res of residentsOrdered) {
    for (const rot of rotationsOrdered) {
      const init = initialRequired.get(reqKey(res.id, rot.id));
      if (init === undefined) continue;
      const got = assignedByReq.get(reqKey(res.id, rot.id)) ?? 0;
      if (init === 0) {
        if (got !== 0) {
          reqFail.push({
            pass: false,
            reason: "Rotation marked required=0 (forbidden / custom matrix) but assigned > 0 months",
            residentId: res.id,
            rotationId: rot.id,
            meta: { assigned: got },
          });
        }
        continue;
      }
      if (reqMode === "exact") {
        if (got !== init) {
          reqFail.push({
            pass: false,
            reason: `Exact months required (${init}) mismatch`,
            residentId: res.id,
            rotationId: rot.id,
            meta: { required: init, assigned: got, mode: "exact" },
          });
        }
      } else {
        if (got < init) {
          reqFail.push({
            pass: false,
            reason: `Below minimum months (${init})`,
            residentId: res.id,
            rotationId: rot.id,
            meta: { min: init, assigned: got, mode: "minimum" },
          });
        }
      }
    }
  }
  pushCheck({
    ruleId: "required_months",
    label: `Required months (mode=${reqMode})`,
    passed: reqFail.length === 0,
    failures: reqFail,
  });

  // --- implicit max: cannot assign more than M months to one resident on one rotation (structural) ---
  const maxFail: DetailedCheckFailure[] = [];
  for (const res of residentsOrdered) {
    for (const rot of rotationsOrdered) {
      const got = assignedByReq.get(reqKey(res.id, rot.id)) ?? 0;
      if (got > monthsOrdered.length) {
        maxFail.push({
          pass: false,
          reason: "More months assigned than exist in academic year",
          residentId: res.id,
          rotationId: rot.id,
          meta: { assigned: got, monthsInYear: monthsOrdered.length },
        });
      }
    }
  }
  pushCheck({ ruleId: "max_months_structural", label: "Counts do not exceed year length", passed: maxFail.length === 0, failures: maxFail });

  // --- spacing ---
  const strenuousIds = buildStrenuousConsultRotationIds(rotationsOrdered);
  const transplantIds = new Set(rotationsOrdered.filter((r: Rotation) => r.is_transplant).map((r) => r.id));
  const sameFail: DetailedCheckFailure[] = [];
  const strFail: DetailedCheckFailure[] = [];
  const txpFail: DetailedCheckFailure[] = [];

  for (const res of residentsOrdered) {
    for (let mi = 1; mi < monthsOrdered.length; mi++) {
      const a = lookup.get(residentMonthKey(res.id, monthsOrdered[mi - 1].id));
      const b = lookup.get(residentMonthKey(res.id, monthsOrdered[mi].id));
      if (!a || !b) continue;
      const prevMonth = monthsOrdered[mi - 1];
      const currMonth = monthsOrdered[mi];
      if (b2bHard.same && a === b) {
        sameFail.push({
          pass: false,
          reason: "Same rotation back-to-back",
          residentId: res.id,
          monthId: currMonth.id,
          rotationId: b,
          meta: {
            boundary: `${mi - 1}->${mi}`,
            prevMonthId: prevMonth.id,
            currMonthId: currMonth.id,
            prevRotationId: a,
            currRotationId: b,
          },
        });
      }
      if (
        b2bHard.strenuous &&
        staticData.avoidBackToBackConsult &&
        strenuousIds.has(a) &&
        strenuousIds.has(b)
      ) {
        strFail.push({
          pass: false,
          reason: "Strenuous consult back-to-back",
          residentId: res.id,
          monthId: currMonth.id,
          meta: {
            prev: a,
            curr: b,
            prevMonthId: prevMonth.id,
            currMonthId: currMonth.id,
          },
        });
      }
      if (
        b2bHard.transplant &&
        staticData.avoidBackToBackTransplant &&
        transplantIds.has(a) &&
        transplantIds.has(b)
      ) {
        txpFail.push({
          pass: false,
          reason: "Transplant back-to-back",
          residentId: res.id,
          monthId: currMonth.id,
          meta: {
            prev: a,
            curr: b,
            prevMonthId: prevMonth.id,
            currMonthId: currMonth.id,
          },
        });
      }
    }
  }

  pushCheck({
    ruleId: "spacing_same_b2b",
    label: "Same-rotation B2B (hard when SCHEDULER_B2B_HARD includes same)",
    passed: sameFail.length === 0,
    failures: sameFail,
  });
  pushCheck({
    ruleId: "spacing_strenuous_b2b",
    label: "Strenuous B2B (hard when enabled + SCHEDULER_B2B_HARD)",
    passed: strFail.length === 0,
    failures: strFail,
  });
  pushCheck({
    ruleId: "spacing_transplant_b2b",
    label: "Transplant B2B (hard when enabled + SCHEDULER_B2B_HARD)",
    passed: txpFail.length === 0,
    failures: txpFail,
  });

  const allPassed = checks.every((c) => c.passed);
  return { checks, allPassed };
}

export function formatDetailedValidationReport(
  r: DetailedValidationReport,
  print?: (s: string) => void,
  options?: { leadWithFirstHumanFailure?: boolean; normalized?: NormalizedSchedulerInput | LoadedSchedulerStaticData }
): string {
  const lines: string[] = [];
  const emit = (s: string) => {
    lines.push(s);
    print?.(s);
  };
  emit("=== HUMAN SCHEDULE DETAILED VALIDATOR ===");
  if (options?.leadWithFirstHumanFailure && options.normalized && !r.allPassed) {
    const human = formatFirstFailingRuleHumanReadable(r, options.normalized);
    if (human) {
      emit("");
      emit("--- FIRST FAILING RULE (human-readable) ---");
      emit(human);
      emit("");
    }
  }
  for (const c of r.checks) {
    emit(`[${c.passed ? "PASS" : "FAIL"}] ${c.ruleId} — ${c.label}`);
    for (const f of c.failures) {
      emit(
        `  • ${f.reason} | resident=${f.residentId ?? "—"} month=${f.monthId ?? "—"} rotation=${f.rotationId ?? "—"}`
      );
    }
  }
  emit(`OVERALL: ${r.allPassed ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

/** Labels for one academic year: July → June. */
export const ACADEMIC_MONTH_LABELS = [
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
] as const;

/**
 * Maps `months.month_index` from Postgres: **1 = July … 12 = June** (typical GME).
 * Legacy test fixtures may still use **0 = July … 11 = June**; those are supported when the value is 0
 * or when it falls only in the 0..11 range (fixtures with no `month_index` 12).
 */
export function academicMonthLabelFromIndex(monthIndex: number): string {
  if (monthIndex >= 1 && monthIndex <= 12) {
    return ACADEMIC_MONTH_LABELS[monthIndex - 1];
  }
  if (monthIndex >= 0 && monthIndex <= 11) {
    return ACADEMIC_MONTH_LABELS[monthIndex];
  }
  return `month_index_${monthIndex}`;
}

export function getFirstFailingFailure(
  r: DetailedValidationReport
): { check: DetailedCheck; failure: DetailedCheckFailure } | null {
  for (const c of r.checks) {
    if (c.passed || c.failures.length === 0) continue;
    return { check: c, failure: c.failures[0]! };
  }
  return null;
}

/**
 * Single-block summary of the first failed rule (witness / debugging).
 * Returns null if all checks passed.
 */
export function formatFirstFailingRuleHumanReadable(
  r: DetailedValidationReport,
  staticDataOrNormalized: LoadedSchedulerStaticData | NormalizedSchedulerInput
): string | null {
  const first = getFirstFailingFailure(r);
  if (!first) return null;

  const n =
    "vacationResidentMonthKeys" in staticDataOrNormalized
      ? staticDataOrNormalized
      : normalizeSchedulerInput(staticDataOrNormalized);
  const { residentsOrdered, monthsOrdered, rotationsOrdered } = n;
  const rotById = new Map(rotationsOrdered.map((rot) => [rot.id, rot]));

  const resName = (id: string | undefined) => {
    if (!id) return "—";
    const res = residentsOrdered.find((x) => x.id === id);
    if (!res) return id;
    const parts = [res.first_name, res.last_name].filter(Boolean);
    return parts.length ? parts.join(" ") : id;
  };

  const rotName = (id: string | undefined | null) => {
    if (id == null || id === "") return "—";
    const rot = rotById.get(id);
    const label = rot?.name?.trim();
    return label || id;
  };

  const monthPair = (meta: DetailedCheckFailure["meta"]) => {
    const p = meta?.prevMonthId as string | undefined;
    const c = meta?.currMonthId as string | undefined;
    if (p && c) {
      const mp = monthsOrdered.find((m) => m.id === p);
      const mc = monthsOrdered.find((m) => m.id === c);
      if (mp && mc) {
        return `${academicMonthLabelFromIndex(mp.month_index)} -> ${academicMonthLabelFromIndex(mc.month_index)}`;
      }
      return `${p} -> ${c}`;
    }
    const mid = first.failure.monthId;
    if (mid) {
      const m = monthsOrdered.find((x) => x.id === mid);
      return m ? academicMonthLabelFromIndex(m.month_index) : mid;
    }
    return "—";
  };

  const strenuousDetail = (rotId: string) => {
    const rot = rotById.get(rotId) as Rotation & { is_consult?: boolean; is_back_to_back_consult_blocker?: boolean };
    const label = rot?.name?.trim() || rotId;
    if (rot?.is_back_to_back_consult_blocker) return `${label} (back-to-back consult blocker → strenuous set)`;
    if (rot?.is_consult) return `${label} (consult rotation → strenuous set)`;
    return `${label} (included in strenuous B2B set)`;
  };

  const { check, failure: f } = first;
  const meta = f.meta;
  const lines: string[] = [];

  switch (check.ruleId) {
    case "spacing_strenuous_b2b": {
      const prevR = (meta?.prev as string) ?? "";
      const currR = (meta?.curr as string) ?? "";
      lines.push("FAIL: strenuous_consult_b2b");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Month: ${monthPair(meta)}`);
      lines.push(
        `Reason: ${strenuousDetail(prevR)} and ${strenuousDetail(currR)} are both in the strenuous consult rotation set; consecutive academic months are forbidden as a hard rule when avoidBackToBackConsult is on (and SCHEDULER_B2B_HARD treats this as hard).`
      );
      break;
    }
    case "spacing_transplant_b2b": {
      const prevR = (meta?.prev as string) ?? "";
      const currR = (meta?.curr as string) ?? "";
      lines.push("FAIL: transplant_b2b");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Month: ${monthPair(meta)}`);
      lines.push(
        `Reason: ${rotName(prevR)} and ${rotName(currR)} are both flagged as transplant (is_transplant); consecutive months are forbidden when avoidBackToBackTransplant is on.`
      );
      break;
    }
    case "spacing_same_b2b": {
      const rid = (meta?.currRotationId as string) || f.rotationId || "—";
      lines.push("FAIL: same_rotation_b2b");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Month: ${monthPair(meta)}`);
      lines.push(
        `Reason: ${rotName(rid)} is assigned in two consecutive months; same-rotation back-to-back is a hard rule when enforced.`
      );
      break;
    }
    case "required_months": {
      const mode = meta?.mode as string | undefined;
      const assigned = meta?.assigned as number | undefined;
      const required = (meta?.required ?? meta?.min) as number | undefined;
      if (mode === "exact") {
        lines.push("FAIL: exact_rotation_count");
        lines.push(`Resident: ${resName(f.residentId)}`);
        lines.push(`Rotation: ${rotName(f.rotationId)}`);
        lines.push(`Expected: ${required ?? "—"}`);
        lines.push(`Actual: ${assigned ?? "—"}`);
      } else {
        lines.push("FAIL: below_minimum_rotation_months");
        lines.push(`Resident: ${resName(f.residentId)}`);
        lines.push(`Rotation: ${rotName(f.rotationId)}`);
        lines.push(`Minimum required: ${required ?? "—"}`);
        lines.push(`Actual months assigned: ${assigned ?? "—"}`);
        lines.push(`Reason: Fewer months on this rotation than min_months_required (SCHEDULER_REQ_MODE=minimum).`);
      }
      break;
    }
    case "completeness": {
      const mid = f.monthId;
      const m = mid ? monthsOrdered.find((x) => x.id === mid) : undefined;
      const mLabel = m ? academicMonthLabelFromIndex(m.month_index) : mid ?? "—";
      lines.push("FAIL: one_assignment_per_resident_per_month");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Month: ${mLabel}`);
      lines.push(
        `Reason: No assignment row for this resident–month (every resident must have exactly one cell per month in the grid).`
      );
      break;
    }
    case "capacity": {
      const cap = meta?.cap as number | undefined;
      const nAss = meta?.assigned as number | undefined;
      const mid = f.monthId;
      const m = mid ? monthsOrdered.find((x) => x.id === mid) : undefined;
      const mLabel = m ? academicMonthLabelFromIndex(m.month_index) : mid ?? "—";
      lines.push("FAIL: monthly_rotation_capacity");
      lines.push(`Month: ${mLabel}`);
      lines.push(`Rotation: ${rotName(f.rotationId)}`);
      lines.push(`Reason: ${nAss ?? "—"} residents assigned but capacity_per_month is ${cap ?? "—"}.`);
      break;
    }
    case "pgy_eligibility": {
      const emin = meta?.eligibleMin as number | undefined;
      const emax = meta?.eligibleMax as number | undefined;
      const mid = f.monthId;
      const m = mid ? monthsOrdered.find((x) => x.id === mid) : undefined;
      const mLabel = m ? academicMonthLabelFromIndex(m.month_index) : mid ?? "—";
      lines.push("FAIL: pgy_domain_eligibility");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Month: ${mLabel}`);
      lines.push(`Rotation: ${rotName(f.rotationId)}`);
      lines.push(
        `Reason: Resident PGY is outside eligible_pgy_min–eligible_pgy_max (${emin ?? "?"}-${emax ?? "?"}) for this rotation.`
      );
      break;
    }
    case "vacation_forced_off": {
      const mid = f.monthId;
      const m = mid ? monthsOrdered.find((x) => x.id === mid) : undefined;
      const mLabel = m ? academicMonthLabelFromIndex(m.month_index) : mid ?? "—";
      lines.push("FAIL: vacation_conflict");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Month: ${mLabel}`);
      lines.push(`Rotation: ${rotName(f.rotationId)}`);
      lines.push(
        `Reason: Calendar vacation overlaps this month but noConsultWhenVacationInMonth is false, so the model requires null (off) — assigning ${rotName(f.rotationId)} violates that hard rule.`
      );
      break;
    }
    case "fixed_rules": {
      const expected = meta?.expectedRotationId as string | undefined;
      const mid = f.monthId;
      const m = mid ? monthsOrdered.find((x) => x.id === mid) : undefined;
      const mLabel = m ? academicMonthLabelFromIndex(m.month_index) : mid ?? "—";
      lines.push("FAIL: fixed_rule_mismatch");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Month: ${mLabel}`);
      lines.push(`Reason: Fixed rule requires ${rotName(expected)} but assignment is ${rotName(f.rotationId)}.`);
      break;
    }
    case "max_months_structural": {
      lines.push("FAIL: rotation_count_exceeds_year");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Rotation: ${rotName(f.rotationId)}`);
      lines.push(`Reason: More months assigned on this rotation than months in the academic year.`);
      break;
    }
    case "hidden_full_year_assignment": {
      lines.push("FAIL: hidden_full_year_assignment");
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Expected assigned months: ${meta?.expectedAssignedMonths ?? "—"}`);
      lines.push(`Solver required: ${meta?.solverRequiredMonths ?? "—"}`);
      lines.push(`Reason: ${f.reason}`);
      break;
    }
    default: {
      lines.push(`FAIL: ${check.ruleId}`);
      lines.push(`Resident: ${resName(f.residentId)}`);
      lines.push(`Month: ${monthPair(meta)}`);
      lines.push(`Rotation: ${rotName(f.rotationId)}`);
      lines.push(`Reason: ${f.reason}`);
    }
  }

  return lines.join("\n");
}
