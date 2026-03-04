"use client";

import { useEffect } from "react";

export default function SuperAdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Super Admin error:", error);
  }, [error]);

  return (
    <div className="p-6 min-h-screen flex items-center justify-center">
      <div className="max-w-md w-full rounded-lg border border-red-200 bg-red-50 p-6">
        <h1 className="text-xl font-semibold text-red-800 mb-2">Something went wrong</h1>
        <p className="text-sm text-red-700 mb-4">{error.message}</p>
        <p className="text-xs text-red-600 mb-4">
          Check the browser console and server logs for details. Ensure SUPABASE_SERVICE_ROLE_KEY
          and SUPER_ADMIN_EMAILS are set in .env.local.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700"
          >
            Try again
          </button>
          <a
            href="/admin/scheduler"
            className="inline-block px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100 no-underline text-gray-900"
          >
            Back to Scheduler
          </a>
        </div>
      </div>
    </div>
  );
}
