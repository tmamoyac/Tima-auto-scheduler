import type { SupabaseClient } from "@supabase/supabase-js";
import { isSuperAdmin } from "./superAdmin";

export type DirectorContext = {
  userId: string;
  programId: string;
  academicYearId: string | null;
};

export async function requireDirectorContext(
  supabase: SupabaseClient
): Promise<DirectorContext> {
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new Error("UNAUTHENTICATED");
  }

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("program_id, is_active")
    .eq("id", user.id)
    .single();

  if (profileErr || !profile?.program_id) {
    throw new Error("NO_PROFILE");
  }

  const isActive = profile?.is_active !== false;
  if (!isActive && !isSuperAdmin(user.email ?? undefined)) {
    throw new Error("DEACTIVATED"); // User account deactivated
  }

  const programId = profile.program_id as string;

  const { data: program } = await supabase
    .from("programs")
    .select("is_active")
    .eq("id", programId)
    .maybeSingle();

  const programIsActive = (program as { is_active?: boolean } | null)?.is_active !== false;
  if (!programIsActive && !isSuperAdmin(user.email ?? undefined)) {
    throw new Error("PROGRAM_DEACTIVATED"); // Program deactivated (user may still be active)
  }

  const today = new Date().toISOString().slice(0, 10);

  let academicYearId: string | null = null;

  const { data: currentYear, error: currentErr } = await supabase
    .from("academic_years")
    .select("id")
    .eq("program_id", programId)
    .lte("start_date", today)
    .gte("end_date", today)
    .limit(1)
    .maybeSingle();

  if (!currentErr && currentYear?.id) {
    academicYearId = currentYear.id as string;
  } else {
    const { data: fallbackYear } = await supabase
      .from("academic_years")
      .select("id")
      .eq("program_id", programId)
      .order("end_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    academicYearId = (fallbackYear?.id as string | undefined) ?? null;
  }

  return { userId: user.id, programId, academicYearId };
}

export function directorAuthErrorResponse(e: unknown): { status: number; error: string } | null {
  const msg = e instanceof Error ? e.message : "";
  if (msg === "UNAUTHENTICATED") return { status: 401, error: "Unauthorized" };
  if (msg === "NO_PROFILE") return { status: 403, error: "No profile found for user" };
  if (msg === "DEACTIVATED") return { status: 403, error: "Account deactivated" };
  if (msg === "PROGRAM_DEACTIVATED") return { status: 403, error: "Program deactivated" };
  return null;
}

