import { mediumFixture, tinyFeasibleFixture, tinyInvalidSameRotationRows, tinyValidAssignmentRows } from "./fixtures";
import { explainInfeasibility } from "./explainInfeasibility";
import { formatValidationReport, validateSchedule } from "./validateSchedule";

export type DebugFixtureName = "tiny_valid" | "tiny_invalid_spacing" | "medium_structure";

/**
 * Run without the solver — validates known grids against engine rules.
 * Use from tests or: `npx vitest run lib/scheduler/engine/runDebugFixture`
 */
export function runDebugFixture(name: DebugFixtureName): string {
  if (name === "tiny_valid") {
    const data = tinyFeasibleFixture();
    const v = validateSchedule(data, tinyValidAssignmentRows());
    return [`=== ${name} ===`, formatValidationReport(v), explainInfeasibility(v)].join("\n");
  }
  if (name === "tiny_invalid_spacing") {
    const data = tinyFeasibleFixture();
    const v = validateSchedule(data, tinyInvalidSameRotationRows());
    return [`=== ${name} ===`, formatValidationReport(v), explainInfeasibility(v)].join("\n");
  }
  if (name === "medium_structure") {
    const data = mediumFixture();
    const lines = [`=== ${name} ===`, `residents=${data.residentsList.length} months=${data.monthsList.length}`];
    const v = validateSchedule(data, []);
    lines.push(formatValidationReport(v));
    return lines.join("\n");
  }
  return "unknown fixture";
}
