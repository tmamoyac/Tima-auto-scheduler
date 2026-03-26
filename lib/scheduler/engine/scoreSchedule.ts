import type { ValidationResult } from "./types";

/** Soft-constraint penalty (higher = worse). Feasibility does not use this. */
export function scoreSoftViolations(v: ValidationResult): number {
  let s = 0;
  for (const x of v.softViolations) {
    if (x.code === "CONSULT_ON_VACATION") s += 10;
    else s += 1;
  }
  return s;
}
