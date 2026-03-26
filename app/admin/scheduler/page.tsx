import type { SupabaseClient } from "@supabase/supabase-js";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSchedulerContext } from "@/lib/auth/schedulerContext";
import { ExportSolverSetupButton } from "./ExportSolverSetupButton";
import { FixedAssignmentsDebugPanel } from "./FixedAssignmentsDebugPanel";
import { GenerateScheduleButton } from "./GenerateScheduleButton";
import { ScheduleVersionPicker } from "./ScheduleVersionPicker";
import { SchedulerRefreshButton } from "./SchedulerRefreshButton";
import { SchedulerTabsLayout } from "./SchedulerTabsLayout";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ContextResult =
  | {
      programId: string;
      academicYearId: string;
      programName?: string;
      academicYearStart: string;
      academicYearEnd: string;
      useAdminClient: boolean;
      isSuperAdmin: boolean;
    }
  | { error: "DEACTIVATED" }
  | { error: "PROGRAM_DEACTIVATED" }
  | null;

async function getContext(
  programIdOverride?: string | null,
  academicYearIdOverride?: string | null
): Promise<ContextResult> {
  const supabase = createSupabaseServerClient();
  try {
    const ctx = await getSchedulerContext(
      supabase,
      supabaseAdmin,
      programIdOverride,
      academicYearIdOverride
    );
    // Super admin can stay on a program even when it has no academic year (e.g. UCI just added)
    const allowNoAcademicYear = ctx.isSuperAdmin && ctx.programId;
    if (!ctx.academicYearId && !allowNoAcademicYear) return null;

    const programRes = await supabaseAdmin
      .from("programs")
      .select("name")
      .eq("id", ctx.programId)
      .maybeSingle();
    const programName = (programRes.data as { name?: string } | null)?.name;

    let academicYearStart = "";
    let academicYearEnd = "";
    const academicYearId = ctx.academicYearId ?? "";

    if (ctx.academicYearId) {
      const yearRes = await supabaseAdmin
        .from("academic_years")
        .select("start_date, end_date")
        .eq("id", ctx.academicYearId)
        .maybeSingle();
      const year = yearRes.data as { start_date?: string; end_date?: string } | null;
      academicYearStart = year?.start_date ?? "";
      academicYearEnd = year?.end_date ?? "";
    }

    return {
      programId: ctx.programId,
      academicYearId,
      programName,
      academicYearStart,
      academicYearEnd,
      useAdminClient: ctx.useAdminClient,
      isSuperAdmin: ctx.isSuperAdmin,
    };
  } catch (e) {
    if (e instanceof Error && e.message === "DEACTIVATED") {
      return { error: "DEACTIVATED" };
    }
    if (e instanceof Error && e.message === "PROGRAM_DEACTIVATED") {
      return { error: "PROGRAM_DEACTIVATED" };
    }
    return null;
  }
}

async function getResidents(supabase: SupabaseClient, programId: string) {
  const { data, error } = await supabase
    .from("residents")
    .select("*")
    .eq("program_id", programId)
    .order("pgy")
    .order("last_name");
  if (error) throw error;
  return data ?? [];
}

async function getMonths(supabase: SupabaseClient, academicYearId: string) {
  const { data, error } = await supabase
    .from("months")
    .select("*")
    .eq("academic_year_id", academicYearId)
    .order("month_index", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function getScheduleVersions(supabase: SupabaseClient, academicYearId: string) {
  const { data, error } = await supabase
    .from("schedule_versions")
    .select("id, version_name, is_final, created_at")
    .eq("academic_year_id", academicYearId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as { id: string; version_name: string | null; is_final: boolean; created_at: string }[];
}

async function getAssignments(supabase: SupabaseClient, scheduleVersionId: string) {
  const { data, error } = await supabase
    .from("assignments")
    .select("resident_id, month_id, rotation_id")
    .eq("schedule_version_id", scheduleVersionId);
  if (error) throw error;
  return data ?? [];
}

async function getRotationNames(supabase: SupabaseClient, programId: string) {
  const { data, error } = await supabase
    .from("rotations")
    .select("id, name")
    .eq("program_id", programId);
  if (error) throw error;
  const map: Record<string, string> = {};
  for (const row of data ?? []) {
    map[row.id] = row.name;
  }
  return map;
}

async function getVacationRequests(
  supabase: SupabaseClient,
  academicYearId: string,
  residentIds: string[]
) {
  if (residentIds.length === 0) return [];
  const { data: yearRow } = await supabase
    .from("academic_years")
    .select("start_date, end_date")
    .eq("id", academicYearId)
    .single();
  const yearStart = (yearRow as { start_date: string } | null)?.start_date ?? "";
  const yearEnd = (yearRow as { end_date: string } | null)?.end_date ?? "";
  if (!yearStart || !yearEnd) return [];
  const { data, error } = await supabase
    .from("vacation_requests")
    .select("resident_id, start_date, end_date")
    .in("resident_id", residentIds)
    .lte("start_date", yearEnd)
    .gte("end_date", yearStart);
  if (error) return [];
  return (data ?? []) as { resident_id: string; start_date: string; end_date: string }[];
}

function formatVacationRange(start: string, end: string): string {
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  const monthShort = s.toLocaleString("en-US", { month: "short" });
  const dayS = s.getDate();
  const dayE = e.getDate();
  if (start === end) return `${monthShort} ${dayS}`;
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${monthShort} ${dayS}-${dayE}`;
  }
  const monthE = e.toLocaleString("en-US", { month: "short" });
  return `${monthShort} ${dayS} – ${monthE} ${dayE}`;
}

function getVacationLabelsInMonth(
  vacationRequests: { resident_id: string; start_date: string; end_date: string }[],
  residentId: string,
  monthStart: string,
  monthEnd: string
): string[] {
  return vacationRequests
    .filter(
      (v) =>
        v.resident_id === residentId &&
        v.start_date <= monthEnd &&
        v.end_date >= monthStart
    )
    .map((v) => formatVacationRange(v.start_date, v.end_date));
}

export default async function SchedulerPage({
  searchParams,
}: {
  searchParams: Promise<{
    versionId?: string;
    tab?: string;
    programId?: string;
    programid?: string;
    academicYearId?: string;
    academicyearid?: string;
    view?: string;
  }>;
}) {
  const params = await searchParams;
  const programIdRaw = params.programId ?? params.programid;
  const programIdOverride =
    typeof programIdRaw === "string" && programIdRaw.length > 0 ? programIdRaw : undefined;
  const academicYearIdRaw = params.academicYearId ?? params.academicyearid;
  const academicYearIdOverride =
    typeof academicYearIdRaw === "string" && academicYearIdRaw.length > 0 ? academicYearIdRaw : undefined;

  /** Default: rotations as rows (PDs’ usual matrix). Use `view=residents` for resident rows. */
  const viewMode = params.view === "residents" ? "residents" : "rotations";
  const context = await getContext(programIdOverride, academicYearIdOverride);

  const supabase = createSupabaseServerClient();
  const db = context && !("error" in context) && context.useAdminClient ? supabaseAdmin : supabase;

  if (context && "error" in context && context.error === "DEACTIVATED") {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold mb-4">Scheduler</h1>
        <p className="text-gray-600">
          Your account has been deactivated. Contact your program administrator to restore access.
        </p>
      </div>
    );
  }
  if (context && "error" in context && context.error === "PROGRAM_DEACTIVATED") {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold mb-4">Scheduler</h1>
        <p className="text-gray-600">
          The program you are assigned to has been deactivated. Contact your system administrator to reactivate the program.
        </p>
      </div>
    );
  }

  if (!context || !("programId" in context)) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold mb-4">Scheduler</h1>
        <p className="text-gray-600">
          You must be logged in and mapped to a program (via `profiles`) to use the scheduler.
        </p>
      </div>
    );
  }

  const { programId, academicYearId, programName, academicYearStart, academicYearEnd, isSuperAdmin } = context;
  const versionIdParam = typeof params.versionId === "string" ? params.versionId : undefined;
  const tabParam = params.tab === "setup" || params.tab === "schedule" ? params.tab : "schedule";

  // Super admin without programId in URL: redirect so URL is always the source of truth
  if (isSuperAdmin && !programIdOverride) {
    const search = new URLSearchParams();
    search.set("tab", tabParam);
    search.set("programId", programId);
    if (academicYearId) search.set("academicYearId", academicYearId);
    redirect(`/admin/scheduler?${search.toString()}`);
  }

  // Setup tab: skip schedule data fetches so the page loads immediately
  if (tabParam === "setup") {
    return (
      <Suspense fallback={<div className="p-6 text-gray-500">Loading…</div>}>
        <SchedulerTabsLayout
          programId={programId}
          academicYearId={academicYearId}
          programName={programName}
          academicYearStart={academicYearStart}
          academicYearEnd={academicYearEnd}
          initialTab="setup"
          isSuperAdmin={isSuperAdmin}
        >
          <p className="text-sm text-gray-500">Switch to Schedule tab to view the schedule.</p>
        </SchedulerTabsLayout>
      </Suspense>
    );
  }

  const [residents, months, versions, rotationNames] = await Promise.all([
    getResidents(db, programId),
    getMonths(db, academicYearId),
    getScheduleVersions(db, academicYearId),
    getRotationNames(db, programId),
  ]);

  const residentIds = residents.map((r) => r.id);
  const vacationRequests = await getVacationRequests(db, academicYearId, residentIds);

  type MonthRow = { id: string; month_label?: string; start_date?: string; end_date?: string };
  const monthsTyped = months as MonthRow[];

  const finalVersion = versions.find((v) => v.is_final);
  const selectedVersionId =
    (versionIdParam && versions.some((v) => v.id === versionIdParam) ? versionIdParam : null) ??
    finalVersion?.id ??
    versions[0]?.id ??
    null;

  let assignments: { resident_id: string; month_id: string; rotation_id: string | null }[] = [];
  if (selectedVersionId) {
    assignments = await getAssignments(db, selectedVersionId);
  }

  const cellRotationLabel = new Map<string, string>();
  for (const a of assignments) {
    const key = `${a.resident_id}_${a.month_id}`;
    const label = a.rotation_id ? (rotationNames[a.rotation_id] ?? "Unassigned") : "Unassigned";
    cellRotationLabel.set(key, label);
  }

  const residentNameById = new Map(residents.map((r) => [r.id, `${r.first_name} ${r.last_name}`.trim()]));

  const UNASSIGNED_ROTATION_KEY = "__unassigned__";
  const rotationMonthResidentIds = new Map<string, string[]>();
  for (const a of assignments) {
    const rotKey = a.rotation_id ?? UNASSIGNED_ROTATION_KEY;
    const key = `${a.month_id}_${rotKey}`;
    const arr = rotationMonthResidentIds.get(key) ?? [];
    arr.push(a.resident_id);
    rotationMonthResidentIds.set(key, arr);
  }

  const rotationIdsList = Object.keys(rotationNames);
  const showUnassignedRotationRow = assignments.some((a) => a.rotation_id === null);

  const selectedVersion = versions.find((v) => v.id === selectedVersionId);

  const viewToggleHref =
    viewMode === "residents"
      ? `/admin/scheduler?tab=schedule&programId=${programId}&academicYearId=${academicYearId}${selectedVersionId ? `&versionId=${selectedVersionId}` : ""}`
      : `/admin/scheduler?tab=schedule&programId=${programId}&academicYearId=${academicYearId}${selectedVersionId ? `&versionId=${selectedVersionId}` : ""}&view=residents`;

  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading…</div>}>
      <SchedulerTabsLayout
        programId={programId}
        academicYearId={academicYearId}
        programName={programName}
        academicYearStart={academicYearStart}
        academicYearEnd={academicYearEnd}
        initialTab={tabParam}
        isSuperAdmin={isSuperAdmin}
        headerRight={
          <a href={viewToggleHref} className="text-sm text-blue-600 underline">
            {viewMode === "rotations" ? "Change view: Residents" : "Change view: Rotations"}
          </a>
        }
      >
      <h1 className="text-2xl font-semibold mb-4">Scheduler</h1>
      <p className="text-sm text-gray-600 mb-2">
        Residents: {residents.length} · Months: {months.length}
        {months.length < 12 && (
          <span className="text-amber-700 ml-1">(Expected 12 months for the academic year; refresh or re-edit the academic year to regenerate months.)</span>
        )}
        {selectedVersionId
          ? ` · Showing: ${selectedVersion?.version_name ?? "Unnamed"}${selectedVersion?.is_final ? " (Final)" : ""}`
          : " · No schedule generated yet"}
      </p>
      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4 max-w-xl">
        Changed residents or rotations on Setup? Click <strong>Refresh</strong> below to load them here.
      </p>
      {academicYearId ? (
        <FixedAssignmentsDebugPanel programId={programId} academicYearId={academicYearId} />
      ) : null}
      <div className="overflow-x-auto mb-6">
        {viewMode === "rotations" ? (
          <table className="border-collapse border border-gray-300 text-sm">
            <thead>
              <tr>
                <th className="border border-gray-300 bg-gray-100 px-2 py-1.5 text-left sticky left-0 z-10 min-w-[140px]">
                  Rotation
                </th>
                {monthsTyped.map((m) => {
                  const shortLabel = m.month_label
                    ? m.month_label.slice(0, 3) + (m.month_label.includes("2027") ? " '27" : " '26")
                    : "";
                  return (
                    <th
                      key={m.id}
                      className="border border-gray-300 bg-gray-100 px-1 py-1.5 text-center min-w-[64px] max-w-[80px]"
                      title={m.month_label ?? undefined}
                    >
                      <span className="truncate block" title={m.month_label ?? undefined}>
                        {shortLabel || m.month_label}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rotationIdsList.map((rotId) => {
                return (
                  <tr key={rotId}>
                    <td className="border border-gray-300 px-2 py-1.5 sticky left-0 bg-white z-10 font-medium min-w-[140px] text-xs">
                      {rotationNames[rotId] ?? rotId}
                    </td>
                    {monthsTyped.map((m) => {
                      const mStart = m.start_date ?? "";
                      const mEnd = m.end_date ?? "";
                      const key = `${m.id}_${rotId}`;
                      const residentIds = rotationMonthResidentIds.get(key) ?? [];
                      const residentNames = residentIds.map((rid) => residentNameById.get(rid) ?? rid);

                      const vacationLabels: string[] = [];
                      if (mStart && mEnd && residentIds.length > 0) {
                        const vacSet = new Set<string>();
                        for (const rid of residentIds) {
                          const v = getVacationLabelsInMonth(vacationRequests, rid, mStart, mEnd);
                          for (const label of v) vacSet.add(label);
                        }
                        vacationLabels.push(...vacSet);
                      }

                      return (
                        <td
                          key={m.id}
                          className="border border-gray-300 px-1 py-1.5 text-center text-gray-700 align-top min-w-[64px] max-w-[80px]"
                        >
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs block break-words" title={residentNames.join(", ")}>
                              {residentNames.length > 0 ? residentNames.join(", ") : "—"}
                            </span>
                            {vacationLabels.length > 0 && (
                              <span
                                className="text-[10px] text-amber-700 block break-words"
                                title={`Vacation: ${vacationLabels.join(", ")}`}
                              >
                                Vac: {vacationLabels.join(", ")}
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              {showUnassignedRotationRow && (
                <tr key={UNASSIGNED_ROTATION_KEY}>
                  <td className="border border-gray-300 px-2 py-1.5 sticky left-0 bg-white z-10 font-medium min-w-[140px] text-xs">
                    Unassigned
                  </td>
                  {monthsTyped.map((m) => {
                    const mStart = m.start_date ?? "";
                    const mEnd = m.end_date ?? "";
                    const key = `${m.id}_${UNASSIGNED_ROTATION_KEY}`;
                    const residentIds = rotationMonthResidentIds.get(key) ?? [];
                    const residentNames = residentIds.map((rid) => residentNameById.get(rid) ?? rid);

                    const vacationLabels: string[] = [];
                    if (mStart && mEnd && residentIds.length > 0) {
                      const vacSet = new Set<string>();
                      for (const rid of residentIds) {
                        const v = getVacationLabelsInMonth(vacationRequests, rid, mStart, mEnd);
                        for (const label of v) vacSet.add(label);
                      }
                      vacationLabels.push(...vacSet);
                    }

                    return (
                      <td
                        key={m.id}
                        className="border border-gray-300 px-1 py-1.5 text-center text-gray-700 align-top min-w-[64px] max-w-[80px]"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs block break-words" title={residentNames.join(", ")}>
                            {residentNames.length > 0 ? residentNames.join(", ") : "—"}
                          </span>
                          {vacationLabels.length > 0 && (
                            <span
                              className="text-[10px] text-amber-700 block break-words"
                              title={`Vacation: ${vacationLabels.join(", ")}`}
                            >
                              Vac: {vacationLabels.join(", ")}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="border-collapse border border-gray-300 text-sm">
            <thead>
              <tr>
                <th className="border border-gray-300 bg-gray-100 px-2 py-1.5 text-left sticky left-0 z-10 min-w-[100px]">
                  Resident
                </th>
                {monthsTyped.map((m) => {
                  const shortLabel = m.month_label
                    ? m.month_label.slice(0, 3) + (m.month_label.includes("2027") ? " '27" : " '26")
                    : "";
                  return (
                    <th
                      key={m.id}
                      className="border border-gray-300 bg-gray-100 px-1 py-1.5 text-center min-w-[64px] max-w-[80px]"
                      title={m.month_label ?? undefined}
                    >
                      <span className="truncate block" title={m.month_label ?? undefined}>
                        {shortLabel || m.month_label}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {residents.map((r) => (
                <tr key={r.id}>
                  <td className="border border-gray-300 px-2 py-1.5 sticky left-0 bg-white z-10 font-medium min-w-[100px] text-xs">
                    {r.first_name} {r.last_name} (PGY{r.pgy})
                  </td>
                  {monthsTyped.map((m) => {
                    const key = `${r.id}_${m.id}`;
                    const rotationLabel = cellRotationLabel.get(key) ?? "—";
                    const mStart = m.start_date ?? "";
                    const mEnd = m.end_date ?? "";
                    const vacationLabels =
                      mStart && mEnd ? getVacationLabelsInMonth(vacationRequests, r.id, mStart, mEnd) : [];
                    return (
                      <td
                        key={m.id}
                        className="border border-gray-300 px-1 py-1.5 text-center text-gray-700 align-top min-w-[64px] max-w-[80px]"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs block break-words" title={rotationLabel}>
                            {rotationLabel}
                          </span>
                          {vacationLabels.length > 0 && (
                            <span
                              className="text-[10px] text-amber-700 block break-words"
                              title={`Vacation: ${vacationLabels.join(", ")}`}
                            >
                              Vac: {vacationLabels.join(", ")}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 p-4 border-t border-gray-200 bg-gray-50 rounded-lg">
        <GenerateScheduleButton programId={programId} />
        <ExportSolverSetupButton programId={programId} />
        <SchedulerRefreshButton />
        {versions.length > 0 && (
          <ScheduleVersionPicker
            versions={versions}
            currentVersionId={selectedVersionId}
            programId={programId}
          />
        )}
        <a href="/admin/scheduler/fix" className="text-sm text-blue-600 underline ml-auto">
          Generate not working? Click here to fix it.
        </a>
      </div>
    </SchedulerTabsLayout>
    </Suspense>
  );
}
