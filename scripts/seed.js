// scripts/seed.js
// Seeds demo data into Supabase for the scheduler prototype.
// Requires: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local

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
  // day 0 of next month = last day of current month
  return new Date(Date.UTC(year, monthIndex1to12, 0));
}

async function main() {
  const url = mustGetEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  // 1) Create program
  const programName = "Demo Residency Program";
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
    const monthIndex = i + 1; // 1..12 relative order (not calendar month)
    // Map to calendar: July (7) to June (6)
    const calMonth = ((6 + i) % 12) + 1; // 7..12 then 1..6
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

  // 4) Create residents (18 total: 6 per PGY1-3)
  const residentsToInsert = [];
  const lastNames = ["Smith", "Lee", "Patel", "Nguyen", "Garcia", "Kim", "Brown", "Lopez", "Chen"];
  let idx = 0;
  for (let pgy = 1; pgy <= 3; pgy++) {
    for (let j = 0; j < 6; j++) {
      const last = lastNames[(idx + j) % lastNames.length];
      residentsToInsert.push({
        program_id: program.id,
        first_name: `Resident${pgy}${j + 1}`,
        last_name: last,
        pgy,
        is_active: true,
      });
      idx++;
    }
  }

  const { data: residents, error: residentsErr } = await supabase
    .from("residents")
    .insert(residentsToInsert)
    .select();

  if (residentsErr) throw residentsErr;

  // 5) Create rotations
  const rotationsToInsert = [
    { name: "Clinic", capacity_per_month: 4, eligible_pgy_min: 1, eligible_pgy_max: 3 },
    { name: "Wards", capacity_per_month: 6, eligible_pgy_min: 1, eligible_pgy_max: 3 },
    { name: "ICU", capacity_per_month: 3, eligible_pgy_min: 1, eligible_pgy_max: 3 },
    { name: "Night Float", capacity_per_month: 2, eligible_pgy_min: 1, eligible_pgy_max: 3 },
    { name: "Elective", capacity_per_month: 5, eligible_pgy_min: 2, eligible_pgy_max: 3 },
    { name: "ED", capacity_per_month: 3, eligible_pgy_min: 2, eligible_pgy_max: 3 },
  ].map((r) => ({ ...r, program_id: program.id }));

  const { data: rotations, error: rotationsErr } = await supabase
    .from("rotations")
    .insert(rotationsToInsert)
    .select();

  if (rotationsErr) throw rotationsErr;

  const byName = Object.fromEntries(rotations.map((r) => [r.name, r.id]));

  // 6) Requirements by PGY
  const req = [
    // PGY1
    { pgy: 1, rotation: "ICU", min: 2 },
    { pgy: 1, rotation: "Wards", min: 4 },
    { pgy: 1, rotation: "Clinic", min: 2 },
    { pgy: 1, rotation: "Night Float", min: 1 },
    // PGY2
    { pgy: 2, rotation: "ICU", min: 1 },
    { pgy: 2, rotation: "Wards", min: 3 },
    { pgy: 2, rotation: "Clinic", min: 2 },
    { pgy: 2, rotation: "Night Float", min: 1 },
    { pgy: 2, rotation: "ED", min: 1 },
    // PGY3
    { pgy: 3, rotation: "ICU", min: 1 },
    { pgy: 3, rotation: "Clinic", min: 3 },
    { pgy: 3, rotation: "Elective", min: 4 },
    { pgy: 3, rotation: "Night Float", min: 1 },
    { pgy: 3, rotation: "ED", min: 1 },
  ];

  const requirementsToInsert = req.map((x) => ({
    program_id: program.id,
    pgy: x.pgy,
    rotation_id: byName[x.rotation],
    min_months_required: x.min,
  }));

  const { error: reqErr } = await supabase.from("rotation_requirements").insert(requirementsToInsert);
  if (reqErr) throw reqErr;

  console.log("✅ Seed complete");
  console.log("Program:", program.id);
  console.log("Academic year:", academicYear.id);
  console.log("Residents:", residents.length);
  console.log("Rotations:", rotations.length);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
