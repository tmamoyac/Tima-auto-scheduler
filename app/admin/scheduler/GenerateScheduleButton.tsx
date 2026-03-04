"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";

export function GenerateScheduleButton({ programId }: { programId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleClick = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await apiFetch(`/api/scheduler/generate?programId=${encodeURIComponent(programId)}`, {
        method: "POST",
      });
      const contentType = res.headers.get("content-type") ?? "";
      let data: { error?: string } = {};
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
      setMessage({ type: "success", text: "Schedule created! Refreshing…" });
      window.location.reload();
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
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
  );
}
