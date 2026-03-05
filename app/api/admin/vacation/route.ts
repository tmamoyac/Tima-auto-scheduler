import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import {
  getAcademicYearIdFromRequest,
  getProgramContextForRequest,
  getProgramIdFromRequest,
} from "@/lib/auth/schedulerContext";

export async function GET(request: NextRequest) {
  const academicYearId = getAcademicYearIdFromRequest(request.nextUrl.searchParams);
  if (!academicYearId) {
    return NextResponse.json({ error: "academicYearId required" }, { status: 400 });
  }
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

  const { data: yearRow, error: yearErr } = await supabaseAdmin
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

  const { data: months, error: monthsErr } = await supabaseAdmin
    .from("months")
    .select("id, month_index, month_label, start_date, end_date")
    .eq("academic_year_id", academicYearId)
    .order("month_index", { ascending: true });
  if (monthsErr) {
    return NextResponse.json({ error: monthsErr.message }, { status: 500 });
  }

  const { data: residents, error: resErr } = await supabaseAdmin
    .from("residents")
    .select("id, first_name, last_name, pgy")
    .eq("program_id", programId)
    .order("pgy")
    .order("last_name");
  if (resErr) {
    return NextResponse.json({ error: resErr.message }, { status: 500 });
  }

  const residentIds = (residents ?? []).map((r) => r.id);
  const yearStart = (yearRow as { start_date?: string })?.start_date ?? "";
  const yearEnd = (yearRow as { end_date?: string })?.end_date ?? "";

  let vacationRows: { id: string; resident_id: string; start_date: string; end_date: string }[] = [];
  if (residentIds.length > 0 && yearStart && yearEnd) {
    const { data, error: vacErr } = await supabaseAdmin
      .from("vacation_requests")
      .select("id, resident_id, start_date, end_date")
      .in("resident_id", residentIds)
      .lte("start_date", yearEnd)
      .gte("end_date", yearStart)
      .order("start_date", { ascending: true });
    if (vacErr) {
      return NextResponse.json({ error: vacErr.message }, { status: 500 });
    }
    vacationRows = data ?? [];
  }

  return NextResponse.json({
    months: months ?? [],
    residents: residents ?? [],
    vacationRequests: vacationRows ?? [],
  });
}

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServerClient(request);
  const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
  const academicYearIdFromQuery = getAcademicYearIdFromRequest(request.nextUrl.searchParams);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(
      supabase,
      supabaseAdmin,
      programIdFromQuery,
      academicYearIdFromQuery
    );
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { programId, academicYearId } = ctx;
  if (!academicYearId) {
    return NextResponse.json(
      { error: "Academic year context required for vacation requests" },
      { status: 400 }
    );
  }

  const { data: yearRow } = await supabaseAdmin
    .from("academic_years")
    .select("start_date, end_date")
    .eq("id", academicYearId)
    .eq("program_id", programId)
    .maybeSingle();
  const yearStart = (yearRow as { start_date?: string } | null)?.start_date ?? "";
  const yearEnd = (yearRow as { end_date?: string } | null)?.end_date ?? "";
  if (!yearStart || !yearEnd) {
    return NextResponse.json(
      { error: "Academic year not found" },
      { status: 404 }
    );
  }

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
  if (start < yearStart || end > yearEnd) {
    return NextResponse.json(
      {
        error: `Vacation dates must be within the academic year (${yearStart} – ${yearEnd}).`,
      },
      { status: 400 }
    );
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

  const { data: residentRow } = await supabaseAdmin
    .from("residents")
    .select("id")
    .eq("id", resident_id)
    .eq("program_id", programId)
    .maybeSingle();
  if (!residentRow) {
    return NextResponse.json({ error: "Resident not found or not in your program" }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
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

  const id = request.nextUrl.searchParams.get("id");
  if (id) {
    const { data: existing } = await supabaseAdmin
      .from("vacation_requests")
      .select("resident_id")
      .eq("id", id)
      .maybeSingle();
    if (existing) {
      const { data: residentRow } = await supabaseAdmin
        .from("residents")
        .select("id")
        .eq("id", existing.resident_id)
        .eq("program_id", programId)
        .maybeSingle();
      if (!residentRow) {
        return NextResponse.json({ error: "Not authorized to delete this vacation request" }, { status: 403 });
      }
    }
    const { error } = await supabaseAdmin.from("vacation_requests").delete().eq("id", id);
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
  const { data: residentRow } = await supabaseAdmin
    .from("residents")
    .select("id")
    .eq("id", resident_id)
    .eq("program_id", programId)
    .maybeSingle();
  if (!residentRow) {
    return NextResponse.json({ error: "Not authorized to delete this vacation request" }, { status: 403 });
  }
  const { error } = await supabaseAdmin
    .from("vacation_requests")
    .delete()
    .eq("resident_id", resident_id)
    .eq("start_date", start_date.slice(0, 10));
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
