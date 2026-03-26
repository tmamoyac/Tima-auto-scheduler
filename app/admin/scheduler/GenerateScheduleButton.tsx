"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import {
  formatStrenuousBestEffortBanner,
  SCHEDULE_SEARCH_BUDGET_MS,
  type CpSatUnavailableDetail,
  type FeasibilityReport,
  type ScheduleAudit,
  type StrenuousConsultB2bBestEffortMeta,
  type VacationOverlapBlocked,
  type VacationOverlapDetailRow,
  type VacationOverlapSummary,
} from "@/lib/scheduler/scheduleClientShare";

/** Server search budget plus persist / network slack — whole client wait including auth. */
const CLIENT_GENERATE_TIMEOUT_MS = SCHEDULE_SEARCH_BUDGET_MS + 75_000;

function schedulerSetupHref(opts: {
  programId: string;
  academicYearId: string;
  viewParam: string;
  hash: string;
}): string {
  const q = new URLSearchParams();
  q.set("tab", "setup");
  q.set("programId", opts.programId);
  if (opts.academicYearId) q.set("academicYearId", opts.academicYearId);
  if (opts.viewParam) q.set("view", opts.viewParam);
  const h = opts.hash.startsWith("#") ? opts.hash : `#${opts.hash}`;
  return `/admin/scheduler?${q.toString()}${h}`;
}

function vacationSummaryFromDetails(rows: VacationOverlapDetailRow[]): VacationOverlapSummary {
  return {
    prohibited_violation_count: rows.filter((r) => r.policy === "Prohibited").length,
    avoid_used_count: rows.filter((r) => r.policy === "Avoid").length,
  };
}

function parseCpSatUnavailablePayload(raw: unknown): CpSatUnavailableDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.code !== "CP_SAT_RUNTIME_UNAVAILABLE") return null;
  return {
    code: "CP_SAT_RUNTIME_UNAVAILABLE",
    cause: String(o.cause ?? "unknown"),
    message: String(o.message ?? ""),
    executable: o.executable != null ? String(o.executable) : undefined,
    os_error: o.os_error != null ? String(o.os_error) : undefined,
    stderr_snippet: o.stderr_snippet != null ? String(o.stderr_snippet) : undefined,
    remediation: Array.isArray(o.remediation) ? o.remediation.map(String) : [],
  };
}

function parseVacationDetailsPayload(raw: unknown): VacationOverlapDetailRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const r = item as Partial<VacationOverlapDetailRow>;
    return {
      resident_id: r.resident_id ?? "",
      resident_name: r.resident_name ?? "",
      month_id: r.month_id ?? "",
      month_label: r.month_label ?? "",
      rotation_id: r.rotation_id ?? "",
      rotation_name: r.rotation_name ?? "",
      policy: r.policy === "Prohibited" ? "Prohibited" : "Avoid",
      overlapping_vacation_start: r.overlapping_vacation_start ?? "",
      overlapping_vacation_end: r.overlapping_vacation_end ?? "",
      from_fixed_rule: r.from_fixed_rule === true,
      fixed_rule_id: r.fixed_rule_id ?? null,
    };
  });
}

export function GenerateScheduleButton({
  programId,
  omitFixedAssignmentRules = false,
  buttonLabel,
  buttonClassName,
}: {
  programId: string;
  /** When true, POST JSON `{ omitFixedAssignmentRules: true }` so the solver skips DB fixed pins (one-off generate). */
  omitFixedAssignmentRules?: boolean;
  buttonLabel?: string;
  buttonClassName?: string;
}) {
  const [loading, setLoading] = useState(false);
  /** True only after the request is actually in flight (past auth), so the button doesn’t look stuck on “Generating…”. */
  const [serverContact, setServerContact] = useState(false);
  const runEpochRef = useRef(0);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [audit, setAudit] = useState<ScheduleAudit | null>(null);
  const [feasibilityReport, setFeasibilityReport] = useState<FeasibilityReport | null>(null);
  const [strenuousBestEffortBanner, setStrenuousBestEffortBanner] = useState<string | null>(null);
  /** Explains whether CP-SAT or the legacy heuristic produced a failed generate response. */
  const [engineBanner, setEngineBanner] = useState<string | null>(null);
  /** Populated on 422 when server validates SCHEDULER_WITNESS_ASSIGNMENTS_JSON against hard rules. */
  const [witnessFirstFailure, setWitnessFirstFailure] = useState<string | null>(null);
  const [vacationSummary, setVacationSummary] = useState<VacationOverlapSummary | null>(null);
  const [vacationDetails, setVacationDetails] = useState<VacationOverlapDetailRow[]>([]);
  /** Fixed pin blocked generate (prohibited rotation + vacation overlap month). */
  const [vacationBlocked, setVacationBlocked] = useState<VacationOverlapBlocked | null>(null);
  /** After clearing the fixed pin that blocked generate, until the next generate attempt. */
  const [vacationPinResolvedNote, setVacationPinResolvedNote] = useState<string | null>(null);
  const [clearingFixedRuleId, setClearingFixedRuleId] = useState<string | null>(null);
  /** HTTP 503 structured CP-SAT runtime failure */
  const [cpSatUnavailable, setCpSatUnavailable] = useState<CpSatUnavailableDetail | null>(null);
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
        vacation_overlap_summary?: VacationOverlapSummary;
        vacation_overlap_details?: VacationOverlapDetailRow[];
      };
      if (!parsed || parsed.programId !== programId) return;

      const ageMs = Date.now() - (parsed.ts ?? 0);
      if (ageMs > 5 * 60 * 1000) return;

      setAudit(parsed.audit);
      setStrenuousBestEffortBanner(parsed.strenuousBestEffortBanner ?? null);
      if (parsed.feasibilityReport) setFeasibilityReport(parsed.feasibilityReport);
      setVacationSummary(
        parsed.vacation_overlap_summary ?? {
          prohibited_violation_count: 0,
          avoid_used_count: 0,
        }
      );
      setVacationDetails(parseVacationDetailsPayload(parsed.vacation_overlap_details));

      const reqViol = parsed.audit.requirementViolations.length;
      const softViol = parsed.audit.softRuleViolations.length;
      if (reqViol > 0) {
        setMessage({
          type: "error",
          text: "This saved report shows unmet rotation requirements (older run). Generate a new schedule.",
        });
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

  const scheduleAuditPayload = useCallback(
    (
      a: ScheduleAudit,
      extras: {
        strenuousBestEffortBanner: string | null;
        feasibilityReport: FeasibilityReport | null;
        vacation_overlap_summary: VacationOverlapSummary;
        vacation_overlap_details: VacationOverlapDetailRow[];
      }
    ) =>
      JSON.stringify({
        programId,
        audit: a,
        ts: Date.now(),
        strenuousBestEffortBanner: extras.strenuousBestEffortBanner,
        feasibilityReport: extras.feasibilityReport ?? undefined,
        vacation_overlap_summary: extras.vacation_overlap_summary,
        vacation_overlap_details: extras.vacation_overlap_details,
      }),
    [programId]
  );

  const deleteFixedRule = useCallback(
    async (ruleId: string, options?: { dismissBlockedPanel?: boolean }) => {
      if (!ruleId) return;
      if (!confirm("Remove this fixed assignment? You can generate again afterward.")) return;
      setClearingFixedRuleId(ruleId);
      try {
        const res = await apiFetch(
          `/api/admin/fixed-assignment-rules?id=${encodeURIComponent(ruleId)}&programId=${encodeURIComponent(programId)}`,
          { method: "DELETE", credentials: "include" }
        );
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          const detail = (data.error ?? "").trim() || res.statusText.trim() || `HTTP ${res.status}`;
          throw new Error(detail);
        }

        let nextDetails: VacationOverlapDetailRow[] = [];
        setVacationDetails((prev) => {
          nextDetails = prev.filter((r) => r.fixed_rule_id !== ruleId);
          return nextDetails;
        });
        const nextSummary = vacationSummaryFromDetails(nextDetails);
        setVacationSummary(nextSummary);

        if (options?.dismissBlockedPanel) {
          setVacationBlocked(null);
          setVacationPinResolvedNote(
            "The conflicting fixed assignment was removed. You can regenerate the schedule."
          );
        }

        setMessage({ type: "success", text: "Fixed assignment cleared" });

        if (audit) {
          try {
            sessionStorage.setItem(
              "scheduleAuditReport",
              scheduleAuditPayload(audit, {
                strenuousBestEffortBanner,
                feasibilityReport,
                vacation_overlap_summary: nextSummary,
                vacation_overlap_details: nextDetails,
              })
            );
          } catch {
            // ignore
          }
        }
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        setMessage({
          type: "error",
          text: raw ? `Could not clear fixed assignment: ${raw}` : "Could not clear fixed assignment.",
        });
      } finally {
        setClearingFixedRuleId(null);
      }
    },
    [programId, audit, strenuousBestEffortBanner, feasibilityReport, scheduleAuditPayload]
  );

  // If the audit shows issues but feasibilityReport was missing (old deploy, sessionStorage gap, etc.),
  // load hints from the server using current program setup + this audit.
  useEffect(() => {
    if (!academicYearId || !programId || !audit) return;
    if (feasibilityReport) return;
    const hasIssues =
      audit.requirementViolations.length > 0 || audit.softRuleViolations.length > 0;
    if (!hasIssues) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(
          `/api/scheduler/feasibility-report?programId=${encodeURIComponent(programId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audit }),
          }
        );
        if (!res.ok || cancelled) return;
        const payload = (await res.json()) as { feasibilityReport?: FeasibilityReport };
        if (!cancelled && payload.feasibilityReport) {
          setFeasibilityReport(payload.feasibilityReport);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academicYearId, programId, audit, feasibilityReport]);

  const handleClick = async () => {
    const runEpoch = ++runEpochRef.current;
    const isStale = () => runEpoch !== runEpochRef.current;

    setLoading(true);
    setServerContact(false);
    setMessage(null);
    setAudit(null);
    setFeasibilityReport(null);
    setStrenuousBestEffortBanner(null);
    setEngineBanner(null);
    setWitnessFirstFailure(null);
    setVacationSummary(null);
    setVacationDetails([]);
    setVacationBlocked(null);
    setVacationPinResolvedNote(null);
    setCpSatUnavailable(null);

    const controller = new AbortController();
    /** Timer handle — DOM `number` vs Node `Timeout`; clearTimeout accepts both. */
    let raceTimeoutId: number | undefined;

    const fetchGenerate = () =>
      apiFetch(`/api/scheduler/generate?programId=${encodeURIComponent(programId)}`, {
        method: "POST",
        signal: controller.signal,
        headers: omitFixedAssignmentRules ? { "Content-Type": "application/json" } : undefined,
        body: omitFixedAssignmentRules ? JSON.stringify({ omitFixedAssignmentRules: true }) : undefined,
      });

    try {
      // Covers hung auth (getToken) or hung server — aborts fetch and always settles the UI.
      const res = await Promise.race([
        fetchGenerate(),
        new Promise<Response>((_, reject) => {
          raceTimeoutId = window.setTimeout(() => {
            controller.abort();
            reject(new Error("CLIENT_TIMEOUT"));
          }, CLIENT_GENERATE_TIMEOUT_MS) as number;
        }),
      ]);

      if (raceTimeoutId !== undefined) {
        window.clearTimeout(raceTimeoutId);
        raceTimeoutId = undefined;
      }

      if (isStale()) return;

      setServerContact(true);
      const contentType = res.headers.get("content-type") ?? "";
      let data: {
        error?: string;
        scheduleVersionId?: string;
        audit?: ScheduleAudit;
        strenuousConsultB2bBestEffort?: StrenuousConsultB2bBestEffortMeta;
        feasibilityReport?: FeasibilityReport;
        schedulerEngineUsed?: "cp_sat" | "heuristic";
        witnessFirstFailure?: string | null;
        vacation_overlap_summary?: VacationOverlapSummary;
        vacation_overlap_details?: VacationOverlapDetailRow[];
        vacation_overlap_blocked?: VacationOverlapBlocked;
        cp_sat_unavailable?: CpSatUnavailableDetail;
      } = {};
      if (contentType.includes("application/json")) {
        data = await res.json();
      } else {
        const text = await res.text();
        if (isStale()) return;
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
      if (isStale()) return;

      if (!res.ok) {
        const wf = data.witnessFirstFailure?.trim() ? data.witnessFirstFailure : null;
        setWitnessFirstFailure(wf);
        if (data.vacation_overlap_blocked) {
          const b = data.vacation_overlap_blocked;
          setVacationBlocked({
            ...b,
            fixed_rule_id: b.fixed_rule_id ?? "",
          });
        }
        if (data.feasibilityReport) setFeasibilityReport(data.feasibilityReport);

        const cpUnavail = parseCpSatUnavailablePayload(data.cp_sat_unavailable);
        if (res.status === 503 && cpUnavail) {
          setCpSatUnavailable(cpUnavail);
          setEngineBanner(
            "Production hosts such as Vercel usually do not include Python. Set SCHEDULER_CP_SOLVER_URL to a small Python solver service (see docs/cp-sat-production.md), or run the app on a server where python3 and OR-Tools are installed."
          );
          setMessage({
            type: "error",
            text: cpUnavail.message || data.error || "CP-SAT cannot run on this server.",
          });
          return;
        }
        setCpSatUnavailable(null);

        const errLine = (data.error ?? "").trim();
        if (!wf && /python3 ENOENT|spawnSync python3 ENOENT|spawn: spawnSync python3 ENOENT/i.test(errLine)) {
          setEngineBanner(
            "This server cannot start the CP-SAT solver (Python was not found). Deploy the latest app for structured errors, then either set SCHEDULER_CP_SOLVER_URL to a remote solver or use a host with Python 3 + OR-Tools. See docs/cp-sat-production.md in the repository."
          );
        } else if (!wf) {
          if (data.schedulerEngineUsed === "heuristic") {
            setEngineBanner(
              "This failure used the legacy randomized search, not CP-SAT. For the constraint solver: install Python 3 + OR-Tools locally, or set SCHEDULER_CP_SOLVER_URL in production, and do not set SCHEDULER_ENGINE=heuristic unless you accept lower-quality schedules."
            );
          } else if (data.schedulerEngineUsed === "cp_sat") {
            setEngineBanner(
              "CP-SAT ran. If the text below says the solver proved infeasible, that is a definite “no” for the current hard rules, not the old search giving up."
            );
          }
        }
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
      if (isStale()) return;

      const effort = data.strenuousConsultB2bBestEffort;
      const effortBanner = effort ? formatStrenuousBestEffortBanner(effort) : null;
      if (effortBanner) setStrenuousBestEffortBanner(effortBanner);
      if (data.feasibilityReport) setFeasibilityReport(data.feasibilityReport);

      const vacSum = data.vacation_overlap_summary ?? {
        prohibited_violation_count: 0,
        avoid_used_count: 0,
      };
      const vacDet = parseVacationDetailsPayload(data.vacation_overlap_details);
      setVacationSummary(vacSum);
      setVacationDetails(vacDet);

      const persistAudit = () => {
        try {
          sessionStorage.setItem(
            "scheduleAuditReport",
            scheduleAuditPayload(a, {
              strenuousBestEffortBanner: effortBanner,
              feasibilityReport: data.feasibilityReport ?? null,
              vacation_overlap_summary: vacSum,
              vacation_overlap_details: vacDet,
            })
          );
        } catch {
          // ignore
        }
      };

      if (reqViol > 0 || softViol > 0 || effortBanner) {
        setAudit(a);
        const msgText =
          reqViol > 0
            ? "Schedule created but some rotation requirements could not be fully met (see below). Reloading…"
            : effortBanner
              ? "Schedule saved (best effort within search time). Reloading…"
              : "Schedule created with soft-rule warnings (see below). Reloading…";
        setMessage({ type: reqViol > 0 ? "error" : "success", text: msgText });
        persistAudit();
        if (redirectUrl) window.location.assign(redirectUrl);
        else window.location.reload();
        return;
      }

      setAudit(a);
      setMessage({ type: "success", text: "Schedule created! All requirements met. Refreshing…" });
      persistAudit();
      if (redirectUrl) window.location.assign(redirectUrl);
      else window.location.reload();
    } catch (e) {
      if (isStale()) return;
      const msg =
        e instanceof Error && e.message === "CLIENT_TIMEOUT"
          ? `Generation timed out after ${Math.round(CLIENT_GENERATE_TIMEOUT_MS / 1000)}s. Try again, or run locally if your host limits function time.`
          : e instanceof DOMException && e.name === "AbortError"
            ? `Request was cancelled or timed out after ${Math.round(CLIENT_GENERATE_TIMEOUT_MS / 1000)}s. Try again.`
            : e instanceof Error
              ? e.message
              : "Request failed";
      setMessage({ type: "error", text: msg });
    } finally {
      if (raceTimeoutId !== undefined) window.clearTimeout(raceTimeoutId);
      if (!isStale()) {
        setLoading(false);
        setServerContact(false);
      }
    }
  };

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleClick}
          disabled={loading}
          aria-busy={loading}
          title={
            loading
              ? serverContact
                ? "Working — generation can take up to about 90 seconds."
                : "Signing you in — if this lasts more than a minute, refresh the page."
              : omitFixedAssignmentRules
                ? "Runs the solver without fixed_assignment_rules for this year. Does not delete them in the database."
                : undefined
          }
          className={
            buttonClassName ??
            "rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait"
          }
        >
          {loading
            ? serverContact
              ? "Generating schedule…"
              : "Connecting…"
            : (buttonLabel ?? "Generate new schedule")}
        </button>
        {message && (
          <span
            role="status"
            aria-live="polite"
            className={`text-sm ${message.type === "success" ? "text-green-600" : "text-red-600"}`}
          >
            {message.text}
          </span>
        )}
      </div>
      {loading && (
        <p className="mt-2 text-xs text-gray-500 max-w-xl" aria-live="polite">
          {serverContact
            ? "The server is building your schedule. This often takes 30–90 seconds; please keep this tab open."
            : "Preparing your session with the server…"}
        </p>
      )}

      {engineBanner && !witnessFirstFailure && (
        <div className="mt-3 max-w-2xl rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
          {engineBanner}
        </div>
      )}

      {cpSatUnavailable && (
        <div
          className="mt-3 max-w-2xl rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950"
          role="alert"
        >
          <h3 className="mb-2 font-semibold text-rose-900">CP-SAT solver unavailable</h3>
          <p className="mb-2">{cpSatUnavailable.message}</p>
          {cpSatUnavailable.cause ? (
            <p className="mb-2 text-xs text-rose-800">
              Cause: {cpSatUnavailable.cause}
              {cpSatUnavailable.os_error ? ` (${cpSatUnavailable.os_error})` : ""}
            </p>
          ) : null}
          {cpSatUnavailable.remediation.length > 0 ? (
            <ul className="mb-2 list-disc space-y-1 pl-5">
              {cpSatUnavailable.remediation.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}
          {cpSatUnavailable.stderr_snippet ? (
            <pre className="mt-2 max-h-24 overflow-auto rounded border border-rose-200 bg-white p-2 font-mono text-xs text-rose-900">
              {cpSatUnavailable.stderr_snippet}
            </pre>
          ) : null}
          <p className="mt-3 text-xs text-rose-800">
            Deploy guide:{" "}
            <code className="rounded bg-white px-1 py-0.5 text-[11px]">docs/cp-sat-production.md</code> in this
            repository.
          </p>
        </div>
      )}

      {witnessFirstFailure && (
        <pre className="mt-3 max-w-3xl overflow-x-auto rounded border border-neutral-300 bg-neutral-50 p-3 text-xs font-mono whitespace-pre-wrap text-neutral-900">
          {witnessFirstFailure}
        </pre>
      )}

      {vacationPinResolvedNote && !vacationBlocked && (
        <div
          className="mt-3 max-w-2xl rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950"
          role="status"
          aria-live="polite"
        >
          {vacationPinResolvedNote}
        </div>
      )}

      {vacationBlocked && (
        <div className="mt-3 max-w-2xl rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-950">
          <h3 className="font-semibold text-rose-900 mb-2">Vacation overlap summary</h3>
          <p className="mb-3 text-rose-900">
            Generation was blocked because a fixed assignment conflicts with a rotation that does not allow vacation
            overlap in that month.
          </p>
          <ul className="space-y-1.5 list-none mb-4">
            <li>
              <span className="font-medium text-rose-900">Resident</span> — {vacationBlocked.resident_name}
            </li>
            <li>
              <span className="font-medium text-rose-900">Month</span> — {vacationBlocked.month_label}
            </li>
            <li>
              <span className="font-medium text-rose-900">Rotation</span> — {vacationBlocked.rotation_name}
            </li>
            <li>
              <span className="font-medium text-rose-900">Policy</span> — Prohibited
            </li>
            <li>
              <span className="font-medium text-rose-900">Why it is blocked</span> — {vacationBlocked.reason}
            </li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <a
              href={schedulerSetupHref({
                programId,
                academicYearId,
                viewParam,
                hash:
                  vacationBlocked.fixed_rule_id !== ""
                    ? `fixed-rule-${vacationBlocked.fixed_rule_id}`
                    : "section-fixed-assignments",
              })}
              className="inline-flex items-center rounded bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-800 no-underline"
            >
              View fixed assignment
            </a>
            {vacationBlocked.fixed_rule_id !== "" ? (
              <button
                type="button"
                disabled={clearingFixedRuleId !== null}
                onClick={() =>
                  void deleteFixedRule(vacationBlocked.fixed_rule_id, { dismissBlockedPanel: true })
                }
                className="rounded border border-rose-400 bg-white px-3 py-1.5 text-sm font-medium text-rose-900 hover:bg-rose-100 disabled:opacity-50"
              >
                {clearingFixedRuleId === vacationBlocked.fixed_rule_id ? "Removing…" : "Clear this fixed assignment"}
              </button>
            ) : null}
            <a
              href={schedulerSetupHref({
                programId,
                academicYearId,
                viewParam,
                hash: `rotation-row-${vacationBlocked.rotation_id}`,
              })}
              className="inline-flex items-center rounded border border-rose-400 bg-white px-3 py-1.5 text-sm font-medium text-rose-900 hover:bg-rose-100 no-underline"
            >
              Jump to rotation settings
            </a>
          </div>
        </div>
      )}

      {/* Full failure: feasibility hints when no witness-first failure to show. */}
      {feasibilityReport && !audit && !witnessFirstFailure && (
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

          {vacationSummary && (
            <div className="mb-3 rounded border border-amber-200 bg-white/90 px-3 py-2.5">
              <h4 className="font-semibold text-amber-900 mb-2">Vacation overlap summary</h4>
              <ul className="list-none space-y-1 text-sm mb-2">
                <li>
                  <span className="font-medium text-amber-950">Prohibited violations</span>
                  {": "}
                  <span
                    className={
                      vacationSummary.prohibited_violation_count > 0 ? "font-semibold text-red-700" : undefined
                    }
                  >
                    {vacationSummary.prohibited_violation_count}
                  </span>
                </li>
                <li>
                  <span className="font-medium text-amber-950">Avoid placements used</span>
                  {": "}
                  {vacationSummary.avoid_used_count}
                </li>
              </ul>
              {vacationDetails.length > 0 && (
                <details className="mt-1 text-sm">
                  <summary className="cursor-pointer font-medium text-amber-900 select-none">
                    Vacation overlap details
                  </summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="min-w-full border-collapse border border-amber-200 text-xs">
                      <thead>
                        <tr className="bg-amber-100/80">
                          <th className="border border-amber-200 px-2 py-1.5 text-left font-medium">Resident</th>
                          <th className="border border-amber-200 px-2 py-1.5 text-left font-medium">Month</th>
                          <th className="border border-amber-200 px-2 py-1.5 text-left font-medium">Rotation</th>
                          <th className="border border-amber-200 px-2 py-1.5 text-left font-medium">Policy</th>
                          <th className="border border-amber-200 px-2 py-1.5 text-left font-medium">
                            Overlapping vacation dates
                          </th>
                          <th className="border border-amber-200 px-2 py-1.5 text-left font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vacationDetails.map((row, i) => (
                          <tr key={`${row.resident_id}-${row.month_id}-${row.rotation_id}-${i}`}>
                            <td className="border border-amber-200 px-2 py-1.5">{row.resident_name}</td>
                            <td className="border border-amber-200 px-2 py-1.5">{row.month_label}</td>
                            <td className="border border-amber-200 px-2 py-1.5">{row.rotation_name}</td>
                            <td className="border border-amber-200 px-2 py-1.5">{row.policy}</td>
                            <td className="border border-amber-200 px-2 py-1.5">
                              {row.overlapping_vacation_start && row.overlapping_vacation_end
                                ? `${row.overlapping_vacation_start} – ${row.overlapping_vacation_end}`
                                : "—"}
                            </td>
                            <td className="border border-amber-200 px-2 py-1.5 align-top">
                              <div className="flex flex-col gap-1.5 items-start min-w-[10rem]">
                                <a
                                  href={schedulerSetupHref({
                                    programId,
                                    academicYearId,
                                    viewParam,
                                    hash: `rotation-row-${row.rotation_id}`,
                                  })}
                                  className="text-blue-700 underline hover:text-blue-900"
                                >
                                  Jump to rotation settings
                                </a>
                                {row.from_fixed_rule && row.fixed_rule_id ? (
                                  <>
                                    <a
                                      href={schedulerSetupHref({
                                        programId,
                                        academicYearId,
                                        viewParam,
                                        hash: `fixed-rule-${row.fixed_rule_id}`,
                                      })}
                                      className="text-blue-700 underline hover:text-blue-900"
                                    >
                                      Jump to fixed assignment
                                    </a>
                                    <button
                                      type="button"
                                      disabled={clearingFixedRuleId !== null}
                                      onClick={() => void deleteFixedRule(row.fixed_rule_id!)}
                                      className="text-left text-sm text-amber-900 underline hover:text-amber-950 disabled:opacity-50"
                                    >
                                      {clearingFixedRuleId === row.fixed_rule_id
                                        ? "Clearing…"
                                        : "Clear fixed assignment"}
                                    </button>
                                  </>
                                ) : (
                                  <a
                                    href={schedulerSetupHref({
                                      programId,
                                      academicYearId,
                                      viewParam,
                                      hash: "section-fixed-assignments",
                                    })}
                                    className="text-blue-700 underline hover:text-blue-900"
                                  >
                                    Open fixed assignments
                                  </a>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
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
