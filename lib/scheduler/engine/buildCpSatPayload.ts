import { buildStrenuousConsultRotationIds, type LoadedSchedulerStaticData } from "../generateSchedule";
import { rotationVacationOverlapPolicy } from "../vacationOverlapPolicy";
import { residentMonthKey, reqKey } from "./normalizeInput";
import type { CpSatHardFlags, NormalizedSchedulerInput } from "./types";
import {
  type CpConstraintMask,
  type CpDomainLayer,
  domainLayerForLadderStage,
  maskForLadderStage,
} from "./cpConstraintMask";

type Rotation = LoadedSchedulerStaticData["rotationsList"][number];

export type RequirementsMode = "exact" | "minimum";

export function readCpSatHardFlagsFromEnv(): CpSatHardFlags {
  const t = (v: string | undefined) => (v ?? "1").trim();
  return {
    hardStrenuousB2b: t(process.env.SCHEDULER_CP_HARD_STRENUOUS_B2B) !== "0",
    hardTransplantB2b: t(process.env.SCHEDULER_CP_HARD_TRANSPLANT_B2B) !== "0",
  };
}

/** Same predicate CP-SAT uses for `avoid_b2b_strenuous` at ladder stage 9 (incl. SCHEDULER_B2B_HARD + CP flags). */
export function isStrenuousConsultB2bHardInModel(
  staticData: { avoidBackToBackConsult: boolean },
  flags: CpSatHardFlags = readCpSatHardFlagsFromEnv()
): boolean {
  const b2b = readB2bHardFromEnv();
  return b2b.strenuous && staticData.avoidBackToBackConsult === true && flags.hardStrenuousB2b;
}

/** Same predicate CP-SAT uses for `avoid_b2b_transplant` at ladder stage 9. */
export function isTransplantB2bHardInModel(
  staticData: { avoidBackToBackTransplant: boolean },
  flags: CpSatHardFlags = readCpSatHardFlagsFromEnv()
): boolean {
  const b2b = readB2bHardFromEnv();
  return b2b.transplant && staticData.avoidBackToBackTransplant === true && flags.hardTransplantB2b;
}

/**
 * `min_months_required` in DB is a minimum; `minimum` matches that. `exact` matches legacy CP/heuristic equality.
 * Default `minimum` — if your year was INFEASIBLE under CP but humans satisfied mins, try this mode first.
 */
export function readRequirementsModeFromEnv(): RequirementsMode {
  const v = (process.env.SCHEDULER_REQ_MODE ?? "minimum").trim().toLowerCase();
  return v === "exact" ? "exact" : "minimum";
}

/** When false, that B2B class is omitted from CP and reported as soft in validateSchedule (not hard). */
export function readB2bHardFromEnv(): { same: boolean; strenuous: boolean; transplant: boolean } {
  const v = (process.env.SCHEDULER_B2B_HARD ?? "1").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "soft" || v === "off") {
    return { same: false, strenuous: false, transplant: false };
  }
  return { same: true, strenuous: true, transplant: true };
}

export type BuildCpSatOptions = {
  /** 1–9 feasibility ladder; sets domain layer + default constraint mask when `constraintMask` omitted */
  ladderStage?: number;
  constraintMask?: CpConstraintMask;
  requirementsMode?: RequirementsMode;
  /** Seconds for this solve (ladder uses shorter early stages) */
  maxSecondsOverride?: number;
};

function mergeMask(base: CpConstraintMask, override?: CpConstraintMask): CpConstraintMask {
  if (!override) return base;
  return { ...base, ...override };
}

export type AllowedValuesAndFixedResult = {
  allowedValues: number[][][];
  fixedTriples: number[][];
  vacationForcedCells: number;
  /** [ri, mi, rotation_1based_index] — soft objective terms in CP-SAT when policy is `avoid`. */
  vacationOverlapSoftTriples: number[][];
};

/**
 * Build allowed_values + fixed triples for a domain layer (feasibility ladder vs production).
 */
export function buildAllowedValuesAndFixed(
  n: NormalizedSchedulerInput,
  domainLayer: CpDomainLayer
): AllowedValuesAndFixedResult {
  const { staticData, residentsOrdered, monthsOrdered, rotationsOrdered, rotIndexById } = n;
  const R = residentsOrdered.length;
  const M = monthsOrdered.length;
  const K = rotationsOrdered.length;

  const fullDom = [...Array(K + 1).keys()];

  const transplantRotationIds = new Set<string>();
  const primarySiteRotationIds = new Set<string>();
  for (const rot of rotationsOrdered) {
    if (rot.is_transplant) transplantRotationIds.add(rot.id);
    if (rot.is_primary_site) primarySiteRotationIds.add(rot.id);
  }

  const initialCap = (monthId: string, rotId: string): number => {
    const rot = rotationsOrdered.find((r) => r.id === rotId);
    return rot?.capacity_per_month ?? 0;
  };

  const allowedValues: number[][][] = [];
  const fixedTriples: number[][] = [];
  const vacationOverlapSoftTriples: number[][] = [];
  let vacationForcedCells = 0;

  for (let ri = 0; ri < R; ri++) {
    const row: number[][] = [];
    const res = residentsOrdered[ri];
    for (let mi = 0; mi < M; mi++) {
      const month = monthsOrdered[mi];

      if (domainLayer === 1) {
        row.push([...fullDom]);
        continue;
      }

      const onVac = n.vacationResidentMonthKeys.has(residentMonthKey(res.id, month.id));
      const forceNullVacation = onVac && !staticData.noConsultWhenVacationInMonth;

      if (forceNullVacation) {
        vacationForcedCells++;
        row.push([0]);
        continue;
      }

      const ruleRotId = staticData.fixedRuleMap.get(residentMonthKey(res.id, month.id));
      let fixedRotIdx: number | null = null;
      if (domainLayer >= 4 && ruleRotId) {
        const idx = rotIndexById.get(ruleRotId);
        const ruleRot = rotationsOrdered.find((r: Rotation) => r.id === ruleRotId);
        const capOk = idx != null && ruleRot && initialCap(month.id, ruleRotId) > 0;
        const skipPrimaryStart =
          mi === 0 &&
          staticData.requirePgyStartAtPrimarySite &&
          res.pgy === staticData.pgyStartAtPrimarySite &&
          primarySiteRotationIds.size > 0 &&
          !primarySiteRotationIds.has(ruleRotId);
        if (capOk && !skipPrimaryStart && idx != null) {
          fixedRotIdx = idx;
        }
      }

      if (fixedRotIdx != null) {
        const fixedRot = rotationsOrdered[fixedRotIdx - 1];
        const fixedPol = fixedRot ? rotationVacationOverlapPolicy(fixedRot) : "allowed";
        if (fixedPol === "prohibited" && onVac) {
          const dom = new Set<number>();
          dom.add(0);
          if (domainLayer <= 2) {
            for (let j = 1; j <= K; j++) dom.add(j);
          } else {
            for (const rot of rotationsOrdered) {
              const j = rotIndexById.get(rot.id);
              if (j == null) continue;
              if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) continue;
              dom.add(j);
            }
          }
          dom.delete(fixedRotIdx);
          row.push([...dom].sort((a, b) => a - b));
          fixedTriples.push([ri, mi, fixedRotIdx]);
          continue;
        }
        row.push([fixedRotIdx]);
        fixedTriples.push([ri, mi, fixedRotIdx]);
        if (onVac && domainLayer >= 3 && fixedPol === "avoid") {
          vacationOverlapSoftTriples.push([ri, mi, fixedRotIdx]);
        }
        continue;
      }

      const dom = new Set<number>();
      dom.add(0);
      if (domainLayer <= 2) {
        for (let j = 1; j <= K; j++) dom.add(j);
      } else {
        for (const rot of rotationsOrdered) {
          const j = rotIndexById.get(rot.id);
          if (j == null) continue;
          if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) continue;
          dom.add(j);
        }
      }
      if (onVac && domainLayer >= 3) {
        for (const j of [...dom]) {
          if (j < 1) continue;
          const rot = rotationsOrdered[j - 1];
          if (rot && rotationVacationOverlapPolicy(rot) === "prohibited") {
            dom.delete(j);
          }
        }
      }
      if (onVac && domainLayer >= 3) {
        for (const j of dom) {
          if (j < 1) continue;
          const rot = rotationsOrdered[j - 1];
          if (rot && rotationVacationOverlapPolicy(rot) === "avoid") {
            vacationOverlapSoftTriples.push([ri, mi, j]);
          }
        }
      }
      row.push([...dom].sort((a, b) => a - b));
    }
    allowedValues.push(row);
  }

  return { allowedValues, fixedTriples, vacationForcedCells, vacationOverlapSoftTriples };
}

/** JSON payload for scripts/solve_schedule_cp_sat.py — built only from normalized input (no drift). */
export function buildCpSatJsonPayload(
  n: NormalizedSchedulerInput,
  flags: CpSatHardFlags = readCpSatHardFlagsFromEnv(),
  opts?: BuildCpSatOptions
): Record<string, unknown> {
  const stage = opts?.ladderStage ?? 9;
  const domainLayer = domainLayerForLadderStage(stage);
  const defaultMask = maskForLadderStage(stage);
  const mask = mergeMask(defaultMask, opts?.constraintMask);
  const b2bHard = readB2bHardFromEnv();
  const requirementsMode = opts?.requirementsMode ?? readRequirementsModeFromEnv();

  const { staticData, residentsOrdered, monthsOrdered, rotationsOrdered, initialRequired, rotIndexById } = n;

  const R = residentsOrdered.length;
  const M = monthsOrdered.length;
  const K = rotationsOrdered.length;

  const { allowedValues, fixedTriples, vacationForcedCells, vacationOverlapSoftTriples } =
    buildAllowedValuesAndFixed(n, domainLayer);

  const policyCounts = (() => {
    let a = 0,
      v = 0,
      p = 0;
    for (const rot of rotationsOrdered) {
      const pol = rotationVacationOverlapPolicy(rot);
      if (pol === "avoid") v++;
      else if (pol === "prohibited") p++;
      else a++;
    }
    return { allowed: a, avoid: v, prohibited: p };
  })();

  let pgyRestrictedCells = 0;
  if (domainLayer >= 3) {
    for (let ri = 0; ri < R; ri++) {
      for (let mi = 0; mi < M; mi++) {
        const d = allowedValues[ri][mi];
        if (d.length === 1 && d[0] === 0) continue;
        if (d.length === 1) continue;
        if (d.length < K + 1) pgyRestrictedCells++;
      }
    }
  }

  const fixedForCp = mask.fixed_triples ? fixedTriples : [];

  const requiredTriples: number[][] = [];
  for (let ri = 0; ri < R; ri++) {
    const res = residentsOrdered[ri];
    for (const rot of rotationsOrdered) {
      const j = rotIndexById.get(rot.id);
      if (j == null) continue;
      const init = initialRequired.get(reqKey(res.id, rot.id));
      if (init === undefined) continue;
      requiredTriples.push([ri, j, init]);
    }
  }

  const capacity: number[][] = [];
  for (let mi = 0; mi < M; mi++) {
    const row: number[] = [];
    for (const rot of rotationsOrdered) {
      row.push(rot.capacity_per_month);
    }
    capacity.push(row);
  }

  const transplantRotationIds = new Set<string>();
  for (const rot of rotationsOrdered) {
    if (rot.is_transplant) transplantRotationIds.add(rot.id);
  }

  const strenuousIds = buildStrenuousConsultRotationIds(rotationsOrdered);
  const strenuous_indices: number[] = [];
  for (const rot of rotationsOrdered) {
    if (strenuousIds.has(rot.id)) {
      const j = rotIndexById.get(rot.id);
      if (j != null) strenuous_indices.push(j);
    }
  }

  const transplant_indices: number[] = [];
  for (const rot of rotationsOrdered) {
    if (transplantRotationIds.has(rot.id)) {
      const j = rotIndexById.get(rot.id);
      if (j != null) transplant_indices.push(j);
    }
  }

  const maxSeconds =
    opts?.maxSecondsOverride ??
    Math.min(120, Math.max(5, Number(process.env.CP_SAT_MAX_SECONDS ?? 90) || 90));

  const applyStrenuous = mask.b2b_strenuous && isStrenuousConsultB2bHardInModel(staticData, flags);
  const applyTransplant = mask.b2b_transplant && isTransplantB2bHardInModel(staticData, flags);
  const applySame = mask.b2b_same && b2bHard.same;

  return {
    n_residents: R,
    n_months: M,
    n_rotations: K,
    allowed_values: allowedValues,
    fixed: fixedForCp,
    required: requiredTriples,
    capacity,
    /** Python: use constraint_mask to enable groups */
    constraint_mask: mask,
    ladder_stage: stage,
    requirements_mode: requirementsMode,
    b2b_same: applySame,
    avoid_b2b_strenuous: applyStrenuous,
    strenuous_indices,
    avoid_b2b_transplant: applyTransplant,
    transplant_indices,
    max_seconds: stage < 9 ? Math.min(maxSeconds, 25) : maxSeconds,
    vacation_overlap_soft_triples: vacationOverlapSoftTriples,
    hard_flags: {
      ladder_stage: stage,
      constraint_mask: mask,
      requirements_mode: requirementsMode,
      b2b_same: applySame,
      strenuous_b2b: applyStrenuous,
      transplant_b2b: applyTransplant,
      vacation_forced_cells: vacationForcedCells,
      pgy_restricted_cells: pgyRestrictedCells,
      vacation_overlap_soft_triple_count: vacationOverlapSoftTriples.length,
      vacation_overlap_policy_rotations: policyCounts,
    },
  };
}

/** Stats for ladder logging (counts match payload sent to Python). */
export function countPayloadStats(
  n: NormalizedSchedulerInput,
  payload: Record<string, unknown>
): {
  residents: number;
  months: number;
  rotations: number;
  requiredTriples: number;
  fixedTriples: number;
  vacationForcedCells: number;
} {
  const fixed = (payload.fixed as number[][]) ?? [];
  const req = (payload.required as number[][]) ?? [];
  const hf = (payload.hard_flags as Record<string, number>) ?? {};
  return {
    residents: n.residentsOrdered.length,
    months: n.monthsOrdered.length,
    rotations: n.rotationsOrdered.length,
    requiredTriples: req.filter((t) => t[2] !== 0).length,
    fixedTriples: fixed.length,
    vacationForcedCells: Number(hf.vacation_forced_cells ?? 0),
  };
}

export function gridToAssignmentRows(
  n: NormalizedSchedulerInput,
  grid: number[][]
): { resident_id: string; month_id: string; rotation_id: string | null }[] {
  const { residentsOrdered, monthsOrdered, rotationsOrdered } = n;
  const rows: { resident_id: string; month_id: string; rotation_id: string | null }[] = [];
  for (let ri = 0; ri < residentsOrdered.length; ri++) {
    for (let mi = 0; mi < monthsOrdered.length; mi++) {
      const v = grid[ri][mi];
      const rotation_id =
        v === 0 ? null : rotationsOrdered[v - 1] ? rotationsOrdered[v - 1].id : null;
      rows.push({
        resident_id: residentsOrdered[ri].id,
        month_id: monthsOrdered[mi].id,
        rotation_id,
      });
    }
  }
  return rows;
}
