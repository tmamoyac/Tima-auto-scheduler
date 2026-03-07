"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/apiFetch";
import { safeParseJson } from "@/lib/fetchJson";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { TimaLogo } from "@/app/components/TimaLogo";

type Program = { id: string; name: string };

export function ResidencyAdminHeader({
  programId: programIdProp,
  currentTab,
  isSuperAdmin,
  showSuperAdminLink = false,
  programName,
}: {
  programId: string;
  currentTab: string;
  isSuperAdmin: boolean;
  showSuperAdminLink?: boolean;
  programName?: string;
}) {
  const searchParams = useSearchParams();
  const programIdFromUrl = searchParams.get("programId") ?? searchParams.get("programid");
  const programId =
    typeof programIdFromUrl === "string" && programIdFromUrl.length > 0 ? programIdFromUrl : programIdProp;

  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(isSuperAdmin);
  const [fetchError, setFetchError] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null | undefined>(undefined); // undefined = not loaded yet

  useEffect(() => {
    let mounted = true;
    createSupabaseBrowserClient()
      .auth.getUser()
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error || !data.user) {
          setUserEmail(null);
        } else {
          const email = data.user.email;
          setUserEmail(email !== undefined && email !== null ? email : "");
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isSuperAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setFetchError(false);
    apiFetch("/api/super-admin/programs?activeOnly=true")
      .then(async (res) => {
        const data = await safeParseJson<Program[] | { error?: string }>(res);
        if (!res.ok) throw new Error("Failed");
        return Array.isArray(data) ? data : [];
      })
      .then((data: Program[]) => {
        if (mounted) setPrograms(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (mounted) {
          setPrograms([]);
          setFetchError(true);
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isSuperAdmin]);

  const tab = currentTab === "setup" || currentTab === "schedule" ? currentTab : "schedule";

  const currentProgramName =
    programName ??
    programs.find((p) => p.id === programId)?.name ??
    "Program";

  const directorPrograms: Program[] = [
    { id: programId, name: currentProgramName },
  ];

  const displayPrograms = isSuperAdmin ? programs : directorPrograms;
  const displayLoading = isSuperAdmin && loading;

  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <TimaLogo className="w-6 h-6 text-indigo-600 shrink-0" />
              <h1 className="text-lg font-semibold text-gray-900">Tima</h1>
            </div>
            {(isSuperAdmin || directorPrograms.length > 0) ? (
              <form
                method="get"
                action="/admin/scheduler"
                className="inline-block"
                onSubmit={(e) => e.preventDefault()}
              >
                <input type="hidden" name="tab" value={tab} />
                <select
                  id="program-selector"
                  name="programId"
                  value={programId}
                  onChange={(e) => {
                    const selected = e.target.value;
                    if (!selected) return;
                    const curr = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
                    curr.set("tab", tab);
                    curr.set("programId", selected);
                    curr.delete("academicYearId");
                    window.location.assign(`/admin/scheduler?${curr.toString()}`);
                  }}
                  disabled={displayLoading || displayPrograms.length === 0}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium bg-white min-w-[220px] focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none disabled:opacity-60 disabled:cursor-not-allowed text-gray-700"
                >
                {displayLoading ? (
                  <option value={programId}>{currentProgramName}</option>
                ) : fetchError ? (
                  <>
                    {programId && <option value={programId}>{currentProgramName}</option>}
                    <option value="">Failed to load programs</option>
                  </>
                ) : displayPrograms.length === 0 ? (
                  <>
                    {programId && <option value={programId}>{currentProgramName}</option>}
                    <option value="">No programs</option>
                  </>
                ) : (
                  displayPrograms.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                )}
              </select>
              </form>
            ) : (
              <p className="text-sm text-gray-600">{currentProgramName}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="p-2 rounded-full text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              aria-label="Notifications"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                />
              </svg>
            </button>
            <div className="relative group">
              <div
                className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-medium cursor-default hover:bg-indigo-200"
                aria-label="Account"
              >
                A
              </div>
              <div
                className="absolute right-0 top-full mt-2 z-50 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg max-w-[280px] break-all opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity pointer-events-none"
                role="tooltip"
              >
                Logged in as:{" "}
                {userEmail === undefined
                  ? "…"
                  : userEmail === null
                    ? "Not signed in"
                    : userEmail === ""
                      ? "Email not available"
                      : userEmail}
              </div>
            </div>
            {showSuperAdminLink && (
              <a
                href="/admin/super"
                className="text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline"
              >
                Super Admin
              </a>
            )}
            <form action="/logout" method="post" className="inline">
              <button
                type="submit"
                className="text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline bg-transparent border-none cursor-pointer p-0"
              >
                Log out
              </button>
            </form>
          </div>
        </div>
      </div>
    </header>
  );
}
