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
    .from("rotation_requirements")
    .select("id, pgy, rotation_id, min_months_required")
    .eq("program_id", programId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as { id: string; pgy: number; rotation_id: string; min_months_required: number }[];
  const noStore = { headers: { "Cache-Control": "no-store, max-age=0" } as HeadersInit };
  if (rows.length === 0) {
    return NextResponse.json([], noStore);
  }
  const rotationIds = [...new Set(rows.map((r) => r.rotation_id))];
  const { data: rotations } = await db
    .from("rotations")
    .select("id, name")
    .in("id", rotationIds);
  const nameById = Object.fromEntries(
    (rotations ?? []).map((r: { id: string; name: string }) => [r.id, r.name])
  );
  const result = rows.map((r) => ({
    ...r,
    rotation_name: nameById[r.rotation_id] ?? "",
  }));
  return NextResponse.json(result, noStore);
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
  const { pgy, rotation_id, min_months_required } = body;
  if (pgy == null || !rotation_id || min_months_required == null) {
    return NextResponse.json(
      { error: "pgy, rotation_id, min_months_required required" },
      { status: 400 }
    );
  }
  const { data, error } = await db
    .from("rotation_requirements")
    .insert({
      program_id: programId,
      pgy: Number(pgy),
      rotation_id,
      min_months_required: Number(min_months_required),
    })
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function PUT(request: NextRequest) {
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

  let body: { requirements: { pgy: number; rotation_id: string; min_months_required: number }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const requirements = Array.isArray(body.requirements) ? body.requirements : [];
  const valid = requirements.filter(
    (r) =>
      Number.isInteger(r.pgy) &&
      r.pgy >= 1 &&
      r.pgy <= 5 &&
      typeof r.rotation_id === "string" &&
      r.rotation_id &&
      Number.isInteger(r.min_months_required) &&
      r.min_months_required >= 0
  );

  const { error: delErr } = await db
    .from("rotation_requirements")
    .delete()
    .eq("program_id", programId);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  const toInsert = valid
    .filter((r) => r.min_months_required > 0)
    .map((r) => ({
      program_id: programId,
      pgy: r.pgy,
      rotation_id: r.rotation_id,
      min_months_required: r.min_months_required,
    }));

  if (toInsert.length > 0) {
    const { error: insErr } = await db.from("rotation_requirements").insert(toInsert);
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, count: toInsert.length });
}
