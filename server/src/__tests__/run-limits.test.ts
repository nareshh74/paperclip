import { describe, expect, it } from "vitest";
import { buildRunLimitStopComment, resolveEffectiveRunLimits } from "../services/run-limits.js";

describe("resolveEffectiveRunLimits", () => {
  it("lets each lower level only lower a ceiling, and picks the most specific model", () => {
    const scopes = {
      task: { model: "task-model" },
      agent: { model: "agent-model", maxAicPerRun: 500 },
      team: { model: "team-model", maxAicPerRun: 1000, timeoutSec: 600 },
      company: { model: "company-model", maxAicPerRun: 2000, timeoutSec: 3600 },
    };
    expect(resolveEffectiveRunLimits(scopes)).toEqual({
      model: "task-model",
      maxAicPerRun: 500,
      timeoutSec: 600,
      sources: { model: "task", maxAicPerRun: "agent", timeoutSec: "team" },
      clamped: [],
    });
    expect(resolveEffectiveRunLimits({ company: scopes.company })).toEqual({
      model: "company-model",
      maxAicPerRun: 2000,
      timeoutSec: 3600,
      sources: { model: "company", maxAicPerRun: "company", timeoutSec: "company" },
      clamped: [],
    });
  });

  it("clamps a lower level that asks for more than its ceiling", () => {
    const limits = resolveEffectiveRunLimits({
      task: { maxAicPerRun: 50_000, timeoutSec: 30 },
      agent: { maxAicPerRun: 9_000 },
      team: { maxAicPerRun: 3_000, timeoutSec: 7200 },
      company: { maxAicPerRun: 2_000, timeoutSec: 3600 },
    });
    expect(limits.maxAicPerRun).toBe(2_000);
    expect(limits.sources.maxAicPerRun).toBe("company");
    expect(limits.timeoutSec).toBe(30);
    expect(limits.sources.timeoutSec).toBe("task");
    expect(limits.clamped).toEqual(["maxAicPerRun", "timeoutSec"]);
  });

  it("uses the lowest value when only lower levels set it", () => {
    const limits = resolveEffectiveRunLimits({ task: { maxAicPerRun: 80 }, agent: { maxAicPerRun: 100 } });
    expect(limits).toMatchObject({ maxAicPerRun: 80, sources: { maxAicPerRun: "task" }, clamped: [] });
  });

  it("ignores blank models and non-positive or fractional numbers", () => {
    expect(
      resolveEffectiveRunLimits({
        agent: { model: "  ", maxAicPerRun: 0, timeoutSec: 1.5 },
        company: { model: null, maxAicPerRun: -1, timeoutSec: "60" },
      }),
    ).toEqual({ model: null, maxAicPerRun: null, timeoutSec: null, sources: {}, clamped: [] });
  });
});

describe("resolveEffectiveRunLimits time limit opt-out", () => {
  it("treats a negative agent timeoutSec as no adapter timeout when no ceiling exists", () => {
    const limits = resolveEffectiveRunLimits({ agent: { timeoutSec: -1 } });
    expect(limits.timeoutSec).toBeNull();
    expect(limits.sources.timeoutSec).toBeUndefined();
  });

  it("does not let a negative agent or task timeoutSec remove a company or team ceiling", () => {
    const fromCompany = resolveEffectiveRunLimits({ agent: { timeoutSec: -1 }, company: { timeoutSec: 600 } });
    expect(fromCompany).toMatchObject({ timeoutSec: 600, sources: { timeoutSec: "company" }, clamped: ["timeoutSec"] });
    const fromTeam = resolveEffectiveRunLimits({
      task: { timeoutSec: -1 },
      agent: { timeoutSec: 120 },
      team: { timeoutSec: 300 },
    });
    expect(fromTeam).toMatchObject({ timeoutSec: 300, sources: { timeoutSec: "team" } });
  });

  it("treats timeoutSec 0 as unset, as the adapter UI stores 0 for untouched fields", () => {
    expect(resolveEffectiveRunLimits({ agent: { timeoutSec: 0 }, company: { timeoutSec: 600 } }).sources.timeoutSec).toBe("company");
  });
});

describe("buildRunLimitStopComment", () => {
  const limits = {
    model: "team-model",
    maxAicPerRun: 1000,
    timeoutSec: 600,
    sources: { model: "team", maxAicPerRun: "company", timeoutSec: "task" } as const,
    clamped: [] as Array<"maxAicPerRun" | "timeoutSec" | "model">,
  };

  it("names the AIC cap, its level, and resume steps", () => {
    const body = buildRunLimitStopComment({
      kind: "aic", runId: "run-1", agentName: "Builder", observed: 1200,
      limits, lastOutputExcerpt: "last line",
    });
    expect(body).toContain("AIC cap reached (1200 of 1000 AIC, set at company level)");
    expect(body).toContain("Raise `maxAicPerRun` at the company level");
    expect(body).toContain("team-model (from team)");
    expect(body).toContain("last line");
    expect(body).not.toContain("ceiling, so");
  });

  it("mentions clamping when a lower level asked for more", () => {
    const body = buildRunLimitStopComment({
      kind: "aic", runId: "run-1", agentName: "Builder", observed: 1200,
      limits: { ...limits, clamped: ["maxAicPerRun"] }, lastOutputExcerpt: null,
    });
    expect(body).toContain("asked for more than the company ceiling");
  });

  it("describes a time stop", () => {
    const body = buildRunLimitStopComment({
      kind: "time", runId: "run-2", agentName: "Builder", observed: 601, limits, lastOutputExcerpt: null,
    });
    expect(body).toContain("time limit reached (601s of 600s, set at task level)");
    expect(body).not.toContain("Last output before stop");
  });
});
