import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

export async function GET(
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
  if (id !== programId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await db
    .from("programs")
    .select("*")
    .eq("id", id)
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.code === "PGRST116" ? 404 : 500 });
  }
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const row = data as Record<string, unknown>;
  return NextResponse.json({
    id: row.id,
    name: row.name,
    avoid_back_to_back_consult: row.avoid_back_to_back_consult === true,
    no_consult_when_vacation_in_month: row.no_consult_when_vacation_in_month === true,
    avoid_back_to_back_transplant: row.avoid_back_to_back_transplant === true,
  });
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
  const { programId, supabase: db } = ctx;
  if (id !== programId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { avoid_back_to_back_consult?: boolean; no_consult_when_vacation_in_month?: boolean; avoid_back_to_back_transplant?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const updates: Record<string, unknown> = {};
  if (body.avoid_back_to_back_consult !== undefined)
    updates.avoid_back_to_back_consult = Boolean(body.avoid_back_to_back_consult);
  if (body.no_consult_when_vacation_in_month !== undefined)
    updates.no_consult_when_vacation_in_month = Boolean(body.no_consult_when_vacation_in_month);
  if (body.avoid_back_to_back_transplant !== undefined)
    updates.avoid_back_to_back_transplant = Boolean(body.avoid_back_to_back_transplant);
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  const { data, error } = await db
    .from("programs")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
