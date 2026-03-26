/**
 * Run the 9-stage CP-SAT feasibility ladder (cumulative constraints).
 *
 * Usage:
 *   npm run debug:scheduler-ladder
 *   SCHEDULER_STATIC_JSON=/path/to/export.json npm run debug:scheduler-ladder
 *
 * Export format: JSON matching LoadedSchedulerStaticData with:
 *   fixedRuleMap: [[key, value], ...]
 *   residentReqByResident: [[residentId, [{rotation_id, min_months_required}, ...]], ...]
 *   requirementsList: array (PGY matrix)
 */
import { readFileSync, existsSync } from "fs";
import path from "node:path";
import {
  schedulerStaticDataFromSerializedJson,
  type LoadedSchedulerStaticData,
} from "../lib/scheduler/generateSchedule";
import { tinyFeasibleFixture } from "../lib/scheduler/engine/fixtures";
import { formatFeasibilityLadderReport, runFeasibilityLadder } from "../lib/scheduler/engine/feasibilityLadder";
import { formatDetailedValidationReport, validateHumanScheduleDetailed } from "../lib/scheduler/engine/validateScheduleDetailed";

function main() {
  const defaultSetup = path.join("debug", "current-scheduler-setup.json");
  const envPath = process.env.SCHEDULER_STATIC_JSON?.trim();
  const pathJson =
    envPath ||
    (existsSync(path.join(process.cwd(), defaultSetup)) ? defaultSetup : "");
  let data: LoadedSchedulerStaticData;
  if (pathJson && existsSync(path.isAbsolute(pathJson) ? pathJson : path.join(process.cwd(), pathJson))) {
    const abs = path.isAbsolute(pathJson) ? pathJson : path.join(process.cwd(), pathJson);
    const raw = JSON.parse(readFileSync(abs, "utf-8")) as Record<string, unknown>;
    data = schedulerStaticDataFromSerializedJson(raw);
    console.info(`Loaded static data from ${abs}`);
  } else {
    if (pathJson) {
      console.warn(`SCHEDULER_STATIC_JSON not found (${pathJson}); using tiny fixture.`);
    } else {
      console.info(
        "No setup JSON (SCHEDULER_STATIC_JSON or debug/current-scheduler-setup.json) — using tiny fixture."
      );
    }
    data = tinyFeasibleFixture();
  }

  const humanGrid = process.env.SCHEDULER_HUMAN_ASSIGNMENT_JSON?.trim();
  if (humanGrid && existsSync(humanGrid)) {
    const rows = JSON.parse(readFileSync(humanGrid, "utf-8")) as {
      resident_id: string;
      month_id: string;
      rotation_id: string | null;
    }[];
    console.info(`\n${formatDetailedValidationReport(validateHumanScheduleDetailed(data, rows))}\n`);
  }

  const ladder = runFeasibilityLadder(data);
  console.info(formatFeasibilityLadderReport(ladder));
  if (ladder.firstFailingStage != null) {
    process.exitCode = 2;
  }
}

main();
