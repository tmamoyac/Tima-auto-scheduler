import type { ValidationResult } from "./types";

/** First hard failure is listed first (debuggable). */
export function explainInfeasibility(v: ValidationResult): string {
  if (v.ok) return "Schedule satisfies all hard constraints.";
  const lines = v.hardViolations.map((h) => `[${h.group}] ${h.code}: ${h.message}`);
  return lines.join("\n");
}
