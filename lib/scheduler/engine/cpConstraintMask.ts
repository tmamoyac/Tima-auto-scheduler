/**
 * CP-SAT constraint groups (must match scripts/solve_schedule_cp_sat.py).
 * Used for feasibility ladder and probes.
 */
export type CpConstraintMask = {
  capacity: boolean;
  required: boolean;
  b2b_same: boolean;
  b2b_strenuous: boolean;
  b2b_transplant: boolean;
  fixed_triples: boolean;
};

export const CP_MASK_ALL_TRUE: CpConstraintMask = {
  capacity: true,
  required: true,
  b2b_same: true,
  b2b_strenuous: true,
  b2b_transplant: true,
  fixed_triples: true,
};

/** Ladder stage names (1..9) — order matches user debugging flow. */
export const FEASIBILITY_LADDER_STAGE_NAMES: Record<number, string> = {
  1: "1_assignment_domains_unrestricted",
  2: "2_vacation_off_months_domains",
  3: "3_coverage_capacity",
  4: "4_pgy_domain_eligibility",
  5: "5_required_months",
  6: "6_same_rotation_b2b",
  7: "7_strenuous_b2b",
  8: "8_transplant_b2b",
  9: "9_fixed_rules_and_remaining",
};

/**
 * Domain layer for building allowed_values:
 * - 1: any rotation or null (0..K)
 * - 2: + vacation forced null when applicable
 * - 3: + PGY eligibility on domains
 * - 4: production — + fixed rules collapsed to singleton + fixed_triples emitted
 */
export type CpDomainLayer = 1 | 2 | 3 | 4;

export function maskForLadderStage(stage: number): CpConstraintMask {
  const s = Math.min(9, Math.max(1, Math.floor(stage)));
  const m: CpConstraintMask = {
    capacity: false,
    required: false,
    b2b_same: false,
    b2b_strenuous: false,
    b2b_transplant: false,
    fixed_triples: false,
  };
  if (s >= 3) m.capacity = true;
  if (s >= 5) m.required = true;
  if (s >= 6) m.b2b_same = true;
  if (s >= 7) m.b2b_strenuous = true;
  if (s >= 8) m.b2b_transplant = true;
  if (s >= 9) m.fixed_triples = true;
  return m;
}

export function domainLayerForLadderStage(stage: number): CpDomainLayer {
  const s = Math.min(9, Math.max(1, Math.floor(stage)));
  if (s <= 1) return 1;
  if (s === 2) return 2;
  if (s === 3) return 2;
  if (s <= 8) return 3;
  return 4;
}
