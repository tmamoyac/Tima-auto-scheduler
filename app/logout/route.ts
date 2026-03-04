import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * POST-only logout. Using POST prevents Next.js RSC prefetching, bot
 * crawlers, and browser preloading from accidentally triggering sign-out.
 */
export async function POST(request: NextRequest) {
  const cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookies) {
          cookiesToSet.push(
            ...cookies.map((c) => ({
              name: c.name,
              value: c.value,
              options: (c.options ?? {}) as Record<string, unknown>,
            }))
          );
        },
      },
    }
  );

  await supabase.auth.signOut();

  const response = NextResponse.redirect(
    new URL("/login?logout=1", request.url)
  );

  for (const { name, value, options } of cookiesToSet) {
    response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2]);
  }

  return response;
}

/**
 * GET fallback — redirect to login without signing out.
 * This prevents RSC prefetch or stale bookmarks from nuking the session.
 */
export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL("/login?logout=1", request.url));
}
