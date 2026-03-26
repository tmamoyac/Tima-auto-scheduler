import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";
import { normalizeVacationOverlapPolicy } from "@/lib/scheduler/vacationOverlapPolicy";

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
  const { programId, supabase: db } = ctx;

  const body = await request.json();
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = String(body.name);
  if (body.capacity_per_month !== undefined)
    updates.capacity_per_month = Number(body.capacity_per_month);
  if (body.eligible_pgy_min !== undefined)
    updates.eligible_pgy_min = Number(body.eligible_pgy_min);
  if (body.eligible_pgy_max !== undefined)
    updates.eligible_pgy_max = Number(body.eligible_pgy_max);
  if (body.is_consult !== undefined) updates.is_consult = Boolean(body.is_consult);
  if (body.is_back_to_back_consult_blocker !== undefined)
    updates.is_back_to_back_consult_blocker = Boolean(body.is_back_to_back_consult_blocker);
  if (body.is_transplant !== undefined) updates.is_transplant = Boolean(body.is_transplant);
  if (body.is_primary_site !== undefined) updates.is_primary_site = Boolean(body.is_primary_site);
  if (body.vacation_overlap_policy !== undefined) {
    updates.vacation_overlap_policy = normalizeVacationOverlapPolicy(body.vacation_overlap_policy);
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  const { data, error } = await db
    .from("rotations")
    .update(updates)
    .eq("id", id)
    .eq("program_id", programId)
    .select()
    .single();
  if (error) {
    if (error.code === "PGRST116") {
      return NextResponse.json({ error: "Rotation not found in this program" }, { status: 404 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function DELETE(
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
  const { programId, supabase: db } = ctx;

  const { data: deleted, error } = await db
    .from("rotations")
    .delete()
    .eq("id", id)
    .eq("program_id", programId)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!deleted) {
    return NextResponse.json({ error: "Rotation not found in this program" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
