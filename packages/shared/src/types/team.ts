/**
 * Run limits configurable at company, team, agent, and task level.
 * Company and team store them in a `runLimits` column. Agent and task use the
 * same keys inside `adapterConfig` (agent) and `assigneeAdapterOverrides.adapterConfig` (task).
 */
export interface RunLimits {
  /** Model id passed to the adapter as `adapterConfig.model`. */
  model?: string | null;
  /** The run is stopped when its output tokens go over this. */
  maxOutputTokensPerRun?: number | null;
  /** Wall-clock limit for one run, in seconds. The run is stopped when it is exceeded. */
  timeoutSec?: number | null;
}

export type RunLimitKey = keyof RunLimits;

export const RUN_LIMIT_KEYS: readonly RunLimitKey[] = ["model", "maxOutputTokensPerRun", "timeoutSec"];

/** Hierarchy level a resolved limit came from. */
export type RunLimitSource = "task" | "agent" | "team" | "company";

export interface Team {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  runLimits: RunLimits;
  createdAt: Date;
  updatedAt: Date;
}

export interface EffectiveRunLimits {
  model: string | null;
  maxOutputTokensPerRun: number | null;
  timeoutSec: number | null;
  /** Level each set limit came from. A key is absent when no level sets it. */
  sources: Partial<Record<RunLimitKey, RunLimitSource>>;
}
