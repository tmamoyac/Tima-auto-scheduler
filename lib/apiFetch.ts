"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const TOKEN_KEY = "tima_access_token";

/**
 * Fetch with auth token - use for admin/super-admin/scheduler API routes.
 * Bypasses cookie issues on Vercel by sending Bearer token.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let token: string | null = null;
  if (typeof window !== "undefined") {
    token = window.sessionStorage.getItem(TOKEN_KEY);
  }
  if (!token) {
    const supabase = createSupabaseBrowserClient();
    const session = (await supabase.auth.getSession()).data.session;
    token = session?.access_token ?? null;
    if (!token) {
      const { data } = await supabase.auth.refreshSession();
      token = data.session?.access_token ?? null;
      if (token && typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_KEY, token);
      }
    }
  }
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-Tima-Token", token);
  }
  const res = await fetch(input, { ...init, headers, credentials: "include" });
  if (res.status === 401 && typeof window !== "undefined") {
    window.sessionStorage.removeItem(TOKEN_KEY);
  }
  return res;
}
