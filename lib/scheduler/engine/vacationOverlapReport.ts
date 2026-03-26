import type { LoadedSchedulerStaticData } from "../generateSchedule";
import type { VacationOverlapDetailRow, VacationOverlapSummary } from "../scheduleClientShare";
import { rotationVacationOverlapPolicy } from "../vacationOverlapPolicy";
import { normalizeSchedulerInput, residentMonthKey } from "./normalizeInput";
import { academicMonthLabelFromIndex } from "./validateScheduleDetailed";

/**
 * Counts and rows for assignments where the resident has vacation overlap in that academic month
 * and the rotation policy is `avoid` or `prohibited`, from the final grid only.
 */
export function computeVacationOverlapReport(
  staticData: LoadedSchedulerStaticData,
  assignmentRows: Array<{ resident_id: string; month_id: string; rotation_id: string | null }>
): {
  vacation_overlap_summary: VacationOverlapSummary;
  vacation_overlap_details: VacationOverlapDetailRow[];
} {
  const n = normalizeSchedulerInput(staticData);
  const monthsById = new Map(staticData.monthsList.map((m) => [m.id, m]));
  const resById = new Map(staticData.residentsList.map((r) => [r.id, r]));
  const rotById = new Map(staticData.rotationsList.map((r) => [r.id, r]));

  let prohibited_violation_count = 0;
  let avoid_used_count = 0;
  const vacation_overlap_details: VacationOverlapDetailRow[] = [];

  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const k = residentMonthKey(row.resident_id, row.month_id);
    if (!n.vacationResidentMonthKeys.has(k)) continue;

    const rot = rotById.get(row.rotation_id);
    if (!rot) continue;
    const pol = rotationVacationOverlapPolicy(rot);
    if (pol === "allowed") continue;

    const month = monthsById.get(row.month_id);
    const res = resById.get(row.resident_id);
    const rname = [res?.first_name, res?.last_name].filter(Boolean).join(" ").trim() || row.resident_id;
    const mlabel = month ? academicMonthLabelFromIndex(month.month_index) : row.month_id;
    const rotName = rot.name ?? rot.id;

    const win = month ? n.monthWindows.get(month.id) : undefined;
    const span = pickOverlappingVacationSpan(staticData, row.resident_id, win);

    const pinKey = residentMonthKey(row.resident_id, row.month_id);
    const pinnedRot = staticData.fixedRuleMap.get(pinKey);
    const from_fixed_rule = pinnedRot === row.rotation_id;
    const fixed_rule_id = from_fixed_rule
      ? staticData.fixedRuleIdByKey.get(pinKey) ?? null
      : null;

    const base = {
      resident_id: row.resident_id,
      resident_name: rname,
      month_id: row.month_id,
      month_label: mlabel,
      rotation_id: row.rotation_id,
      rotation_name: rotName,
      overlapping_vacation_start: span.start,
      overlapping_vacation_end: span.end,
      from_fixed_rule,
      fixed_rule_id,
    };

    if (pol === "prohibited") {
      prohibited_violation_count++;
      vacation_overlap_details.push({
        ...base,
        policy: "Prohibited",
      });
    } else {
      avoid_used_count++;
      vacation_overlap_details.push({
        ...base,
        policy: "Avoid",
      });
    }
  }

  return {
    vacation_overlap_summary: { prohibited_violation_count, avoid_used_count },
    vacation_overlap_details,
  };
}

function pickOverlappingVacationSpan(
  staticData: LoadedSchedulerStaticData,
  residentId: string,
  monthWin: { start: string; end: string } | undefined
): { start: string; end: string } {
  if (!monthWin) return { start: "", end: "" };
  const ranges = staticData.vacationRanges.filter(
    (v) =>
      v.resident_id === residentId && v.start_date <= monthWin.end && v.end_date >= monthWin.start
  );
  if (ranges.length === 0) return { start: "", end: "" };
  let minS = ranges[0]!.start_date;
  let maxE = ranges[0]!.end_date;
  for (const r of ranges) {
    if (r.start_date < minS) minS = r.start_date;
    if (r.end_date > maxE) maxE = r.end_date;
  }
  return { start: minS, end: maxE };
}
