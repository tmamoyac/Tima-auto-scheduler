import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

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
  const { programId, supabase: db } = ctx;

  const { data, error } = await db
    .from("rotations")
    .select("*")
    .eq("program_id", programId)
    .order("name");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data ?? [], {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
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
  const { programId, supabase: db } = ctx;

  const body = await request.json();
  const { name, capacity_per_month, eligible_pgy_min, eligible_pgy_max } = body;
  if (
    name == null ||
    capacity_per_month == null ||
    eligible_pgy_min == null ||
    eligible_pgy_max == null
  ) {
    return NextResponse.json(
      { error: "name, capacity_per_month, eligible_pgy_min, eligible_pgy_max required" },
      { status: 400 }
    );
  }
  const { data, error } = await db
    .from("rotations")
    .insert({
      program_id: programId,
      name: String(name),
      capacity_per_month: Number(capacity_per_month),
      eligible_pgy_min: Number(eligible_pgy_min),
      eligible_pgy_max: Number(eligible_pgy_max),
      is_consult: body.is_consult === true,
      is_transplant: body.is_transplant === true,
      is_primary_site: body.is_primary_site === true,
    })
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
