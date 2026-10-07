import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, costEvents, createDb, issueComments, issues, teams } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { RUN_AIC_CAP_ERROR_CODE, RUN_TIME_LIMIT_ERROR_CODE, runLimitTiming } from "../services/run-limits.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "run_limit_capture";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat run limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat scoped run limits", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipApiUrl: string | undefined;
  let paperclipHome: string | null = null;
  const capturedConfigs: Array<Record<string, unknown>> = [];
  let messagesEmitted = 0;
  let recordAic = false;
  /** When set, the adapter does no work and reports this much AIC only when it returns. */
  let endOfRunAic: number | null = null;
  const defaultAicPollMs = runLimitTiming.aicPollIntervalMs;

  beforeAll(async () => {
    runLimitTiming.aicPollIntervalMs = 100;
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-limits-");
    db = createDb(tempDb.connectionString);
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-limits-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    oldPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => {
        capturedConfigs.push(ctx.config);
        await ctx.onCancellationReady?.();
        if (endOfRunAic !== null) {
          await db.insert(costEvents).values({
            companyId: ctx.agent.companyId,
            agentId: ctx.agent.id,
            heartbeatRunId: ctx.runId,
            provider: "pilot",
            model: "test",
            costCents: endOfRunAic,
            occurredAt: new Date(),
          });
          return { exitCode: 0, signal: null, timedOut: false };
        }
        // Record 100 AIC (cents) per step for this run, like the pilot bridge does, until aborted.
        for (let i = 0; i < 200 && !ctx.signal?.aborted; i += 1) {
          messagesEmitted += 1;
          await ctx.onLog("stdout", `step ${i}\n`);
          if (recordAic) {
            await db.insert(costEvents).values({
              companyId: ctx.agent.companyId,
              agentId: ctx.agent.id,
              heartbeatRunId: ctx.runId,
              provider: "pilot",
              model: "test",
              costCents: 100,
              occurredAt: new Date(),
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { exitCode: ctx.signal?.aborted ? null : 0, signal: null, timedOut: false };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    capturedConfigs.length = 0;
    messagesEmitted = 0;
    recordAic = false;
    endOfRunAic = null;
    runLimitTiming.aicPollIntervalMs = 100;
    // Post-cancel finalization may still be writing; retry a deadlocked truncate.
    for (let attempt = 0; ; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        await truncateAll();
        break;
      } catch (error) {
        const code = (error as { code?: string; cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
        if (code !== "40P01" || attempt >= 10) throw error;
      }
    }
  });

  const truncateAll = () =>
    db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "cost_events",
        "issue_comments",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "issues",
        "agents",
        "teams",
        "companies"
      RESTART IDENTITY CASCADE
    `));

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    runLimitTiming.aicPollIntervalMs = defaultAicPollMs;
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldPaperclipApiUrl;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("injects the team model and stops the run mid-run at the company AIC ceiling with resume notes", async () => {
    recordAic = true;
    const companyId = randomUUID();
    const teamId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db
      .insert(authUsers)
      .values({ id: "responsible-user", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      runLimits: { model: "company-model", maxAicPerRun: 450 },
    });
    // The team asks for more than the company ceiling, so the company value applies.
    await db.insert(teams).values({ id: teamId, companyId, name: "Platform", runLimits: { model: "team-model", maxAicPerRun: 5000 } });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      teamId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long task",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);

    expect(capturedConfigs[0]?.model).toBe("team-model");
    expect(finished?.status).toBe("cancelled");
    expect(finished?.errorCode).toBe(RUN_AIC_CAP_ERROR_CODE);
    // 5 steps x 100 AIC crosses 450; with a 100ms poll the adapter must stop well before its 200-step end.
    expect(messagesEmitted).toBeLessThan(60);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const capComment = comments.find((comment) => comment.body.includes("AIC cap reached"));
    expect(capComment?.body).toContain("set at company level");
    expect(capComment?.body).toContain("asked for more than the company ceiling");
    expect(capComment?.body).toContain("Next actions");
    expect(capComment?.body).toContain("team-model (from team)");
  }, 30_000);

  it("flags a run that reaches the AIC cap only at run end without cancelling it", async () => {
    endOfRunAic = 300;
    // Keep the live poll out of the way: this adapter reports cost only when it returns.
    runLimitTiming.aicPollIntervalMs = 60_000;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db
      .insert(authUsers)
      .values({ id: "responsible-user", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      // Exactly at the cap: reaching the cap counts as exceeding it.
      runLimits: { maxAicPerRun: 300 },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Quick task",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    await waitForRunToFinish(heartbeat, run!.id);
    // The post-run check runs after the terminal status write; wait for its comment.
    let capComment: { body: string } | undefined;
    for (let i = 0; i < 100 && !capComment; i += 1) {
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      capComment = comments.find((comment) => comment.body.includes("AIC cap reached"));
      if (!capComment) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const finished = await heartbeat.getRun(run!.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.errorCode).not.toBe(RUN_AIC_CAP_ERROR_CODE);
    expect((finished?.resultJson as Record<string, unknown>)?.runLimitExceeded).toMatchObject({ kind: "aic", observed: 300, postRun: true });
    expect(capComment?.body).toContain("after it ended");
    expect(capComment?.body).toContain("Next actions");
  }, 30_000);

  it("stops the run at the team time limit with resume notes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db
      .insert(authUsers)
      .values({ id: "responsible-user", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      runLimits: { timeoutSec: 3600 },
    });
    const teamId = randomUUID();
    await db.insert(teams).values({ id: teamId, companyId, name: "Platform", runLimits: { timeoutSec: 1 } });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      teamId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Slow task",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    const finished = await waitForRunToFinish(heartbeat, run!.id);

    expect(finished?.status).toBe("cancelled");
    expect(finished?.errorCode).toBe(RUN_TIME_LIMIT_ERROR_CODE);
    // The adapter would emit 200 steps of 20ms (about 4s); the 1s team limit must cut it short.
    // Count steps, not wall-clock time, so a slow host does not make the check flaky.
    expect(messagesEmitted).toBeLessThan(150);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const stopComment = comments.find((comment) => comment.body.includes("time limit reached"));
    expect(stopComment?.body).toContain("set at team level");
    expect(stopComment?.body).toContain("Next actions");
  }, 30_000);
});
