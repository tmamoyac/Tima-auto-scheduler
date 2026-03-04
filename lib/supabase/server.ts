import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function createSupabaseServerClient(request?: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request && "cookies" in request ? request.cookies.getAll() : cookies().getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        if (!request) {
          const store = cookies();
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options ?? {});
          }
        }
        // In Route Handlers, middleware handles cookie refresh; we only need to read
      },
    },
  });
}

