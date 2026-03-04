"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";

type Program = { id: string; name: string };

export function ProgramSwitcher({
  programId,
  currentTab,
}: {
  programId: string;
  currentTab: string;
}) {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    let mounted = true;
    setFetchError(false);
    apiFetch("/api/super-admin/programs?activeOnly=true")
      .then(async (res) => {
        const data = await safeParseJson<Program[] | { error?: string }>(res);
        if (!res.ok) throw new Error("Failed");
        return Array.isArray(data) ? data : [];
      })
      .then((data: Program[]) => {
        if (mounted) setPrograms(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (mounted) {
          setPrograms([]);
          setFetchError(true);
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const tab = currentTab === "setup" || currentTab === "schedule" ? currentTab : "schedule";

  return (
    <div className="flex items-center gap-2 mb-4">
      <svg
        className="w-4 h-4 text-gray-500 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
      <label htmlFor="program-switcher" className="text-sm font-medium text-gray-700">
        Program:
      </label>
      <form
        method="get"
        action="/admin/scheduler"
        className="inline-block"
        onSubmit={(e) => e.preventDefault()}
      >
        <input type="hidden" name="tab" value={tab} />
        <select
          id="program-switcher"
          name="programId"
          key={programId}
          defaultValue={programId}
          onChange={(e) => {
            const selected = e.target.value;
            if (!selected) return;
            const params = new URLSearchParams({ tab, programId: selected });
            window.location.assign(`/admin/scheduler?${params.toString()}`);
          }}
          disabled={loading || programs.length === 0}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium bg-white min-w-[220px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:opacity-60 disabled:cursor-not-allowed"
        >
        {loading ? (
          <option value="">Loading programs…</option>
        ) : fetchError ? (
          <option value="">Failed to load programs</option>
        ) : programs.length === 0 ? (
          <option value="">No programs</option>
        ) : (
          programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))
        )}
      </select>
      </form>
      {(loading || fetchError || programs.length === 0) && (
        <span className="text-xs text-gray-500 ml-1">
          {loading ? "Loading…" : fetchError ? "Check Super Admin login" : "No programs"}
        </span>
      )}
    </div>
  );
}
