"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { safeParseJson } from "@/lib/fetchJson";

type Stats = {
  residentsCount: number;
  rotationsCount: number;
  vacationCount: number;
  consultMonthsRequired: number;
};

type Rotation = { id: string; is_consult?: boolean };
type Requirement = { rotation_id: string; min_months_required: number };

export function SetupStatsCards({
  programId,
  academicYearId,
  isSuperAdmin,
}: {
  programId: string;
  academicYearId: string;
  isSuperAdmin?: boolean;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const baseUrl = "/admin/scheduler";
  const query = isSuperAdmin ? `?tab=setup&programId=${encodeURIComponent(programId)}` : "?tab=setup";

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    const programParam = `programId=${encodeURIComponent(programId)}`;
    const yearParam = `academicYearId=${encodeURIComponent(academicYearId)}`;

    Promise.all([
      fetch(`/api/admin/residents?${programParam}`, { cache: "no-store", credentials: "include" }),
      fetch(`/api/admin/rotations?${programParam}`, { cache: "no-store", credentials: "include" }),
      fetch(`/api/admin/vacation?${yearParam}&${programParam}`, {
        cache: "no-store",
        credentials: "include",
      }),
      fetch(`/api/admin/requirements?${programParam}`, { cache: "no-store", credentials: "include" }),
    ])
      .then(async ([residentsRes, rotationsRes, vacationRes, requirementsRes]) => {
        const [residents, rotations, vacation, requirements] = await Promise.all([
          residentsRes.ok ? safeParseJson<unknown[]>(residentsRes) : [],
          rotationsRes.ok ? safeParseJson<unknown[]>(rotationsRes) : [],
          vacationRes.ok ? safeParseJson<{ vacationRequests?: unknown[] }>(vacationRes) : { vacationRequests: [] },
          requirementsRes.ok ? safeParseJson<unknown[]>(requirementsRes) : [],
        ]);

        const rotationsTyped = (rotations ?? []) as Rotation[];
        const requirementsTyped = (requirements ?? []) as Requirement[];
        const consultRotationIds = new Set(
          rotationsTyped.filter((r) => r.is_consult === true).map((r) => r.id)
        );
        const consultMonthsRequired = requirementsTyped
          .filter((r) => consultRotationIds.has(r.rotation_id))
          .reduce((sum, r) => sum + (r.min_months_required ?? 0), 0);

        return {
          residentsCount: Array.isArray(residents) ? residents.length : 0,
          rotationsCount: Array.isArray(rotations) ? rotations.length : 0,
          vacationCount: Array.isArray(vacation?.vacationRequests)
            ? vacation.vacationRequests.length
            : 0,
          consultMonthsRequired,
        };
      })
      .then((s) => {
        if (mounted) setStats(s);
      })
      .catch(() => {
        if (mounted) setStats(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [programId, academicYearId]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-24 rounded-lg border border-gray-200 bg-gray-50 animate-pulse"
          />
        ))}
      </div>
    );
  }

  const cards = [
    {
      title: "Residents",
      value: stats?.residentsCount ?? 0,
      label: "Residents",
      href: `${baseUrl}${query}#section-residents`,
      icon: (
        <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ),
    },
    {
      title: "Active Rotations",
      value: stats?.rotationsCount ?? 0,
      label: "Active Rotations",
      href: `${baseUrl}${query}#section-rotations`,
      icon: (
        <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      ),
    },
    {
      title: "Consult Months",
      value: `${stats?.consultMonthsRequired ?? 0} Required`,
      label: "",
      href: `${baseUrl}${query}#section-requirements`,
      icon: (
        <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ),
    },
    {
      title: "Vacation Requests",
      value: stats?.vacationCount ?? 0,
      label: "Actions",
      href: `${baseUrl}${query}#section-vacation`,
      icon: (
        <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      {cards.map((card) => (
        <Link
          key={card.title}
          href={card.href}
          className="flex flex-col p-4 rounded-lg border border-gray-200 bg-white shadow-sm hover:shadow-md hover:border-gray-300 transition-all no-underline text-gray-900"
        >
          <div className="flex items-start justify-between">
            {card.icon}
            <span className="text-xs font-medium text-gray-500">{card.label}</span>
          </div>
          <p className="text-2xl font-bold mt-2">{card.value}</p>
          <p className="text-sm font-medium text-gray-600">{card.title}</p>
        </Link>
      ))}
    </div>
  );
}
