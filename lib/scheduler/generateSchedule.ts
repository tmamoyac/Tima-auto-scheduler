import type { SupabaseClient } from "@supabase/supabase-js";

type Resident = { id: string; program_id: string; pgy: number; is_active: boolean };
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
  capacity_per_month: number;
  eligible_pgy_min: number;
  eligible_pgy_max: number;
  is_consult?: boolean;
  is_transplant?: boolean;
  is_primary_site?: boolean;
};
type Requirement = { pgy: number; rotation_id: string; min_months_required: number };
type VacationRange = { resident_id: string; start_date: string; end_date: string };
type FixedRule = { resident_id: string; month_id: string; rotation_id: string };

function shuffle<T>(array: T[]): T[] {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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

export async function generateSchedule({
  supabaseAdmin,
  academicYearId,
}: {
  supabaseAdmin: SupabaseClient;
  academicYearId: string;
}): Promise<{ scheduleVersionId: string }> {
  // 1) Resolve program from academic year
  const { data: academicYear, error: ayErr } = await supabaseAdmin
    .from("academic_years")
    .select("id, program_id")
    .eq("id", academicYearId)
    .single();

  if (ayErr || !academicYear) {
    throw new Error("Academic year not found");
  }
  const programId = academicYear.program_id as string;

  // 2) Load data
  const { data: months, error: monthsErr } = await supabaseAdmin
    .from("months")
    .select("id, academic_year_id, month_index, start_date, end_date")
    .eq("academic_year_id", academicYearId)
    .order("month_index", { ascending: true });

  if (monthsErr) throw monthsErr;
  const monthsList = (months ?? []) as Month[];

  const { data: residents, error: residentsErr } = await supabaseAdmin
    .from("residents")
    .select("id, program_id, pgy, is_active")
    .eq("program_id", programId)
    .eq("is_active", true);

  if (residentsErr) throw residentsErr;
  const residentsList = (residents ?? []) as Resident[];

  const { data: rotations, error: rotationsErr } = await supabaseAdmin
    .from("rotations")
    .select("id, program_id, capacity_per_month, eligible_pgy_min, eligible_pgy_max, is_consult, is_transplant, is_primary_site")
    .eq("program_id", programId);

  if (rotationsErr) throw rotationsErr;
  const rotationsList = (rotations ?? []) as Rotation[];

  const { data: programRow } = await supabaseAdmin
    .from("programs")
    .select("avoid_back_to_back_consult, no_consult_when_vacation_in_month, avoid_back_to_back_transplant, prefer_primary_site_for_long_vacation, require_pgy_start_at_primary_site, pgy_start_at_primary_site")
    .eq("id", programId)
    .single();
  const program = programRow as {
    avoid_back_to_back_consult?: boolean;
    no_consult_when_vacation_in_month?: boolean;
    avoid_back_to_back_transplant?: boolean;
    prefer_primary_site_for_long_vacation?: boolean;
    require_pgy_start_at_primary_site?: boolean;
    pgy_start_at_primary_site?: number | null;
  } | null;
  const avoidBackToBackConsult = program?.avoid_back_to_back_consult === true;
  const noConsultWhenVacationInMonth = program?.no_consult_when_vacation_in_month === true;
  const avoidBackToBackTransplant = program?.avoid_back_to_back_transplant === true;
  const preferPrimarySiteForLongVacation = program?.prefer_primary_site_for_long_vacation === true;
  const requirePgyStartAtPrimarySite = program?.require_pgy_start_at_primary_site === true;
  const pgyStartAtPrimarySite =
    typeof program?.pgy_start_at_primary_site === "number" ? program.pgy_start_at_primary_site : 4;

  const consultRotationIds = new Set<string>();
  const transplantRotationIds = new Set<string>();
  const primarySiteRotationIds = new Set<string>();
  for (const rot of rotationsList) {
    if ((rot as Rotation & { is_consult?: boolean }).is_consult) consultRotationIds.add(rot.id);
    if ((rot as Rotation & { is_transplant?: boolean }).is_transplant) transplantRotationIds.add(rot.id);
    if ((rot as Rotation & { is_primary_site?: boolean }).is_primary_site) primarySiteRotationIds.add(rot.id);
  }

  const { data: yearRow } = await supabaseAdmin
    .from("academic_years")
    .select("start_date, end_date")
    .eq("id", academicYearId)
    .single();
  const yearStart = (yearRow as { start_date: string } | null)?.start_date ?? "";
  const yearEnd = (yearRow as { end_date: string } | null)?.end_date ?? "";
  const { data: vacationRows } = await supabaseAdmin
    .from("vacation_requests")
    .select("resident_id, start_date, end_date")
    .lte("start_date", yearEnd)
    .gte("end_date", yearStart);
  const vacationRanges = (vacationRows ?? []) as VacationRange[];
  const vacationSet = new Set<string>();
  for (const month of monthsList) {
    const mStart = month.start_date ?? "";
    const mEnd = month.end_date ?? "";
    if (!mStart || !mEnd) continue;
    for (const resident of residentsList) {
      const hasOverlap = vacationRanges.some(
        (v) =>
          v.resident_id === resident.id && v.start_date <= mEnd && v.end_date >= mStart
      );
      if (hasOverlap) vacationSet.add(residentMonthKey(resident.id, month.id));
    }
  }

  // "More than one week" = 8+ days (so Feb 1–12, etc. gets primary-site preference)
  const LONG_VACATION_DAYS = 8;
  const residentsWithLongVacation = new Set<string>();
  for (const v of vacationRanges) {
    const startMs = new Date(v.start_date).getTime();
    const endMs = new Date(v.end_date).getTime();
    const days = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
    if (days >= LONG_VACATION_DAYS) residentsWithLongVacation.add(v.resident_id);
  }

  const { data: fixedRulesRows } = await supabaseAdmin
    .from("fixed_assignment_rules")
    .select("resident_id, month_id, rotation_id")
    .eq("academic_year_id", academicYearId);
  const fixedRulesList = (fixedRulesRows ?? []) as FixedRule[];
  const fixedRuleMap = new Map<string, string>();
  for (const r of fixedRulesList) {
    fixedRuleMap.set(residentMonthKey(r.resident_id, r.month_id), r.rotation_id);
  }

  const { data: requirements, error: reqErr } = await supabaseAdmin
    .from("rotation_requirements")
    .select("pgy, rotation_id, min_months_required")
    .eq("program_id", programId);

  if (reqErr) throw reqErr;
  const requirementsList = (requirements ?? []) as Requirement[];

  // 3) Build capacity: for each (month, rotation) -> capacity_per_month
  const capacity = new Map<string, number>();
  for (const month of monthsList) {
    for (const rot of rotationsList) {
      capacity.set(capKey(month.id, rot.id), rot.capacity_per_month);
    }
  }

  // Required: residentId_rotationId -> remaining months needed (from resident's PGY)
  const required = new Map<string, number>();
  for (const r of residentsList) {
    for (const req of requirementsList) {
      if (req.pgy !== r.pgy) continue;
      const key = reqKey(r.id, req.rotation_id);
      required.set(key, req.min_months_required);
    }
  }

  // 4) Create schedule version (version_name is sortable so "latest" query can use it)
  const versionName = `Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
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

  // 5) Greedy assignment per month
  const assignmentRows: {
    schedule_version_id: string;
    resident_id: string;
    month_id: string;
    rotation_id: string | null;
  }[] = [];

  const rotationById = new Map<string, Rotation>();
  for (const rot of rotationsList) rotationById.set(rot.id, rot);

  for (let monthIndex = 0; monthIndex < monthsList.length; monthIndex++) {
    const month = monthsList[monthIndex];
    const shuffledResidents = shuffle(residentsList);

    const prevMonthAssignments = new Map<string, string>();
    if (monthIndex > 0) {
      const prevMonthId = monthsList[monthIndex - 1].id;
      for (const row of assignmentRows) {
        if (row.month_id === prevMonthId && row.rotation_id)
          prevMonthAssignments.set(row.resident_id, row.rotation_id);
      }
    }

    // When avoiding back-to-back consult/transplant, process residents who had it last month first
    // so they get first pick of non-consult/non-transplant slots.
    const avoidIds = new Set<string>();
    if (avoidBackToBackConsult && consultRotationIds.size > 0) {
      for (const id of consultRotationIds) avoidIds.add(id);
    }
    if (avoidBackToBackTransplant && transplantRotationIds.size > 0) {
      for (const id of transplantRotationIds) avoidIds.add(id);
    }
    const orderedResidents =
      avoidIds.size > 0
        ? [...shuffledResidents].sort((a, b) => {
            const aHad = avoidIds.has(prevMonthAssignments.get(a.id) ?? "");
            const bHad = avoidIds.has(prevMonthAssignments.get(b.id) ?? "");
            if (aHad && !bHad) return -1;
            if (!aHad && bHad) return 1;
            return 0;
          })
        : shuffledResidents;

    for (const resident of orderedResidents) {
      const ruleRotationId = fixedRuleMap.get(residentMonthKey(resident.id, month.id));
      const onVacation = vacationSet.has(residentMonthKey(resident.id, month.id));

      let chosenRotation: Rotation | null = null;

      // When preference is OFF: vacation months stay unassigned (current behavior).
      if (onVacation && !noConsultWhenVacationInMonth) {
        assignmentRows.push({
          schedule_version_id: scheduleVersionId,
          resident_id: resident.id,
          month_id: month.id,
          rotation_id: null,
        });
        continue;
      }

      if (ruleRotationId) {
        if (!onVacation) {
          const ruleRotation = rotationById.get(ruleRotationId);
          if (ruleRotation) {
            const rem = capacity.get(capKey(month.id, ruleRotation.id)) ?? 0;
            const isFirstMonthPgyMustBePrimary =
              monthIndex === 0 &&
              requirePgyStartAtPrimarySite &&
              resident.pgy === pgyStartAtPrimarySite &&
              primarySiteRotationIds.size > 0;
            const fixedIsPrimary = primarySiteRotationIds.has(ruleRotation.id);
            if (rem > 0 && (!isFirstMonthPgyMustBePrimary || fixedIsPrimary)) {
              chosenRotation = ruleRotation;
            }
          }
        }
        // When onVacation && noConsultWhenVacationInMonth: fall through to assign non-consult below.
      }

      if (!chosenRotation) {
        let eligible = rotationsList.filter((rot) => {
          if (resident.pgy < rot.eligible_pgy_min || resident.pgy > rot.eligible_pgy_max) return false;
          const rem = capacity.get(capKey(month.id, rot.id)) ?? 0;
          return rem > 0;
        });
        if (
          monthIndex === 0 &&
          requirePgyStartAtPrimarySite &&
          resident.pgy === pgyStartAtPrimarySite &&
          primarySiteRotationIds.size > 0 &&
          eligible.length > 0
        ) {
          const primaryOnly = eligible.filter((rot) => primarySiteRotationIds.has(rot.id));
          if (primaryOnly.length > 0) eligible = primaryOnly;
        }
        if (onVacation && noConsultWhenVacationInMonth && consultRotationIds.size > 0) {
          eligible = eligible.filter((rot) => !consultRotationIds.has(rot.id));
        }
        const hadConsultLastMonth =
          avoidBackToBackConsult &&
          (() => {
            const prevRotId = prevMonthAssignments.get(resident.id);
            return prevRotId != null && consultRotationIds.has(prevRotId);
          })();
        const hadTransplantLastMonth =
          avoidBackToBackTransplant &&
          (() => {
            const prevRotId = prevMonthAssignments.get(resident.id);
            return prevRotId != null && transplantRotationIds.has(prevRotId);
          })();
        let candidatePool = eligible;
        if (hadConsultLastMonth && eligible.length > 0) {
          const eligibleNonConsult = eligible.filter((rot) => !consultRotationIds.has(rot.id));
          if (eligibleNonConsult.length > 0) candidatePool = eligibleNonConsult;
        }
        if (hadTransplantLastMonth && candidatePool.length > 0) {
          const eligibleNonTransplant = candidatePool.filter((rot) => !transplantRotationIds.has(rot.id));
          if (eligibleNonTransplant.length > 0) candidatePool = eligibleNonTransplant;
        }
        if (
          !onVacation &&
          preferPrimarySiteForLongVacation &&
          residentsWithLongVacation.has(resident.id) &&
          primarySiteRotationIds.size > 0 &&
          candidatePool.length > 0
        ) {
          const primarySiteCandidates = candidatePool.filter((rot) => primarySiteRotationIds.has(rot.id));
          if (primarySiteCandidates.length > 0) {
            const requiredWithCapacityPrimary = primarySiteCandidates.filter((rot) => {
              const rem = required.get(reqKey(resident.id, rot.id)) ?? 0;
              return rem > 0;
            });
            if (requiredWithCapacityPrimary.length > 0) {
              candidatePool = requiredWithCapacityPrimary;
            } else {
              candidatePool = primarySiteCandidates;
            }
          }
        }
        const requiredWithCapacity = candidatePool.filter((rot) => {
          const rem = required.get(reqKey(resident.id, rot.id)) ?? 0;
          return rem > 0;
        });
        if (requiredWithCapacity.length > 0) {
          chosenRotation = requiredWithCapacity[Math.floor(Math.random() * requiredWithCapacity.length)];
        } else if (candidatePool.length > 0) {
          chosenRotation = candidatePool[Math.floor(Math.random() * candidatePool.length)];
        }
      }

      assignmentRows.push({
        schedule_version_id: scheduleVersionId,
        resident_id: resident.id,
        month_id: month.id,
        rotation_id: chosenRotation?.id ?? null,
      });

      if (chosenRotation) {
        const capKeyVal = capKey(month.id, chosenRotation.id);
        capacity.set(capKeyVal, (capacity.get(capKeyVal) ?? 0) - 1);
        const reqKeyVal = reqKey(resident.id, chosenRotation.id);
        const rem = required.get(reqKeyVal) ?? 0;
        if (rem > 0) required.set(reqKeyVal, rem - 1);
      }
    }
  }

  if (assignmentRows.length > 0) {
    const { error: assignErr } = await supabaseAdmin.from("assignments").insert(assignmentRows);
    if (assignErr) throw assignErr;
  }

  return { scheduleVersionId };
}
