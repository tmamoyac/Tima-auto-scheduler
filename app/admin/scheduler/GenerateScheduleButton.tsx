"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import {
  formatStrenuousBestEffortBanner,
  type FeasibilityReport,
  type ScheduleAudit,
  type StrenuousConsultB2bBestEffortMeta,
} from "@/lib/scheduler/generateSchedule";

export function GenerateScheduleButton({ programId }: { programId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [audit, setAudit] = useState<ScheduleAudit | null>(null);
  const [feasibilityReport, setFeasibilityReport] = useState<FeasibilityReport | null>(null);
  const [strenuousBestEffortBanner, setStrenuousBestEffortBanner] = useState<string | null>(null);
  const searchParams = useSearchParams();

  const academicYearId =
    searchParams.get("academicYearId") ?? searchParams.get("academicyearid") ?? "";
  const viewParam = searchParams.get("view") ?? "";

  // Preserve the audit panel across reloads so the schedule-version dropdown
  // updates immediately after generation (even when there are warnings).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("scheduleAuditReport");
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        programId: string;
        audit: ScheduleAudit;
        ts: number;
        strenuousBestEffortBanner?: string | null;
        feasibilityReport?: FeasibilityReport | null;
        requirementsPartial?: boolean;
      };
      if (!parsed || parsed.programId !== programId) return;

      const ageMs = Date.now() - (parsed.ts ?? 0);
      if (ageMs > 5 * 60 * 1000) return;

      setAudit(parsed.audit);
      setStrenuousBestEffortBanner(parsed.strenuousBestEffortBanner ?? null);
      if (parsed.feasibilityReport) setFeasibilityReport(parsed.feasibilityReport);

      const reqViol = parsed.audit.requirementViolations.length;
      const softViol = parsed.audit.softRuleViolations.length;
      if (reqViol > 0 && parsed.requirementsPartial) {
        setMessage({
          type: "success",
          text: "Schedule saved as best effort. Review unmet requirements and suggested adjustments below.",
        });
      } else if (reqViol > 0) {
        setMessage({ type: "error", text: "Hard requirements were not met (unexpected)." });
      } else if (softViol > 0) {
        setMessage({
          type: "success",
          text: "Schedule created with soft-rule warnings (see below).",
        });
      } else {
        setMessage({ type: "success", text: "Schedule created! All requirements met." });
      }

      sessionStorage.removeItem("scheduleAuditReport");
    } catch {
      // ignore
    }
  }, [programId]);

  function scheduleAuditPayload(
    audit: ScheduleAudit,
    extras: {
      strenuousBestEffortBanner: string | null;
      feasibilityReport: FeasibilityReport | null;
      requirementsPartial?: boolean;
    }
  ) {
    return JSON.stringify({
      programId,
      audit,
      ts: Date.now(),
      strenuousBestEffortBanner: extras.strenuousBestEffortBanner,
      feasibilityReport: extras.feasibilityReport ?? undefined,
      requirementsPartial: extras.requirementsPartial,
    });
  }

  const handleClick = async () => {
    setLoading(true);
    setMessage(null);
    setAudit(null);
    setFeasibilityReport(null);
    setStrenuousBestEffortBanner(null);
    try {
      const res = await apiFetch(`/api/scheduler/generate?programId=${encodeURIComponent(programId)}`, {
        method: "POST",
      });
      const contentType = res.headers.get("content-type") ?? "";
      let data: {
        error?: string;
        scheduleVersionId?: string;
        audit?: ScheduleAudit;
        strenuousConsultB2bBestEffort?: StrenuousConsultB2bBestEffortMeta;
        requirementsPartial?: boolean;
        feasibilityReport?: FeasibilityReport;
      } = {};
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
        if (data.feasibilityReport) setFeasibilityReport(data.feasibilityReport);
        setMessage({ type: "error", text: data.error || "Failed to generate schedule" });
        return;
      }

      const a = data.audit;
      const reqViol = a?.requirementViolations.length ?? 0;
      const softViol = a?.softRuleViolations.length ?? 0;
      const scheduleVersionId = data.scheduleVersionId;

      const redirectUrl =
        academicYearId && scheduleVersionId
          ? `/admin/scheduler?tab=schedule&programId=${encodeURIComponent(programId)}&academicYearId=${encodeURIComponent(
              academicYearId
            )}${viewParam ? `&view=${encodeURIComponent(viewParam)}` : ""}&versionId=${encodeURIComponent(
              scheduleVersionId
            )}`
          : null;

      if (!a) {
        setMessage({ type: "error", text: "Schedule generation returned no audit data." });
        return;
      }

      const effort = data.strenuousConsultB2bBestEffort;
      const effortBanner = effort ? formatStrenuousBestEffortBanner(effort) : null;
      if (effortBanner) setStrenuousBestEffortBanner(effortBanner);
      if (data.feasibilityReport) setFeasibilityReport(data.feasibilityReport);

      if (reqViol > 0) {
        setAudit(a);
        if (data.requirementsPartial) {
          setMessage({
            type: "success",
            text: "Schedule saved as best effort: some rotation requirements still don’t match. See “What to adjust” below, then fix in Setup or manually. Reloading…",
          });
          try {
            sessionStorage.setItem(
              "scheduleAuditReport",
              scheduleAuditPayload(a, {
                strenuousBestEffortBanner: effortBanner,
                feasibilityReport: data.feasibilityReport ?? null,
                requirementsPartial: true,
              })
            );
          } catch {
            // ignore
          }
          if (redirectUrl) window.location.assign(redirectUrl);
          else window.location.reload();
          return;
        }
        setMessage({ type: "error", text: "Hard requirements were not met (unexpected)." });
        return;
      }

      if (softViol > 0 || effortBanner) {
        setAudit(a);
        setMessage({
          type: "success",
          text: effortBanner
            ? "Schedule saved (best effort within search time). Reloading…"
            : "Schedule created with soft-rule warnings (see below). Reloading…",
        });
        try {
          sessionStorage.setItem(
            "scheduleAuditReport",
            scheduleAuditPayload(a, {
              strenuousBestEffortBanner: effortBanner,
              feasibilityReport: data.feasibilityReport ?? null,
            })
          );
        } catch {
          // ignore
        }
        if (redirectUrl) window.location.assign(redirectUrl);
        else window.location.reload();
        return;
      }

      setMessage({ type: "success", text: "Schedule created! All requirements met. Refreshing…" });
      if (redirectUrl) window.location.assign(redirectUrl);
      else window.location.reload();
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

      {/* Full failure: no audit, but API still returns feasibility hints (e.g. 422). */}
      {feasibilityReport && !audit && (
        <div className="mt-3 max-w-2xl rounded-lg border-2 border-sky-400 bg-sky-50 p-4 text-sm text-sky-950">
          <h3 className="font-semibold text-sky-900 mb-2">How to fix this</h3>
          <p className="mb-2">{feasibilityReport.summary}</p>
          {feasibilityReport.suggestions.length > 0 && (
            <div className="mb-2">
              <p className="font-medium text-sky-900 mb-1">Try these steps</p>
              <ul className="list-disc pl-5 space-y-1">
                {feasibilityReport.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {feasibilityReport.checks.some((c) => !c.ok) && (
            <div>
              <p className="font-medium text-sky-900 mb-1">What’s wrong in your setup</p>
              <ul className="list-disc pl-5 space-y-1">
                {feasibilityReport.checks
                  .filter((c) => !c.ok)
                  .map((c, i) => (
                    <li key={i}>
                      <span className="font-medium">{c.label}</span>
                      {c.detail ? ` — ${c.detail}` : ""}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {audit && (
        <div className="mt-3 max-w-2xl rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <h3 className="font-semibold text-amber-900 mb-2">Schedule Audit Report</h3>

          {feasibilityReport && (
            <div className="mb-4 rounded-lg border-2 border-sky-400 bg-sky-50 p-3 text-sky-950">
              <h4 className="font-semibold text-sky-900 mb-2">How to fix this</h4>
              <p className="mb-2 text-sm">{feasibilityReport.summary}</p>
              {feasibilityReport.suggestions.length > 0 && (
                <div className="mb-2">
                  <p className="text-sm font-medium text-sky-900 mb-1">Try these steps</p>
                  <ul className="list-disc pl-5 space-y-1 text-sm">
                    {feasibilityReport.suggestions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {feasibilityReport.checks.some((c) => !c.ok) && (
                <div>
                  <p className="text-sm font-medium text-sky-900 mb-1">What’s wrong in your setup</p>
                  <ul className="list-disc pl-5 space-y-1 text-sm">
                    {feasibilityReport.checks
                      .filter((c) => !c.ok)
                      .map((c, i) => (
                        <li key={i}>
                          <span className="font-medium">{c.label}</span>
                          {c.detail ? ` — ${c.detail}` : ""}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {strenuousBestEffortBanner && (
            <p className="mb-3 rounded border border-amber-400 bg-amber-100 px-3 py-2 font-medium text-amber-950">
              {strenuousBestEffortBanner}
            </p>
          )}

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
