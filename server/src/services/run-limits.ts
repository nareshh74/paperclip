import type { EffectiveRunLimits, RunLimitKey, RunLimitSource, RunLimits } from "@paperclipai/shared";

export const RUN_AIC_CAP_ERROR_CODE = "run_aic_cap_exceeded";
export const RUN_TIME_LIMIT_ERROR_CODE = "run_time_limit_exceeded";

/** Polling cadence for the per-run AIC check. Mutable only so tests can shorten it. */
export const runLimitTiming = { aicPollIntervalMs: 15_000 };

export type RunLimitStopKind = "aic" | "time";

type ScopeInput = RunLimits | Record<string, unknown> | null | undefined;

const GENERAL_TO_SPECIFIC: RunLimitSource[] = ["company", "team", "agent", "task"];

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Resolve one run's limits.
 *
 * - `model`: the most specific level that sets it wins.
 * - `maxAicPerRun` and `timeoutSec` are ceilings: company >= team >= agent >= task.
 *   Start from the company value; each more specific level may only lower it.
 *   A level that asks for more than its ceiling is held to the ceiling and the
 *   key is listed in `clamped`.
 * - `timeoutSec` keeps the adapter contract that a negative value means "no adapter
 *   timeout". At agent or task level that clears agent/task values, but it never
 *   removes a company or team ceiling.
 */
export function resolveEffectiveRunLimits(
  scopes: Partial<Record<RunLimitSource, ScopeInput>>,
): EffectiveRunLimits {
  const result: EffectiveRunLimits = { model: null, maxAicPerRun: null, timeoutSec: null, sources: {}, clamped: [] };
  const read = (source: RunLimitSource, key: RunLimitKey) =>
    (scopes[source] as Record<string, unknown> | null | undefined)?.[key];

  for (const source of GENERAL_TO_SPECIFIC) {
    const model = read(source, "model");
    if (typeof model === "string" && model.trim()) {
      result.model = model.trim();
      result.sources.model = source;
    }
  }

  for (const key of ["maxAicPerRun", "timeoutSec"] as const) {
    let value: number | null = null;
    let from: RunLimitSource | undefined;
    let ceiling: number | null = null;
    let ceilingFrom: RunLimitSource | undefined;
    let clamped = false;
    for (const source of GENERAL_TO_SPECIFIC) {
      const raw = read(source, key);
      const isCeilingLevel = source === "company" || source === "team";
      if (key === "timeoutSec" && typeof raw === "number" && raw < 0 && !isCeilingLevel) {
        // Explicit "no timeout" only drops agent/task values; a ceiling stays.
        value = ceiling;
        from = ceilingFrom;
        if (ceiling !== null) clamped = true;
        continue;
      }
      const next = readPositiveInt(raw);
      if (next === null) continue;
      if (value !== null && next > value) {
        clamped = true;
        continue;
      }
      value = next;
      from = source;
      if (isCeilingLevel) {
        ceiling = next;
        ceilingFrom = source;
      }
    }
    result[key] = value;
    if (from) result.sources[key] = from;
    if (clamped) result.clamped.push(key);
  }
  return result;
}

/** Issue comment that lets a later session or agent resume after a limit stop. */
export function buildRunLimitStopComment(input: {
  kind: RunLimitStopKind;
  runId: string;
  agentName: string;
  /** AIC recorded for an AIC stop, elapsed seconds for a time stop. */
  observed: number;
  limits: EffectiveRunLimits;
  lastOutputExcerpt: string | null;
}): string {
  const { limits } = input;
  const key: RunLimitKey = input.kind === "time" ? "timeoutSec" : "maxAicPerRun";
  const limit = limits[key];
  const level = limits.sources[key] ?? "configured";
  const what =
    input.kind === "time"
      ? `time limit reached (${input.observed}s of ${limit}s`
      : `AIC cap reached (${input.observed} of ${limit} AIC`;
  const clampNote = limits.clamped.includes(key)
    ? [`- A lower level asked for more than the ${level} ceiling, so the ${level} value applied.`]
    : [];
  const excerpt = input.lastOutputExcerpt?.trim();
  return [
    `Run stopped: ${what}, set at ${level} level).`,
    "",
    "**Resume notes**",
    `- Run: \`${input.runId}\`; agent: ${input.agentName}; model: ${limits.model ?? "adapter default"}${limits.sources.model ? ` (from ${limits.sources.model})` : ""}.`,
    ...clampNote,
    "- The agent session is kept, so the next run on this task continues from the same conversation.",
    "- Check the run log for work already done before you repeat any step.",
    "",
    "**Next actions**",
    "1. Split the remaining work into smaller subtasks, or",
    `2. Raise \`${key}\` at the ${level} level (lower levels cannot exceed it), then`,
    "3. Wake the assignee again to continue.",
    ...(excerpt ? ["", "**Last output before stop**", "```", excerpt.slice(-1500), "```"] : []),
  ].join("\n");
}
