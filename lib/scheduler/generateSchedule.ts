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
  is_back_to_back_consult_blocker?: boolean;
  is_transplant?: boolean;
  is_primary_site?: boolean;
};
type Requirement = { pgy: number; rotation_id: string; min_months_required: number };
type VacationRange = { resident_id: string; start_date: string; end_date: string };
type FixedRule = { resident_id: string; month_id: string; rotation_id: string };

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

type LoadedSchedulerStaticData = {
  monthsList: Month[];
  residentsList: Resident[];
  rotationsList: Rotation[];
  avoidBackToBackConsult: boolean;
  noConsultWhenVacationInMonth: boolean;
  avoidBackToBackTransplant: boolean;
  requirePgyStartAtPrimarySite: boolean;
  pgyStartAtPrimarySite: number;
  vacationRanges: VacationRange[];
  fixedRuleMap: Map<string, string>;
  requirementsList: Requirement[];
  residentReqByResident: Map<string, { rotation_id: string; min_months_required: number }[]>;
};

async function loadSchedulerStaticData({
  supabaseAdmin,
  academicYearId,
}: {
  supabaseAdmin: SupabaseClient;
  academicYearId: string;
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

  const { data: rotations, error: rotationsErr } = await supabaseAdmin
    .from("rotations")
    .select(
      "id, program_id, name, capacity_per_month, eligible_pgy_min, eligible_pgy_max, is_consult, is_back_to_back_consult_blocker, is_transplant, is_primary_site"
    )
    .eq("program_id", programId);
  if (rotationsErr) throw rotationsErr;
  const rotationsList = (rotations ?? []) as Rotation[];

  const { data: programRow } = await supabaseAdmin
    .from("programs")
    .select(
      "avoid_back_to_back_consult, no_consult_when_vacation_in_month, avoid_back_to_back_transplant, prefer_primary_site_for_long_vacation, require_pgy_start_at_primary_site, pgy_start_at_primary_site"
    )
    .eq("id", programId)
    .single();

  const program = programRow as
    | {
        avoid_back_to_back_consult?: boolean;
        no_consult_when_vacation_in_month?: boolean;
        avoid_back_to_back_transplant?: boolean;
        prefer_primary_site_for_long_vacation?: boolean;
        require_pgy_start_at_primary_site?: boolean;
        pgy_start_at_primary_site?: number | null;
      }
    | null;

  const avoidBackToBackConsult = program?.avoid_back_to_back_consult === true;
  const noConsultWhenVacationInMonth = program?.no_consult_when_vacation_in_month === true;
  const avoidBackToBackTransplant = program?.avoid_back_to_back_transplant === true;
  const requirePgyStartAtPrimarySite = program?.require_pgy_start_at_primary_site === true;
  const pgyStartAtPrimarySite =
    typeof program?.pgy_start_at_primary_site === "number" ? program.pgy_start_at_primary_site : 4;

  const { data: vacationRows } = await supabaseAdmin
    .from("vacation_requests")
    .select("resident_id, start_date, end_date")
    .lte("start_date", yearEnd)
    .gte("end_date", yearStart);
  const vacationRanges = (vacationRows ?? []) as VacationRange[];

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
    requirePgyStartAtPrimarySite,
    pgyStartAtPrimarySite,
    vacationRanges,
    fixedRuleMap,
    requirementsList,
    residentReqByResident,
  };
}

async function buildScheduleVariation({
  staticData,
  seed,
}: {
  staticData: LoadedSchedulerStaticData;
  seed: number;
}): Promise<{
  assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[];
  audit: ScheduleAudit;
}> {
  const rng = mulberry32(seed);

  const {
    monthsList,
    residentsList,
    rotationsList,
    avoidBackToBackConsult,
    noConsultWhenVacationInMonth,
    avoidBackToBackTransplant,
    requirePgyStartAtPrimarySite,
    pgyStartAtPrimarySite,
    vacationRanges,
    fixedRuleMap,
    requirementsList,
    residentReqByResident,
  } = staticData;

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
  // as the blocker set for back-to-back minimization/audit.
  const consultRotationIdsForBackToBack =
    backToBackBlockerRotationIds.size > 0 ? backToBackBlockerRotationIds : consultRotationIdsForVacation;

  const vacationSet = new Set<string>();
  for (const month of monthsList) {
    const mStart = month.start_date ?? "";
    const mEnd = month.end_date ?? "";
    if (!mStart || !mEnd) continue;
    for (const resident of residentsList) {
      const hasOverlap = vacationRanges.some(
        (v) => v.resident_id === resident.id && v.start_date <= mEnd && v.end_date >= mStart
      );
      if (hasOverlap) vacationSet.add(residentMonthKey(resident.id, month.id));
    }
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

  // 4) Build schedule assignments (in-memory only)
  const assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[] = [];

  const rotationById = new Map<string, Rotation>();
  for (const rot of rotationsList) rotationById.set(rot.id, rot);

  const scheduledSet = new Set<string>();

  const applyAssignment = (residentId: string, monthId: string, rotId: string | null) => {
    assignmentRows.push({
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
      if (onVac && consultRotationIdsForVacation.has(ruleRotId)) continue;
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
      for (const month of shuffle(monthsList, rng)) {
        let cap = capacity.get(capKey(month.id, rot.id)) ?? 0;
        if (cap <= 0) continue;
        const mi = monthsList.indexOf(month);

        const candidates = residentsList.filter((res) => {
          if (scheduledSet.has(residentMonthKey(res.id, month.id))) return false;
          if ((required.get(reqKey(res.id, rot.id)) ?? 0) <= 0) return false;
          if (res.pgy < rot.eligible_pgy_min || res.pgy > rot.eligible_pgy_max) return false;
          const onVac = vacationSet.has(residentMonthKey(res.id, month.id));
          if (onVac && noConsultWhenVacationInMonth && consultRotationIdsForVacation.has(rot.id)) return false;
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
          if (onVac && noConsultWhenVacationInMonth && consultRotationIdsForVacation.has(r.id)) return false;
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

  const runRepairPass = (rounds: number) => {
    for (let repairRound = 0; repairRound < rounds; repairRound++) {
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
              // Update capacity map to reflect both the removal and addition in the same month.
              const capRot = capKey(month.id, rot.id);
              // B: rot -> null (release one slot of rot at this month)
              capacity.set(capRot, (capacity.get(capRot) ?? 0) + 1);
              // A: null -> rot (consume one slot of rot at this month)
              capacity.set(capRot, (capacity.get(capRot) ?? 0) - 1);

              const rkA = reqKey(resA.id, rot.id);
              const remA = required.get(rkA) ?? 0;
              if (remA > 0) required.set(rkA, remA - 1);

              const rkB = reqKey(resB.id, rot.id);
              const remB = required.get(rkB) ?? 0;
              if (remB > 0) required.set(rkB, remB + 1);

              assignmentRows[idxA].rotation_id = rot.id;
              assignmentRows[idxB].rotation_id = null;
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

              // Swap within the same month: A(aRotId)->rot and B(rot)->aRotId.
              const capRot = capKey(month.id, rot.id);
              const capA = capKey(month.id, aRotId);

              // B: rot -> aRotId (release one rot slot, consume one aRotId slot)
              capacity.set(capRot, (capacity.get(capRot) ?? 0) + 1);
              capacity.set(capA, (capacity.get(capA) ?? 0) - 1);

              // A: aRotId -> rot (release one aRotId slot, consume one rot slot)
              capacity.set(capA, (capacity.get(capA) ?? 0) + 1);
              capacity.set(capRot, (capacity.get(capRot) ?? 0) - 1);

              // Update remaining requirements (only adjust if the rotation was still needed at this moment).
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

  // First repair attempt (soft rules ignored for hard requirements).
  runRepairPass(5);

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
    runRepairPass(5);
  }

  // Phase F: final hard-requirement closure (capacity-safe swaps)
  // If we still have a small number of unmet requirements, close them by:
  // - Directly placing needed rotations when the rotation has remaining capacity in the month, or
  // - When a rotation's capacity is full, swapping with another resident who is currently
  //   over-assigned for that needed rotation in the same month.
  //
  // Soft rules are ignored here so that hard requirements always take precedence.

  // Rebuild capacity from current `assignmentRows` to avoid any drift from prior repair phases.
  // `capacity` in this file represents remaining capacity per (month, rotation).
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

  const residentById = new Map<string, Resident>();
  for (const r of residentsList) residentById.set(r.id, r);

  const assignedCountForEnforce = new Map<string, number>();
  for (const row of assignmentRows) {
    if (!row.rotation_id) continue;
    const k = reqKey(row.resident_id, row.rotation_id);
    assignedCountForEnforce.set(k, (assignedCountForEnforce.get(k) ?? 0) + 1);
  }

  // Map monthId_rotationId -> indices of assignmentRows occupying that rotation.
  const monthRotationToIndices = new Map<string, number[]>();
  for (let idx = 0; idx < assignmentRows.length; idx++) {
    const row = assignmentRows[idx];
    if (!row.rotation_id) continue;
    const k = capKey(row.month_id, row.rotation_id);
    if (!monthRotationToIndices.has(k)) monthRotationToIndices.set(k, []);
    monthRotationToIndices.get(k)!.push(idx);
  }

  const splitReqKey = (k: string): { residentId: string; rotationId: string } => {
    const u = k.indexOf("_");
    if (u < 0) return { residentId: k, rotationId: "" };
    return { residentId: k.slice(0, u), rotationId: k.slice(u + 1) };
  };

  const enforceMaxIters = 20000;
  for (let iter = 0; iter < enforceMaxIters; iter++) {
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

      // Case 1: Direct placement if capacity remains.
      const canPlaceDirectly = (capacity.get(capKey(month.id, neededRot.id)) ?? 0) > 0;
      if (canPlaceDirectly) {
        if (currRotIdA) {
          // Free currRotIdA and consume neededRot.
          capacity.set(
            capKey(month.id, currRotIdA),
            (capacity.get(capKey(month.id, currRotIdA)) ?? 0) + 1
          );
          assignedCountForEnforce.set(
            reqKey(res.id, currRotIdA),
            (assignedCountForEnforce.get(reqKey(res.id, currRotIdA)) ?? 0) - 1
          );
        }

        capacity.set(capKey(month.id, neededRot.id), (capacity.get(capKey(month.id, neededRot.id)) ?? 0) - 1);
        assignmentRows[idxA].rotation_id = neededRot.id;
        assignedCountForEnforce.set(
          reqKey(res.id, neededRot.id),
          (assignedCountForEnforce.get(reqKey(res.id, neededRot.id)) ?? 0) + 1
        );
        applied = true;
        break;
      }

      // Case 2: Capacity is full -> swap within the same month with an over-assigned resident B.
      const candidatesB = monthRotationToIndices.get(capKey(month.id, neededRot.id)) ?? [];
      if (candidatesB.length === 0) continue;

      for (const idxB of candidatesB) {
        const rowB = assignmentRows[idxB];
        if (rowB.resident_id === res.id) continue;
        const bNeedKey = reqKey(rowB.resident_id, neededRot.id);

        // B will take A's current rotation (or become null).
        if (currRotIdA) {
          const bRes = residentById.get(rowB.resident_id);
          const currRotObj = rotationById.get(currRotIdA);
          if (!bRes || !currRotObj) continue;
          if (bRes.pgy < currRotObj.eligible_pgy_min || bRes.pgy > currRotObj.eligible_pgy_max) continue;
        }

        // Perform swap.
        assignmentRows[idxA].rotation_id = neededRot.id;
        assignmentRows[idxB].rotation_id = currRotIdA ?? null;

        // Update assigned counts.
        assignedCountForEnforce.set(deficitKey, (assignedCountForEnforce.get(deficitKey) ?? 0) + 1);

        if (currRotIdA) {
          const aOldKey = reqKey(res.id, currRotIdA);
          assignedCountForEnforce.set(aOldKey, (assignedCountForEnforce.get(aOldKey) ?? 0) - 1);

          const bNewKey = reqKey(rowB.resident_id, currRotIdA);
          assignedCountForEnforce.set(bNewKey, (assignedCountForEnforce.get(bNewKey) ?? 0) + 1);
        }

        // B loses one neededRot.
        assignedCountForEnforce.set(
          bNeedKey,
          (assignedCountForEnforce.get(bNeedKey) ?? 0) - 1
        );

        // Capacity remains satisfied because this is a within-month swap.
        applied = true;
        break;
      }

      if (applied) break;
    }

    if (!applied) continue;
  }

  // Phase D: score-based minimizer for the soft violations we report in the audit UI.
  // This tries to reduce the global soft violation count to <= 3 while preserving per-resident
  // rotation counts (by swapping two non-null rotation slots within the same resident).
  const getRotAt = (resId: string, mIdx: number): string | null => {
    if (mIdx < 0 || mIdx >= monthsList.length) return null;
    const idx = assignmentIndexMap.get(residentMonthKey(resId, monthsList[mIdx].id));
    return idx !== undefined ? assignmentRows[idx].rotation_id : null;
  };

  const pairViolationCount = (rotA: string | null, rotB: string | null): number => {
    if (!rotA || !rotB) return 0;
    let c = 0;
    if (
      avoidBackToBackConsult &&
      consultRotationIdsForBackToBack.has(rotA) &&
      consultRotationIdsForBackToBack.has(rotB)
    )
      c += 1;
    if (avoidBackToBackTransplant && transplantRotationIds.has(rotA) && transplantRotationIds.has(rotB)) c += 1;
    return c;
  };

  const pgyStartViolationCount = (resident: Resident): number => {
    if (!requirePgyStartAtPrimarySite) return 0;
    if (resident.pgy !== pgyStartAtPrimarySite) return 0;
    const firstRotId = getRotAt(resident.id, 0);
    if (!firstRotId) return 0;
    return primarySiteRotationIds.has(firstRotId) ? 0 : 1;
  };

  const residentPairScore = (resident: Resident): number => {
    let score = 0;
    for (let mi = 1; mi < monthsList.length; mi++) {
      score += pairViolationCount(getRotAt(resident.id, mi - 1), getRotAt(resident.id, mi));
    }
    return score;
  };

  const totalPairScore = (): number => residentsList.reduce((sum, r) => sum + residentPairScore(r), 0);

  // Strictly enforce back-to-back consult/transplant avoidance by driving pair score to 0.
  let pairScore = totalPairScore();
  const MAX_SOFT_ITERS = 3000;

  const rotAfterSwap = (resId: string, i: number, j: number, rotI: string, rotJ: string, idx: number): string | null => {
    if (idx === i) return rotJ;
    if (idx === j) return rotI;
    return getRotAt(resId, idx);
  };

  const deltaPairScoreForSwap = (resident: Resident, i: number, j: number): number => {
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

      delta += pairViolationCount(newPrev, newCurr) - pairViolationCount(oldPrev, oldCurr);
    }

    return delta;
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

    // Month i: rotI -> rotJ (release rotI, consume rotJ)
    capacity.set(capKey(monthsList[i].id, rotI), (capacity.get(capKey(monthsList[i].id, rotI)) ?? 0) + 1);
    capacity.set(capKey(monthsList[i].id, rotJ), (capacity.get(capKey(monthsList[i].id, rotJ)) ?? 0) - 1);

    // Month j: rotJ -> rotI (release rotJ, consume rotI)
    capacity.set(capKey(monthsList[j].id, rotJ), (capacity.get(capKey(monthsList[j].id, rotJ)) ?? 0) + 1);
    capacity.set(capKey(monthsList[j].id, rotI), (capacity.get(capKey(monthsList[j].id, rotI)) ?? 0) - 1);

    assignmentRows[idxI].rotation_id = rotJ;
    assignmentRows[idxJ].rotation_id = rotI;
    return true;
  };

  for (let iter = 0; iter < MAX_SOFT_ITERS && pairScore > 0; iter++) {
    // Global greedy search: find the best improving swap anywhere that
    // touches an existing violating adjacency (or the first month if PGY-start is violated).
    let bestDelta = 0;
    let bestSwap:
      | {
          resident: Resident;
          i: number;
          j: number;
        }
      | null = null;

    for (const resident of residentsList) {
      const baseIndices = new Set<number>();

      // PGY-start violations involve the first month.
      if (requirePgyStartAtPrimarySite && pgyStartViolationCount(resident) > 0) baseIndices.add(0);

      // Any violating adjacent pair contributes both indices to consider.
      for (let mi = 1; mi < monthsList.length; mi++) {
        const prev = getRotAt(resident.id, mi - 1);
        const curr = getRotAt(resident.id, mi);
        if (pairViolationCount(prev, curr) > 0) {
          baseIndices.add(mi - 1);
          baseIndices.add(mi);
        }
      }

      for (const i of baseIndices) {
        const rotI = getRotAt(resident.id, i);
        if (!rotI) continue;

        for (let j = 0; j < monthsList.length; j++) {
          if (j === i) continue;
          const rotJ = getRotAt(resident.id, j);
          if (!rotJ || rotJ === rotI) continue;

          // Hard constraint: capacity must allow the swapped rotations.
          if ((capacity.get(capKey(monthsList[j].id, rotI)) ?? 0) < 1) continue;
          if ((capacity.get(capKey(monthsList[i].id, rotJ)) ?? 0) < 1) continue;

          const delta = deltaPairScoreForSwap(resident, i, j);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestSwap = { resident, i, j };
          }
        }
      }
    }

    if (!bestSwap || bestDelta >= 0) break;

    const didApply = applySwap(bestSwap.resident, bestSwap.i, bestSwap.j);
    if (!didApply) break;
    pairScore += bestDelta;
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
            rule: `3-in-a-row consult: ${a} → ${b} → ${c}`,
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

  return { assignmentRows, audit };
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
    if (assignErr) throw assignErr;
  }

  return scheduleVersionId;
}

export async function generateSchedule({
  supabaseAdmin,
  academicYearId,
}: {
  supabaseAdmin: SupabaseClient;
  academicYearId: string;
}): Promise<{ scheduleVersionId: string; audit: ScheduleAudit }> {
  const maxAttempts = 60;
  const baseSeed = (hashStringToU32(academicYearId) ^ (Date.now() >>> 0)) >>> 0;

  let bestHard:
    | {
        assignmentRows: { resident_id: string; month_id: string; rotation_id: string | null }[];
        audit: ScheduleAudit;
        attempt: number;
        seed: number;
        consultBackToBackViolations: number;
        transplantBackToBackViolations: number;
      }
    | null = null;
  let bestSoft = Infinity;

  const isBetterFallback = (
    next: {
      consultBackToBackViolations: number;
      transplantBackToBackViolations: number;
      softCount: number;
    },
    prev: {
      consultBackToBackViolations: number;
      transplantBackToBackViolations: number;
      softCount: number;
    }
  ): boolean => {
    if (next.consultBackToBackViolations !== prev.consultBackToBackViolations) {
      return next.consultBackToBackViolations < prev.consultBackToBackViolations;
    }
    if (next.transplantBackToBackViolations !== prev.transplantBackToBackViolations) {
      return next.transplantBackToBackViolations < prev.transplantBackToBackViolations;
    }
    return next.softCount < prev.softCount;
  };

  const staticData = await loadSchedulerStaticData({ supabaseAdmin, academicYearId });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const seed = (baseSeed + attempt) >>> 0;
    const { assignmentRows, audit } = await buildScheduleVariation({ staticData, seed });

    const hardOk = audit.requirementViolations.length === 0;
    if (!hardOk) continue;

    // Unacceptable strict rule:
    // If a resident has 3+ consult rotations consecutively, reject the schedule variation.
    const tripleConsultViolations = audit.softRuleViolations.filter((v) =>
      v.rule.startsWith("3-in-a-row consult:")
    ).length;
    if (tripleConsultViolations > 0) continue;

    const consultBackToBackViolations = audit.softRuleViolations.filter((v) =>
      v.rule.startsWith("Back-to-back consult:")
    ).length;
    const transplantBackToBackViolations = audit.softRuleViolations.filter((v) =>
      v.rule.startsWith("Back-to-back transplant:")
    ).length;

    const strictPairOk = consultBackToBackViolations === 0 && transplantBackToBackViolations === 0;

    const softCount = audit.softRuleViolations.length;
    // Strict acceptance: strict back-to-back counts must be 0 AND total soft violations must be <= 5.
    if (strictPairOk && softCount <= 5) {
      const scheduleVersionId = await persistSchedule({
        supabaseAdmin,
        academicYearId,
        seed,
        attempt,
        assignmentRows,
      });
      return { scheduleVersionId, audit };
    }

    // Track the best hard-valid schedule (even if strict back-to-back is not 0).
    // We'll use this as the fallback if strict back-to-back constraints are infeasible.
    const nextFallback = {
      consultBackToBackViolations,
      transplantBackToBackViolations,
      softCount,
    };
    const prevFallback = bestHard
      ? {
          consultBackToBackViolations: bestHard.consultBackToBackViolations,
          transplantBackToBackViolations: bestHard.transplantBackToBackViolations,
          softCount: bestSoft,
        }
      : null;

    if (!prevFallback || isBetterFallback(nextFallback, prevFallback)) {
      bestSoft = softCount;
      bestHard = {
        assignmentRows,
        audit,
        attempt,
        seed,
        consultBackToBackViolations,
        transplantBackToBackViolations,
      };
    }
  }

  // Fallback: hard requirements are satisfiable, but strict back-to-back counts are not.
  if (bestHard) {
    const scheduleVersionId = await persistSchedule({
      supabaseAdmin,
      academicYearId,
      seed: bestHard.seed,
      attempt: bestHard.attempt,
      assignmentRows: bestHard.assignmentRows,
    });
    return { scheduleVersionId, audit: bestHard.audit };
  }

  throw new Error("SCHEDULE_CONSTRAINTS_UNSATISFIABLE");
}
