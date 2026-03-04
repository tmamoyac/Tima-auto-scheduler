"use client";

import { useState } from "react";
import Link from "next/link";

export default function SetupPasswordPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/setup-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          setupKey,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-sm p-6">
          <h1 className="text-2xl font-semibold mb-2 text-green-700">Password set</h1>
          <p className="text-gray-600 mb-4">You can now sign in with your new password.</p>
          <Link
            href="/login"
            className="inline-block rounded-md bg-blue-600 text-white py-2 px-4 text-sm font-semibold hover:bg-blue-700"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-sm p-6">
        <h1 className="text-2xl font-semibold mb-2">Set your password</h1>
        <p className="text-sm text-gray-600 mb-6">
          Use this if you&apos;re locked out. You need the setup key from .env.local (SETUP_SECRET).
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="tmamoyac@gmail.com"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">New password</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              minLength={6}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="At least 6 characters"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">Setup key</label>
            <input
              value={setupKey}
              onChange={(e) => setSetupKey(e.target.value)}
              type="text"
              required
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="From SETUP_SECRET in .env.local"
            />
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-blue-600 text-white py-2 text-sm font-semibold disabled:opacity-60"
          >
            {loading ? "Setting…" : "Set password"}
          </button>
        </form>

        <p className="mt-4 text-sm text-gray-500">
          <Link href="/login" className="text-blue-600 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
