"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { TimaLogo } from "@/app/components/TimaLogo";

const TOKEN_KEY = "tima_access_token";

export default function LoginPage() {
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get("next") || "/admin/scheduler?tab=setup";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("logout") === "1" && typeof window !== "undefined") {
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  }, [searchParams]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        access_token?: string;
        refresh_token?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Login failed");

      // Store token for apiFetch (bypasses Supabase storage issues on Vercel)
      if (data.access_token) {
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(TOKEN_KEY, data.access_token);
        }
        const supabase = createSupabaseBrowserClient();
        await supabase.auth.setSession({
          access_token: data.access_token,
          refresh_token: data.refresh_token || "",
        });
      }

      window.location.href = nextUrl;
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Brand panel - left on desktop, top on mobile */}
      <div className="lg:w-1/2 min-h-[140px] lg:min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 px-8 py-12 lg:py-24">
        <div className="text-center lg:text-left max-w-lg">
          <div className="flex items-center justify-center lg:justify-start gap-3">
            <TimaLogo className="w-12 h-12 lg:w-14 lg:h-14 text-white shrink-0" />
            <h1 className="text-4xl lg:text-5xl font-bold text-white tracking-tight">Tima</h1>
          </div>
          <p className="mt-4 text-lg lg:text-xl text-slate-300">
            Smarter Scheduling for residency programs
          </p>
          <div className="mt-8 h-px w-16 bg-slate-600 mx-auto lg:mx-0" aria-hidden />
        </div>
      </div>

      {/* Form panel - right on desktop, below on mobile */}
      <div className="lg:w-1/2 flex items-center justify-center bg-white px-6 py-12 lg:py-24">
        <div className="w-full max-w-md">
          <div className="rounded-xl border border-gray-100 bg-white shadow-lg p-8">
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">Sign in</h2>
            <p className="text-sm text-gray-600 mb-6">
              Use your director account email + password.
            </p>

            <form onSubmit={onSubmit} className="space-y-4">
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700">Email</label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="email"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-700">Password</label>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete="current-password"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              <p className="text-sm text-gray-500">
                Can&apos;t log in?{" "}
                <Link href="/setup-password" className="text-indigo-600 hover:text-indigo-700 font-medium hover:underline">
                  Set your password
                </Link>
              </p>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-indigo-600 text-white py-2.5 text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
