/**
 * Validate a witness assignment grid against enforced hard rules (first failure only on error).
 *
 * Usage:
 *   npm run debug:witness-schedule
 *   SCHEDULER_STATIC_JSON=/path/to/export.json SCHEDULER_WITNESS_ASSIGNMENTS_JSON=/path/to/rows.json npm run debug:witness-schedule
 *
 * Without SCHEDULER_STATIC_JSON: uses lib witness program fixture static data.
 * Without SCHEDULER_WITNESS_ASSIGNMENTS_JSON: uses Hannah rows from witnessProgram.fixture.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { schedulerStaticDataFromSerializedJson, type LoadedSchedulerStaticData } from "../lib/scheduler/generateSchedule";
import { readRequirementsModeFromEnv } from "../lib/scheduler/engine/buildCpSatPayload";
import {
  witnessHannahAssignmentRows,
  witnessProgramStaticData,
} from "../lib/scheduler/engine/witnessProgram.fixture";
import { validateWitnessSchedule, type WitnessRow } from "../lib/scheduler/engine/witnessValidate";

function main() {
  const staticPath = process.env.SCHEDULER_STATIC_JSON?.trim();
  let staticData: LoadedSchedulerStaticData;
  if (staticPath) {
    const abs = path.isAbsolute(staticPath) ? staticPath : path.join(process.cwd(), staticPath);
    if (!existsSync(abs)) {
      console.error(`SCHEDULER_STATIC_JSON not found: ${abs}`);
      process.exit(2);
    }
    const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    staticData = schedulerStaticDataFromSerializedJson(raw);
    console.error(`Loaded static data from ${abs}`);
  } else {
    staticData = witnessProgramStaticData();
    console.error("No SCHEDULER_STATIC_JSON — using witnessProgram.fixture static data.");
  }

  const defaultWitnessFixture = path.join("lib", "scheduler", "engine", "witness-assignments.fixture.json");
  const witnessPath =
    process.env.SCHEDULER_WITNESS_ASSIGNMENTS_JSON?.trim() ||
    (existsSync(path.join(process.cwd(), defaultWitnessFixture)) ? defaultWitnessFixture : "");
  let rows: WitnessRow[];
  if (witnessPath) {
    const abs = path.isAbsolute(witnessPath) ? witnessPath : path.join(process.cwd(), witnessPath);
    if (!existsSync(abs)) {
      console.error(`Witness JSON not found: ${abs}`);
      process.exit(2);
    }
    rows = JSON.parse(readFileSync(abs, "utf8")) as WitnessRow[];
    console.error(`Loaded witness rows from ${abs}`);
  } else {
    rows = witnessHannahAssignmentRows();
    console.error("Using witnessHannahAssignmentRows() (no default JSON on disk).");
  }

  const r = validateWitnessSchedule(rows, staticData, {
    requirementsMode: readRequirementsModeFromEnv(),
    firstFailureOnly: true,
  });

  if (!r.allPassed) {
    console.log(r.firstFailureBlock ?? r.lines.join("\n"));
    process.exit(1);
  }

  console.log("PASS: all hard rules (witness validation)");
  process.exit(0);
}

main();
