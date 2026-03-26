"""
Shared CP-SAT solve logic for CLI (`solve_schedule_cp_sat.py`) and Vercel Python handlers.

Input: scheduler JSON payload (same shape as stdin to the CLI).
Output: result dict (same shape as CLI stdout object), not yet JSON-serialized for callers that need bytes.
"""
from __future__ import annotations

import os
import sys
import time
from typing import Any

from ortools.sat.python import cp_model


def solve_cp_sat_from_dict(data: dict[str, Any]) -> dict[str, Any]:
    R = int(data["n_residents"])
    M = int(data["n_months"])
    K = int(data["n_rotations"])
    max_seconds = float(data.get("max_seconds", 90))
    debug_cp = os.environ.get("SCHEDULER_DEBUG_CP", "").strip().lower() in ("1", "true", "yes")

    allowed_values: list[list[list[int]]] = data["allowed_values"]
    fixed_triples: list[list[int]] = data.get("fixed", [])
    required_triples: list[list[int]] = data.get("required", [])
    capacity_grid: list[list[int]] = data["capacity"]

    req_mode = str(data.get("requirements_mode", "minimum")).strip().lower()
    use_minimum_req = req_mode != "exact"

    cm = data.get("constraint_mask")
    if isinstance(cm, dict):
        cap_on = bool(cm.get("capacity", True))
        req_on = bool(cm.get("required", True))
        fixed_on = bool(cm.get("fixed_triples", True))
        b2b_same_on = bool(cm.get("b2b_same", True))
        strenuous_on = bool(data.get("avoid_b2b_strenuous")) and bool(cm.get("b2b_strenuous", True))
        transplant_on = bool(data.get("avoid_b2b_transplant")) and bool(cm.get("b2b_transplant", True))
    else:
        cap_on = True
        req_on = True
        fixed_on = True
        b2b_same_on = bool(data.get("b2b_same", True))
        strenuous_on = bool(data.get("avoid_b2b_strenuous"))
        transplant_on = bool(data.get("avoid_b2b_transplant"))

    strenuous_indices = [int(x) for x in data.get("strenuous_indices", [])]
    transplant_indices = [int(x) for x in data.get("transplant_indices", [])]

    ladder_stage = data.get("ladder_stage", 9)

    if debug_cp:
        hf = data.get("hard_flags") or {}
        print(
            f"[cp_sat] stage={ladder_stage} R={R} M={M} K={K} max_s={max_seconds} "
            f"req_mode={req_mode} cap={cap_on} req={req_on} fixed={fixed_on} "
            f"b2b_same={b2b_same_on} str={strenuous_on} txp={transplant_on} hard_flags={hf}",
            file=sys.stderr,
            flush=True,
        )

    model = cp_model.CpModel()
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    for r in range(R):
        for m in range(M):
            x[(r, m)] = model.NewIntVar(0, K, f"x_{r}_{m}")

    for r in range(R):
        for m in range(M):
            dom = set(allowed_values[r][m])
            for v in range(0, K + 1):
                if v not in dom:
                    model.Add(x[(r, m)] != v)

    if fixed_on:
        for triple in fixed_triples:
            r, m, val = int(triple[0]), int(triple[1]), int(triple[2])
            model.Add(x[(r, m)] == val)

    if req_on:
        for triple in required_triples:
            r, j, cnt = int(triple[0]), int(triple[1]), int(triple[2])
            if cnt == 0:
                bools = []
                for m in range(M):
                    b = model.NewBoolVar(f"eq_r{r}_m{m}_j{j}")
                    model.Add(x[(r, m)] == j).OnlyEnforceIf(b)
                    model.Add(x[(r, m)] != j).OnlyEnforceIf(b.Not())
                    bools.append(b)
                model.Add(sum(bools) == 0)
                continue
            bools = []
            for m in range(M):
                b = model.NewBoolVar(f"eq_r{r}_m{m}_j{j}")
                model.Add(x[(r, m)] == j).OnlyEnforceIf(b)
                model.Add(x[(r, m)] != j).OnlyEnforceIf(b.Not())
                bools.append(b)
            if use_minimum_req:
                model.Add(sum(bools) >= cnt)
            else:
                model.Add(sum(bools) == cnt)

    if cap_on:
        for m in range(M):
            for j in range(1, K + 1):
                cap = int(capacity_grid[m][j - 1])
                bools = []
                for r in range(R):
                    b = model.NewBoolVar(f"cap_r{r}_m{m}_j{j}")
                    model.Add(x[(r, m)] == j).OnlyEnforceIf(b)
                    model.Add(x[(r, m)] != j).OnlyEnforceIf(b.Not())
                    bools.append(b)
                model.Add(sum(bools) <= cap)

    if b2b_same_on:
        for r in range(R):
            for m in range(M - 1):
                for j in range(1, K + 1):
                    model.AddForbiddenAssignments([x[(r, m)], x[(r, m + 1)]], [[j, j]])

    if strenuous_on and strenuous_indices:
        pairs = [[a, b] for a in strenuous_indices for b in strenuous_indices]
        for r in range(R):
            for m in range(M - 1):
                model.AddForbiddenAssignments([x[(r, m)], x[(r, m + 1)]], pairs)

    if transplant_on and transplant_indices:
        pairs = [[a, b] for a in transplant_indices for b in transplant_indices]
        for r in range(R):
            for m in range(M - 1):
                model.AddForbiddenAssignments([x[(r, m)], x[(r, m + 1)]], pairs)

    soft_vac = data.get("vacation_overlap_soft_triples") or []
    penalty_terms: list = []
    if isinstance(soft_vac, list):
        for item in soft_vac:
            if not isinstance(item, (list, tuple)) or len(item) < 3:
                continue
            r, m, j = int(item[0]), int(item[1]), int(item[2])
            if r < 0 or r >= R or m < 0 or m >= M or j < 1 or j > K:
                continue
            b = model.NewBoolVar(f"vac_overlap_soft_r{r}_m{m}_j{j}")
            model.Add(x[(r, m)] == j).OnlyEnforceIf(b)
            model.Add(x[(r, m)] != j).OnlyEnforceIf(b.Not())
            penalty_terms.append(b)
    if penalty_terms:
        model.Minimize(sum(penalty_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_seconds
    t0 = time.perf_counter()
    status = solver.Solve(model)
    wall_ms = int((time.perf_counter() - t0) * 1000)

    try:
        status_name = solver.StatusName(status)
    except Exception:
        status_name = str(status)

    if debug_cp:
        print(f"[cp_sat] status={status} ({status_name}) wall_ms={wall_ms}", file=sys.stderr, flush=True)

    out: dict[str, Any] = {
        "status": int(status),
        "wall_ms": wall_ms,
        "status_name": status_name,
        "ladder_stage": ladder_stage,
    }
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        grid: list[list[int]] = []
        for r in range(R):
            row = [int(solver.Value(x[(r, m)])) for m in range(M)]
            grid.append(row)
        out["grid"] = grid
    return out
