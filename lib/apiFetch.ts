"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const TOKEN_KEY = "tima_access_token";

let tokenPromise: Promise<string | null> | null = null;

async function getToken(): Promise<string | null> {
  if (typeof window !== "undefined") {
    const cached = window.sessionStorage.getItem(TOKEN_KEY);
    if (cached) return cached;
  }
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    try {
      const supabase = createSupabaseBrowserClient();
      const session = (await supabase.auth.getSession()).data.session;
      let token = session?.access_token ?? null;
      if (!token) {
        const { data } = await supabase.auth.refreshSession();
        token = data.session?.access_token ?? null;
      }
      if (token && typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_KEY, token);
      }
      return token;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

function clearTokenPromise() {
  tokenPromise = null;
}

async function doFetch(input: RequestInfo | URL, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-Tima-Token", token);
  }
  return fetch(input, { ...init, headers, credentials: "include" });
}

/**
 * Fetch with auth token - use for admin/super-admin/scheduler API routes.
 * Bypasses cookie issues on Vercel by sending Bearer token.
 * Retries once on 401 after refreshing the session (handles race where token was not ready).
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const mergedInit = { ...init, credentials: "include" as RequestCredentials };
  let token = await getToken();
  let res = await doFetch(input, mergedInit, token);

  if (res.status === 401 && typeof window !== "undefined") {
    window.sessionStorage.removeItem(TOKEN_KEY);
    clearTokenPromise();
    token = await getToken();
    if (token) {
      res = await doFetch(input, mergedInit, token);
    }
  }

  return res;
}
