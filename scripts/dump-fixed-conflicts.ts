/**
 * Fixed-rule feasibility probes (stage 9): per-pin SAT, minimal infeasible core, stage-8 witness audit.
 * Does not treat “differs from one stage-8 witness” as bad data.
 *
 *   npm run debug:fixed-conflicts
 *   SCHEDULER_STATIC_JSON=/path/to.json npm run debug:fixed-conflicts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { academicMonthLabelFromIndex } from "../lib/scheduler/engine/validateScheduleDetailed";
import { probeFixedRulesFeasibility } from "../lib/scheduler/engine/fixedRulesFeasibilityProbe";
import { schedulerStaticDataFromSerializedJson } from "../lib/scheduler/generateSchedule";

const DEFAULT = path.join("debug", "current-scheduler-setup.json");

function main() {
  const envPath = process.env.SCHEDULER_STATIC_JSON?.trim();
  const rel = envPath || (existsSync(path.join(process.cwd(), DEFAULT)) ? DEFAULT : "");
  if (!rel) {
    console.error("No JSON: set SCHEDULER_STATIC_JSON or place debug/current-scheduler-setup.json");
    process.exit(2);
  }
  const abs = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
  if (!existsSync(abs)) {
    console.error(`Not found: ${abs}`);
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  const staticData = schedulerStaticDataFromSerializedJson(raw);
  const monthById = new Map(staticData.monthsList.map((m) => [m.id, m]));
  const rotById = new Map(staticData.rotationsList.map((r) => [r.id, r]));
  const resById = new Map(staticData.residentsList.map((r) => [r.id, r]));

  const report = probeFixedRulesFeasibility(raw);

  const enrichedRows = report.rows.map((row) => {
    const m = monthById.get(row.monthId);
    const rot = rotById.get(row.rotationId);
    const res = resById.get(row.residentId);
    const name = res ? [res.first_name, res.last_name].filter(Boolean).join(" ") : "";
    return {
      ...row,
      resident_name: name || row.residentId,
      month_index: m?.month_index ?? -1,
      month_label: m ? academicMonthLabelFromIndex(m.month_index) : "",
      rotation_name: rot?.name ?? "",
    };
  });

  const enrichedCore = report.minimalInfeasibleCore.map(([key, rotationId]) => {
    const i = key.indexOf("_");
    const residentId = i > 0 ? key.slice(0, i) : "";
    const monthId = i > 0 ? key.slice(i + 1) : "";
    const m = monthById.get(monthId);
    const res = resById.get(residentId);
    const rot = rotById.get(rotationId);
    return {
      key,
      resident_id: residentId,
      resident_name: res ? [res.first_name, res.last_name].filter(Boolean).join(" ") : residentId,
      month_id: monthId,
      month_index: m?.month_index ?? -1,
      month_label: m ? academicMonthLabelFromIndex(m.month_index) : "",
      rotation_id: rotationId,
      rotation_name: rot?.name ?? "",
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    sourceJson: abs,
    fullFixedSetStage9Feasible: report.fullFixedSetStage9Feasible,
    individuallyFeasibleKeys: report.individuallyFeasibleKeys,
    minimalInfeasibleCore: enrichedCore,
    contradictionSummary: report.contradictionSummary,
    stage8WitnessAssignmentAudits: report.stage8WitnessAssignmentAudits,
    stage8SolverMisleadingNullNote: report.stage8SolverMisleadingNullNote,
    rows: enrichedRows,
  };

  const outPath = path.join(process.cwd(), "debug", "fixed-conflict-report.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

  console.log(`Wrote ${outPath}`);
  console.log(
    `Stage-9 with all fixed: ${report.fullFixedSetStage9Feasible ? "FEASIBLE" : "INFEASIBLE"} · pins=${report.allPairs.length} · individually SAT=${report.individuallyFeasibleKeys.length} · minimal core size=${report.minimalInfeasibleCore.length}`
  );
}

main();
