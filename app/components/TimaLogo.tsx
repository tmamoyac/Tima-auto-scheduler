/**
 * Tima logo: simple clock outline.
 */
export function TimaLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {/* Clock face outline */}
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" />
      {/* Hour markers (12, 3, 6, 9) */}
      <line x1="16" y1="4" x2="16" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <line x1="26" y1="16" x2="24" y2="16" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <line x1="16" y1="26" x2="16" y2="24" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <line x1="6" y1="16" x2="8" y2="16" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      {/* Clock hands - 10:10 */}
      <line x1="16" y1="16" x2="16" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="16" y1="16" x2="21" y2="12" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
