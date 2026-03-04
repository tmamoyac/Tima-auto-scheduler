import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

export async function GET(request: NextRequest) {
  const academicYearId = request.nextUrl.searchParams.get("academicYearId");
  if (!academicYearId) {
    return NextResponse.json({ error: "academicYearId required" }, { status: 400 });
  }
  const supabase = createSupabaseServerClient();
  const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { programId, supabase: db } = ctx;

  const { data: yearRow, error: yearErr } = await db
    .from("academic_years")
    .select("program_id, start_date, end_date")
    .eq("id", academicYearId)
    .eq("program_id", programId)
    .single();
  if (yearErr || !yearRow) {
    return NextResponse.json(
      { error: yearErr?.message ?? "Academic year not found" },
      { status: 404 }
    );
  }
  const yearStart = yearRow.start_date as string;
  const yearEnd = yearRow.end_date as string;

  const { data: months, error: monthsErr } = await db
    .from("months")
    .select("id, month_index, month_label, start_date, end_date")
    .eq("academic_year_id", academicYearId)
    .order("month_index", { ascending: true });
  if (monthsErr) {
    return NextResponse.json({ error: monthsErr.message }, { status: 500 });
  }

  const { data: residents, error: resErr } = await db
    .from("residents")
    .select("id, first_name, last_name, pgy")
    .eq("program_id", programId)
    .order("pgy")
    .order("last_name");
  if (resErr) {
    return NextResponse.json({ error: resErr.message }, { status: 500 });
  }

  const { data: vacationRows, error: vacErr } = await db
    .from("vacation_requests")
    .select("id, resident_id, start_date, end_date")
    .lte("start_date", yearEnd)
    .gte("end_date", yearStart);
  if (vacErr) {
    return NextResponse.json({ error: vacErr.message }, { status: 500 });
  }

  return NextResponse.json({
    months: months ?? [],
    residents: residents ?? [],
    vacationRequests: vacationRows ?? [],
  });
}

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServerClient();
  const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase: db } = ctx;

  let body: { resident_id?: string; start_date?: string; end_date?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { resident_id, start_date, end_date } = body;
  if (!resident_id || !start_date || !end_date) {
    return NextResponse.json(
      { error: "resident_id, start_date, and end_date required" },
      { status: 400 }
    );
  }
  const start = start_date.slice(0, 10);
  const end = end_date.slice(0, 10);
  if (start > end) {
    return NextResponse.json({ error: "start_date must be <= end_date" }, { status: 400 });
  }
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const days = (endMs - startMs) / (24 * 60 * 60 * 1000) + 1;
  if (days > 14) {
    return NextResponse.json(
      { error: "Vacation range must be 14 days or less" },
      { status: 400 }
    );
  }

  const { data, error } = await db
    .from("vacation_requests")
    .insert({ resident_id, start_date: start, end_date: end })
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function DELETE(request: NextRequest) {
  const supabase = createSupabaseServerClient();
  const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase: db } = ctx;

  const id = request.nextUrl.searchParams.get("id");
  if (id) {
    const { error } = await db.from("vacation_requests").delete().eq("id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }
  const resident_id = request.nextUrl.searchParams.get("resident_id");
  const start_date = request.nextUrl.searchParams.get("start_date");
  if (!resident_id || !start_date) {
    return NextResponse.json(
      { error: "id or (resident_id and start_date) required" },
      { status: 400 }
    );
  }
  const { error } = await db
    .from("vacation_requests")
    .delete()
    .eq("resident_id", resident_id)
    .eq("start_date", start_date.slice(0, 10));
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
