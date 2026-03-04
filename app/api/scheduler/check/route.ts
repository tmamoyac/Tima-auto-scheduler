import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

export async function GET(request: NextRequest) {
  const steps: { name: string; status: "pass" | "fail"; detail: string }[] = [];
  let needTables = false;

  try {
    const supabase = createSupabaseServerClient(request);
    const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
    const ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
    if (!ctx.academicYearId) {
      steps.push({
        name: "Academic year",
        status: "fail",
        detail: "No academic year found for your program. Run the seed or add one in Supabase.",
      });
    }

    const { data: years, error: yearErr } = await ctx.supabase
      .from("academic_years")
      .select("id")
      .eq("program_id", ctx.programId)
      .limit(1);
    if (yearErr) {
      steps.push({ name: "Academic year", status: "fail", detail: yearErr.message });
    } else if (!years?.length) {
      steps.push({ name: "Academic year", status: "fail", detail: "No academic year in database. Run the seed or add one in Supabase." });
    } else {
      steps.push({ name: "Academic year", status: "pass", detail: "Found." });
    }

    const { error: svErr } = await ctx.supabase.from("schedule_versions").select("id").limit(1);
    if (svErr) {
      const msg = String(svErr.message);
      if (msg.includes("schedule_versions") && (msg.includes("does not exist") || msg.includes("relation"))) {
        steps.push({ name: "schedule_versions table", status: "fail", detail: "Table is missing." });
        needTables = true;
      } else {
        steps.push({ name: "schedule_versions table", status: "fail", detail: msg });
      }
    } else {
      steps.push({ name: "schedule_versions table", status: "pass", detail: "Exists." });
    }

    const { error: aErr } = await ctx.supabase.from("assignments").select("id").limit(1);
    if (aErr) {
      const msg = String(aErr.message);
      if (msg.includes("assignments") && (msg.includes("does not exist") || msg.includes("relation"))) {
        steps.push({ name: "assignments table", status: "fail", detail: "Table is missing." });
        needTables = true;
      } else {
        steps.push({ name: "assignments table", status: "fail", detail: msg });
      }
    } else {
      steps.push({ name: "assignments table", status: "pass", detail: "Exists." });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg === "UNAUTHENTICATED") {
      steps.push({ name: "Auth", status: "fail", detail: "Not logged in." });
    } else if (msg === "NO_PROFILE") {
      steps.push({
        name: "Profile",
        status: "fail",
        detail: "No `profiles` row found for your user. Create one mapping you to a program.",
      });
    } else if (msg === "DEACTIVATED") {
      steps.push({
        name: "Account",
        status: "fail",
        detail: "Account deactivated. Contact your program administrator.",
      });
    } else {
      steps.push({
        name: "Connection",
        status: "fail",
        detail:
          e instanceof Error
            ? e.message
            : "Could not connect to database. Check .env.local (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY).",
      });
    }
  }

  const allPass = steps.every((s) => s.status === "pass");
  return NextResponse.json({
    ok: allPass,
    steps,
    needTables,
  });
}
