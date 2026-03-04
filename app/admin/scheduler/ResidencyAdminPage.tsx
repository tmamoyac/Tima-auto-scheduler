"use client";

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
}: {
  programId: string;
  academicYearId: string;
}) {
  return (
    <div className="max-w-7xl mx-auto px-8 py-8">
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
            <VacationSection programId={programId} academicYearId={academicYearId} variant="minimal" />
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
