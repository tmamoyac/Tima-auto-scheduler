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
 * - academicYearIdOverride: when provided, use it if it belongs to the program; otherwise fall back to default.
 */
export async function getSchedulerContext(
  supabase: SupabaseClient,
  supabaseAdmin: SupabaseClient,
  programIdOverride?: string | null,
  academicYearIdOverride?: string | null
): Promise<SchedulerContextResult> {
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new Error("UNAUTHENTICATED");
  }

  const sa =
    isSuperAdmin(user.email ?? undefined) ||
    (await checkSuperAdminRole(supabase, user.id));

  // When URL has programId, also check role with admin client so RLS/env doesn't block super admin
  const saWithAdmin =
    sa ||
    (programIdOverride != null &&
      (await checkSuperAdminRoleWithAdmin(supabaseAdmin, user.id)));

  if (saWithAdmin && programIdOverride) {
    const { programId, academicYearId } = await resolveProgramWithAdmin(
      supabaseAdmin,
      programIdOverride,
      academicYearIdOverride
    );
    return {
      programId,
      academicYearId,
      userId: user.id,
      useAdminClient: true,
      isSuperAdmin: true,
    };
  }

  // Super admin with no URL programId: use first active program so we don't hit DEACTIVATED when profile's program is inactive
  if (sa && !programIdOverride) {
    const firstProgram = await getFirstProgram(supabaseAdmin);
    if (firstProgram) {
      const { programId, academicYearId } = await resolveProgramWithAdmin(
        supabaseAdmin,
        firstProgram.id,
        academicYearIdOverride
      );
      return {
        programId,
        academicYearId,
        userId: user.id,
        useAdminClient: true,
        isSuperAdmin: true,
      };
    }
    const ctx = await requireDirectorContext(supabase);
    return {
      programId: ctx.programId,
      academicYearId: ctx.academicYearId,
      userId: ctx.userId,
      useAdminClient: false,
      isSuperAdmin: true,
    };
  }

  const ctx = await requireDirectorContext(supabase);
  let academicYearId = ctx.academicYearId;
  if (academicYearIdOverride) {
    const valid = await validateAcademicYearBelongsToProgram(
      supabaseAdmin,
      academicYearIdOverride,
      ctx.programId
    );
    if (valid) academicYearId = academicYearIdOverride;
  }
  return {
    programId: ctx.programId,
    academicYearId,
    userId: ctx.userId,
    useAdminClient: false,
    isSuperAdmin: sa,
  };
}

async function validateAcademicYearBelongsToProgram(
  supabaseAdmin: SupabaseClient,
  academicYearId: string,
  programId: string
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("academic_years")
    .select("id")
    .eq("id", academicYearId)
    .eq("program_id", programId)
    .maybeSingle();
  return !!data?.id;
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

/** Check super_admin using admin client (bypasses RLS). Use when URL has programId so we honor it. */
async function checkSuperAdminRoleWithAdmin(
  supabaseAdmin: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  return (profile as { role?: string } | null)?.role === "super_admin";
}

async function resolveProgramWithAdmin(
  supabaseAdmin: SupabaseClient,
  programId: string,
  academicYearIdOverride?: string | null
): Promise<{ programId: string; academicYearId: string | null }> {
  const { data: program, error: progErr } = await supabaseAdmin
    .from("programs")
    .select("id")
    .eq("id", programId)
    .maybeSingle();

  if (progErr || !program?.id) {
    throw new Error("NO_PROFILE");
  }

  if (academicYearIdOverride) {
    const valid = await validateAcademicYearBelongsToProgram(
      supabaseAdmin,
      academicYearIdOverride,
      programId
    );
    if (valid) {
      return { programId, academicYearId: academicYearIdOverride };
    }
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
 * Extracts academicYearId from request search params (case-insensitive).
 */
export function getAcademicYearIdFromRequest(
  searchParams: URLSearchParams
): string | null {
  const v =
    searchParams.get("academicYearId") ?? searchParams.get("academicyearid");
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Gets program context for API routes.
 * - If user is Super Admin AND programIdFromQuery is provided and valid: use supabaseAdmin.
 * - Else: use requireDirectorContext, return anon supabase client.
 * - academicYearIdOverride: when provided, validate it belongs to the program and use it.
 */
export async function getProgramContextForRequest(
  supabase: SupabaseClient,
  supabaseAdmin: SupabaseClient,
  programIdFromQuery?: string | null,
  academicYearIdOverride?: string | null
): Promise<ProgramContextForRequest> {
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new Error("UNAUTHENTICATED");
  }

  const sa =
    isSuperAdmin(user.email ?? undefined) ||
    (await checkSuperAdminRole(supabase, user.id));

  const saWithAdmin =
    sa ||
    (programIdFromQuery != null &&
      (await checkSuperAdminRoleWithAdmin(supabaseAdmin, user.id)));

  if (saWithAdmin && programIdFromQuery) {
    const { programId, academicYearId } = await resolveProgramWithAdmin(
      supabaseAdmin,
      programIdFromQuery,
      academicYearIdOverride
    );
    return {
      programId,
      academicYearId,
      supabase: supabaseAdmin,
      userId: user.id,
    };
  }

  const ctx = await requireDirectorContext(supabase);
  let academicYearId = ctx.academicYearId;
  if (academicYearIdOverride) {
    const valid = await validateAcademicYearBelongsToProgram(
      supabaseAdmin,
      academicYearIdOverride,
      ctx.programId
    );
    if (valid) academicYearId = academicYearIdOverride;
  }
  return {
    programId: ctx.programId,
    academicYearId,
    supabase,
    userId: ctx.userId,
  };
}
