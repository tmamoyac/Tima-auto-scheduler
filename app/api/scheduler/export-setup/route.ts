import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";
import {
  loadSchedulerStaticData,
  schedulerStaticDataToSerializableJson,
} from "@/lib/scheduler/generateSchedule";

const RELATIVE_DEBUG_FILE = path.join("debug", "current-scheduler-setup.json");

/**
 * POST — load the same scheduler static input the solver uses, write JSON next to project root for local CLI.
 * Query: programId, academicYearId (same as generate).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient(request);
    const q = request.nextUrl.searchParams;
    const programIdFromQuery = getProgramIdFromRequest(q);
    const academicYearIdOverride = q.get("academicYearId") ?? q.get("academicyearid");
    const ctx = await getProgramContextForRequest(
      supabase,
      supabaseAdmin,
      programIdFromQuery,
      academicYearIdOverride
    );
    if (!ctx.academicYearId) {
      return NextResponse.json({ error: "No academic year found for program" }, { status: 400 });
    }

    const staticData = await loadSchedulerStaticData({
      supabaseAdmin: ctx.supabase,
      academicYearId: ctx.academicYearId,
    });
    const serializable = schedulerStaticDataToSerializableJson(staticData);
    const outAbs = path.join(process.cwd(), RELATIVE_DEBUG_FILE);
    let writeError: string | null = null;
    try {
      mkdirSync(path.dirname(outAbs), { recursive: true });
      writeFileSync(outAbs, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
    } catch (e) {
      writeError = e instanceof Error ? e.message : String(e);
    }

    return NextResponse.json({
      ok: true,
      relativePath: writeError ? null : RELATIVE_DEBUG_FILE,
      writeError,
      setupJson: writeError ? serializable : undefined,
      academicYearId: ctx.academicYearId,
      programId: ctx.programId,
    });
  } catch (err) {
    const res = directorAuthErrorResponse(err);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Export failed" },
      { status: 500 }
    );
  }
}
