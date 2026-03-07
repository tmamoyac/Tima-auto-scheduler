import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireDirectorContext } from "@/lib/auth/directorContext";

const FIX_SQL = `-- Copy everything below this line and paste into Supabase SQL Editor, then click Run.

create table if not exists schedule_versions (
  id uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references academic_years(id) on delete cascade,
  version_name text,
  is_final boolean default false,
  created_at timestamptz default now()
);

create index if not exists schedule_versions_academic_year_id_idx on schedule_versions(academic_year_id);

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  schedule_version_id uuid not null references schedule_versions(id) on delete cascade,
  resident_id uuid not null references residents(id) on delete cascade,
  month_id uuid not null references months(id) on delete cascade,
  rotation_id uuid references rotations(id) on delete set null,
  unique (schedule_version_id, resident_id, month_id)
);

create index if not exists assignments_schedule_version_id_idx on assignments(schedule_version_id);
create index if not exists assignments_resident_id_idx on assignments(resident_id);
create index if not exists assignments_month_id_idx on assignments(month_id);
`;

async function getCheckResult(): Promise<{
  ok: boolean;
  steps: { name: string; status: "pass" | "fail"; detail: string }[];
  needTables: boolean;
}> {
  const steps: { name: string; status: "pass" | "fail"; detail: string }[] = [];
  let needTables = false;

  try {
    const supabase = createSupabaseServerClient();
    const ctx = await requireDirectorContext(supabase);

    const { data: years, error: yearErr } = await supabase
      .from("academic_years")
      .select("id")
      .eq("program_id", ctx.programId)
      .limit(1);
    if (yearErr) {
      steps.push({ name: "Academic year", status: "fail", detail: yearErr.message });
    } else if (!years?.length) {
      steps.push({
        name: "Academic year",
        status: "fail",
        detail: "No academic year in database. Run the seed or add one in Supabase.",
      });
    } else {
      steps.push({ name: "Academic year", status: "pass", detail: "Found." });
    }

    const { error: svErr } = await supabase.from("schedule_versions").select("id").limit(1);
    if (svErr) {
      const msg = String(svErr.message);
      if (msg.includes("schedule_versions") && (msg.includes("does not exist") || msg.includes("relation"))) {
        steps.push({ name: "schedule_versions table", status: "fail", detail: "Table is missing." });
        needTables = true;
      } else {
        steps.push({ name: "schedule_versions table", status: "fail", detail: msg });
      }
    } else {
      steps.push({ name: "schedule_versions table", status: "pass", detail: "Exists." });
    }

    const { error: aErr } = await supabase.from("assignments").select("id").limit(1);
    if (aErr) {
      const msg = String(aErr.message);
      if (msg.includes("assignments") && (msg.includes("does not exist") || msg.includes("relation"))) {
        steps.push({ name: "assignments table", status: "fail", detail: "Table is missing." });
        needTables = true;
      } else {
        steps.push({ name: "assignments table", status: "fail", detail: msg });
      }
    } else {
      steps.push({ name: "assignments table", status: "pass", detail: "Exists." });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "DEACTIVATED") {
      steps.push({
        name: "Account",
        status: "fail",
        detail: "Account deactivated. Contact your program administrator.",
      });
    } else if (msg === "PROGRAM_DEACTIVATED") {
      steps.push({
        name: "Program",
        status: "fail",
        detail: "Your program has been deactivated. Contact your system administrator to reactivate it.",
      });
    } else {
      steps.push({
        name: "Connection",
        status: "fail",
        detail: msg || "Could not connect. Check .env.local (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY).",
      });
    }
  }

  return { ok: steps.every((s) => s.status === "pass"), steps, needTables };
}

export default async function FixPage() {
  const result = await getCheckResult();

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-semibold mb-2">Fix schedule generation</h1>
      <p className="text-sm text-gray-600 mb-6">
        This page checks why &quot;Generate new schedule&quot; might be failing.
      </p>

      <div className="space-y-3 mb-8">
        {result.steps.map((step) => (
          <div
            key={step.name}
            className={`flex items-start gap-3 p-3 rounded border ${
              step.status === "pass" ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
            }`}
          >
            <span className="text-lg">{step.status === "pass" ? "✓" : "✗"}</span>
            <div>
              <p className="font-medium">{step.name}</p>
              <p className="text-sm text-gray-700">{step.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {result.ok ? (
        <div className="p-4 rounded bg-green-50 border border-green-200">
          <p className="font-medium text-green-800">All checks passed.</p>
          <p className="text-sm text-green-700 mt-1">
            Go back to the scheduler and click &quot;Generate new schedule&quot; again.
          </p>
          <a href="/admin/scheduler" className="inline-block mt-3 text-blue-600 underline">
            Back to Scheduler
          </a>
        </div>
      ) : result.needTables ? (
        <div className="space-y-4">
          <div className="p-4 rounded bg-amber-50 border border-amber-200">
            <p className="font-medium text-amber-900">Missing database tables</p>
            <p className="text-sm text-amber-800 mt-1">Do these 3 steps:</p>
            <ol className="list-decimal list-inside text-sm text-amber-800 mt-2 space-y-1">
              <li>Open <strong>Supabase</strong> in your browser and open your project.</li>
              <li>Click <strong>SQL Editor</strong> in the left menu, then <strong>New query</strong>.</li>
              <li>Copy the SQL below, paste it into the box, and click <strong>Run</strong>.</li>
            </ol>
          </div>
          <pre className="p-4 bg-gray-900 text-gray-100 text-xs overflow-x-auto rounded whitespace-pre">
            {FIX_SQL}
          </pre>
          <p className="text-sm text-gray-600">
            After it says &quot;Success&quot;, go back to the Scheduler and click &quot;Generate new schedule&quot; again.
          </p>
          <a href="/admin/scheduler" className="inline-block mt-2 text-blue-600 underline">
            Back to Scheduler
          </a>
        </div>
      ) : (
        <div className="p-4 rounded bg-red-50 border border-red-200">
          <p className="font-medium text-red-800">Something else is wrong</p>
          <p className="text-sm text-red-700 mt-1">
            Fix the failed check above (read the detail). If &quot;Academic year&quot; failed, run the seed script or add an academic year in Supabase.
          </p>
          <a href="/admin/scheduler" className="inline-block mt-3 text-blue-600 underline">
            Back to Scheduler
          </a>
        </div>
      )}
    </div>
  );
}
