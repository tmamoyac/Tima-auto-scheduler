"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";
import { ActionsMenu } from "./ActionsMenu";

type Resident = { id: string; first_name: string; last_name: string; pgy: number };
type VacationRequest = {
  id: string;
  resident_id: string;
  start_date: string;
  end_date: string;
};

function formatRange(start: string, end: string): string {
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  const startStr = s.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = e.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return sameMonth ? `${s.toLocaleDateString("en-US", { month: "short" })} ${s.getDate()}-${e.getDate()}` : `${startStr}-${endStr}`;
}

export function VacationSection({
  programId,
  academicYearId,
  variant = "default",
}: {
  programId: string;
  academicYearId: string;
  variant?: "default" | "minimal";
}) {
  const [residents, setResidents] = useState<Resident[]>([]);
  const [vacationRequests, setVacationRequests] = useState<VacationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await apiFetch(
        `/api/admin/vacation?academicYearId=${encodeURIComponent(academicYearId)}&programId=${encodeURIComponent(programId)}`,
        { signal: controller.signal, cache: "no-store", credentials: "include" }
      );
      clearTimeout(timeoutId);
      const data = await safeParseJson<{ error?: string; residents?: Resident[]; vacationRequests?: VacationRequest[] }>(res);
      if (!res.ok) throw new Error(data.error || "Failed to load");
      if (data.residents) setResidents(data.residents);
      if (data.vacationRequests) setVacationRequests(data.vacationRequests);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.name === "AbortError"
            ? "Request timed out. Restart dev server and check terminal for errors."
            : e.message
          : "Failed to load"
      );
      setResidents([]);
      setVacationRequests([]);
    } finally {
      setLoading(false);
    }
  }, [academicYearId, programId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onResidentsUpdated = () => load();
    window.addEventListener("residents-updated", onResidentsUpdated);
    return () => window.removeEventListener("residents-updated", onResidentsUpdated);
  }, [load]);

  const byResident = (residentId: string) =>
    vacationRequests.filter((v) => v.resident_id === residentId);

  const addRange = async (residentId: string) => {
    if (!newStart || !newEnd) {
      alert("Enter start and end date.");
      return;
    }
    if (newStart > newEnd) {
      alert("Start date must be before or equal to end date.");
      return;
    }
    setUpdating(true);
    try {
      const res = await apiFetch(`/api/admin/vacation?programId=${encodeURIComponent(programId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          resident_id: residentId,
          start_date: newStart,
          end_date: newEnd,
        }),
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      setAddingFor(null);
      setNewStart("");
      setNewEnd("");
      await load();
    } catch (e) {
      alert(String(e));
    }
    setUpdating(false);
  };

  const deleteRange = async (id: string) => {
    if (!confirm("Remove this vacation week?")) return;
    setUpdating(true);
    try {
      const res = await apiFetch(`/api/admin/vacation?id=${encodeURIComponent(id)}&programId=${encodeURIComponent(programId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      await load();
    } catch (e) {
      alert(String(e));
    }
    setUpdating(false);
  };

  if (variant === "minimal") {
    return (
      <section>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Vacation Requests</h2>
          <p className="text-sm text-gray-500">
            Add vacation weeks per resident. Each range is up to 14 days.
          </p>
        </div>
        {loading ? (
          <p className="text-sm text-gray-500 py-4">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600 py-4">{error}</p>
        ) : (
          <>
            <div className="divide-y divide-gray-100">
              {residents.map((r) => {
                const ranges = byResident(r.id);
                const isAdding = addingFor === r.id;
                return (
                  <div key={r.id} className="py-3 first:pt-0">
                    <div className="flex items-center justify-between gap-4 mb-2">
                      <span className="text-sm font-medium text-gray-900">
                        {r.first_name} {r.last_name}
                      </span>
                      {!isAdding && (
                        <button
                          type="button"
                          className="text-sm px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg"
                          onClick={() => setAddingFor(r.id)}
                        >
                          + Add Request
                        </button>
                      )}
                    </div>
                    <div className="space-y-2">
                      {ranges.map((v) => (
                        <div
                          key={v.id}
                          className="flex items-center justify-between py-2"
                        >
                          <span className="text-sm text-gray-600">
                            {formatRange(v.start_date, v.end_date)}
                          </span>
                          <ActionsMenu
                            items={[
                              {
                                label: "Delete",
                                onClick: () => deleteRange(v.id),
                                variant: "danger",
                              },
                            ]}
                          />
                        </div>
                      ))}
                      {isAdding && (
                        <div className="flex flex-wrap items-center gap-2 pt-2">
                          <input
                            type="date"
                            value={newStart}
                            onChange={(e) => setNewStart(e.target.value)}
                            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                          />
                          <span className="text-sm text-gray-500">to</span>
                          <input
                            type="date"
                            value={newEnd}
                            onChange={(e) => setNewEnd(e.target.value)}
                            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                          />
                          <button
                            type="button"
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg disabled:opacity-50"
                            onClick={() => addRange(r.id)}
                            disabled={updating}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-sm rounded-lg"
                            onClick={() => {
                              setAddingFor(null);
                              setNewStart("");
                              setNewEnd("");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-3">Vacation requests</h2>
      <p className="text-sm text-gray-600 mb-2">
        Add vacation weeks per resident (e.g. Nov 3-7, Jan 12-16). Each range is up to 14 days.
      </p>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <div className="space-y-4 max-w-3xl">
          {residents.map((r) => {
            const ranges = byResident(r.id);
            const isAdding = addingFor === r.id;
            return (
              <div
                key={r.id}
                className="border border-gray-300 rounded p-3 bg-gray-50"
              >
                <div className="font-medium mb-2">
                  {r.first_name} {r.last_name} (PGY{r.pgy})
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {ranges.map((v) => (
                    <span
                      key={v.id}
                      className="inline-flex items-center gap-1 rounded bg-white border border-gray-300 px-2 py-1 text-sm"
                    >
                      {formatRange(v.start_date, v.end_date)}
                      <button
                        type="button"
                        className="text-red-600 hover:underline text-xs"
                        onClick={() => deleteRange(v.id)}
                        disabled={updating}
                      >
                        Delete
                      </button>
                    </span>
                  ))}
                  {isAdding ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="date"
                        value={newStart}
                        onChange={(e) => setNewStart(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                      <span className="text-sm">to</span>
                      <input
                        type="date"
                        value={newEnd}
                        onChange={(e) => setNewEnd(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                      <button
                        type="button"
                        className="px-2 py-1 bg-blue-600 text-white rounded text-sm disabled:opacity-50"
                        onClick={() => addRange(r.id)}
                        disabled={updating}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="px-2 py-1 bg-gray-300 rounded text-sm"
                        onClick={() => {
                          setAddingFor(null);
                          setNewStart("");
                          setNewEnd("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="text-sm px-2 py-1 border border-gray-300 rounded bg-white hover:bg-gray-100"
                      onClick={() => setAddingFor(r.id)}
                    >
                      Add week
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
