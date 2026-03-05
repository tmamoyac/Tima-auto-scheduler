"use client";

function formatYearRange(start: string, end: string): string {
  if (!start || !end) return "";
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

export function AcademicYearSection({
  academicYearStart,
  academicYearEnd,
}: {
  programId: string;
  academicYearId: string;
  academicYearStart: string;
  academicYearEnd: string;
}) {
  const hasYear = Boolean(academicYearStart && academicYearEnd);

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
      <p className="text-sm text-gray-700">
        <span className="font-semibold">Current academic year:</span>{" "}
        {hasYear ? formatYearRange(academicYearStart, academicYearEnd) : "None set for this program."}
      </p>
      {!hasYear && (
        <p className="text-xs text-gray-500 mt-1">
          Ask your administrator to set the academic year for this program.
        </p>
      )}
    </div>
  );
}
