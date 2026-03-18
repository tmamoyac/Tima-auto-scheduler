import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";
import { generateSchedule } from "@/lib/scheduler/generateSchedule";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient(request);
    const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
    const ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
    if (!ctx.academicYearId) return jsonError("No academic year found for program", 400);

    const { scheduleVersionId, audit } = await generateSchedule({
      supabaseAdmin: ctx.supabase,
      academicYearId: ctx.academicYearId,
    });
    return NextResponse.json({ scheduleVersionId, audit });
  } catch (err) {
    const res = directorAuthErrorResponse(err);
    if (res) return jsonError(res.error, res.status);
    return jsonError(
      err instanceof Error ? err.message : "Schedule generation failed",
      500
    );
  }
}
