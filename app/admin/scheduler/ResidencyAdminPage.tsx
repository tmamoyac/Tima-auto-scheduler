"use client";

import { useRouter } from "next/navigation";
import { AcademicYearBanner } from "../setup/AcademicYearBanner";
import { AcademicYearsSection } from "../setup/AcademicYearsSection";
import { ResidentsSection } from "../setup/ResidentsSection";
import { RotationsSection } from "../setup/RotationsSection";
import { VacationSection } from "../setup/VacationSection";
import { RequirementsSection } from "../setup/RequirementsSection";
import { SchedulerPreferencesSection } from "../setup/SchedulerPreferencesSection";
import { FixedAssignmentsSection } from "../setup/FixedAssignmentsSection";

const cardClass = "bg-white rounded-2xl shadow-sm p-6";

export function ResidencyAdminPage({
  programId,
  academicYearId,
  academicYearStart,
  academicYearEnd,
  academicYearLabel,
  isSuperAdmin = false,
}: {
  programId: string;
  academicYearId: string;
  academicYearStart: string;
  academicYearEnd: string;
  academicYearLabel: string;
  isSuperAdmin?: boolean;
}) {
  const router = useRouter();

  const handleYearCreated = (yearId: string) => {
    const params = new URLSearchParams();
    params.set("tab", "setup");
    if (isSuperAdmin) params.set("programId", programId);
    params.set("academicYearId", yearId);
    router.push(`/admin/scheduler?${params.toString()}`);
  };

  return (
    <div className="max-w-7xl mx-auto px-8 py-8">
      <AcademicYearBanner
        programId={programId}
        academicYearId={academicYearId}
        academicYearStart={academicYearStart}
        academicYearEnd={academicYearEnd}
        academicYearLabel={academicYearLabel}
        isSuperAdmin={isSuperAdmin}
      />
      <div className="mb-6">
        <div id="section-academic-years" className={`${cardClass} scroll-mt-4`}>
          <AcademicYearsSection
            programId={programId}
            currentAcademicYearId={academicYearId}
            onYearCreated={handleYearCreated}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="flex flex-col gap-6">
          <div id="section-residents" className={`${cardClass} scroll-mt-4`}>
            <ResidentsSection programId={programId} variant="minimal" />
          </div>
          <div id="section-requirements" className={`${cardClass} scroll-mt-4`}>
            <RequirementsSection programId={programId} variant="minimal" />
          </div>
        </div>
        <div className="flex flex-col gap-6">
          <div id="section-rotations" className={`${cardClass} scroll-mt-4`}>
            <RotationsSection programId={programId} variant="minimal" />
          </div>
          <div id="section-vacation" className={`${cardClass} scroll-mt-4`}>
            <VacationSection
              programId={programId}
              academicYearId={academicYearId}
              academicYearStart={academicYearStart}
              academicYearEnd={academicYearEnd}
              variant="minimal"
            />
          </div>
          <div id="section-scheduling-rules" className={`${cardClass} scroll-mt-4`}>
            <SchedulerPreferencesSection programId={programId} />
          </div>
          <div id="section-fixed-assignments" className={`${cardClass} scroll-mt-4`}>
            <FixedAssignmentsSection programId={programId} academicYearId={academicYearId} variant="minimal" />
          </div>
        </div>
      </div>
    </div>
  );
}
