"use client";

import { useCallback, useEffect, useState } from "react";
import { safeParseJson } from "@/lib/fetchJson";

export function SchedulerPreferencesSection({ programId }: { programId: string }) {
  const [avoidBackToBackConsult, setAvoidBackToBackConsult] = useState(false);
  const [noConsultWhenVacationInMonth, setNoConsultWhenVacationInMonth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/programs/${encodeURIComponent(programId)}?programId=${encodeURIComponent(programId)}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await safeParseJson<{ error?: string; avoid_back_to_back_consult?: boolean; no_consult_when_vacation_in_month?: boolean }>(res);
      if (!res.ok) throw new Error(data.error || "Failed to load program");
      setAvoidBackToBackConsult(data.avoid_back_to_back_consult === true);
      setNoConsultWhenVacationInMonth(data.no_consult_when_vacation_in_month === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setAvoidBackToBackConsult(false);
      setNoConsultWhenVacationInMonth(false);
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAvoidBackToBackToggle = async (checked: boolean) => {
    setAvoidBackToBackConsult(checked);
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/programs/${encodeURIComponent(programId)}?programId=${encodeURIComponent(programId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avoid_back_to_back_consult: checked }),
        credentials: "include",
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
    } catch (e) {
      alert(String(e));
      setAvoidBackToBackConsult(!checked);
    } finally {
      setSaving(false);
    }
  };

  const handleNoConsultWhenVacationToggle = async (checked: boolean) => {
    setNoConsultWhenVacationInMonth(checked);
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/programs/${encodeURIComponent(programId)}?programId=${encodeURIComponent(programId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ no_consult_when_vacation_in_month: checked }),
        credentials: "include",
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
    } catch (e) {
      alert(String(e));
      setNoConsultWhenVacationInMonth(!checked);
    } finally {
      setSaving(false);
    }
  };

  function ToggleSwitch({
    checked,
    onChange,
    disabled,
  }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
  }) {
    return (
      <button
        type="button"
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-indigo-600" : "bg-gray-200"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        role="switch"
        aria-checked={checked}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    );
  }

  if (loading) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Scheduling Rules</h2>
        <p className="text-sm text-gray-500">Loading…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Scheduling Rules</h2>
        <p className="text-sm text-red-600">{error}</p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Scheduling Rules</h2>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-green-100 text-green-600 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <span className="text-sm text-gray-700">
              Avoid back-to-back consult months
            </span>
          </div>
          <ToggleSwitch
            checked={avoidBackToBackConsult}
            onChange={handleAvoidBackToBackToggle}
            disabled={saving}
          />
        </div>
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-green-100 text-green-600 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <span className="text-sm text-gray-700">
              Do not assign consult in months when resident has vacation
            </span>
          </div>
          <ToggleSwitch
            checked={noConsultWhenVacationInMonth}
            onChange={handleNoConsultWhenVacationToggle}
            disabled={saving}
          />
        </div>
      </div>
      {saving && <span className="mt-2 block text-xs text-gray-500">Saving…</span>}
    </section>
  );
}
