import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";
import {
  generateSchedule,
  SCHEDULE_ERROR_REQUIREMENTS_UNSATISFIABLE,
  ScheduleCpSatUnavailableError,
  ScheduleUnsatError,
  ScheduleVacationOverlapFixedBlockError,
} from "@/lib/scheduler/generateSchedule";

/** Must be a static number for Next.js route config (≈90s search + DB + slack). */
export const maxDuration = 120;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient(request);
    const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
    const ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
    if (!ctx.academicYearId) return jsonError("No academic year found for program", 400);

    let omitFixedAssignmentRules = false;
    try {
      const ct = request.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const body = (await request.json()) as { omitFixedAssignmentRules?: boolean };
        omitFixedAssignmentRules = body?.omitFixedAssignmentRules === true;
      }
    } catch {
      omitFixedAssignmentRules = false;
    }

    const result = await generateSchedule({
      supabaseAdmin: ctx.supabase,
      academicYearId: ctx.academicYearId,
      omitFixedAssignmentRules,
    });
    return NextResponse.json(result);
  } catch (err) {
    const res = directorAuthErrorResponse(err);
    if (res) return jsonError(res.error, res.status);
    if (err instanceof ScheduleCpSatUnavailableError) {
      return NextResponse.json(
        {
          error: err.message,
          cp_sat_unavailable: err.cp_sat_unavailable,
        },
        { status: 503 }
      );
    }
    if (err instanceof ScheduleVacationOverlapFixedBlockError) {
      return NextResponse.json(
        {
          error: err.message,
          vacation_overlap_blocked: err.vacation_overlap_blocked,
        },
        { status: 422 }
      );
    }
    if (err instanceof ScheduleUnsatError) {
      return NextResponse.json(
        {
          error: "Schedule generation failed.",
          feasibilityReport: err.feasibilityReport,
          schedulerEngineUsed: err.schedulerEngineUsed,
          witnessFirstFailure: err.witnessFirstFailure ?? null,
        },
        { status: 422 }
      );
    }
    if (err instanceof Error && err.message === SCHEDULE_ERROR_REQUIREMENTS_UNSATISFIABLE) {
      return jsonError(
        "Unable to generate a schedule that satisfies all rotation requirements within the attempt limit.",
        422
      );
    }
    return jsonError(
      err instanceof Error ? err.message : "Schedule generation failed",
      500
    );
  }
}
