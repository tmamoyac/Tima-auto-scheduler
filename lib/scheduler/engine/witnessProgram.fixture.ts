import type { LoadedSchedulerStaticData } from "../generateSchedule";

/**
 * Human witness program: July→June, eight rotations as named in setup UI.
 * Hannah has Orange C1 in October and VA Con in November — both `is_consult` for vacation,
 * neither `is_back_to_back_consult_blocker`. That pair must NOT trigger strenuous B2B.
 */
export const WITNESS_PROGRAM_ID = "witness_prog";
export const WITNESS_RESIDENT_HANNAH = "witness_res_hannah";

export const WITNESS_ROTATION_IDS = {
  orangeC1: "witness_rot_orange_c1",
  orangeC2: "witness_rot_orange_c2",
  irvineC: "witness_rot_irvine_c",
  uciDia: "witness_rot_uci_dia",
  trans: "witness_rot_trans",
  vaCon: "witness_rot_va_con",
  vaDial: "witness_rot_va_dial",
  vaElec: "witness_rot_va_elec",
} as const;

const ROT_IDS = WITNESS_ROTATION_IDS;

/** Academic months: ids m0…m11 chronological; `month_index` is 1=July … 12=June (DB style). */
export function witnessMonthsList(): LoadedSchedulerStaticData["monthsList"] {
  const starts = [
    "2024-07-01",
    "2024-08-01",
    "2024-09-01",
    "2024-10-01",
    "2024-11-01",
    "2024-12-01",
    "2025-01-01",
    "2025-02-01",
    "2025-03-01",
    "2025-04-01",
    "2025-05-01",
    "2025-06-01",
  ];
  return starts.map((start, i) => ({
    id: `witness_m_${i}`,
    academic_year_id: "witness_year",
    month_index: i + 1,
    start_date: start,
    end_date: start.replace(/-\d\d$/, "-28"),
  }));
}

function witnessRotationsList(): LoadedSchedulerStaticData["rotationsList"] {
  const base = {
    program_id: WITNESS_PROGRAM_ID,
    capacity_per_month: 4,
    eligible_pgy_min: 1,
    eligible_pgy_max: 4,
  };
  return [
    {
      id: ROT_IDS.orangeC1,
      name: "Orange C1",
      ...base,
      is_consult: true,
      is_back_to_back_consult_blocker: false,
      is_transplant: false,
    },
    {
      id: ROT_IDS.orangeC2,
      name: "Orange C2",
      ...base,
      is_consult: false,
      is_back_to_back_consult_blocker: false,
      is_transplant: false,
    },
    {
      id: ROT_IDS.irvineC,
      name: "Irvine C",
      ...base,
      is_consult: false,
      is_back_to_back_consult_blocker: false,
      is_transplant: false,
    },
    {
      id: ROT_IDS.uciDia,
      name: "UCI Dia",
      ...base,
      is_consult: false,
      is_back_to_back_consult_blocker: false,
      is_transplant: false,
    },
    {
      id: ROT_IDS.trans,
      name: "Trans",
      ...base,
      is_consult: false,
      is_back_to_back_consult_blocker: false,
      is_transplant: true,
    },
    {
      id: ROT_IDS.vaCon,
      name: "VA Con",
      ...base,
      is_consult: true,
      is_back_to_back_consult_blocker: false,
      is_transplant: false,
    },
    {
      id: ROT_IDS.vaDial,
      name: "VA Dial",
      ...base,
      is_consult: false,
      is_back_to_back_consult_blocker: false,
      is_transplant: false,
    },
    {
      id: ROT_IDS.vaElec,
      name: "VA Elec",
      ...base,
      is_consult: false,
      is_back_to_back_consult_blocker: false,
      is_transplant: false,
    },
  ];
}

export function witnessProgramStaticData(): LoadedSchedulerStaticData {
  return {
    monthsList: witnessMonthsList(),
    residentsList: [
      {
        id: WITNESS_RESIDENT_HANNAH,
        program_id: WITNESS_PROGRAM_ID,
        pgy: 1,
        is_active: true,
        first_name: "Hannah",
        last_name: "Witness",
      },
    ],
    rotationsList: witnessRotationsList(),
    avoidBackToBackConsult: true,
    noConsultWhenVacationInMonth: true,
    avoidBackToBackTransplant: true,
    preferPrimarySiteForLongVacation: false,
    requirePgyStartAtPrimarySite: false,
    pgyStartAtPrimarySite: 1,
    vacationRanges: [],
    academicYearStart: "2024-07-01",
    academicYearEnd: "2025-06-30",
    fixedRuleMap: new Map(),
    fixedRuleIdByKey: new Map(),
    requirementsList: [],
    residentReqByResident: new Map(),
  };
}

/** One row per resident × month; October = index 3, November = 4 */
export function witnessHannahAssignmentRows(): {
  resident_id: string;
  month_id: string;
  rotation_id: string | null;
}[] {
  const months = witnessMonthsList();
  const seq = [
    ROT_IDS.irvineC,
    ROT_IDS.orangeC2,
    ROT_IDS.uciDia,
    ROT_IDS.orangeC1,
    ROT_IDS.vaCon,
    ROT_IDS.vaDial,
    ROT_IDS.vaElec,
    ROT_IDS.trans,
    ROT_IDS.orangeC2,
    ROT_IDS.irvineC,
    ROT_IDS.uciDia,
    ROT_IDS.orangeC1,
  ];
  return months.map((m, i) => ({
    resident_id: WITNESS_RESIDENT_HANNAH,
    month_id: m.id,
    rotation_id: seq[i]!,
  }));
}
