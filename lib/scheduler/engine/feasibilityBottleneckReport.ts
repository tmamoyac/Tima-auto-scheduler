/**
 * After the feasibility ladder finds a first failing stage, print concrete bottlenecks
 * (capacity / PGY / requirements / B2B edges from a witness grid at the prior stage).
 */
import { buildStrenuousConsultRotationIds } from "../generateSchedule";
import {
  buildAllowedValuesAndFixed,
  buildCpSatJsonPayload,
  gridToAssignmentRows,
  readCpSatHardFlagsFromEnv,
  readRequirementsModeFromEnv,
  type BuildCpSatOptions,
} from "./buildCpSatPayload";
import { FEASIBILITY_LADDER_STAGE_NAMES } from "./cpConstraintMask";
import { CP_FEASIBLE, CP_MODEL_INVALID, CP_OPTIMAL, invokeCpSatSolver } from "./cpSatInvoke";
import { residentMonthKey, reqKey } from "./normalizeInput";
import type { NormalizedSchedulerInput } from "./types";
import { academicMonthLabelFromIndex } from "./validateScheduleDetailed";

function resName(n: NormalizedSchedulerInput, id: string): string {
  const r = n.residentsOrdered.find((x) => x.id === id);
  if (!r) return id;
  const p = [r.first_name, r.last_name].filter(Boolean).join(" ");
  return p || id;
}

function monthLabel(n: NormalizedSchedulerInput, monthId: string): string {
  const m = n.monthsOrdered.find((x) => x.id === monthId);
  return m ? academicMonthLabelFromIndex(m.month_index) : monthId;
}

function rotName(n: NormalizedSchedulerInput, rotId: string): string {
  return n.rotationsOrdered.find((r) => r.id === rotId)?.name?.trim() || rotId;
}

/** Count residents (indices) that can take rotation index j in month mi. */
function residentsSupportingRotation(
  allowedValues: number[][][],
  mi: number,
  j: number
): number[] {
  const out: number[] = [];
  for (let ri = 0; ri < allowedValues.length; ri++) {
    const dom = allowedValues[ri][mi];
    if (dom.includes(j)) out.push(ri);
  }
  return out;
}

function solveStageGrid(
  n: NormalizedSchedulerInput,
  stage: number,
  opts?: Pick<BuildCpSatOptions, "requirementsMode" | "maxSecondsOverride">
): { ok: true; grid: number[][] } | { ok: false; reason: string } {
  const flags = readCpSatHardFlagsFromEnv();
  const payload = buildCpSatJsonPayload(n, flags, {
    ladderStage: stage,
    requirementsMode: opts?.requirementsMode ?? readRequirementsModeFromEnv(),
    maxSecondsOverride: opts?.maxSecondsOverride ?? Math.min(60, Number(process.env.CP_SAT_MAX_SECONDS ?? 60) || 60),
  }) as Record<string, unknown>;
  const raw = invokeCpSatSolver(payload);
  if (!raw.ok) return { ok: false, reason: raw.reason };
  const feasible =
    raw.grid != null && (raw.status === CP_OPTIMAL || raw.status === CP_FEASIBLE);
  if (raw.status === CP_MODEL_INVALID || !feasible) {
    return { ok: false, reason: raw.status_name ?? `status_${raw.status}` };
  }
  return { ok: true, grid: raw.grid! };
}

function reportCapacityStage3(n: NormalizedSchedulerInput, lines: string[]): void {
  const avFull = buildAllowedValuesAndFixed(n, 1).allowedValues;
  const avVac = buildAllowedValuesAndFixed(n, 2).allowedValues;
  const flags = readCpSatHardFlagsFromEnv();
  const payload = buildCpSatJsonPayload(n, flags, { ladderStage: 3 }) as Record<string, unknown>;
  const capacity = payload.capacity as number[][];
  const { residentsOrdered, monthsOrdered, rotationsOrdered } = n;
  lines.push("Interpretation: stage 3 enables capacity only (domains still vacation-layer).");
  lines.push("Bottleneck if more residents can simultaneously take rotation j in month m than capacity allows.");
  lines.push("PGY / B2B filters: not active in the CP model until later ladder stages.");
  let any = false;
  for (let mi = 0; mi < monthsOrdered.length; mi++) {
    const m = monthsOrdered[mi];
    for (let ji = 0; ji < rotationsOrdered.length; ji++) {
      const j = ji + 1;
      const cap = capacity[mi]?.[ji] ?? 0;
      const sFull = residentsSupportingRotation(avFull, mi, j);
      const sVac = residentsSupportingRotation(avVac, mi, j);
      if (sVac.length > cap) {
        any = true;
        const deficit = sVac.length - cap;
        lines.push(
          `CAPACITY_EXCESS month=${monthLabel(n, m.id)} rotation=${rotName(n, rotationsOrdered[ji].id)} required_slots(capacity_per_month)=${cap}`
        );
        lines.push(
          `  candidate_residents_before_vacation_filter=${sFull.length} after_vacation_domain=${sVac.length} after_pgy_filter=n/a after_b2b_filter=n/a deficit_worst_case=${deficit}`
        );
        lines.push(`  residents_after_vacation_domain: ${sVac.map((ri) => resName(n, residentsOrdered[ri].id)).join(", ")}`);
      }
    }
  }
  if (!any) {
    lines.push(
      "No (month,rotation) with count(domain includes j) > capacity; infeasibility may be structural (solver) — check MODEL_INVALID or empty domains in stderr."
    );
  }
}

function reportPgyStage4(n: NormalizedSchedulerInput, lines: string[]): void {
  const avFull = buildAllowedValuesAndFixed(n, 1).allowedValues;
  const avVac = buildAllowedValuesAndFixed(n, 2).allowedValues;
  const avPgy = buildAllowedValuesAndFixed(n, 3).allowedValues;
  const { residentsOrdered, monthsOrdered } = n;
  lines.push(
    "Interpretation: stage 4 tightens domains from vacation-layer to PGY-eligible rotations (fixed rules not collapsed yet)."
  );
  let any = false;
  for (let ri = 0; ri < residentsOrdered.length; ri++) {
    for (let mi = 0; mi < monthsOrdered.length; mi++) {
      const dFull = avFull[ri][mi];
      const dVac = avVac[ri][mi];
      const dPgy = avPgy[ri][mi];
      const fullWork = dFull.filter((x) => x > 0);
      const vacWork = dVac.filter((x) => x > 0);
      const pgyWork = dPgy.filter((x) => x > 0);
      const onVacForced = dVac.length === 1 && dVac[0] === 0;
      if (onVacForced) continue;
      if (vacWork.length > 0 && pgyWork.length === 0) {
        any = true;
        lines.push(
          `PGY_ELIMINATED_ALL_CLINICAL resident=${resName(n, residentsOrdered[ri].id)} month=${monthLabel(n, monthsOrdered[mi].id)}`
        );
        lines.push(
          `  candidate_rotations_before_vacation_filter=${fullWork.length} after_vacation_filter=${vacWork.length} after_pgy_eligibility_filter=0 after_b2b_filter=n/a`
        );
      }
    }
  }
  if (!any) {
    lines.push("No obvious PGY-wipeout cells; inspect CP stderr or ladder stage-3 vs 4 payload diff.");
  }
}

function reportRequirementsStage5(
  n: NormalizedSchedulerInput,
  reqMode: "exact" | "minimum",
  lines: string[]
): void {
  const { allowedValues: avPgy } = buildAllowedValuesAndFixed(n, 3);
  const { allowedValues: avVac } = buildAllowedValuesAndFixed(n, 2);
  const { residentsOrdered, rotationsOrdered, initialRequired } = n;
  lines.push(`Interpretation: stage 5 adds required-month counts (mode=${reqMode}).`);
  let any = false;
  for (const res of residentsOrdered) {
    for (const rot of rotationsOrdered) {
      const init = initialRequired.get(reqKey(res.id, rot.id));
      if (init === undefined || init <= 0) continue;
      let monthsPgy = 0;
      let monthsVac = 0;
      const ri = n.residentIndexById.get(res.id) ?? -1;
      if (ri < 0) continue;
      const j = n.rotIndexById.get(rot.id);
      if (j == null) continue;
      const eligibleMonths: string[] = [];
      for (let mi = 0; mi < n.monthsOrdered.length; mi++) {
        if (avVac[ri][mi].includes(j)) monthsVac++;
        if (avPgy[ri][mi].includes(j)) {
          monthsPgy++;
          eligibleMonths.push(monthLabel(n, n.monthsOrdered[mi].id));
        }
      }
      const need = init;
      if (monthsPgy < need) {
        any = true;
        lines.push(
          `REQ_IMPOSSIBLE resident=${resName(n, res.id)} rotation=${rotName(n, rot.id)} required_months=${need} mode=${reqMode}`
        );
        lines.push(
          `  candidate_months_after_vacation_domain=${monthsVac} after_pgy_eligibility=${monthsPgy} after_b2b_filter=n/a final_deficit=${need - monthsPgy}`
        );
        lines.push(`  eligible_months_after_pgy: ${eligibleMonths.length ? eligibleMonths.join(", ") : "(none)"}`);
      }
    }
  }
  if (!any) {
    lines.push("No per-resident rotation with required months > eligible months count (layer-3 domains).");
  }
}

function consecutivePairsFromRows(
  n: NormalizedSchedulerInput,
  rows: { resident_id: string; month_id: string; rotation_id: string | null }[]
): { resId: string; prevMonthId: string; currMonthId: string; a: string; b: string }[] {
  const lookup = new Map<string, string | null>();
  for (const row of rows) {
    lookup.set(residentMonthKey(row.resident_id, row.month_id), row.rotation_id);
  }
  const out: { resId: string; prevMonthId: string; currMonthId: string; a: string; b: string }[] = [];
  const months = n.monthsOrdered;
  for (const res of n.residentsOrdered) {
    for (let mi = 1; mi < months.length; mi++) {
      const pm = months[mi - 1];
      const cm = months[mi];
      const a = lookup.get(residentMonthKey(res.id, pm.id));
      const b = lookup.get(residentMonthKey(res.id, cm.id));
      if (a && b) {
        out.push({ resId: res.id, prevMonthId: pm.id, currMonthId: cm.id, a, b });
      }
    }
  }
  return out;
}

function reportB2bFromPreviousSolution(
  n: NormalizedSchedulerInput,
  failingStage: number,
  kind: "same" | "strenuous" | "transplant",
  lines: string[],
  opts?: Pick<BuildCpSatOptions, "requirementsMode" | "maxSecondsOverride">
): void {
  const prev = failingStage - 1;
  if (prev < 1) return;
  const solved = solveStageGrid(n, prev, opts);
  if (!solved.ok) {
    lines.push(`Could not solve prior stage ${prev} for witness grid (${solved.reason}).`);
    return;
  }
  const rows = gridToAssignmentRows(n, solved.grid);
  const pairs = consecutivePairsFromRows(n, rows);
  const strenuous = buildStrenuousConsultRotationIds(n.rotationsOrdered);
  const transplantIds = new Set(n.rotationsOrdered.filter((r) => r.is_transplant).map((r) => r.id));
  const hits: typeof pairs = [];
  for (const p of pairs) {
    if (kind === "same" && p.a === p.b) hits.push(p);
    if (kind === "strenuous" && strenuous.has(p.a) && strenuous.has(p.b)) hits.push(p);
    if (kind === "transplant" && transplantIds.has(p.a) && transplantIds.has(p.b)) hits.push(p);
  }
  lines.push(
    `Witness assignment from feasible stage ${prev} (${FEASIBILITY_LADDER_STAGE_NAMES[prev]}); edges that violate NEW constraint at stage ${failingStage}:`
  );
  if (hits.length === 0) {
    lines.push(`  (no ${kind} back-to-back edges in that witness — infeasibility may be non-local or time-limit)`);
    return;
  }
  const avProd = buildAllowedValuesAndFixed(n, 4).allowedValues;
  const clinical = (ri: number, mi: number) => avProd[ri]?.[mi]?.filter((x) => x > 0).length ?? 0;
  for (const h of hits) {
    const ri = n.residentIndexById.get(h.resId) ?? -1;
    const miPrev = n.monthIndexById.get(h.prevMonthId) ?? -1;
    const miCurr = n.monthIndexById.get(h.currMonthId) ?? -1;
    lines.push(
      `BLOCKED_EDGE resident=${resName(n, h.resId)} month_pair=${monthLabel(n, h.prevMonthId)}->${monthLabel(n, h.currMonthId)} rotations=${rotName(n, h.a)}->${rotName(n, h.b)}`
    );
    if (ri >= 0 && miPrev >= 0 && miCurr >= 0) {
      lines.push(
        `  month=${monthLabel(n, h.prevMonthId)} rotation=${rotName(n, h.a)} required_slots=n/a eligible_clinical_after_vacation_pgy_domains=${clinical(ri, miPrev)}`
      );
      lines.push(
        `  month=${monthLabel(n, h.currMonthId)} rotation=${rotName(n, h.b)} required_slots=n/a eligible_clinical_after_vacation_pgy_domains=${clinical(ri, miCurr)}`
      );
    }
    lines.push(
      `  after_b2b_filter=0 for this consecutive pair under stage ${failingStage} (${kind} B2B hard); witness from stage ${prev} uses this edge, so tightening makes model infeasible unless other assignments exist`
    );
  }
}

function cellClinicalCounts(n: NormalizedSchedulerInput, ri: number, mi: number): {
  beforeFilters: number;
  afterVacation: number;
  afterPgy: number;
} {
  const c = (layer: 1 | 2 | 3) =>
    buildAllowedValuesAndFixed(n, layer).allowedValues[ri]?.[mi]?.filter((x) => x > 0).length ?? 0;
  return { beforeFilters: c(1), afterVacation: c(2), afterPgy: c(3) };
}

function reportFixedStage9(
  n: NormalizedSchedulerInput,
  lines: string[],
  opts?: Pick<BuildCpSatOptions, "requirementsMode" | "maxSecondsOverride">
): void {
  const { allowedValues } = buildAllowedValuesAndFixed(n, 4);
  const { staticData, residentsOrdered, monthsOrdered } = n;
  lines.push("Interpretation: stage 9 collapses fixed rules into singleton domains + fixed triples.");
  lines.push(
    "Note: stages 1–8 do not pin fixed_assignment_rules in domains (layer 4 + fixed triples only at stage 9). A feasible stage-8 grid can violate DB fixed rows; enforcing them then often proves INFEASIBLE."
  );
  const flags = readCpSatHardFlagsFromEnv();
  const payload = buildCpSatJsonPayload(n, flags, { ladderStage: 9 }) as Record<string, unknown>;
  const fixed = (payload.fixed as number[][]) ?? [];
  let any = false;
  for (const t of fixed) {
    const [ri, mi, val] = t.map(Number);
    const dom = allowedValues[ri]?.[mi];
    if (!dom || !dom.includes(val)) {
      any = true;
      const res = residentsOrdered[ri];
      const m = monthsOrdered[mi];
      const rot = val === 0 ? null : n.rotationsOrdered[val - 1];
      lines.push(
        `FIXED_NOT_IN_DOMAIN resident=${resName(n, res.id)} month=${monthLabel(n, m.id)} fixed_value_index=${val} rotation=${rot ? rotName(n, rot.id) : "null"} domain=${JSON.stringify(dom)}`
      );
    }
  }
  for (let ri = 0; ri < residentsOrdered.length; ri++) {
    for (let mi = 0; mi < monthsOrdered.length; mi++) {
      const k = residentMonthKey(residentsOrdered[ri].id, monthsOrdered[mi].id);
      const ruleRot = staticData.fixedRuleMap.get(k);
      if (!ruleRot) continue;
      const j = n.rotIndexById.get(ruleRot);
      const dom = allowedValues[ri][mi];
      if (j != null && dom && !dom.includes(j)) {
        any = true;
        lines.push(
          `FIXED_RULE_MISMATCH_DOMAIN resident=${resName(n, residentsOrdered[ri].id)} month=${monthLabel(n, monthsOrdered[mi].id)} fixed_rotation=${rotName(n, ruleRot)} domain=${JSON.stringify(dom)}`
        );
      }
    }
  }

  const solved = solveStageGrid(n, 8, opts);
  if (solved.ok) {
    const rows = gridToAssignmentRows(n, solved.grid);
    const lookup = new Map(rows.map((r) => [residentMonthKey(r.resident_id, r.month_id), r.rotation_id]));
    const mism: { ri: number; mi: number; want: string; got: string | null }[] = [];
    for (let ri = 0; ri < residentsOrdered.length; ri++) {
      for (let mi = 0; mi < monthsOrdered.length; mi++) {
        const k = residentMonthKey(residentsOrdered[ri].id, monthsOrdered[mi].id);
        const want = staticData.fixedRuleMap.get(k);
        if (!want) continue;
        const got = lookup.get(k) ?? null;
        if (got !== want) mism.push({ ri, mi, want, got });
      }
    }
    if (mism.length > 0) {
      any = true;
      lines.push(
        `FIXED_VS_STAGE8_WITNESS mismatches=${mism.length} (CP stage-8 feasible solution vs DB fixed_assignment_rules)`
      );
      for (const x of mism.slice(0, 12)) {
        const m = monthsOrdered[x.mi];
        lines.push(
          `  resident=${resName(n, residentsOrdered[x.ri].id)} month=${monthLabel(n, m.id)} mandated=${rotName(n, x.want)} stage8_had=${x.got ? rotName(n, x.got) : "null"}`
        );
      }
    }
  } else {
    lines.push(`Could not solve stage 8 for witness (${solved.reason}).`);
  }

  if (!any) {
    lines.push("No fixed/domain/mismatch diagnostics; inspect global capacity+B2B+requirements with fixed pins.");
  }
}

/**
 * Short executive summary (top 3 bottleneck rows) for console / copy-paste.
 */
export function formatExecutiveBottleneckTop3(
  n: NormalizedSchedulerInput,
  firstFailingStage: number,
  opts?: Pick<BuildCpSatOptions, "requirementsMode" | "maxSecondsOverride">
): string {
  const name = FEASIBILITY_LADDER_STAGE_NAMES[firstFailingStage] ?? `stage_${firstFailingStage}`;
  const lines: string[] = [];
  lines.push(`FIRST_FAILING_STAGE: ${name}`);
  lines.push("");

  if (firstFailingStage === 9) {
    const { staticData, residentsOrdered, monthsOrdered } = n;
    const solved = solveStageGrid(n, 8, opts);
    if (!solved.ok) {
      lines.push("BOTTLENECK: (could not build stage-8 witness)");
      lines.push(`Month: —`);
      lines.push(`Rotation: —`);
      lines.push(`Required Slots: —`);
      lines.push(`Eligible Before Filters: —`);
      lines.push(`After Vacation Filter: —`);
      lines.push(`After PGY/Domain Filter: —`);
      lines.push(`After B2B Filter: —`);
      lines.push(`Final Deficit: —`);
      return lines.join("\n");
    }
    const rows = gridToAssignmentRows(n, solved.grid);
    const lookup = new Map(rows.map((r) => [residentMonthKey(r.resident_id, r.month_id), r.rotation_id]));
    const mism: { ri: number; mi: number; want: string; got: string | null }[] = [];
    for (let ri = 0; ri < residentsOrdered.length; ri++) {
      for (let mi = 0; mi < monthsOrdered.length; mi++) {
        const k = residentMonthKey(residentsOrdered[ri].id, monthsOrdered[mi].id);
        const want = staticData.fixedRuleMap.get(k);
        if (!want) continue;
        const got = lookup.get(k) ?? null;
        if (got !== want) mism.push({ ri, mi, want, got });
      }
    }
    lines.push("BOTTLENECK: Fixed rules cannot coexist with a schedule that satisfies capacity + requirements + B2B from stages 3–8. Witness stage-8 CP assignment disagrees with DB fixed rows below.");
    lines.push("");
    let nPrinted = 0;
    for (const x of mism) {
      if (nPrinted >= 3) break;
      nPrinted++;
      const m = monthsOrdered[x.mi];
      const rot = n.rotationsOrdered.find((r) => r.id === x.want);
      const cap = rot?.capacity_per_month ?? 0;
      const fc = cellClinicalCounts(n, x.ri, x.mi);
      lines.push(`--- bottleneck ${nPrinted} of ${Math.min(3, mism.length)} (of ${mism.length} fixed mismatches) ---`);
      lines.push(`Month: ${monthLabel(n, m.id)}`);
      lines.push(`Rotation: ${rotName(n, x.want)}`);
      lines.push(`Required Slots: ${cap} (rotation capacity_per_month; fixed claims 1 seat for this resident)`);
      lines.push(`Eligible Before Filters: ${fc.beforeFilters} clinical options (layer-1 domain count)`);
      lines.push(`After Vacation Filter: ${fc.afterVacation}`);
      lines.push(`After PGY/Domain Filter: ${fc.afterPgy}`);
      lines.push(`After B2B Filter: n/a (single-cell view; B2B already satisfied at stage 8)`);
      lines.push(
        `Final Deficit: 1 mandated fixed month ≠ stage-8 assignment (${x.got ? rotName(n, x.got) : "null"}) — enforcing all fixed rows together is INFEASIBLE with current hard rules`
      );
      lines.push("");
    }
    lines.push("FIXED_RULE_CONFLICTS (DB fixed_assignment_rules vs stage-8 CP solution):");
    for (const x of mism) {
      const m = monthsOrdered[x.mi];
      lines.push(
        `- Resident: ${resName(n, residentsOrdered[x.ri].id)}, Mandated: ${rotName(n, x.want)}, Month: ${monthLabel(n, m.id)}, Stage8_had: ${x.got ? rotName(n, x.got) : "null"}`
      );
    }
    return lines.join("\n");
  }

  if (firstFailingStage === 5) {
    const reqMode = opts?.requirementsMode ?? readRequirementsModeFromEnv();
    lines.push("BOTTLENECK: (see detailed REQ_IMPOSSIBLE lines above if present)");
    lines.push(
      `REQUIREMENT_CONFLICTS (requirementsMode=${reqMode}): run with full bottleneck report or inspect formatFirstFailingStageBottleneck output.`
    );
    return lines.join("\n");
  }

  lines.push("BOTTLENECK: (see === BOTTLENECK REPORT === block above for this stage)");
  lines.push(`Month: —`);
  lines.push(`Rotation: —`);
  lines.push(`Required Slots: —`);
  lines.push(`Eligible Before Filters: —`);
  lines.push(`After Vacation Filter: —`);
  lines.push(`After PGY/Domain Filter: —`);
  lines.push(`After B2B Filter: —`);
  lines.push(`Final Deficit: —`);
  return lines.join("\n");
}

/**
 * Multi-line bottleneck report for the first ladder stage that returned INFEASIBLE / invalid.
 */
export function formatFirstFailingStageBottleneck(
  n: NormalizedSchedulerInput,
  firstFailingStage: number,
  opts?: Pick<BuildCpSatOptions, "requirementsMode" | "maxSecondsOverride">
): string {
  const lines: string[] = [];
  const name = FEASIBILITY_LADDER_STAGE_NAMES[firstFailingStage] ?? `stage_${firstFailingStage}`;
  lines.push(`=== BOTTLENECK REPORT (stage ${firstFailingStage}: ${name}) ===`);
  const reqMode = opts?.requirementsMode ?? readRequirementsModeFromEnv();

  switch (firstFailingStage) {
    case 1:
    case 2:
      lines.push("Early stage failure: check Python/OR-Tools, empty rotation list, or MODEL_INVALID.");
      break;
    case 3:
      reportCapacityStage3(n, lines);
      break;
    case 4:
      reportPgyStage4(n, lines);
      break;
    case 5:
      reportRequirementsStage5(n, reqMode, lines);
      break;
    case 6:
      reportB2bFromPreviousSolution(n, 6, "same", lines, opts);
      break;
    case 7:
      reportB2bFromPreviousSolution(n, 7, "strenuous", lines, opts);
      break;
    case 8:
      reportB2bFromPreviousSolution(n, 8, "transplant", lines, opts);
      break;
    case 9:
      reportFixedStage9(n, lines, opts);
      break;
    default:
      lines.push("Unknown stage.");
  }

  return lines.join("\n");
}
