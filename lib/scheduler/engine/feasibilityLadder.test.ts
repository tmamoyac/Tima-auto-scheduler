import { describe, expect, it } from "vitest";
import { buildCpSatJsonPayload } from "./buildCpSatPayload";
import { tinyFeasibleFixture } from "./fixtures";
import { formatFeasibilityLadderReport, runFeasibilityLadder } from "./feasibilityLadder";
import { normalizeSchedulerInput } from "./normalizeInput";

describe("feasibility ladder", () => {
  it.skipIf(process.env.CI === "true" || process.env.SKIP_CP_SAT_TEST === "1")(
    "tiny fixture: all cumulative stages feasible",
    () => {
      const data = tinyFeasibleFixture();
      const r = runFeasibilityLadder(data);
      expect(r.firstFailingStage).toBeNull();
      expect(r.steps.length).toBe(9);
      const report = formatFeasibilityLadderReport(r);
      expect(report).toContain("FIRST_FAILING_STAGE=none");
    }
  );

  it("normalized tiny: stage 1 payload has unrestricted domains", () => {
    const n = normalizeSchedulerInput(tinyFeasibleFixture());
    const p = buildCpSatJsonPayload(n, { hardStrenuousB2b: true, hardTransplantB2b: true }, { ladderStage: 1 });
    const av = p.allowed_values as number[][][];
    expect(av[0][0].length).toBeGreaterThan(2);
  });
});
