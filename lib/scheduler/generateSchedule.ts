import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FeasibilityReport,
  GenerateScheduleResult,
  ScheduleAudit,
  VacationOverlapBlocked,
} from "./scheduleClientShare";
import { SCHEDULE_SEARCH_BUDGET_MS, SOFT_RULE_TARGET_MAX_EXCLUSIVE } from "./scheduleClientShare";
import {
  isStrenuousConsultB2bHardInModel,
  isTransplantB2bHardInModel,
  readB2bHardFromEnv,
} from "./engine/buildCpSatPayload";
import { getFixedProhibitedVacationOverlapBlock } from "./engine/fixedVacationOverlapCheck";
import { computeVacationOverlapReport as buildVacationOverlapReport } from "./engine/vacationOverlapReport";
import type { CpSatUnavailableDetail } from "./engine/cpSatRuntime";
import { computeWitnessFirstFailureIfConfigured } from "./engine/witnessFromEnv";
import type { VacationOverlapPolicy } from "./vacationOverlapPolicy";
import { normalizeRotationsVacationPolicy } from "./vacationOverlapPolicy";

export type {
  FeasibilityReport,
  GenerateScheduleResult,
  ScheduleAudit,
  StrenuousConsultB2bBestEffortMeta,
  VacationOverlapBlocked,
  VacationOverlapDetailRow,
  VacationOverlapSummary,
} from "./scheduleClientShare";
export type { CpSatUnavailableDetail } from "./engine/cpSatRuntime";
export {
  formatStrenuousBestEffortBanner,
  SCHEDULE_SEARCH_BUDGET_MS,
  SOFT_RULE_TARGET_MAX_EXCLUSIVE,
  STRENUOUS_B2B_BEST_EFFORT_TARGET_MAX_EXCLUSIVE,
} from "./scheduleClientShare";

type Resident = { id: string; program_id: string; pgy: number; is_active: boolean; first_name?: string; last_name?: string };
type Month = {
  id: string;
  academic_year_id: string;
  month_index: number;
  start_date?: string;
  end_date?: string;
};
type Rotation = {
  id: string;
  program_id: string;
  name?: string;
  capacity_per_month: number;
  eligible_pgy_min: number;
  eligible_pgy_max: number;
  is_consult?: boolean;
  is_back_to_back_consult_blocker?: boolean;
  is_transplant?: boolean;
  is_primary_site?: boolean;
  /** `allowed` | `avoid` (soft in CP) | `prohibited` (hard in CP). */
  vacation_overlap_policy?: VacationOverlapPolicy;
};

type Requirement = { pgy: number; rotation_id: string; min_months_required: number };
type VacationRange = { resident_id: string; start_date: string; end_date: string };
type FixedRule = { id: string; resident_id: string; month_id: string; rotation_id: string };

function mulberry32(seed: number): () => number {
  // Deterministic PRNG for schedule generation attempts.
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(array: T[], rng: () => number): T[] {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function capKey(monthId: string, rotationId: string): string {
  return `${monthId}_${rotationId}`;
}

function reqKey(residentId: string, rotationId: string): string {
  return `${residentId}_${rotationId}`;
}

function residentMonthKey(residentId: string, monthId: string): string {
  return `${residentId}_${monthId}`;
}

/**
 * Rotations that count for the **avoid back-to-back consult / strenuous B2B** hard rule (CP-SAT, validateSchedule, heuristic).
 *
 * Uses **only** `is_back_to_back_consult_blocker`. `is_consult` is for vacation / consult-on-vacation behavior — not this rule.
 * Previously we fell back to all `is_consult` rotations when no blockers existed, which incorrectly forbade pairs like
 * Orange C1 → VA Con when both were marked consult for vacation but were not intended as “strenuous” for B2B.
 */
export function buildStrenuousConsultRotationIds(rotationsList: Rotation[]): Set<string> {
  const out = new Set<string>();
  for (const rot of rotationsList) {
    if (rot.is_back_to_back_consult_blocker) out.add(rot.id);
  }
  return out;
}

/**
 * Per resident: count of month boundaries where both adjacent rotations are "strenuous" for B2B rules.
 * User goal: at most one such boundary per resident (residentsOverOne counts those with 2+).
 */
export function computeStrenuousB2BMetrics(
  assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[],
  monthsList: Month[],
  residentsList: Resident[],
  strenuousRotationIds: Set<string>
): { totalEdges: number; residentsOverOne: number } {
  const months = [...monthsList].sort((a, b) => a.month_index - b.month_index);
  const lookup = new Map<string, string | null>();
  for (const row of assignmentRows) {
    lookup.set(residentMonthKey(row.resident_id, row.month_id), row.rotation_id);
  }
  let totalEdges = 0;
  let residentsOverOne = 0;
  for (const res of residentsList) {
    let edges = 0;
    for (let mi = 1; mi < months.length; mi++) {
      const prev = lookup.get(residentMonthKey(res.id, months[mi - 1].id));
      const curr = lookup.get(residentMonthKey(res.id, months[mi].id));
      if (!prev || !curr) continue;
      if (strenuousRotationIds.has(prev) && strenuousRotationIds.has(curr)) {
        edges++;
      }
    }
    totalEdges += edges;
    if (edges > 1) residentsOverOne++;
  }
  return { totalEdges, residentsOverOne };
}

/**
 * True if any resident has consecutive months on the same rotation, or consecutive “strenuous consult”
 * months when that program rule is on, or consecutive transplant months when that rule is on.
 * Used to refuse persisting schedules that violate hard spacing.
 */
export function assignmentHasHardSpacingViolations(
  assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[],
  monthsList: Month[],
  residentsList: Resident[],
  rotationsList: Rotation[],
  avoidBackToBackConsult: boolean,
  avoidBackToBackTransplant: boolean
): boolean {
  const months = [...monthsList].sort((a, b) => a.month_index - b.month_index);
  const lookup = new Map<string, string | null>();
  for (const row of assignmentRows) {
    lookup.set(residentMonthKey(row.resident_id, row.month_id), row.rotation_id);
  }
  const strenuousIds = buildStrenuousConsultRotationIds(rotationsList);
  const transplantIds = new Set<string>();
  for (const rot of rotationsList) {
    if ((rot as Rotation & { is_transplant?: boolean }).is_transplant) transplantIds.add(rot.id);
  }
  const b2bSame = readB2bHardFromEnv().same;
  for (const res of residentsList) {
    for (let mi = 1; mi < months.length; mi++) {
      const a = lookup.get(residentMonthKey(res.id, months[mi - 1].id));
      const b = lookup.get(residentMonthKey(res.id, months[mi].id));
      if (!a || !b) continue;
      if (b2bSame && a === b) return true;
      if (
        isStrenuousConsultB2bHardInModel({ avoidBackToBackConsult }) &&
        strenuousIds.has(a) &&
        strenuousIds.has(b)
      )
        return true;
      if (
        isTransplantB2bHardInModel({ avoidBackToBackTransplant }) &&
        transplantIds.has(a) &&
        transplantIds.has(b)
      )
        return true;
    }
  }
  return false;
}

function isBetterStrenuousMetrics(
  a: { residentsOverOne: number; totalEdges: number },
  b: { residentsOverOne: number; totalEdges: number }
): boolean {
  if (a.residentsOverOne !== b.residentsOverOne) return a.residentsOverOne < b.residentsOverOne;
  return a.totalEdges < b.totalEdges;
}

export type LoadedSchedulerStaticData = {
  monthsList: Month[];
  residentsList: Resident[];
  rotationsList: Rotation[];
  avoidBackToBackConsult: boolean;
  noConsultWhenVacationInMonth: boolean;
  avoidBackToBackTransplant: boolean;
  /** When true, months with 8+ vacation overlap days prefer primary-site rotations only if any exist. */
  preferPrimarySiteForLongVacation: boolean;
  requirePgyStartAtPrimarySite: boolean;
  pgyStartAtPrimarySite: number;
  vacationRanges: VacationRange[];
  /** ISO dates; used to infer month windows when `months` rows lack start/end. */
  academicYearStart: string;
  academicYearEnd: string;
  fixedRuleMap: Map<string, string>;
  /** `residentMonthKey` → `fixed_assignment_rules.id` (empty when fixed rules omitted). */
  fixedRuleIdByKey: Map<string, string>;
  requirementsList: Requirement[];
  residentReqByResident: Map<string, { rotation_id: string; min_months_required: number }[]>;
};

/** Maps → arrays for `debug/current-scheduler-setup.json` and CLI export. */
export function schedulerStaticDataToSerializableJson(data: LoadedSchedulerStaticData): Record<string, unknown> {
  return {
    monthsList: data.monthsList,
    residentsList: data.residentsList,
    rotationsList: data.rotationsList,
    avoidBackToBackConsult: data.avoidBackToBackConsult,
    noConsultWhenVacationInMonth: data.noConsultWhenVacationInMonth,
    avoidBackToBackTransplant: data.avoidBackToBackTransplant,
    preferPrimarySiteForLongVacation: data.preferPrimarySiteForLongVacation,
    requirePgyStartAtPrimarySite: data.requirePgyStartAtPrimarySite,
    pgyStartAtPrimarySite: data.pgyStartAtPrimarySite,
    vacationRanges: data.vacationRanges,
    academicYearStart: data.academicYearStart,
    academicYearEnd: data.academicYearEnd,
    requirementsList: data.requirementsList,
    fixedRuleMap: [...data.fixedRuleMap.entries()],
    fixedRuleIdByKey: [...data.fixedRuleIdByKey.entries()],
    residentReqByResident: [...data.residentReqByResident.entries()],
  };
}

export function schedulerStaticDataFromSerializedJson(raw: Record<string, unknown>): LoadedSchedulerStaticData {
  const fixedPairs = Array.isArray(raw.fixedRuleMap)
    ? (raw.fixedRuleMap as [string, string][])
    : [];
  const fixedIdPairs = Array.isArray(raw.fixedRuleIdByKey)
    ? (raw.fixedRuleIdByKey as [string, string][])
    : [];
  const resReq = Array.isArray(raw.residentReqByResident)
    ? (raw.residentReqByResident as [string, { rotation_id: string; min_months_required: number }][])
    : [];
  const rest = { ...(raw as Record<string, unknown>) };
  delete rest.fixedRuleMap;
  delete rest.fixedRuleIdByKey;
  delete rest.residentReqByResident;
  const rotationsRaw = rest.rotationsList;
  if (Array.isArray(rotationsRaw)) {
    rest.rotationsList = normalizeRotationsVacationPolicy(
      rotationsRaw as { vacation_overlap_policy?: unknown }[]
    );
  }
  return {
    ...rest,
    fixedRuleMap: new Map(fixedPairs),
    fixedRuleIdByKey: new Map(fixedIdPairs),
    residentReqByResident: new Map(resReq),
  } as unknown as LoadedSchedulerStaticData;
}

/** PostgREST / Postgres when a selected column is not in the DB yet (migration not applied). */
function isMissingColumnOrSchemaError(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  const m = (err.message ?? "").toLowerCase();
  const c = err.code ?? "";
  return (
    c === "42703" ||
    m.includes("column") ||
    m.includes("does not exist") ||
    m.includes("schema cache")
  );
}

export async function loadSchedulerStaticData({
  supabaseAdmin,
  academicYearId,
  omitFixedAssignmentRules = false,
}: {
  supabaseAdmin: SupabaseClient;
  academicYearId: string;
  /** When true, skip `fixed_assignment_rules` so CP/heuristic runs without pinned cells (debug / probe). */
  omitFixedAssignmentRules?: boolean;
}): Promise<LoadedSchedulerStaticData> {
  const { data: academicYearRow, error: ayErr } = await supabaseAdmin
    .from("academic_years")
    .select("id, program_id, start_date, end_date")
    .eq("id", academicYearId)
    .single();

  if (ayErr || !academicYearRow) {
    throw new Error("Academic year not found");
  }

  const programId = academicYearRow.program_id as string;
  const yearStart = (academicYearRow as { start_date: string } | null)?.start_date ?? "";
  const yearEnd = (academicYearRow as { end_date: string } | null)?.end_date ?? "";

  const { data: months, error: monthsErr } = await supabaseAdmin
    .from("months")
    .select("id, academic_year_id, month_index, start_date, end_date")
    .eq("academic_year_id", academicYearId)
    .order("month_index", { ascending: true });
  if (monthsErr) throw monthsErr;
  const monthsList = (months ?? []) as Month[];

  const { data: residents, error: residentsErr } = await supabaseAdmin
    .from("residents")
    .select("id, program_id, pgy, is_active, first_name, last_name")
    .eq("program_id", programId)
    .eq("is_active", true);
  if (residentsErr) throw residentsErr;
  const residentsList = (residents ?? []) as Resident[];

  const rotationSelectVariants = [
    "id, program_id, name, capacity_per_month, eligible_pgy_min, eligible_pgy_max, is_consult, is_back_to_back_consult_blocker, is_transplant, is_primary_site, vacation_overlap_policy",
    "id, program_id, name, capacity_per_month, eligible_pgy_min, eligible_pgy_max, is_consult, is_back_to_back_consult_blocker, is_transplant, is_primary_site",
    "id, program_id, name, capacity_per_month, eligible_pgy_min, eligible_pgy_max, is_consult, is_back_to_back_consult_blocker, is_transplant",
    "id, program_id, name, capacity_per_month, eligible_pgy_min, eligible_pgy_max, is_consult, is_transplant",
  ];

  let rotationsList: Rotation[] = [];
  {
    let loaded = false;
    let lastRotErr: { message?: string; code?: string } | null = null;
    for (const sel of rotationSelectVariants) {
      const { data: rotData, error: rotErr } = await supabaseAdmin
        .from("rotations")
        .select(sel)
        .eq("program_id", programId);
      if (!rotErr) {
        rotationsList = (rotData ?? []) as unknown as Rotation[];
        loaded = true;
        break;
      }
      lastRotErr = rotErr;
      if (!isMissingColumnOrSchemaError(rotErr)) throw rotErr;
    }
    if (!loaded && lastRotErr) throw lastRotErr;
    rotationsList = normalizeRotationsVacationPolicy(rotationsList);
  }

  const programSelectFull =
    "avoid_back_to_back_consult, no_consult_when_vacation_in_month, avoid_back_to_back_transplant, prefer_primary_site_for_long_vacation, require_pgy_start_at_primary_site, pgy_start_at_primary_site";
  const programSelectCore =
    "avoid_back_to_back_consult, no_consult_when_vacation_in_month, avoid_back_to_back_transplant";

  let programRow:
    | {
        avoid_back_to_back_consult?: boolean;
        no_consult_when_vacation_in_month?: boolean;
        avoid_back_to_back_transplant?: boolean;
        prefer_primary_site_for_long_vacation?: boolean;
        require_pgy_start_at_primary_site?: boolean;
        pgy_start_at_primary_site?: number | null;
      }
    | null = null;

  {
    const { data, error } = await supabaseAdmin
      .from("programs")
      .select(programSelectFull)
      .eq("id", programId)
      .single();
    if (!error && data) {
      programRow = data;
    } else if (error && isMissingColumnOrSchemaError(error)) {
      const { data: data2, error: err2 } = await supabaseAdmin
        .from("programs")
        .select(programSelectCore)
        .eq("id", programId)
        .single();
      if (err2) throw err2;
      programRow = data2;
    } else if (error) {
      throw error;
    }
  }

  const program = programRow;

  const avoidBackToBackConsult = program?.avoid_back_to_back_consult === true;
  const noConsultWhenVacationInMonth = program?.no_consult_when_vacation_in_month === true;
  const avoidBackToBackTransplant = program?.avoid_back_to_back_transplant === true;
  const preferPrimarySiteForLongVacation = program?.prefer_primary_site_for_long_vacation === true;
  const requirePgyStartAtPrimarySite = program?.require_pgy_start_at_primary_site === true;
  const pgyStartAtPrimarySite =
    typeof program?.pgy_start_at_primary_site === "number" ? program.pgy_start_at_primary_site : 4;

  const { data: vacationRows } = await supabaseAdmin
    .from("vacation_requests")
    .select("resident_id, start_date, end_date")
    .lte("start_date", yearEnd)
    .gte("end_date", yearStart);
  const residentIdSet = new Set(residentsList.map((r) => r.id));
  const vacationRanges = ((vacationRows ?? []) as VacationRange[]).filter((v) =>
    residentIdSet.has(v.resident_id)
  );

  const fixedRuleMap = new Map<string, string>();
  const fixedRuleIdByKey = new Map<string, string>();
  if (!omitFixedAssignmentRules) {
    const { data: fixedRulesRows } = await supabaseAdmin
      .from("fixed_assignment_rules")
      .select("id, resident_id, month_id, rotation_id")
      .eq("academic_year_id", academicYearId);

    const fixedRulesList = (fixedRulesRows ?? []) as FixedRule[];
    for (const r of fixedRulesList) {
      const key = residentMonthKey(r.resident_id, r.month_id);
      fixedRuleMap.set(key, r.rotation_id);
      fixedRuleIdByKey.set(key, r.id);
    }
  }

  const { data: requirements, error: reqErr } = await supabaseAdmin
    .from("rotation_requirements")
    .select("pgy, rotation_id, min_months_required")
    .eq("program_id", programId);
  if (reqErr) throw reqErr;
  const requirementsList = (requirements ?? []) as Requirement[];

  const residentIds = residentsList.map((r) => r.id);
  const { data: residentReqRows } =
    residentIds.length > 0
      ? await supabaseAdmin
          .from("resident_rotation_requirements")
          .select("resident_id, rotation_id, min_months_required")
          .in("resident_id", residentIds)
      : {
          data: [] as { resident_id: string; rotation_id: string; min_months_required: number }[],
        };

  const residentReqByResident = new Map<
    string,
    { rotation_id: string; min_months_required: number }[]
  >();
  for (const row of residentReqRows ?? []) {
    const rid = (row as { resident_id: string }).resident_id;
    if (!residentReqByResident.has(rid)) residentReqByResident.set(rid, []);
    residentReqByResident
      .get(rid)!
      .push(row as { rotation_id: string; min_months_required: number });
  }

  return {
    monthsList,
    residentsList,
    rotationsList,
    avoidBackToBackConsult,
    noConsultWhenVacationInMonth,
    avoidBackToBackTransplant,
    preferPrimarySiteForLongVacation,
    requirePgyStartAtPrimarySite,
    pgyStartAtPrimarySite,
    vacationRanges,
    academicYearStart: yearStart,
    academicYearEnd: yearEnd,
    fixedRuleMap,
    fixedRuleIdByKey,
    requirementsList,
    residentReqByResident,
  };
}

/** Inclusive overlap length in days between [aStart,aEnd] and [bStart,bEnd] (YYYY-MM-DD). */
function vacationOverlapDaysInclusive(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  if (s > e) return 0;
  const d0 = Date.parse(s.length > 10 ? s : `${s}T12:00:00.000Z`);
  const d1 = Date.parse(e.length > 10 ? e : `${e}T12:00:00.000Z`);
  if (Number.isNaN(d0) || Number.isNaN(d1)) return 0;
  return Math.max(0, Math.floor((d1 - d0) / 86400000) + 1);
}

/** When month rows have no dates, split academic year evenly for vacation overlap checks. */
function approximateMonthWindowUtc(
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

async function buildScheduleVariation({
  staticData,
  seed,
  deadlineTs,
  /** First search phase: block consult/strenuous on vacation months when program toggle is on. */
  vacationConsultStrict = false,
}: {
  staticData: LoadedSchedulerStaticData;
  seed: number;
  deadlineTs?: number;
  vacationConsultStrict?: boolean;
}): Promise<{
  assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[];
  audit: ScheduleAudit;
}> {
  const rng = mulberry32(seed);

  const {
    monthsList: monthsRaw,
    residentsList,
    rotationsList,
    avoidBackToBackConsult,
    noConsultWhenVacationInMonth,
    avoidBackToBackTransplant,
    preferPrimarySiteForLongVacation,
    requirePgyStartAtPrimarySite,
    pgyStartAtPrimarySite,
    vacationRanges,
    academicYearStart,
    academicYearEnd,
    fixedRuleMap,
    requirementsList,
    residentReqByResident,
  } = staticData;
  const monthsList = [...monthsRaw].sort((a, b) => a.month_index - b.month_index);

  const consultRotationIdsForVacation = new Set<string>();
  const backToBackBlockerRotationIds = new Set<string>();
  const transplantRotationIds = new Set<string>();
  const primarySiteRotationIds = new Set<string>();
  for (const rot of rotationsList) {
    if ((rot as Rotation & { is_consult?: boolean }).is_consult) consultRotationIdsForVacation.add(rot.id);
    if (
      (rot as Rotation & { is_back_to_back_consult_blocker?: boolean }).is_back_to_back_consult_blocker
    )
      backToBackBlockerRotationIds.add(rot.id);
    if ((rot as Rotation & { is_transplant?: boolean }).is_transplant) transplantRotationIds.add(rot.id);
    if ((rot as Rotation & { is_primary_site?: boolean }).is_primary_site) primarySiteRotationIds.add(rot.id);
  }

  // Backward compatibility: if no blocker rotations are configured, fall back to treating all consult rotations
  // as the strenuous set for back-to-back minimization/audit.
  const consultRotationIdsForBackToBack =
    backToBackBlockerRotationIds.size > 0 ? backToBackBlockerRotationIds : consultRotationIdsForVacation;

  /** Consult / strenuous-blocker rotations (used for soft audit “consult during vacation month”). */
  const isRotationBlockedWhenResidentOnVacation = (rotationId: string): boolean =>
    consultRotationIdsForVacation.has(rotationId) || consultRotationIdsForBackToBack.has(rotationId);

  const vacationSet = new Set<string>();
  const nMonths = monthsList.length;
  for (let mi = 0; mi < monthsList.length; mi++) {
    const month = monthsList[mi]!;
    let mStart = (month.start_date ?? "").trim();
    let mEnd = (month.end_date ?? "").trim();
    if (!mStart || !mEnd) {
      const approx = approximateMonthWindowUtc(
        academicYearStart,
        academicYearEnd,
        mi,
        nMonths
      );
      if (approx) {
        mStart = approx.start;
        mEnd = approx.end;
      }
    }
    if (!mStart || !mEnd) continue;
    for (const resident of residentsList) {
      const hasOverlap = vacationRanges.some(
        (v) => v.resident_id === resident.id && v.start_date <= mEnd && v.end_date >= mStart
      );
      if (hasOverlap) vacationSet.add(residentMonthKey(resident.id, month.id));
    }
  }

  /** True when this would count as a soft-rule “consult during vacation” (audit always; placement blocked only in strict phase). */
  const consultBlockedOnVacationMonth = (residentId: string, monthId: string, rotationId: string): boolean => {
    if (!noConsultWhenVacationInMonth) return false;
    if (!isRotationBlockedWhenResidentOnVacation(rotationId)) return false;
    return vacationSet.has(residentMonthKey(residentId, monthId));
  };

  /** Hard reject for placement/repair/swap when strict vacation phase is active. */
  const vacationHardBlock = (residentId: string, monthId: string, rotationId: string | null): boolean =>
    vacationConsultStrict && rotationId != null && consultBlockedOnVacationMonth(residentId, monthId, rotationId);

  // 3) Build capacity: for each (month, rotation) -> max residents that month (Setup capacity_per_month)
  const capacity = new Map<string, number>();
  for (const month of monthsList) {
    for (const rot of rotationsList) {
      capacity.set(capKey(month.id, rot.id), rot.capacity_per_month);
    }
  }

  // Required: residentId_rotationId -> remaining months (per-resident table if any rows exist, else PGY matrix)
  const required = new Map<string, number>();
  for (const r of residentsList) {
    const custom = residentReqByResident.get(r.id);
    if (custom && custom.length > 0) {
      for (const rot of rotationsList) {
        required.set(reqKey(r.id, rot.id), 0);
      }
      for (const row of custom) {
        required.set(reqKey(r.id, row.rotation_id), row.min_months_required);
      }
    } else {
      for (const req of requirementsList) {
        if (req.pgy !== r.pgy) continue;
        required.set(reqKey(r.id, req.rotation_id), req.min_months_required);
      }
    }
  }

  const initialRequired = new Map<string, number>();
  for (const [k, v] of required) initialRequired.set(k, v);

  const initialReqTotalByResident = new Map<string, number>();
  for (const r of residentsList) {
    let t = 0;
    for (const rot of rotationsList) {
      t += required.get(reqKey(r.id, rot.id)) ?? 0;
    }
    initialReqTotalByResident.set(r.id, t);
  }

  // 4) Build schedule assignments (in-memory only)
  const assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[] = [];

  const rotationById = new Map<string, Rotation>();
  for (const rot of rotationsList) rotationById.set(rot.id, rot);

  const scheduledSet = new Set<string>();
  /** Stable row index per (resident, month); kept in sync with assignmentRows from first assign through repair/swaps. */
  const assignmentIndexMap = new Map<string, number>();

  const applyAssignment = (residentId: string, monthId: string, rotId: string | null) => {
    const idx = assignmentRows.length;
    assignmentRows.push({
      resident_id: residentId,
      month_id: monthId,
      rotation_id: rotId,
    });
    assignmentIndexMap.set(residentMonthKey(residentId, monthId), idx);
    scheduledSet.add(residentMonthKey(residentId, monthId));
    if (rotId) {
      const ck = capKey(monthId, rotId);
      capacity.set(ck, (capacity.get(ck) ?? 0) - 1);
      const rk = reqKey(residentId, rotId);
      const rem = required.get(rk) ?? 0;
      if (rem > 0) required.set(rk, rem - 1);
    }
  };

  const rotAtCell = (residentId: string, monthId: string): string | null => {
    const idx = assignmentIndexMap.get(residentMonthKey(residentId, monthId));
    if (idx === undefined) return null;
    return assignmentRows[idx].rotation_id;
  };

  /** Hard rules: no consecutive same rotation; no consecutive strenuous/blocker consult when enabled; no consecutive transplant when enabled. */
  const residentViolatesHardSpacing = (residentId: string): boolean => {
    for (let mi = 1; mi < monthsList.length; mi++) {
      const prev = rotAtCell(residentId, monthsList[mi - 1].id);
      const curr = rotAtCell(residentId, monthsList[mi].id);
      if (!prev || !curr) continue;
      if (prev === curr) return true;
      if (
        avoidBackToBackConsult &&
        consultRotationIdsForBackToBack.has(prev) &&
        consultRotationIdsForBackToBack.has(curr)
      )
        return true;
      if (avoidBackToBackTransplant && transplantRotationIds.has(prev) && transplantRotationIds.has(curr))
        return true;
    }
    return false;
  };

  const wouldCreateStrenuousB2B = (residentId: string, monthIndex: number, rotationId: string): boolean => {
    if (!avoidBackToBackConsult) return false;
    if (!consultRotationIdsForBackToBack.has(rotationId)) return false;
    if (monthIndex > 0) {
      const prevRotId = rotAtCell(residentId, monthsList[monthIndex - 1].id);
      if (prevRotId && consultRotationIdsForBackToBack.has(prevRotId)) return true;
    }
    if (monthIndex < monthsList.length - 1) {
      const nextRotId = rotAtCell(residentId, monthsList[monthIndex + 1].id);
      if (nextRotId && consultRotationIdsForBackToBack.has(nextRotId)) return true;
    }
    return false;
  };

  /** True if assigning rotationId this month would match the resident's assignment in an adjacent month (never allowed in output). */
  const wouldCreateSameRotationB2B = (residentId: string, monthIndex: number, rotationId: string): boolean => {
    if (monthIndex > 0) {
      const prevRotId = rotAtCell(residentId, monthsList[monthIndex - 1].id);
      if (prevRotId && prevRotId === rotationId) return true;
    }
    if (monthIndex < monthsList.length - 1) {
      const nextRotId = rotAtCell(residentId, monthsList[monthIndex + 1].id);
      if (nextRotId && nextRotId === rotationId) return true;
    }
    return false;
  };

  /** True if assigning rotationId this month would put transplant next to transplant (when that rule is on). */
  const wouldCreateTransplantB2B = (residentId: string, monthIndex: number, rotationId: string): boolean => {
    if (!avoidBackToBackTransplant) return false;
    if (!transplantRotationIds.has(rotationId)) return false;
    if (monthIndex > 0) {
      const prevRotId = rotAtCell(residentId, monthsList[monthIndex - 1].id);
      if (prevRotId && transplantRotationIds.has(prevRotId)) return true;
    }
    if (monthIndex < monthsList.length - 1) {
      const nextRotId = rotAtCell(residentId, monthsList[monthIndex + 1].id);
      if (nextRotId && transplantRotationIds.has(nextRotId)) return true;
    }
    return false;
  };

  const nCalMonths = monthsList.length;

  /**
   * Closest linear distance from monthIndex to another month where this resident already has rotationId.
   * Returns a large sentinel when they have no other month on that rotation yet.
   * Manual “good” grids stagger repeats (e.g. Orange in Jan / Apr / Jun): use this to prefer spread-out
   * placement and to give priority to residents who are spacing-tight when several want the same slot.
   */
  const minLinearDistToExistingSameRotation = (
    residentId: string,
    monthIndex: number,
    rotationId: string
  ): number => {
    let best = nCalMonths + 5;
    let any = false;
    for (let j = 0; j < nCalMonths; j++) {
      if (j === monthIndex) continue;
      if (rotAtCell(residentId, monthsList[j].id) !== rotationId) continue;
      any = true;
      best = Math.min(best, Math.abs(monthIndex - j));
    }
    return any ? best : nCalMonths + 5;
  };

  /** ≥8 vacation days overlapping this academic month → treat as “long vacation” for primary-site preference. */
  const residentHasLongVacationInMonth = (residentId: string, month: Month): boolean => {
    if (!preferPrimarySiteForLongVacation) return false;
    const mStart = month.start_date ?? "";
    const mEnd = month.end_date ?? "";
    let ms = mStart;
    let me = mEnd;
    if (!ms || !me) {
      const idx = monthsList.indexOf(month);
      if (idx < 0) return false;
      const ap = approximateMonthWindowUtc(academicYearStart, academicYearEnd, idx, monthsList.length);
      if (!ap) return false;
      ms = ap.start;
      me = ap.end;
    }
    let maxOverlap = 0;
    for (const v of vacationRanges) {
      if (v.resident_id !== residentId) continue;
      maxOverlap = Math.max(maxOverlap, vacationOverlapDaysInclusive(v.start_date, v.end_date, ms, me));
    }
    return maxOverlap >= 8;
  };

  // --- Phase 1: Vacations (null when no-consult-when-vacation is OFF) ---
  for (const month of monthsList) {
    for (const resident of residentsList) {
      if (scheduledSet.has(residentMonthKey(resident.id, month.id))) continue;
      const onVac = vacationSet.has(residentMonthKey(resident.id, month.id));
      if (onVac && !noConsultWhenVacationInMonth) {
        applyAssignment(resident.id, month.id, null);
      }
    }
  }

  // --- Phase 2: Fixed assignment rules ---
  for (let mi = 0; mi < monthsList.length; mi++) {
    const month = monthsList[mi];
    for (const resident of residentsList) {
      if (scheduledSet.has(residentMonthKey(resident.id, month.id))) continue;
      const ruleRotId = fixedRuleMap.get(residentMonthKey(resident.id, month.id));
      if (!ruleRotId) continue;
      const onVac = vacationSet.has(residentMonthKey(resident.id, month.id));
      if (onVac && !noConsultWhenVacationInMonth) continue;
      const ruleRot = rotationById.get(ruleRotId);
      if (!ruleRot) continue;
      if ((capacity.get(capKey(month.id, ruleRot.id)) ?? 0) <= 0) continue;
      if (
        mi === 0 &&
        requirePgyStartAtPrimarySite &&
        resident.pgy === pgyStartAtPrimarySite &&
        primarySiteRotationIds.size > 0 &&
        !primarySiteRotationIds.has(ruleRot.id)
      ) continue;
      if (vacationHardBlock(resident.id, month.id, ruleRot.id)) continue;
      applyAssignment(resident.id, month.id, ruleRot.id);
    }
  }

  // --- Phase 3: Global rotation-first assignment ---
  // Process rotations by scarcity (demand / supply), most constrained first.
  // For each rotation, distribute all required slots across ALL months at once,
  // preventing the suboptimal month-by-month allocation that was causing
  // under-assignment of tightly-constrained rotations like UCI Orange.
  for (let round = 0; round < 5; round++) {
    const rotScarcity = rotationsList
      .map((rot) => {
        let demand = 0;
        for (const res of residentsList) demand += Math.max(0, required.get(reqKey(res.id, rot.id)) ?? 0);
        let supply = 0;
        for (const m of monthsList) supply += Math.max(0, capacity.get(capKey(m.id, rot.id)) ?? 0);
        return { rot, demand, ratio: supply > 0 ? demand / supply : demand > 0 ? Infinity : 0 };
      })
      .filter((x) => x.demand > 0)
      .sort((a, b) => b.ratio - a.ratio);

    if (rotScarcity.length === 0) break;
    let madeAssignment = false;

    for (const { rot } of rotScarcity) {
      for (const month of shuffle(monthsList, rng)) {
        let cap = capacity.get(capKey(month.id, rot.id)) ?? 0;
        if (cap <= 0) continue;
        const mi = monthsList.indexOf(month);

        let candidates = residentsList.filter((res) => {
          if (scheduledSet.has(residentMonthKey(res.id, month.id))) return false;
          if ((required.get(reqKey(res.id, rot.id)) ?? 0) <= 0) return false;
          if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) return false;
          if (
            mi === 0 &&
            requirePgyStartAtPrimarySite &&
            res.pgy === pgyStartAtPrimarySite &&
            primarySiteRotationIds.size > 0 &&
            !primarySiteRotationIds.has(rot.id)
          ) return false;
          if (vacationHardBlock(res.id, month.id, rot.id)) return false;
          if (wouldCreateSameRotationB2B(res.id, mi, rot.id)) return false;
          if (wouldCreateStrenuousB2B(res.id, mi, rot.id)) return false;
          if (wouldCreateTransplantB2B(res.id, mi, rot.id)) return false;
          return true;
        });

        if (
          preferPrimarySiteForLongVacation &&
          primarySiteRotationIds.size > 0 &&
          !primarySiteRotationIds.has(rot.id)
        ) {
          const noLongVac = candidates.filter((res) => !residentHasLongVacationInMonth(res.id, month));
          if (noLongVac.length > 0) candidates = noLongVac;
        }

        candidates.sort((a, b) => {
          const na = required.get(reqKey(a.id, rot.id)) ?? 0;
          const nb = required.get(reqKey(b.id, rot.id)) ?? 0;
          if (nb !== na) return nb - na;
          const da = minLinearDistToExistingSameRotation(a.id, mi, rot.id);
          const db = minLinearDistToExistingSameRotation(b.id, mi, rot.id);
          if (da !== db) return da - db;
          let ta = 0, tb = 0;
          for (const r of rotationsList) {
            ta += Math.max(0, required.get(reqKey(a.id, r.id)) ?? 0);
            tb += Math.max(0, required.get(reqKey(b.id, r.id)) ?? 0);
          }
          return tb - ta;
        });

        for (const res of candidates) {
          if (cap <= 0) break;
          applyAssignment(res.id, month.id, rot.id);
          cap = capacity.get(capKey(month.id, rot.id)) ?? 0;
          madeAssignment = true;
        }
      }
    }
    if (!madeAssignment) break;
  }

  // --- Phase 3b: Stagger repeats — for each remaining (resident, rotation), take the valid month
  // that maximizes distance to other months already on that rotation (mimics hand-built grids). ---
  for (let p3b = 0; p3b < 3; p3b++) {
    let progressed = false;
    for (const res of shuffle(residentsList, rng)) {
      for (const rot of shuffle(rotationsList, rng)) {
        if ((required.get(reqKey(res.id, rot.id)) ?? 0) <= 0) continue;
        if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) continue;

        let bestMi = -1;
        let bestDist = -1;
        for (let mi = 0; mi < monthsList.length; mi++) {
          const month = monthsList[mi];
          if (scheduledSet.has(residentMonthKey(res.id, month.id))) continue;
          if ((capacity.get(capKey(month.id, rot.id)) ?? 0) <= 0) continue;
          if (vacationHardBlock(res.id, month.id, rot.id)) continue;
          if (wouldCreateSameRotationB2B(res.id, mi, rot.id)) continue;
          if (wouldCreateStrenuousB2B(res.id, mi, rot.id)) continue;
          if (wouldCreateTransplantB2B(res.id, mi, rot.id)) continue;
          if (
            preferPrimarySiteForLongVacation &&
            primarySiteRotationIds.size > 0 &&
            !primarySiteRotationIds.has(rot.id) &&
            residentHasLongVacationInMonth(res.id, month)
          ) {
            continue;
          }
          if (
            mi === 0 &&
            requirePgyStartAtPrimarySite &&
            res.pgy === pgyStartAtPrimarySite &&
            primarySiteRotationIds.size > 0 &&
            !primarySiteRotationIds.has(rot.id)
          )
            continue;

          const d = minLinearDistToExistingSameRotation(res.id, mi, rot.id);
          if (d > bestDist || (d === bestDist && rng() < 0.5 && bestMi >= 0)) {
            bestDist = d;
            bestMi = mi;
          }
        }
        if (bestMi >= 0) {
          applyAssignment(res.id, monthsList[bestMi].id, rot.id);
          progressed = true;
        }
      }
    }
    if (!progressed) break;
  }

  // --- Phase 4: Fill remaining unscheduled slots ---
  for (const month of shuffle([...monthsList], rng)) {
    const sortedRes = [...residentsList].sort((a, b) => {
      let ta = 0, tb = 0;
      for (const r of rotationsList) {
        ta += Math.max(0, required.get(reqKey(a.id, r.id)) ?? 0);
        tb += Math.max(0, required.get(reqKey(b.id, r.id)) ?? 0);
      }
      return tb - ta;
    });

    for (const resident of sortedRes) {
      if (scheduledSet.has(residentMonthKey(resident.id, month.id))) continue;

      let remainingTotal = 0;
      for (const rot of rotationsList) {
        remainingTotal += Math.max(0, required.get(reqKey(resident.id, rot.id)) ?? 0);
      }
      const hadExplicitTargets = (initialReqTotalByResident.get(resident.id) ?? 0) > 0;

      if (remainingTotal === 0 && hadExplicitTargets) {
        applyAssignment(resident.id, month.id, null);
        continue;
      }

      const fillMi = monthsList.indexOf(month);
      let eligible = rotationsList.filter((r) => {
        if (resident.pgy < r.eligible_pgy_min || resident.pgy > r.eligible_pgy_max) return false;
        if ((capacity.get(capKey(month.id, r.id)) ?? 0) <= 0) return false;
        if (vacationHardBlock(resident.id, month.id, r.id)) return false;
        if (wouldCreateSameRotationB2B(resident.id, fillMi, r.id)) return false;
        if (wouldCreateStrenuousB2B(resident.id, fillMi, r.id)) return false;
        if (wouldCreateTransplantB2B(resident.id, fillMi, r.id)) return false;
        return (required.get(reqKey(resident.id, r.id)) ?? 0) > 0;
      });
      if (
        preferPrimarySiteForLongVacation &&
        primarySiteRotationIds.size > 0 &&
        residentHasLongVacationInMonth(resident.id, month)
      ) {
        const withPrimary = eligible.filter((r) => primarySiteRotationIds.has(r.id));
        if (withPrimary.length > 0) eligible = withPrimary;
      }
      eligible = eligible.sort((a, b) => {
          const ra = required.get(reqKey(resident.id, a.id)) ?? 0;
          const rb = required.get(reqKey(resident.id, b.id)) ?? 0;
          if (rb !== ra) return rb - ra;
          const dSameA = minLinearDistToExistingSameRotation(resident.id, fillMi, a.id);
          const dSameB = minLinearDistToExistingSameRotation(resident.id, fillMi, b.id);
          if (dSameB !== dSameA) return dSameB - dSameA;
          const capA = capacity.get(capKey(month.id, a.id)) ?? 0;
          const capB = capacity.get(capKey(month.id, b.id)) ?? 0;
          if (capB !== capA) return capB - capA;
          return a.id.localeCompare(b.id);
      });

      if (eligible.length > 0) {
        applyAssignment(resident.id, month.id, eligible[0].id);
      } else {
        applyAssignment(resident.id, month.id, null);
      }
    }
  }

  // ---- REPAIR PASS: fill unmet requirements (never break hard spacing rules) ----

  /** Reset remaining-capacity map from current assignmentRows (fixes drift after complex swaps). */
  const rebuildCapacityFromAssignments = () => {
    for (const month of monthsList) {
      for (const rot of rotationsList) {
        capacity.set(capKey(month.id, rot.id), rot.capacity_per_month);
      }
    }
    for (const row of assignmentRows) {
      if (!row.rotation_id) continue;
      const ck = capKey(row.month_id, row.rotation_id);
      capacity.set(ck, (capacity.get(ck) ?? 0) - 1);
    }
  };

  const runRepairPass = (rounds: number) => {
    for (let repairRound = 0; repairRound < rounds; repairRound++) {
      rebuildCapacityFromAssignments();
      let improved = false;

    // Phase A: fill unassigned months with needed rotations (ignoring soft rules)
    for (const resident of residentsList) {
      const shortfalls: { rotation: Rotation; remaining: number }[] = [];
      for (const rot of rotationsList) {
        const rem = required.get(reqKey(resident.id, rot.id)) ?? 0;
        if (rem > 0) shortfalls.push({ rotation: rot, remaining: rem });
      }
      shortfalls.sort((a, b) => b.remaining - a.remaining);

      for (const { rotation: rot } of shortfalls) {
        for (const month of monthsList) {
          if ((required.get(reqKey(resident.id, rot.id)) ?? 0) <= 0) break;
          const idx = assignmentIndexMap.get(residentMonthKey(resident.id, month.id));
          if (idx === undefined) continue;
          if (assignmentRows[idx].rotation_id !== null) continue;

          const ck = capKey(month.id, rot.id);
          if ((capacity.get(ck) ?? 0) <= 0) continue;
          if (resident.pgy < rot.eligible_pgy_min || resident.pgy > rot.eligible_pgy_max) continue;
          if (vacationHardBlock(resident.id, month.id, rot.id)) continue;
          const miA = monthsList.indexOf(month);
          if (miA < 0) continue;
          if (wouldCreateSameRotationB2B(resident.id, miA, rot.id)) continue;
          if (wouldCreateStrenuousB2B(resident.id, miA, rot.id)) continue;
          if (wouldCreateTransplantB2B(resident.id, miA, rot.id)) continue;

          assignmentRows[idx].rotation_id = rot.id;
          capacity.set(ck, (capacity.get(ck) ?? 0) - 1);
          const rk = reqKey(resident.id, rot.id);
          required.set(rk, (required.get(rk) ?? 0) - 1);
          improved = true;
        }
      }
    }

    // Phase B: swap over-assigned rotations for under-assigned needed ones
    for (const resident of residentsList) {
      for (const rot of rotationsList) {
        if ((required.get(reqKey(resident.id, rot.id)) ?? 0) <= 0) continue;
        if (resident.pgy < rot.eligible_pgy_min || resident.pgy > rot.eligible_pgy_max) continue;

        for (const month of monthsList) {
          if ((required.get(reqKey(resident.id, rot.id)) ?? 0) <= 0) break;
          const idx = assignmentIndexMap.get(residentMonthKey(resident.id, month.id));
          if (idx === undefined) continue;
          const currentRotId = assignmentRows[idx].rotation_id;
          if (currentRotId === null || currentRotId === rot.id) continue;

          const currentInit = initialRequired.get(reqKey(resident.id, currentRotId)) ?? 0;
          let currentCount = 0;
          for (const row of assignmentRows) {
            if (row.resident_id === resident.id && row.rotation_id === currentRotId) currentCount++;
          }
          if (currentCount <= currentInit) continue;

          const ck = capKey(month.id, rot.id);
          if ((capacity.get(ck) ?? 0) <= 0) continue;
          if (vacationHardBlock(resident.id, month.id, rot.id)) continue;
          const miB = monthsList.indexOf(month);
          if (miB < 0) continue;
          if (wouldCreateSameRotationB2B(resident.id, miB, rot.id)) continue;
          if (wouldCreateStrenuousB2B(resident.id, miB, rot.id)) continue;
          if (wouldCreateTransplantB2B(resident.id, miB, rot.id)) continue;

          const oldCk = capKey(month.id, currentRotId);
          capacity.set(oldCk, (capacity.get(oldCk) ?? 0) + 1);
          capacity.set(ck, (capacity.get(ck) ?? 0) - 1);
          required.set(reqKey(resident.id, rot.id), (required.get(reqKey(resident.id, rot.id)) ?? 0) - 1);
          assignmentRows[idx].rotation_id = rot.id;
          improved = true;
        }
      }
    }

    // Phase C: within-resident month rearrangement
    for (const resident of residentsList) {
      const neededRotations: { rot: Rotation; rem: number }[] = [];
      for (const rot of rotationsList) {
        const rem = required.get(reqKey(resident.id, rot.id)) ?? 0;
        if (rem > 0 && resident.pgy >= rot.eligible_pgy_min && resident.pgy <= rot.eligible_pgy_max) {
          neededRotations.push({ rot, rem });
        }
      }
      if (neededRotations.length === 0) continue;
      neededRotations.sort((a, b) => b.rem - a.rem);

      for (const { rot: neededRot } of neededRotations) {
        for (const monthM of monthsList) {
          if ((required.get(reqKey(resident.id, neededRot.id)) ?? 0) <= 0) break;

          const ckX = capKey(monthM.id, neededRot.id);
          if ((capacity.get(ckX) ?? 0) <= 0) continue;
          if (vacationHardBlock(resident.id, monthM.id, neededRot.id)) continue;

          const idxM = assignmentIndexMap.get(residentMonthKey(resident.id, monthM.id));
          if (idxM === undefined) continue;
          const currentRotId = assignmentRows[idxM].rotation_id;
          if (currentRotId === null || currentRotId === neededRot.id) continue;

          for (const monthMp of monthsList) {
            if (monthMp.id === monthM.id) continue;
            const idxMp = assignmentIndexMap.get(residentMonthKey(resident.id, monthMp.id));
            if (idxMp === undefined) continue;
            if (assignmentRows[idxMp].rotation_id !== null) continue;

            const ckY = capKey(monthMp.id, currentRotId);
            if ((capacity.get(ckY) ?? 0) <= 0) continue;
            if (vacationHardBlock(resident.id, monthMp.id, currentRotId)) continue;

            assignmentRows[idxMp].rotation_id = currentRotId;
            const ckYinM = capKey(monthM.id, currentRotId);
            capacity.set(ckYinM, (capacity.get(ckYinM) ?? 0) + 1);
            capacity.set(ckY, (capacity.get(ckY) ?? 0) - 1);

            assignmentRows[idxM].rotation_id = neededRot.id;
            capacity.set(ckX, (capacity.get(ckX) ?? 0) - 1);
            required.set(
              reqKey(resident.id, neededRot.id),
              (required.get(reqKey(resident.id, neededRot.id)) ?? 0) - 1
            );
            if (residentViolatesHardSpacing(resident.id)) {
              required.set(
                reqKey(resident.id, neededRot.id),
                (required.get(reqKey(resident.id, neededRot.id)) ?? 0) + 1
              );
              capacity.set(ckX, (capacity.get(ckX) ?? 0) + 1);
              assignmentRows[idxM].rotation_id = currentRotId;
              capacity.set(ckY, (capacity.get(ckY) ?? 0) + 1);
              capacity.set(ckYinM, (capacity.get(ckYinM) ?? 0) - 1);
              assignmentRows[idxMp].rotation_id = null;
            } else {
              improved = true;
              break;
            }
          }
        }
      }
    }

    // Phase E: Cross-resident redistribution
    // When resident A needs rotation X but all slots are taken, find resident B
    // who has more X than required and swap their assignments.
    for (const resA of residentsList) {
      for (const rot of rotationsList) {
        if ((required.get(reqKey(resA.id, rot.id)) ?? 0) <= 0) continue;
        if (resA.pgy < rot.eligible_pgy_min || resA.pgy > rot.eligible_pgy_max) continue;

        for (const month of monthsList) {
          if ((required.get(reqKey(resA.id, rot.id)) ?? 0) <= 0) break;

          const idxA = assignmentIndexMap.get(residentMonthKey(resA.id, month.id));
          if (idxA === undefined) continue;
          const aRotId = assignmentRows[idxA].rotation_id;

          // If capacity exists and A is unassigned, assign directly (Phase A catch-up)
          if ((capacity.get(capKey(month.id, rot.id)) ?? 0) > 0 && aRotId === null) {
            if (vacationHardBlock(resA.id, month.id, rot.id)) continue;
            const miE0 = monthsList.indexOf(month);
            if (miE0 < 0) continue;
            if (wouldCreateSameRotationB2B(resA.id, miE0, rot.id)) continue;
            if (wouldCreateStrenuousB2B(resA.id, miE0, rot.id)) continue;
            if (wouldCreateTransplantB2B(resA.id, miE0, rot.id)) continue;
            const capK = capKey(month.id, rot.id);
            assignmentRows[idxA].rotation_id = rot.id;
            capacity.set(capK, (capacity.get(capK) ?? 0) - 1);
            required.set(reqKey(resA.id, rot.id), (required.get(reqKey(resA.id, rot.id)) ?? 0) - 1);
            if (residentViolatesHardSpacing(resA.id)) {
              assignmentRows[idxA].rotation_id = null;
              capacity.set(capK, (capacity.get(capK) ?? 0) + 1);
              required.set(reqKey(resA.id, rot.id), (required.get(reqKey(resA.id, rot.id)) ?? 0) + 1);
              continue;
            }
            improved = true;
            continue;
          }

          // No capacity for rot: find resident B with excess rot in this month
          for (const resB of residentsList) {
            if (resB.id === resA.id) continue;
            if ((required.get(reqKey(resA.id, rot.id)) ?? 0) <= 0) break;

            const idxB = assignmentIndexMap.get(residentMonthKey(resB.id, month.id));
            if (idxB === undefined) continue;
            if (assignmentRows[idxB].rotation_id !== rot.id) continue;

            // Check B has excess of rot
            const bInit = initialRequired.get(reqKey(resB.id, rot.id)) ?? 0;
            let bCount = 0;
            for (const row of assignmentRows) {
              if (row.resident_id === resB.id && row.rotation_id === rot.id) bCount++;
            }
            if (bCount <= bInit) continue;

            if (aRotId === null) {
              if (vacationHardBlock(resA.id, month.id, rot.id)) continue;
              const miE1 = monthsList.indexOf(month);
              if (miE1 < 0) continue;
              if (wouldCreateSameRotationB2B(resA.id, miE1, rot.id)) continue;
              if (wouldCreateStrenuousB2B(resA.id, miE1, rot.id)) continue;
              if (wouldCreateTransplantB2B(resA.id, miE1, rot.id)) continue;
              // A unassigned, B has excess: A takes rot, B gets null
              const capRot = capKey(month.id, rot.id);
              capacity.set(capRot, (capacity.get(capRot) ?? 0) + 1);
              capacity.set(capRot, (capacity.get(capRot) ?? 0) - 1);

              const rkA = reqKey(resA.id, rot.id);
              const remA = required.get(rkA) ?? 0;
              if (remA > 0) required.set(rkA, remA - 1);

              const rkB = reqKey(resB.id, rot.id);
              const remB = required.get(rkB) ?? 0;
              if (remB > 0) required.set(rkB, remB + 1);

              assignmentRows[idxA].rotation_id = rot.id;
              assignmentRows[idxB].rotation_id = null;
              if (residentViolatesHardSpacing(resA.id) || residentViolatesHardSpacing(resB.id)) {
                assignmentRows[idxA].rotation_id = null;
                assignmentRows[idxB].rotation_id = rot.id;
                if (remA > 0) required.set(rkA, remA);
                if (remB > 0) required.set(rkB, remB);
                continue;
              }
              improved = true;
              break;
            }

            // A has aRotId. Check if A has excess of it.
            if (aRotId) {
              const aInitOld = initialRequired.get(reqKey(resA.id, aRotId)) ?? 0;
              let aCountOld = 0;
              for (const row of assignmentRows) {
                if (row.resident_id === resA.id && row.rotation_id === aRotId) aCountOld++;
              }
              if (aCountOld <= aInitOld) continue;

              const aRotObj = rotationById.get(aRotId);
              if (!aRotObj) continue;
              if (resB.pgy < aRotObj.eligible_pgy_min || resB.pgy > aRotObj.eligible_pgy_max) continue;
              if (vacationHardBlock(resA.id, month.id, rot.id)) continue;
              if (vacationHardBlock(resB.id, month.id, aRotId)) continue;
              const miE2 = monthsList.indexOf(month);
              if (miE2 < 0) continue;
              if (wouldCreateSameRotationB2B(resA.id, miE2, rot.id)) continue;
              if (wouldCreateStrenuousB2B(resA.id, miE2, rot.id)) continue;
              if (wouldCreateTransplantB2B(resA.id, miE2, rot.id)) continue;
              if (wouldCreateSameRotationB2B(resB.id, miE2, aRotId)) continue;
              if (wouldCreateStrenuousB2B(resB.id, miE2, aRotId)) continue;
              if (wouldCreateTransplantB2B(resB.id, miE2, aRotId)) continue;

              // Swap within the same month: A(aRotId)->rot and B(rot)->aRotId.
              const capRot = capKey(month.id, rot.id);
              const capA = capKey(month.id, aRotId);

              capacity.set(capRot, (capacity.get(capRot) ?? 0) + 1);
              capacity.set(capA, (capacity.get(capA) ?? 0) - 1);

              capacity.set(capA, (capacity.get(capA) ?? 0) + 1);
              capacity.set(capRot, (capacity.get(capRot) ?? 0) - 1);

              const rkAOld = reqKey(resA.id, aRotId);
              const remAOld = required.get(rkAOld) ?? 0;
              if (remAOld > 0) required.set(rkAOld, remAOld + 1);

              const rkANew = reqKey(resA.id, rot.id);
              const remANew = required.get(rkANew) ?? 0;
              if (remANew > 0) required.set(rkANew, remANew - 1);

              const rkBOld = reqKey(resB.id, rot.id);
              const remBOld = required.get(rkBOld) ?? 0;
              if (remBOld > 0) required.set(rkBOld, remBOld + 1);

              const rkBNew = reqKey(resB.id, aRotId);
              const remBNew = required.get(rkBNew) ?? 0;
              if (remBNew > 0) required.set(rkBNew, remBNew - 1);

              assignmentRows[idxA].rotation_id = rot.id;
              assignmentRows[idxB].rotation_id = aRotId;
              if (residentViolatesHardSpacing(resA.id) || residentViolatesHardSpacing(resB.id)) {
                assignmentRows[idxA].rotation_id = aRotId;
                assignmentRows[idxB].rotation_id = rot.id;
                if (remAOld > 0) required.set(rkAOld, remAOld);
                if (remANew > 0) required.set(rkANew, remANew);
                if (remBOld > 0) required.set(rkBOld, remBOld);
                if (remBNew > 0) required.set(rkBNew, remBNew);
                continue;
              }
              improved = true;
              break;
            }
          }
        }
      }
    }

      if (!improved) break;
    }
  };

  // First repair attempt (requirements only; hard spacing enforced inside the pass).
  runRepairPass(12);

  // ---- Hard requirement verification gate (must be zero unmet) ----
  const assignedCountForGate = new Map<string, number>();
  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const key = reqKey(row.resident_id, row.rotation_id);
    assignedCountForGate.set(key, (assignedCountForGate.get(key) ?? 0) + 1);
  }

  let hasUnmetRequirements = false;
  for (const [key, init] of initialRequired) {
    const assigned = assignedCountForGate.get(key) ?? 0;
    if (assigned !== init) {
      hasUnmetRequirements = true;
      break;
    }
  }

  // If anything is still unmet, rerun the hard-requirement repair pass with a higher cap
  // before we even start minimizing soft rule violations.
  if (hasUnmetRequirements) {
    runRepairPass(12);
  }

  // Phase F: final hard-requirement closure (capacity-safe swaps). Re-runnable after repair passes.
  const residentById = new Map<string, Resident>();
  for (const r of residentsList) residentById.set(r.id, r);

  const splitReqKey = (k: string): { residentId: string; rotationId: string } => {
    const u = k.indexOf("_");
    if (u < 0) return { residentId: k, rotationId: "" };
    return { residentId: k.slice(0, u), rotationId: k.slice(u + 1) };
  };

  const runPhaseFEnforce = () => {
    const assignedCountForEnforce = new Map<string, number>();
    const monthRotationToIndices = new Map<string, number[]>();

    const rebuildPhaseFState = () => {
      rebuildCapacityFromAssignments();
      assignedCountForEnforce.clear();
      for (const row of assignmentRows) {
        if (!row.rotation_id) continue;
        const k = reqKey(row.resident_id, row.rotation_id);
        assignedCountForEnforce.set(k, (assignedCountForEnforce.get(k) ?? 0) + 1);
      }
      monthRotationToIndices.clear();
      for (let idx = 0; idx < assignmentRows.length; idx++) {
        const row = assignmentRows[idx];
        if (!row.rotation_id) continue;
        const k = capKey(row.month_id, row.rotation_id);
        if (!monthRotationToIndices.has(k)) monthRotationToIndices.set(k, []);
        monthRotationToIndices.get(k)!.push(idx);
      }
    };

    const enforceMaxIters = 20000;
    for (let iter = 0; iter < enforceMaxIters; iter++) {
      rebuildPhaseFState();

      let deficitKey: string | null = null;
      let bestGap = -Infinity;
      for (const [k, init] of initialRequired) {
        if (init <= 0) continue;
        const assigned = assignedCountForEnforce.get(k) ?? 0;
        const gap = init - assigned;
        if (gap > 0 && gap > bestGap) {
          bestGap = gap;
          deficitKey = k;
        }
      }
      if (!deficitKey) break;

      const { residentId: resId, rotationId: neededRotId } = splitReqKey(deficitKey);
      const res = residentById.get(resId);
      const neededRot = rotationById.get(neededRotId);
      if (!res || !neededRot) break;

      let applied = false;

      for (const month of monthsList) {
        if (res.pgy < neededRot.eligible_pgy_min || res.pgy > neededRot.eligible_pgy_max) continue;

        const idxA = assignmentIndexMap.get(residentMonthKey(res.id, month.id));
        if (idxA === undefined) continue;

        const currRotIdA = assignmentRows[idxA].rotation_id;
        if (currRotIdA === neededRot.id) continue;

        // Case 1: Direct placement if capacity remains (capacity map matches assignmentRows this iter).
        const canPlaceDirectly = (capacity.get(capKey(month.id, neededRot.id)) ?? 0) > 0;
        if (canPlaceDirectly) {
          if (vacationHardBlock(res.id, month.id, neededRot.id)) continue;
          const miF = monthsList.indexOf(month);
          if (miF < 0) continue;
          if (wouldCreateSameRotationB2B(res.id, miF, neededRot.id)) continue;
          if (wouldCreateStrenuousB2B(res.id, miF, neededRot.id)) continue;
          if (wouldCreateTransplantB2B(res.id, miF, neededRot.id)) continue;
          const savedA = assignmentRows[idxA].rotation_id;
          assignmentRows[idxA].rotation_id = neededRot.id;
          if (residentViolatesHardSpacing(res.id)) {
            assignmentRows[idxA].rotation_id = savedA;
            continue;
          }
          applied = true;
          break;
        }

        // Case 2: Capacity is full -> swap within the same month with a resident B on neededRot.
        const candidatesB = monthRotationToIndices.get(capKey(month.id, neededRot.id)) ?? [];
        if (candidatesB.length === 0) continue;

        for (const idxB of candidatesB) {
          const rowB = assignmentRows[idxB];
          if (rowB.resident_id === res.id) continue;
          if (rowB.rotation_id !== neededRot.id) continue;

          // B will take A's current rotation (or become null).
          if (currRotIdA) {
            const bRes = residentById.get(rowB.resident_id);
            const currRotObj = rotationById.get(currRotIdA);
            if (!bRes || !currRotObj) continue;
            if (bRes.pgy < currRotObj.eligible_pgy_min || bRes.pgy > currRotObj.eligible_pgy_max) continue;
          }

          if (vacationHardBlock(res.id, month.id, neededRot.id)) continue;
          if (currRotIdA && vacationHardBlock(rowB.resident_id, month.id, currRotIdA)) continue;
          const miF2 = monthsList.indexOf(month);
          if (miF2 < 0) continue;
          if (wouldCreateSameRotationB2B(res.id, miF2, neededRot.id)) continue;
          if (wouldCreateStrenuousB2B(res.id, miF2, neededRot.id)) continue;
          if (wouldCreateTransplantB2B(res.id, miF2, neededRot.id)) continue;
          if (currRotIdA) {
            if (wouldCreateSameRotationB2B(rowB.resident_id, miF2, currRotIdA)) continue;
            if (wouldCreateStrenuousB2B(rowB.resident_id, miF2, currRotIdA)) continue;
            if (wouldCreateTransplantB2B(rowB.resident_id, miF2, currRotIdA)) continue;
          }

          const savedA2 = assignmentRows[idxA].rotation_id;
          const savedB2 = assignmentRows[idxB].rotation_id;
          assignmentRows[idxA].rotation_id = neededRot.id;
          assignmentRows[idxB].rotation_id = currRotIdA ?? null;
          if (
            residentViolatesHardSpacing(res.id) ||
            residentViolatesHardSpacing(rowB.resident_id)
          ) {
            assignmentRows[idxA].rotation_id = savedA2;
            assignmentRows[idxB].rotation_id = savedB2;
            continue;
          }
          applied = true;
          break;
        }

        if (applied) break;
      }

      if (!applied) continue;
    }
  };

  runPhaseFEnforce();

  // Repair / Phase F again after enforce (strict vacation blocks placement in first search phase only).
  runRepairPass(12);
  runPhaseFEnforce();
  runRepairPass(12);

  // Phase D: staged score-based minimizer (same-resident month swaps; preserves rotation counts).
  // Order: (1) different strenuous consult B2B, (2) same strenuous rotation B2B, (3) transplant B2B (+ PGY-start exploration via base indices).
  const getRotAt = (resId: string, mIdx: number): string | null => {
    if (mIdx < 0 || mIdx >= monthsList.length) return null;
    const idx = assignmentIndexMap.get(residentMonthKey(resId, monthsList[mIdx].id));
    return idx !== undefined ? assignmentRows[idx].rotation_id : null;
  };

  /** Same strenuous/blocker rotation in consecutive months (e.g. UCI Orange → UCI Orange). Highest impact. */
  const sameStrenuousRotationBackToBack = (rotA: string | null, rotB: string | null): number => {
    if (!avoidBackToBackConsult || !rotA || !rotB || rotA !== rotB) return 0;
    if (!consultRotationIdsForBackToBack.has(rotA)) return 0;
    return 1;
  };

  /** Two different strenuous consult rotations in consecutive months (e.g. Orange → VA Consult). */
  const differentStrenuousConsultBackToBack = (rotA: string | null, rotB: string | null): number => {
    if (!avoidBackToBackConsult || !rotA || !rotB || rotA === rotB) return 0;
    if (!consultRotationIdsForBackToBack.has(rotA) || !consultRotationIdsForBackToBack.has(rotB)) return 0;
    return 1;
  };

  const transplantPairViolation = (rotA: string | null, rotB: string | null): number => {
    if (!rotA || !rotB) return 0;
    if (avoidBackToBackTransplant && transplantRotationIds.has(rotA) && transplantRotationIds.has(rotB)) return 1;
    return 0;
  };

  /** Same rotation in consecutive months (any rotation), e.g. VA Dialysis → VA Dialysis. */
  const sameAnyRotationBackToBack = (rotA: string | null, rotB: string | null): number => {
    if (!rotA || !rotB || rotA !== rotB) return 0;
    return 1;
  };

  /** Combined tertiary score (Phase D3): transplant B2B only; consult spacing is handled in D1/D2. */
  const tertiaryPairMetric = (rotA: string | null, rotB: string | null): number =>
    transplantPairViolation(rotA, rotB);

  const pgyStartViolationCount = (resident: Resident): number => {
    if (!requirePgyStartAtPrimarySite) return 0;
    if (resident.pgy !== pgyStartAtPrimarySite) return 0;
    const firstRotId = getRotAt(resident.id, 0);
    if (!firstRotId) return 0;
    return primarySiteRotationIds.has(firstRotId) ? 0 : 1;
  };

  const rotAfterSwap = (resId: string, i: number, j: number, rotI: string, rotJ: string, idx: number): string | null => {
    if (idx === i) return rotJ;
    if (idx === j) return rotI;
    return getRotAt(resId, idx);
  };

  const deltaMetricForSwap = (
    resident: Resident,
    i: number,
    j: number,
    metric: (a: string | null, b: string | null) => number
  ): number => {
    const rotI = getRotAt(resident.id, i);
    const rotJ = getRotAt(resident.id, j);
    if (!rotI || !rotJ || rotI === rotJ) return 0;

    let delta = 0;

    const affectedPairStarts = new Set<number>([i - 1, i, j - 1, j]);
    for (const start of affectedPairStarts) {
      if (start < 0 || start >= monthsList.length - 1) continue;

      const oldPrev = getRotAt(resident.id, start);
      const oldCurr = getRotAt(resident.id, start + 1);
      const newPrev = rotAfterSwap(resident.id, i, j, rotI, rotJ, start);
      const newCurr = rotAfterSwap(resident.id, i, j, rotI, rotJ, start + 1);

      delta += metric(newPrev, newCurr) - metric(oldPrev, oldCurr);
    }

    return delta;
  };

  /** Phase D3: never undo D1/D1 spacing wins when optimizing transplant. */
  const deltaTertiaryPairScoreForSwap = (resident: Resident, i: number, j: number): number => {
    if (avoidBackToBackConsult) {
      if (deltaMetricForSwap(resident, i, j, differentStrenuousConsultBackToBack) > 0) {
        return Number.POSITIVE_INFINITY;
      }
      if (deltaMetricForSwap(resident, i, j, sameStrenuousRotationBackToBack) > 0) {
        return Number.POSITIVE_INFINITY;
      }
    }
    return deltaMetricForSwap(resident, i, j, tertiaryPairMetric);
  };

  /** Phase D4: reduce same-rotation B2B for any service without worsening strenuous consult or transplant B2B. */
  const deltaAnySameRotationScoreForSwap = (resident: Resident, i: number, j: number): number => {
    if (avoidBackToBackConsult) {
      if (deltaMetricForSwap(resident, i, j, differentStrenuousConsultBackToBack) > 0) {
        return Number.POSITIVE_INFINITY;
      }
      if (deltaMetricForSwap(resident, i, j, sameStrenuousRotationBackToBack) > 0) {
        return Number.POSITIVE_INFINITY;
      }
    }
    if (avoidBackToBackTransplant) {
      if (deltaMetricForSwap(resident, i, j, transplantPairViolation) > 0) {
        return Number.POSITIVE_INFINITY;
      }
    }
    return deltaMetricForSwap(resident, i, j, sameAnyRotationBackToBack);
  };

  const applySwap = (resident: Resident, i: number, j: number) => {
    const idxI = assignmentIndexMap.get(residentMonthKey(resident.id, monthsList[i].id));
    const idxJ = assignmentIndexMap.get(residentMonthKey(resident.id, monthsList[j].id));
    if (idxI === undefined || idxJ === undefined) return false;

    const rotI = assignmentRows[idxI].rotation_id;
    const rotJ = assignmentRows[idxJ].rotation_id;
    if (!rotI || !rotJ || rotI === rotJ) return false;

    // Hard constraint: ensure both rotations can fit in the opposite months by capacity.
    if ((capacity.get(capKey(monthsList[j].id, rotI)) ?? 0) < 1) return false;
    if ((capacity.get(capKey(monthsList[i].id, rotJ)) ?? 0) < 1) return false;

    if (vacationHardBlock(resident.id, monthsList[i].id, rotJ)) return false;
    if (vacationHardBlock(resident.id, monthsList[j].id, rotI)) return false;

    // Month i: rotI -> rotJ (release rotI, consume rotJ)
    capacity.set(capKey(monthsList[i].id, rotI), (capacity.get(capKey(monthsList[i].id, rotI)) ?? 0) + 1);
    capacity.set(capKey(monthsList[i].id, rotJ), (capacity.get(capKey(monthsList[i].id, rotJ)) ?? 0) - 1);

    // Month j: rotJ -> rotI (release rotJ, consume rotI)
    capacity.set(capKey(monthsList[j].id, rotJ), (capacity.get(capKey(monthsList[j].id, rotJ)) ?? 0) + 1);
    capacity.set(capKey(monthsList[j].id, rotI), (capacity.get(capKey(monthsList[j].id, rotI)) ?? 0) - 1);

    assignmentRows[idxI].rotation_id = rotJ;
    assignmentRows[idxJ].rotation_id = rotI;
    if (residentViolatesHardSpacing(resident.id)) {
      assignmentRows[idxI].rotation_id = rotI;
      assignmentRows[idxJ].rotation_id = rotJ;
      capacity.set(capKey(monthsList[i].id, rotI), (capacity.get(capKey(monthsList[i].id, rotI)) ?? 0) + 1);
      capacity.set(capKey(monthsList[i].id, rotJ), (capacity.get(capKey(monthsList[i].id, rotJ)) ?? 0) - 1);
      capacity.set(capKey(monthsList[j].id, rotJ), (capacity.get(capKey(monthsList[j].id, rotJ)) ?? 0) + 1);
      capacity.set(capKey(monthsList[j].id, rotI), (capacity.get(capKey(monthsList[j].id, rotI)) ?? 0) - 1);
      return false;
    }
    return true;
  };

  const residentPairScoreWithMetric = (
    resident: Resident,
    metric: (a: string | null, b: string | null) => number
  ): number => {
    let score = 0;
    for (let mi = 1; mi < monthsList.length; mi++) {
      score += metric(getRotAt(resident.id, mi - 1), getRotAt(resident.id, mi));
    }
    return score;
  };

  const residentPairScoreIfSwappedWithMetric = (
    res: Resident,
    i: number,
    j: number,
    metric: (a: string | null, b: string | null) => number
  ): number => {
    const getVirt = (mIdx: number): string | null => {
      if (mIdx === i) return getRotAt(res.id, j);
      if (mIdx === j) return getRotAt(res.id, i);
      return getRotAt(res.id, mIdx);
    };
    let score = 0;
    for (let mi = 1; mi < monthsList.length; mi++) {
      score += metric(getVirt(mi - 1), getVirt(mi));
    }
    return score;
  };

  const maxResidentPairScoreExcludingWithMetric = (
    excludeId: string,
    metric: (a: string | null, b: string | null) => number
  ): number => {
    let m = 0;
    for (const r of residentsList) {
      if (r.id === excludeId) continue;
      const s = residentPairScoreWithMetric(r, metric);
      if (s > m) m = s;
    }
    return m;
  };

  const pairScoreMaxAfterSwapWithMetric = (
    resident: Resident,
    i: number,
    j: number,
    metric: (a: string | null, b: string | null) => number
  ): number => {
    const self = residentPairScoreIfSwappedWithMetric(resident, i, j, metric);
    const others = maxResidentPairScoreExcludingWithMetric(resident.id, metric);
    return Math.max(self, others);
  };

  const totalPairScoreWithMetric = (metric: (a: string | null, b: string | null) => number): number =>
    residentsList.reduce((sum, r) => sum + residentPairScoreWithMetric(r, metric), 0);

  const MAX_NON_IMPROVING_MOVES = 300;

  /**
   * Phase D: three-stage soft minimizer (same-resident month swaps).
   * D1: Remove back-to-back *different* strenuous consult rotations (e.g. Orange → VA Consult).
   * D2: Remove back-to-back *same* strenuous rotation (e.g. Orange → Orange), without worsening D1.
   * D3: Reduce transplant B2B and explore PGY-start fixes, without worsening D1 or D2.
   */
  const runPhaseDStage = (opts: {
    targetMetric: (a: string | null, b: string | null) => number;
    deltaFn: (resident: Resident, i: number, j: number) => number;
    tieFairMetric: (a: string | null, b: string | null) => number;
    baseIndicesForResident: (resident: Resident) => Set<number>;
    maxIters: number;
  }) => {
    rebuildCapacityFromAssignments();
    let nonImprovingMovesUsed = 0;
    let pairScore = totalPairScoreWithMetric(opts.targetMetric);

    for (
      let iter = 0;
      iter < opts.maxIters &&
      pairScore > 0 &&
      (deadlineTs === undefined || Date.now() < deadlineTs);
      iter++
    ) {
      let bestDelta = Number.POSITIVE_INFINITY;
      let bestFairTiebreak = Number.POSITIVE_INFINITY;
      let bestSwap: { resident: Resident; i: number; j: number } | null = null;

      for (const resident of residentsList) {
        const baseIndices = opts.baseIndicesForResident(resident);

        for (const i of baseIndices) {
          const rotI = getRotAt(resident.id, i);
          if (!rotI) continue;

          for (let j = 0; j < monthsList.length; j++) {
            if (j === i) continue;
            const rotJ = getRotAt(resident.id, j);
            if (!rotJ || rotJ === rotI) continue;

            if ((capacity.get(capKey(monthsList[j].id, rotI)) ?? 0) < 1) continue;
            if ((capacity.get(capKey(monthsList[i].id, rotJ)) ?? 0) < 1) continue;

            const delta = opts.deltaFn(resident, i, j);
            if (!Number.isFinite(delta)) continue;
            const fairTb = pairScoreMaxAfterSwapWithMetric(resident, i, j, opts.tieFairMetric);
            if (delta < bestDelta) {
              bestDelta = delta;
              bestFairTiebreak = fairTb;
              bestSwap = { resident, i, j };
            } else if (delta === bestDelta && bestSwap) {
              if (fairTb < bestFairTiebreak) {
                bestFairTiebreak = fairTb;
                bestSwap = { resident, i, j };
              } else if (fairTb === bestFairTiebreak && rng() < 0.2) {
                bestSwap = { resident, i, j };
              }
            }
          }
        }
      }

      if (!bestSwap) break;

      const didApply = applySwap(bestSwap.resident, bestSwap.i, bestSwap.j);
      if (!didApply) break;

      if (bestDelta > 0) {
        nonImprovingMovesUsed += 1;
        if (nonImprovingMovesUsed > MAX_NON_IMPROVING_MOVES) break;
      } else {
        nonImprovingMovesUsed = 0;
      }

      pairScore += bestDelta;
    }
  };

  const buildBaseIndices = (
    resident: Resident,
    edgePredicate: (prev: string | null, curr: string | null) => boolean
  ): Set<number> => {
    const baseIndices = new Set<number>();
    if (requirePgyStartAtPrimarySite && pgyStartViolationCount(resident) > 0) baseIndices.add(0);
    for (let mi = 1; mi < monthsList.length; mi++) {
      const prev = getRotAt(resident.id, mi - 1);
      const curr = getRotAt(resident.id, mi);
      if (edgePredicate(prev, curr)) {
        baseIndices.add(mi - 1);
        baseIndices.add(mi);
      }
    }
    return baseIndices;
  };

  const STAGE_D_MAX = 4000;
  const STAGE_D3_MAX = 1200;
  const STAGE_D4_MAX = 4000;

  const countGlobalSameRotationB2BEdges = (): number => {
    let n = 0;
    for (const r of residentsList) {
      for (let mi = 1; mi < monthsList.length; mi++) {
        const a = getRotAt(r.id, mi - 1);
        const b = getRotAt(r.id, mi);
        if (a && b && a === b) n++;
      }
    }
    return n;
  };

  const residentAnyConsecutiveSameRotation = (resId: string): boolean => {
    for (let mi = 1; mi < monthsList.length; mi++) {
      const p = getRotAt(resId, mi - 1);
      const c = getRotAt(resId, mi);
      if (p && c && p === c) return true;
    }
    return false;
  };

  const residentAnyConsultB2BEdge = (resId: string): boolean => {
    if (!avoidBackToBackConsult) return false;
    for (let mi = 1; mi < monthsList.length; mi++) {
      const p = getRotAt(resId, mi - 1);
      const c = getRotAt(resId, mi);
      if (p && c && consultRotationIdsForBackToBack.has(p) && consultRotationIdsForBackToBack.has(c)) return true;
    }
    return false;
  };

  const residentAnyTransplantB2BEdge = (resId: string): boolean => {
    if (!avoidBackToBackTransplant) return false;
    for (let mi = 1; mi < monthsList.length; mi++) {
      const p = getRotAt(resId, mi - 1);
      const c = getRotAt(resId, mi);
      if (p && c && transplantRotationIds.has(p) && transplantRotationIds.has(c)) return true;
    }
    return false;
  };

  const runPhaseICrossSameRotationSwaps = (maxIters: number) => {
    rebuildCapacityFromAssignments();
    const genCrossRotCount = new Map<string, number>();
    for (const row of assignmentRows) {
      if (!row.rotation_id) continue;
      const k = reqKey(row.resident_id, row.rotation_id);
      genCrossRotCount.set(k, (genCrossRotCount.get(k) ?? 0) + 1);
    }
    for (let gci = 0; gci < maxIters; gci++) {
      if (deadlineTs !== undefined && Date.now() >= deadlineTs) break;
      let genMadeSwap = false;
      for (const resA of residentsList) {
        if (genMadeSwap) break;
        for (let mi = 1; mi < monthsList.length; mi++) {
          if (genMadeSwap) break;
          const rotPrev = getRotAt(resA.id, mi - 1);
          const rotCurr = getRotAt(resA.id, mi);
          if (!rotPrev || !rotCurr || rotPrev !== rotCurr) continue;

          for (const swapMi of [mi, mi - 1]) {
            if (genMadeSwap) break;
            const monthId = monthsList[swapMi].id;
            const idxA = assignmentIndexMap.get(residentMonthKey(resA.id, monthId));
            if (idxA === undefined) continue;
            const rotA = assignmentRows[idxA].rotation_id;
            if (!rotA) continue;

            const otherMi = swapMi === mi ? mi - 1 : mi;
            const otherRot = getRotAt(resA.id, otherMi);

            for (const resB of shuffle(residentsList, rng)) {
              if (resB.id === resA.id) continue;
              const idxB = assignmentIndexMap.get(residentMonthKey(resB.id, monthId));
              if (idxB === undefined) continue;
              const rotBId = assignmentRows[idxB].rotation_id;
              if (!rotBId || rotBId === rotA) continue;

              if (otherRot === rotBId) continue;

              const rotAObj = rotationById.get(rotA);
              const rotBObj = rotationById.get(rotBId);
              if (!rotAObj || !rotBObj) continue;
              if (resB.pgy < rotAObj.eligible_pgy_min || resB.pgy > rotAObj.eligible_pgy_max) continue;
              if (resA.pgy < rotBObj.eligible_pgy_min || resA.pgy > rotBObj.eligible_pgy_max) continue;
              if (vacationHardBlock(resA.id, monthId, rotBId)) continue;
              if (vacationHardBlock(resB.id, monthId, rotA)) continue;

              if (avoidBackToBackConsult) {
                if (
                  consultRotationIdsForBackToBack.has(rotBId) &&
                  otherRot &&
                  consultRotationIdsForBackToBack.has(otherRot)
                ) continue;
                if (swapMi > 0 && swapMi - 1 !== otherMi) {
                  const adj = getRotAt(resA.id, swapMi - 1);
                  if (consultRotationIdsForBackToBack.has(rotBId) && adj && consultRotationIdsForBackToBack.has(adj)) continue;
                }
                if (swapMi < monthsList.length - 1 && swapMi + 1 !== otherMi) {
                  const adj = getRotAt(resA.id, swapMi + 1);
                  if (consultRotationIdsForBackToBack.has(rotBId) && adj && consultRotationIdsForBackToBack.has(adj)) continue;
                }
                if (consultRotationIdsForBackToBack.has(rotA)) {
                  if (swapMi > 0) {
                    const bPrev = getRotAt(resB.id, swapMi - 1);
                    if (bPrev && consultRotationIdsForBackToBack.has(bPrev)) continue;
                  }
                  if (swapMi < monthsList.length - 1) {
                    const bNext = getRotAt(resB.id, swapMi + 1);
                    if (bNext && consultRotationIdsForBackToBack.has(bNext)) continue;
                  }
                }
              }

              if (avoidBackToBackTransplant) {
                if (transplantRotationIds.has(rotBId)) {
                  if (swapMi > 0 && swapMi - 1 !== otherMi) {
                    const adj = getRotAt(resA.id, swapMi - 1);
                    if (adj && transplantRotationIds.has(adj)) continue;
                  }
                  if (swapMi < monthsList.length - 1 && swapMi + 1 !== otherMi) {
                    const adj = getRotAt(resA.id, swapMi + 1);
                    if (adj && transplantRotationIds.has(adj)) continue;
                  }
                }
                if (transplantRotationIds.has(rotA)) {
                  if (swapMi > 0) {
                    const bPrev = getRotAt(resB.id, swapMi - 1);
                    if (bPrev && transplantRotationIds.has(bPrev)) continue;
                  }
                  if (swapMi < monthsList.length - 1) {
                    const bNext = getRotAt(resB.id, swapMi + 1);
                    if (bNext && transplantRotationIds.has(bNext)) continue;
                  }
                }
              }

              const aCountRotA = genCrossRotCount.get(reqKey(resA.id, rotA)) ?? 0;
              const bCountRotB = genCrossRotCount.get(reqKey(resB.id, rotBId)) ?? 0;
              const aReqRotA = initialRequired.get(reqKey(resA.id, rotA)) ?? 0;
              const bReqRotB = initialRequired.get(reqKey(resB.id, rotBId)) ?? 0;
              if (aCountRotA - 1 < aReqRotA) continue;
              if (bCountRotB - 1 < bReqRotB) continue;

              assignmentRows[idxA].rotation_id = rotBId;
              assignmentRows[idxB].rotation_id = rotA;
              genCrossRotCount.set(reqKey(resA.id, rotA), aCountRotA - 1);
              genCrossRotCount.set(reqKey(resA.id, rotBId), (genCrossRotCount.get(reqKey(resA.id, rotBId)) ?? 0) + 1);
              genCrossRotCount.set(reqKey(resB.id, rotBId), bCountRotB - 1);
              genCrossRotCount.set(reqKey(resB.id, rotA), (genCrossRotCount.get(reqKey(resB.id, rotA)) ?? 0) + 1);
              genMadeSwap = true;
              break;
            }
          }
        }
      }
      if (!genMadeSwap) break;
    }
  };

  /** Rectangle 2×2 swap for any rotation R with consecutive R→R (not only strenuous consult). */
  const runPhaseJGenericSameRotRectangles = (maxIters: number) => {
    rebuildCapacityFromAssignments();
    const jCount = new Map<string, number>();
    for (const row of assignmentRows) {
      if (!row.rotation_id) continue;
      const k = reqKey(row.resident_id, row.rotation_id);
      jCount.set(k, (jCount.get(k) ?? 0) + 1);
    }
    for (let it = 0; it < maxIters; it++) {
      if (deadlineTs !== undefined && Date.now() >= deadlineTs) break;
      let made = false;
      for (const resA of residentsList) {
        if (made) break;
        for (let mi = 1; mi < monthsList.length; mi++) {
          if (made) break;
          const rotPrev = getRotAt(resA.id, mi - 1);
          const rotCurr = getRotAt(resA.id, mi);
          if (!rotPrev || !rotCurr || rotPrev !== rotCurr) continue;
          const rotR = rotPrev;

          for (const targetMi of [mi, mi - 1]) {
            if (made) break;
            const stayMi = targetMi === mi ? mi - 1 : mi;
            const targetMonthId = monthsList[targetMi].id;

            for (let x = 0; x < monthsList.length; x++) {
              if (made) break;
              if (x === targetMi || x === stayMi) continue;
              if (Math.abs(x - stayMi) <= 1) continue;

              const rotAatX = getRotAt(resA.id, x);
              if (!rotAatX || rotAatX === rotR) continue;

              const monthXId = monthsList[x].id;

              for (const resB of residentsList) {
                if (resB.id === resA.id) continue;
                if (getRotAt(resB.id, x) !== rotR) continue;
                const rotBatTarget = getRotAt(resB.id, targetMi);
                if (!rotBatTarget || rotBatTarget === rotR) continue;

                const rotBTObj = rotationById.get(rotBatTarget);
                const rotSObj = rotationById.get(rotR);
                const rotAXObj = rotationById.get(rotAatX);
                if (rotBTObj && (resA.pgy < rotBTObj.eligible_pgy_min || resA.pgy > rotBTObj.eligible_pgy_max)) continue;
                if (rotSObj && (resB.pgy < rotSObj.eligible_pgy_min || resB.pgy > rotSObj.eligible_pgy_max)) continue;
                if (rotAXObj && (resB.pgy < rotAXObj.eligible_pgy_min || resB.pgy > rotAXObj.eligible_pgy_max)) continue;

                if (vacationHardBlock(resA.id, targetMonthId, rotBatTarget)) continue;
                if (vacationHardBlock(resA.id, monthXId, rotR)) continue;
                if (vacationHardBlock(resB.id, targetMonthId, rotR)) continue;
                if (vacationHardBlock(resB.id, monthXId, rotAatX)) continue;

                if (rotAatX !== rotBatTarget) {
                  const aCountAX = jCount.get(reqKey(resA.id, rotAatX)) ?? 0;
                  const aReqAX = initialRequired.get(reqKey(resA.id, rotAatX)) ?? 0;
                  if (aCountAX - 1 < aReqAX) continue;
                  const bCountBT = jCount.get(reqKey(resB.id, rotBatTarget)) ?? 0;
                  const bReqBT = initialRequired.get(reqKey(resB.id, rotBatTarget)) ?? 0;
                  if (bCountBT - 1 < bReqBT) continue;
                }

                const idxAT = assignmentIndexMap.get(residentMonthKey(resA.id, targetMonthId));
                const idxAX = assignmentIndexMap.get(residentMonthKey(resA.id, monthXId));
                const idxBT = assignmentIndexMap.get(residentMonthKey(resB.id, targetMonthId));
                const idxBX = assignmentIndexMap.get(residentMonthKey(resB.id, monthXId));
                if (idxAT === undefined || idxAX === undefined || idxBT === undefined || idxBX === undefined) continue;

                const oldAT = assignmentRows[idxAT].rotation_id;
                const oldAX = assignmentRows[idxAX].rotation_id;
                const oldBT = assignmentRows[idxBT].rotation_id;
                const oldBX = assignmentRows[idxBX].rotation_id;

                assignmentRows[idxAT].rotation_id = rotBatTarget;
                assignmentRows[idxAX].rotation_id = rotR;
                assignmentRows[idxBT].rotation_id = rotR;
                assignmentRows[idxBX].rotation_id = rotAatX;

                const bad =
                  residentAnyConsecutiveSameRotation(resA.id) ||
                  residentAnyConsecutiveSameRotation(resB.id) ||
                  (avoidBackToBackConsult &&
                    (residentAnyConsultB2BEdge(resA.id) || residentAnyConsultB2BEdge(resB.id))) ||
                  (avoidBackToBackTransplant &&
                    (residentAnyTransplantB2BEdge(resA.id) || residentAnyTransplantB2BEdge(resB.id)));

                if (bad) {
                  assignmentRows[idxAT].rotation_id = oldAT;
                  assignmentRows[idxAX].rotation_id = oldAX;
                  assignmentRows[idxBT].rotation_id = oldBT;
                  assignmentRows[idxBX].rotation_id = oldBX;
                  continue;
                }

                if (rotAatX !== rotBatTarget) {
                  const kA1 = reqKey(resA.id, rotAatX);
                  jCount.set(kA1, (jCount.get(kA1) ?? 0) - 1);
                  const kA2 = reqKey(resA.id, rotBatTarget);
                  jCount.set(kA2, (jCount.get(kA2) ?? 0) + 1);
                  const kB1 = reqKey(resB.id, rotBatTarget);
                  jCount.set(kB1, (jCount.get(kB1) ?? 0) - 1);
                  const kB2 = reqKey(resB.id, rotAatX);
                  jCount.set(kB2, (jCount.get(kB2) ?? 0) + 1);
                }

                made = true;
                break;
              }
            }
          }
        }
      }
      if (!made) break;
    }
  };

  if (avoidBackToBackConsult) {
    runPhaseDStage({
      targetMetric: differentStrenuousConsultBackToBack,
      deltaFn: (res, i, j) => deltaMetricForSwap(res, i, j, differentStrenuousConsultBackToBack),
      tieFairMetric: differentStrenuousConsultBackToBack,
      baseIndicesForResident: (resident) =>
        buildBaseIndices(resident, (prev, curr) => differentStrenuousConsultBackToBack(prev, curr) > 0),
      maxIters: STAGE_D_MAX,
    });

    runPhaseDStage({
      targetMetric: sameStrenuousRotationBackToBack,
      deltaFn: (res, i, j) => {
        if (deltaMetricForSwap(res, i, j, differentStrenuousConsultBackToBack) > 0) {
          return Number.POSITIVE_INFINITY;
        }
        return deltaMetricForSwap(res, i, j, sameStrenuousRotationBackToBack);
      },
      tieFairMetric: sameStrenuousRotationBackToBack,
      baseIndicesForResident: (resident) =>
        buildBaseIndices(resident, (prev, curr) => sameStrenuousRotationBackToBack(prev, curr) > 0),
      maxIters: STAGE_D_MAX,
    });
  }

  runPhaseDStage({
    targetMetric: tertiaryPairMetric,
    deltaFn: deltaTertiaryPairScoreForSwap,
    tieFairMetric: tertiaryPairMetric,
    baseIndicesForResident: (resident) =>
      buildBaseIndices(resident, (prev, curr) => tertiaryPairMetric(prev, curr) > 0),
    maxIters: avoidBackToBackConsult ? STAGE_D3_MAX : 900,
  });

  // Phase D4: Any rotation, consecutive same block (VA Dialysis, Elective, etc.) — after transplant pass.
  runPhaseDStage({
    targetMetric: sameAnyRotationBackToBack,
    deltaFn: deltaAnySameRotationScoreForSwap,
    tieFairMetric: sameAnyRotationBackToBack,
    baseIndicesForResident: (resident) =>
      buildBaseIndices(resident, (prev, curr) => sameAnyRotationBackToBack(prev, curr) > 0),
    maxIters: STAGE_D4_MAX,
  });

  // Phase G: Cross-resident same-month swaps to eliminate remaining B2B strenuous consult violations.
  // Within-resident swaps (Phase D) can get stuck when capacity prevents rearrangement;
  // cross-resident swaps have a much larger solution space.
  if (avoidBackToBackConsult) {
    rebuildCapacityFromAssignments();

    const resRotCount = new Map<string, number>();
    for (const row of assignmentRows) {
      if (!row.rotation_id) continue;
      const k = reqKey(row.resident_id, row.rotation_id);
      resRotCount.set(k, (resRotCount.get(k) ?? 0) + 1);
    }

    const MAX_CROSS_ITERS = 1400;
    for (let iter = 0; iter < MAX_CROSS_ITERS; iter++) {
      if (deadlineTs !== undefined && Date.now() >= deadlineTs) break;
      let madeSwap = false;

      for (const resA of residentsList) {
        if (madeSwap) break;
        for (let mi = 1; mi < monthsList.length; mi++) {
          if (madeSwap) break;
          const rotPrev = getRotAt(resA.id, mi - 1);
          const rotCurr = getRotAt(resA.id, mi);
          if (!rotPrev || !rotCurr) continue;
          if (!consultRotationIdsForBackToBack.has(rotPrev) || !consultRotationIdsForBackToBack.has(rotCurr)) continue;

          for (const swapMi of [mi, mi - 1]) {
            if (madeSwap) break;
            const monthId = monthsList[swapMi].id;
            const idxA = assignmentIndexMap.get(residentMonthKey(resA.id, monthId));
            if (idxA === undefined) continue;
            const rotA = assignmentRows[idxA].rotation_id;
            if (!rotA) continue;

            for (const resB of shuffle(residentsList, rng)) {
              if (resB.id === resA.id) continue;
              const idxB = assignmentIndexMap.get(residentMonthKey(resB.id, monthId));
              if (idxB === undefined) continue;
              const rotBId = assignmentRows[idxB].rotation_id;
              if (!rotBId || rotBId === rotA) continue;

              const rotAObj = rotationById.get(rotA);
              const rotBObj = rotationById.get(rotBId);
              if (!rotAObj || !rotBObj) continue;
              if (resB.pgy < rotAObj.eligible_pgy_min || resB.pgy > rotAObj.eligible_pgy_max) continue;
              if (resA.pgy < rotBObj.eligible_pgy_min || resA.pgy > rotBObj.eligible_pgy_max) continue;
              if (vacationHardBlock(resA.id, monthId, rotBId)) continue;
              if (vacationHardBlock(resB.id, monthId, rotA)) continue;

              // Verify A's B2B is actually fixed by getting rotB
              const otherMi = swapMi === mi ? mi - 1 : mi;
              const otherRot = getRotAt(resA.id, otherMi);
              if (
                consultRotationIdsForBackToBack.has(rotBId) &&
                otherRot && consultRotationIdsForBackToBack.has(otherRot)
              ) continue;
              // Check A's other adjacent side doesn't form new B2B
              if (swapMi > 0 && swapMi - 1 !== otherMi) {
                const adj = getRotAt(resA.id, swapMi - 1);
                if (consultRotationIdsForBackToBack.has(rotBId) && adj && consultRotationIdsForBackToBack.has(adj)) continue;
              }
              if (swapMi < monthsList.length - 1 && swapMi + 1 !== otherMi) {
                const adj = getRotAt(resA.id, swapMi + 1);
                if (consultRotationIdsForBackToBack.has(rotBId) && adj && consultRotationIdsForBackToBack.has(adj)) continue;
              }

              // Verify B doesn't get new B2B from receiving rotA (strenuous)
              if (consultRotationIdsForBackToBack.has(rotA)) {
                if (swapMi > 0) {
                  const bPrev = getRotAt(resB.id, swapMi - 1);
                  if (bPrev && consultRotationIdsForBackToBack.has(bPrev)) continue;
                }
                if (swapMi < monthsList.length - 1) {
                  const bNext = getRotAt(resB.id, swapMi + 1);
                  if (bNext && consultRotationIdsForBackToBack.has(bNext)) continue;
                }
              }

              // Verify neither resident loses a required rotation
              const aCountRotA = resRotCount.get(reqKey(resA.id, rotA)) ?? 0;
              const bCountRotB = resRotCount.get(reqKey(resB.id, rotBId)) ?? 0;
              const aReqRotA = initialRequired.get(reqKey(resA.id, rotA)) ?? 0;
              const bReqRotB = initialRequired.get(reqKey(resB.id, rotBId)) ?? 0;
              if (aCountRotA - 1 < aReqRotA) continue;
              if (bCountRotB - 1 < bReqRotB) continue;

              // All checks pass — apply the cross-resident swap
              assignmentRows[idxA].rotation_id = rotBId;
              assignmentRows[idxB].rotation_id = rotA;
              resRotCount.set(reqKey(resA.id, rotA), aCountRotA - 1);
              resRotCount.set(reqKey(resA.id, rotBId), (resRotCount.get(reqKey(resA.id, rotBId)) ?? 0) + 1);
              resRotCount.set(reqKey(resB.id, rotBId), bCountRotB - 1);
              resRotCount.set(reqKey(resB.id, rotA), (resRotCount.get(reqKey(resB.id, rotA)) ?? 0) + 1);
              madeSwap = true;
              break;
            }
          }
        }
      }

      if (!madeSwap) break;
    }

    // Phase H: Rectangle swaps — relocate strenuous rotations to non-adjacent months.
    // When residents have exactly the required count of a strenuous rotation (no excess),
    // Phase G can't help because nobody can give one up. Rectangle swaps solve this:
    // Two residents swap their assignments at two different months simultaneously.
    // resA[T]=S, resA[X]=R1, resB[T]=R2, resB[X]=S → after: resA[T]=R2, resA[X]=S, resB[T]=S, resB[X]=R1
    // The strenuous rotation S has net-zero count change for both residents (lost 1, gained 1).
    // If R1≠R2, we verify the changed counts don't violate requirements.
    rebuildCapacityFromAssignments();

    const rectRotCount = new Map<string, number>();
    for (const row of assignmentRows) {
      if (!row.rotation_id) continue;
      const k = reqKey(row.resident_id, row.rotation_id);
      rectRotCount.set(k, (rectRotCount.get(k) ?? 0) + 1);
    }

    const MAX_RECT_ITERS = 600;
    for (let rectIter = 0; rectIter < MAX_RECT_ITERS; rectIter++) {
      if (deadlineTs !== undefined && Date.now() >= deadlineTs) break;
      let madeRectSwap = false;

      for (const resA of residentsList) {
        if (madeRectSwap) break;
        for (let mi = 1; mi < monthsList.length; mi++) {
          if (madeRectSwap) break;
          const rotPrev = getRotAt(resA.id, mi - 1);
          const rotCurr = getRotAt(resA.id, mi);
          if (!rotPrev || !rotCurr) continue;
          if (!consultRotationIdsForBackToBack.has(rotPrev) || !consultRotationIdsForBackToBack.has(rotCurr)) continue;

          for (const targetMi of [mi, mi - 1]) {
            if (madeRectSwap) break;
            const stayMi = targetMi === mi ? mi - 1 : mi;
            const rotStren = getRotAt(resA.id, targetMi);
            if (!rotStren) continue;
            const targetMonthId = monthsList[targetMi].id;

            for (let x = 0; x < monthsList.length; x++) {
              if (madeRectSwap) break;
              if (x === targetMi || x === stayMi) continue;
              if (Math.abs(x - stayMi) <= 1) continue;

              const rotAatX = getRotAt(resA.id, x);
              if (!rotAatX) continue;
              // resA[X] can be strenuous — we're relocating rotStren there, so rotAatX moves out
              // But if rotAatX is strenuous, we must ensure resA won't have B2B at X after swap

              const monthXId = monthsList[x].id;

              for (const resB of residentsList) {
                if (resB.id === resA.id) continue;
                // resB must have the same strenuous rotation at month X (so counts of S balance)
                if (getRotAt(resB.id, x) !== rotStren) continue;
                const rotBatTarget = getRotAt(resB.id, targetMi);
                if (!rotBatTarget) continue;
                // resA receives rotBatTarget at targetMi — it must be non-strenuous to fix B2B
                if (consultRotationIdsForBackToBack.has(rotBatTarget)) continue;

                // After swap:
                //   resA[T] = rotBatTarget, resA[X] = rotStren
                //   resB[T] = rotStren,     resB[X] = rotAatX

                // PGY eligibility
                const rotBTObj = rotationById.get(rotBatTarget);
                const rotSObj = rotationById.get(rotStren);
                const rotAXObj = rotationById.get(rotAatX);
                if (rotBTObj && (resA.pgy < rotBTObj.eligible_pgy_min || resA.pgy > rotBTObj.eligible_pgy_max)) continue;
                if (rotSObj && (resB.pgy < rotSObj.eligible_pgy_min || resB.pgy > rotSObj.eligible_pgy_max)) continue;
                if (rotAXObj && (resB.pgy < rotAXObj.eligible_pgy_min || resB.pgy > rotAXObj.eligible_pgy_max)) continue;

                // Vacation blocks
                if (vacationHardBlock(resA.id, targetMonthId, rotBatTarget)) continue;
                if (vacationHardBlock(resA.id, monthXId, rotStren)) continue;
                if (vacationHardBlock(resB.id, targetMonthId, rotStren)) continue;
                if (vacationHardBlock(resB.id, monthXId, rotAatX)) continue;

                // Requirement count check for non-strenuous rotations that shift
                // rotStren count is net-zero for both (lost 1, gained 1)
                if (rotAatX !== rotBatTarget) {
                  // resA loses rotAatX, gains rotBatTarget
                  const aCountAX = rectRotCount.get(reqKey(resA.id, rotAatX)) ?? 0;
                  const aReqAX = initialRequired.get(reqKey(resA.id, rotAatX)) ?? 0;
                  if (aCountAX - 1 < aReqAX) continue;
                  // resB loses rotBatTarget, gains rotAatX
                  const bCountBT = rectRotCount.get(reqKey(resB.id, rotBatTarget)) ?? 0;
                  const bReqBT = initialRequired.get(reqKey(resB.id, rotBatTarget)) ?? 0;
                  if (bCountBT - 1 < bReqBT) continue;
                }

                // Check resA doesn't get new B2B at month X (receiving rotStren)
                let bad = false;
                if (x > 0 && x - 1 !== targetMi) {
                  const adj = getRotAt(resA.id, x - 1);
                  if (adj && consultRotationIdsForBackToBack.has(adj)) bad = true;
                }
                if (x < monthsList.length - 1 && x + 1 !== targetMi) {
                  const adj = getRotAt(resA.id, x + 1);
                  if (adj && consultRotationIdsForBackToBack.has(adj)) bad = true;
                }
                if (bad) continue;

                // Check resB doesn't get new B2B at targetMi (receiving rotStren)
                if (targetMi > 0) {
                  const adj = targetMi - 1 === x ? rotAatX : getRotAt(resB.id, targetMi - 1);
                  if (adj && consultRotationIdsForBackToBack.has(adj)) bad = true;
                }
                if (targetMi < monthsList.length - 1) {
                  const adj = targetMi + 1 === x ? rotAatX : getRotAt(resB.id, targetMi + 1);
                  if (adj && consultRotationIdsForBackToBack.has(adj)) bad = true;
                }
                if (bad) continue;

                // Check resB doesn't get new B2B at month X (receiving rotAatX)
                if (consultRotationIdsForBackToBack.has(rotAatX)) {
                  if (x > 0 && x - 1 !== targetMi) {
                    const adj = getRotAt(resB.id, x - 1);
                    if (adj && consultRotationIdsForBackToBack.has(adj)) bad = true;
                  }
                  if (x < monthsList.length - 1 && x + 1 !== targetMi) {
                    const adj = getRotAt(resB.id, x + 1);
                    if (adj && consultRotationIdsForBackToBack.has(adj)) bad = true;
                  }
                  if (bad) continue;
                }

                const idxAT = assignmentIndexMap.get(residentMonthKey(resA.id, targetMonthId));
                const idxAX = assignmentIndexMap.get(residentMonthKey(resA.id, monthXId));
                const idxBT = assignmentIndexMap.get(residentMonthKey(resB.id, targetMonthId));
                const idxBX = assignmentIndexMap.get(residentMonthKey(resB.id, monthXId));
                if (idxAT === undefined || idxAX === undefined || idxBT === undefined || idxBX === undefined) continue;

                assignmentRows[idxAT].rotation_id = rotBatTarget;
                assignmentRows[idxAX].rotation_id = rotStren;
                assignmentRows[idxBT].rotation_id = rotStren;
                assignmentRows[idxBX].rotation_id = rotAatX;

                // Update rotation counts for the shifted non-strenuous rotations
                if (rotAatX !== rotBatTarget) {
                  const kA1 = reqKey(resA.id, rotAatX);
                  rectRotCount.set(kA1, (rectRotCount.get(kA1) ?? 0) - 1);
                  const kA2 = reqKey(resA.id, rotBatTarget);
                  rectRotCount.set(kA2, (rectRotCount.get(kA2) ?? 0) + 1);
                  const kB1 = reqKey(resB.id, rotBatTarget);
                  rectRotCount.set(kB1, (rectRotCount.get(kB1) ?? 0) - 1);
                  const kB2 = reqKey(resB.id, rotAatX);
                  rectRotCount.set(kB2, (rectRotCount.get(kB2) ?? 0) + 1);
                }

                madeRectSwap = true;
                break;
              }
            }
          }
        }
      }

      if (!madeRectSwap) break;
    }

    // Re-run within-resident Phase D after rectangle + cross-resident swaps
    rebuildCapacityFromAssignments();
    if (avoidBackToBackConsult) {
      runPhaseDStage({
        targetMetric: differentStrenuousConsultBackToBack,
        deltaFn: (res, i, j) => deltaMetricForSwap(res, i, j, differentStrenuousConsultBackToBack),
        tieFairMetric: differentStrenuousConsultBackToBack,
        baseIndicesForResident: (resident) =>
          buildBaseIndices(resident, (prev, curr) => differentStrenuousConsultBackToBack(prev, curr) > 0),
        maxIters: STAGE_D_MAX,
      });
      runPhaseDStage({
        targetMetric: sameStrenuousRotationBackToBack,
        deltaFn: (res, i, j) => {
          if (deltaMetricForSwap(res, i, j, differentStrenuousConsultBackToBack) > 0) {
            return Number.POSITIVE_INFINITY;
          }
          return deltaMetricForSwap(res, i, j, sameStrenuousRotationBackToBack);
        },
        tieFairMetric: sameStrenuousRotationBackToBack,
        baseIndicesForResident: (resident) =>
          buildBaseIndices(resident, (prev, curr) => sameStrenuousRotationBackToBack(prev, curr) > 0),
        maxIters: STAGE_D_MAX,
      });
    }

    runPhaseDStage({
      targetMetric: sameAnyRotationBackToBack,
      deltaFn: deltaAnySameRotationScoreForSwap,
      tieFairMetric: sameAnyRotationBackToBack,
      baseIndicesForResident: (resident) =>
        buildBaseIndices(resident, (prev, curr) => sameAnyRotationBackToBack(prev, curr) > 0),
      maxIters: STAGE_D4_MAX,
    });
  }

  // Phase I: Cross-resident same-month swaps for any same-rotation B2B (when within-resident D4 is stuck).
  runPhaseICrossSameRotationSwaps(700);

  // Phase T: Cross-resident same-month swaps for back-to-back transplant (D3 is often stuck on capacity).
  if (avoidBackToBackTransplant) {
    rebuildCapacityFromAssignments();
    const txRotCount = new Map<string, number>();
    for (const row of assignmentRows) {
      if (!row.rotation_id) continue;
      const k = reqKey(row.resident_id, row.rotation_id);
      txRotCount.set(k, (txRotCount.get(k) ?? 0) + 1);
    }
    const MAX_TX_CROSS_ITERS = 900;
    for (let txi = 0; txi < MAX_TX_CROSS_ITERS; txi++) {
      if (deadlineTs !== undefined && Date.now() >= deadlineTs) break;
      let txMadeSwap = false;
      for (const resA of residentsList) {
        if (txMadeSwap) break;
        for (let mi = 1; mi < monthsList.length; mi++) {
          if (txMadeSwap) break;
          const rotPrev = getRotAt(resA.id, mi - 1);
          const rotCurr = getRotAt(resA.id, mi);
          if (!rotPrev || !rotCurr) continue;
          if (!transplantRotationIds.has(rotPrev) || !transplantRotationIds.has(rotCurr)) continue;

          for (const swapMi of [mi, mi - 1]) {
            if (txMadeSwap) break;
            const monthId = monthsList[swapMi].id;
            const idxA = assignmentIndexMap.get(residentMonthKey(resA.id, monthId));
            if (idxA === undefined) continue;
            const rotA = assignmentRows[idxA].rotation_id;
            if (!rotA) continue;

            const otherMi = swapMi === mi ? mi - 1 : mi;
            const otherRot = getRotAt(resA.id, otherMi);

            for (const resB of shuffle(residentsList, rng)) {
              if (resB.id === resA.id) continue;
              const idxB = assignmentIndexMap.get(residentMonthKey(resB.id, monthId));
              if (idxB === undefined) continue;
              const rotBId = assignmentRows[idxB].rotation_id;
              if (!rotBId || rotBId === rotA) continue;
              if (otherRot === rotBId) continue;

              if (
                transplantRotationIds.has(rotBId) &&
                otherRot &&
                transplantRotationIds.has(otherRot)
              ) continue;

              const rotAObj = rotationById.get(rotA);
              const rotBObj = rotationById.get(rotBId);
              if (!rotAObj || !rotBObj) continue;
              if (resB.pgy < rotAObj.eligible_pgy_min || resB.pgy > rotAObj.eligible_pgy_max) continue;
              if (resA.pgy < rotBObj.eligible_pgy_min || resA.pgy > rotBObj.eligible_pgy_max) continue;
              if (vacationHardBlock(resA.id, monthId, rotBId)) continue;
              if (vacationHardBlock(resB.id, monthId, rotA)) continue;

              if (avoidBackToBackConsult) {
                if (
                  consultRotationIdsForBackToBack.has(rotBId) &&
                  otherRot &&
                  consultRotationIdsForBackToBack.has(otherRot)
                ) continue;
                if (swapMi > 0 && swapMi - 1 !== otherMi) {
                  const adj = getRotAt(resA.id, swapMi - 1);
                  if (consultRotationIdsForBackToBack.has(rotBId) && adj && consultRotationIdsForBackToBack.has(adj)) continue;
                }
                if (swapMi < monthsList.length - 1 && swapMi + 1 !== otherMi) {
                  const adj = getRotAt(resA.id, swapMi + 1);
                  if (consultRotationIdsForBackToBack.has(rotBId) && adj && consultRotationIdsForBackToBack.has(adj)) continue;
                }
                if (consultRotationIdsForBackToBack.has(rotA)) {
                  if (swapMi > 0) {
                    const bPrev = getRotAt(resB.id, swapMi - 1);
                    if (bPrev && consultRotationIdsForBackToBack.has(bPrev)) continue;
                  }
                  if (swapMi < monthsList.length - 1) {
                    const bNext = getRotAt(resB.id, swapMi + 1);
                    if (bNext && consultRotationIdsForBackToBack.has(bNext)) continue;
                  }
                }
              }

              if (transplantRotationIds.has(rotBId)) {
                if (swapMi > 0 && swapMi - 1 !== otherMi) {
                  const adj = getRotAt(resA.id, swapMi - 1);
                  if (adj && transplantRotationIds.has(adj)) continue;
                }
                if (swapMi < monthsList.length - 1 && swapMi + 1 !== otherMi) {
                  const adj = getRotAt(resA.id, swapMi + 1);
                  if (adj && transplantRotationIds.has(adj)) continue;
                }
              }
              if (transplantRotationIds.has(rotA)) {
                if (swapMi > 0) {
                  const bPrev = getRotAt(resB.id, swapMi - 1);
                  if (bPrev && transplantRotationIds.has(bPrev)) continue;
                }
                if (swapMi < monthsList.length - 1) {
                  const bNext = getRotAt(resB.id, swapMi + 1);
                  if (bNext && transplantRotationIds.has(bNext)) continue;
                }
              }

              const aCountRotA = txRotCount.get(reqKey(resA.id, rotA)) ?? 0;
              const bCountRotB = txRotCount.get(reqKey(resB.id, rotBId)) ?? 0;
              const aReqRotA = initialRequired.get(reqKey(resA.id, rotA)) ?? 0;
              const bReqRotB = initialRequired.get(reqKey(resB.id, rotBId)) ?? 0;
              if (aCountRotA - 1 < aReqRotA) continue;
              if (bCountRotB - 1 < bReqRotB) continue;

              assignmentRows[idxA].rotation_id = rotBId;
              assignmentRows[idxB].rotation_id = rotA;
              txRotCount.set(reqKey(resA.id, rotA), aCountRotA - 1);
              txRotCount.set(reqKey(resA.id, rotBId), (txRotCount.get(reqKey(resA.id, rotBId)) ?? 0) + 1);
              txRotCount.set(reqKey(resB.id, rotBId), bCountRotB - 1);
              txRotCount.set(reqKey(resB.id, rotA), (txRotCount.get(reqKey(resB.id, rotA)) ?? 0) + 1);
              txMadeSwap = true;
              break;
            }
          }
        }
      }
      if (!txMadeSwap) break;
    }

    rebuildCapacityFromAssignments();
    runPhaseDStage({
      targetMetric: tertiaryPairMetric,
      deltaFn: deltaTertiaryPairScoreForSwap,
      tieFairMetric: tertiaryPairMetric,
      baseIndicesForResident: (resident) =>
        buildBaseIndices(resident, (prev, curr) => tertiaryPairMetric(prev, curr) > 0),
      maxIters: 1000,
    });
  }

  rebuildCapacityFromAssignments();
  runPhaseDStage({
    targetMetric: sameAnyRotationBackToBack,
    deltaFn: deltaAnySameRotationScoreForSwap,
    tieFairMetric: sameAnyRotationBackToBack,
    baseIndicesForResident: (resident) =>
      buildBaseIndices(resident, (prev, curr) => sameAnyRotationBackToBack(prev, curr) > 0),
    maxIters: STAGE_D4_MAX,
  });
  runPhaseICrossSameRotationSwaps(700);
  runPhaseJGenericSameRotRectangles(800);

  const MAX_SAME_B2B_REPAIR_ROUNDS = 16;
  for (let rb = 0; rb < MAX_SAME_B2B_REPAIR_ROUNDS; rb++) {
    if (deadlineTs !== undefined && Date.now() >= deadlineTs) break;
    const beforeEdges = countGlobalSameRotationB2BEdges();
    if (beforeEdges === 0) break;
    rebuildCapacityFromAssignments();
    runPhaseDStage({
      targetMetric: sameAnyRotationBackToBack,
      deltaFn: deltaAnySameRotationScoreForSwap,
      tieFairMetric: sameAnyRotationBackToBack,
      baseIndicesForResident: (resident) =>
        buildBaseIndices(resident, (prev, curr) => sameAnyRotationBackToBack(prev, curr) > 0),
      maxIters: STAGE_D4_MAX,
    });
    runPhaseICrossSameRotationSwaps(700);
    runPhaseJGenericSameRotRectangles(800);
    const afterEdges = countGlobalSameRotationB2BEdges();
    if (afterEdges >= beforeEdges) break;
  }

  /**
   * After soft minimization, counts can be short while hard spacing still allows a fix:
   * move an existing assignment to another empty month for the same resident, then place the deficit rotation.
   * (Repair/Phase F use a `required` map that can be stale after D/I/J; this uses initialRequired vs actual counts.)
   */
  const runResidentRelocationForDeficits = (maxIters: number) => {
    for (let it = 0; it < maxIters; it++) {
      if (deadlineTs !== undefined && Date.now() >= deadlineTs) break;
      rebuildCapacityFromAssignments();
      const assignedByKey = new Map<string, number>();
      for (const row of assignmentRows) {
        if (!row.rotation_id) continue;
        const k = reqKey(row.resident_id, row.rotation_id);
        assignedByKey.set(k, (assignedByKey.get(k) ?? 0) + 1);
      }
      let deficitKey: string | null = null;
      let bestGap = 0;
      for (const [k, init] of initialRequired) {
        if (init <= 0) continue;
        const gap = init - (assignedByKey.get(k) ?? 0);
        if (gap > bestGap) {
          bestGap = gap;
          deficitKey = k;
        }
      }
      if (!deficitKey || bestGap <= 0) break;

      const { residentId: resId, rotationId: needRotId } = splitReqKey(deficitKey);
      const res = residentById.get(resId);
      const needRot = rotationById.get(needRotId);
      if (!res || !needRot) break;
      if (res.pgy < needRot.eligible_pgy_min || res.pgy > needRot.eligible_pgy_max) break;

      let made = false;

      outer: for (const month of shuffle(monthsList, rng)) {
        const mi = monthsList.indexOf(month);
        const idx = assignmentIndexMap.get(residentMonthKey(res.id, month.id));
        if (idx === undefined) continue;

        if (assignmentRows[idx].rotation_id === needRot.id) continue;

        if ((capacity.get(capKey(month.id, needRot.id)) ?? 0) <= 0) continue;
        if (vacationHardBlock(res.id, month.id, needRot.id)) continue;
        if (wouldCreateSameRotationB2B(res.id, mi, needRot.id)) continue;
        if (wouldCreateStrenuousB2B(res.id, mi, needRot.id)) continue;
        if (wouldCreateTransplantB2B(res.id, mi, needRot.id)) continue;

        const cur = assignmentRows[idx].rotation_id;
        if (cur === null) {
          assignmentRows[idx].rotation_id = needRot.id;
          if (residentViolatesHardSpacing(res.id)) {
            assignmentRows[idx].rotation_id = null;
            continue;
          }
          made = true;
          break outer;
        }

        for (const month2 of shuffle(monthsList, rng)) {
          if (month2.id === month.id) continue;
          const mi2 = monthsList.indexOf(month2);
          const idx2 = assignmentIndexMap.get(residentMonthKey(res.id, month2.id));
          if (idx2 === undefined) continue;
          if (assignmentRows[idx2].rotation_id !== null) continue;

          if (vacationHardBlock(res.id, month2.id, cur)) continue;
          if (wouldCreateSameRotationB2B(res.id, mi2, cur)) continue;
          if (wouldCreateStrenuousB2B(res.id, mi2, cur)) continue;
          if (wouldCreateTransplantB2B(res.id, mi2, cur)) continue;
          if ((capacity.get(capKey(month2.id, cur)) ?? 0) <= 0) continue;

          assignmentRows[idx].rotation_id = needRot.id;
          assignmentRows[idx2].rotation_id = cur;
          if (residentViolatesHardSpacing(res.id)) {
            assignmentRows[idx].rotation_id = cur;
            assignmentRows[idx2].rotation_id = null;
            continue;
          }
          made = true;
          break outer;
        }
      }

      if (!made) break;
      rebuildCapacityFromAssignments();
    }
  };

  runResidentRelocationForDeficits(500);
  for (let z = 0; z < 5; z++) {
    if (deadlineTs !== undefined && Date.now() >= deadlineTs) break;
    runRepairPass(20);
    runPhaseFEnforce();
  }
  runResidentRelocationForDeficits(200);

  const audit = buildAuditForAssignmentRows(staticData, assignmentRows);
  return { assignmentRows, audit };
}

export function computeInitialRequiredMap(data: LoadedSchedulerStaticData): Map<string, number> {
  const { residentsList, rotationsList, requirementsList, residentReqByResident } = data;
  const required = new Map<string, number>();
  for (const r of residentsList) {
    const custom = residentReqByResident.get(r.id);
    if (custom && custom.length > 0) {
      for (const rot of rotationsList) {
        required.set(reqKey(r.id, rot.id), 0);
      }
      for (const row of custom) {
        required.set(reqKey(r.id, row.rotation_id), row.min_months_required);
      }
    } else {
      for (const req of requirementsList) {
        if (req.pgy !== r.pgy) continue;
        required.set(reqKey(r.id, req.rotation_id), req.min_months_required);
      }
    }
  }
  return required;
}

/** Post-generation audit for an assignment grid (same rules as {@link buildScheduleVariation}). */
export function buildAuditForAssignmentRows(
  staticData: LoadedSchedulerStaticData,
  assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[]
): ScheduleAudit {
  const {
    residentsList,
    rotationsList,
    avoidBackToBackConsult,
    noConsultWhenVacationInMonth,
    avoidBackToBackTransplant,
    preferPrimarySiteForLongVacation,
    requirePgyStartAtPrimarySite,
    pgyStartAtPrimarySite,
    vacationRanges,
    academicYearStart,
    academicYearEnd,
  } = staticData;
  /** Chronological order — must match CP-SAT and spacing checks (DB order is not guaranteed). */
  const monthsList = [...staticData.monthsList].sort((a, b) => a.month_index - b.month_index);

  const consultRotationIdsForVacation = new Set<string>();
  const backToBackBlockerRotationIds = new Set<string>();
  const transplantRotationIds = new Set<string>();
  const primarySiteRotationIds = new Set<string>();
  for (const rot of rotationsList) {
    if ((rot as Rotation & { is_consult?: boolean }).is_consult) consultRotationIdsForVacation.add(rot.id);
    if (
      (rot as Rotation & { is_back_to_back_consult_blocker?: boolean }).is_back_to_back_consult_blocker
    )
      backToBackBlockerRotationIds.add(rot.id);
    if ((rot as Rotation & { is_transplant?: boolean }).is_transplant) transplantRotationIds.add(rot.id);
    if ((rot as Rotation & { is_primary_site?: boolean }).is_primary_site) primarySiteRotationIds.add(rot.id);
  }
  const consultRotationIdsForBackToBack =
    backToBackBlockerRotationIds.size > 0 ? backToBackBlockerRotationIds : consultRotationIdsForVacation;
  const useStrenuousConsultLabels = backToBackBlockerRotationIds.size > 0;

  const isRotationBlockedWhenResidentOnVacation = (rotationId: string): boolean =>
    consultRotationIdsForVacation.has(rotationId) || consultRotationIdsForBackToBack.has(rotationId);

  const vacationSet = new Set<string>();
  const nCal = monthsList.length;
  for (let mi = 0; mi < monthsList.length; mi++) {
    const month = monthsList[mi]!;
    let mStart = (month.start_date ?? "").trim();
    let mEnd = (month.end_date ?? "").trim();
    if (!mStart || !mEnd) {
      const approx = approximateMonthWindowUtc(
        academicYearStart,
        academicYearEnd,
        mi,
        nCal
      );
      if (approx) {
        mStart = approx.start;
        mEnd = approx.end;
      }
    }
    if (!mStart || !mEnd) continue;
    for (const resident of residentsList) {
      const hasOverlap = vacationRanges.some(
        (v) => v.resident_id === resident.id && v.start_date <= mEnd && v.end_date >= mStart
      );
      if (hasOverlap) vacationSet.add(residentMonthKey(resident.id, month.id));
    }
  }

  const consultBlockedOnVacationMonth = (residentId: string, monthId: string, rotationId: string): boolean => {
    if (!noConsultWhenVacationInMonth) return false;
    if (!isRotationBlockedWhenResidentOnVacation(rotationId)) return false;
    return vacationSet.has(residentMonthKey(residentId, monthId));
  };

  const rotationById = new Map<string, Rotation>();
  for (const rot of rotationsList) rotationById.set(rot.id, rot);

  const initialRequired = computeInitialRequiredMap(staticData);

  const residentHasLongVacationInMonth = (residentId: string, month: Month): boolean => {
    if (!preferPrimarySiteForLongVacation) return false;
    const mStart = month.start_date ?? "";
    const mEnd = month.end_date ?? "";
    let ms = mStart;
    let me = mEnd;
    if (!ms || !me) {
      const idx = monthsList.indexOf(month);
      if (idx < 0) return false;
      const ap = approximateMonthWindowUtc(academicYearStart, academicYearEnd, idx, monthsList.length);
      if (!ap) return false;
      ms = ap.start;
      me = ap.end;
    }
    let maxOverlap = 0;
    for (const v of vacationRanges) {
      if (v.resident_id !== residentId) continue;
      maxOverlap = Math.max(maxOverlap, vacationOverlapDaysInclusive(v.start_date, v.end_date, ms, me));
    }
    return maxOverlap >= 8;
  };

  const audit: ScheduleAudit = { requirementViolations: [], softRuleViolations: [] };

  const assignedCount = new Map<string, number>();
  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const key = reqKey(row.resident_id, row.rotation_id);
    assignedCount.set(key, (assignedCount.get(key) ?? 0) + 1);
  }

  for (const res of residentsList) {
    for (const rot of rotationsList) {
      const init = initialRequired.get(reqKey(res.id, rot.id));
      if (init === undefined) continue;
      const assigned = assignedCount.get(reqKey(res.id, rot.id)) ?? 0;
      if (assigned !== init) {
        audit.requirementViolations.push({
          residentName: `${res.first_name ?? ""} ${res.last_name ?? ""}`.trim(),
          rotationName: rot.name ?? rot.id,
          required: init,
          assigned,
        });
      }
    }
  }

  const monthIdToLabel = new Map<string, string>();
  for (const m of monthsList) {
    if (m.start_date) {
      const d = new Date(m.start_date);
      const mn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      monthIdToLabel.set(m.id, `${mn[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(-2)}`);
    } else {
      monthIdToLabel.set(m.id, `Month ${m.month_index}`);
    }
  }

  const assignmentLookup = new Map<string, string | null>();
  for (const row of assignmentRows) {
    assignmentLookup.set(residentMonthKey(row.resident_id, row.month_id), row.rotation_id);
  }

  const monthRotationCounts = new Map<string, number>();
  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const k = capKey(row.month_id, row.rotation_id);
    monthRotationCounts.set(k, (monthRotationCounts.get(k) ?? 0) + 1);
  }
  for (const m of monthsList) {
    for (const rot of rotationsList) {
      const n = monthRotationCounts.get(capKey(m.id, rot.id)) ?? 0;
      const max = rot.capacity_per_month;
      if (n > max) {
        const ml = monthIdToLabel.get(m.id) ?? "";
        audit.softRuleViolations.push({
          residentName: "(Program)",
          monthLabel: ml,
          rule: `Rotation "${rot.name ?? rot.id}" has ${n} residents in ${ml || "one month"} (max ${max}/mo in Setup). This should not happen—report as a bug.`,
        });
      }
    }
  }

  if (noConsultWhenVacationInMonth) {
    for (const res of residentsList) {
      const resName = `${res.first_name ?? ""} ${res.last_name ?? ""}`.trim();
      for (const m of monthsList) {
        const rotId = assignmentLookup.get(residentMonthKey(res.id, m.id));
        if (!rotId) continue;
        if (!consultBlockedOnVacationMonth(res.id, m.id, rotId)) continue;
        const rotLabel = rotationById.get(rotId)?.name ?? rotId;
        audit.softRuleViolations.push({
          residentName: resName,
          monthLabel: monthIdToLabel.get(m.id) ?? "",
          rule: `Consult during vacation month: ${rotLabel}`,
        });
      }
    }
  }

  if (preferPrimarySiteForLongVacation && primarySiteRotationIds.size > 0) {
    for (const res of residentsList) {
      const resName = `${res.first_name ?? ""} ${res.last_name ?? ""}`.trim();
      for (const m of monthsList) {
        if (!residentHasLongVacationInMonth(res.id, m)) continue;
        const rotId = assignmentLookup.get(residentMonthKey(res.id, m.id));
        if (!rotId) continue;
        if (primarySiteRotationIds.has(rotId)) continue;
        audit.softRuleViolations.push({
          residentName: resName,
          monthLabel: monthIdToLabel.get(m.id) ?? "",
          rule: `Long vacation month but non-primary rotation: ${rotationById.get(rotId)?.name ?? rotId}`,
        });
      }
    }
  }

  for (const res of residentsList) {
    for (let mi = 1; mi < monthsList.length; mi++) {
      const prevMId = monthsList[mi - 1].id;
      const currMId = monthsList[mi].id;
      const prevRotId = assignmentLookup.get(residentMonthKey(res.id, prevMId));
      const currRotId = assignmentLookup.get(residentMonthKey(res.id, currMId));
      if (!prevRotId || !currRotId) continue;
      const resName = `${res.first_name ?? ""} ${res.last_name ?? ""}`.trim();
      if (avoidBackToBackConsult && mi >= 2) {
        const prevPrevMId = monthsList[mi - 2].id;
        const prevPrevRotId = assignmentLookup.get(residentMonthKey(res.id, prevPrevMId));
        if (
          prevPrevRotId &&
          consultRotationIdsForBackToBack.has(prevPrevRotId) &&
          consultRotationIdsForBackToBack.has(prevRotId) &&
          consultRotationIdsForBackToBack.has(currRotId)
        ) {
          const a = rotationById.get(prevPrevRotId)?.name ?? prevPrevRotId;
          const b = rotationById.get(prevRotId)?.name ?? prevRotId;
          const c = rotationById.get(currRotId)?.name ?? currRotId;
          audit.softRuleViolations.push({
            residentName: resName,
            monthLabel: monthIdToLabel.get(currMId) ?? "",
            rule: useStrenuousConsultLabels
              ? `3-in-a-row strenuous consult: ${a} → ${b} → ${c}`
              : `3-in-a-row consult: ${a} → ${b} → ${c}`,
          });
        }
      }
      if (
        avoidBackToBackConsult &&
        consultRotationIdsForBackToBack.has(prevRotId) &&
        consultRotationIdsForBackToBack.has(currRotId)
      ) {
        const prevName = rotationById.get(prevRotId)?.name ?? "Consult";
        const currName = rotationById.get(currRotId)?.name ?? "Consult";
        if (prevRotId === currRotId) {
          audit.softRuleViolations.push({
            residentName: resName,
            monthLabel: monthIdToLabel.get(currMId) ?? "",
            rule: useStrenuousConsultLabels
              ? `Back-to-back same strenuous rotation: ${prevName}`
              : `Back-to-back same consult rotation: ${prevName}`,
          });
        } else {
          audit.softRuleViolations.push({
            residentName: resName,
            monthLabel: monthIdToLabel.get(currMId) ?? "",
            rule: useStrenuousConsultLabels
              ? `Back-to-back strenuous consult: ${prevName} → ${currName}`
              : `Back-to-back consult: ${prevName} → ${currName}`,
          });
        }
      } else if (prevRotId === currRotId) {
        const rotLabel = rotationById.get(prevRotId)?.name ?? prevRotId;
        audit.softRuleViolations.push({
          residentName: resName,
          monthLabel: monthIdToLabel.get(currMId) ?? "",
          rule: `Back-to-back same rotation: ${rotLabel}`,
        });
      }
      if (avoidBackToBackTransplant && transplantRotationIds.has(prevRotId) && transplantRotationIds.has(currRotId)) {
        const prevName = rotationById.get(prevRotId)?.name ?? "Transplant";
        const currName = rotationById.get(currRotId)?.name ?? "Transplant";
        audit.softRuleViolations.push({
          residentName: resName,
          monthLabel: monthIdToLabel.get(currMId) ?? "",
          rule: `Back-to-back transplant: ${prevName} → ${currName}`,
        });
      }
    }

    if (requirePgyStartAtPrimarySite && res.pgy === pgyStartAtPrimarySite && monthsList.length > 0) {
      const firstMId = monthsList[0].id;
      const firstRotId = assignmentLookup.get(residentMonthKey(res.id, firstMId));
      if (firstRotId && !primarySiteRotationIds.has(firstRotId)) {
        audit.softRuleViolations.push({
          residentName: `${res.first_name ?? ""} ${res.last_name ?? ""}`.trim(),
          monthLabel: monthIdToLabel.get(firstMId) ?? "",
          rule: `PGY${pgyStartAtPrimarySite} not starting at primary site (assigned ${rotationById.get(firstRotId)?.name ?? firstRotId})`,
        });
      }
    }
  }

  return audit;
}

/**
 * Analyze rotation capacities, PGY rules, vacations, and optional saved audit to suggest parameter changes.
 * Safe to call with `audit: null` (static checks only).
 */
export function buildFeasibilityReport(
  data: LoadedSchedulerStaticData,
  audit?: ScheduleAudit | null
): FeasibilityReport {
  const {
    monthsList,
    residentsList,
    rotationsList,
    avoidBackToBackConsult,
    noConsultWhenVacationInMonth,
    avoidBackToBackTransplant,
    vacationRanges,
  } = data;
  const required = computeInitialRequiredMap(data);
  const nMonths = monthsList.length;
  const checks: FeasibilityReport["checks"] = [];
  const suggestions: string[] = [];
  const residentLabel = (r: Resident) =>
    `${(r.first_name ?? "").trim()} ${(r.last_name ?? "").trim()}`.trim() || r.id;

  // --- Per-resident total required vs months in year ---
  for (const res of residentsList) {
    let sumReq = 0;
    for (const rot of rotationsList) {
      sumReq += Math.max(0, required.get(reqKey(res.id, rot.id)) ?? 0);
    }
    const ok = sumReq <= nMonths;
    if (!ok) {
      checks.push({
        label: `${residentLabel(res)}: too many required rotations`,
        ok: false,
        detail: `This resident is required to complete ${sumReq} rotation months, but the year only has ${nMonths} months.`,
      });
      suggestions.push(
        `For ${residentLabel(res)}: lower how many months they must spend on rotations (right now it adds up to ${sumReq}, but there are only ${nMonths} months in the year). Or add more months to this academic year in your setup.`
      );
    }
  }

  // --- PGY eligibility vs requirements (record failures only to keep the list readable) ---
  for (const res of residentsList) {
    for (const rot of rotationsList) {
      const need = required.get(reqKey(res.id, rot.id)) ?? 0;
      if (need <= 0) continue;
      const ok = res.pgy >= rot.eligible_pgy_min && res.pgy <= rot.eligible_pgy_max;
      const rname = rot.name ?? rot.id;
      if (!ok) {
        checks.push({
          label: `${residentLabel(res)} and ${rname} don’t match PGY rules`,
          ok: false,
          detail: `${residentLabel(res)} is PGY ${res.pgy}, but ${rname} is only set up for PGY ${rot.eligible_pgy_min}–${rot.eligible_pgy_max}.`,
        });
        suggestions.push(
          `Update either the rotation “who can do this” PGY range for ${rname}, or the requirements so ${residentLabel(res)} (PGY ${res.pgy}) isn’t required on that rotation until the PGY line up.`
        );
      }
    }
  }

  // --- Rotation supply (capacity × months) vs demand ---
  for (const rot of rotationsList) {
    let demand = 0;
    for (const res of residentsList) {
      demand += Math.max(0, required.get(reqKey(res.id, rot.id)) ?? 0);
    }
    if (demand <= 0) continue;
    const capMo = rot.capacity_per_month;
    const supply = nMonths > 0 ? nMonths * capMo : 0;
    const ok = demand <= supply;
    const rname = rot.name ?? rot.id;
    if (!ok) {
      checks.push({
        label: `Not enough open spots on ${rname}`,
        ok: false,
        detail: `The program needs ${demand} assignment months on ${rname}, but only about ${supply} exist (${capMo} resident(s) per month × ${nMonths} months; capacity is set in Rotations).`,
      });
      suggestions.push(
        `For ${rname}: either raise “residents per month” in Setup (currently ${capMo}), or reduce how many months each person must do on that rotation. You need at least ${demand} total assignment-months; you only have about ${supply}.`
      );
    }
  }

  // --- Vacation + consult rule ---
  const vacationCount = vacationRanges.length;
  if (noConsultWhenVacationInMonth && vacationCount > 0) {
    checks.push({
      label: "Vacation overlaps the academic year",
      ok: true,
      detail: `You have ${vacationCount} vacation booking(s). The scheduler first tries to avoid consult/strenuous months on those months, then may allow them if needed to meet rotation requirements or to reduce back-to-back strenuous consult.`,
    });
    suggestions.push(
      "With “prefer no consult during vacation” on, generation runs in two phases: strict preference first, then relaxed if that helps spacing. Soft warnings list any month where consult/strenuous still landed on vacation."
    );
  }

  // --- Strenuous B2B + transplant spacing ---
  const strenuousIds = buildStrenuousConsultRotationIds(rotationsList);
  let strenuousDemand = 0;
  for (const res of residentsList) {
    for (const rot of rotationsList) {
      if (!strenuousIds.has(rot.id)) continue;
      strenuousDemand += Math.max(0, required.get(reqKey(res.id, rot.id)) ?? 0);
    }
  }
  if (avoidBackToBackConsult && strenuousDemand > 0 && nMonths > 0) {
    checks.push({
      label: "Spacing out heavy consult months",
      ok: true,
      detail: `The program needs ${strenuousDemand} months on “strenuous consult” rotations in total. With “avoid back-to-back strenuous consult” on, the scheduler will not save a schedule where any resident has two consecutive months on those rotations.`,
    });
    suggestions.push(
      "“Avoid back-to-back strenuous consult” is a hard rule when enabled: no consecutive strenuous consult months. That needs gaps between heavy consult assignments. Easier options: mark only the heaviest rotations as “blockers,” add one more resident-per-month on those services, shorten how many consult months each person needs, or turn this rule off for one test run to see if spacing was the problem."
    );
  }
  if (!audit && avoidBackToBackConsult) {
    suggestions.push(
      "The scheduler always returns a schedule. If any back-to-back strenuous consult months remain, they appear as soft-rule warnings. Try the spacing ideas above to help the algorithm achieve zero."
    );
  }
  if (avoidBackToBackTransplant) {
    suggestions.push(
      "“Avoid back-to-back transplant” is turned on. If things still don’t work, try fewer transplant months per person or more transplant slots per month."
    );
  }

  // --- Audit-driven (saved or best attempt) ---
  if (audit && audit.requirementViolations.length > 0) {
    const byRot = new Map<string, { short: number; example: string }>();
    for (const v of audit.requirementViolations) {
      const prev = byRot.get(v.rotationName) ?? { short: 0, example: v.residentName };
      const gap = v.required - v.assigned;
      byRot.set(v.rotationName, {
        short: prev.short + Math.max(0, gap),
        example: prev.example,
      });
    }
    for (const [rotName, { example }] of byRot) {
      suggestions.push(
        `The schedule is still missing time on ${rotName} for someone (for example ${example}). In Setup, either increase how many residents that service can take each month, or reduce how many months of ${rotName} are required—and generate again.`
      );
    }
  }

  if (
    audit &&
    noConsultWhenVacationInMonth &&
    audit.softRuleViolations.some((v) => v.rule.startsWith("Consult during vacation month:"))
  ) {
    const nVac = audit.softRuleViolations.filter((v) =>
      v.rule.startsWith("Consult during vacation month:")
    ).length;
    suggestions.push(
      nVac === 1
        ? "One consult-on-vacation warning below: adjust that resident’s vacation dates in Setup so they don’t overlap the listed month, or accept the warning."
        : `${nVac} consult-on-vacation warnings below — use the audit for who and which month; shift vacation dates in Setup off those months, or turn off “prefer no consult during vacation” if that’s acceptable.`
    );
  }

  // Dedupe suggestions (keep order)
  const seen = new Set<string>();
  const uniqueSuggestions = suggestions.filter((s) => {
    const k = s.slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const failedStatic = checks.filter((c) => !c.ok).length;
  const auditFail = audit ? audit.requirementViolations.length + audit.softRuleViolations.length : 0;

  let summary =
    failedStatic > 0
      ? "Something in your setup doesn’t add up yet—like too many required months or PGY rules that don’t match. Fix the items marked below (or follow the steps), then click Generate again."
      : audit && audit.requirementViolations.length > 0
        ? "Not everyone got the number of months you required on each rotation. The list below suggests concrete changes in Setup (usually capacity or how many months are required)."
        : audit && audit.softRuleViolations.length > 0
          ? "Required month counts are OK, but some “nice-to-have” rules weren’t fully met (for example back-to-back consult or vacation). Try the ideas below or accept the warnings and edit the grid by hand."
          : "The rules you turned on may be too strict for the number of spots you have. Try the steps below—often raising capacity a little or relaxing one preference fixes it.";

  if (failedStatic === 0 && auditFail === 0 && uniqueSuggestions.length === 0) {
    summary =
      "Try giving rotations a bit more capacity, lowering required months, or relaxing options like consult spacing or vacation rules—then generate again.";
  }

  return { summary, suggestions: uniqueSuggestions, checks };
}

/**
 * For API routes / client fallback: reload program setup from DB and merge optional audit into hints.
 */
export async function buildFeasibilityReportForAcademicYear(
  supabaseAdmin: SupabaseClient,
  academicYearId: string,
  audit?: ScheduleAudit | null
): Promise<FeasibilityReport> {
  const staticData = await loadSchedulerStaticData({ supabaseAdmin, academicYearId });
  return buildFeasibilityReport(staticData, audit ?? null);
}

export const SCHEDULE_ERROR_REQUIREMENTS_UNSATISFIABLE = "SCHEDULE_CONSTRAINTS_UNSATISFIABLE";

export class ScheduleUnsatError extends Error {
  readonly feasibilityReport: FeasibilityReport;
  /** Which engine decided this failure (CP-SAT proof vs heuristic best attempt). */
  readonly schedulerEngineUsed: "cp_sat" | "heuristic";
  /** First hard-rule failure from SCHEDULER_WITNESS_ASSIGNMENTS_JSON vs current static data, if configured. */
  readonly witnessFirstFailure?: string;
  constructor(
    feasibilityReport: FeasibilityReport,
    schedulerEngineUsed: "cp_sat" | "heuristic" = "heuristic",
    witnessFirstFailure?: string
  ) {
    super(SCHEDULE_ERROR_REQUIREMENTS_UNSATISFIABLE);
    this.name = "ScheduleUnsatError";
    this.feasibilityReport = feasibilityReport;
    this.schedulerEngineUsed = schedulerEngineUsed;
    if (witnessFirstFailure) this.witnessFirstFailure = witnessFirstFailure;
  }
}

/** Generate blocked before solve: fixed pin on a vacation-overlap month for a `prohibited` rotation. */
export class ScheduleVacationOverlapFixedBlockError extends Error {
  readonly vacation_overlap_blocked: VacationOverlapBlocked;
  constructor(block: VacationOverlapBlocked) {
    super(block.message);
    this.name = "ScheduleVacationOverlapFixedBlockError";
    this.vacation_overlap_blocked = block;
  }
}

/** CP-SAT cannot run in this runtime (missing Python, OR-Tools, or unreachable remote solver). */
export class ScheduleCpSatUnavailableError extends Error {
  readonly cp_sat_unavailable: CpSatUnavailableDetail;
  constructor(detail: CpSatUnavailableDetail) {
    super(detail.message);
    this.name = "ScheduleCpSatUnavailableError";
    this.cp_sat_unavailable = detail;
  }
}

/**
 * Strenuous consult spacing audit lines: adjacent blocker months and 3-in-a-row (or legacy consult fallback labels).
 */
function countStrenuousConsultBackToBackViolations(audit: ScheduleAudit): number {
  return audit.softRuleViolations.filter(
    (v) =>
      v.rule.startsWith("Back-to-back same strenuous rotation:") ||
      v.rule.startsWith("Back-to-back same consult rotation:") ||
      v.rule.startsWith("Back-to-back strenuous consult:") ||
      v.rule.startsWith("Back-to-back consult:") ||
      v.rule.startsWith("3-in-a-row strenuous consult:") ||
      v.rule.startsWith("3-in-a-row consult:")
  ).length;
}

/** Consecutive months on the same rotation (any service), including strenuous-labeled lines. */
function countAnySameRotationBackToBackViolations(audit: ScheduleAudit): number {
  return audit.softRuleViolations.filter(
    (v) =>
      v.rule.startsWith("Back-to-back same rotation:") ||
      v.rule.startsWith("Back-to-back same strenuous rotation:") ||
      v.rule.startsWith("Back-to-back same consult rotation:")
  ).length;
}

function countVacationConsultSoftViolations(audit: ScheduleAudit): number {
  return audit.softRuleViolations.filter((v) =>
    v.rule.startsWith("Consult during vacation month:")
  ).length;
}

/**
 * Minimax + variance of soft-rule counts per resident (same name format as audit).
 * Used as a late tie-break to spread burden more evenly when global totals match.
 */
function softViolationFairnessStats(
  audit: ScheduleAudit,
  residentsList: Resident[]
): { maxPerResident: number; variance: number } {
  const byName = new Map<string, number>();
  for (const r of residentsList) {
    const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
    if (name) byName.set(name, 0);
  }
  for (const v of audit.softRuleViolations) {
    const n = (v.residentName ?? "").trim();
    byName.set(n, (byName.get(n) ?? 0) + 1);
  }
  const counts = [...byName.values()];
  const maxPerResident = counts.length > 0 ? Math.max(...counts) : 0;
  const n = counts.length;
  const sum = counts.reduce((a, b) => a + b, 0);
  const mean = n > 0 ? sum / n : 0;
  let varSum = 0;
  for (const c of counts) {
    const d = c - mean;
    varSum += d * d;
  }
  const variance = n > 0 ? varSum / n : 0;
  return { maxPerResident, variance };
}

function hashStringToU32(input: string): number {
  // FNV-1a 32-bit hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

async function persistSchedule({
  supabaseAdmin,
  academicYearId,
  seed,
  attempt,
  assignmentRows,
}: {
  supabaseAdmin: SupabaseClient;
  academicYearId: string;
  seed: number;
  attempt: number;
  assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[];
}): Promise<string> {
  const formatPacific = (d: Date): string => {
    // Use America/Los_Angeles so the timestamp shows PST or PDT appropriately.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);

    const map: Record<string, string> = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = p.value;
    }

    // MM/DD/YYYY HH:mm:ss -> convert to YYYY-MM-DD HH:mm:ss for stable sorting.
    const date = `${map.year}-${map.month}-${map.day}`;
    const time = `${map.hour}:${map.minute}:${map.second}`;
    const tz = map.timeZoneName ?? "PT";
    return `${date} ${time} ${tz}`;
  };

  const versionName = `Generated ${formatPacific(new Date())} (attempt ${
    attempt + 1
  }, seed ${seed})`;

  const { data: versionRow, error: versionErr } = await supabaseAdmin
    .from("schedule_versions")
    .insert({ academic_year_id: academicYearId, version_name: versionName })
    .select("id")
    .single();

  if (versionErr || !versionRow) {
    const msg = versionErr?.message ?? "No row returned";
    throw new Error(`Failed to create schedule version: ${msg}`);
  }

  const scheduleVersionId = versionRow.id as string;

  if (assignmentRows.length > 0) {
    const rowsToInsert = assignmentRows.map((r) => ({
      schedule_version_id: scheduleVersionId,
      resident_id: r.resident_id,
      month_id: r.month_id,
      rotation_id: r.rotation_id,
    }));
    const { error: assignErr } = await supabaseAdmin.from("assignments").insert(rowsToInsert);
    if (assignErr) {
      throw new Error(assignErr.message || "Failed to insert assignments");
    }
  }

  return scheduleVersionId;
}

function buildHardSpacingUnsatFeasibilityReport(staticData: LoadedSchedulerStaticData): FeasibilityReport {
  void staticData;
  return {
    summary:
      "Within the search time we could not build a schedule that satisfies hard spacing rules: no two consecutive months on the same rotation, and (when enabled) no consecutive strenuous consult months and no consecutive transplant months. Nothing is saved until all of those are satisfied.",
    suggestions: [
      "Lower how many months each resident must spend on the same heavy consult rotation, or raise that rotation’s residents-per-month capacity so those months can be separated.",
      "Mark only the most demanding services as strenuous “blockers” so more rotations count as safe gaps between heavy months.",
      "If “avoid back-to-back transplant” is on, reduce transplant-month requirements or add transplant capacity per month.",
      "Click Generate again—the search is randomized and tight setups sometimes succeed on a later attempt.",
    ],
    checks: [
      {
        label: "Hard spacing (consecutive same rotation / strenuous consult / transplant)",
        ok: false,
        detail: "Schedules with any of these consecutive-month violations are not saved.",
      },
    ],
  };
}

function enrichVacationOverlap(
  staticData: LoadedSchedulerStaticData,
  assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[],
  base: Omit<
    GenerateScheduleResult,
    "feasibilityReport" | "vacation_overlap_summary" | "vacation_overlap_details"
  >
): Omit<GenerateScheduleResult, "feasibilityReport"> {
  const { vacation_overlap_summary, vacation_overlap_details } = buildVacationOverlapReport(
    staticData,
    assignmentRows
  );
  return { ...base, vacation_overlap_summary, vacation_overlap_details };
}

function withFeasibility(
  staticData: LoadedSchedulerStaticData,
  audit: ScheduleAudit,
  partial: Omit<GenerateScheduleResult, "feasibilityReport">
): GenerateScheduleResult {
  const noisy =
    partial.strenuousConsultB2bBestEffort != null ||
    audit.requirementViolations.length > 0 ||
    audit.softRuleViolations.length > 0;
  if (!noisy) return partial as GenerateScheduleResult;
  return {
    ...partial,
    feasibilityReport: buildFeasibilityReport(staticData, audit),
  };
}

export async function generateSchedule({
  supabaseAdmin,
  academicYearId,
  omitFixedAssignmentRules = false,
}: {
  supabaseAdmin: SupabaseClient;
  academicYearId: string;
  omitFixedAssignmentRules?: boolean;
}): Promise<GenerateScheduleResult> {
  const staticData = await loadSchedulerStaticData({
    supabaseAdmin,
    academicYearId,
    omitFixedAssignmentRules,
  });

  const fixedVacBlock = omitFixedAssignmentRules
    ? null
    : getFixedProhibitedVacationOverlapBlock(staticData);
  if (fixedVacBlock) {
    throw new ScheduleVacationOverlapFixedBlockError(fixedVacBlock);
  }

  /** CP-SAT whenever SCHEDULER_ENGINE is unset. Use SCHEDULER_ENGINE=heuristic only if Python/OR-Tools is unavailable. */
  const schedulerEngine = (process.env.SCHEDULER_ENGINE ?? "cp_sat").toLowerCase().trim();

  if (schedulerEngine !== "heuristic") {
    const { trySolveScheduleWithCpSat } = await import("./cpSatSolver");
    const { result: cp } = await trySolveScheduleWithCpSat(staticData);
    if (cp.kind === "ok") {
      const scheduleVersionId = await persistSchedule({
        supabaseAdmin,
        academicYearId,
        seed: 0x43505341,
        attempt: 0,
        assignmentRows: cp.assignmentRows,
      });
      return withFeasibility(
        staticData,
        cp.audit,
        enrichVacationOverlap(staticData, cp.assignmentRows, {
          scheduleVersionId,
          audit: cp.audit,
          schedulerEngineUsed: "cp_sat",
        })
      );
    }
    if (cp.kind === "infeasible") {
      throw new ScheduleUnsatError(
        cp.feasibilityReport,
        "cp_sat",
        computeWitnessFirstFailureIfConfigured(staticData) ?? undefined
      );
    }
    if (cp.kind === "unavailable" && cp.cp_sat_unavailable) {
      throw new ScheduleCpSatUnavailableError(cp.cp_sat_unavailable);
    }
    throw new Error(
      `${cp.reason} Schedule generation uses CP-SAT by default. Configure a Python runtime, set SCHEDULER_CP_SOLVER_URL to a remote solver, or use SCHEDULER_ENGINE=heuristic only as a fallback. See docs/cp-sat-production.md`
    );
  }

  const baseSeed = (hashStringToU32(academicYearId) ^ (Date.now() >>> 0)) >>> 0;
  const prioritizeStrenuousSpacing = staticData.avoidBackToBackConsult === true;
  const strenuousRotationIds = buildStrenuousConsultRotationIds(staticData.rotationsList);

  const searchStartedAt = Date.now();
  const deadlineTs = searchStartedAt + SCHEDULE_SEARCH_BUDGET_MS;
  /** First ~half of the 90s window uses strict vacation blocking when the program preference is on. */
  const strictVacationUntilTs = searchStartedAt + SCHEDULE_SEARCH_BUDGET_MS / 2;
  const maxAttempts = 20_000;

  type CandidateSchedule = {
    assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[];
    audit: ScheduleAudit;
    attempt: number;
    seed: number;
    requirementViolations: number;
    b2bEdges: number;
    softCount: number;
    strenuousMetrics: { totalEdges: number; residentsOverOne: number };
    strenuousAuditLines: number;
    sameRotationB2bEdges: number;
    transplantBackToBackViolations: number;
    vacationSoftViolations: number;
    otherSoftCount: number;
    maxSoftPerResident: number;
    softVariance: number;
  };

  /** Lexicographic comparison used for ALL candidate tracking.
   *  Priority: (1) requirements, (2) same-rotation B2B (any service), (3) strenuous B2B, (4) soft metrics. */
  const isBetterCandidate = (next: CandidateSchedule, prev: CandidateSchedule): boolean => {
    // Requirement violations are the #1 priority — must be met before anything else
    if (next.requirementViolations !== prev.requirementViolations) {
      return next.requirementViolations < prev.requirementViolations;
    }
    if (next.sameRotationB2bEdges !== prev.sameRotationB2bEdges) {
      return next.sameRotationB2bEdges < prev.sameRotationB2bEdges;
    }
    // Among schedules with equal requirement satisfaction, prefer zero B2B
    if (prioritizeStrenuousSpacing) {
      const nextB2bOk = next.b2bEdges === 0 ? 0 : 1;
      const prevB2bOk = prev.b2bEdges === 0 ? 0 : 1;
      if (nextB2bOk !== prevB2bOk) return nextB2bOk < prevB2bOk;
    }
    // Then minimize B2B edges further
    if (isBetterStrenuousMetrics(next.strenuousMetrics, prev.strenuousMetrics)) return true;
    if (isBetterStrenuousMetrics(prev.strenuousMetrics, next.strenuousMetrics)) return false;
    if (next.strenuousAuditLines !== prev.strenuousAuditLines) {
      return next.strenuousAuditLines < prev.strenuousAuditLines;
    }
    // Then soft count and sub-metrics
    if (next.softCount !== prev.softCount) return next.softCount < prev.softCount;
    if (next.transplantBackToBackViolations !== prev.transplantBackToBackViolations) {
      return next.transplantBackToBackViolations < prev.transplantBackToBackViolations;
    }
    if (next.vacationSoftViolations !== prev.vacationSoftViolations) {
      return next.vacationSoftViolations < prev.vacationSoftViolations;
    }
    if (next.otherSoftCount !== prev.otherSoftCount) return next.otherSoftCount < prev.otherSoftCount;
    if (next.maxSoftPerResident !== prev.maxSoftPerResident) {
      return next.maxSoftPerResident < prev.maxSoftPerResident;
    }
    return next.softVariance < prev.softVariance;
  };

  /** Best candidate with valid hard spacing (may still have unmet rotation counts). */
  let bestSpacingValid: CandidateSchedule | null = null;
  /** Best candidate with valid hard spacing and zero requirement violations — only kind we persist. */
  let bestFullyValid: CandidateSchedule | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() >= deadlineTs) break;
    const seed = (baseSeed + attempt) >>> 0;
    const vacationConsultStrict =
      staticData.noConsultWhenVacationInMonth === true && Date.now() < strictVacationUntilTs;
    const { assignmentRows, audit } = await buildScheduleVariation({
      staticData,
      seed,
      deadlineTs,
      vacationConsultStrict,
    });

    const strenuousMetrics = computeStrenuousB2BMetrics(
      assignmentRows,
      staticData.monthsList,
      staticData.residentsList,
      strenuousRotationIds
    );
    const strenuousAuditLines = countStrenuousConsultBackToBackViolations(audit);
    const sameRotationB2bEdges = countAnySameRotationBackToBackViolations(audit);
    const transplantBackToBackViolations = audit.softRuleViolations.filter((v) =>
      v.rule.startsWith("Back-to-back transplant:")
    ).length;

    const reqViolCount = audit.requirementViolations.length;
    const softCount = audit.softRuleViolations.length;
    const vacationSoftViolations = countVacationConsultSoftViolations(audit);
    const otherSoftCount = Math.max(
      0,
      softCount - vacationSoftViolations - strenuousAuditLines - transplantBackToBackViolations
    );
    const { maxPerResident: maxSoftPerResident, variance: softVariance } = softViolationFairnessStats(
      audit,
      staticData.residentsList
    );

    const candidate: CandidateSchedule = {
      assignmentRows,
      audit,
      attempt,
      seed,
      requirementViolations: reqViolCount,
      b2bEdges: strenuousMetrics.totalEdges,
      softCount,
      strenuousMetrics,
      strenuousAuditLines,
      sameRotationB2bEdges,
      transplantBackToBackViolations,
      vacationSoftViolations,
      otherSoftCount,
      maxSoftPerResident,
      softVariance,
    };

    const hardSpacingOk = !assignmentHasHardSpacingViolations(
      assignmentRows,
      staticData.monthsList,
      staticData.residentsList,
      staticData.rotationsList,
      staticData.avoidBackToBackConsult,
      staticData.avoidBackToBackTransplant
    );
    if (hardSpacingOk && (!bestSpacingValid || isBetterCandidate(candidate, bestSpacingValid))) {
      bestSpacingValid = candidate;
    }
    if (
      hardSpacingOk &&
      reqViolCount === 0 &&
      (!bestFullyValid || isBetterCandidate(candidate, bestFullyValid))
    ) {
      bestFullyValid = candidate;
    }

    // Early exit: perfect schedule (hard spacing OK, strenuous B2B satisfied, requirements met, low soft count)
    const b2bOk = !prioritizeStrenuousSpacing || strenuousMetrics.totalEdges === 0;
    if (
      hardSpacingOk &&
      b2bOk &&
      sameRotationB2bEdges === 0 &&
      reqViolCount === 0 &&
      softCount < SOFT_RULE_TARGET_MAX_EXCLUSIVE
    ) {
      const scheduleVersionId = await persistSchedule({
        supabaseAdmin,
        academicYearId,
        seed,
        attempt,
        assignmentRows,
      });
      return withFeasibility(
        staticData,
        audit,
        enrichVacationOverlap(staticData, assignmentRows, {
          scheduleVersionId,
          audit,
          schedulerEngineUsed: "heuristic",
        })
      );
    }
  }

  if (bestFullyValid) {
    const scheduleVersionId = await persistSchedule({
      supabaseAdmin,
      academicYearId,
      seed: bestFullyValid.seed,
      attempt: bestFullyValid.attempt,
      assignmentRows: bestFullyValid.assignmentRows,
    });
    return withFeasibility(
      staticData,
      bestFullyValid.audit,
      enrichVacationOverlap(staticData, bestFullyValid.assignmentRows, {
        scheduleVersionId,
        audit: bestFullyValid.audit,
        schedulerEngineUsed: "heuristic",
      })
    );
  }

  if (bestSpacingValid) {
    throw new ScheduleUnsatError(
      buildFeasibilityReport(staticData, bestSpacingValid.audit),
      "heuristic",
      computeWitnessFirstFailureIfConfigured(staticData) ?? undefined
    );
  }

  throw new ScheduleUnsatError(
    buildHardSpacingUnsatFeasibilityReport(staticData),
    "heuristic",
    computeWitnessFirstFailureIfConfigured(staticData) ?? undefined
  );
}
