"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";

type Requirement = {
  id: string;
  pgy: number;
  rotation_id: string;
  rotation_name: string;
  min_months_required: number;
};
type Rotation = { id: string; name: string };

export function RequirementsSection({
  programId,
  variant = "default",
}: {
  programId: string;
  variant?: "default" | "minimal";
}) {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [rotations, setRotations] = useState<Rotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ pgy: 1, rotation_id: "", min_months_required: 1 });
  const [editing, setEditing] = useState<Requirement | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingMatrix, setSavingMatrix] = useState(false);
  const [matrix, setMatrix] = useState<Record<string, Record<number, number>>>({});

  const loadReqs = async () => {
    const res = await apiFetch(`/api/admin/requirements?programId=${encodeURIComponent(programId)}`, { cache: "no-store", credentials: "include" });
    const data = await safeParseJson<Requirement[] | { error?: string }>(res);
    if (!res.ok) throw new Error("error" in data ? data.error : "Failed to load requirements");
    if (Array.isArray(data)) {
      setRequirements(data);
      buildMatrixFromReqs(data as Requirement[], rotations);
    }
  };

  function buildMatrixFromReqs(reqs: Requirement[], rots: Rotation[]) {
    const next: Record<string, Record<number, number>> = {};
    for (const rot of rots) {
      next[rot.id] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    }
    for (const r of reqs) {
      if (next[r.rotation_id]) {
        next[r.rotation_id][r.pgy] = r.min_months_required;
      }
    }
    setMatrix(next);
  }

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeoutMs = 15000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const [resReqs, resRots] = await Promise.all([
        apiFetch(`/api/admin/requirements?programId=${encodeURIComponent(programId)}`, {
          signal: controller.signal,
          cache: "no-store",
          credentials: "include",
        }),
        apiFetch(`/api/admin/rotations?programId=${encodeURIComponent(programId)}`, {
          signal: controller.signal,
          cache: "no-store",
          credentials: "include",
        }),
      ]);
      const dataReqs = await safeParseJson<Requirement[] | { error?: string }>(resReqs);
      const dataRots = await safeParseJson<Rotation[] | { error?: string }>(resRots);
      if (!resReqs.ok) throw new Error("error" in dataReqs ? dataReqs.error : "Failed to load requirements");
      if (!resRots.ok) throw new Error("error" in dataRots ? dataRots.error : "Failed to load rotations");
      if (Array.isArray(dataReqs)) setRequirements(dataReqs);
      if (Array.isArray(dataRots)) {
        setRotations(dataRots);
        buildMatrixFromReqs(Array.isArray(dataReqs) ? dataReqs : [], dataRots);
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

  const openAdd = (pgy?: number) => {
    setEditing(null);
    setAdding(true);
    setForm({
      pgy: pgy ?? 1,
      rotation_id: rotations[0]?.id ?? "",
      min_months_required: 1,
    });
  };

  const openEdit = (r: Requirement) => {
    setEditing(r);
    setAdding(false);
    setForm({
      pgy: r.pgy,
      rotation_id: r.rotation_id,
      min_months_required: r.min_months_required,
    });
  };

  const save = async () => {
    if (!form.rotation_id) {
      alert("Select a rotation");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const res = await apiFetch(`/api/admin/requirements/${editing.id}?programId=${encodeURIComponent(programId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
          credentials: "include",
        });
        if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      } else {
        const res = await apiFetch(`/api/admin/requirements?programId=${encodeURIComponent(programId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, program_id: programId }),
          credentials: "include",
        });
        if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      }
      setEditing(null);
      setAdding(false);
      loadReqs();
    } catch (e) {
      alert(String(e));
    }
    setSaving(false);
  };

  const deleteReq = async (id: string) => {
    if (!confirm("Delete this requirement?")) return;
    const res = await apiFetch(`/api/admin/requirements/${id}?programId=${encodeURIComponent(programId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) alert((await safeParseJson<{ error?: string }>(res)).error || "Failed");
    else loadReqs();
  };

  const byPgy = (pgy: number) => requirements.filter((r) => r.pgy === pgy);

  const setMatrixCell = (rotationId: string, pgy: number, value: number) => {
    setMatrix((prev) => ({
      ...prev,
      [rotationId]: {
        ...prev[rotationId],
        [pgy]: Math.max(0, value),
      },
    }));
  };

  const saveMatrix = async () => {
    setSavingMatrix(true);
    try {
      const requirementsPayload = rotations.flatMap((rot) =>
        [1, 2, 3, 4, 5].map((pgy) => ({
          pgy,
          rotation_id: rot.id,
          min_months_required: matrix[rot.id]?.[pgy] ?? 0,
        }))
      );
      const res = await apiFetch(`/api/admin/requirements?programId=${encodeURIComponent(programId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirements: requirementsPayload }),
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await loadReqs();
    } catch (e) {
      alert(String(e));
    }
    setSavingMatrix(false);
  };

  if (variant === "minimal") {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">PGY Requirements</h2>
        {loading ? (
          <p className="text-sm text-gray-500 py-4">Loading…</p>
        ) : error ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-600">{error}</p>
            <button
              type="button"
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm"
              onClick={() => loadData()}
            >
              Retry
            </button>
          </div>
        ) : rotations.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 pr-4 font-medium text-gray-700">Rotation</th>
                    {[1, 2, 3, 4, 5].map((pgy) => (
                      <th key={pgy} className="text-center py-3 px-2 font-medium text-gray-700">
                        PGY{pgy}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rotations.map((rot) => (
                    <tr key={rot.id}>
                      <td className="py-3 pr-4 font-medium text-gray-900">{rot.name}</td>
                      {[1, 2, 3, 4, 5].map((pgy) => (
                        <td key={pgy} className="py-2 px-2">
                          <input
                            type="number"
                            min={0}
                            className="w-14 rounded-lg border border-gray-300 px-2 py-1.5 text-center text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                            value={matrix[rot.id]?.[pgy] ?? 0}
                            onChange={(e) =>
                              setMatrixCell(rot.id, pgy, parseInt(e.target.value, 10) || 0)
                            }
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
              className="mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
              onClick={saveMatrix}
              disabled={savingMatrix}
            >
              {savingMatrix ? "Saving…" : "Save matrix"}
            </button>
          </>
        ) : (
          <p className="text-sm text-gray-500">Add rotations first.</p>
        )}
      </section>
    );
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-3">PGY requirements</h2>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : error ? (
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-sm text-red-600">{error}</p>
          <button
            type="button"
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm"
            onClick={() => loadData()}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {rotations.length > 0 && (
            <div className="mb-6">
              <h3 className="text-md font-medium mb-2">Rules matrix (min months per rotation by PGY)</h3>
              <p className="text-sm text-gray-500 mb-2">
                Edit the grid below like your Excel &quot;# of Rotation&quot; block, then click Save matrix.
              </p>
              <div className="overflow-x-auto">
                <table className="border-collapse border border-gray-300 text-sm w-full max-w-3xl mb-2">
                  <thead>
                    <tr>
                      <th className="border border-gray-300 bg-gray-100 p-2 text-left">Rotation</th>
                      {[1, 2, 3, 4, 5].map((pgy) => (
                        <th key={pgy} className="border border-gray-300 bg-gray-100 p-2 text-center">
                          <span className="block">PGY{pgy}</span>
                          {pgy === 4 && <span className="block text-xs font-normal text-gray-600 mt-0.5">1st yr fellow</span>}
                          {pgy === 5 && <span className="block text-xs font-normal text-gray-600 mt-0.5">2nd yr fellow</span>}
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
                              value={matrix[rot.id]?.[pgy] ?? 0}
                              onChange={(e) =>
                                setMatrixCell(rot.id, pgy, parseInt(e.target.value, 10) || 0)
                              }
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
                className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm disabled:opacity-50"
                onClick={saveMatrix}
                disabled={savingMatrix}
              >
                {savingMatrix ? "Saving…" : "Save matrix"}
              </button>
            </div>
          )}
          <h3 className="text-md font-medium mb-2 mt-4">Per-row edit (optional)</h3>
          {[1, 2, 3, 4, 5].map((pgy) => (
            <div key={pgy} className="mb-6">
              <h3 className="text-md font-medium mb-2">PGY{pgy}</h3>
              <table className="border-collapse border border-gray-300 text-sm w-full max-w-xl mb-2">
                <thead>
                  <tr>
                    <th className="border border-gray-300 bg-gray-100 p-2 text-left">Rotation</th>
                    <th className="border border-gray-300 bg-gray-100 p-2 text-left">Min months</th>
                    <th className="border border-gray-300 bg-gray-100 p-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {byPgy(pgy).map((r) => (
                    <tr key={r.id}>
                      <td className="border border-gray-300 p-2">{r.rotation_name}</td>
                      <td className="border border-gray-300 p-2">{r.min_months_required}</td>
                      <td className="border border-gray-300 p-2">
                        <button
                          type="button"
                          className="text-blue-600 underline mr-2"
                          onClick={() => openEdit(r)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-red-600 underline"
                          onClick={() => deleteReq(r.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                className="text-sm px-2 py-1 bg-gray-200 rounded"
                onClick={() => openAdd(pgy)}
              >
                Add requirement for PGY{pgy}
              </button>
            </div>
          ))}
          {(editing !== null || adding) && (
            <div className="flex flex-wrap gap-2 items-center border border-gray-300 rounded p-3 bg-gray-50 mt-3">
              <span className="text-sm">PGY</span>
              <select
                value={form.pgy}
                onChange={(e) => setForm((f) => ({ ...f, pgy: Number(e.target.value) }))}
                className="border border-gray-300 rounded px-2 py-1"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>PGY{n}</option>
                ))}
              </select>
              <select
                value={form.rotation_id}
                onChange={(e) => setForm((f) => ({ ...f, rotation_id: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1"
              >
                <option value="">Select rotation</option>
                {rotations.map((rot) => (
                  <option key={rot.id} value={rot.id}>{rot.name}</option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={form.min_months_required}
                onChange={(e) =>
                  setForm((f) => ({ ...f, min_months_required: Number(e.target.value) || 1 }))
                }
                className="border border-gray-300 rounded px-2 py-1 w-16"
              />
              <span className="text-sm">months</span>
              <button
                type="button"
                className="px-3 py-1.5 bg-blue-600 text-white rounded"
                onClick={save}
                disabled={saving}
              >
                {editing ? "Update" : "Create"}
              </button>
              <button
                type="button"
                className="px-3 py-1.5 bg-gray-300 rounded"
                onClick={() => {
                  setEditing(null);
                  setAdding(false);
                  setForm({ pgy: 1, rotation_id: "", min_months_required: 1 });
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
