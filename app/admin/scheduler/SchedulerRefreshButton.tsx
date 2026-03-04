"use client";

export function SchedulerRefreshButton() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
    >
      Refresh (load latest residents & rotations)
    </button>
  );
}
