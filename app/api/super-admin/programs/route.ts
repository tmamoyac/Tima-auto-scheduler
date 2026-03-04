import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/auth/superAdmin";
import { supabaseAdmin } from "@/lib/supabase/admin";

function monthLabel(year: number, monthIndex1to12: number): string {
  const d = new Date(Date.UTC(year, monthIndex1to12 - 1, 1));
  return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function firstDayUTC(year: number, monthIndex1to12: number): Date {
  return new Date(Date.UTC(year, monthIndex1to12 - 1, 1));
}

function lastDayUTC(year: number, monthIndex1to12: number): Date {
  return new Date(Date.UTC(year, monthIndex1to12, 0));
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient();
    await requireSuperAdmin(supabase);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const activeOnly = searchParams.get("activeOnly") === "true";

  let query = supabaseAdmin
    .from("programs")
    .select("id, name, is_active")
    .order("name");

  if (activeOnly) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient();
    await requireSuperAdmin(supabase);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { data: program, error: programErr } = await supabaseAdmin
    .from("programs")
    .insert({ name })
    .select("id, name")
    .single();

  if (programErr) return NextResponse.json({ error: programErr.message }, { status: 500 });

  const startYear = new Date().getUTCFullYear();
  const startDate = `${startYear}-07-01`;
  const endDate = `${startYear + 1}-06-30`;
  const label = `${startYear}-${startYear + 1}`;

  const { data: academicYear, error: yearErr } = await supabaseAdmin
    .from("academic_years")
    .insert({
      program_id: program.id,
      label,
      start_date: startDate,
      end_date: endDate,
    })
    .select("id")
    .single();

  if (yearErr) {
    await supabaseAdmin.from("programs").delete().eq("id", program.id);
    return NextResponse.json({ error: yearErr.message }, { status: 500 });
  }

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

  const { error: monthsErr } = await supabaseAdmin.from("months").insert(monthsToInsert);
  if (monthsErr) {
    await supabaseAdmin.from("academic_years").delete().eq("id", academicYear.id);
    await supabaseAdmin.from("programs").delete().eq("id", program.id);
    return NextResponse.json({ error: monthsErr.message }, { status: 500 });
  }

  return NextResponse.json({ id: program.id, name: program.name });
}
