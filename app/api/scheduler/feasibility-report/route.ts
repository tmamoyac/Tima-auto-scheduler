import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";
import {
  buildFeasibilityReportForAcademicYear,
  type ScheduleAudit,
} from "@/lib/scheduler/generateSchedule";

/**
 * POST optional body: `{ audit?: ScheduleAudit }` to merge audit gaps into suggestions.
 * Used when the client shows an audit but feasibilityReport was missing from the generate response.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient(request);
    const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
    const ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
    if (!ctx.academicYearId) {
      return NextResponse.json({ error: "No academic year found for program" }, { status: 400 });
    }

    let audit: ScheduleAudit | null | undefined;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = (await request.json()) as { audit?: ScheduleAudit };
        audit = body?.audit;
      } catch {
        audit = undefined;
      }
    }

    const feasibilityReport = await buildFeasibilityReportForAcademicYear(
      ctx.supabase,
      ctx.academicYearId,
      audit ?? null
    );
    return NextResponse.json({ feasibilityReport });
  } catch (err) {
    const res = directorAuthErrorResponse(err);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Feasibility report failed" },
      { status: 500 }
    );
  }
}
