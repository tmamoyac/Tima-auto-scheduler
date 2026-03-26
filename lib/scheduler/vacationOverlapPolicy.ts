/**
 * Per-rotation vacation overlap policy (DB `rotations.vacation_overlap_policy`).
 */
export type VacationOverlapPolicy = "allowed" | "avoid" | "prohibited";

export function normalizeVacationOverlapPolicy(v: unknown): VacationOverlapPolicy {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "avoid" || s === "prohibited" || s === "allowed") return s;
  return "allowed";
}

export function rotationVacationOverlapPolicy(rot: {
  vacation_overlap_policy?: unknown;
}): VacationOverlapPolicy {
  return normalizeVacationOverlapPolicy(rot.vacation_overlap_policy);
}

export function normalizeRotationsVacationPolicy<
  T extends { vacation_overlap_policy?: unknown },
>(list: T[]): (T & { vacation_overlap_policy: VacationOverlapPolicy })[] {
  return list.map((r) => ({
    ...r,
    vacation_overlap_policy: normalizeVacationOverlapPolicy(r.vacation_overlap_policy),
  }));
}

export function countRotationsByVacationOverlapPolicy(
  rotations: { vacation_overlap_policy?: unknown }[]
): { allowed: number; avoid: number; prohibited: number } {
  let allowed = 0;
  let avoid = 0;
  let prohibited = 0;
  for (const r of rotations) {
    const p = rotationVacationOverlapPolicy(r);
    if (p === "avoid") avoid++;
    else if (p === "prohibited") prohibited++;
    else allowed++;
  }
  return { allowed, avoid, prohibited };
}
