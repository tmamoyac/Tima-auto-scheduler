#!/usr/bin/env python3
"""
Read JSON problem from stdin, run Google OR-Tools CP-SAT, write JSON to stdout.

Variable x[r,m] in {0..K}: 0 = null (vacation / off), 1..K = rotation index (1-based).

Constraint groups are toggled via `constraint_mask` for feasibility ladder debugging.
`requirements_mode`: "minimum" uses sum(assignments to j) >= cnt for cnt>0 (matches min_months_required);
  "exact" uses sum == cnt (legacy).
"""
from __future__ import annotations

import json
import sys

from cp_sat_solve_core import solve_cp_sat_from_dict


def main() -> None:
    data = json.load(sys.stdin)
    out = solve_cp_sat_from_dict(data)
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
