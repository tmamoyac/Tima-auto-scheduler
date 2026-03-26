import { NextResponse } from "next/server";
import {
  checkRemoteCpSatHealth,
  checkVercelPythonCpSatHealth,
  getCpSatCapabilities,
} from "@/lib/scheduler/engine/cpSatRuntime";

export const dynamic = "force-dynamic";

/**
 * CP-SAT runtime probe (same auth as other `/api/scheduler/*` routes via middleware).
 * GET — returns whether local Python+OR-Tools, remote solver, or Vercel Python function is usable.
 */
export async function GET() {
  const cap = getCpSatCapabilities(true);
  let remote_health: { ok: boolean; error?: string } | undefined;
  let vercel_python_health: Awaited<ReturnType<typeof checkVercelPythonCpSatHealth>> | undefined;

  if (cap.mode === "remote" && cap.remote_base_url) {
    remote_health = await checkRemoteCpSatHealth(cap.remote_base_url);
  }
  if (cap.mode === "vercel_python" && cap.vercel_python_base_url) {
    vercel_python_health = await checkVercelPythonCpSatHealth(cap.vercel_python_base_url);
  }

  const ok =
    cap.mode === "remote"
      ? cap.can_invoke && (remote_health?.ok ?? false)
      : cap.mode === "vercel_python"
        ? cap.can_invoke && (vercel_python_health?.ok ?? false)
        : cap.can_invoke;

  return NextResponse.json(
    {
      ok,
      cp_sat: {
        mode: cap.mode,
        can_invoke: cap.can_invoke,
        executable: cap.executable,
        remote_base_url: cap.remote_base_url,
        vercel_python_base_url: cap.vercel_python_base_url ?? null,
        unavailable: cap.unavailable ?? null,
        remote_health: remote_health ?? null,
        vercel_python_health: vercel_python_health ?? null,
      },
    },
    { status: ok ? 200 : 503 }
  );
}
