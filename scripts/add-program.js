// scripts/add-program.js
// Adds a new program with academic year and 12 months. No residents, rotations, or requirements.
// Usage: node scripts/add-program.js "Program Name"
// Requires: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local

require("dotenv").config({ path: ".env.local" });
const { createClient } = require("@supabase/supabase-js");

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}. Check .env.local`);
  return v;
}

function monthLabel(year, monthIndex1to12) {
  const d = new Date(Date.UTC(year, monthIndex1to12 - 1, 1));
  return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function firstDayUTC(year, monthIndex1to12) {
  return new Date(Date.UTC(year, monthIndex1to12 - 1, 1));
}

function lastDayUTC(year, monthIndex1to12) {
  return new Date(Date.UTC(year, monthIndex1to12, 0));
}

async function main() {
  const programName = process.argv[2]?.trim();
  if (!programName) {
    console.error("Usage: node scripts/add-program.js \"Program Name\"");
    process.exit(1);
  }

  const url = mustGetEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  // 1) Create program
  const { data: programRows, error: programErr } = await supabase
    .from("programs")
    .insert({ name: programName })
    .select()
    .limit(1);

  if (programErr) throw programErr;
  const program = programRows[0];

  // 2) Create academic year (July -> June)
  const startYear = new Date().getUTCFullYear();
  const startDate = `${startYear}-07-01`;
  const endDate = `${startYear + 1}-06-30`;
  const label = `${startYear}-${startYear + 1}`;

  const { data: yearRows, error: yearErr } = await supabase
    .from("academic_years")
    .insert({
      program_id: program.id,
      label,
      start_date: startDate,
      end_date: endDate,
    })
    .select()
    .limit(1);

  if (yearErr) throw yearErr;
  const academicYear = yearRows[0];

  // 3) Create 12 months starting July
  const monthsToInsert = [];
  for (let i = 0; i < 12; i++) {
    const monthIndex = i + 1;
    const calMonth = ((6 + i) % 12) + 1;
    const calYear = calMonth >= 7 ? startYear : startYear + 1;

    const start = firstDayUTC(calYear, calMonth);
    const end = lastDayUTC(calYear, calMonth);

    monthsToInsert.push({
      academic_year_id: academicYear.id,
      month_index: monthIndex,
      month_label: monthLabel(calYear, calMonth),
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
    });
  }

  const { error: monthsErr } = await supabase.from("months").insert(monthsToInsert);
  if (monthsErr) throw monthsErr;

  console.log("✅ Program created:", programName);
  console.log("   Program ID:", program.id);
  console.log("   Academic year:", academicYear.id, `(${label})`);
  console.log("   Add residents and rotations in the Scheduler Setup tab.");
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
