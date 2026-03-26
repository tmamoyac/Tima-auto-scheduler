import { NextResponse } from "next/server";
import { checkRemoteCpSatHealth, getCpSatCapabilities } from "@/lib/scheduler/engine/cpSatRuntime";

export const dynamic = "force-dynamic";

/**
 * CP-SAT runtime probe (same auth as other `/api/scheduler/*` routes via middleware).
 * GET — returns whether local Python+OR-Tools or remote solver is usable.
 */
export async function GET() {
  const cap = getCpSatCapabilities(true);
  let remote_health: { ok: boolean; error?: string } | undefined;
  if (cap.mode === "remote" && cap.remote_base_url) {
    remote_health = await checkRemoteCpSatHealth(cap.remote_base_url);
  }

  const ok =
    cap.mode === "remote"
      ? cap.can_invoke && (remote_health?.ok ?? false)
      : cap.can_invoke;

  return NextResponse.json(
    {
      ok,
      cp_sat: {
        mode: cap.mode,
        can_invoke: cap.can_invoke,
        executable: cap.executable,
        remote_base_url: cap.remote_base_url,
        unavailable: cap.unavailable ?? null,
        remote_health: remote_health ?? null,
      },
    },
    { status: ok ? 200 : 503 }
  );
}
