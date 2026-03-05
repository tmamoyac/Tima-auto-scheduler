import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

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
  const supabase = createSupabaseServerClient(request);
  const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { programId } = ctx;

  const { data: years, error } = await supabaseAdmin
    .from("academic_years")
    .select("id, label, start_date, end_date")
    .eq("program_id", programId)
    .order("end_date", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(years ?? []);
}

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServerClient(request);
  const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { programId } = ctx;

  let body: { start_date?: string; end_date?: string; label?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const startDate = typeof body.start_date === "string" ? body.start_date.trim().slice(0, 10) : "";
  const endDate = typeof body.end_date === "string" ? body.end_date.trim().slice(0, 10) : "";
  const label = typeof body.label === "string" ? body.label.trim() || undefined : undefined;

  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: "start_date and end_date are required" },
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
      { error: `Academic year must span 11–13 months (${minDays}–${maxDays} days)` },
      { status: 400 }
    );
  }

  const { data: existingYears } = await supabaseAdmin
    .from("academic_years")
    .select("id, start_date, end_date")
    .eq("program_id", programId);
  for (const y of existingYears ?? []) {
    const es = (y as { start_date: string }).start_date;
    const ee = (y as { end_date: string }).end_date;
    if (
      (startDate <= ee && endDate >= es)
    ) {
      return NextResponse.json(
        { error: "Academic year dates overlap with an existing year" },
        { status: 400 }
      );
    }
  }

  const autoLabel = label ?? `${startDate.slice(0, 4)}-${endDate.slice(0, 4)}`;

  const { data: academicYear, error: yearErr } = await supabaseAdmin
    .from("academic_years")
    .insert({
      program_id: programId,
      label: autoLabel,
      start_date: startDate,
      end_date: endDate,
    })
    .select("id, label, start_date, end_date")
    .single();

  if (yearErr) {
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
    return NextResponse.json({ error: monthsErr.message }, { status: 500 });
  }

  return NextResponse.json(academicYear);
}
