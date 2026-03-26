import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";
import {
  checkRemoteCpSatHealth,
  checkVercelPythonCpSatHealth,
  getCpSatCapabilities,
} from "@/lib/scheduler/engine/cpSatRuntime";

export const dynamic = "force-dynamic";

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
    } else if (msg === "PROGRAM_DEACTIVATED") {
      steps.push({
        name: "Program",
        status: "fail",
        detail: "Your program has been deactivated. Contact your system administrator to reactivate it.",
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

  const cap = getCpSatCapabilities(true);
  if (cap.mode === "vercel_python" && cap.vercel_python_base_url) {
    const vh = await checkVercelPythonCpSatHealth(cap.vercel_python_base_url);
    const cpDetail = vh.ok
      ? `Vercel Python CP-SAT OK (${cap.vercel_python_base_url}/api/cp_sat_vercel/health).`
      : (vh.error ?? "vercel python health failed");
    steps.push({
      name: "CP-SAT runtime",
      status: cap.can_invoke && vh.ok ? "pass" : "fail",
      detail: `${cpDetail} Mode: vercel_python.`,
    });
  } else if (cap.mode === "remote" && cap.remote_base_url) {
    const rh = await checkRemoteCpSatHealth(cap.remote_base_url);
    const cpDetail = rh.ok
      ? `Remote solver reachable (${cap.remote_base_url}).`
      : (rh.error ?? "remote health failed");
    steps.push({
      name: "CP-SAT runtime",
      status: cap.can_invoke && rh.ok ? "pass" : "fail",
      detail: cpDetail,
    });
  } else if (cap.mode === "local" && cap.can_invoke) {
    steps.push({
      name: "CP-SAT runtime",
      status: "pass",
      detail: `Local interpreter ${cap.executable ?? "python3"} with OR-Tools OK.`,
    });
  } else {
    steps.push({
      name: "CP-SAT runtime",
      status: "fail",
      detail: cap.unavailable?.message ?? "CP-SAT not available.",
    });
  }

  const allPass = steps.every((s) => s.status === "pass");
  return NextResponse.json({
    ok: allPass,
    steps,
    needTables,
  });
}
