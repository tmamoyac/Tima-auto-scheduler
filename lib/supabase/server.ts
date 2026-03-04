import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";

/**
 * Extract Bearer token from incoming request headers.
 * Checks Authorization header first, then X-Tima-Token as a fallback
 * (in case the host strips the Authorization header).
 */
function getBearerToken(): string | null {
  try {
    const h = headers();
    const auth = h.get("authorization");
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
    const x = h.get("x-tima-token");
    return x?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Creates a Supabase client for use in Server Components, Route Handlers,
 * and Server Actions.
 *
 * - If the request carries a Bearer token (from apiFetch), a plain
 *   supabase-js client is returned that authenticates via that token.
 * - Otherwise a cookie-based @supabase/ssr client is returned that reads
 *   and writes auth cookies through Next.js's cookies() store.
 */
export function createSupabaseServerClient(_request?: unknown) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const token = getBearerToken();
  if (token) {
    return createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  }

  const cookieStore = cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, (options ?? {}) as Parameters<typeof cookieStore.set>[2])
          );
        } catch {
          // cookies().set() throws in read-only contexts (Server Components).
          // This is expected — the middleware handles cookie updates instead.
        }
      },
    },
  });
}
