"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import { GenerateScheduleButton } from "./GenerateScheduleButton";

type FixedRow = {
  id: string;
  resident_id: string;
  month_id: string;
  rotation_id: string;
  resident_name: string;
  month_label: string;
  rotation_name: string;
};

export function FixedAssignmentsDebugPanel({
  programId,
  academicYearId,
}: {
  programId: string;
  academicYearId: string;
}) {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<FixedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearMsg, setClearMsg] = useState<string | null>(null);

  const effectiveProgramId =
    searchParams.get("programId") ?? searchParams.get("programid") ?? programId;

  const load = useCallback(async () => {
    if (!academicYearId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/admin/fixed-assignment-rules?academicYearId=${encodeURIComponent(academicYearId)}&programId=${encodeURIComponent(effectiveProgramId)}`
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        setRows([]);
        return;
      }
      const data = (await res.json()) as FixedRow[];
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [academicYearId, effectiveProgramId]);

  useEffect(() => {
    void load();
  }, [load]);

  const clearAll = async () => {
    if (
      !confirm(
        "Delete all fixed assignments for this academic year? This cannot be undone. You can re-add them from setup if needed."
      )
    ) {
      return;
    }
    setClearMsg(null);
    try {
      const res = await apiFetch(
        `/api/admin/fixed-assignment-rules?academicYearId=${encodeURIComponent(academicYearId)}&programId=${encodeURIComponent(effectiveProgramId)}`,
        { method: "DELETE" }
      );
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        deletedCount?: number;
      };
      if (!res.ok) {
        setClearMsg(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setClearMsg(`Cleared ${j.deletedCount ?? 0} fixed assignment(s).`);
      await load();
    } catch (e) {
      setClearMsg(e instanceof Error ? e.message : "Delete failed");
    }
  };

  if (!academicYearId) return null;

  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-800 mb-1">Active Fixed Assignments</h2>
      <p className="text-xs text-slate-600 mb-3">
        Rows come from <code className="text-[11px]">fixed_assignment_rules</code>. The database does not store how each
        row was created (UI lock, import, etc.); provenance is not available from the API.
      </p>
      {loading ? (
        <p className="text-sm text-slate-500">Loading fixed rules…</p>
      ) : error ? (
        <p className="text-sm text-red-700">{error}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-600">No fixed assignment rules for this academic year.</p>
      ) : (
        <div className="overflow-x-auto mb-3">
          <table className="min-w-full border-collapse border border-slate-200 text-sm">
            <thead>
              <tr className="bg-slate-50">
                <th className="border border-slate-200 px-2 py-1.5 text-left font-medium">Resident</th>
                <th className="border border-slate-200 px-2 py-1.5 text-left font-medium">Month</th>
                <th className="border border-slate-200 px-2 py-1.5 text-left font-medium">Rotation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="border border-slate-200 px-2 py-1.5">{r.resident_name || r.resident_id}</td>
                  <td className="border border-slate-200 px-2 py-1.5">{r.month_label || r.month_id}</td>
                  <td className="border border-slate-200 px-2 py-1.5">{r.rotation_name || r.rotation_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <GenerateScheduleButton
          programId={effectiveProgramId}
          omitFixedAssignmentRules
          buttonLabel="Solve ignoring fixed assignments"
          buttonClassName="rounded bg-slate-700 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-wait"
        />
        <button
          type="button"
          onClick={() => void clearAll()}
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-100"
        >
          Clear all fixed assignments
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          Refresh list
        </button>
      </div>
      {clearMsg && <p className="mt-2 text-sm text-slate-700">{clearMsg}</p>}
    </section>
  );
}
