"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Version = { id: string; version_name: string | null; is_final: boolean };

export function ScheduleVersionPicker({
  versions,
  currentVersionId,
  programId,
}: {
  versions: Version[];
  currentVersionId: string | null;
  programId: string;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [markingFinal, setMarkingFinal] = useState(false);

  const current = versions.find((v) => v.id === currentVersionId);

  const handleRename = async () => {
    if (!currentVersionId) return;
    const name = prompt("Version name:", current?.version_name ?? "");
    if (name === null) return;
    setRenaming(true);
    try {
      const res = await fetch(`/api/admin/schedule-versions/${currentVersionId}?programId=${encodeURIComponent(programId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version_name: name.trim() || null }),
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error);
      router.refresh();
    } catch (e) {
      alert(String(e));
    }
    setRenaming(false);
  };

  const handleMarkFinal = async () => {
    if (!currentVersionId) return;
    if (!confirm("Mark this version as the final schedule?")) return;
    setMarkingFinal(true);
    try {
      const res = await fetch(`/api/admin/schedule-versions/${currentVersionId}?programId=${encodeURIComponent(programId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_final: true }),
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error);
      router.refresh();
    } catch (e) {
      alert(String(e));
    }
    setMarkingFinal(false);
  };

  const handleVersionChange = (versionId: string) => {
    if (versionId === currentVersionId) return;
    const params = new URLSearchParams(window.location.search);
    params.set("versionId", versionId);
    params.set("programId", programId);
    router.push(`${window.location.pathname}?${params.toString()}`);
  };

  if (versions.length === 0) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <label className="text-sm font-medium text-gray-700">Schedule version:</label>
      <select
        value={currentVersionId ?? ""}
        onChange={(e) => handleVersionChange(e.target.value)}
        className="rounded border border-gray-300 px-3 py-1.5 text-sm"
      >
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            {v.version_name || "Unnamed"} {v.is_final ? "(Final)" : ""}
          </option>
        ))}
      </select>
      {currentVersionId && (
        <>
          <button
            type="button"
            onClick={handleRename}
            disabled={renaming}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {renaming ? "Saving…" : "Rename"}
          </button>
          {!current?.is_final && (
            <button
              type="button"
              onClick={handleMarkFinal}
              disabled={markingFinal}
              className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {markingFinal ? "Saving…" : "Mark as final"}
            </button>
          )}
          {current?.is_final && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-800">
              Final
            </span>
          )}
        </>
      )}
    </div>
  );
}
