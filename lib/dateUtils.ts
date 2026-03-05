/**
 * Formats an ISO date string (YYYY-MM-DD) to compact M/D/YYYY format.
 */
export function formatDateCompact(isoDate: string): string {
  if (!isoDate) return "";
  const d = new Date(isoDate + "T12:00:00");
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const year = d.getFullYear();
  return `${m}/${day}/${year}`;
}

/**
 * Formats an academic year range to compact M/D/YYYY–M/D/YYYY format.
 * Example: "7/1/2026–6/30/2026"
 */
export function formatAcademicYearCompact(start: string, end: string): string {
  if (!start || !end) return "";
  return `${formatDateCompact(start)}–${formatDateCompact(end)}`;
}
