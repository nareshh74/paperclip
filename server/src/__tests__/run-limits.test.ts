import { describe, expect, it } from "vitest";
import {
  buildRunLimitStopComment,
  createOutputTokenMeter,
  resolveEffectiveRunLimits,
} from "../services/run-limits.js";

describe("resolveEffectiveRunLimits", () => {
  it("resolves each key from the most specific level that sets it", () => {
    const scopes = {
      task: { model: "task-model" },
      agent: { model: "agent-model", maxOutputTokensPerRun: 500 },
      team: { model: "team-model", maxOutputTokensPerRun: 1000, timeoutSec: 600 },
      company: { model: "company-model", maxOutputTokensPerRun: 2000, timeoutSec: 3600 },
    };
    expect(resolveEffectiveRunLimits(scopes)).toEqual({
      model: "task-model",
      maxOutputTokensPerRun: 500,
      timeoutSec: 600,
      sources: { model: "task", maxOutputTokensPerRun: "agent", timeoutSec: "team" },
    });
    expect(resolveEffectiveRunLimits({ company: scopes.company })).toEqual({
      model: "company-model",
      maxOutputTokensPerRun: 2000,
      timeoutSec: 3600,
      sources: { model: "company", maxOutputTokensPerRun: "company", timeoutSec: "company" },
    });
  });

  it("ignores blank models and non-positive or fractional numbers", () => {
    expect(
      resolveEffectiveRunLimits({
        agent: { model: "  ", maxOutputTokensPerRun: 0, timeoutSec: 1.5 },
        company: { model: null, maxOutputTokensPerRun: -1, timeoutSec: "60" },
      }),
    ).toEqual({ model: null, maxOutputTokensPerRun: null, timeoutSec: null, sources: {} });
  });
});

describe("resolveEffectiveRunLimits time limit opt-out", () => {
  it("treats a negative timeoutSec as an explicit no-limit that stops inheritance", () => {
    const limits = resolveEffectiveRunLimits({ agent: { timeoutSec: -1 }, company: { timeoutSec: 600 } });
    expect(limits.timeoutSec).toBeNull();
    expect(limits.sources.timeoutSec).toBeUndefined();
  });

  it("treats timeoutSec 0 as unset, as the adapter UI stores 0 for untouched fields", () => {
    expect(resolveEffectiveRunLimits({ agent: { timeoutSec: 0 }, company: { timeoutSec: 600 } }).sources.timeoutSec).toBe("company");
  });
});

describe("createOutputTokenMeter", () => {
  it("counts Claude assistant usage once per message across split chunks", () => {
    const meter = createOutputTokenMeter();
    const a1 = JSON.stringify({ type: "assistant", message: { id: "m1", usage: { output_tokens: 40 } } });
    const a2 = JSON.stringify({ type: "assistant", message: { id: "m2", usage: { output_tokens: 60 } } });
    meter.push(`${a1}\n${a1.slice(0, 10)}`);
    meter.push(`${a1.slice(10)}\n${a2}\nnot json\n`);
    expect(meter.total()).toBe(100);
  });

  it("counts each assistant event without an id as its own message", () => {
    const meter = createOutputTokenMeter();
    const anon = JSON.stringify({ type: "assistant", message: { usage: { output_tokens: 10 } } });
    meter.push(`${anon}
${anon}
${anon}
`);
    expect(meter.total()).toBe(30);
  });

  it("sums Codex turns and takes a larger final result total", () => {
    const meter = createOutputTokenMeter();
    meter.push(`${JSON.stringify({ type: "turn.completed", usage: { output_tokens: 30 } })}\n`);
    meter.push(`${JSON.stringify({ type: "turn.completed", usage: { output_tokens: 20 } })}\n`);
    expect(meter.total()).toBe(50);
    meter.push(`${JSON.stringify({ type: "result", usage: { output_tokens: 75 } })}\n`);
    expect(meter.total()).toBe(75);
  });
});

describe("buildRunLimitStopComment", () => {
  const limits = {
    model: "m",
    maxOutputTokensPerRun: 1000,
    timeoutSec: 60,
    sources: { model: "team", maxOutputTokensPerRun: "company", timeoutSec: "task" } as const,
  };

  it("names the token cap level and the next actions", () => {
    const body = buildRunLimitStopComment({
      kind: "output_tokens", runId: "run-1", agentName: "Builder", observed: 1200,
      limits, lastOutputExcerpt: "last line",
    });
    expect(body).toContain("output-token cap reached (1200 of 1000 tokens, set at company level)");
    expect(body).toContain("Raise `maxOutputTokensPerRun` at the company level");
    expect(body).toContain("model: m (from team)");
    expect(body).toContain("last line");
  });

  it("names the time limit level", () => {
    const body = buildRunLimitStopComment({
      kind: "time", runId: "run-1", agentName: "Builder", observed: 61,
      limits, lastOutputExcerpt: null,
    });
    expect(body).toContain("time limit reached (61s of 60s, set at task level)");
    expect(body).toContain("Raise `timeoutSec` at the task level");
  });
});
