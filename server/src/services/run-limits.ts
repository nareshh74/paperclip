import { RUN_LIMIT_KEYS } from "@paperclipai/shared";
import type { EffectiveRunLimits, RunLimitKey, RunLimitSource, RunLimits } from "@paperclipai/shared";

export const OUTPUT_TOKEN_CAP_ERROR_CODE = "output_token_cap_exceeded";
export const RUN_TIME_LIMIT_ERROR_CODE = "run_time_limit_exceeded";

export type RunLimitStopKind = "output_tokens" | "time";

function readLimit(key: RunLimitKey, value: unknown): string | number | null {
  if (key === "model") return typeof value === "string" && value.trim() ? value.trim() : null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Resolve one run's limits. Each key resolves on its own: the most specific
 * level that sets it wins (task, then agent, then team, then company).
 * Agent and task read the same keys from their adapter config.
 */
export function resolveEffectiveRunLimits(
  scopes: Partial<Record<RunLimitSource, RunLimits | Record<string, unknown> | null | undefined>>,
): EffectiveRunLimits {
  const result: EffectiveRunLimits = { model: null, maxOutputTokensPerRun: null, timeoutSec: null, sources: {} };
  const order: RunLimitSource[] = ["task", "agent", "team", "company"];
  for (const key of RUN_LIMIT_KEYS) {
    for (const source of order) {
      const raw = (scopes[source] as Record<string, unknown> | null | undefined)?.[key];
      // Existing adapter contract: a negative timeoutSec means "explicitly no time limit".
      if (key === "timeoutSec" && typeof raw === "number" && raw < 0) break;
      const value = readLimit(key, raw);
      if (value === null) continue;
      (result as unknown as Record<string, unknown>)[key] = value;
      result.sources[key] = source;
      break;
    }
  }
  return result;
}

/**
 * Counts output tokens from adapter stdout while a run is live.
 *
 * Understands the stream-json shapes Paperclip adapters already emit:
 * - Claude `assistant` events carry `message.usage.output_tokens` per message
 *   (repeated per content block, so they are de-duplicated by `message.id`).
 * - Codex `turn.completed` events carry per-turn `usage.output_tokens`.
 * - Final `result` events carry a run total; it is taken when it is larger.
 *
 * ponytail: stdout heuristics only; adapters that never print usage cannot be
 * stopped mid-run by the token cap. Add an adapter usage callback if needed.
 */
export function createOutputTokenMeter() {
  const perMessage = new Map<string, number>();
  let turnTotal = 0;
  let reportedTotal = 0;
  let buffer = "";
  let anonymousMessages = 0;

  function readTokens(usage: unknown): number {
    if (!usage || typeof usage !== "object") return 0;
    const value = (usage as Record<string, unknown>).output_tokens;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  }

  function handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type === "assistant" && event.message && typeof event.message === "object") {
      const message = event.message as Record<string, unknown>;
      const tokens = readTokens(message.usage);
      const id = typeof message.id === "string" ? message.id : `anon-${(anonymousMessages += 1)}`;
      perMessage.set(id, Math.max(perMessage.get(id) ?? 0, tokens));
    } else if (event.type === "turn.completed") {
      turnTotal += readTokens(event.usage);
    } else if (event.type === "result") {
      reportedTotal = Math.max(reportedTotal, readTokens(event.usage));
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    },
    total() {
      let messageTotal = 0;
      for (const value of perMessage.values()) messageTotal += value;
      return Math.max(messageTotal + turnTotal, reportedTotal);
    },
  };
}

/** Issue comment that lets a later session or agent resume after a limit stop. */
export function buildRunLimitStopComment(input: {
  kind: RunLimitStopKind;
  runId: string;
  agentName: string;
  /** Output tokens for a token stop, elapsed seconds for a time stop. */
  observed: number;
  limits: EffectiveRunLimits;
  lastOutputExcerpt: string | null;
}): string {
  const { limits } = input;
  const key: RunLimitKey = input.kind === "time" ? "timeoutSec" : "maxOutputTokensPerRun";
  const limit = limits[key];
  const level = limits.sources[key] ?? "configured";
  const what =
    input.kind === "time"
      ? `time limit reached (${input.observed}s of ${limit}s`
      : `output-token cap reached (${input.observed} of ${limit} tokens`;
  const excerpt = input.lastOutputExcerpt?.trim();
  return [
    `Run stopped: ${what}, set at ${level} level).`,
    "",
    "**Resume notes**",
    `- Run: \`${input.runId}\`; agent: ${input.agentName}; model: ${limits.model ?? "adapter default"}${limits.sources.model ? ` (from ${limits.sources.model})` : ""}.`,
    "- The agent session is kept, so the next run on this task continues from the same conversation.",
    "- Check the run log for work already done before you repeat any step.",
    "",
    "**Next actions**",
    "1. Split the remaining work into smaller subtasks, or",
    `2. Raise \`${key}\` at the ${level} level (or set a larger task override), then`,
    "3. Wake the assignee again to continue.",
    ...(excerpt ? ["", "**Last output before stop**", "```", excerpt.slice(-1500), "```"] : []),
  ].join("\n");
}
