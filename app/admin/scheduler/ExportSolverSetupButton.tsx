"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";

/** Writes the same static input the CP solver loads to `debug/current-scheduler-setup.json` on the dev server. */
export function ExportSolverSetupButton({ programId }: { programId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const academicYearId =
    searchParams.get("academicYearId") ?? searchParams.get("academicyearid") ?? "";

  const onClick = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const q = new URLSearchParams();
      q.set("programId", programId);
      if (academicYearId) q.set("academicYearId", academicYearId);
      const res = await apiFetch(`/api/scheduler/export-setup?${q.toString()}`, { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        relativePath?: string | null;
        writeError?: string | null;
      };
      if (!res.ok) {
        setMessage(data.error ?? "Export failed");
        return;
      }
      if (data.writeError) {
        setMessage(`Could not write file (${data.writeError}). Copy setupJson from network response in devtools if needed.`);
        return;
      }
      setMessage(`Saved ${data.relativePath ?? "debug/current-scheduler-setup.json"} — run: npm run debug:scheduler-real-case`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Export failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={loading || !academicYearId}
        className="rounded border border-neutral-400 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
        title={!academicYearId ? "Select an academic year in the URL first" : undefined}
      >
        {loading ? "Exporting…" : "Export solver setup to debug/"}
      </button>
      {message && <span className="text-xs text-neutral-600 max-w-md">{message}</span>}
    </div>
  );
}
