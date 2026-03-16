import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

  const { data: existingYear, error: fetchErr } = await supabaseAdmin
    .from("academic_years")
    .select("id, program_id, label, start_date, end_date")
    .eq("id", id)
    .eq("program_id", programId)
    .maybeSingle();

  if (fetchErr || !existingYear) {
    return NextResponse.json({ error: "Academic year not found" }, { status: 404 });
  }

  let body: { label?: string; start_date?: string; end_date?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: { label?: string; start_date?: string; end_date?: string } = {};
  if (body.label !== undefined) updates.label = String(body.label).trim() || (existingYear as { label?: string }).label;
  if (body.start_date !== undefined) updates.start_date = String(body.start_date).trim().slice(0, 10);
  if (body.end_date !== undefined) updates.end_date = String(body.end_date).trim().slice(0, 10);

  const newStart = updates.start_date ?? (existingYear as { start_date: string }).start_date;
  const newEnd = updates.end_date ?? (existingYear as { end_date: string }).end_date;

  let duplicateYearIdToRemove: string | null = null;
  if (updates.start_date !== undefined || updates.end_date !== undefined) {
    if (!newStart || !newEnd) {
      return NextResponse.json({ error: "start_date and end_date are required when changing dates" }, { status: 400 });
    }
    const startMatch = /^\d{4}-\d{2}-\d{2}$/.exec(newStart);
    const endMatch = /^\d{4}-\d{2}-\d{2}$/.exec(newEnd);
    if (!startMatch || !endMatch) {
      return NextResponse.json({ error: "start_date and end_date must be YYYY-MM-DD" }, { status: 400 });
    }
    if (newStart >= newEnd) {
      return NextResponse.json({ error: "start_date must be before end_date" }, { status: 400 });
    }
    const startMs = new Date(newStart + "T12:00:00").getTime();
    const endMs = new Date(newEnd + "T12:00:00").getTime();
    const days = (endMs - startMs) / (24 * 60 * 60 * 1000) + 1;
    const minDays = 330;
    const maxDays = 400;
    if (days < minDays || days > maxDays) {
      return NextResponse.json(
        { error: `Academic year must span 11–13 months (${minDays}–${maxDays} days)` },
        { status: 400 }
      );
    }
    // Only check overlap within the same program (programs are siloed).
    const programIdForOverlap = (existingYear as { program_id: string }).program_id;
    const { data: otherYears } = await supabaseAdmin
      .from("academic_years")
      .select("id, start_date, end_date")
      .eq("program_id", programIdForOverlap)
      .neq("id", id);
    for (const y of otherYears ?? []) {
      const es = (y as { start_date: string }).start_date;
      const ee = (y as { end_date: string }).end_date;
      if (newStart <= ee && newEnd >= es) {
        if (es === newStart && ee === newEnd) {
          duplicateYearIdToRemove = (y as { id: string }).id;
          break;
        }
        return NextResponse.json(
          { error: "Academic year dates overlap with another year in this program" },
          { status: 400 }
        );
      }
    }
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("academic_years")
    .update({
      ...(updates.label !== undefined && { label: updates.label }),
      ...(updates.start_date !== undefined && { start_date: updates.start_date }),
      ...(updates.end_date !== undefined && { end_date: updates.end_date }),
    })
    .eq("id", id)
    .eq("program_id", programId)
    .select("id, label, start_date, end_date")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  if (updates.start_date !== undefined || updates.end_date !== undefined) {
    const { error: delErr } = await supabaseAdmin.from("months").delete().eq("academic_year_id", id);
    if (delErr) {
      return NextResponse.json({ error: "Updated year but failed to refresh months: " + delErr.message }, { status: 500 });
    }
    const monthsData = generateMonthsForAcademicYear(newStart, newEnd);
    const monthsToInsert = monthsData.map((m) => ({
      academic_year_id: id,
      month_index: m.month_index,
      month_label: m.month_label,
      start_date: m.start_date,
      end_date: m.end_date,
    }));
    const { error: monthsErr } = await supabaseAdmin.from("months").insert(monthsToInsert);
    if (monthsErr) {
      return NextResponse.json({ error: monthsErr.message }, { status: 500 });
    }
    if (duplicateYearIdToRemove) {
      const { error: dupErr } = await supabaseAdmin
        .from("academic_years")
        .delete()
        .eq("id", duplicateYearIdToRemove)
        .eq("program_id", programId);
      if (dupErr) {
        return NextResponse.json(
          { error: "Updated year but failed to remove duplicate: " + dupErr.message },
          { status: 500 }
        );
      }
    }
  }

  return NextResponse.json(updated);
}
