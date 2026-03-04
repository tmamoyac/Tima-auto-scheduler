"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function SchedulerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Scheduler error:", error);
  }, [error]);

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-red-600 mb-2">Something went wrong</h2>
      <p className="text-sm text-gray-600 mb-4">{error.message}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Try again
        </button>
        <Link
          href="/login"
          className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
        >
          Back to login
        </Link>
      </div>
    </div>
  );
}
