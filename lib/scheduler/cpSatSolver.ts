/**
 * CP-SAT bridge — implementation lives in {@link ./engine/solveFeasibility}.
 */
export type { CpSatGenerateResult } from "./engine/types";
export { solveScheduleFeasibilityCpSat as trySolveScheduleWithCpSat } from "./engine/solveFeasibility";
