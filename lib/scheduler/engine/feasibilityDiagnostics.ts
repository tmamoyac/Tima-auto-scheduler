import type { LoadedSchedulerStaticData } from "../generateSchedule";
import { computeInitialRequiredMap } from "../generateSchedule";
import { countRotationsByVacationOverlapPolicy } from "../vacationOverlapPolicy";
import { normalizeSchedulerInput, residentMonthKey, reqKey } from "./normalizeInput";
import type { NormalizedSchedulerInput } from "./types";

/**
 * Aggregate contradiction hints when the model is infeasible (does not prove cause — use ladder for that).
 */
export function buildInfeasibilityDiagnostics(
  staticDataOrN: LoadedSchedulerStaticData | NormalizedSchedulerInput
): string[] {
  const n =
    "vacationResidentMonthKeys" in staticDataOrN
      ? staticDataOrN
      : normalizeSchedulerInput(staticDataOrN);
  const { staticData, residentsOrdered, monthsOrdered, rotationsOrdered } = n;
  const M = monthsOrdered.length;
  const initialRequired =
    "initialRequired" in staticDataOrN && staticDataOrN.initialRequired instanceof Map
      ? staticDataOrN.initialRequired
      : computeInitialRequiredMap(staticData);

  const lines: string[] = [];
  lines.push("--- infeasibility diagnostics (aggregate, not proof) ---");

  let vacCells = 0;
  for (const res of residentsOrdered) {
    for (const month of monthsOrdered) {
      if (n.vacationResidentMonthKeys.has(residentMonthKey(res.id, month.id))) vacCells++;
    }
  }
  lines.push(
    `resident-months total=${residentsOrdered.length * M} vacation_overlap_cells=${vacCells} (forced null when noConsultWhenVacationInMonth is false)`
  );
  const polc = countRotationsByVacationOverlapPolicy(rotationsOrdered);
  lines.push(
    `vacation_overlap_policy_rotations allowed=${polc.allowed} avoid=${polc.avoid} prohibited=${polc.prohibited}`
  );

  const demandByRotation = new Map<string, number>();
  for (const res of residentsOrdered) {
    for (const rot of rotationsOrdered) {
      const minM = initialRequired.get(reqKey(res.id, rot.id));
      if (minM === undefined || minM <= 0) continue;
      demandByRotation.set(rot.id, (demandByRotation.get(rot.id) ?? 0) + minM);
    }
  }

  for (const rot of rotationsOrdered) {
    const totalMin = demandByRotation.get(rot.id) ?? 0;
    const capPer = rot.capacity_per_month;
    const maxServe = capPer * M;
    if (totalMin > maxServe) {
      lines.push(
        `DEMAND_EXCEEDS_CAPACITY rotation=${rot.name ?? rot.id}: sum(min months)=${totalMin} > capacity_per_month*M=${maxServe}`
      );
    }
  }

  for (const res of residentsOrdered) {
    let sumMin = 0;
    for (const rot of rotationsOrdered) {
      const v = initialRequired.get(reqKey(res.id, rot.id));
      if (v !== undefined && v > 0) sumMin += v;
    }
    const vacLocked =
      staticData.noConsultWhenVacationInMonth
        ? 0
        : monthsOrdered.filter((month) =>
            n.vacationResidentMonthKeys.has(residentMonthKey(res.id, month.id))
          ).length;
    const assignableMonths = M - vacLocked;
    if (!staticData.noConsultWhenVacationInMonth) {
      if (sumMin > assignableMonths) {
        lines.push(
          `RESIDENT_MIN_SUM_EXCEEDS_ASSIGNABLE_MONTHS resident=${res.id} sum(min_required rotations)=${sumMin} assignable_months=${assignableMonths} vacation_forced_off=${vacLocked}`
        );
      }
    } else if (sumMin > M) {
      lines.push(`RESIDENT_MIN_SUM_EXCEEDS_YEAR resident=${res.id} sum(min_required)=${sumMin} months=${M}`);
    }
  }

  lines.push(
    `requirements_mode env SCHEDULER_REQ_MODE=${(process.env.SCHEDULER_REQ_MODE ?? "minimum").trim() || "minimum"} (minimum uses DB min_months_required as lower bound; exact matches legacy equality)`
  );
  lines.push(
    `B2B hardness SCHEDULER_B2B_HARD=${(process.env.SCHEDULER_B2B_HARD ?? "1").trim() || "1"} (0 = same/strenuous/transplant spacing soft + omitted from CP)`
  );

  return lines;
}
