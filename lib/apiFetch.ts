"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

/**
 * Fetch with auth token - use for admin/super-admin/scheduler API routes.
 * Bypasses cookie issues on Vercel by sending Bearer token.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const supabase = createSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  if (session?.access_token) {
    headers.set("Authorization", `Bearer ${session.access_token}`);
  }
  return fetch(input, { ...init, headers, credentials: "include" });
}
