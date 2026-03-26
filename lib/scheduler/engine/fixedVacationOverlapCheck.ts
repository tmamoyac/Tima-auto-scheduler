import type { LoadedSchedulerStaticData } from "../generateSchedule";
import type { VacationOverlapBlocked } from "../scheduleClientShare";
import { rotationVacationOverlapPolicy } from "../vacationOverlapPolicy";
import { normalizeSchedulerInput, residentMonthKey } from "./normalizeInput";
import { academicMonthLabelFromIndex } from "./validateScheduleDetailed";

/**
 * Structured block when a fixed pin requires a rotation marked `prohibited` on a vacation-overlap month.
 */
export function getFixedProhibitedVacationOverlapBlock(
  staticData: LoadedSchedulerStaticData
): VacationOverlapBlocked | null {
  if (staticData.fixedRuleMap.size === 0) return null;
  const n = normalizeSchedulerInput(staticData);
  const monthsOrdered = [...staticData.monthsList].sort((a, b) => a.month_index - b.month_index);

  for (const res of staticData.residentsList) {
    for (const month of monthsOrdered) {
      const k = residentMonthKey(res.id, month.id);
      const rotationId = staticData.fixedRuleMap.get(k);
      if (!rotationId) continue;
      if (!n.vacationResidentMonthKeys.has(k)) continue;
      const rot = staticData.rotationsList.find((r) => r.id === rotationId);
      if (!rot || rotationVacationOverlapPolicy(rot) !== "prohibited") continue;
      const rname = [res.first_name, res.last_name].filter(Boolean).join(" ").trim() || res.id;
      const mlabel = academicMonthLabelFromIndex(month.month_index);
      const rotName = rot.name ?? rot.id;
      const message = `${rname} cannot be fixed to ${rotName} in ${mlabel} because that rotation does not allow vacation overlap.`;
      const fixed_rule_id = staticData.fixedRuleIdByKey.get(k) ?? "";
      return {
        resident_id: res.id,
        resident_name: rname,
        month_id: month.id,
        month_label: mlabel,
        rotation_id: rot.id,
        rotation_name: rotName,
        message,
        reason:
          "This rotation is set to never schedule during months that overlap this resident’s vacation, but this fixed assignment falls in such a month.",
        fixed_rule_id,
      };
    }
  }
  return null;
}

/** First human-readable error if a fixed pin requires a rotation marked `prohibited` on a vacation-overlap month. */
export function getFirstFixedProhibitedVacationOverlapError(
  staticData: LoadedSchedulerStaticData
): string | null {
  const b = getFixedProhibitedVacationOverlapBlock(staticData);
  return b ? b.message : null;
}
