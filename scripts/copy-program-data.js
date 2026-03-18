// scripts/copy-program-data.js
// Copies all setup/scheduler data from one program (e.g. Demo Residency Program) into another (e.g. UCI Nephrology Fellowship).
// Usage: node scripts/copy-program-data.js "Demo Residency Program" "UCI Nephrology Fellowship"
// Requires: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local

require("dotenv").config({ path: ".env.local" });
const { createClient } = require("@supabase/supabase-js");

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}. Check .env.local`);
  return v;
}

async function main() {
  const sourceName = process.argv[2]?.trim() || "Demo Residency Program";
  const targetName = process.argv[3]?.trim() || "UCI Nephrology Fellowship";

  const url = mustGetEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: sourcePrograms, error: spErr } = await supabase
    .from("programs")
    .select("id, name, avoid_back_to_back_consult, no_consult_when_vacation_in_month, avoid_back_to_back_transplant, prefer_primary_site_for_long_vacation, require_pgy_start_at_primary_site, pgy_start_at_primary_site")
    .ilike("name", sourceName)
    .limit(1);
  if (spErr) throw spErr;
  const sourceProgram = sourcePrograms?.[0];
  if (!sourceProgram) {
    throw new Error(`Source program not found: "${sourceName}". Check the name.`);
  }

  const { data: targetPrograms, error: tpErr } = await supabase
    .from("programs")
    .select("id, name")
    .ilike("name", targetName)
    .limit(1);
  if (tpErr) throw tpErr;
  const targetProgram = targetPrograms?.[0];
  if (!targetProgram) {
    throw new Error(`Target program not found: "${targetName}". Create it first (e.g. via add-program.js).`);
  }

  const sourceId = sourceProgram.id;
  const targetId = targetProgram.id;
  console.log("Copying from:", sourceProgram.name, "→", targetProgram.name);

  // 0) Clear existing target data (so copy replaces, not appends)
  const { data: targetYears } = await supabase
    .from("academic_years")
    .select("id")
    .eq("program_id", targetId);
  const targetYearIds = (targetYears || []).map((y) => y.id);
  const { data: targetResidents } = await supabase
    .from("residents")
    .select("id")
    .eq("program_id", targetId);
  const targetResidentIds = (targetResidents || []).map((r) => r.id);

  if (targetYearIds.length > 0) {
    const { data: versions } = await supabase
      .from("schedule_versions")
      .select("id")
      .in("academic_year_id", targetYearIds);
    const versionIds = (versions || []).map((v) => v.id);
    if (versionIds.length > 0) {
      await supabase.from("assignments").delete().in("schedule_version_id", versionIds);
    }
    await supabase.from("schedule_versions").delete().in("academic_year_id", targetYearIds);
    await supabase.from("fixed_assignment_rules").delete().in("academic_year_id", targetYearIds);
    await supabase.from("months").delete().in("academic_year_id", targetYearIds);
  }
  await supabase.from("academic_years").delete().eq("program_id", targetId);

  if (targetResidentIds.length > 0) {
    await supabase.from("resident_rotation_requirements").delete().in("resident_id", targetResidentIds);
    await supabase.from("vacation_requests").delete().in("resident_id", targetResidentIds);
  }
  await supabase.from("rotation_requirements").delete().eq("program_id", targetId);
  await supabase.from("residents").delete().eq("program_id", targetId);
  await supabase.from("rotations").delete().eq("program_id", targetId);
  console.log("  ✓ Cleared existing target data");

  // 1) Copy program settings (scheduling rules)
  const { error: progUpd } = await supabase
    .from("programs")
    .update({
      avoid_back_to_back_consult: sourceProgram.avoid_back_to_back_consult ?? false,
      no_consult_when_vacation_in_month: sourceProgram.no_consult_when_vacation_in_month ?? false,
      avoid_back_to_back_transplant: sourceProgram.avoid_back_to_back_transplant ?? false,
      prefer_primary_site_for_long_vacation: sourceProgram.prefer_primary_site_for_long_vacation ?? false,
      require_pgy_start_at_primary_site: sourceProgram.require_pgy_start_at_primary_site ?? false,
      pgy_start_at_primary_site: sourceProgram.pgy_start_at_primary_site ?? 4,
    })
    .eq("id", targetId);
  if (progUpd) throw progUpd;
  console.log("  ✓ Program settings");

  // 2) Academic years
  const { data: sourceYears, error: ayErr } = await supabase
    .from("academic_years")
    .select("id, label, start_date, end_date")
    .eq("program_id", sourceId)
    .order("start_date", { ascending: true });
  if (ayErr) throw ayErr;
  const oldToNewYearId = {};
  for (const y of sourceYears || []) {
    const { data: inserted, error: ins } = await supabase
      .from("academic_years")
      .insert({
        program_id: targetId,
        label: y.label,
        start_date: y.start_date,
        end_date: y.end_date,
      })
      .select("id")
      .single();
    if (ins) throw ins;
    oldToNewYearId[y.id] = inserted.id;
  }
  console.log("  ✓ Academic years:", Object.keys(oldToNewYearId).length);

  // 3) Months (per academic year, same order)
  const oldToNewMonthId = {};
  for (const y of sourceYears || []) {
    const { data: sourceMonths, error: mErr } = await supabase
      .from("months")
      .select("id, month_index, start_date, end_date, month_label")
      .eq("academic_year_id", y.id)
      .order("month_index", { ascending: true });
    if (mErr) throw mErr;
    const newYearId = oldToNewYearId[y.id];
    if (!newYearId) continue;
    for (const m of sourceMonths || []) {
      const row = {
        academic_year_id: newYearId,
        month_index: m.month_index,
        start_date: m.start_date ?? null,
        end_date: m.end_date ?? null,
      };
      if (m.month_label != null) row.month_label = m.month_label;
      const { data: inserted, error: ins } = await supabase
        .from("months")
        .insert(row)
        .select("id")
        .single();
      if (ins) throw ins;
      oldToNewMonthId[m.id] = inserted.id;
    }
  }
  console.log("  ✓ Months:", Object.keys(oldToNewMonthId).length);

  // 4) Residents
  const { data: sourceResidents, error: resErr } = await supabase
    .from("residents")
    .select("id, first_name, last_name, pgy, is_active")
    .eq("program_id", sourceId)
    .order("pgy")
    .order("last_name");
  if (resErr) throw resErr;
  const oldToNewResidentId = {};
  const residentsToInsert = (sourceResidents || []).map((r) => ({
    program_id: targetId,
    first_name: r.first_name ?? "",
    last_name: r.last_name ?? "",
    pgy: r.pgy ?? 1,
    is_active: r.is_active !== false,
  }));
  if (residentsToInsert.length > 0) {
    const { data: inserted, error: ins } = await supabase
      .from("residents")
      .insert(residentsToInsert)
      .select("id");
    if (ins) throw ins;
    const insertedList = inserted || [];
    sourceResidents.forEach((r, i) => {
      oldToNewResidentId[r.id] = insertedList[i]?.id;
    });
  }
  console.log("  ✓ Residents:", Object.keys(oldToNewResidentId).length);

  // 5) Rotations
  const { data: sourceRotations, error: rotErr } = await supabase
    .from("rotations")
    .select("id, name, capacity_per_month, eligible_pgy_min, eligible_pgy_max, is_consult, is_transplant, is_primary_site")
    .eq("program_id", sourceId)
    .order("name");
  if (rotErr) throw rotErr;
  const oldToNewRotationId = {};
  const rotationsToInsert = (sourceRotations || []).map((r) => ({
    program_id: targetId,
    name: r.name,
    capacity_per_month: r.capacity_per_month ?? 1,
    eligible_pgy_min: r.eligible_pgy_min ?? 1,
    eligible_pgy_max: r.eligible_pgy_max ?? 5,
    is_consult: r.is_consult === true,
    is_transplant: r.is_transplant === true,
    is_primary_site: r.is_primary_site === true,
  }));
  if (rotationsToInsert.length > 0) {
    const { data: inserted, error: ins } = await supabase
      .from("rotations")
      .insert(rotationsToInsert)
      .select("id");
    if (ins) throw ins;
    const insertedList = inserted || [];
    sourceRotations.forEach((r, i) => {
      oldToNewRotationId[r.id] = insertedList[i]?.id;
    });
  }
  console.log("  ✓ Rotations:", Object.keys(oldToNewRotationId).length);

  // 6) rotation_requirements (PGY matrix)
  const { data: sourceReqs, error: reqErr } = await supabase
    .from("rotation_requirements")
    .select("pgy, rotation_id, min_months_required")
    .eq("program_id", sourceId);
  if (reqErr) throw reqErr;
  const reqsToInsert = (sourceReqs || [])
    .filter((r) => oldToNewRotationId[r.rotation_id] != null)
    .map((r) => ({
      program_id: targetId,
      pgy: r.pgy,
      rotation_id: oldToNewRotationId[r.rotation_id],
      min_months_required: r.min_months_required ?? 0,
    }));
  if (reqsToInsert.length > 0) {
    const { error: ins } = await supabase.from("rotation_requirements").insert(reqsToInsert);
    if (ins) throw ins;
  }
  console.log("  ✓ Rotation requirements (PGY):", reqsToInsert.length);

  // 7) resident_rotation_requirements
  const { data: sourceResReqs, error: resReqErr } = await supabase
    .from("resident_rotation_requirements")
    .select("resident_id, rotation_id, min_months_required")
    .in("resident_id", Object.keys(oldToNewResidentId));
  if (resReqErr) throw resReqErr;
  const resReqsToInsert = (sourceResReqs || [])
    .filter(
      (r) =>
        oldToNewResidentId[r.resident_id] != null && oldToNewRotationId[r.rotation_id] != null
    )
    .map((r) => ({
      resident_id: oldToNewResidentId[r.resident_id],
      rotation_id: oldToNewRotationId[r.rotation_id],
      min_months_required: r.min_months_required ?? 0,
    }));
  if (resReqsToInsert.length > 0) {
    const { error: ins } = await supabase.from("resident_rotation_requirements").insert(resReqsToInsert);
    if (ins) throw ins;
  }
  console.log("  ✓ Resident rotation requirements:", resReqsToInsert.length);

  // 8) vacation_requests (by resident_id; dates stay the same)
  const { data: sourceVacations, error: vacErr } = await supabase
    .from("vacation_requests")
    .select("resident_id, start_date, end_date")
    .in("resident_id", Object.keys(oldToNewResidentId));
  if (vacErr) throw vacErr;
  const vacToInsert = (sourceVacations || [])
    .filter((v) => oldToNewResidentId[v.resident_id] != null)
    .map((v) => ({
      resident_id: oldToNewResidentId[v.resident_id],
      start_date: v.start_date,
      end_date: v.end_date,
    }));
  if (vacToInsert.length > 0) {
    const { error: ins } = await supabase.from("vacation_requests").insert(vacToInsert);
    if (ins) throw ins;
  }
  console.log("  ✓ Vacation requests:", vacToInsert.length);

  // 9) fixed_assignment_rules (academic_year_id, resident_id, month_id, rotation_id)
  const { data: sourceFixed, error: fixErr } = await supabase
    .from("fixed_assignment_rules")
    .select("academic_year_id, resident_id, month_id, rotation_id")
    .in("resident_id", Object.keys(oldToNewResidentId));
  if (fixErr) throw fixErr;
  const fixedToInsert = (sourceFixed || [])
    .filter(
      (f) =>
        oldToNewYearId[f.academic_year_id] != null &&
        oldToNewResidentId[f.resident_id] != null &&
        oldToNewMonthId[f.month_id] != null &&
        oldToNewRotationId[f.rotation_id] != null
    )
    .map((f) => ({
      academic_year_id: oldToNewYearId[f.academic_year_id],
      resident_id: oldToNewResidentId[f.resident_id],
      month_id: oldToNewMonthId[f.month_id],
      rotation_id: oldToNewRotationId[f.rotation_id],
    }));
  if (fixedToInsert.length > 0) {
    const { error: ins } = await supabase.from("fixed_assignment_rules").insert(fixedToInsert);
    if (ins) throw ins;
  }
  console.log("  ✓ Fixed assignment rules:", fixedToInsert.length);

  console.log("\n✅ Copy complete. Switch to UCI Nephrology Fellowship in the app and regenerate the schedule if needed.");
}

main().catch((err) => {
  console.error("❌", err.message || err);
  process.exit(1);
});
