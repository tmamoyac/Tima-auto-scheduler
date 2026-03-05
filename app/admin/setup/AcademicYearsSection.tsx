"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";
import { formatAcademicYearCompact } from "@/lib/dateUtils";

type AcademicYear = { id: string; label: string; start_date: string; end_date: string };

export function AcademicYearsSection({
  programId,
  currentAcademicYearId,
  onYearCreated,
}: {
  programId: string;
  currentAcademicYearId: string;
  onYearCreated?: (yearId: string) => void;
}) {
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/admin/academic-years?programId=${encodeURIComponent(programId)}`;
      const res = await apiFetch(url, { cache: "no-store", credentials: "include" });
      const data = await safeParseJson<AcademicYear[] | { error?: string }>(res);
      if (!res.ok) throw new Error(typeof data === "object" && data && "error" in data ? data.error : "Failed to load");
      if (Array.isArray(data)) setYears(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load academic years");
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!startDate || !endDate) {
      setCreateError("Start and end date are required.");
      return;
    }
    if (startDate >= endDate) {
      setCreateError("End date must be after start date.");
      return;
    }
    setCreateError(null);
    setSaving(true);
    try {
      const url = `/api/admin/academic-years?programId=${encodeURIComponent(programId)}`;
      const res = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          ...(label.trim() ? { label: label.trim() } : {}),
        }),
      });
      const data = await safeParseJson<AcademicYear | { error?: string }>(res);
      if (!res.ok) {
        throw new Error(typeof data === "object" && data && "error" in data ? data.error : "Failed to create");
      }
      const created = data as AcademicYear;
      setAdding(false);
      setStartDate("");
      setEndDate("");
      setLabel("");
      await load();
      onYearCreated?.(created.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create academic year");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Academic Years</h2>
        <p className="text-sm text-gray-500">
          Create academic years for your program. Vacation requests are restricted to the selected year.
        </p>
      </div>
      {loading ? (
        <p className="text-sm text-gray-500 py-4">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600 py-4">{error}</p>
      ) : (
        <>
          <div className="divide-y divide-gray-100">
            {years.map((y) => (
              <div key={y.id} className="py-3 first:pt-0 flex items-center justify-between">
                <span className="text-sm text-gray-900">
                  {formatAcademicYearCompact(y.start_date, y.end_date) || y.label || y.id}
                  {y.label && y.label !== formatAcademicYearCompact(y.start_date, y.end_date) && (
                    <span className="text-gray-500 ml-2">({y.label})</span>
                  )}
                </span>
                {y.id === currentAcademicYearId && (
                  <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                    Current
                  </span>
                )}
              </div>
            ))}
          </div>
          {!adding ? (
            <button
              type="button"
              className="mt-4 text-sm px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg"
              onClick={() => setAdding(true)}
            >
              + Add Academic Year
            </button>
          ) : (
            <div className="mt-4 p-4 rounded-lg border border-gray-200 bg-gray-50 space-y-3">
              <div className="flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Start date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">End date</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Label (optional)</label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. 2026-2027"
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-32"
                  />
                </div>
                <button
                  type="button"
                  className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                  onClick={handleCreate}
                  disabled={saving}
                >
                  {saving ? "Creating…" : "Create"}
                </button>
                <button
                  type="button"
                  className="px-3 py-2 bg-gray-200 hover:bg-gray-300 text-sm rounded-lg"
                  onClick={() => {
                    setAdding(false);
                    setStartDate("");
                    setEndDate("");
                    setLabel("");
                    setCreateError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              {createError && <p className="text-sm text-red-600">{createError}</p>}
              <p className="text-xs text-gray-500">
                Academic year should span 11–13 months (e.g. July 1 – June 30).
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
