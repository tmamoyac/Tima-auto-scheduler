import { buildStrenuousConsultRotationIds, type LoadedSchedulerStaticData } from "../generateSchedule";
import {
  isStrenuousConsultB2bHardInModel,
  isTransplantB2bHardInModel,
  readB2bHardFromEnv,
  readCpSatHardFlagsFromEnv,
  readRequirementsModeFromEnv,
  type RequirementsMode,
} from "./buildCpSatPayload";
import { rotationVacationOverlapPolicy } from "../vacationOverlapPolicy";
import { debugLog } from "./debug";
import { normalizeSchedulerInput, residentMonthKey, reqKey } from "./normalizeInput";
import type { NormalizedSchedulerInput, RuleViolation, ValidationResult } from "./types";

type AssignmentRow = { resident_id: string; month_id: string; rotation_id: string | null };
type Rotation = LoadedSchedulerStaticData["rotationsList"][number];

function buildLookup(rows: AssignmentRow[]): Map<string, string | null> {
  const lookup = new Map<string, string | null>();
  for (const row of rows) {
    lookup.set(residentMonthKey(row.resident_id, row.month_id), row.rotation_id);
  }
  return lookup;
}

/** Mirror CP-SAT / Phase-2 fixed-rule skips (must stay aligned with buildCpSatPayload). */
export function fixedRuleIsEnforced(
  n: NormalizedSchedulerInput,
  residentId: string,
  monthId: string,
  monthOrderIndex: number,
  fixedRotationId: string
): boolean {
  const { staticData } = n;
  const onVac = n.vacationResidentMonthKeys.has(residentMonthKey(residentId, monthId));
  if (onVac && !staticData.noConsultWhenVacationInMonth) return false;

  const rot = n.rotationsOrdered.find((r: Rotation) => r.id === fixedRotationId);
  if (!rot) return false;
  const cap =
    n.rotationsOrdered.find((r: Rotation) => r.id === fixedRotationId)?.capacity_per_month ?? 0;
  if (cap <= 0) return false;

  const primarySiteRotationIds = new Set(
    n.rotationsOrdered.filter((r: Rotation) => r.is_primary_site).map((r) => r.id)
  );
  const skipPrimaryStart =
    monthOrderIndex === 0 &&
    staticData.requirePgyStartAtPrimarySite &&
    n.residentsOrdered.find((r) => r.id === residentId)?.pgy === staticData.pgyStartAtPrimarySite &&
    primarySiteRotationIds.size > 0 &&
    !primarySiteRotationIds.has(fixedRotationId);
  if (skipPrimaryStart) return false;

  return true;
}

/**
 * Validates a full assignment grid. HARD = what we persist; SOFT = preferences (consult-on-vacation, etc.).
 */
export function validateSchedule(
  staticDataOrNormalized: LoadedSchedulerStaticData | NormalizedSchedulerInput,
  assignmentRows: AssignmentRow[],
  options?: { requirementsMode?: RequirementsMode }
): ValidationResult {
  const n =
    "vacationResidentMonthKeys" in staticDataOrNormalized
      ? staticDataOrNormalized
      : normalizeSchedulerInput(staticDataOrNormalized);

  const reqMode = options?.requirementsMode ?? readRequirementsModeFromEnv();
  const b2bHard = readB2bHardFromEnv();
  const cpFlags = readCpSatHardFlagsFromEnv();

  const hard: RuleViolation[] = [];
  const soft: RuleViolation[] = [];
  const { staticData, residentsOrdered, monthsOrdered, rotationsOrdered, initialRequired } = n;

  const lookup = buildLookup(assignmentRows);

  // --- Completeness: every resident × month has exactly one row ---
  for (const res of residentsOrdered) {
    for (const month of monthsOrdered) {
      const k = residentMonthKey(res.id, month.id);
      if (!lookup.has(k)) {
        hard.push({
          group: "completeness",
          severity: "hard",
          code: "MISSING_CELL",
          message: `No assignment for resident ${res.id} in month ${month.id}.`,
          meta: { residentId: res.id, monthId: month.id },
        });
      }
    }
  }
  debugLog("completeness", `cells expected=${residentsOrdered.length * monthsOrdered.length} rows=${assignmentRows.length}`);

  // --- PGY eligibility (hard) ---
  const rotById = new Map<string, Rotation>(rotationsOrdered.map((r) => [r.id, r]));
  for (const res of residentsOrdered) {
    for (const month of monthsOrdered) {
      const rid = lookup.get(residentMonthKey(res.id, month.id));
      if (rid == null) continue;
      const rot = rotById.get(rid);
      if (!rot) {
        hard.push({
          group: "pgy",
          severity: "hard",
          code: "UNKNOWN_ROTATION",
          message: `Unknown rotation id ${rid}.`,
          meta: { residentId: res.id, monthId: month.id, rotationId: rid },
        });
        continue;
      }
      if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) {
        hard.push({
          group: "pgy",
          severity: "hard",
          code: "PGY_OUT_OF_RANGE",
          message: `PGY ${res.pgy} not eligible for rotation ${rot.name ?? rot.id} (${rot.eligible_pgy_min}–${rot.eligible_pgy_max}).`,
          meta: { residentId: res.id, monthId: month.id, rotationId: rid },
        });
      }
    }
  }

  // --- Vacation forced null (hard): same as CP when !noConsultWhenVacationInMonth ---
  if (!staticData.noConsultWhenVacationInMonth) {
    for (const res of residentsOrdered) {
      for (const month of monthsOrdered) {
        const k = residentMonthKey(res.id, month.id);
        if (!n.vacationResidentMonthKeys.has(k)) continue;
        const assigned = lookup.get(k);
        if (assigned != null) {
          hard.push({
            group: "vacation_null",
            severity: "hard",
            code: "VACATION_MONTH_NOT_NULL",
            message: `Vacation overlap month must be null (off) when "no consult when vacation" is off; resident ${res.id} has rotation in month ${month.id}.`,
            meta: { residentId: res.id, monthId: month.id },
          });
        }
      }
    }
  }

  // --- Rotation vacation-overlap policy (hard prohibited / soft avoid; mirrors CP) ---
  for (const res of residentsOrdered) {
    for (const month of monthsOrdered) {
      const k = residentMonthKey(res.id, month.id);
      if (!n.vacationResidentMonthKeys.has(k)) continue;
      const assigned = lookup.get(k);
      if (assigned == null) continue;
      const rot = rotById.get(assigned);
      if (!rot) continue;
      const pol = rotationVacationOverlapPolicy(rot);
      if (pol === "allowed") continue;
      const mStart = (month.start_date ?? "").trim();
      const mEnd = (month.end_date ?? "").trim();
      const vacSnips = staticData.vacationRanges
        .filter(
          (v) =>
            v.resident_id === res.id && mStart && mEnd && v.start_date <= mEnd && v.end_date >= mStart
        )
        .map((v) => `${v.start_date}–${v.end_date}`);
      const vacLabel = vacSnips.length ? vacSnips.join(", ") : "(vacation overlap this month)";
      const rname = [res.first_name, res.last_name].filter(Boolean).join(" ") || res.id;
      const rotLabel = rot.name ?? rot.id;
      if (pol === "prohibited") {
        hard.push({
          group: "vacation_overlap_policy",
          severity: "hard",
          code: "VACATION_OVERLAP_PROHIBITED_ROTATION",
          message: `${rname} is on ${rotLabel} in month ${month.month_index} but that rotation does not allow vacation overlap (vacation ${vacLabel}).`,
          meta: {
            residentId: res.id,
            monthId: month.id,
            monthIndex: month.month_index,
            rotationId: assigned,
            vacationRanges: vacSnips.join("; "),
          },
        });
      } else {
        soft.push({
          group: "vacation_overlap_policy",
          severity: "soft",
          code: "VACATION_OVERLAP_AVOID_ROTATION",
          message: `${rname} is on ${rotLabel} during a vacation-overlap month (try to avoid; vacation ${vacLabel}).`,
          meta: {
            residentId: res.id,
            monthId: month.id,
            monthIndex: month.month_index,
            rotationId: assigned,
          },
        });
      }
    }
  }

  // --- Fixed rules (hard when enforced) ---
  for (const res of residentsOrdered) {
    for (let mi = 0; mi < monthsOrdered.length; mi++) {
      const month = monthsOrdered[mi];
      const fixedRot = staticData.fixedRuleMap.get(residentMonthKey(res.id, month.id));
      if (!fixedRot) continue;
      if (!fixedRuleIsEnforced(n, res.id, month.id, mi, fixedRot)) continue;
      const actual = lookup.get(residentMonthKey(res.id, month.id)) ?? null;
      if (actual !== fixedRot) {
        hard.push({
          group: "fixed_rules",
          severity: "hard",
          code: "FIXED_RULE_MISMATCH",
          message: `Fixed rule requires rotation ${fixedRot} for resident ${res.id} in month ${month.id}; got ${actual ?? "null"}.`,
          meta: { residentId: res.id, monthId: month.id, expected: fixedRot, actual: actual ?? "null" },
        });
      }
    }
  }

  // --- Capacity per month × rotation (hard) ---
  const counts = new Map<string, number>();
  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const k = `${row.month_id}_${row.rotation_id}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const month of monthsOrdered) {
    for (const rot of rotationsOrdered) {
      const nAss = counts.get(`${month.id}_${rot.id}`) ?? 0;
      if (nAss > rot.capacity_per_month) {
        hard.push({
          group: "capacity",
          severity: "hard",
          code: "CAPACITY_EXCEEDED",
          message: `Month ${month.id} rotation ${rot.name ?? rot.id}: ${nAss} residents, capacity ${rot.capacity_per_month}.`,
          meta: { monthId: month.id, rotationId: rot.id, assigned: nAss, cap: rot.capacity_per_month },
        });
      }
    }
  }

  // --- Requirement counts (hard) ---
  const assignedByReq = new Map<string, number>();
  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const k = reqKey(row.resident_id, row.rotation_id);
    assignedByReq.set(k, (assignedByReq.get(k) ?? 0) + 1);
  }
  for (const res of residentsOrdered) {
    for (const rot of rotationsOrdered) {
      const init = initialRequired.get(reqKey(res.id, rot.id));
      if (init === undefined) continue;
      const got = assignedByReq.get(reqKey(res.id, rot.id)) ?? 0;
      if (init === 0) {
        if (got !== 0) {
          hard.push({
            group: "requirements",
            severity: "hard",
            code: "REQ_FORBIDDEN_ROTATION",
            message: `Resident ${res.id} rotation ${rot.name ?? rot.id}: required 0 months (forbidden in custom matrix), assigned ${got}.`,
            meta: { residentId: res.id, rotationId: rot.id, assigned: got },
          });
        }
        continue;
      }
      if (reqMode === "exact") {
        if (got !== init) {
          hard.push({
            group: "requirements",
            severity: "hard",
            code: "REQ_COUNT_MISMATCH",
            message: `Resident ${res.id} rotation ${rot.name ?? rot.id}: exact ${init} required, assigned ${got}.`,
            meta: { residentId: res.id, rotationId: rot.id, required: init, assigned: got, mode: "exact" },
          });
        }
      } else {
        if (got < init) {
          hard.push({
            group: "requirements",
            severity: "hard",
            code: "REQ_BELOW_MINIMUM",
            message: `Resident ${res.id} rotation ${rot.name ?? rot.id}: min ${init} months, assigned ${got}.`,
            meta: { residentId: res.id, rotationId: rot.id, min: init, assigned: got, mode: "minimum" },
          });
        } else if (got > init) {
          soft.push({
            group: "requirements",
            severity: "soft",
            code: "REQ_ABOVE_MINIMUM",
            message: `Resident ${res.id} rotation ${rot.name ?? rot.id}: min ${init}, assigned ${got} (above minimum).`,
            meta: { residentId: res.id, rotationId: rot.id, min: init, assigned: got, mode: "minimum" },
          });
        }
      }
    }
  }

  // --- Hard spacing (null breaks the chain — same as assignmentHasHardSpacingViolations) ---
  const strenuousIds = buildStrenuousConsultRotationIds(rotationsOrdered);
  const transplantIds = new Set(rotationsOrdered.filter((r: Rotation) => r.is_transplant).map((r) => r.id));
  for (const res of residentsOrdered) {
    for (let mi = 1; mi < monthsOrdered.length; mi++) {
      const a = lookup.get(residentMonthKey(res.id, monthsOrdered[mi - 1].id));
      const b = lookup.get(residentMonthKey(res.id, monthsOrdered[mi].id));
      if (!a || !b) continue;
      if (a === b) {
        const v: RuleViolation = {
          group: "spacing_same_rotation",
          severity: b2bHard.same ? "hard" : "soft",
          code: "SAME_ROTATION_B2B",
          message: `Resident ${res.id}: back-to-back same rotation ${a} at month boundary ${mi - 1}→${mi}.`,
          meta: { residentId: res.id, rotationId: a },
        };
        (b2bHard.same ? hard : soft).push(v);
      }
      if (staticData.avoidBackToBackConsult && strenuousIds.has(a) && strenuousIds.has(b)) {
        const strHard = isStrenuousConsultB2bHardInModel(staticData, cpFlags);
        const v: RuleViolation = {
          group: "spacing_strenuous_b2b",
          severity: strHard ? "hard" : "soft",
          code: "STRENUOUS_B2B",
          message: `Resident ${res.id}: back-to-back strenuous consult rotations ${a} → ${b}.`,
          meta: { residentId: res.id, prev: a, curr: b },
        };
        (strHard ? hard : soft).push(v);
      }
      if (staticData.avoidBackToBackTransplant && transplantIds.has(a) && transplantIds.has(b)) {
        const txHard = isTransplantB2bHardInModel(staticData, cpFlags);
        const v: RuleViolation = {
          group: "spacing_transplant_b2b",
          severity: txHard ? "hard" : "soft",
          code: "TRANSPLANT_B2B",
          message: `Resident ${res.id}: back-to-back transplant rotations ${a} → ${b}.`,
          meta: { residentId: res.id, prev: a, curr: b },
        };
        (txHard ? hard : soft).push(v);
      }
    }
  }

  // --- Soft: consult / strenuous on vacation when toggle on (preference, not persisted as hard) ---
  if (staticData.noConsultWhenVacationInMonth) {
    const consultRotationIdsForVacation = new Set<string>();
    const blockerIds = new Set<string>();
    for (const rot of rotationsOrdered) {
      if ((rot as { is_consult?: boolean }).is_consult) consultRotationIdsForVacation.add(rot.id);
      if ((rot as { is_back_to_back_consult_blocker?: boolean }).is_back_to_back_consult_blocker)
        blockerIds.add(rot.id);
    }
    const consultRotationIdsForBackToBack =
      blockerIds.size > 0 ? blockerIds : consultRotationIdsForVacation;
    const blockedForVac = new Set<string>([
      ...consultRotationIdsForVacation,
      ...consultRotationIdsForBackToBack,
    ]);
    for (const res of residentsOrdered) {
      for (const month of monthsOrdered) {
        if (!n.vacationResidentMonthKeys.has(residentMonthKey(res.id, month.id))) continue;
        const rid = lookup.get(residentMonthKey(res.id, month.id));
        if (!rid || !blockedForVac.has(rid)) continue;
        soft.push({
          group: "vacation_null",
          severity: "soft",
          code: "CONSULT_ON_VACATION",
          message: `Resident ${res.id}: consult/strenuous rotation on a vacation-overlap month (soft).`,
          meta: { residentId: res.id, monthId: month.id, rotationId: rid },
        });
      }
    }
  }

  const ok = hard.length === 0;
  return { ok, hardViolations: hard, softViolations: soft };
}

/** Pretty lines for CLI / logs: first failing hard rule first. */
export function formatValidationReport(v: ValidationResult): string {
  const lines: string[] = [];
  lines.push(`valid=${v.ok} hard=${v.hardViolations.length} soft=${v.softViolations.length}`);
  for (const x of v.hardViolations) {
    lines.push(`[HARD][${x.group}] ${x.code}: ${x.message}`);
  }
  for (const x of v.softViolations) {
    lines.push(`[SOFT][${x.group}] ${x.code}: ${x.message}`);
  }
  return lines.join("\n");
}
