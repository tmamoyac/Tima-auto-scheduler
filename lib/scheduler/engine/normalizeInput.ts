import { computeInitialRequiredMap, type LoadedSchedulerStaticData } from "../generateSchedule";
import type { NormalizedSchedulerInput } from "./types";

export function residentMonthKey(residentId: string, monthId: string): string {
  return `${residentId}_${monthId}`;
}

export function reqKey(residentId: string, rotationId: string): string {
  return `${residentId}_${rotationId}`;
}

/** Inclusive overlap on YYYY-MM-DD strings (same semantics as generateSchedule). */
export function vacationOverlapDaysInclusive(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): number {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  if (s > e) return 0;
  const d0 = Date.parse(s.length > 10 ? s : `${s}T12:00:00.000Z`);
  const d1 = Date.parse(e.length > 10 ? e : `${e}T12:00:00.000Z`);
  if (Number.isNaN(d0) || Number.isNaN(d1)) return 0;
  return Math.max(0, Math.floor((d1 - d0) / 86400000) + 1);
}

export function approximateMonthWindowUtc(
  yearStartIso: string,
  yearEndIso: string,
  monthIndex: number,
  totalMonths: number
): { start: string; end: string } | null {
  if (!yearStartIso || !yearEndIso || totalMonths <= 0) return null;
  const s = yearStartIso.includes("T") ? yearStartIso : `${yearStartIso}T00:00:00.000Z`;
  const e = yearEndIso.includes("T") ? yearEndIso : `${yearEndIso}T23:59:59.999Z`;
  const t0 = Date.parse(s);
  const t1 = Date.parse(e);
  if (Number.isNaN(t0) || Number.isNaN(t1) || t1 <= t0) return null;
  const slice = (t1 - t0) / totalMonths;
  const segStart = t0 + monthIndex * slice;
  const segEnd = t0 + (monthIndex + 1) * slice - 1;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: fmt(segStart), end: fmt(segEnd) };
}

/**
 * Single source of truth for month ordering, vacation keys, and windows.
 * Fixes: unstable month order if DB returns unsorted rows; duplicated date logic drift.
 */
export function normalizeSchedulerInput(staticData: LoadedSchedulerStaticData): NormalizedSchedulerInput {
  const monthsOrdered = [...staticData.monthsList].sort((a, b) => a.month_index - b.month_index);
  const residentsOrdered = [...staticData.residentsList];
  const rotationsOrdered = [...staticData.rotationsList];

  const monthWindows = new Map<string, { start: string; end: string }>();
  const nM = monthsOrdered.length;
  for (let mi = 0; mi < monthsOrdered.length; mi++) {
    const month = monthsOrdered[mi]!;
    let mStart = (month.start_date ?? "").trim();
    let mEnd = (month.end_date ?? "").trim();
    if (!mStart || !mEnd) {
      const approx = approximateMonthWindowUtc(
        staticData.academicYearStart,
        staticData.academicYearEnd,
        mi,
        nM
      );
      if (approx) {
        mStart = approx.start;
        mEnd = approx.end;
      }
    }
    if (mStart && mEnd) {
      monthWindows.set(month.id, { start: mStart, end: mEnd });
    }
  }

  const vacationResidentMonthKeys = new Set<string>();
  for (const month of monthsOrdered) {
    const win = monthWindows.get(month.id);
    if (!win) continue;
    const { start: mStart, end: mEnd } = win;
    for (const resident of residentsOrdered) {
      const hasOverlap = staticData.vacationRanges.some(
        (v) => v.resident_id === resident.id && v.start_date <= mEnd && v.end_date >= mStart
      );
      if (hasOverlap) vacationResidentMonthKeys.add(residentMonthKey(resident.id, month.id));
    }
  }

  const initialRequired = computeInitialRequiredMap(staticData);
  const rotIndexById = new Map<string, number>();
  for (let i = 0; i < rotationsOrdered.length; i++) {
    rotIndexById.set(rotationsOrdered[i].id, i + 1);
  }
  const residentIndexById = new Map<string, number>();
  for (let i = 0; i < residentsOrdered.length; i++) {
    residentIndexById.set(residentsOrdered[i].id, i);
  }
  const monthIndexById = new Map<string, number>();
  for (let i = 0; i < monthsOrdered.length; i++) {
    monthIndexById.set(monthsOrdered[i].id, i);
  }

  return {
    staticData,
    residentsOrdered,
    monthsOrdered,
    rotationsOrdered,
    vacationResidentMonthKeys,
    monthWindows,
    initialRequired,
    rotIndexById,
    residentIndexById,
    monthIndexById,
  };
}
