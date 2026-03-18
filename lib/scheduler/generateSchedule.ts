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

  const residentIds = residentsList.map((r) => r.id);
  const { data: residentReqRows } =
    residentIds.length > 0
      ? await supabaseAdmin
          .from("resident_rotation_requirements")
          .select("resident_id, rotation_id, min_months_required")
          .in("resident_id", residentIds)
      : { data: [] as { resident_id: string; rotation_id: string; min_months_required: number }[] };

  const residentReqByResident = new Map<string, { rotation_id: string; min_months_required: number }[]>();
  for (const row of residentReqRows ?? []) {
    const rid = (row as { resident_id: string }).resident_id;
    if (!residentReqByResident.has(rid)) residentReqByResident.set(rid, []);
    residentReqByResident.get(rid)!.push(row as { rotation_id: string; min_months_required: number });
  }

  // 3) Build capacity: for each (month, rotation) -> capacity_per_month
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

  /** Max/total remaining required months for a resident (updated as schedule is built). */
  function residentRequirementUrgency(residentId: string): { maxSingle: number; total: number } {
    let maxSingle = 0;
    let total = 0;
    for (const rot of rotationsList) {
      const v = required.get(reqKey(residentId, rot.id)) ?? 0;
      if (v > 0) {
        total += v;
        maxSingle = Math.max(maxSingle, v);
      }
    }
    return { maxSingle, total };
  }

  for (let monthIndex = 0; monthIndex < monthsList.length; monthIndex++) {
    const month = monthsList[monthIndex];
    const monthId = month.id;

    const residentHasNonConsultNeedWithCapacity = (res: Resident): boolean => {
      for (const r of rotationsList) {
        if (consultRotationIds.has(r.id)) continue;
        if (res.pgy < r.eligible_pgy_min || res.pgy > r.eligible_pgy_max) continue;
        if ((required.get(reqKey(res.id, r.id)) ?? 0) <= 0) continue;
        if ((capacity.get(capKey(monthId, r.id)) ?? 0) <= 0) continue;
        return true;
      }
      return false;
    };

    const residentHasNonTransplantNeedWithCapacity = (res: Resident): boolean => {
      for (const r of rotationsList) {
        if (transplantRotationIds.has(r.id)) continue;
        if (res.pgy < r.eligible_pgy_min || res.pgy > r.eligible_pgy_max) continue;
        if ((required.get(reqKey(res.id, r.id)) ?? 0) <= 0) continue;
        if ((capacity.get(capKey(monthId, r.id)) ?? 0) <= 0) continue;
        return true;
      }
      return false;
    };
    const shuffledResidents = shuffle(residentsList);

    const prevMonthAssignments = new Map<string, string>();
    if (monthIndex > 0) {
      const prevMonthId = monthsList[monthIndex - 1].id;
      for (const row of assignmentRows) {
        if (row.month_id === prevMonthId && row.rotation_id)
          prevMonthAssignments.set(row.resident_id, row.rotation_id);
      }
    }

    const avoidIds = new Set<string>();
    if (avoidBackToBackConsult && consultRotationIds.size > 0) {
      for (const id of consultRotationIds) avoidIds.add(id);
    }
    if (avoidBackToBackTransplant && transplantRotationIds.size > 0) {
      for (const id of transplantRotationIds) avoidIds.add(id);
    }
    const orderedResidents = [...shuffledResidents].sort((a, b) => {
      if (avoidIds.size > 0) {
        const aHad = avoidIds.has(prevMonthAssignments.get(a.id) ?? "");
        const bHad = avoidIds.has(prevMonthAssignments.get(b.id) ?? "");
        if (aHad && !bHad) return -1;
        if (!aHad && bHad) return 1;
      }
      const ua = residentRequirementUrgency(a.id);
      const ub = residentRequirementUrgency(b.id);
      if (ub.maxSingle !== ua.maxSingle) return ub.maxSingle - ua.maxSingle;
      if (ub.total !== ua.total) return ub.total - ua.total;
      return a.id.localeCompare(b.id);
    });

    const scheduledThisMonth = new Set<string>();

    const applyAssignment = (residentId: string, rot: Rotation) => {
      const capKeyVal = capKey(month.id, rot.id);
      capacity.set(capKeyVal, (capacity.get(capKeyVal) ?? 0) - 1);
      const reqKeyVal = reqKey(residentId, rot.id);
      const rem = required.get(reqKeyVal) ?? 0;
      if (rem > 0) required.set(reqKeyVal, rem - 1);
      scheduledThisMonth.add(residentId);
      assignmentRows.push({
        schedule_version_id: scheduleVersionId,
        resident_id: residentId,
        month_id: month.id,
        rotation_id: rot.id,
      });
    };

    for (const resident of residentsList) {
      const onVacation = vacationSet.has(residentMonthKey(resident.id, month.id));
      if (onVacation && !noConsultWhenVacationInMonth) {
        assignmentRows.push({
          schedule_version_id: scheduleVersionId,
          resident_id: resident.id,
          month_id: month.id,
          rotation_id: null,
        });
        scheduledThisMonth.add(resident.id);
      }
    }

    for (const resident of residentsList) {
      if (scheduledThisMonth.has(resident.id)) continue;
      const ruleRotationId = fixedRuleMap.get(residentMonthKey(resident.id, month.id));
      const onVacation = vacationSet.has(residentMonthKey(resident.id, month.id));
      if (ruleRotationId && !onVacation) {
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
            applyAssignment(resident.id, ruleRotation);
          }
        }
      }
    }

    const rotationPressure = (rot: Rotation) => {
      let s = 0;
      for (const res of residentsList) {
        if (scheduledThisMonth.has(res.id)) continue;
        s += required.get(reqKey(res.id, rot.id)) ?? 0;
      }
      return s;
    };
    const rotOrder = shuffle([...rotationsList]).sort((a, b) => rotationPressure(b) - rotationPressure(a));

    for (const rot of rotOrder) {
      let capLeft = capacity.get(capKey(month.id, rot.id)) ?? 0;
      if (capLeft <= 0) continue;

      const candidates: Resident[] = [];
      for (const res of residentsList) {
        if (scheduledThisMonth.has(res.id)) continue;
        const onVacation = vacationSet.has(residentMonthKey(res.id, month.id));
        if ((required.get(reqKey(res.id, rot.id)) ?? 0) <= 0) continue;
        if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) continue;
        if (
          monthIndex === 0 &&
          requirePgyStartAtPrimarySite &&
          res.pgy === pgyStartAtPrimarySite &&
          primarySiteRotationIds.size > 0 &&
          !primarySiteRotationIds.has(rot.id)
        ) {
          continue;
        }
        if (onVacation && noConsultWhenVacationInMonth && consultRotationIds.has(rot.id)) continue;
        const prevRotId = prevMonthAssignments.get(res.id);
        const hadConsultLastMonth =
          avoidBackToBackConsult && prevRotId != null && consultRotationIds.has(prevRotId);
        if (hadConsultLastMonth && consultRotationIds.has(rot.id) && residentHasNonConsultNeedWithCapacity(res)) {
          continue;
        }
        const hadTransplantLastMonth =
          avoidBackToBackTransplant && prevRotId != null && transplantRotationIds.has(prevRotId);
        if (
          hadTransplantLastMonth &&
          transplantRotationIds.has(rot.id) &&
          residentHasNonTransplantNeedWithCapacity(res)
        ) {
          continue;
        }
        candidates.push(res);
      }

      const byNeed = new Map<number, Resident[]>();
      for (const res of candidates) {
        const n = required.get(reqKey(res.id, rot.id)) ?? 0;
        if (!byNeed.has(n)) byNeed.set(n, []);
        byNeed.get(n)!.push(res);
      }
      const tiers = [...byNeed.keys()].sort((a, b) => b - a);
      for (const n of tiers) {
        const group = shuffle(byNeed.get(n)!);
        for (const res of group) {
          if (capLeft <= 0) break;
          if (scheduledThisMonth.has(res.id)) continue;
          const ck = capKey(month.id, rot.id);
          if ((capacity.get(ck) ?? 0) <= 0) break;
          applyAssignment(res.id, rot);
          capLeft = (capacity.get(ck) ?? 0);
        }
      }
    }

    for (const resident of orderedResidents) {
      if (scheduledThisMonth.has(resident.id)) continue;

      const ruleRotationId = fixedRuleMap.get(residentMonthKey(resident.id, month.id));
      const onVacation = vacationSet.has(residentMonthKey(resident.id, month.id));

      let chosenRotation: Rotation | null = null;

      if (ruleRotationId && onVacation && noConsultWhenVacationInMonth) {
        const ruleRotation = rotationById.get(ruleRotationId);
        if (ruleRotation && (capacity.get(capKey(month.id, ruleRotation.id)) ?? 0) > 0) {
          chosenRotation = ruleRotation;
        }
      }

      if (!chosenRotation) {
        let remainingTotal = 0;
        for (const r of rotationsList) {
          remainingTotal += required.get(reqKey(resident.id, r.id)) ?? 0;
        }
        const hadExplicitTargets = (initialReqTotalByResident.get(resident.id) ?? 0) > 0;
        if (remainingTotal === 0 && hadExplicitTargets) {
          // extra months unassigned
        } else {
          let eligible = rotationsList.filter((r) => {
            if (resident.pgy < r.eligible_pgy_min || resident.pgy > r.eligible_pgy_max) return false;
            return (capacity.get(capKey(month.id, r.id)) ?? 0) > 0;
          });
          if (
            monthIndex === 0 &&
            requirePgyStartAtPrimarySite &&
            resident.pgy === pgyStartAtPrimarySite &&
            primarySiteRotationIds.size > 0 &&
            eligible.length > 0
          ) {
            const primaryOnly = eligible.filter((r) => primarySiteRotationIds.has(r.id));
            if (primaryOnly.length > 0) eligible = primaryOnly;
          }
          if (onVacation && noConsultWhenVacationInMonth && consultRotationIds.size > 0) {
            eligible = eligible.filter((r) => !consultRotationIds.has(r.id));
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
          const requiredFromEligible = eligible.filter((r) => {
            return (required.get(reqKey(resident.id, r.id)) ?? 0) > 0;
          });

          if (requiredFromEligible.length > 0) {
            let pool = requiredFromEligible;
            if (hadConsultLastMonth) {
              const alt = pool.filter((r) => !consultRotationIds.has(r.id));
              if (alt.length > 0) pool = alt;
            }
            if (hadTransplantLastMonth) {
              const alt = pool.filter((r) => !transplantRotationIds.has(r.id));
              if (alt.length > 0) pool = alt;
            }
            if (
              !onVacation &&
              preferPrimarySiteForLongVacation &&
              residentsWithLongVacation.has(resident.id) &&
              primarySiteRotationIds.size > 0
            ) {
              const alt = pool.filter((r) => primarySiteRotationIds.has(r.id));
              if (alt.length > 0) pool = alt;
            }
            let maxReq = 0;
            for (const r of pool) {
              maxReq = Math.max(maxReq, required.get(reqKey(resident.id, r.id)) ?? 0);
            }
            const tied = pool.filter(
              (r) => (required.get(reqKey(resident.id, r.id)) ?? 0) === maxReq
            );
            chosenRotation = tied[Math.floor(Math.random() * tied.length)];
          } else if (eligible.length > 0) {
            let candidatePool = eligible;
            if (hadConsultLastMonth) {
              const alt = candidatePool.filter((r) => !consultRotationIds.has(r.id));
              if (alt.length > 0) candidatePool = alt;
            }
            if (hadTransplantLastMonth) {
              const alt = candidatePool.filter((r) => !transplantRotationIds.has(r.id));
              if (alt.length > 0) candidatePool = alt;
            }
            const notOverfilled = candidatePool.filter((r) => {
              const init = initialRequired.get(reqKey(resident.id, r.id));
              const rem = required.get(reqKey(resident.id, r.id)) ?? 0;
              return init === undefined || rem > 0;
            });
            if (notOverfilled.length > 0) {
              chosenRotation = notOverfilled[Math.floor(Math.random() * notOverfilled.length)];
            }
          }
        }
      }

      assignmentRows.push({
        schedule_version_id: scheduleVersionId,
        resident_id: resident.id,
        month_id: month.id,
        rotation_id: chosenRotation?.id ?? null,
      });
      scheduledThisMonth.add(resident.id);

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
