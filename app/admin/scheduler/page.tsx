import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSchedulerContext } from "@/lib/auth/schedulerContext";
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
    .order("version_name", { ascending: false, nullsFirst: false });
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
  }>;
}) {
  const params = await searchParams;
  const programIdRaw = params.programId ?? params.programid;
  const programIdOverride =
    typeof programIdRaw === "string" && programIdRaw.length > 0 ? programIdRaw : undefined;
  const academicYearIdRaw = params.academicYearId ?? params.academicyearid;
  const academicYearIdOverride =
    typeof academicYearIdRaw === "string" && academicYearIdRaw.length > 0 ? academicYearIdRaw : undefined;
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

  // Setup tab: skip schedule data fetches so the page loads immediately
  if (tabParam === "setup") {
    return (
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

  const selectedVersion = versions.find((v) => v.id === selectedVersionId);

  return (
    <SchedulerTabsLayout
      programId={programId}
      academicYearId={academicYearId}
      programName={programName}
        academicYearStart={academicYearStart}
        academicYearEnd={academicYearEnd}
        initialTab={tabParam}
      isSuperAdmin={isSuperAdmin}
    >
      <h1 className="text-2xl font-semibold mb-4">Scheduler</h1>
      <p className="text-sm text-gray-600 mb-2">
        Residents: {residents.length} · Months: {months.length}
        {selectedVersionId
          ? ` · Showing: ${selectedVersion?.version_name ?? "Unnamed"}${selectedVersion?.is_final ? " (Final)" : ""}`
          : " · No schedule generated yet"}
      </p>
      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4 max-w-xl">
        Changed residents or rotations on Setup? Click <strong>Refresh</strong> below to load them here.
      </p>
      <div className="overflow-x-auto mb-6">
        <table className="border-collapse border border-gray-300 text-sm">
          <thead>
            <tr>
              <th className="border border-gray-300 bg-gray-100 p-2 text-left sticky left-0 z-10 min-w-[140px]">
                Resident
              </th>
              {monthsTyped.map((m) => (
                <th
                  key={m.id}
                  className="border border-gray-300 bg-gray-100 p-2 text-center min-w-[100px]"
                >
                  {m.month_label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {residents.map((r) => (
              <tr key={r.id}>
                <td className="border border-gray-300 p-2 sticky left-0 bg-white z-10 font-medium">
                  {r.first_name} {r.last_name} (PGY{r.pgy})
                </td>
                {monthsTyped.map((m) => {
                  const key = `${r.id}_${m.id}`;
                  const rotationLabel = cellRotationLabel.get(key) ?? "Unassigned";
                  const mStart = m.start_date ?? "";
                  const mEnd = m.end_date ?? "";
                  const vacationLabels =
                    mStart && mEnd
                      ? getVacationLabelsInMonth(vacationRequests, r.id, mStart, mEnd)
                      : [];
                  return (
                    <td key={m.id} className="border border-gray-300 p-2 text-center text-gray-700 align-top">
                      <div className="flex flex-col gap-0.5">
                        <span>{rotationLabel}</span>
                        {vacationLabels.length > 0 && (
                          <span className="text-xs text-amber-700" title="Vacation">
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
      </div>
      <div className="flex flex-wrap items-center gap-3 p-4 border-t border-gray-200 bg-gray-50 rounded-lg">
        <GenerateScheduleButton programId={programId} />
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
  );
}
