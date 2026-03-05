"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";

type AcademicYear = {
  id: string;
  label?: string;
  start_date: string;
  end_date: string;
};

function formatYearRange(start: string, end: string): string {
  if (!start || !end) return "";
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

export function AcademicYearSection({
  programId: programIdProp,
  academicYearId: currentYearId,
  academicYearStart,
  academicYearEnd,
}: {
  programId: string;
  academicYearId: string;
  academicYearStart: string;
  academicYearEnd: string;
}) {
  const searchParams = useSearchParams();
  const programIdFromUrl = searchParams.get("programId") ?? searchParams.get("programid");
  const programId =
    typeof programIdFromUrl === "string" && programIdFromUrl.length > 0 ? programIdFromUrl : programIdProp;

  const [years, setYears] = useState<AcademicYear[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingYear, setEditingYear] = useState<AcademicYear | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadYears = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/academic-years?programId=${encodeURIComponent(programId)}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await safeParseJson<AcademicYear[] | { error?: string }>(res);
      if (!res.ok) throw new Error("error" in data ? data.error : "Failed to load");
      setYears(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setYears([]);
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    loadYears();
  }, [loadYears]);

  const openModal = () => {
    setStartDate("");
    setEndDate("");
    setError(null);
    setModalOpen(true);
  };

  const createYear = async () => {
    if (!startDate || !endDate) {
      setError("Start and end dates are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/academic-years?programId=${encodeURIComponent(programId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
        credentials: "include",
      });
      const data = await safeParseJson<AcademicYear | { error?: string }>(res);
      if (!res.ok) throw new Error("error" in data ? data.error : "Failed to create");
      const created = data as AcademicYear;
      setModalOpen(false);
      // Reload page with new academic year so it becomes the active one
      const params = new URLSearchParams(window.location.search);
      params.set("tab", "setup");
      params.set("programId", programId);
      params.set("academicYearId", created.id);
      window.location.href = `${window.location.pathname}?${params.toString()}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create academic year");
    } finally {
      setSaving(false);
    }
  };

  const switchToYear = (id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "setup");
    params.set("programId", programId);
    params.set("academicYearId", id);
    window.location.href = `${window.location.pathname}?${params.toString()}`;
  };

  const openEditModal = (y: AcademicYear) => {
    setEditingYear(y);
    setEditLabel(y.label ?? "");
    setEditStartDate(y.start_date ?? "");
    setEditEndDate(y.end_date ?? "");
    setError(null);
    setEditModalOpen(true);
  };

  const closeEditModal = () => {
    setEditModalOpen(false);
    setEditingYear(null);
    setError(null);
  };

  const saveEdit = async () => {
    if (!editingYear) return;
    if (!editStartDate || !editEndDate) {
      setError("Start and end dates are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/admin/academic-years/${encodeURIComponent(editingYear.id)}?programId=${encodeURIComponent(programId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: editLabel.trim() || undefined,
            start_date: editStartDate,
            end_date: editEndDate,
          }),
          credentials: "include",
        }
      );
      const data = await safeParseJson<AcademicYear | { error?: string }>(res);
      if (!res.ok) throw new Error("error" in data ? data.error : "Failed to update");
      closeEditModal();
      await loadYears();
      if (editingYear.id === currentYearId) {
        const params = new URLSearchParams(window.location.search);
        params.set("tab", "setup");
        params.set("programId", programId);
        params.set("academicYearId", editingYear.id);
        window.location.href = `${window.location.pathname}?${params.toString()}`;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update academic year");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
        <p className="text-sm text-indigo-900">
          <span className="font-semibold">Academic year:</span>{" "}
          {academicYearStart && academicYearEnd
            ? formatYearRange(academicYearStart, academicYearEnd)
            : "None set for this program."}{" "}
          Set one so vacation and schedule use the correct dates.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button
          type="button"
          onClick={openModal}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
        >
          + Add academic year
        </button>
      </div>
      {loading ? (
        <p className="text-sm text-gray-500">Loading years…</p>
      ) : error && years.length === 0 ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : years.length > 0 ? (
        <ul className="space-y-2">
          {years.map((y) => (
            <li key={y.id} className="flex items-center justify-between gap-3 py-2 border-b border-gray-100 last:border-0">
              <span className="text-sm text-gray-700">
                {formatYearRange(y.start_date, y.end_date)}
                {y.id === currentYearId && (
                  <span className="ml-2 text-indigo-600 font-medium">(current)</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openEditModal(y)}
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium"
                >
                  Edit
                </button>
                {y.id !== currentYearId && (
                  <button
                    type="button"
                    onClick={() => switchToYear(y.id)}
                    className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
                  >
                    Use this year
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No academic years yet. Add one above.</p>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Add academic year</h3>
            <p className="text-sm text-gray-600 mb-4">
              Choose start and end dates. The range must span 11–13 months (e.g. Jul 1 – Jun 30).
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Start date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">End date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
            <div className="flex gap-3 mt-6">
              <button
                type="button"
                onClick={createYear}
                disabled={saving || !startDate || !endDate}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
              >
                {saving ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                disabled={saving}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-sm font-medium rounded-lg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {editModalOpen && editingYear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Edit academic year</h3>
            <p className="text-sm text-gray-600 mb-4">
              Change label or start/end dates. Dates must span 11–13 months and not overlap other years.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Label (optional)</label>
                <input
                  type="text"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  placeholder="e.g. 2025-2026"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Start date</label>
                <input
                  type="date"
                  value={editStartDate}
                  onChange={(e) => setEditStartDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">End date</label>
                <input
                  type="date"
                  value={editEndDate}
                  onChange={(e) => setEditEndDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
            <div className="flex gap-3 mt-6">
              <button
                type="button"
                onClick={saveEdit}
                disabled={saving || !editStartDate || !editEndDate}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeEditModal}
                disabled={saving}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-sm font-medium rounded-lg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
