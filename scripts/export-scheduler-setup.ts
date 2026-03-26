/**
 * Export current DB scheduler input to debug/current-scheduler-setup.json (same shape as solver).
 *
 *   SCHEDULER_ACADEMIC_YEAR_ID=<uuid> npm run export:scheduler-setup
 *
 * Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  loadSchedulerStaticData,
  schedulerStaticDataToSerializableJson,
} from "../lib/scheduler/generateSchedule";

config({ path: ".env.local" });
config();

const RELATIVE_OUT = path.join("debug", "current-scheduler-setup.json");

async function main() {
  const academicYearId = process.env.SCHEDULER_ACADEMIC_YEAR_ID?.trim();
  if (!academicYearId) {
    console.error("Set SCHEDULER_ACADEMIC_YEAR_ID to the academic year UUID.");
    process.exit(2);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local).");
    process.exit(2);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const data = await loadSchedulerStaticData({ supabaseAdmin: supabase, academicYearId });
  const json = schedulerStaticDataToSerializableJson(data);
  const outAbs = path.join(process.cwd(), RELATIVE_OUT);
  mkdirSync(path.dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  console.error(`Wrote ${outAbs}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
