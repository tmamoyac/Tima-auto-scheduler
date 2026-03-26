import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side only. Use in API routes, server components, or server actions.
 * Bypasses RLS; do not expose to the client.
 *
 * Lazily creates the client on first use so `next build` can load modules that
 * import this file even when env is only present at runtime (and so missing-env
 * errors surface on first request, not at import time).
 */
let cachedAdmin: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient {
  if (cachedAdmin) return cachedAdmin;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Add them to .env.local (see README)."
    );
  }
  cachedAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
  return cachedAdmin;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getSupabaseAdmin();
    const value = Reflect.get(client, prop, receiver) as unknown;
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(client);
    }
    return value;
  },
});
