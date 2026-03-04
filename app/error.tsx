"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-red-600">Something went wrong</h2>
      <p className="mt-2 text-sm text-gray-600">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded bg-gray-200 px-3 py-2 text-sm"
      >
        Try again
      </button>
    </div>
  );
}
