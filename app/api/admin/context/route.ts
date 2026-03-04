import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

export async function GET(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient();
    const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
    const { programId, academicYearId } = await getProgramContextForRequest(
      supabase,
      supabaseAdmin,
      programIdFromQuery
    );
    if (!academicYearId) {
      return NextResponse.json({ error: "No academic year found for program" }, { status: 404 });
    }
    return NextResponse.json({ programId, academicYearId });
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Failed to load context" }, { status: 500 });
  }
}
