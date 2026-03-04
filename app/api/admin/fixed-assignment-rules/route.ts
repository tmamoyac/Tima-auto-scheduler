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

  const { data: year, error: yearErr } = await db
    .from("academic_years")
    .select("id")
    .eq("id", academicYearId)
    .eq("program_id", programId)
    .maybeSingle();
  if (yearErr || !year) {
    return NextResponse.json({ error: "Academic year not found" }, { status: 404 });
  }

  const { data: rows, error } = await db
    .from("fixed_assignment_rules")
    .select("id, resident_id, month_id, rotation_id")
    .eq("academic_year_id", academicYearId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const list = (rows ?? []) as { id: string; resident_id: string; month_id: string; rotation_id: string }[];
  if (list.length === 0) {
    return NextResponse.json([]);
  }
  const residentIds = [...new Set(list.map((r) => r.resident_id))];
  const monthIds = [...new Set(list.map((r) => r.month_id))];
  const rotationIds = [...new Set(list.map((r) => r.rotation_id))];
  const [{ data: residents }, { data: months }, { data: rotations }] = await Promise.all([
    db.from("residents").select("id, first_name, last_name").in("id", residentIds),
    db.from("months").select("id, month_label").in("id", monthIds),
    db.from("rotations").select("id, name").in("id", rotationIds),
  ]);
  const residentByName = Object.fromEntries(
    (residents ?? []).map((r: { id: string; first_name: string; last_name: string }) => [
      r.id,
      `${r.first_name} ${r.last_name}`,
    ])
  );
  const monthByLabel = Object.fromEntries(
    (months ?? []).map((m: { id: string; month_label: string }) => [m.id, m.month_label])
  );
  const rotationByName = Object.fromEntries(
    (rotations ?? []).map((r: { id: string; name: string }) => [r.id, r.name])
  );
  const result = list.map((r) => ({
    ...r,
    resident_name: residentByName[r.resident_id] ?? "",
    month_label: monthByLabel[r.month_id] ?? "",
    rotation_name: rotationByName[r.rotation_id] ?? "",
  }));
  return NextResponse.json(result);
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

  let body: {
    academic_year_id?: string;
    resident_id?: string;
    month_id?: string;
    rotation_id?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { academic_year_id, resident_id, month_id, rotation_id } = body;
  if (!academic_year_id || !resident_id || !month_id || !rotation_id) {
    return NextResponse.json(
      { error: "academic_year_id, resident_id, month_id, rotation_id required" },
      { status: 400 }
    );
  }

  const { data: year, error: yearErr } = await db
    .from("academic_years")
    .select("id")
    .eq("id", academic_year_id)
    .eq("program_id", programId)
    .maybeSingle();
  if (yearErr || !year) {
    return NextResponse.json({ error: "Academic year not found" }, { status: 404 });
  }

  const { data: monthRow, error: monthErr } = await db
    .from("months")
    .select("academic_year_id")
    .eq("id", month_id)
    .single();
  if (monthErr || !monthRow || (monthRow as { academic_year_id: string }).academic_year_id !== academic_year_id) {
    return NextResponse.json({ error: "Month must belong to the given academic year" }, { status: 400 });
  }
  const { data, error } = await db
    .from("fixed_assignment_rules")
    .insert({
      academic_year_id,
      resident_id,
      month_id,
      rotation_id,
    })
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
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
  const { supabase: db } = ctx;

  const { error } = await db.from("fixed_assignment_rules").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
