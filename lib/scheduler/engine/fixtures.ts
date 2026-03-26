import type { LoadedSchedulerStaticData } from "../generateSchedule";

/** 1 resident, 2 months, 2 rotations — a trivial feasible grid exists (A then B). */
export function tinyFeasibleFixture(): LoadedSchedulerStaticData {
  return {
    monthsList: [
      {
        id: "m0",
        academic_year_id: "y1",
        month_index: 1,
        start_date: "2024-07-01",
        end_date: "2024-07-31",
      },
      {
        id: "m1",
        academic_year_id: "y1",
        month_index: 2,
        start_date: "2024-08-01",
        end_date: "2024-08-31",
      },
    ],
    residentsList: [
      {
        id: "res1",
        program_id: "p1",
        pgy: 1,
        is_active: true,
        first_name: "Tiny",
        last_name: "Test",
      },
    ],
    rotationsList: [
      {
        id: "rot_a",
        program_id: "p1",
        name: "A",
        capacity_per_month: 1,
        eligible_pgy_min: 1,
        eligible_pgy_max: 4,
        is_consult: false,
        is_transplant: false,
      },
      {
        id: "rot_b",
        program_id: "p1",
        name: "B",
        capacity_per_month: 1,
        eligible_pgy_min: 1,
        eligible_pgy_max: 4,
        is_consult: false,
        is_transplant: false,
      },
    ],
    avoidBackToBackConsult: false,
    noConsultWhenVacationInMonth: false,
    avoidBackToBackTransplant: false,
    preferPrimarySiteForLongVacation: false,
    requirePgyStartAtPrimarySite: false,
    pgyStartAtPrimarySite: 4,
    vacationRanges: [],
    academicYearStart: "2024-07-01",
    academicYearEnd: "2025-06-30",
    fixedRuleMap: new Map(),
    fixedRuleIdByKey: new Map(),
    requirementsList: [],
    residentReqByResident: new Map([
      [
        "res1",
        [
          { rotation_id: "rot_a", min_months_required: 1 },
          { rotation_id: "rot_b", min_months_required: 1 },
        ],
      ],
    ]),
  };
}

/** 2 residents × 3 months; capacities allow a feasible split if spaced. */
export function mediumFixture(): LoadedSchedulerStaticData {
  const months = [0, 1, 2].map((i) => ({
    id: `m${i}`,
    academic_year_id: "y1",
    month_index: i + 1,
    start_date: `2024-${String(7 + i).padStart(2, "0")}-01`,
    end_date: `2024-${String(7 + i).padStart(2, "0")}-28`,
  }));
  return {
    monthsList: months,
    residentsList: [
      {
        id: "r1",
        program_id: "p1",
        pgy: 1,
        is_active: true,
        first_name: "One",
        last_name: "Res",
      },
      {
        id: "r2",
        program_id: "p1",
        pgy: 1,
        is_active: true,
        first_name: "Two",
        last_name: "Res",
      },
    ],
    rotationsList: [
      {
        id: "x",
        program_id: "p1",
        name: "X",
        capacity_per_month: 2,
        eligible_pgy_min: 1,
        eligible_pgy_max: 4,
      },
      {
        id: "y",
        program_id: "p1",
        name: "Y",
        capacity_per_month: 2,
        eligible_pgy_min: 1,
        eligible_pgy_max: 4,
      },
    ],
    avoidBackToBackConsult: false,
    noConsultWhenVacationInMonth: false,
    avoidBackToBackTransplant: false,
    preferPrimarySiteForLongVacation: false,
    requirePgyStartAtPrimarySite: false,
    pgyStartAtPrimarySite: 4,
    vacationRanges: [],
    academicYearStart: "2024-07-01",
    academicYearEnd: "2025-06-30",
    fixedRuleMap: new Map(),
    fixedRuleIdByKey: new Map(),
    requirementsList: [],
    residentReqByResident: new Map([
      ["r1", [
        { rotation_id: "x", min_months_required: 2 },
        { rotation_id: "y", min_months_required: 1 },
      ]],
      ["r2", [
        { rotation_id: "x", min_months_required: 1 },
        { rotation_id: "y", min_months_required: 2 },
      ]],
    ]),
  };
}

/** Human-style grid for {@link tinyFeasibleFixture} (valid). */
export function tinyValidAssignmentRows() {
  return [
    { resident_id: "res1", month_id: "m0", rotation_id: "rot_a" },
    { resident_id: "res1", month_id: "m1", rotation_id: "rot_b" },
  ];
}

/** Same as valid but back-to-back same rotation if only one rot used — use to test spacing. */
export function tinyInvalidSameRotationRows() {
  return [
    { resident_id: "res1", month_id: "m0", rotation_id: "rot_a" },
    { resident_id: "res1", month_id: "m1", rotation_id: "rot_a" },
  ];
}
