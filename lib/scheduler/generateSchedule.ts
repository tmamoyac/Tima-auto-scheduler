import type { SupabaseClient } from "@supabase/supabase-js";

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

export type ScheduleAudit = {
  requirementViolations: {
    residentName: string;
    rotationName: string;
    required: number;
    assigned: number;
  }[];
  softRuleViolations: {
    residentName: string;
    monthLabel: string;
    rule: string;
  }[];
};

export async function generateSchedule({
  supabaseAdmin,
  academicYearId,
}: {
  supabaseAdmin: SupabaseClient;
  academicYearId: string;
}): Promise<{ scheduleVersionId: string; audit: ScheduleAudit }> {
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
    .select("id, program_id, pgy, is_active, first_name, last_name")
    .eq("program_id", programId)
    .eq("is_active", true);

  if (residentsErr) throw residentsErr;
  const residentsList = (residents ?? []) as Resident[];

  const { data: rotations, error: rotationsErr } = await supabaseAdmin
    .from("rotations")
    .select("id, program_id, name, capacity_per_month, eligible_pgy_min, eligible_pgy_max, is_consult, is_transplant, is_primary_site")
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

  // 4) Create schedule version
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

  // 5) Build schedule assignments
  const assignmentRows: {
    schedule_version_id: string;
    resident_id: string;
    month_id: string;
    rotation_id: string | null;
  }[] = [];

  const rotationById = new Map<string, Rotation>();
  for (const rot of rotationsList) rotationById.set(rot.id, rot);

  const scheduledSet = new Set<string>();

  const applyAssignment = (residentId: string, monthId: string, rotId: string | null) => {
    assignmentRows.push({
      schedule_version_id: scheduleVersionId,
      resident_id: residentId,
      month_id: monthId,
      rotation_id: rotId,
    });
    scheduledSet.add(residentMonthKey(residentId, monthId));
    if (rotId) {
      const ck = capKey(monthId, rotId);
      capacity.set(ck, (capacity.get(ck) ?? 0) - 1);
      const rk = reqKey(residentId, rotId);
      const rem = required.get(rk) ?? 0;
      if (rem > 0) required.set(rk, rem - 1);
    }
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
      if (onVac && consultRotationIds.has(ruleRotId)) continue;
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
      applyAssignment(resident.id, month.id, ruleRot.id);
    }
  }

  // --- Phase 3: Global rotation-first assignment ---
  // Process rotations by scarcity (demand / supply), most constrained first.
  // For each rotation, distribute all required slots across ALL months at once,
  // preventing the suboptimal month-by-month allocation that was causing
  // under-assignment of tightly-constrained rotations like UCI Orange.
  for (let round = 0; round < 3; round++) {
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
      for (const month of shuffle(monthsList)) {
        let cap = capacity.get(capKey(month.id, rot.id)) ?? 0;
        if (cap <= 0) continue;
        const mi = monthsList.indexOf(month);

        const candidates = residentsList.filter((res) => {
          if (scheduledSet.has(residentMonthKey(res.id, month.id))) return false;
          if ((required.get(reqKey(res.id, rot.id)) ?? 0) <= 0) return false;
          if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) return false;
          const onVac = vacationSet.has(residentMonthKey(res.id, month.id));
          if (onVac && noConsultWhenVacationInMonth && consultRotationIds.has(rot.id)) return false;
          if (
            mi === 0 &&
            requirePgyStartAtPrimarySite &&
            res.pgy === pgyStartAtPrimarySite &&
            primarySiteRotationIds.size > 0 &&
            !primarySiteRotationIds.has(rot.id)
          ) return false;
          return true;
        });

        candidates.sort((a, b) => {
          const na = required.get(reqKey(a.id, rot.id)) ?? 0;
          const nb = required.get(reqKey(b.id, rot.id)) ?? 0;
          if (nb !== na) return nb - na;
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

  // --- Phase 4: Fill remaining unscheduled slots ---
  for (const month of monthsList) {
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

      const onVac = vacationSet.has(residentMonthKey(resident.id, month.id));
      const eligible = rotationsList
        .filter((r) => {
          if (resident.pgy < r.eligible_pgy_min || resident.pgy > r.eligible_pgy_max) return false;
          if ((capacity.get(capKey(month.id, r.id)) ?? 0) <= 0) return false;
          if (onVac && noConsultWhenVacationInMonth && consultRotationIds.has(r.id)) return false;
          return (required.get(reqKey(resident.id, r.id)) ?? 0) > 0;
        })
        .sort((a, b) => {
          const ra = required.get(reqKey(resident.id, a.id)) ?? 0;
          const rb = required.get(reqKey(resident.id, b.id)) ?? 0;
          return rb - ra;
        });

      if (eligible.length > 0) {
        applyAssignment(resident.id, month.id, eligible[0].id);
      } else {
        applyAssignment(resident.id, month.id, null);
      }
    }
  }

  // ---- REPAIR PASS: fill unmet requirements ----
  const assignmentIndexMap = new Map<string, number>();
  for (let i = 0; i < assignmentRows.length; i++) {
    assignmentIndexMap.set(
      residentMonthKey(assignmentRows[i].resident_id, assignmentRows[i].month_id),
      i
    );
  }

  for (let repairRound = 0; repairRound < 5; repairRound++) {
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

          const onVac = vacationSet.has(residentMonthKey(resident.id, month.id));
          if (onVac && noConsultWhenVacationInMonth && consultRotationIds.has(rot.id)) continue;

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

          const onVac = vacationSet.has(residentMonthKey(resident.id, month.id));
          if (onVac && noConsultWhenVacationInMonth && consultRotationIds.has(rot.id)) continue;

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

          const onVacM = vacationSet.has(residentMonthKey(resident.id, monthM.id));
          if (onVacM && noConsultWhenVacationInMonth && consultRotationIds.has(neededRot.id)) continue;

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

            const onVacMp = vacationSet.has(residentMonthKey(resident.id, monthMp.id));
            if (onVacMp && noConsultWhenVacationInMonth && consultRotationIds.has(currentRotId)) continue;

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
            improved = true;
            break;
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

          const onVacA = vacationSet.has(residentMonthKey(resA.id, month.id));
          if (onVacA && noConsultWhenVacationInMonth && consultRotationIds.has(rot.id)) continue;

          // If capacity exists and A is unassigned, assign directly (Phase A catch-up)
          if ((capacity.get(capKey(month.id, rot.id)) ?? 0) > 0 && aRotId === null) {
            assignmentRows[idxA].rotation_id = rot.id;
            capacity.set(capKey(month.id, rot.id), (capacity.get(capKey(month.id, rot.id)) ?? 0) - 1);
            required.set(reqKey(resA.id, rot.id), (required.get(reqKey(resA.id, rot.id)) ?? 0) - 1);
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
              // A unassigned, B has excess: A takes rot, B gets null
              assignmentRows[idxA].rotation_id = rot.id;
              assignmentRows[idxB].rotation_id = null;
              required.set(reqKey(resA.id, rot.id), (required.get(reqKey(resA.id, rot.id)) ?? 0) - 1);
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
              const onVacB = vacationSet.has(residentMonthKey(resB.id, month.id));
              if (onVacB && noConsultWhenVacationInMonth && consultRotationIds.has(aRotId)) continue;

              assignmentRows[idxA].rotation_id = rot.id;
              assignmentRows[idxB].rotation_id = aRotId;
              required.set(reqKey(resA.id, rot.id), (required.get(reqKey(resA.id, rot.id)) ?? 0) - 1);
              improved = true;
              break;
            }
          }
        }
      }
    }

    if (!improved) break;
  }

  // Phase D: reduce back-to-back violations by swapping within a resident's schedule
  const isViolatingType = (rotId: string): boolean =>
    (avoidBackToBackConsult && consultRotationIds.has(rotId)) ||
    (avoidBackToBackTransplant && transplantRotationIds.has(rotId));

  const pairViolates = (rotA: string | null, rotB: string | null): boolean => {
    if (!rotA || !rotB) return false;
    if (avoidBackToBackConsult && consultRotationIds.has(rotA) && consultRotationIds.has(rotB)) return true;
    if (avoidBackToBackTransplant && transplantRotationIds.has(rotA) && transplantRotationIds.has(rotB)) return true;
    return false;
  };

  const getRotAt = (resId: string, mIdx: number): string | null => {
    if (mIdx < 0 || mIdx >= monthsList.length) return null;
    const idx = assignmentIndexMap.get(residentMonthKey(resId, monthsList[mIdx].id));
    return idx !== undefined ? assignmentRows[idx].rotation_id : null;
  };

  for (let pass = 0; pass < 3; pass++) {
    let swapped = false;
    for (const resident of residentsList) {
      for (let mi = 1; mi < monthsList.length; mi++) {
        const prevRotId = getRotAt(resident.id, mi - 1);
        const currRotId = getRotAt(resident.id, mi);
        if (!pairViolates(prevRotId, currRotId)) continue;

        const currMonth = monthsList[mi];
        const currIdx = assignmentIndexMap.get(residentMonthKey(resident.id, currMonth.id))!;

        for (let mj = 0; mj < monthsList.length; mj++) {
          if (mj === mi || mj === mi - 1) continue;
          const swapMonth = monthsList[mj];
          const swapIdx = assignmentIndexMap.get(residentMonthKey(resident.id, swapMonth.id));
          if (swapIdx === undefined) continue;
          const swapRotId = assignmentRows[swapIdx].rotation_id;
          if (!swapRotId || swapRotId === currRotId) continue;
          if (isViolatingType(swapRotId)) continue;

          if (pairViolates(getRotAt(resident.id, mj - 1), currRotId)) continue;
          if (pairViolates(currRotId, getRotAt(resident.id, mj + 1))) continue;
          if (pairViolates(getRotAt(resident.id, mi - 1), swapRotId)) continue;
          if (pairViolates(swapRotId, getRotAt(resident.id, mi + 1))) continue;

          if ((capacity.get(capKey(swapMonth.id, currRotId!)) ?? 0) < 1) continue;
          if ((capacity.get(capKey(currMonth.id, swapRotId)) ?? 0) < 1) continue;

          const onVacCurr = vacationSet.has(residentMonthKey(resident.id, currMonth.id));
          const onVacSwap = vacationSet.has(residentMonthKey(resident.id, swapMonth.id));
          if (onVacCurr && noConsultWhenVacationInMonth && consultRotationIds.has(swapRotId)) continue;
          if (onVacSwap && noConsultWhenVacationInMonth && consultRotationIds.has(currRotId!)) continue;

          assignmentRows[currIdx].rotation_id = swapRotId;
          assignmentRows[swapIdx].rotation_id = currRotId;
          capacity.set(capKey(currMonth.id, currRotId!), (capacity.get(capKey(currMonth.id, currRotId!)) ?? 0) + 1);
          capacity.set(capKey(currMonth.id, swapRotId), (capacity.get(capKey(currMonth.id, swapRotId)) ?? 0) - 1);
          capacity.set(capKey(swapMonth.id, swapRotId), (capacity.get(capKey(swapMonth.id, swapRotId)) ?? 0) + 1);
          capacity.set(capKey(swapMonth.id, currRotId!), (capacity.get(capKey(swapMonth.id, currRotId!)) ?? 0) - 1);
          swapped = true;
          break;
        }
      }
    }
    if (!swapped) break;
  }

  if (assignmentRows.length > 0) {
    const { error: assignErr } = await supabaseAdmin.from("assignments").insert(assignmentRows);
    if (assignErr) throw assignErr;
  }

  // Post-generation audit
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
      monthIdToLabel.set(m.id, `Month ${m.month_index + 1}`);
    }
  }

  const assignmentLookup = new Map<string, string | null>();
  for (const row of assignmentRows) {
    assignmentLookup.set(residentMonthKey(row.resident_id, row.month_id), row.rotation_id);
  }

  for (const res of residentsList) {
    for (let mi = 1; mi < monthsList.length; mi++) {
      const prevMId = monthsList[mi - 1].id;
      const currMId = monthsList[mi].id;
      const prevRotId = assignmentLookup.get(residentMonthKey(res.id, prevMId));
      const currRotId = assignmentLookup.get(residentMonthKey(res.id, currMId));
      if (!prevRotId || !currRotId) continue;
      const resName = `${res.first_name ?? ""} ${res.last_name ?? ""}`.trim();
      if (avoidBackToBackConsult && consultRotationIds.has(prevRotId) && consultRotationIds.has(currRotId)) {
        const prevName = rotationById.get(prevRotId)?.name ?? "Consult";
        const currName = rotationById.get(currRotId)?.name ?? "Consult";
        audit.softRuleViolations.push({
          residentName: resName,
          monthLabel: monthIdToLabel.get(currMId) ?? "",
          rule: `Back-to-back consult: ${prevName} → ${currName}`,
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

  return { scheduleVersionId, audit };
}
