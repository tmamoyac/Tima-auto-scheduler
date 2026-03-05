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

function generateMonthsForAcademicYear(
  startDate: string,
  endDate: string
): { month_index: number; month_label: string; start_date: string; end_date: string }[] {
  const start = new Date(startDate + "T12:00:00");
  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth() + 1;
  const result: { month_index: number; month_label: string; start_date: string; end_date: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const totalMonths = startMonth - 1 + i;
    const calMonth = (totalMonths % 12) + 1;
    const calYear = startYear + Math.floor(totalMonths / 12);
    const monthStart = firstDayUTC(calYear, calMonth);
    const monthEnd = lastDayUTC(calYear, calMonth);
    const monthEndStr = monthEnd.toISOString().slice(0, 10);
    result.push({
      month_index: i + 1,
      month_label: monthLabel(calYear, calMonth),
      start_date: monthStart.toISOString().slice(0, 10),
      end_date: monthEndStr > endDate ? endDate : monthEndStr,
    });
  }
  return result;
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient(request);
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

  const { data: programs, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const programList = programs ?? [];

  if (programList.length === 0) {
    return NextResponse.json([]);
  }

  const programIds = programList.map((p: { id: string }) => p.id);
  const { data: years, error: yearsErr } = await supabaseAdmin
    .from("academic_years")
    .select("id, program_id, start_date, end_date")
    .in("program_id", programIds)
    .order("end_date", { ascending: false });

  if (yearsErr) {
    return NextResponse.json({ error: yearsErr.message }, { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const byProgram = new Map<string, { id: string; start_date: string; end_date: string }[]>();
  for (const y of years ?? []) {
    const row = y as { id: string; program_id: string; start_date: string; end_date: string };
    if (!byProgram.has(row.program_id)) byProgram.set(row.program_id, []);
    byProgram.get(row.program_id)!.push({ id: row.id, start_date: row.start_date, end_date: row.end_date });
  }

  const withDefault = programList.map((p: { id: string; name: string; is_active?: boolean }) => {
    const list = byProgram.get(p.id) ?? [];
    const current = list.find((y) => y.start_date <= today && today <= y.end_date);
    const defaultYear = current ?? list[0] ?? null;
    return {
      ...p,
      default_academic_year: defaultYear,
    };
  });

  return NextResponse.json(withDefault);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient(request);
    await requireSuperAdmin(supabase);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { name?: string; start_date?: string; end_date?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const startYear = new Date().getUTCFullYear();
  let startDate = typeof body.start_date === "string" ? body.start_date.trim().slice(0, 10) : "";
  let endDate = typeof body.end_date === "string" ? body.end_date.trim().slice(0, 10) : "";

  if (startDate || endDate) {
    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "Provide both start_date and end_date, or omit both to use default (Jul 1 – Jun 30)" },
        { status: 400 }
      );
    }
    const startMatch = /^\d{4}-\d{2}-\d{2}$/.exec(startDate);
    const endMatch = /^\d{4}-\d{2}-\d{2}$/.exec(endDate);
    if (!startMatch || !endMatch) {
      return NextResponse.json(
        { error: "start_date and end_date must be YYYY-MM-DD" },
        { status: 400 }
      );
    }
    if (startDate >= endDate) {
      return NextResponse.json({ error: "start_date must be before end_date" }, { status: 400 });
    }
    const startMs = new Date(startDate + "T12:00:00").getTime();
    const endMs = new Date(endDate + "T12:00:00").getTime();
    const days = (endMs - startMs) / (24 * 60 * 60 * 1000) + 1;
    const minDays = 330;
    const maxDays = 400;
    if (days < minDays || days > maxDays) {
      return NextResponse.json(
        { error: "Academic year must span 11–13 months (330–400 days)" },
        { status: 400 }
      );
    }
  } else {
    startDate = `${startYear}-07-01`;
    endDate = `${startYear + 1}-06-30`;
  }

  const label = `${startDate.slice(0, 4)}-${endDate.slice(0, 4)}`;

  const { data: program, error: programErr } = await supabaseAdmin
    .from("programs")
    .insert({ name })
    .select("id, name")
    .single();

  if (programErr) return NextResponse.json({ error: programErr.message }, { status: 500 });

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

  const monthsData = generateMonthsForAcademicYear(startDate, endDate);
  const monthsToInsert = monthsData.map((m) => ({
    academic_year_id: academicYear.id,
    month_index: m.month_index,
    month_label: m.month_label,
    start_date: m.start_date,
    end_date: m.end_date,
  }));

  const { error: monthsErr } = await supabaseAdmin.from("months").insert(monthsToInsert);
  if (monthsErr) {
    await supabaseAdmin.from("academic_years").delete().eq("id", academicYear.id);
    await supabaseAdmin.from("programs").delete().eq("id", program.id);
    return NextResponse.json({ error: monthsErr.message }, { status: 500 });
  }

  return NextResponse.json({ id: program.id, name: program.name });
}
