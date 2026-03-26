import {
  computeInitialRequiredMap,
  schedulerStaticDataFromSerializedJson,
  type LoadedSchedulerStaticData,
} from "../generateSchedule";
import { rotationVacationOverlapPolicy } from "../vacationOverlapPolicy";
import {
  buildCpSatJsonPayload,
  gridToAssignmentRows,
  readCpSatHardFlagsFromEnv,
  readRequirementsModeFromEnv,
} from "./buildCpSatPayload";
import { CP_FEASIBLE, CP_OPTIMAL, invokeCpSatSolverLocalSync } from "./cpSatInvoke";
import { normalizeSchedulerInput, reqKey } from "./normalizeInput";

export type FixedRowClassification =
  | "valid_intentional_fixed_row"
  | "impossible_given_other_fixed_rows"
  | "blank_or_invalid_saved_fixed_row"
  | "mapping_bug"
  | "unknown";

export type FixedRulePair = readonly [key: string, rotationId: string];

function parseResidentMonthKey(key: string): { residentId: string; monthId: string } | null {
  const i = key.indexOf("_");
  if (i <= 0 || i >= key.length - 1) return null;
  return { residentId: key.slice(0, i), monthId: key.slice(i + 1) };
}

function staticFromRawWithFixed(
  raw: Record<string, unknown>,
  pairs: FixedRulePair[]
): LoadedSchedulerStaticData {
  return schedulerStaticDataFromSerializedJson({
    ...raw,
    fixedRuleMap: pairs.map(([k, r]) => [k, r]),
  });
}

function stage9Sat(staticData: LoadedSchedulerStaticData): boolean {
  const n = normalizeSchedulerInput(staticData);
  const flags = readCpSatHardFlagsFromEnv();
  const reqMode = readRequirementsModeFromEnv();
  const payload = buildCpSatJsonPayload(n, flags, { ladderStage: 9, requirementsMode: reqMode });
  const raw = invokeCpSatSolverLocalSync(payload as Record<string, unknown>);
  return (
    raw.ok &&
    raw.grid != null &&
    (raw.status === CP_OPTIMAL || raw.status === CP_FEASIBLE)
  );
}

function stage8WitnessGrid(staticData: LoadedSchedulerStaticData): number[][] | null {
  const n = normalizeSchedulerInput(staticData);
  const flags = readCpSatHardFlagsFromEnv();
  const reqMode = readRequirementsModeFromEnv();
  const payload = buildCpSatJsonPayload(n, flags, { ladderStage: 8, requirementsMode: reqMode });
  const raw = invokeCpSatSolverLocalSync(payload as Record<string, unknown>);
  if (!raw.ok || raw.grid == null || (raw.status !== CP_OPTIMAL && raw.status !== CP_FEASIBLE)) {
    return null;
  }
  return raw.grid;
}

/** Mirrors domain-layer-4 enforcement in buildAllowedValuesAndFixed (stage 9). */
export function fixedRuleWouldBeEnforcedInStage9(
  staticData: LoadedSchedulerStaticData,
  key: string,
  rotationId: string
): { enforced: boolean; reasonIfNot: string | null } {
  const parsed = parseResidentMonthKey(key);
  if (!parsed) return { enforced: false, reasonIfNot: "bad_key_format" };
  const { residentId, monthId } = parsed;
  const res = staticData.residentsList.find((r) => r.id === residentId);
  const month = staticData.monthsList.find((m) => m.id === monthId);
  const rot = staticData.rotationsList.find((r) => r.id === rotationId);
  if (!res || !month || !rot) return { enforced: false, reasonIfNot: "unknown_resident_month_or_rotation" };

  const n = normalizeSchedulerInput(staticData);
  if (n.vacationResidentMonthKeys.has(key) && rotationVacationOverlapPolicy(rot) === "prohibited") {
    return { enforced: false, reasonIfNot: "rotation_prohibited_on_vacation_overlap_month" };
  }
  if (n.vacationResidentMonthKeys.has(key) && !staticData.noConsultWhenVacationInMonth) {
    return { enforced: false, reasonIfNot: "vacation_forced_off_month_cell_cannot_hold_rotation" };
  }

  const idx = n.rotIndexById.get(rotationId);
  const cap =
    staticData.rotationsList.find((r) => r.id === rotationId)?.capacity_per_month ?? 0;
  if (idx == null || cap <= 0) return { enforced: false, reasonIfNot: "rotation_missing_or_zero_capacity" };

  const monthsOrdered = [...staticData.monthsList].sort((a, b) => a.month_index - b.month_index);
  const mi = monthsOrdered.findIndex((m) => m.id === monthId);
  const primarySiteRotationIds = new Set(
    staticData.rotationsList.filter((r) => r.is_primary_site).map((r) => r.id)
  );
  if (
    mi === 0 &&
    staticData.requirePgyStartAtPrimarySite &&
    res.pgy === staticData.pgyStartAtPrimarySite &&
    primarySiteRotationIds.size > 0 &&
    !primarySiteRotationIds.has(rotationId)
  ) {
    return { enforced: false, reasonIfNot: "primary_site_start_rule_skips_this_rotation_in_month_1" };
  }

  return { enforced: true, reasonIfNot: null };
}

function sumRequiredMonthsForResident(staticData: LoadedSchedulerStaticData, residentId: string): number {
  const m = computeInitialRequiredMap(staticData);
  let s = 0;
  for (const rot of staticData.rotationsList) {
    const v = m.get(reqKey(residentId, rot.id));
    if (v != null && v > 0) s += v;
  }
  return s;
}

export type Stage8ResidentAssignmentAudit = {
  residentId: string;
  residentName: string;
  sumMinMonthsRequired: number;
  assignedClinicalMonthsInWitness: number;
  witnessHasAllNullWhenRequirementsPositive: boolean;
};

export function auditStage8WitnessVsRequirements(
  staticData: LoadedSchedulerStaticData,
  grid: number[][]
): Stage8ResidentAssignmentAudit[] {
  const n = normalizeSchedulerInput(staticData);
  const rows = gridToAssignmentRows(n, grid);
  const byRes = new Map<string, number>();
  for (const r of rows) {
    if (r.rotation_id) {
      byRes.set(r.resident_id, (byRes.get(r.resident_id) ?? 0) + 1);
    }
  }
  return staticData.residentsList.map((res) => {
    const sumReq = sumRequiredMonthsForResident(staticData, res.id);
    const assigned = byRes.get(res.id) ?? 0;
    const name = [res.first_name, res.last_name].filter(Boolean).join(" ");
    return {
      residentId: res.id,
      residentName: name || res.id,
      sumMinMonthsRequired: sumReq,
      assignedClinicalMonthsInWitness: assigned,
      witnessHasAllNullWhenRequirementsPositive: sumReq > 0 && assigned === 0,
    };
  });
}

/**
 * Shrinks an infeasible fixed set to a minimal subset that is still infeasible at stage 9
 * (every proper subset is feasible).
 */
export function minimalInfeasibleFixedSubset(
  raw: Record<string, unknown>,
  pairs: FixedRulePair[]
): FixedRulePair[] {
  if (pairs.length === 0) return [];
  let S = [...pairs];
  if (stage9Sat(staticFromRawWithFixed(raw, S))) return [];

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < S.length; i++) {
      const rest = S.filter((_, j) => j !== i);
      if (rest.length === 0) break;
      if (!stage9Sat(staticFromRawWithFixed(raw, rest))) {
        S = rest;
        changed = true;
        break;
      }
    }
  }
  return S;
}

function heuristicContradiction(
  staticData: LoadedSchedulerStaticData,
  core: FixedRulePair[]
): string {
  if (core.length === 0) return "No infeasible fixed subset (full fixed set is feasible).";
  const lines: string[] = [];
  lines.push(
    `Stage-9 CP-SAT is INFEASIBLE with this fixed set but feasible if any one of these ${core.length} pins is removed (minimal irreducible core). OR-Tools does not emit an IIS in this bridge; below is a structural sketch.`
  );

  const rotCap = new Map<string, number>();
  for (const r of staticData.rotationsList) rotCap.set(r.id, r.capacity_per_month ?? 0);

  const byMonth = new Map<string, FixedRulePair[]>();
  for (const [k, rid] of core) {
    const p = parseResidentMonthKey(k);
    if (!p) continue;
    const arr = byMonth.get(p.monthId) ?? [];
    arr.push([k, rid]);
    byMonth.set(p.monthId, arr);
  }
  for (const [mid, rows] of byMonth) {
    const byRot = new Map<string, number>();
    for (const [, rid] of rows) byRot.set(rid, (byRot.get(rid) ?? 0) + 1);
    const month = staticData.monthsList.find((m) => m.id === mid);
    const label = month ? `month_index=${month.month_index}` : mid;
    for (const [rid, cnt] of byRot) {
      const cap = rotCap.get(rid) ?? 0;
      if (cnt > cap && cap > 0) {
        lines.push(
          `Capacity: ${label} has ${cnt} core pins on one rotation (id=${rid}) but capacity_per_month=${cap}.`
        );
      }
    }
  }

  const residentsInCore = new Set<string>();
  const coreParsed: { key: string; residentId: string; monthId: string; rotationId: string; monthIndex: number }[] =
    [];
  for (const [k, rotationId] of core) {
    const p = parseResidentMonthKey(k);
    if (!p) continue;
    residentsInCore.add(p.residentId);
    const month = staticData.monthsList.find((m) => m.id === p.monthId);
    coreParsed.push({
      key: k,
      residentId: p.residentId,
      monthId: p.monthId,
      rotationId,
      monthIndex: month?.month_index ?? -1,
    });
  }
  coreParsed.sort((a, b) => {
    if (a.residentId !== b.residentId) return a.residentId.localeCompare(b.residentId);
    return a.monthIndex - b.monthIndex;
  });
  for (let i = 1; i < coreParsed.length; i++) {
    const a = coreParsed[i - 1]!;
    const b = coreParsed[i]!;
    if (
      a.residentId === b.residentId &&
      a.rotationId === b.rotationId &&
      b.monthIndex === a.monthIndex + 1
    ) {
      const res = staticData.residentsList.find((r) => r.id === a.residentId);
      const rn = res ? [res.first_name, res.last_name].filter(Boolean).join(" ") : a.residentId;
      const ra = staticData.rotationsList.find((r) => r.id === a.rotationId);
      lines.push(
        `Adjacent-month pins: ${rn} has consecutive calendar months (month_index ${a.monthIndex} then ${b.monthIndex}) both forced to the same rotation "${ra?.name ?? a.rotationId}". With hard “same rotation back-to-back” (b2b_same) enabled in the CP mask at stage 9, that pair is typically INFEASIBLE by itself; removing either month’s pin restores feasibility.`
      );
    }
  }
  if (residentsInCore.size < core.length) {
    lines.push(
      "Same resident appears on multiple pinned months in the core; together with global requirements/B2B/capacity, the combined pins can over-constrain feasible packings."
    );
  }

  if (lines.length === 1) {
    lines.push(
      "No single-month capacity overrun detected among core pins; infeasibility is likely from interaction of requirements, multi-month B2B rules, and distributed capacity across the year."
    );
  }
  return lines.join(" ");
}

export type FixedRowProbeResult = {
  key: string;
  residentId: string;
  monthId: string;
  rotationId: string;
  mappingValid: boolean;
  enforcedInStage9: boolean;
  notEnforcedReason: string | null;
  individuallyStage9Feasible: boolean | null;
  classification: FixedRowClassification;
  likelyIntentionalNote: string;
};

export type FixedRulesProbeReport = {
  allPairs: FixedRulePair[];
  fullFixedSetStage9Feasible: boolean;
  individuallyFeasibleKeys: string[];
  minimalInfeasibleCore: FixedRulePair[];
  contradictionSummary: string;
  rows: FixedRowProbeResult[];
  stage8WitnessAssignmentAudits: Stage8ResidentAssignmentAudit[];
  stage8SolverMisleadingNullNote: string;
};

export function probeFixedRulesFeasibility(raw: Record<string, unknown>): FixedRulesProbeReport {
  const base = schedulerStaticDataFromSerializedJson(raw);
  const allPairs: FixedRulePair[] = [...base.fixedRuleMap.entries()].map(([k, r]) => [k, r] as const);

  const fullFixedSetStage9Feasible = stage9Sat(base);

  const minimalInfeasibleCore = fullFixedSetStage9Feasible
    ? []
    : minimalInfeasibleFixedSubset(raw, allPairs);

  const coreKeySet = new Set(minimalInfeasibleCore.map(([k]) => k));

  const grid8 = stage8WitnessGrid(base);
  const audits = grid8 ? auditStage8WitnessVsRequirements(base, grid8) : [];

  const underAssigned = audits.filter((a) => a.witnessHasAllNullWhenRequirementsPositive);
  const stage8SolverMisleadingNullNote =
    underAssigned.length > 0
      ? `Residents with positive summed min_months_required but zero clinical assignments in one stage-8 optimal witness: ${underAssigned
          .map((u) => u.residentName)
          .join(", ")}. If this list is non-empty, stage-8 witness cells should not be read as ground truth for those residents.`
      : `No resident had sum(min_months_required)>0 and zero clinical months in this stage-8 optimal witness; witness nulls on specific cells are not evidence of “missing assignment” when requirements are satisfied elsewhere.`;

  const individuallyFeasibleKeys: string[] = [];

  const rows: FixedRowProbeResult[] = allPairs.map(([key, rotationId]) => {
    const parsed = parseResidentMonthKey(key);
    const residentId = parsed?.residentId ?? "";
    const monthId = parsed?.monthId ?? "";

    const rOk = new Set(base.residentsList.map((x) => x.id));
    const mOk = new Set(base.monthsList.map((x) => x.id));
    const rotOk = new Set(base.rotationsList.map((x) => x.id));
    const mappingValid =
      parsed != null && rOk.has(residentId) && mOk.has(monthId) && rotOk.has(rotationId) && rotationId.length > 0;

    const { enforced, reasonIfNot } = fixedRuleWouldBeEnforcedInStage9(base, key, rotationId);

    let individuallyStage9Feasible: boolean | null = null;
    if (mappingValid && enforced) {
      individuallyStage9Feasible = stage9Sat(staticFromRawWithFixed(raw, [[key, rotationId]]));
      if (individuallyStage9Feasible) individuallyFeasibleKeys.push(key);
    }

    const likelyIntentionalNote =
      residentId === "1800cfa0-c539-4ea4-b889-9c64124d464e"
        ? "Business: single-month resident (only UCI Irvine x1 in requirements); July Irvine pin is treated as intentional."
        : "";

    let classification: FixedRowClassification = "unknown";

    if (!parsed || !rotationId) {
      classification = "blank_or_invalid_saved_fixed_row";
    } else if (!mappingValid) {
      classification = "mapping_bug";
    } else if (!enforced) {
      classification =
        reasonIfNot === "vacation_forced_off_month_cell_cannot_hold_rotation"
          ? "blank_or_invalid_saved_fixed_row"
          : "mapping_bug";
    } else if (individuallyStage9Feasible === false) {
      classification = "unknown";
    } else if (individuallyStage9Feasible === true) {
      const cydneyIntentional =
        residentId === "1800cfa0-c539-4ea4-b889-9c64124d464e" &&
        likelyIntentionalNote.length > 0;
      if (fullFixedSetStage9Feasible || cydneyIntentional) {
        classification = "valid_intentional_fixed_row";
      } else if (coreKeySet.has(key)) {
        classification = "impossible_given_other_fixed_rows";
      } else {
        classification = "valid_intentional_fixed_row";
      }
    }

    return {
      key,
      residentId,
      monthId,
      rotationId,
      mappingValid,
      enforcedInStage9: enforced,
      notEnforcedReason: reasonIfNot,
      individuallyStage9Feasible,
      classification,
      likelyIntentionalNote,
    };
  });

  const contradictionSummary = fullFixedSetStage9Feasible
    ? "Full fixed set is feasible at stage 9; no contradiction among exported pins under the current CP hard model."
    : heuristicContradiction(base, minimalInfeasibleCore);

  return {
    allPairs,
    fullFixedSetStage9Feasible,
    individuallyFeasibleKeys,
    minimalInfeasibleCore,
    contradictionSummary,
    rows,
    stage8WitnessAssignmentAudits: audits,
    stage8SolverMisleadingNullNote,
  };
}
