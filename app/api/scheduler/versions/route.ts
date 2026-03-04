import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const academicYearIdParam = searchParams.get("academicYearId");
  const programIdFromQuery = getProgramIdFromRequest(searchParams);
    const supabase = createSupabaseServerClient(request);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Failed to load schedule versions" }, { status: 500 });
  }
  const academicYearId = academicYearIdParam ?? ctx.academicYearId;

  if (!academicYearId) {
    return NextResponse.json({ error: "academicYearId required" }, { status: 400 });
  }

  const { data, error } = await ctx.supabase
    .from("schedule_versions")
    .select("id, version_name, is_final, created_at")
    .eq("academic_year_id", academicYearId)
    .order("version_name", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}
