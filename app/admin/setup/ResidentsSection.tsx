"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";
import { ActionsMenu } from "./ActionsMenu";

type Resident = {
  id: string;
  first_name: string;
  last_name: string;
  pgy: number;
  is_active: boolean;
};

function getInitials(r: Resident): string {
  const f = r.first_name?.charAt(0) ?? "";
  const l = r.last_name?.charAt(0) ?? "";
  return (f + l).toUpperCase() || "?";
}

export function ResidentsSection({
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

  const [list, setList] = useState<Resident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Resident | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ first_name: "", last_name: "", pgy: 1, is_active: true });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await apiFetch(`/api/admin/residents?programId=${encodeURIComponent(programId)}`, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "include",
      });
      clearTimeout(timeoutId);
      const data = await safeParseJson<Resident[] | { error?: string }>(res);
      if (!res.ok) throw new Error("error" in data ? data.error : "Failed to load");
      if (Array.isArray(data)) setList(data);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.name === "AbortError"
            ? "Request timed out. Restart the dev server (npm run dev) and check the terminal for errors."
            : e.message
          : "Failed to load residents"
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
    setForm({ first_name: "", last_name: "", pgy: 1, is_active: true });
  };

  const openEdit = (r: Resident) => {
    setEditing(r);
    setAdding(false);
    setForm({
      first_name: r.first_name,
      last_name: r.last_name,
      pgy: r.pgy,
      is_active: r.is_active,
    });
  };

  const deleteResident = async (r: Resident) => {
    if (!confirm(`Delete ${r.first_name} ${r.last_name}? This cannot be undone.`)) return;
    try {
      const res = await apiFetch(`/api/admin/residents/${r.id}?programId=${encodeURIComponent(programId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      if (editing?.id === r.id) setEditing(null);
      load();
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("residents-updated"));
    } catch (e) {
      alert(String(e));
    }
  };

  const [search, setSearch] = useState("");

  const filteredList = useMemo(() => {
    if (variant !== "minimal" || !search.trim()) return list;
    const q = search.trim().toLowerCase();
    return list.filter(
      (r) =>
        r.first_name.toLowerCase().includes(q) || r.last_name.toLowerCase().includes(q)
    );
  }, [list, search, variant]);

  const toggleActive = async (r: Resident) => {
    try {
      const res = await apiFetch(`/api/admin/residents/${r.id}?programId=${encodeURIComponent(programId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...r, is_active: !r.is_active }),
        credentials: "include",
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      load();
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("residents-updated"));
    } catch (e) {
      alert(String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editing) {
        const res = await apiFetch(`/api/admin/residents/${editing.id}?programId=${encodeURIComponent(programId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
          credentials: "include",
        });
        if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
      } else {
        const res = await apiFetch(`/api/admin/residents?programId=${encodeURIComponent(programId)}`, {
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
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("residents-updated"));
    } catch (e) {
      alert(String(e));
    }
    setSaving(false);
  };

  if (variant === "minimal") {
    return (
      <section>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Residents</h2>
          <div className="flex items-center gap-3">
            <input
              type="search"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-40 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
            />
            <button
              type="button"
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
              onClick={openAdd}
            >
              + Add Resident
            </button>
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-gray-500 py-4">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600 py-4">{error}</p>
        ) : (
          <>
            <div className="divide-y divide-gray-100">
              {filteredList.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-4 py-3 first:pt-0"
                >
                  <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium flex items-center justify-center shrink-0">
                    {getInitials(r)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-gray-900">
                      {r.first_name} {r.last_name}
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                    PGY{r.pgy}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleActive(r)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                      r.is_active ? "bg-green-500" : "bg-gray-200"
                    }`}
                    role="switch"
                    aria-checked={r.is_active}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                        r.is_active ? "translate-x-5" : "translate-x-1"
                      }`}
                    />
                  </button>
                  <ActionsMenu
                    items={[
                      { label: "Edit", onClick: () => openEdit(r) },
                      { label: "Delete", onClick: () => deleteResident(r), variant: "danger" },
                    ]}
                  />
                </div>
              ))}
            </div>
            {(editing !== null || adding) && (
              <div className="mt-4 flex flex-wrap gap-2 items-center rounded-lg border border-gray-200 p-4 bg-gray-50">
                <input
                  placeholder="First name"
                  value={form.first_name}
                  onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  placeholder="Last name"
                  value={form.last_name}
                  onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <select
                  value={form.pgy}
                  onChange={(e) => setForm((f) => ({ ...f, pgy: Number(e.target.value) }))}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>PGY{n}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                    className="rounded"
                  />
                  Active
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
                    setForm({ first_name: "", last_name: "", pgy: 1, is_active: true });
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
      <h2 className="text-xl font-semibold mb-3">Residents</h2>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <>
          <table className="border-collapse border border-gray-300 text-sm w-full max-w-2xl">
            <thead>
              <tr>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">First name</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Last name</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">PGY</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Active</th>
                <th className="border border-gray-300 bg-gray-100 p-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="border border-gray-300 p-2">{r.first_name}</td>
                  <td className="border border-gray-300 p-2">{r.last_name}</td>
                  <td className="border border-gray-300 p-2">{r.pgy}</td>
                  <td className="border border-gray-300 p-2">{r.is_active ? "Yes" : "No"}</td>
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
                      onClick={() => deleteResident(r)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap gap-4 items-end">
            <button
              type="button"
              className="px-3 py-1.5 bg-gray-200 rounded"
              onClick={openAdd}
            >
              Add resident
            </button>
            {(editing !== null || adding) && (
              <div className="flex flex-wrap gap-2 items-center border border-gray-300 rounded p-3 bg-gray-50">
                <input
                  placeholder="First name"
                  value={form.first_name}
                  onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1"
                />
                <input
                  placeholder="Last name"
                  value={form.last_name}
                  onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1"
                />
                <select
                  value={form.pgy}
                  onChange={(e) => setForm((f) => ({ ...f, pgy: Number(e.target.value) }))}
                  className="border border-gray-300 rounded px-2 py-1"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>PGY{n}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                  />
                  Active
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
                    setForm({ first_name: "", last_name: "", pgy: 1, is_active: true });
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
