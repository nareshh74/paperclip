/**
 * Run limits configurable at company, team, agent, and task level.
 * Company and team store them in a `runLimits` column. Agent and task use the
 * same keys inside `adapterConfig` (agent) and `assigneeAdapterOverrides.adapterConfig` (task).
 */
export interface RunLimits {
  /** Model id passed to the adapter as `adapterConfig.model`. */
  model?: string | null;
  /** The run is stopped when its recorded AIC (1 AIC = 1 cost cent) goes over this. */
  maxAicPerRun?: number | null;
  /** Wall-clock limit for one run, in seconds. The run is stopped when it is exceeded. */
  timeoutSec?: number | null;
}

export type RunLimitKey = keyof RunLimits;

export const RUN_LIMIT_KEYS: readonly RunLimitKey[] = ["model", "maxAicPerRun", "timeoutSec"];

/** Hierarchy level a resolved limit came from. */
export type RunLimitSource = "task" | "agent" | "team" | "company";

export interface Team {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  /** The team's single manager agent. Members report to this agent. */
  managerAgentId: string | null;
  runLimits: RunLimits;
  /** Projects this team works on. */
  projectIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectPmHandoff {
  id: string;
  companyId: string;
  projectId: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  reason: string | null;
  actorType: string;
  actorId: string;
  createdAt: Date;
}

export interface EffectiveRunLimits {
  model: string | null;
  maxAicPerRun: number | null;
  timeoutSec: number | null;
  /** Level each set limit came from. A key is absent when no level sets it. */
  sources: Partial<Record<RunLimitKey, RunLimitSource>>;
  /** Keys where a lower level asked for more than its ceiling and was held to it. */
  clamped: RunLimitKey[];
}
