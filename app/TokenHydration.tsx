"use client";

import { useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const TOKEN_KEY = "tima_access_token";

/**
 * Ensures sessionStorage has the auth token before API calls run.
 * Supabase session may be in localStorage; we sync to sessionStorage for apiFetch.
 */
export function TokenHydration() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.sessionStorage.getItem(TOKEN_KEY)) return;

    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      const token = session?.access_token ?? null;
      if (token) {
        window.sessionStorage.setItem(TOKEN_KEY, token);
      } else {
        supabase.auth.refreshSession().then(({ data: { session: refreshed } }) => {
          const t = refreshed?.access_token ?? null;
          if (t) window.sessionStorage.setItem(TOKEN_KEY, t);
        });
      }
    });
  }, []);

  return null;
}
