import { describe, expect, it } from "vitest";
import { mediumFixture, tinyFeasibleFixture, tinyInvalidSameRotationRows, tinyValidAssignmentRows } from "./fixtures";
import { runDebugFixture } from "./runDebugFixture";
import { solveScheduleFeasibilityCpSat } from "./solveFeasibility";
import { explainInfeasibility } from "./explainInfeasibility";
import {
  formatDetailedValidationReport,
  formatFirstFailingRuleHumanReadable,
  validateHumanScheduleDetailed,
} from "./validateScheduleDetailed";
import { validateSchedule } from "./validateSchedule";

describe("validateSchedule", () => {
  it("tiny fixture: human-style grid passes all hard rules", () => {
    const v = validateSchedule(tinyFeasibleFixture(), tinyValidAssignmentRows());
    expect(v.ok).toBe(true);
    expect(v.hardViolations).toHaveLength(0);
  });

  it("tiny fixture: same rotation B2B is hard-failed with explicit code (exact req mode)", () => {
    const v = validateSchedule(tinyFeasibleFixture(), tinyInvalidSameRotationRows(), {
      requirementsMode: "exact",
    });
    expect(v.ok).toBe(false);
    const codes = v.hardViolations.map((h) => h.code);
    expect(codes).toContain("SAME_ROTATION_B2B");
    expect(codes).toContain("REQ_COUNT_MISMATCH");
    expect(explainInfeasibility(v)).toContain("SAME_ROTATION_B2B");
  });

  it("minimum req mode: missing rotation months fail REQ_BELOW_MINIMUM", () => {
    const v = validateSchedule(tinyFeasibleFixture(), tinyInvalidSameRotationRows(), {
      requirementsMode: "minimum",
    });
    expect(v.ok).toBe(false);
    expect(v.hardViolations.some((h) => h.code === "REQ_BELOW_MINIMUM")).toBe(true);
  });

  it("medium fixture: empty grid fails completeness", () => {
    const v = validateSchedule(mediumFixture(), []);
    expect(v.ok).toBe(false);
    expect(v.hardViolations.some((x) => x.code === "MISSING_CELL")).toBe(true);
  });
});

describe("validateHumanScheduleDetailed", () => {
  it("tiny valid grid: all checks PASS", () => {
    const r = validateHumanScheduleDetailed(tinyFeasibleFixture(), tinyValidAssignmentRows());
    expect(r.allPassed).toBe(true);
    expect(r.checks.every((c) => c.passed)).toBe(true);
    const text = formatDetailedValidationReport(r);
    expect(text).toContain("[PASS] completeness");
    expect(text).toContain("OVERALL: PASS");
  });

  it("first failing rule is human-readable (completeness)", () => {
    const data = mediumFixture();
    const r = validateHumanScheduleDetailed(data, []);
    expect(r.allPassed).toBe(false);
    const human = formatFirstFailingRuleHumanReadable(r, data);
    expect(human).toContain("FAIL: one_assignment_per_resident_per_month");
    expect(human).toMatch(/Resident:/);
    expect(human).toMatch(/Month:/);
    expect(human).toMatch(/Reason:/);
  });

  it("formatDetailedValidationReport can lead with human-readable first failure", () => {
    const data = mediumFixture();
    const r = validateHumanScheduleDetailed(data, []);
    const text = formatDetailedValidationReport(r, undefined, {
      leadWithFirstHumanFailure: true,
      normalized: data,
    });
    expect(text).toContain("FIRST FAILING RULE (human-readable)");
    expect(text).toContain("FAIL: one_assignment_per_resident_per_month");
  });
});

describe("runDebugFixture", () => {
  it("prints structured reports", () => {
    expect(runDebugFixture("tiny_valid")).toContain("valid=true");
    expect(runDebugFixture("tiny_invalid_spacing")).toContain("valid=false");
    expect(runDebugFixture("medium_structure")).toContain("MISSING_CELL");
  });
});

describe("CP-SAT integration", () => {
  it.skipIf(process.env.CI === "true" || process.env.SKIP_CP_SAT_TEST === "1")(
    "solves tiny feasible fixture (set SKIP_CP_SAT_TEST=1 or CI=true to skip)",
    async () => {
      const { result, debug } = await solveScheduleFeasibilityCpSat(tinyFeasibleFixture());
      expect(debug.lines.some((l) => l.includes("status="))).toBe(true);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const v = validateSchedule(tinyFeasibleFixture(), result.assignmentRows);
        expect(v.ok).toBe(true);
      }
    }
  );
});
