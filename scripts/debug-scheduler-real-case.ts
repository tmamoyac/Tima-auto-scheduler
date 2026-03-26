/**
 * Run feasibility ladder on REAL exported setup JSON and print first failing stage + bottleneck report.
 *
 *   SCHEDULER_STATIC_JSON=/path/to/export.json npm run debug:scheduler-real-case
 *
 * Export format matches run-feasibility-ladder.ts (fixedRuleMap / residentReqByResident as entry arrays).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { schedulerStaticDataFromSerializedJson } from "../lib/scheduler/generateSchedule";
import {
  formatExecutiveBottleneckTop3,
  formatFirstFailingStageBottleneck,
} from "../lib/scheduler/engine/feasibilityBottleneckReport";
import {
  formatFeasibilityLadderReport,
  runFeasibilityLadder,
} from "../lib/scheduler/engine/feasibilityLadder";
import { normalizeSchedulerInput } from "../lib/scheduler/engine/normalizeInput";

const DEFAULT_SETUP = path.join("debug", "current-scheduler-setup.json");

function main() {
  const envPath = process.env.SCHEDULER_STATIC_JSON?.trim();
  const defaultAbs = path.join(process.cwd(), DEFAULT_SETUP);
  const p =
    envPath ||
    (existsSync(defaultAbs) ? DEFAULT_SETUP : "");
  if (!p) {
    console.error(
      "No setup JSON: set SCHEDULER_STATIC_JSON or run Export from /admin/scheduler (writes debug/current-scheduler-setup.json), or: SCHEDULER_ACADEMIC_YEAR_ID=… npm run export:scheduler-setup"
    );
    process.exit(2);
  }
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  const staticData = schedulerStaticDataFromSerializedJson(raw);
  console.error(`Loaded ${abs}`);

  const n = normalizeSchedulerInput(staticData);
  const ladder = runFeasibilityLadder(staticData);

  console.log(formatFeasibilityLadderReport(ladder));
  if (ladder.firstFailingStage != null) {
    console.log("");
    console.log(formatFirstFailingStageBottleneck(n, ladder.firstFailingStage));
    console.log("");
    console.log("=== EXECUTIVE SUMMARY (top 3) ===");
    console.log(formatExecutiveBottleneckTop3(n, ladder.firstFailingStage));
    process.exit(1);
  }
  process.exit(0);
}

main();
