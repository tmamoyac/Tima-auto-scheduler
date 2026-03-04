"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Redirects to /auth/callback when the URL has a Supabase auth recovery hash
 * (e.g. from password reset email). The hash is only present client-side.
 */
export function AuthCallbackRedirect() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === "/auth/callback") return;
    if (typeof window === "undefined") return;

    const hash = window.location.hash?.slice(1) || "";
    const params = new URLSearchParams(hash);
    const type = params.get("type");
    const hasToken = params.has("access_token");

    if (type === "recovery" && hasToken) {
      window.location.replace(`/auth/callback${window.location.hash}`);
    }
  }, [pathname]);

  return null;
}
