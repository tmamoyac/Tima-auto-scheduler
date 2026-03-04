import type { SupabaseClient } from "@supabase/supabase-js";
import { isSuperAdmin } from "./superAdmin";
import { requireDirectorContext } from "./directorContext";

export type SchedulerContextResult = {
  programId: string;
  academicYearId: string | null;
  userId: string;
  useAdminClient: boolean;
  isSuperAdmin: boolean;
};

/**
 * Gets scheduler context for the scheduler page.
 * - If user is Super Admin AND programIdOverride is provided and valid: use supabaseAdmin, return that program's context.
 * - Else: use requireDirectorContext (profile's program_id).
 */
export async function getSchedulerContext(
  supabase: SupabaseClient,
  supabaseAdmin: SupabaseClient,
  programIdOverride?: string | null
): Promise<SchedulerContextResult> {
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new Error("UNAUTHENTICATED");
  }

  const sa = isSuperAdmin(user.email ?? undefined) || await checkSuperAdminRole(supabase, user.id);

  if (sa && programIdOverride) {
    const { programId, academicYearId } = await resolveProgramWithAdmin(
      supabaseAdmin,
      programIdOverride
    );
    return {
      programId,
      academicYearId,
      userId: user.id,
      useAdminClient: true,
      isSuperAdmin: true,
    };
  }

  if (sa && !programIdOverride) {
    try {
      const ctx = await requireDirectorContext(supabase);
      return {
        programId: ctx.programId,
        academicYearId: ctx.academicYearId,
        userId: ctx.userId,
        useAdminClient: false,
        isSuperAdmin: true,
      };
    } catch (e) {
      if (e instanceof Error && e.message === "NO_PROFILE") {
        const firstProgram = await getFirstProgram(supabaseAdmin);
        if (firstProgram) {
          const { programId, academicYearId } = await resolveProgramWithAdmin(
            supabaseAdmin,
            firstProgram.id
          );
          return {
            programId,
            academicYearId,
            userId: user.id,
            useAdminClient: true,
            isSuperAdmin: true,
          };
        }
      }
      throw e;
    }
  }

  const ctx = await requireDirectorContext(supabase);
  return {
    programId: ctx.programId,
    academicYearId: ctx.academicYearId,
    userId: ctx.userId,
    useAdminClient: false,
    isSuperAdmin: sa,
  };
}

async function getFirstProgram(
  supabaseAdmin: SupabaseClient
): Promise<{ id: string } | null> {
  const { data } = await supabaseAdmin
    .from("programs")
    .select("id")
    .eq("is_active", true)
    .order("name")
    .limit(1)
    .maybeSingle();
  return data as { id: string } | null;
}

async function checkSuperAdminRole(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  return (profile as { role?: string } | null)?.role === "super_admin";
}

async function resolveProgramWithAdmin(
  supabaseAdmin: SupabaseClient,
  programId: string
): Promise<{ programId: string; academicYearId: string | null }> {
  const { data: program, error: progErr } = await supabaseAdmin
    .from("programs")
    .select("id")
    .eq("id", programId)
    .maybeSingle();

  if (progErr || !program?.id) {
    throw new Error("NO_PROFILE");
  }

  const today = new Date().toISOString().slice(0, 10);

  const { data: currentYear, error: currentErr } = await supabaseAdmin
    .from("academic_years")
    .select("id")
    .eq("program_id", programId)
    .lte("start_date", today)
    .gte("end_date", today)
    .limit(1)
    .maybeSingle();

  if (!currentErr && currentYear?.id) {
    return { programId, academicYearId: currentYear.id as string };
  }

  const { data: fallbackYear } = await supabaseAdmin
    .from("academic_years")
    .select("id")
    .eq("program_id", programId)
    .order("end_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    programId,
    academicYearId: (fallbackYear?.id as string | undefined) ?? null,
  };
}

export type ProgramContextForRequest = {
  programId: string;
  academicYearId: string | null;
  supabase: SupabaseClient;
  userId: string;
};

/**
 * Extracts programId from request search params (case-insensitive).
 */
export function getProgramIdFromRequest(
  searchParams: URLSearchParams
): string | null {
  const v = searchParams.get("programId") ?? searchParams.get("programid");
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Gets program context for API routes.
 * - If user is Super Admin AND programIdFromQuery is provided and valid: use supabaseAdmin.
 * - Else: use requireDirectorContext, return anon supabase client.
 */
export async function getProgramContextForRequest(
  supabase: SupabaseClient,
  supabaseAdmin: SupabaseClient,
  programIdFromQuery?: string | null
): Promise<ProgramContextForRequest> {
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new Error("UNAUTHENTICATED");
  }

  const sa = isSuperAdmin(user.email ?? undefined) || await checkSuperAdminRole(supabase, user.id);

  if (sa && programIdFromQuery) {
    const { programId, academicYearId } = await resolveProgramWithAdmin(
      supabaseAdmin,
      programIdFromQuery
    );
    return {
      programId,
      academicYearId,
      supabase: supabaseAdmin,
      userId: user.id,
    };
  }

  const ctx = await requireDirectorContext(supabase);
  return {
    programId: ctx.programId,
    academicYearId: ctx.academicYearId,
    supabase,
    userId: ctx.userId,
  };
}
