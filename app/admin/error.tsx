"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Admin error:", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F7F9FC]">
      <div className="max-w-md w-full rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-red-600 mb-2">Something went wrong</h2>
        <p className="text-sm text-gray-600 mb-4">{error.message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
          >
            Try again
          </button>
          <Link
            href="/login"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Back to login
          </Link>
        </div>
      </div>
    </div>
  );
}
