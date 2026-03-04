"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

function parseHashParams(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const hash = window.location.hash?.slice(1) || "";
  return Object.fromEntries(new URLSearchParams(hash));
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "recovery" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const params = parseHashParams();
    const type = params.type;
    const accessToken = params.access_token;
    const refreshToken = params.refresh_token;

    if (type === "recovery" && accessToken && refreshToken) {
      const supabase = createSupabaseBrowserClient();
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken })
        .then(() => {
          // Clear the hash from URL (tokens are now in session)
          window.history.replaceState(null, "", window.location.pathname);
          setStatus("recovery");
        })
        .catch((err) => {
          setError(err?.message ?? "Invalid or expired link.");
          setStatus("error");
        });
      return;
    }

    if (accessToken) {
      router.replace("/admin/scheduler?tab=setup");
      return;
    }

    setStatus("error");
    setError(params.error_description?.replace(/\+/g, " ") || "Invalid or expired link.");
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setStatus("done");
      setTimeout(() => router.replace("/login"), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <p className="text-gray-600">Loading…</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-sm p-6">
          <h1 className="text-2xl font-semibold mb-2">Reset link invalid</h1>
          <p className="text-gray-600 mb-4">{error}</p>
          <p className="text-sm text-gray-600">
            Request a new password reset from your program administrator or try again.
          </p>
          <a
            href="/login"
            className="mt-4 inline-block text-blue-600 hover:underline font-medium"
          >
            Back to sign in
          </a>
        </div>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-sm p-6">
          <h1 className="text-2xl font-semibold mb-2">Password updated</h1>
          <p className="text-gray-600">Redirecting you to sign in…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-sm p-6">
        <h1 className="text-2xl font-semibold mb-2">Set new password</h1>
        <p className="text-sm text-gray-600 mb-6">
          Enter your new password below.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">New password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="At least 6 characters"
            />
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-blue-600 text-white py-2 text-sm font-semibold disabled:opacity-60"
          >
            {submitting ? "Updating…" : "Set password"}
          </button>
        </form>
      </div>
    </div>
  );
}
