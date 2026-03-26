import { describe, expect, it } from "vitest";
import { buildCpSatJsonPayload } from "./buildCpSatPayload";
import { CP_OPTIMAL, invokeCpSatSolver } from "./cpSatInvoke";
import { normalizeSchedulerInput } from "./normalizeInput";
import { validateSchedule } from "./validateSchedule";
import { formatWitnessAuditReport, runWitnessHardConstraintAudit } from "./witnessConstraintAudit";
import {
  witnessHannahAssignmentRows,
  witnessProgramStaticData,
  WITNESS_ROTATION_IDS,
} from "./witnessProgram.fixture";

describe("witness program (human schedule vs hard model)", () => {
  it("audit prints PASS for all hard constraints including Oct Orange C1 -> Nov VA Con", () => {
    const data = witnessProgramStaticData();
    const rows = witnessHannahAssignmentRows();
    const { lines, allPassed } = runWitnessHardConstraintAudit(data, rows, { requirementsMode: "minimum" });
    expect(allPassed).toBe(true);
    expect(lines.some((l) => l === "PASS: strenuous_consult_b2b")).toBe(true);
    const report = formatWitnessAuditReport(data, rows, { requirementsMode: "minimum" });
    expect(report).toContain("OVERALL: PASS");
  });

  it("validateSchedule agrees (no hard violations)", () => {
    const data = witnessProgramStaticData();
    const rows = witnessHannahAssignmentRows();
    const v = validateSchedule(data, rows, { requirementsMode: "minimum" });
    expect(v.ok).toBe(true);
    expect(v.hardViolations).toHaveLength(0);
  });

  it("if both consult months are explicit blockers, strenuous B2B fails (regression guard)", () => {
    const data = witnessProgramStaticData();
    const rows = witnessHannahAssignmentRows();
    data.rotationsList = data.rotationsList.map((r) =>
      r.id === WITNESS_ROTATION_IDS.orangeC1 || r.id === WITNESS_ROTATION_IDS.vaCon
        ? { ...r, is_back_to_back_consult_blocker: true }
        : r
    );
    const { allPassed, lines } = runWitnessHardConstraintAudit(data, rows, { requirementsMode: "minimum" });
    expect(allPassed).toBe(false);
    expect(lines.some((l) => l === "FAIL: strenuous_consult_b2b")).toBe(true);
    expect(lines.some((l) => l.startsWith("Source File:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Source Function:"))).toBe(true);
  });

  it.skipIf(process.env.CI === "true" || process.env.SKIP_CP_SAT_TEST === "1")(
    "CP-SAT finds feasible assignment for same static config as witness",
    () => {
      const data = witnessProgramStaticData();
      const n = normalizeSchedulerInput(data);
      const payload = buildCpSatJsonPayload(n, { hardStrenuousB2b: true, hardTransplantB2b: true }) as Record<
        string,
        unknown
      >;
      const raw = invokeCpSatSolver(payload);
      expect(raw.ok).toBe(true);
      if (raw.ok) {
        expect(raw.status).toBe(CP_OPTIMAL);
      }
    }
  );
});
