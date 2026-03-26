/**
 * validateWitnessSchedule(witnessRows, schedulerConfig) — hard rules only, aligned with CP-SAT + validateSchedule.
 */
import { buildStrenuousConsultRotationIds, type LoadedSchedulerStaticData } from "../generateSchedule";
import {
  isStrenuousConsultB2bHardInModel,
  isTransplantB2bHardInModel,
  readB2bHardFromEnv,
  readRequirementsModeFromEnv,
  type RequirementsMode,
} from "./buildCpSatPayload";
import { normalizeSchedulerInput, residentMonthKey, reqKey } from "./normalizeInput";
import { fixedRuleIsEnforced } from "./validateSchedule";
import { academicMonthLabelFromIndex } from "./validateScheduleDetailed";
import type { NormalizedSchedulerInput } from "./types";

export type WitnessRow = { resident_id: string; month_id: string; rotation_id: string | null };

export type ValidateWitnessOptions = {
  requirementsMode?: RequirementsMode;
  /** If true, stop at first FAIL and omit PASS lines (and omit later rules). */
  firstFailureOnly?: boolean;
};

export type WitnessValidationResult = {
  allPassed: boolean;
  lines: string[];
  firstFailureRule: string | null;
  /** Multiline text for first failure only (includes Source lines). */
  firstFailureBlock: string | null;
};

export const WITNESS_RULE_META: Record<
  string,
  { sourceFile: string; sourceFunction: string }
> = {
  monthly_capacity: {
    sourceFile: "lib/scheduler/engine/validateSchedule.ts",
    sourceFunction: "validateSchedule (capacity per month × rotation)",
  },
  one_assignment_per_month: {
    sourceFile: "lib/scheduler/engine/validateSchedule.ts",
    sourceFunction: "validateSchedule (completeness)",
  },
  pgy_domain_eligibility: {
    sourceFile: "lib/scheduler/engine/validateSchedule.ts",
    sourceFunction: "validateSchedule (PGY eligibility)",
  },
  vacation_conflict: {
    sourceFile: "lib/scheduler/engine/validateSchedule.ts",
    sourceFunction: "validateSchedule (vacation forced null)",
  },
  fixed_rules: {
    sourceFile: "lib/scheduler/engine/validateSchedule.ts",
    sourceFunction: "validateSchedule (fixed rules)",
  },
  exact_rotation_count: {
    sourceFile: "lib/scheduler/engine/validateSchedule.ts",
    sourceFunction: "validateSchedule (requirement counts)",
  },
  below_minimum_rotation_months: {
    sourceFile: "lib/scheduler/engine/validateSchedule.ts",
    sourceFunction: "validateSchedule (requirement counts, minimum mode)",
  },
  same_rotation_b2b: {
    sourceFile: "lib/scheduler/generateSchedule.ts",
    sourceFunction: "assignmentHasHardSpacingViolations",
  },
  strenuous_consult_b2b: {
    sourceFile: "lib/scheduler/generateSchedule.ts",
    sourceFunction: "buildStrenuousConsultRotationIds + assignmentHasHardSpacingViolations",
  },
  transplant_b2b: {
    sourceFile: "lib/scheduler/generateSchedule.ts",
    sourceFunction: "assignmentHasHardSpacingViolations (transplant)",
  },
  hidden_full_year_assignment: {
    sourceFile: "lib/scheduler/engine/witnessValidate.ts",
    sourceFunction: "validateWitnessSchedule (documentary check)",
  },
};

function residentLabel(n: NormalizedSchedulerInput, id: string): string {
  const r = n.residentsOrdered.find((x) => x.id === id);
  if (!r) return id;
  const p = [r.first_name, r.last_name].filter(Boolean).join(" ");
  return p || id;
}

function rotationLabel(n: NormalizedSchedulerInput, rid: string | null | undefined): string {
  if (rid == null || rid === "") return "—";
  return n.rotationsOrdered.find((x) => x.id === rid)?.name?.trim() || rid;
}

function monthPairLabel(n: NormalizedSchedulerInput, prevMonthId: string, currMonthId: string): string {
  const a = n.monthsOrdered.find((m) => m.id === prevMonthId);
  const b = n.monthsOrdered.find((m) => m.id === currMonthId);
  if (!a || !b) return `${prevMonthId} -> ${currMonthId}`;
  return `${academicMonthLabelFromIndex(a.month_index)} -> ${academicMonthLabelFromIndex(b.month_index)}`;
}

function pushSource(lines: string[], rule: string): void {
  const m = WITNESS_RULE_META[rule];
  lines.push(`Source File: ${m?.sourceFile ?? "unknown"}`);
  lines.push(`Source Function: ${m?.sourceFunction ?? "unknown"}`);
}

/**
 * Validate witness assignment rows against every enforced hard rule (same order as solver audit).
 */
export function validateWitnessSchedule(
  witnessRows: WitnessRow[],
  schedulerConfig: LoadedSchedulerStaticData,
  options?: ValidateWitnessOptions
): WitnessValidationResult {
  const firstOnly = options?.firstFailureOnly === true;
  const n = normalizeSchedulerInput(schedulerConfig);
  const reqMode = options?.requirementsMode ?? readRequirementsModeFromEnv();
  const b2bHard = readB2bHardFromEnv();
  const lines: string[] = [];
  const { staticData: sd, residentsOrdered, monthsOrdered, rotationsOrdered, initialRequired } = n;
  const strenuousB2bHard = isStrenuousConsultB2bHardInModel(sd);
  const transplantB2bHard = isTransplantB2bHardInModel(sd);
  const rotById = new Map(rotationsOrdered.map((r) => [r.id, r]));
  const lookup = new Map<string, string | null>();
  const rowCountByCell = new Map<string, number>();
  for (const row of witnessRows) {
    const k = residentMonthKey(row.resident_id, row.month_id);
    lookup.set(k, row.rotation_id);
    rowCountByCell.set(k, (rowCountByCell.get(k) ?? 0) + 1);
  }

  const fail = (rule: string, parts: string[]): WitnessValidationResult => {
    const failLines = [`FAIL: ${rule}`, ...parts];
    pushSource(failLines, rule);
    const block = failLines.join("\n");
    return {
      allPassed: false,
      lines: [...lines, ...failLines],
      firstFailureRule: rule,
      firstFailureBlock: block,
    };
  };

  const pass = (rule: string) => {
    if (!firstOnly) lines.push(`PASS: ${rule}`);
  };

  const counts = new Map<string, number>();
  for (const row of witnessRows) {
    if (!row.rotation_id) continue;
    const k = `${row.month_id}_${row.rotation_id}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const month of monthsOrdered) {
    for (const rot of rotationsOrdered) {
      const nAss = counts.get(`${month.id}_${rot.id}`) ?? 0;
      if (nAss > rot.capacity_per_month) {
        return fail("monthly_capacity", [
          `Resident: (aggregate across program)`,
          `Month or Month Pair: ${academicMonthLabelFromIndex(month.month_index)}`,
          `Rotation: ${rot.name ?? rot.id}`,
          `Expected: at most ${rot.capacity_per_month} resident(s)`,
          `Actual: ${nAss} resident(s)`,
          `Reason: capacity_per_month exceeded`,
        ]);
      }
    }
  }
  pass("monthly_capacity");

  for (const res of residentsOrdered) {
    for (const month of monthsOrdered) {
      const k = residentMonthKey(res.id, month.id);
      const c = rowCountByCell.get(k) ?? 0;
      if (c === 0) {
        return fail("one_assignment_per_month", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Month or Month Pair: ${academicMonthLabelFromIndex(month.month_index)}`,
          `Rotation: —`,
          `Expected: exactly 1 assignment`,
          `Actual: 0`,
          `Reason: missing row for this resident–month`,
        ]);
      }
      if (c > 1) {
        return fail("one_assignment_per_month", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Month or Month Pair: ${academicMonthLabelFromIndex(month.month_index)}`,
          `Rotation: —`,
          `Expected: exactly 1 assignment`,
          `Actual: ${c} duplicate rows`,
          `Reason: duplicate witness rows for same cell`,
        ]);
      }
    }
  }
  pass("one_assignment_per_month");

  for (const res of residentsOrdered) {
    for (const month of monthsOrdered) {
      const rid = lookup.get(residentMonthKey(res.id, month.id));
      if (rid == null) continue;
      const rot = rotById.get(rid);
      if (!rot) {
        return fail("pgy_domain_eligibility", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Month or Month Pair: ${academicMonthLabelFromIndex(month.month_index)}`,
          `Rotation: ${rid}`,
          `Expected: known rotation id from setup`,
          `Actual: unknown id`,
          `Reason: rotation_id not found in scheduler config`,
        ]);
      }
      if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) {
        return fail("pgy_domain_eligibility", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Month or Month Pair: ${academicMonthLabelFromIndex(month.month_index)}`,
          `Rotation: ${rot.name ?? rot.id}`,
          `Expected: PGY in [${rot.eligible_pgy_min}, ${rot.eligible_pgy_max}]`,
          `Actual: PGY ${res.pgy}`,
          `Reason: eligible_pgy_min / eligible_pgy_max`,
        ]);
      }
    }
  }
  pass("pgy_domain_eligibility");

  if (!sd.noConsultWhenVacationInMonth) {
    for (const res of residentsOrdered) {
      for (const month of monthsOrdered) {
        const k = residentMonthKey(res.id, month.id);
        if (!n.vacationResidentMonthKeys.has(k)) continue;
        const assigned = lookup.get(k);
        if (assigned != null) {
          return fail("vacation_conflict", [
            `Resident: ${residentLabel(n, res.id)}`,
            `Month or Month Pair: ${academicMonthLabelFromIndex(month.month_index)}`,
            `Rotation: ${rotationLabel(n, assigned)}`,
            `Expected: null (off month)`,
            `Actual: assigned rotation`,
            `Reason: vacation overlap with academic month while program forces consult off`,
          ]);
        }
      }
    }
  }
  pass("vacation_conflict");

  for (const res of residentsOrdered) {
    for (let mi = 0; mi < monthsOrdered.length; mi++) {
      const month = monthsOrdered[mi];
      const fixedRot = sd.fixedRuleMap.get(residentMonthKey(res.id, month.id));
      if (!fixedRot) continue;
      if (!fixedRuleIsEnforced(n, res.id, month.id, mi, fixedRot)) continue;
      const actual = lookup.get(residentMonthKey(res.id, month.id)) ?? null;
      if (actual !== fixedRot) {
        return fail("fixed_rules", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Month or Month Pair: ${academicMonthLabelFromIndex(month.month_index)}`,
          `Rotation: ${rotationLabel(n, actual)}`,
          `Expected: ${rotationLabel(n, fixedRot)}`,
          `Actual: ${rotationLabel(n, actual)}`,
          `Reason: enforced fixed rule mismatch`,
        ]);
      }
    }
  }
  pass("fixed_rules");

  const assignedByReq = new Map<string, number>();
  for (const row of witnessRows) {
    if (!row.rotation_id) continue;
    const rk = reqKey(row.resident_id, row.rotation_id);
    assignedByReq.set(rk, (assignedByReq.get(rk) ?? 0) + 1);
  }
  for (const res of residentsOrdered) {
    for (const rot of rotationsOrdered) {
      const init = initialRequired.get(reqKey(res.id, rot.id));
      if (init === undefined) continue;
      const got = assignedByReq.get(reqKey(res.id, rot.id)) ?? 0;
      if (init === 0 && got !== 0) {
        return fail("exact_rotation_count", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Rotation: ${rot.name ?? rot.id}`,
          `Expected: 0 months (forbidden in custom matrix)`,
          `Actual: ${got}`,
          `Reason: rotation marked required 0 but witness assigns it`,
        ]);
      }
      if (init === 0) continue;
      if (reqMode === "exact" && got !== init) {
        return fail("exact_rotation_count", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Rotation: ${rot.name ?? rot.id}`,
          `Expected: ${init} (exact mode)`,
          `Actual: ${got}`,
          `Reason: SCHEDULER_REQ_MODE=exact count mismatch`,
        ]);
      }
      if (reqMode === "minimum" && got < init) {
        return fail("below_minimum_rotation_months", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Rotation: ${rot.name ?? rot.id}`,
          `Expected: at least ${init}`,
          `Actual: ${got}`,
          `Reason: below min_months_required`,
        ]);
      }
    }
  }
  pass(`rotation_requirements_${reqMode}`);

  const strenuousIds = buildStrenuousConsultRotationIds(rotationsOrdered);
  const transplantIds = new Set(rotationsOrdered.filter((r) => r.is_transplant).map((r) => r.id));
  for (const res of residentsOrdered) {
    for (let mi = 1; mi < monthsOrdered.length; mi++) {
      const prevM = monthsOrdered[mi - 1]!;
      const currM = monthsOrdered[mi]!;
      const a = lookup.get(residentMonthKey(res.id, prevM.id));
      const b = lookup.get(residentMonthKey(res.id, currM.id));
      if (!a || !b) continue;
      if (b2bHard.same && a === b) {
        return fail("same_rotation_b2b", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Month or Month Pair: ${monthPairLabel(n, prevM.id, currM.id)}`,
          `Rotation: ${rotationLabel(n, a)}`,
          `Expected: different rotation across consecutive months`,
          `Actual: same rotation twice`,
          `Reason: same-rotation back-to-back hard rule`,
        ]);
      }
      if (strenuousB2bHard && strenuousIds.has(a) && strenuousIds.has(b)) {
        return fail("strenuous_consult_b2b", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Month or Month Pair: ${monthPairLabel(n, prevM.id, currM.id)}`,
          `Rotation: ${rotationLabel(n, a)} -> ${rotationLabel(n, b)}`,
          `Expected: not both in strenuous B2B set on consecutive months`,
          `Actual: both marked is_back_to_back_consult_blocker`,
          `Reason: CP hard model forbids consecutive blocker consult months (SCHEDULER_B2B_HARD + SCHEDULER_CP_HARD_STRENUOUS_B2B + avoid back-to-back consult)`,
        ]);
      }
      if (transplantB2bHard && transplantIds.has(a) && transplantIds.has(b)) {
        return fail("transplant_b2b", [
          `Resident: ${residentLabel(n, res.id)}`,
          `Month or Month Pair: ${monthPairLabel(n, prevM.id, currM.id)}`,
          `Rotation: ${rotationLabel(n, a)} -> ${rotationLabel(n, b)}`,
          `Expected: not two transplant months in a row`,
          `Actual: both is_transplant`,
          `Reason: avoid back-to-back transplant`,
        ]);
      }
    }
  }
  if (!firstOnly) {
    lines.push(
      b2bHard.same ? "PASS: same_rotation_b2b" : "PASS: same_rotation_b2b (soft via SCHEDULER_B2B_HARD)"
    );
    lines.push(strenuousB2bHard ? "PASS: strenuous_consult_b2b" : "PASS: strenuous_consult_b2b_skipped_not_cp_hard");
    lines.push(transplantB2bHard ? "PASS: transplant_b2b" : "PASS: transplant_b2b_skipped_not_cp_hard");
  }

  if (!firstOnly) {
    lines.push(
      "PASS: hidden_full_year_assignment (engine does not require 12 non-null months; one CP variable per cell, domain allows null)"
    );
  }

  return {
    allPassed: true,
    lines,
    firstFailureRule: null,
    firstFailureBlock: null,
  };
}
