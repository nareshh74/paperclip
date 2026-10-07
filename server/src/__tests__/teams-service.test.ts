import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, budgetPolicies, companies, costEvents, createDb, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { teamService } from "../services/teams.js";
import { agentService } from "../services/agents.js";
import { budgetService } from "../services/budgets.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("team service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE "activity_log", "cost_events", "budget_policies", "budget_incidents", "issues",
        "project_pm_handoffs", "team_projects", "projects", "agents", "teams", "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedProject(companyId: string, name = "Apollo") {
    const [row] = await db.insert(projects).values({ companyId, name }).returning();
    return row!;
  }

  it("creates, updates, and scopes teams to a company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = teamService(db);

    const team = await svc.create(companyId, {
      name: "Platform",
      runLimits: { model: "m-1", maxAicPerRun: 5000, timeoutSec: 900 },
    });
    expect(team).toMatchObject({ companyId, runLimits: { model: "m-1", maxAicPerRun: 5000, timeoutSec: 900 } });

    const updated = await svc.update(companyId, team.id, { runLimits: { timeoutSec: 60 } });
    expect(updated.runLimits).toEqual({ timeoutSec: 60 });

    await expect(svc.create(companyId, { name: "Platform" })).rejects.toMatchObject({ status: 409 });
    await expect(svc.getById(otherCompanyId, team.id)).rejects.toMatchObject({ status: 404 });
    expect(await svc.list(otherCompanyId)).toEqual([]);
  });

  it("rejects a cross-company team on agents and detaches members on delete", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = teamService(db);
    const team = await svc.create(companyId, { name: "Platform" });
    const foreignTeam = await svc.create(otherCompanyId, { name: "Foreign" });

    const agentsSvc = agentService(db);
    await expect(
      agentsSvc.create(companyId, { name: "Builder", adapterType: "process", teamId: foreignTeam.id }),
    ).rejects.toMatchObject({ status: 422 });

    const agent = await agentsSvc.create(companyId, { name: "Builder", adapterType: "process", teamId: team.id });
    expect(await svc.listMemberIds(companyId, team.id)).toEqual([agent.id]);

    await svc.remove(companyId, team.id);
    const [row] = await db.select({ teamId: agents.teamId }).from(agents).where(eq(agents.id, agent.id));
    expect(row?.teamId).toBeNull();
  });

  it("makes team members report to the team manager", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = teamService(db);
    const agentsSvc = agentService(db);
    const ceo = await agentsSvc.create(companyId, { name: "Chief", role: "ceo", adapterType: "process" });
    const manager = await agentsSvc.create(companyId, { name: "Eng Manager", adapterType: "process", reportsTo: ceo.id });
    const foreign = await agentsSvc.create(otherCompanyId, { name: "Outsider", adapterType: "process" });

    await expect(svc.create(companyId, { name: "Bad", managerAgentId: foreign.id })).rejects.toMatchObject({ status: 422 });

    const team = await svc.create(companyId, { name: "Platform" });
    const early = await agentsSvc.create(companyId, { name: "Early", adapterType: "process", teamId: team.id, reportsTo: ceo.id });
    expect(early.reportsTo).toBe(ceo.id);

    // Appointing a manager moves existing members under the manager; the manager keeps reporting to the CEO.
    await agentsSvc.update(manager.id, { teamId: team.id });
    await svc.update(companyId, team.id, { managerAgentId: manager.id });
    const rows = await db.select({ id: agents.id, reportsTo: agents.reportsTo }).from(agents).where(eq(agents.teamId, team.id));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.reportsTo]))).toEqual({
      [early.id]: manager.id,
      [manager.id]: ceo.id,
    });

    // New and moved members report to the manager.
    const late = await agentsSvc.create(companyId, { name: "Late", adapterType: "process", teamId: team.id });
    expect(late.reportsTo).toBe(manager.id);
    const mover = await agentsSvc.create(companyId, { name: "Mover", adapterType: "process", reportsTo: ceo.id });
    expect((await agentsSvc.update(mover.id, { teamId: team.id }))?.reportsTo).toBe(manager.id);
  });

  it("links teams to projects many-to-many within a company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = teamService(db);
    const a = await svc.create(companyId, { name: "A" });
    const b = await svc.create(companyId, { name: "B" });
    const p1 = await seedProject(companyId, "P1");
    const p2 = await seedProject(companyId, "P2");
    const foreignProject = await seedProject(otherCompanyId, "Foreign");

    expect(await svc.linkProject(companyId, a.id, p1.id)).toEqual({ created: true });
    expect(await svc.linkProject(companyId, a.id, p1.id)).toEqual({ created: false });
    await svc.linkProject(companyId, a.id, p2.id);
    await svc.linkProject(companyId, b.id, p1.id);
    await expect(svc.linkProject(companyId, a.id, foreignProject.id)).rejects.toMatchObject({ status: 404 });

    const byName = Object.fromEntries((await svc.list(companyId)).map((team) => [team.name, team.projectIds.sort()]));
    expect(byName).toEqual({ A: [p1.id, p2.id].sort(), B: [p1.id] });

    await svc.unlinkProject(companyId, a.id, p1.id);
    expect((await svc.getWithProjects(companyId, a.id)).projectIds).toEqual([p2.id]);
    await expect(svc.unlinkProject(companyId, a.id, p1.id)).rejects.toMatchObject({ status: 404 });
  });

  it("hands off a project manager and keeps the history", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = teamService(db);
    const agentsSvc = agentService(db);
    const pm1 = await agentsSvc.create(companyId, { name: "PM One", adapterType: "process" });
    const pm2 = await agentsSvc.create(companyId, { name: "PM Two", adapterType: "process" });
    const foreign = await agentsSvc.create(otherCompanyId, { name: "Outsider", adapterType: "process" });
    const project = await seedProject(companyId);
    const actor = { actorType: "user", actorId: "board" };

    await svc.handOffProjectManager(companyId, project.id, { toAgentId: pm1.id, reason: "kickoff", ...actor });
    await svc.handOffProjectManager(companyId, project.id, { toAgentId: pm2.id, reason: "rotation", ...actor });
    await expect(
      svc.handOffProjectManager(companyId, project.id, { toAgentId: foreign.id, ...actor }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      svc.handOffProjectManager(otherCompanyId, project.id, { toAgentId: foreign.id, ...actor }),
    ).rejects.toMatchObject({ status: 404 });

    const [row] = await db.select({ leadAgentId: projects.leadAgentId }).from(projects).where(eq(projects.id, project.id));
    expect(row?.leadAgentId).toBe(pm2.id);
    const history = await svc.listProjectManagerHandoffs(companyId, project.id);
    expect(history.map((h) => [h.fromAgentId, h.toAgentId, h.reason])).toEqual([
      [pm1.id, pm2.id, "rotation"],
      [null, pm1.id, "kickoff"],
    ]);
  });

  it("allows one in-progress task per agent and logs the rejected pickup", async () => {
    const companyId = await seedCompany();
    const agentsSvc = agentService(db);
    const agent = await agentsSvc.create(companyId, { name: "Builder", adapterType: "process", status: "idle" });
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    const [first, second] = await db
      .insert(issues)
      .values([1, 2].map((n) => ({
        companyId,
        title: `Task ${n}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agent.id,
        issueNumber: n,
        identifier: `${company!.issuePrefix}-${n}`,
      })))
      .returning();
    const svc = issueService(db);

    await svc.checkout(first!.id, agent.id, ["todo"], null);
    // Re-checkout of the same issue by the same agent still succeeds.
    await svc.checkout(first!.id, agent.id, ["in_progress"], null);

    await expect(svc.checkout(second!.id, agent.id, ["todo"], null)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_has_task_in_progress", inProgressIssueId: first!.id, blockedIssueId: second!.id },
    });
    await expect(svc.update(second!.id, { status: "in_progress" })).rejects.toMatchObject({ status: 409 });

    const rejections = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.task_pickup_rejected")));
    expect(rejections).toHaveLength(2);
    expect(rejections[0]?.details).toMatchObject({ agentId: agent.id, blockedIssueId: second!.id, inProgressIssueId: first!.id });

    // Once the first task is done, the agent can pick up the next one.
    await svc.update(first!.id, { status: "done" });
    await expect(svc.checkout(second!.id, agent.id, ["todo"], null)).resolves.toMatchObject({ status: "in_progress" });
  });

  it("aggregates team budget spend over member agents and blocks member runs at the hard stop", async () => {
    const companyId = await seedCompany();
    const svc = teamService(db);
    const agentsSvc = agentService(db);
    const team = await svc.create(companyId, { name: "Platform" });
    const member1 = await agentsSvc.create(companyId, { name: "M1", adapterType: "process", teamId: team.id });
    const member2 = await agentsSvc.create(companyId, { name: "M2", adapterType: "process", teamId: team.id });
    const outsider = await agentsSvc.create(companyId, { name: "Out", adapterType: "process" });
    const now = new Date();
    for (const [agentId, costCents] of [[member1.id, 300], [member2.id, 250], [outsider.id, 10_000]] as const) {
      await db.insert(costEvents).values({ companyId, agentId, provider: "pilot", model: "m", costCents, occurredAt: now });
    }
    const budgets = budgetService(db);
    const summary = await budgets.upsertPolicy(
      companyId,
      { scopeType: "team", scopeId: team.id, amount: 500, hardStopEnabled: true },
      "board",
    );
    expect(summary).toMatchObject({ scopeType: "team", scopeName: "Platform", observedAmount: 550 });

    expect(await budgets.getInvocationBlock(companyId, member1.id)).toMatchObject({ scopeType: "team", scopeId: team.id });
    expect(await budgets.getInvocationBlock(companyId, outsider.id)).toBeNull();
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, team.id));
    expect(policy?.scopeType).toBe("team");
  });
});
