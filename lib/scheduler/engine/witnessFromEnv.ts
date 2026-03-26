/**
 * When SCHEDULER_WITNESS_ASSIGNMENTS_JSON points at a JSON array of assignment rows,
 * validate against the same hard rules as CP-SAT and return the first failure block for UNSAT UX.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { LoadedSchedulerStaticData } from "../generateSchedule";
import { readRequirementsModeFromEnv } from "./buildCpSatPayload";
import { validateWitnessSchedule, type WitnessRow } from "./witnessValidate";

export function computeWitnessFirstFailureIfConfigured(staticData: LoadedSchedulerStaticData): string | null {
  const p = process.env.SCHEDULER_WITNESS_ASSIGNMENTS_JSON?.trim();
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  let rows: unknown;
  try {
    rows = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const witnessRows = rows as WitnessRow[];
  const r = validateWitnessSchedule(witnessRows, staticData, {
    requirementsMode: readRequirementsModeFromEnv(),
    firstFailureOnly: true,
  });
  if (r.allPassed) return null;
  return r.firstFailureBlock ?? r.lines.join("\n");
}
