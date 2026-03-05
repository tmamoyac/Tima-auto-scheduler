"use client";

import { useMemo } from "react";
import { ResidencyAdminHeader } from "./ResidencyAdminHeader";
import { ResidencyAdminPage } from "./ResidencyAdminPage";

type TabId = "setup" | "schedule";

export function SchedulerTabsLayout({
  programId,
  academicYearId,
  programName,
  academicYearStart,
  academicYearEnd,
  academicYearLabel,
  initialTab = "schedule",
  isSuperAdmin = false,
  children,
}: {
  programId: string;
  academicYearId: string;
  programName?: string;
  academicYearStart: string;
  academicYearEnd: string;
  academicYearLabel: string;
  initialTab?: TabId;
  isSuperAdmin?: boolean;
  children: React.ReactNode;
}) {
  const activeTab = initialTab;

  const tabHref = (tabId: TabId) => {
    const search = new URLSearchParams();
    search.set("tab", tabId);
    if (isSuperAdmin) search.set("programId", programId);
    search.set("academicYearId", academicYearId);
    return `/admin/scheduler?${search.toString()}`;
  };

  const tabs: { id: TabId; label: string }[] = useMemo(
    () => [
      { id: "setup", label: "Setup" },
      { id: "schedule", label: "Schedule" },
    ],
    []
  );

  return (
    <div className="flex flex-col h-full bg-[#F7F9FC]">
      <ResidencyAdminHeader
        programId={programId}
        currentTab={activeTab}
        programName={programName}
        academicYearId={academicYearId}
        academicYearStart={academicYearStart}
        academicYearEnd={academicYearEnd}
        isSuperAdmin={isSuperAdmin}
        showSuperAdminLink={isSuperAdmin}
      />
      <div className="flex flex-col">
        <div className="max-w-7xl w-full mx-auto px-6 pt-6">
          <div className="flex gap-1 p-1.5 rounded-xl bg-gray-200 border border-gray-200 max-w-fit">
            {tabs.map((tab) => (
              <a
                key={tab.id}
                href={tabHref(tab.id)}
                className={`px-6 py-3 text-base font-semibold rounded-lg transition-all no-underline block ${
                  activeTab === tab.id
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-gray-700 hover:bg-gray-300 hover:text-gray-900"
                }`}
              >
                {tab.label}
              </a>
            ))}
          </div>
        </div>
        {activeTab === "setup" && (
          <ResidencyAdminPage
            programId={programId}
            academicYearId={academicYearId}
            academicYearStart={academicYearStart}
            academicYearEnd={academicYearEnd}
            academicYearLabel={academicYearLabel}
            isSuperAdmin={isSuperAdmin}
          />
        )}
        {activeTab === "schedule" && (
          <div className="max-w-7xl w-full mx-auto px-6 py-6 min-w-0">{children}</div>
        )}
      </div>
    </div>
  );
}
