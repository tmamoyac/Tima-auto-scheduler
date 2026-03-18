"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { ScheduleAudit } from "@/lib/scheduler/generateSchedule";

export function GenerateScheduleButton({ programId }: { programId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [audit, setAudit] = useState<ScheduleAudit | null>(null);

  const handleClick = async () => {
    setLoading(true);
    setMessage(null);
    setAudit(null);
    try {
      const res = await apiFetch(`/api/scheduler/generate?programId=${encodeURIComponent(programId)}`, {
        method: "POST",
      });
      const contentType = res.headers.get("content-type") ?? "";
      let data: { error?: string; audit?: ScheduleAudit } = {};
      if (contentType.includes("application/json")) {
        data = await res.json();
      } else {
        const text = await res.text();
        if (text.startsWith("<")) {
          setMessage({
            type: "error",
            text: "Server returned an error page. Look at the terminal where you ran npm run dev for the real error.",
          });
          return;
        }
        try {
          data = JSON.parse(text);
        } catch {
          setMessage({ type: "error", text: "Server error. Check the terminal (npm run dev) for details." });
          return;
        }
      }
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to generate schedule" });
        return;
      }

      const a = data.audit;
      const hasWarnings =
        a && (a.requirementViolations.length > 0 || a.softRuleViolations.length > 0);

      if (hasWarnings) {
        setAudit(a);
        setMessage({ type: "success", text: "Schedule created with warnings (see below)." });
      } else {
        setMessage({ type: "success", text: "Schedule created! All requirements met. Refreshing…" });
        window.location.reload();
      }
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleClick}
          disabled={loading}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Generating…" : "Generate new schedule"}
        </button>
        {message && (
          <span
            className={`text-sm ${message.type === "success" ? "text-green-600" : "text-red-600"}`}
          >
            {message.text}
          </span>
        )}
      </div>

      {audit && (
        <div className="mt-3 max-w-2xl rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <h3 className="font-semibold text-amber-900 mb-2">Schedule Audit Report</h3>

          {audit.requirementViolations.length > 0 && (
            <div className="mb-3">
              <p className="font-medium text-red-800 mb-1">Unmet Requirements:</p>
              <ul className="list-disc pl-5 space-y-0.5 text-red-700">
                {audit.requirementViolations.map((v, i) => (
                  <li key={i}>
                    <strong>{v.residentName}</strong>: {v.rotationName} — required{" "}
                    {v.required} month{v.required > 1 ? "s" : ""}, assigned {v.assigned}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {audit.softRuleViolations.length > 0 && (
            <div className="mb-3">
              <p className="font-medium text-amber-800 mb-1">Soft Rule Violations:</p>
              <ul className="list-disc pl-5 space-y-0.5 text-amber-700">
                {audit.softRuleViolations.map((v, i) => (
                  <li key={i}>
                    <strong>{v.residentName}</strong>: {v.rule} ({v.monthLabel})
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
          >
            View Schedule
          </button>
        </div>
      )}
    </div>
  );
}
