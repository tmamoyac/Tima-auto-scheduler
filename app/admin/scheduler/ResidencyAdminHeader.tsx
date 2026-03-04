"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { safeParseJson } from "@/lib/fetchJson";

type Program = { id: string; name: string };

export function ResidencyAdminHeader({
  programId,
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
  const router = useRouter();
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(isSuperAdmin);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    if (!isSuperAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setFetchError(false);
    fetch("/api/super-admin/programs?activeOnly=true", { credentials: "include" })
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

  const handleProgramChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = e.target.value;
    if (!selected) return;
    const tab = currentTab === "setup" || currentTab === "schedule" ? currentTab : "schedule";
    const url = `/admin/scheduler?tab=${tab}&programId=${encodeURIComponent(selected)}`;
    router.push(url);
  };

  const currentProgramName =
    programName ??
    programs.find((p) => p.id === programId)?.name ??
    "Program";

  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-gray-900">Cassava Health</h1>
            {isSuperAdmin ? (
              <select
                id="program-selector"
                value={programId}
                onChange={handleProgramChange}
                disabled={loading || programs.length === 0}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium bg-white min-w-[220px] focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none disabled:opacity-60 disabled:cursor-not-allowed text-gray-700"
              >
                {loading ? (
                  <option value="">Loading programs…</option>
                ) : fetchError ? (
                  <option value="">Failed to load programs</option>
                ) : programs.length === 0 ? (
                  <option value="">No programs</option>
                ) : (
                  programs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                )}
              </select>
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
            <div
              className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-medium"
              title="Admin"
            >
              A
            </div>
            {showSuperAdminLink && (
              <Link
                href="/admin/super"
                className="text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline"
              >
                Super Admin
              </Link>
            )}
            <Link
              href="/logout"
              className="text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline"
            >
              Log out
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
