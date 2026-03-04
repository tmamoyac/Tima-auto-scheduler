import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

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
  const { supabase: db } = ctx;

  let body: { version_name?: string; is_final?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.version_name !== undefined) updates.version_name = body.version_name === "" ? null : String(body.version_name);
  if (body.is_final !== undefined) updates.is_final = Boolean(body.is_final);

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  // If marking as final, clear is_final on other versions for the same academic year
  if (body.is_final === true) {
    const { data: row, error: fetchErr } = await db
      .from("schedule_versions")
      .select("academic_year_id")
      .eq("id", id)
      .single();
    if (fetchErr || !row) {
      return NextResponse.json({ error: fetchErr?.message ?? "Version not found" }, { status: 404 });
    }
    const academicYearId = row.academic_year_id as string;
    await db
      .from("schedule_versions")
      .update({ is_final: false })
      .eq("academic_year_id", academicYearId)
      .neq("id", id);
  }

  const { data, error } = await db
    .from("schedule_versions")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
