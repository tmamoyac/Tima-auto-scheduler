import type { SupabaseClient } from "@supabase/supabase-js";

const SUPER_ADMIN_EMAILS_KEY = "SUPER_ADMIN_EMAILS";

function getSuperAdminEmails(): string[] {
  const raw = process.env[SUPER_ADMIN_EMAILS_KEY] ?? "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns true if the given email is in SUPER_ADMIN_EMAILS.
 */
export function isSuperAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const emails = getSuperAdminEmails();
  if (emails.length === 0) return false;
  return emails.includes(email.trim().toLowerCase());
}

export type SuperAdminContext = {
  userId: string;
  email: string;
};

/**
 * Returns true if the user has super admin access (env var OR profile role).
 */
export async function hasSuperAdminAccess(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return false;

    const email = user.email ?? undefined;
    if (email && isSuperAdmin(email)) return true;

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    return (profile as { role?: string } | null)?.role === "super_admin";
  } catch {
    return false;
  }
}

/**
 * Requires authenticated super admin. Throws if not.
 * Super admin = email in SUPER_ADMIN_EMAILS OR profile.role = 'super_admin'
 */
export async function requireSuperAdmin(
  supabase: SupabaseClient
): Promise<SuperAdminContext> {
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new Error("UNAUTHENTICATED");
  }

  const email = user.email ?? undefined;
  if (email && isSuperAdmin(email)) {
    return { userId: user.id, email };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if ((profile as { role?: string } | null)?.role === "super_admin") {
    return { userId: user.id, email: email ?? "" };
  }

  throw new Error("FORBIDDEN");
}
