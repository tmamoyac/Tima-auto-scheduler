"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";
import { ActionsMenu } from "./ActionsMenu";

const VACATION_OVERLAP_OPTIONS = [
  { value: "allowed", label: "Okay during vacation" },
  { value: "avoid", label: "Try to avoid during vacation" },
  { value: "prohibited", label: "Never schedule during vacation" },
] as const;

function vacationOverlapLabel(policy: string | undefined): string {
  const p = (policy ?? "allowed").toLowerCase();
  return VACATION_OVERLAP_OPTIONS.find((o) => o.value === p)?.label ?? "Okay during vacation";
}

type Rotation = {
  id: string;
  name: string;
  capacity_per_month: number;
  eligible_pgy_min: number;
  eligible_pgy_max: number;
  is_consult?: boolean;
  is_back_to_back_consult_blocker?: boolean;
  is_transplant?: boolean;
  is_primary_site?: boolean;
  vacation_overlap_policy?: string;
};

export function RotationsSection({
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

  const [list, setList] = useState<Rotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Rotation | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: "",
    capacity_per_month: 4,
    eligible_pgy_min: 1,
    eligible_pgy_max: 3,
    is_consult: false,
    is_back_to_back_consult_blocker: false,
    is_transplant: false,
    is_primary_site: false,
    vacation_overlap_policy: "allowed",
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await apiFetch(`/api/admin/rotations?programId=${encodeURIComponent(programId)}`, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "include",
      });
      clearTimeout(timeoutId);
      const data = await safeParseJson<Rotation[] | { error?: string }>(res);
      if (!res.ok) throw new Error("error" in data ? data.error : "Failed to load");
      if (Array.isArray(data)) setList(data);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.name === "AbortError"
            ? "Request timed out. Restart dev server and check terminal for errors."
            : e.message
          : "Failed to load rotations"
      );
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEditing(null);
    setAdding(true);
    setForm({
      name: "",
      capacity_per_month: 4,
      eligible_pgy_min: 1,
      eligible_pgy_max: 3,
      is_consult: false,
      is_back_to_back_consult_blocker: false,
      is_transplant: false,
      is_primary_site: false,
      vacation_overlap_policy: "allowed",
    });
  };

  const openEdit = (r: Rotation) => {
    setEditing(r);
    setAdding(false);
    setForm({
      name: r.name,
      capacity_per_month: r.capacity_per_month,
      eligible_pgy_min: r.eligible_pgy_min,
      eligible_pgy_max: r.eligible_pgy_max,
      is_consult: r.is_consult === true,
      is_back_to_back_consult_blocker: r.is_back_to_back_consult_blocker === true,
      is_transplant: r.is_transplant === true,
      is_primary_site: r.is_primary_site === true,
      vacation_overlap_policy:
        r.vacation_overlap_policy === "avoid" || r.vacation_overlap_policy === "prohibited"
          ? r.vacation_overlap_policy
          : "allowed",
    });
  };

  const deleteRotation = async (r: Rotation) => {
    if (!confirm(`Delete rotation "${r.name}"? This cannot be undone.`)) return;
    try {
      const res = await apiFetch(`/api/admin/rotations/${r.id}?programId=${encodeURIComponent(programId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      if (editing?.id === r.id) setEditing(null);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editing) {
        const res = await apiFetch(`/api/admin/rotations/${editing.id}?programId=${encodeURIComponent(programId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, program_id: programId }),
          credentials: "include",
        });
        if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      } else {
        const res = await apiFetch(`/api/admin/rotations?programId=${encodeURIComponent(programId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, program_id: programId }),
          credentials: "include",
        });
        if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      }
      setEditing(null);
      setAdding(false);
      load();
    } catch (e) {
      alert(String(e));
    }
    setSaving(false);
  };

  if (variant === "minimal") {
    return (
      <section>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-2">
          <h2 className="text-lg font-semibold text-gray-900">Rotations</h2>
          <button
            type="button"
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg self-start sm:self-auto"
            onClick={openAdd}
          >
            + Add Rotation
          </button>
        </div>
        <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
          <p className="text-sm text-indigo-900">
            <span className="font-semibold">How it works:</span>{" "}
            <strong>N/mo</strong> (capacity) = at most <strong>N residents</strong> on that rotation in <strong>one calendar month</strong>, counting everyone together (e.g.{" "}
            <strong>1/mo</strong> one slot, <strong>2/mo</strong> two).{" "}
            <strong>1–5</strong> = eligible PGY levels.{" "}
            <strong>Consult</strong> / <strong>Transplant</strong> = special types (scheduler can avoid back-to-back months when enabled in rules).{" "}
            <strong>Primary site</strong> = main-site rotations; used when &quot;Prefer primary-site for long vacation&quot; is on.
          </p>
        </div>
        {loading ? (
          <p className="text-sm text-gray-500 py-4">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600 py-4">{error}</p>
        ) : (
          <>
            <div className="divide-y divide-gray-100">
              {list.map((r) => (
                <div
                  key={r.id}
                  id={`rotation-row-${r.id}`}
                  className="flex items-center gap-4 py-3 first:pt-0 scroll-mt-24"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-gray-900">{r.name}</span>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Vacation overlap policy: {vacationOverlapLabel(r.vacation_overlap_policy)}
                    </p>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 shrink-0">
                    {r.capacity_per_month}/mo
                  </span>
                  <span className="text-sm text-gray-600 shrink-0">
                    {r.eligible_pgy_min}–{r.eligible_pgy_max}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    {r.is_consult && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
                        Consult
                      </span>
                    )}
                    {r.is_back_to_back_consult_blocker && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
                        Strenuous consult
                      </span>
                    )}
                    {r.is_transplant && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                        Transplant
                      </span>
                    )}
                    {r.is_primary_site && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                        Primary site
                      </span>
                    )}
                    {!r.is_consult && !r.is_transplant && !r.is_primary_site && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                        Other
                      </span>
                    )}
                  </div>
                  <ActionsMenu
                    items={[
                      { label: "Edit", onClick: () => openEdit(r) },
                      { label: "Delete", onClick: () => deleteRotation(r), variant: "danger" },
                    ]}
                  />
                </div>
              ))}
            </div>
            {(editing !== null || adding) && (
              <div className="mt-4 flex flex-wrap gap-2 items-center rounded-lg border border-gray-200 p-4 bg-gray-50">
                <input
                  placeholder="Name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  min={1}
                  placeholder="Capacity"
                  value={form.capacity_per_month}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, capacity_per_month: Number(e.target.value) || 0 }))
                  }
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-20"
                />
                <span className="text-sm text-gray-600">PGY</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={form.eligible_pgy_min}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, eligible_pgy_min: Number(e.target.value) || 1 }))
                  }
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-14"
                />
                <span className="text-sm">–</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={form.eligible_pgy_max}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, eligible_pgy_max: Number(e.target.value) || 3 }))
                  }
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-14"
                />
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_consult}
                    onChange={(e) => setForm((f) => ({ ...f, is_consult: e.target.checked }))}
                    className="rounded"
                  />
                  Consult
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_back_to_back_consult_blocker}
                    onChange={(e) => setForm((f) => ({ ...f, is_back_to_back_consult_blocker: e.target.checked }))}
                    className="rounded"
                  />
                  Strenuous consult (blocks back-to-back)
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_transplant}
                    onChange={(e) => setForm((f) => ({ ...f, is_transplant: e.target.checked }))}
                    className="rounded"
                  />
                  Transplant
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_primary_site}
                    onChange={(e) => setForm((f) => ({ ...f, is_primary_site: e.target.checked }))}
                    className="rounded"
                  />
                  Primary site
                </label>
                <label className="flex flex-col gap-0.5 text-sm">
                  <span className="font-medium text-gray-800">Vacation overlap policy</span>
                  <select
                    value={form.vacation_overlap_policy}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        vacation_overlap_policy: e.target.value as (typeof VACATION_OVERLAP_OPTIONS)[number]["value"],
                      }))
                    }
                    className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-[14rem]"
                  >
                    {VACATION_OVERLAP_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                  onClick={save}
                  disabled={saving}
                >
                  {editing ? "Update" : "Create"}
                </button>
                <button
                  type="button"
                  className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-sm font-medium rounded-lg"
                  onClick={() => {
                    setEditing(null);
                    setAdding(false);
                    setForm({
                      name: "",
                      capacity_per_month: 4,
                      eligible_pgy_min: 1,
                      eligible_pgy_max: 3,
                      is_consult: false,
                      is_back_to_back_consult_blocker: false,
                      is_transplant: false,
                      is_primary_site: false,
                      vacation_overlap_policy: "allowed",
                    });
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

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-3">Rotations</h2>
      <p className="text-sm text-gray-600 mb-3 max-w-2xl">
        <strong>Capacity/month</strong> is the maximum number of residents on that rotation in a single month (shared across all residents). For example,{" "}
        <strong>2</strong> means two people can be on that service in the same month.
      </p>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <>
          <table className="border-collapse border border-gray-300 text-sm w-full max-w-2xl">
            <thead>
              <tr>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Name</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Capacity/month</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Eligible PGY</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Consult</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Strenuous consult blocker</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Transplant</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Primary site</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Vacation overlap policy</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} id={`rotation-row-${r.id}`} className="scroll-mt-24">
                  <td className="border border-gray-300 p-2">{r.name}</td>
                  <td className="border border-gray-300 p-2">{r.capacity_per_month}</td>
                  <td className="border border-gray-300 p-2">
                    {r.eligible_pgy_min}–{r.eligible_pgy_max}
                  </td>
                  <td className="border border-gray-300 p-2">{r.is_consult ? "Yes" : "No"}</td>
                  <td className="border border-gray-300 p-2">
                    {r.is_back_to_back_consult_blocker ? "Yes" : "No"}
                  </td>
                  <td className="border border-gray-300 p-2">{r.is_transplant ? "Yes" : "No"}</td>
                  <td className="border border-gray-300 p-2">{r.is_primary_site ? "Yes" : "No"}</td>
                  <td className="border border-gray-300 p-2 text-xs max-w-[12rem]">
                    {vacationOverlapLabel(r.vacation_overlap_policy)}
                  </td>
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
                      onClick={() => deleteRotation(r)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap gap-4 items-end">
            <button type="button" className="px-3 py-1.5 bg-gray-200 rounded" onClick={openAdd}>
              Add rotation
            </button>
            {(editing !== null || adding) && (
              <div className="flex flex-wrap gap-2 items-center border border-gray-300 rounded p-3 bg-gray-50">
                <input
                  placeholder="Name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1"
                />
                <input
                  type="number"
                  min={1}
                  placeholder="Capacity"
                  value={form.capacity_per_month}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, capacity_per_month: Number(e.target.value) || 0 }))
                  }
                  className="border border-gray-300 rounded px-2 py-1 w-20"
                />
                <span className="text-sm">PGY</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={form.eligible_pgy_min}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, eligible_pgy_min: Number(e.target.value) || 1 }))
                  }
                  className="border border-gray-300 rounded px-2 py-1 w-14"
                />
                <span className="text-sm">–</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={form.eligible_pgy_max}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, eligible_pgy_max: Number(e.target.value) || 3 }))
                  }
                  className="border border-gray-300 rounded px-2 py-1 w-14"
                />
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_consult}
                    onChange={(e) => setForm((f) => ({ ...f, is_consult: e.target.checked }))}
                    className="rounded"
                  />
                  Consult
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_back_to_back_consult_blocker}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, is_back_to_back_consult_blocker: e.target.checked }))
                    }
                    className="rounded"
                  />
                  Strenuous consult (blocks back-to-back)
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_transplant}
                    onChange={(e) => setForm((f) => ({ ...f, is_transplant: e.target.checked }))}
                    className="rounded"
                  />
                  Transplant
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_primary_site}
                    onChange={(e) => setForm((f) => ({ ...f, is_primary_site: e.target.checked }))}
                    className="rounded"
                  />
                  Primary site
                </label>
                <label className="flex flex-col gap-0.5 text-sm">
                  <span className="font-medium text-gray-800">Vacation overlap policy</span>
                  <select
                    value={form.vacation_overlap_policy}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        vacation_overlap_policy: e.target.value as (typeof VACATION_OVERLAP_OPTIONS)[number]["value"],
                      }))
                    }
                    className="border border-gray-300 rounded px-2 py-1 min-w-[14rem]"
                  >
                    {VACATION_OVERLAP_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
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
                    setForm({
                      name: "",
                      capacity_per_month: 4,
                      eligible_pgy_min: 1,
                      eligible_pgy_max: 3,
                      is_consult: false,
                      is_back_to_back_consult_blocker: false,
                      is_transplant: false,
                      is_primary_site: false,
                      vacation_overlap_policy: "allowed",
                    });
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
