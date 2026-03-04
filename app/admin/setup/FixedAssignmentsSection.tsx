"use client";

import { useCallback, useEffect, useState } from "react";
import { safeParseJson } from "@/lib/fetchJson";
import { ActionsMenu } from "./ActionsMenu";

type Rule = {
  id: string;
  resident_id: string;
  month_id: string;
  rotation_id: string;
  resident_name: string;
  month_label: string;
  rotation_name: string;
};
type Resident = { id: string; first_name: string; last_name: string; pgy: number };
type Month = { id: string; month_label: string; month_index: number };
type Rotation = { id: string; name: string };

export function FixedAssignmentsSection({
  programId,
  academicYearId,
  variant = "default",
}: {
  programId: string;
  academicYearId: string;
  variant?: "default" | "minimal";
}) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [months, setMonths] = useState<Month[]>([]);
  const [rotations, setRotations] = useState<Rotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ resident_id: "", month_id: "", rotation_id: "" });

  const loadRules = useCallback(async () => {
    const res = await fetch(
      `/api/admin/fixed-assignment-rules?academicYearId=${encodeURIComponent(academicYearId)}&programId=${encodeURIComponent(programId)}`,
      { cache: "no-store", credentials: "include" }
    );
    const data = await safeParseJson<Rule[] | { error?: string }>(res);
    if (!res.ok) throw new Error("error" in data ? data.error : "Failed to load rules");
    setRules(Array.isArray(data) ? data : []);
  }, [academicYearId, programId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rulesRes, vacRes, rotsRes] = await Promise.all([
        fetch(`/api/admin/fixed-assignment-rules?academicYearId=${encodeURIComponent(academicYearId)}&programId=${encodeURIComponent(programId)}`, {
          cache: "no-store",
          credentials: "include",
        }),
        fetch(`/api/admin/vacation?academicYearId=${encodeURIComponent(academicYearId)}&programId=${encodeURIComponent(programId)}`, {
          cache: "no-store",
          credentials: "include",
        }),
        fetch(`/api/admin/rotations?programId=${encodeURIComponent(programId)}`, { cache: "no-store", credentials: "include" }),
      ]);
      const rulesData = await safeParseJson<Rule[] | { error?: string }>(rulesRes);
      const vacData = await safeParseJson<{ error?: string; residents?: Resident[]; months?: Month[] }>(vacRes);
      const rotsData = await safeParseJson<Rotation[] | { error?: string }>(rotsRes);
      if (!rulesRes.ok) throw new Error("error" in rulesData ? rulesData.error : "Failed to load rules");
      if (!vacRes.ok) throw new Error("error" in vacData ? vacData.error : "Failed to load residents/months");
      if (!rotsRes.ok) throw new Error("error" in rotsData ? rotsData.error : "Failed to load rotations");
      setRules(Array.isArray(rulesData) ? rulesData : []);
      setResidents(Array.isArray(vacData.residents) ? vacData.residents : []);
      setMonths(Array.isArray(vacData.months) ? vacData.months : []);
      setRotations(Array.isArray(rotsData) ? rotsData : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRules([]);
      setResidents([]);
      setMonths([]);
      setRotations([]);
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

  const addRule = async () => {
    if (!form.resident_id || !form.month_id || !form.rotation_id) {
      alert("Select resident, month, and rotation.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/fixed-assignment-rules?programId=${encodeURIComponent(programId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          academic_year_id: academicYearId,
          resident_id: form.resident_id,
          month_id: form.month_id,
          rotation_id: form.rotation_id,
        }),
      });
      const data = await safeParseJson<{ error?: string }>(res);
      if (!res.ok) throw new Error(data.error || "Failed to add rule");
      setForm({ resident_id: "", month_id: "", rotation_id: "" });
      await loadRules();
      await load();
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteRule = async (id: string) => {
    if (!confirm("Remove this fixed assignment rule?")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/fixed-assignment-rules?id=${encodeURIComponent(id)}&programId=${encodeURIComponent(programId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      await loadRules();
      await load();
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Fixed Assignment Rules</h2>
        <p className="text-sm text-gray-500">Loading…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Fixed Assignment Rules</h2>
        <p className="text-sm text-red-600">{error}</p>
      </section>
    );
  }

  const minimalContent = variant === "minimal";

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-2">Fixed Assignment Rules</h2>
      <p className="text-sm text-gray-600 mb-4">
        Assign a resident to a specific rotation for a given month.
      </p>
      {minimalContent ? (
        <div className="divide-y divide-gray-100">
          {rules.length === 0 ? (
            <p className="py-4 text-sm text-gray-500">No fixed assignment rules. Add one below.</p>
          ) : (
            rules.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-4 py-3 first:pt-0"
              >
                <span className="flex-1 text-sm font-medium text-gray-900">{r.resident_name}</span>
                <span className="text-sm text-gray-600">{r.month_label}</span>
                <span className="text-sm text-gray-600">{r.rotation_name}</span>
                <ActionsMenu
                  items={[
                    { label: "Delete", onClick: () => deleteRule(r.id), variant: "danger" },
                  ]}
                />
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="overflow-x-auto mb-4">
          <table className="border-collapse border border-gray-300 text-sm w-full max-w-2xl">
            <thead>
              <tr>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Resident</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Month</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Rotation</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={4} className="border border-gray-300 p-2 text-gray-500">
                    No fixed assignment rules. Add one below.
                  </td>
                </tr>
              ) : (
                rules.map((r) => (
                  <tr key={r.id}>
                    <td className="border border-gray-300 p-2">{r.resident_name}</td>
                    <td className="border border-gray-300 p-2">{r.month_label}</td>
                    <td className="border border-gray-300 p-2">{r.rotation_name}</td>
                    <td className="border border-gray-300 p-2">
                      <button
                        type="button"
                        className="text-red-600 hover:underline text-xs"
                        onClick={() => deleteRule(r.id)}
                        disabled={saving}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className={`flex flex-wrap items-end gap-3 ${minimalContent ? "mt-4" : ""}`}>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-600">Resident</span>
          <select
            value={form.resident_id}
            onChange={(e) => setForm((f) => ({ ...f, resident_id: e.target.value }))}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm min-w-[160px]"
          >
            <option value="">Select resident</option>
            {residents.map((r) => (
              <option key={r.id} value={r.id}>
                {r.first_name} {r.last_name} (PGY{r.pgy})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-600">Month</span>
          <select
            value={form.month_id}
            onChange={(e) => setForm((f) => ({ ...f, month_id: e.target.value }))}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm min-w-[120px]"
          >
            <option value="">Select month</option>
            {months.map((m) => (
              <option key={m.id} value={m.id}>
                {m.month_label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-600">Rotation</span>
          <select
            value={form.rotation_id}
            onChange={(e) => setForm((f) => ({ ...f, rotation_id: e.target.value }))}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm min-w-[160px]"
          >
            <option value="">Select rotation</option>
            {rotations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
          onClick={addRule}
          disabled={saving}
        >
          {saving ? "Adding…" : "Add rule"}
        </button>
      </div>
    </section>
  );
}
