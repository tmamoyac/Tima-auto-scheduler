"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";

export function SchedulerPreferencesSection({ programId: programIdProp }: { programId: string }) {
  const searchParams = useSearchParams();
  const programIdFromUrl = searchParams.get("programId") ?? searchParams.get("programid");
  const programId =
    typeof programIdFromUrl === "string" && programIdFromUrl.length > 0 ? programIdFromUrl : programIdProp;
  const [avoidBackToBackConsult, setAvoidBackToBackConsult] = useState(false);
  const [noConsultWhenVacationInMonth, setNoConsultWhenVacationInMonth] = useState(false);
  const [avoidBackToBackTransplant, setAvoidBackToBackTransplant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/programs/${encodeURIComponent(programId)}?programId=${encodeURIComponent(programId)}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await safeParseJson<{ error?: string; avoid_back_to_back_consult?: boolean; no_consult_when_vacation_in_month?: boolean; avoid_back_to_back_transplant?: boolean }>(res);
      if (!res.ok) throw new Error(data.error || "Failed to load program");
      setAvoidBackToBackConsult(data.avoid_back_to_back_consult === true);
      setNoConsultWhenVacationInMonth(data.no_consult_when_vacation_in_month === true);
      setAvoidBackToBackTransplant(data.avoid_back_to_back_transplant === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setAvoidBackToBackConsult(false);
      setNoConsultWhenVacationInMonth(false);
      setAvoidBackToBackTransplant(false);
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
      const res = await apiFetch(`/api/admin/programs/${encodeURIComponent(programId)}?programId=${encodeURIComponent(programId)}`, {
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

  const handleAvoidBackToBackTransplantToggle = async (checked: boolean) => {
    setAvoidBackToBackTransplant(checked);
    setSaving(true);
    try {
      const res = await apiFetch(`/api/admin/programs/${encodeURIComponent(programId)}?programId=${encodeURIComponent(programId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avoid_back_to_back_transplant: checked }),
        credentials: "include",
      });
      if (!res.ok) throw new Error((await safeParseJson<{ error?: string }>(res)).error || "Failed");
    } catch (e) {
      alert(String(e));
      setAvoidBackToBackTransplant(!checked);
    } finally {
      setSaving(false);
    }
  };

  const handleNoConsultWhenVacationToggle = async (checked: boolean) => {
    setNoConsultWhenVacationInMonth(checked);
    setSaving(true);
    try {
      const res = await apiFetch(`/api/admin/programs/${encodeURIComponent(programId)}?programId=${encodeURIComponent(programId)}`, {
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

  const checkIcon = (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );

  const rules: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }[] = [
    { id: "transplant", label: "Avoid back-to-back transplant months", checked: avoidBackToBackTransplant, onChange: handleAvoidBackToBackTransplantToggle },
    { id: "consult", label: "Avoid back-to-back consult months", checked: avoidBackToBackConsult, onChange: handleAvoidBackToBackToggle },
    { id: "no-consult-vacation", label: "Do not assign consult in months when resident has vacation", checked: noConsultWhenVacationInMonth, onChange: handleNoConsultWhenVacationToggle },
  ];

  const RULES_COUNT = 3;

  return (
    <section data-scheduling-rules="v3" data-rules-count={RULES_COUNT}>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Scheduling Rules <span className="text-gray-500 font-normal">({RULES_COUNT} rules)</span>
      </h2>
      <div className="space-y-4">
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="flex items-center justify-between gap-4 py-2"
            data-rule={rule.id}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-full bg-green-100 text-green-600 flex items-center justify-center shrink-0">
                {checkIcon}
              </div>
              <span className="text-sm text-gray-700">{rule.label}</span>
            </div>
            <ToggleSwitch
              checked={rule.checked}
              onChange={rule.onChange}
              disabled={saving}
            />
          </div>
        ))}
      </div>
      {saving && <span className="mt-2 block text-xs text-gray-500">Saving…</span>}
    </section>
  );
}
