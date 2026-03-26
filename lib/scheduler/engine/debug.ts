import type { RuleGroup } from "./types";

const ALL_GROUPS: RuleGroup[] = [
  "requirements",
  "capacity",
  "pgy",
  "spacing_same_rotation",
  "spacing_strenuous_b2b",
  "spacing_transplant_b2b",
  "vacation_null",
  "vacation_overlap_policy",
  "fixed_rules",
  "completeness",
];

/**
 * SCHEDULER_DEBUG_RULES=comma,separated,groups or `all` or `1` for everything.
 * Example: SCHEDULER_DEBUG_RULES=requirements,capacity
 */
export function isRuleGroupDebugEnabled(group: RuleGroup): boolean {
  const raw = (process.env.SCHEDULER_DEBUG_RULES ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false") return false;
  if (raw === "all" || raw === "1" || raw === "true") return true;
  const set = new Set(
    raw
      .split(/[, ]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set.has(group);
}

export function debugLog(group: RuleGroup, message: string): void {
  if (!isRuleGroupDebugEnabled(group)) return;
  console.info(`[scheduler:${group}] ${message}`);
}

export function listRuleGroups(): RuleGroup[] {
  return [...ALL_GROUPS];
}
