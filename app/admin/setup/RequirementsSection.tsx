"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";

type Rotation = { id: string; name: string };
type ResidentRow = {
  id: string;
  first_name: string;
  last_name: string;
  pgy: number;
  is_active: boolean;
};
type PgyRequirement = {
  id: string;
  pgy: number;
  rotation_id: string;
  min_months_required: number;
};

function emptyResidentMatrix(
  residents: ResidentRow[],
  rotations: Rotation[]
): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const r of residents) {
    if (!r.is_active) continue;
    m[r.id] = {};
    for (const rot of rotations) m[r.id][rot.id] = 0;
  }
  return m;
}

function matrixFromRequirements(
  residents: ResidentRow[],
  rotations: Rotation[],
  requirements: { resident_id: string; rotation_id: string; min_months_required: number }[]
): Record<string, Record<string, number>> {
  const m = emptyResidentMatrix(residents, rotations);
  for (const row of requirements) {
    if (m[row.resident_id] && row.rotation_id in m[row.resident_id]) {
      m[row.resident_id][row.rotation_id] = row.min_months_required;
    }
  }
  return m;
}

function buildPgyMatrix(
  rotations: Rotation[],
  reqs: PgyRequirement[]
): Record<string, Record<number, number>> {
  const next: Record<string, Record<number, number>> = {};
  for (const rot of rotations) {
    next[rot.id] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  }
  for (const r of reqs) {
    if (next[r.rotation_id]) {
      next[r.rotation_id][r.pgy] = r.min_months_required;
    }
  }
  return next;
}

export function RequirementsSection({
  programId: programIdProp,
  variant = "default",
}: {
  programId: string;
  variant?: "default" | "minimal";
}) {
  const searchParams = useSearchParams();
  const programIdFromUrl = searchParams.get("programId") ?? searchParams.get("programid");
  const programId =
    typeof programIdFromUrl === "string" && programIdFromUrl.length > 0 ? programIdFromUrl : programIdProp;

  const [residents, setResidents] = useState<ResidentRow[]>([]);
  const [rotations, setRotations] = useState<Rotation[]>([]);
  const [residentMatrix, setResidentMatrix] = useState<Record<string, Record<string, number>>>({});
  const [pgyMatrix, setPgyMatrix] = useState<Record<string, Record<number, number>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingResidents, setSavingResidents] = useState(false);
  const [savingPgyTemplate, setSavingPgyTemplate] = useState(false);

  const activeResidents = useMemo(
    () => residents.filter((r) => r.is_active),
    [residents]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeoutMs = 15000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const [resResident, resRots, resPgy] = await Promise.all([
        apiFetch(`/api/admin/resident-requirements?programId=${encodeURIComponent(programId)}`, {
          signal: controller.signal,
          cache: "no-store",
          credentials: "include",
        }),
        apiFetch(`/api/admin/rotations?programId=${encodeURIComponent(programId)}`, {
          signal: controller.signal,
          cache: "no-store",
          credentials: "include",
        }),
        apiFetch(`/api/admin/requirements?programId=${encodeURIComponent(programId)}`, {
          signal: controller.signal,
          cache: "no-store",
          credentials: "include",
        }),
      ]);
      const dataResident = await safeParseJson<
        | { residents: ResidentRow[]; requirements: { resident_id: string; rotation_id: string; min_months_required: number }[] }
        | { error?: string }
      >(resResident);
      const dataRots = await safeParseJson<Rotation[] | { error?: string }>(resRots);
      const dataPgy = await safeParseJson<PgyRequirement[] | { error?: string }>(resPgy);

      if (!resResident.ok) {
        throw new Error("error" in dataResident ? String(dataResident.error) : "Failed to load resident requirements");
      }
      if (!resRots.ok) throw new Error("error" in dataRots ? String(dataRots.error) : "Failed to load rotations");
      if (!resPgy.ok) throw new Error("error" in dataPgy ? String(dataPgy.error) : "Failed to load PGY template");

      const resList = "residents" in dataResident ? dataResident.residents : [];
      const reqList = "requirements" in dataResident ? dataResident.requirements : [];
      const rots = Array.isArray(dataRots) ? dataRots : [];
      const pgyList = Array.isArray(dataPgy) ? dataPgy : [];

      setResidents(resList);
      setRotations(rots);
      setPgyMatrix(buildPgyMatrix(rots, pgyList));

      const hasSaved = reqList.some((r) => r.min_months_required > 0);
      if (hasSaved && rots.length > 0) {
        setResidentMatrix(matrixFromRequirements(resList, rots, reqList));
      } else {
        setResidentMatrix(emptyResidentMatrix(resList, rots));
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.name === "AbortError"
            ? "Request timed out. Click Retry or check that the dev server is running."
            : e.message
          : "Failed to load"
      );
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const setResidentCell = (residentId: string, rotationId: string, value: number) => {
    setResidentMatrix((prev) => ({
      ...prev,
      [residentId]: {
        ...prev[residentId],
        [rotationId]: Math.max(0, value),
      },
    }));
  };

  const copyFromPgyTemplate = () => {
    setResidentMatrix((prev) => {
      const next = { ...prev };
      for (const res of activeResidents) {
        if (!next[res.id]) next[res.id] = {};
        for (const rot of rotations) {
          const v = pgyMatrix[rot.id]?.[res.pgy] ?? 0;
          next[res.id] = { ...next[res.id], [rot.id]: v };
        }
      }
      return next;
    });
  };

  const rowSum = (residentId: string) => {
    const row = residentMatrix[residentId];
    if (!row) return 0;
    return rotations.reduce((s, rot) => s + (row[rot.id] ?? 0), 0);
  };

  const residentHeaderLabel = (res: ResidentRow) => {
    const a = res.first_name?.trim()?.charAt(0) ?? "?";
    const last = res.last_name?.trim() ?? "";
    const shortLast = last.length > 6 ? `${last.slice(0, 5)}…` : last;
    return `${a}. ${shortLast}`;
  };

  const saveResidentRequirements = async () => {
    for (const res of activeResidents) {
      if (rowSum(res.id) > 12) {
        alert(
          `${res.first_name} ${res.last_name}: column cannot exceed 12 months (currently ${rowSum(res.id)}).`
        );
        return;
      }
    }
    const payload: { resident_id: string; rotation_id: string; min_months_required: number }[] = [];
    for (const res of activeResidents) {
      for (const rot of rotations) {
        const n = residentMatrix[res.id]?.[rot.id] ?? 0;
        payload.push({ resident_id: res.id, rotation_id: rot.id, min_months_required: n });
      }
    }
    setSavingResidents(true);
    try {
      const res = await apiFetch(`/api/admin/resident-requirements?programId=${encodeURIComponent(programId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirements: payload }),
        credentials: "include",
      });
      const data = await safeParseJson<{ error?: string }>(res);
      if (!res.ok) throw new Error(data.error || "Save failed");
      await loadData();
      alert("Saved per-resident requirements. Generate schedule to apply.");
    } catch (e) {
      alert(String(e));
    }
    setSavingResidents(false);
  };

  const setPgyCell = (rotationId: string, pgy: number, value: number) => {
    setPgyMatrix((prev) => ({
      ...prev,
      [rotationId]: { ...prev[rotationId], [pgy]: Math.max(0, value) },
    }));
  };

  const savePgyTemplate = async () => {
    const requirementsPayload = rotations.flatMap((rot) =>
      [1, 2, 3, 4, 5].map((pgy) => ({
        pgy,
        rotation_id: rot.id,
        min_months_required: pgyMatrix[rot.id]?.[pgy] ?? 0,
      }))
    );
    setSavingPgyTemplate(true);
    try {
      const res = await apiFetch(`/api/admin/requirements?programId=${encodeURIComponent(programId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirements: requirementsPayload }),
        credentials: "include",
      });
      if (!res.ok) {
        const j = await safeParseJson<{ error?: string }>(res);
        throw new Error(j.error || "Failed");
      }
      alert("PGY template saved. Use “Copy from PGY template” to fill resident rows.");
    } catch (e) {
      alert(String(e));
    }
    setSavingPgyTemplate(false);
  };

  const sectionTitle =
    variant === "minimal" ? "Rotation requirements (per resident)" : "Rotation requirements (per resident)";
  const intro =
    variant === "minimal"
      ? "Each column is at most 12 months; totals under 12 leave remaining months unassigned when you generate. Saved data drives the scheduler (PGY template is fallback until you save here)."
      : "Set how many months each fellow spends on each rotation (max 12 per person). Under 12 means extra months stay unassigned on the schedule. The scheduler uses saved data when present; otherwise the PGY template below.";

  if (loading) {
    return (
      <section className={variant === "default" ? "mb-10" : ""}>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{sectionTitle}</h2>
        <p className="text-sm text-gray-500 py-4">Loading…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className={variant === "default" ? "mb-10" : ""}>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{sectionTitle}</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-sm text-red-600">{error}</p>
          <button
            type="button"
            className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm"
            onClick={() => loadData()}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (rotations.length === 0) {
    return (
      <section className={variant === "default" ? "mb-10" : ""}>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{sectionTitle}</h2>
        <p className="text-sm text-gray-500">Add rotations first.</p>
      </section>
    );
  }

  return (
    <section className={variant === "default" ? "mb-10" : ""}>
      <h2 className={variant === "default" ? "text-xl font-semibold mb-3" : "text-lg font-semibold text-gray-900 mb-4"}>
        {sectionTitle}
      </h2>
      <p className="text-sm text-gray-600 mb-4 max-w-3xl">{intro}</p>

      {activeResidents.length === 0 ? (
        <p className="text-sm text-gray-500">No active residents. Add residents first.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700"
              onClick={copyFromPgyTemplate}
            >
              Copy from PGY template
            </button>
            <button
              type="button"
              className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
              onClick={saveResidentRequirements}
              disabled={savingResidents}
            >
              {savingResidents ? "Saving…" : "Save per-resident requirements"}
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-2">
            Rows = rotations, columns = residents. Max 12 per column; less than 12 leaves unassigned months after generate.
          </p>
          <div className="border border-gray-200 rounded-lg overflow-hidden w-full">
            <table className="w-full text-xs sm:text-sm border-collapse table-fixed">
              <thead>
                <tr className="bg-gray-100 border-b border-gray-200">
                  <th className="text-left py-1.5 px-2 font-medium text-gray-800 w-[min(28%,11rem)] min-w-[7rem] sticky left-0 bg-gray-100 z-10 border-r border-gray-200 align-bottom">
                    Rotation
                  </th>
                  {activeResidents.map((res) => (
                    <th
                      key={res.id}
                      title={`${res.first_name} ${res.last_name} (PGY${res.pgy})`}
                      className="text-center py-1 px-0.5 font-medium text-gray-700 align-bottom leading-tight border-l border-gray-100"
                    >
                      <span className="block truncate max-w-full">{residentHeaderLabel(res)}</span>
                      <span className="block text-[10px] font-normal text-gray-500">PGY{res.pgy}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rotations.map((rot) => (
                  <tr key={rot.id} className="bg-white hover:bg-gray-50/80">
                    <td
                      className="py-1 px-2 font-medium text-gray-800 sticky left-0 bg-white z-[5] border-r border-gray-200 align-middle"
                      title={rot.name}
                    >
                      <span className="line-clamp-2 leading-snug">{rot.name}</span>
                    </td>
                    {activeResidents.map((res) => (
                      <td key={res.id} className="py-0.5 px-0.5 text-center align-middle border-l border-gray-50">
                        <input
                          type="number"
                          min={0}
                          className="w-full min-w-0 max-w-[2.25rem] sm:max-w-[2.5rem] mx-auto block rounded border border-gray-300 px-0.5 py-0.5 text-center text-xs sm:text-sm tabular-nums"
                          value={residentMatrix[res.id]?.[rot.id] ?? 0}
                          onChange={(e) =>
                            setResidentCell(res.id, rot.id, parseInt(e.target.value, 10) || 0)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="bg-amber-50/90 border-t-2 border-amber-200 font-medium">
                  <td className="py-2 px-2 sticky left-0 bg-amber-50 z-[5] border-r border-amber-200 text-gray-800">
                    Total (max 12)
                  </td>
                  {activeResidents.map((res) => {
                    const s = rowSum(res.id);
                    const totalClass =
                      s > 12
                        ? "text-red-800 bg-red-100"
                        : s === 12
                          ? "text-green-800"
                          : "text-amber-900";
                    return (
                    <td
                      key={res.id}
                      title={`${res.first_name} ${res.last_name}`}
                      className={`text-center py-2 px-0.5 border-l border-amber-100 ${totalClass}`}
                    >
                      {s}
                    </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      <details className="mt-8 border border-gray-200 rounded-lg p-4 bg-gray-50">
        <summary className="cursor-pointer font-medium text-gray-800">
          PGY template (optional — for “Copy from PGY template” and scheduler fallback)
        </summary>
        <p className="text-sm text-gray-600 mt-2 mb-3">
          If you have not saved per-resident requirements yet, the scheduler still uses this matrix by PGY level.
          After you save the resident grid above, each resident with saved data uses their own row instead.
        </p>
        <div className="overflow-x-auto">
          <table className="border-collapse border border-gray-300 text-sm w-full max-w-4xl mb-3">
            <thead>
              <tr>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Rotation</th>
                {[1, 2, 3, 4, 5].map((pgy) => (
                  <th key={pgy} className="border border-gray-300 bg-gray-100 p-2 text-center">
                    PGY{pgy}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rotations.map((rot) => (
                <tr key={rot.id}>
                  <td className="border border-gray-300 p-2 font-medium">{rot.name}</td>
                  {[1, 2, 3, 4, 5].map((pgy) => (
                    <td key={pgy} className="border border-gray-300 p-2">
                      <input
                        type="number"
                        min={0}
                        className="w-14 border border-gray-300 rounded px-1 py-0.5 text-center"
                        value={pgyMatrix[rot.id]?.[pgy] ?? 0}
                        onChange={(e) => setPgyCell(rot.id, pgy, parseInt(e.target.value, 10) || 0)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="px-3 py-1.5 bg-gray-700 text-white rounded text-sm disabled:opacity-50"
          onClick={savePgyTemplate}
          disabled={savingPgyTemplate}
        >
          {savingPgyTemplate ? "Saving…" : "Save PGY template"}
        </button>
      </details>
    </section>
  );
}
