import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { parse } from "cookie";

/** Extract Bearer token from request. Checks Authorization + X-Tima-Token (fallback if Auth header stripped). */
function getBearerToken(request?: NextRequest): string | null {
  const getAuth = (h: Headers | null) => {
    if (!h) return null;
    const auth = h.get("authorization");
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
    const x = h.get("x-tima-token");
    return x?.trim() || null;
  };
  let token = request && "headers" in request ? getAuth((request as Request).headers) : null;
  if (!token) {
    try {
      token = getAuth(headers());
    } catch {
      /* ignore */
    }
  }
  return token;
}

/** Parse Cookie header into Supabase-expected { name, value }[] */
function getAllFromCookieHeader(cookieHeader: string | null): { name: string; value: string }[] {
  if (!cookieHeader?.trim()) return [];
  const parsed = parse(cookieHeader);
  return Object.entries(parsed).map(([name, value]) => ({ name, value: value ?? "" }));
}

export function createSupabaseServerClient(request?: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const token = getBearerToken(request);
  if (token) {
    return createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  }

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        if (request) {
          if ("cookies" in request && typeof (request as { cookies: { getAll: () => { name: string; value: string }[] } }).cookies?.getAll === "function") {
            return (request as { cookies: { getAll: () => { name: string; value: string }[] } }).cookies.getAll();
          }
          const cookieHeader = "headers" in request ? (request as Request).headers.get("cookie") : null;
          const fromHeader = getAllFromCookieHeader(cookieHeader);
          if (fromHeader.length > 0) return fromHeader;
        }
        return cookies().getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        const store = cookies();
        for (const { name, value, options } of cookiesToSet) {
          store.set(name, value, (options ?? {}) as Parameters<typeof store.set>[2]);
        }
      },
    },
  });
}

