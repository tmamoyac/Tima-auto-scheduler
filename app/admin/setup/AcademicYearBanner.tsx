"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";
import { formatAcademicYearCompact } from "@/lib/dateUtils";

type AcademicYear = { id: string; label: string; start_date: string; end_date: string };

export function AcademicYearBanner({
  programId,
  academicYearId,
  academicYearStart,
  academicYearEnd,
  academicYearLabel,
  isSuperAdmin,
}: {
  programId: string;
  academicYearId: string;
  academicYearStart: string;
  academicYearEnd: string;
  academicYearLabel: string;
  isSuperAdmin: boolean;
}) {
  const [academicYears, setAcademicYears] = useState<AcademicYear[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/admin/academic-years?programId=${encodeURIComponent(programId)}`;
        const res = await apiFetch(url, { cache: "no-store", credentials: "include" });
        const data = await safeParseJson<AcademicYear[] | { error?: string }>(res);
        if (cancelled) return;
        if (Array.isArray(data)) {
          setAcademicYears(data);
        }
      } catch {
        if (!cancelled) setAcademicYears([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [programId]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newYearId = e.target.value;
    if (!newYearId || newYearId === academicYearId) return;
    const base = "/admin/scheduler";
    const tab = "setup";
    const search = new URLSearchParams();
    search.set("tab", tab);
    if (isSuperAdmin) search.set("programId", programId);
    search.set("academicYearId", newYearId);
    window.location.href = `${base}?${search.toString()}`;
  };

  const displayRange = formatAcademicYearCompact(academicYearStart, academicYearEnd) || academicYearLabel || "Academic Year";

  return (
    <div className="mb-6 p-4 rounded-xl bg-indigo-50 border border-indigo-200">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-indigo-900">Academic Year:</span>
        <span className="text-sm text-indigo-800">{displayRange}</span>
        {!loading && academicYears.length > 1 && (
          <select
            value={academicYearId}
            onChange={handleChange}
            className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {academicYears.map((y) => (
              <option key={y.id} value={y.id}>
                {formatAcademicYearCompact(y.start_date, y.end_date) || y.label || y.id}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
