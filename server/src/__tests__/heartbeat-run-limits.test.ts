import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, issueComments, issues, teams } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { OUTPUT_TOKEN_CAP_ERROR_CODE, RUN_TIME_LIMIT_ERROR_CODE } from "../services/run-limits.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "output_token_cap_capture";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat output-token cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

  beforeAll(async () => {
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
        // Stream Claude-style assistant messages until the host aborts the run.
        for (let i = 0; i < 200 && !ctx.signal?.aborted; i += 1) {
          messagesEmitted += 1;
          await ctx.onLog(
            "stdout",
            `${JSON.stringify({ type: "assistant", message: { id: `m${i}`, usage: { output_tokens: 100 } } })}\n`,
          );
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
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldPaperclipApiUrl;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("injects the team model and stops the run mid-stream at the company cap with resume notes", async () => {
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
      runLimits: { model: "company-model", maxOutputTokensPerRun: 450 },
    });
    await db.insert(teams).values({ id: teamId, companyId, name: "Platform", runLimits: { model: "team-model" } });
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
    expect(finished?.errorCode).toBe(OUTPUT_TOKEN_CAP_ERROR_CODE);
    // 5 messages x 100 tokens crosses 450; the adapter must not run to its 200-message end.
    expect(messagesEmitted).toBeLessThan(20);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const capComment = comments.find((comment) => comment.body.includes("output-token cap reached"));
    expect(capComment?.body).toContain("set at company level");
    expect(capComment?.body).toContain("Next actions");
    expect(capComment?.body).toContain("team-model (from team)");
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
    const startedAt = Date.now();
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    const finished = await waitForRunToFinish(heartbeat, run!.id);

    expect(finished?.status).toBe("cancelled");
    expect(finished?.errorCode).toBe(RUN_TIME_LIMIT_ERROR_CODE);
    // The adapter would emit for about 4s (200 x 20ms); the 1s team limit must cut it short.
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const stopComment = comments.find((comment) => comment.body.includes("time limit reached"));
    expect(stopComment?.body).toContain("set at team level");
    expect(stopComment?.body).toContain("Next actions");
  }, 30_000);
});
