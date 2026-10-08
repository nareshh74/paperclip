import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { costRoutes } from "../routes/costs.js";
import { taskMatchingRoutes } from "../routes/task-matching.js";
import { teamRoutes } from "../routes/teams.js";
import { teamService } from "../services/teams.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const board: Actor = { type: "board", userId: "local-board", source: "local_implicit" };
function agentActor(companyId: string, agentId: string): Actor {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", teamRoutes(db));
  app.use("/api", costRoutes(db));
  app.use("/api", agentRoutes(db));
  app.use("/api", taskMatchingRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("team permission routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-team-permissions-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE "activity_log", "budget_policies", "budget_incidents", "project_pm_handoffs",
        "matching_outcomes", "matching_trial_arms", "matching_trials", "issues",
        "team_projects", "projects", "agents", "teams", "companies"
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
      name: `Perm Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, role: string, extra: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db
      .insert(agents)
      .values({ companyId, name, role, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, ...extra })
      .returning();
    return row!;
  }

  /** Company with a CEO, two managers with teams, an engineer, a PM, and a project. */
  async function seedOrg() {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, "Ceo", "ceo");
    const manager = await seedAgent(companyId, "Manager", "engineer", { reportsTo: ceo.id });
    const otherManager = await seedAgent(companyId, "Other Manager", "engineer", { reportsTo: ceo.id });
    const engineer = await seedAgent(companyId, "Engineer", "engineer", { reportsTo: ceo.id });
    const pm = await seedAgent(companyId, "Pm", "pm", { reportsTo: ceo.id });
    const teams = teamService(db);
    const team = await teams.create(companyId, { name: "Platform", managerAgentId: manager.id });
    const otherTeam = await teams.create(companyId, { name: "Growth", managerAgentId: otherManager.id });
    const [project] = await db.insert(projects).values({ companyId, name: "Apollo", leadAgentId: pm.id }).returning();
    const outsiderCompanyId = await seedCompany();
    const outsider = await seedAgent(outsiderCompanyId, "Outsider Ceo", "ceo");
    return { companyId, ceo, manager, otherManager, engineer, pm, team, otherTeam, project: project!, outsider, outsiderCompanyId };
  }

  describe("team create, update, delete, and manager appointment", () => {
    it("allows the board and the CEO agent", async () => {
      const org = await seedOrg();
      for (const actor of [board, agentActor(org.companyId, org.ceo.id)]) {
        const app = createApp(db, actor);
        const created = await request(app)
          .post(`/api/companies/${org.companyId}/teams`)
          .send({ name: `Team ${randomUUID().slice(0, 6)}` });
        expect(created.status).toBe(201);
        const appointed = await request(app)
          .patch(`/api/companies/${org.companyId}/teams/${created.body.id}`)
          .send({ managerAgentId: org.engineer.id, runLimits: { timeoutSec: 60 } });
        expect(appointed.status).toBe(200);
        expect(appointed.body.managerAgentId).toBe(org.engineer.id);
        const removed = await request(app).delete(`/api/companies/${org.companyId}/teams/${created.body.id}`);
        expect(removed.status).toBe(204);
      }
    });

    it("rejects an engineer agent and a team manager with 403", async () => {
      const org = await seedOrg();
      for (const agentId of [org.engineer.id, org.manager.id]) {
        const app = createApp(db, agentActor(org.companyId, agentId));
        expect((await request(app).post(`/api/companies/${org.companyId}/teams`).send({ name: "Nope" })).status).toBe(403);
        expect(
          (await request(app)
            .patch(`/api/companies/${org.companyId}/teams/${org.team.id}`)
            .send({ managerAgentId: org.engineer.id })).status,
        ).toBe(403);
        expect((await request(app).delete(`/api/companies/${org.companyId}/teams/${org.team.id}`)).status).toBe(403);
      }
      const team = await teamService(db).getById(org.companyId, org.team.id);
      expect(team.managerAgentId).toBe(org.manager.id);
    });

    it("rejects an agent from another company with 403", async () => {
      const org = await seedOrg();
      const app = createApp(db, agentActor(org.outsiderCompanyId, org.outsider.id));
      expect((await request(app).post(`/api/companies/${org.companyId}/teams`).send({ name: "Nope" })).status).toBe(403);
      expect(
        (await request(app).patch(`/api/companies/${org.companyId}/teams/${org.team.id}`).send({ name: "X" })).status,
      ).toBe(403);
      expect((await request(app).delete(`/api/companies/${org.companyId}/teams/${org.team.id}`)).status).toBe(403);
      // The outsider's own company does not see the team.
      const ownCompany = await request(app)
        .patch(`/api/companies/${org.outsiderCompanyId}/teams/${org.team.id}`)
        .send({ name: "X" });
      expect(ownCompany.status).toBe(404);
    });
  });

  describe("team membership through agent PATCH teamId", () => {
    it("allows the CEO and the board to move a no-team agent into a team and out again", async () => {
      const org = await seedOrg();
      for (const actor of [board, agentActor(org.companyId, org.ceo.id)]) {
        const app = createApp(db, actor);
        const joined = await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id });
        expect(joined.status).toBe(200);
        expect(joined.body).toMatchObject({ teamId: org.team.id, reportsTo: org.manager.id });
        const left = await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: null });
        expect(left.status).toBe(200);
        expect(left.body.teamId).toBeNull();
      }
    });

    it("lets a team manager add a no-team engineer but not remove a member to no team", async () => {
      const org = await seedOrg();
      const app = createApp(db, agentActor(org.companyId, org.manager.id));
      const joined = await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id });
      expect(joined.status).toBe(200);
      expect(joined.body.teamId).toBe(org.team.id);
      expect((await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: null })).status).toBe(403);
      const row = await db.select().from(agents).where(eq(agents.id, org.engineer.id)).then((rows) => rows[0]!);
      expect(row.teamId).toBe(org.team.id);
    });

    it("rejects a team manager adding a no-team manager or PM", async () => {
      const org = await seedOrg();
      const app = createApp(db, agentActor(org.companyId, org.manager.id));
      // otherManager manages another team; pm holds the PM role. Neither may be pulled in by a peer manager.
      for (const target of [org.otherManager.id, org.pm.id]) {
        await db.update(agents).set({ teamId: null }).where(eq(agents.id, target));
        expect((await request(app).patch(`/api/agents/${target}`).send({ teamId: org.team.id })).status).toBe(403);
      }
      // A project lead counts as a manager even without the pm role.
      await db.update(projects).set({ leadAgentId: org.engineer.id }).where(eq(projects.id, org.project.id));
      expect((await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id })).status).toBe(403);
    });

    it("rejects a manager adding a no-team agent to a team they do not manage", async () => {
      const org = await seedOrg();
      const app = createApp(db, agentActor(org.companyId, org.otherManager.id));
      expect((await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id })).status).toBe(403);
    });

    it("lets a manager of both teams move a member between them", async () => {
      const org = await seedOrg();
      await teamService(db).update(org.companyId, org.otherTeam.id, { managerAgentId: org.manager.id });
      await db.update(agents).set({ teamId: org.otherTeam.id }).where(eq(agents.id, org.engineer.id));
      const res = await request(createApp(db, agentActor(org.companyId, org.manager.id)))
        .patch(`/api/agents/${org.engineer.id}`)
        .send({ teamId: org.team.id });
      expect(res.status).toBe(200);
      expect(res.body.teamId).toBe(org.team.id);
    });

    it("lets only the board change the CEO's team", async () => {
      const org = await seedOrg();
      for (const agentId of [org.manager.id, org.ceo.id]) {
        const res = await request(createApp(db, agentActor(org.companyId, agentId)))
          .patch(`/api/agents/${org.ceo.id}`)
          .send({ teamId: org.team.id });
        expect(res.status).toBe(403);
      }
      // A team with no manager, so the CEO joining it does not create a reporting cycle.
      const leaderless = await teamService(db).create(org.companyId, { name: "Leaderless" });
      const byBoard = await request(createApp(db, board)).patch(`/api/agents/${org.ceo.id}`).send({ teamId: leaderless.id });
      expect(byBoard.status).toBe(200);
      expect(byBoard.body.teamId).toBe(leaderless.id);
    });

    it("rejects an unrelated team manager with 403", async () => {
      const org = await seedOrg();
      const app = createApp(db, agentActor(org.companyId, org.otherManager.id));
      const res = await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id });
      expect(res.status).toBe(403);
      const row = await db.select().from(agents).where(eq(agents.id, org.engineer.id)).then((rows) => rows[0]!);
      expect(row.teamId).toBeNull();
    });

    it("needs the manager of the old team too when moving between teams", async () => {
      const org = await seedOrg();

      await db.update(agents).set({ teamId: org.otherTeam.id }).where(eq(agents.id, org.engineer.id));
      const app = createApp(db, agentActor(org.companyId, org.manager.id));
      const res = await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id });
      expect(res.status).toBe(403);
    });

    it("resets reportsTo to the CEO and logs it when the team is cleared", async () => {
      const org = await seedOrg();
      const app = createApp(db, board);
      expect((await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id })).body.reportsTo)
        .toBe(org.manager.id);
      const left = await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: null });
      expect(left.status).toBe(200);
      expect(left.body).toMatchObject({ teamId: null, reportsTo: org.ceo.id });
      const logged = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, org.engineer.id), eq(activityLog.action, "agent.reports_to_reset")));
      expect(logged).toHaveLength(1);
      expect(logged[0]!.details).toMatchObject({ fromReportsTo: org.manager.id, toReportsTo: org.ceo.id });
    });

    it("leaves reportsTo unchanged when the company has no CEO", async () => {
      const companyId = await seedCompany();
      const manager = await seedAgent(companyId, "Manager", "engineer");
      const engineer = await seedAgent(companyId, "Engineer", "engineer");
      const team = await teamService(db).create(companyId, { name: "Solo", managerAgentId: manager.id });
      const app = createApp(db, board);
      await request(app).patch(`/api/agents/${engineer.id}`).send({ teamId: team.id });
      const left = await request(app).patch(`/api/agents/${engineer.id}`).send({ teamId: null });
      expect(left.status).toBe(200);
      expect(left.body).toMatchObject({ teamId: null, reportsTo: manager.id });
    });
  });

  describe("agent create with teamId", () => {
    const body = (teamId: string) => ({ name: `Hire ${randomUUID().slice(0, 6)}`, role: "engineer", adapterType: "process", adapterConfig: {}, teamId });
    async function allowCreate(agentId: string) {
      await db
        .update(agents)
        .set({ permissions: { canCreateAgents: true } })
        .where(eq(agents.id, agentId));
    }

    it("rejects an unrelated manager and allows the team manager", async () => {
      const org = await seedOrg();
      await allowCreate(org.otherManager.id);
      await allowCreate(org.manager.id);
      const denied = await request(createApp(db, agentActor(org.companyId, org.otherManager.id)))
        .post(`/api/companies/${org.companyId}/agents`)
        .send(body(org.team.id));
      expect(denied.status).toBe(403);
      const allowed = await request(createApp(db, agentActor(org.companyId, org.manager.id)))
        .post(`/api/companies/${org.companyId}/agents`)
        .send(body(org.team.id));
      expect(allowed.status).toBe(201);
      expect(allowed.body).toMatchObject({ teamId: org.team.id, reportsTo: org.manager.id });
    });
  });

  describe("team deletion and manager change", () => {
    it("resets members to the CEO on delete and logs each reset", async () => {
      const org = await seedOrg();
      const app = createApp(db, board);
      await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id });
      await request(app).patch(`/api/agents/${org.pm.id}`).send({ teamId: org.team.id });
      expect((await request(app).delete(`/api/companies/${org.companyId}/teams/${org.team.id}`)).status).toBe(204);
      const rows = await db.select().from(agents).where(eq(agents.companyId, org.companyId));
      for (const id of [org.engineer.id, org.pm.id]) {
        expect(rows.find((r) => r.id === id)).toMatchObject({ teamId: null, reportsTo: org.ceo.id });
      }
      const logged = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.action, "agent.reports_to_reset"), eq(activityLog.companyId, org.companyId)));
      expect(logged.map((l) => l.entityId).sort()).toEqual([org.engineer.id, org.pm.id].sort());
      expect(logged[0]!.details).toMatchObject({ reason: "team_deleted", fromReportsTo: org.manager.id, toReportsTo: org.ceo.id });
    });

    it("logs one reset per member whose reportsTo changes with a new manager", async () => {
      const org = await seedOrg();
      const app = createApp(db, board);
      await request(app).patch(`/api/agents/${org.engineer.id}`).send({ teamId: org.team.id });
      await request(app).patch(`/api/agents/${org.pm.id}`).send({ teamId: org.team.id });
      const res = await request(app)
        .patch(`/api/companies/${org.companyId}/teams/${org.team.id}`)
        .send({ managerAgentId: org.otherManager.id });
      expect(res.status).toBe(200);
      expect(res.body.reportsToChanges).toBeUndefined();
      const logged = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.action, "agent.reports_to_reset"),
            eq(activityLog.companyId, org.companyId),
          ),
        );
      const managerChanged = logged.filter((l) => (l.details as { reason?: string }).reason === "manager_changed");
      expect(managerChanged.map((l) => l.entityId).sort()).toEqual([org.engineer.id, org.pm.id].sort());
      expect(managerChanged[0]!.details).toMatchObject({ fromReportsTo: org.manager.id, toReportsTo: org.otherManager.id });
    });
  });

  describe("task matching trial permissions", () => {
    async function seedTrialOrg() {
      const org = await seedOrg();
      await teamService(db).linkProject(org.companyId, org.team.id, org.project.id);
      const mine1 = await seedAgent(org.companyId, "Mine One", "engineer", { teamId: org.team.id });
      const mine2 = await seedAgent(org.companyId, "Mine Two", "engineer", { teamId: org.team.id });
      const theirs = await seedAgent(org.companyId, "Theirs", "engineer", { teamId: org.otherTeam.id });
      const [issue] = await db
        .insert(issues)
        .values({
          companyId: org.companyId,
          projectId: org.project.id,
          title: "Trial target",
          status: "todo",
          priority: "medium",
          issueNumber: 1,
          identifier: `TR-${randomUUID().slice(0, 4)}`,
        })
        .returning();
      return { ...org, mine1, mine2, theirs, issue: issue! };
    }
    const trialUrl = (companyId: string, issueId: string) => `/api/companies/${companyId}/issues/${issueId}/match-trial`;

    it("rejects a manager of a team not linked to the project", async () => {
      const org = await seedTrialOrg();
      const res = await request(createApp(db, agentActor(org.companyId, org.otherManager.id)))
        .post(trialUrl(org.companyId, org.issue.id))
        .send({ agentIds: [org.mine1.id, org.mine2.id] });
      expect(res.status).toBe(403);
    });

    it("rejects a linked-team manager using an agent from another team", async () => {
      const org = await seedTrialOrg();
      const res = await request(createApp(db, agentActor(org.companyId, org.manager.id)))
        .post(trialUrl(org.companyId, org.issue.id))
        .send({ agentIds: [org.mine1.id, org.theirs.id] });
      expect(res.status).toBe(403);
    });

    it("allows a linked-team manager with own agents to create and decide", async () => {
      const org = await seedTrialOrg();
      const app = createApp(db, agentActor(org.companyId, org.manager.id));
      const created = await request(app).post(trialUrl(org.companyId, org.issue.id)).send({ agentIds: [org.mine1.id, org.mine2.id] });
      expect(created.status).toBe(201);
      const deniedDecide = await request(createApp(db, agentActor(org.companyId, org.otherManager.id)))
        .post(`${trialUrl(org.companyId, org.issue.id)}/${created.body.id}/decide`)
        .send({ winnerAgentId: org.mine1.id, reason: "x" });
      expect(deniedDecide.status).toBe(403);
      const decided = await request(app)
        .post(`${trialUrl(org.companyId, org.issue.id)}/${created.body.id}/decide`)
        .send({ winnerAgentId: org.mine1.id, reason: "cleaner" });
      expect(decided.status).toBe(200);
    });
  });

  describe("team project links", () => {
    it("allows the team manager to link and unlink", async () => {
      const org = await seedOrg();
      const app = createApp(db, agentActor(org.companyId, org.manager.id));
      const linked = await request(app)
        .post(`/api/companies/${org.companyId}/teams/${org.team.id}/projects`)
        .send({ projectId: org.project.id });
      expect(linked.status).toBe(201);
      expect(linked.body.projectIds).toEqual([org.project.id]);
      const unlinked = await request(app).delete(
        `/api/companies/${org.companyId}/teams/${org.team.id}/projects/${org.project.id}`,
      );
      expect(unlinked.status).toBe(204);
    });

    it("rejects another manager and an engineer with 403", async () => {
      const org = await seedOrg();
      await teamService(db).linkProject(org.companyId, org.team.id, org.project.id);
      for (const agentId of [org.otherManager.id, org.engineer.id]) {
        const app = createApp(db, agentActor(org.companyId, agentId));
        expect(
          (await request(app)
            .post(`/api/companies/${org.companyId}/teams/${org.team.id}/projects`)
            .send({ projectId: org.project.id })).status,
        ).toBe(403);
        expect(
          (await request(app).delete(`/api/companies/${org.companyId}/teams/${org.team.id}/projects/${org.project.id}`))
            .status,
        ).toBe(403);
      }
    });
  });

  describe("PM handoff", () => {
    it("allows the board and the CEO agent", async () => {
      const org = await seedOrg();
      const byCeo = await request(createApp(db, agentActor(org.companyId, org.ceo.id)))
        .post(`/api/companies/${org.companyId}/projects/${org.project.id}/pm-handoff`)
        .send({ toAgentId: org.engineer.id, reason: "rotation" });
      expect(byCeo.status).toBe(201);
      expect(byCeo.body).toMatchObject({ fromAgentId: org.pm.id, toAgentId: org.engineer.id });
      const byBoard = await request(createApp(db, board))
        .post(`/api/companies/${org.companyId}/projects/${org.project.id}/pm-handoff`)
        .send({ toAgentId: org.pm.id });
      expect(byBoard.status).toBe(201);
      const history = await request(createApp(db, agentActor(org.companyId, org.pm.id))).get(
        `/api/companies/${org.companyId}/projects/${org.project.id}/pm-handoffs`,
      );
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(2);
    });

    it("rejects the current PM agent with 403", async () => {
      const org = await seedOrg();
      const res = await request(createApp(db, agentActor(org.companyId, org.pm.id)))
        .post(`/api/companies/${org.companyId}/projects/${org.project.id}/pm-handoff`)
        .send({ toAgentId: org.engineer.id });
      expect(res.status).toBe(403);
      const row = await db.select().from(projects).where(eq(projects.id, org.project.id)).then((rows) => rows[0]!);
      expect(row.leadAgentId).toBe(org.pm.id);
    });
  });

  describe("team budget policy", () => {
    const policy = (teamId: string) => ({ scopeType: "team", scopeId: teamId, amount: 5000, windowKind: "calendar_month_utc" });

    it("allows the board and the CEO agent", async () => {
      const org = await seedOrg();
      for (const actor of [board, agentActor(org.companyId, org.ceo.id)]) {
        const res = await request(createApp(db, actor))
          .post(`/api/companies/${org.companyId}/budgets/policies`)
          .send(policy(org.team.id));
        expect(res.status).toBe(200);
      }
    });

    it("rejects an engineer and the team manager with 403", async () => {
      const org = await seedOrg();
      for (const agentId of [org.engineer.id, org.manager.id]) {
        const res = await request(createApp(db, agentActor(org.companyId, agentId)))
          .post(`/api/companies/${org.companyId}/budgets/policies`)
          .send(policy(org.team.id));
        expect(res.status).toBe(403);
      }
    });
  });
});
