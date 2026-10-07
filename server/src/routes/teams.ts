import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  createTeamSchema,
  linkTeamProjectSchema,
  projectPmHandoffSchema,
  updateTeamSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity, teamService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/** Role of the calling agent, or null for non-agent actors. */
async function actorAgent(db: Db, req: Request, companyId: string) {
  if (req.actor.type !== "agent" || !req.actor.agentId) return null;
  return db
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, req.actor.agentId)))
    .then((rows) => rows[0] ?? null);
}

/** Board or the company's CEO agent. Used for team structure, budgets, and PM handoff. */
export async function assertBoardOrCeo(db: Db, req: Request, companyId: string) {
  if (req.actor.type === "board") return;
  const agent = await actorAgent(db, req, companyId);
  if (agent?.role === "ceo") return;
  throw forbidden("Board or CEO access required");
}

/** Board, the CEO agent, or the given team's manager. Used for membership and project links. */
export async function assertBoardCeoOrTeamManager(
  db: Db,
  req: Request,
  companyId: string,
  teamManagerIds: Array<string | null | undefined>,
) {
  if (req.actor.type === "board") return;
  const agent = await actorAgent(db, req, companyId);
  if (agent && (agent.role === "ceo" || teamManagerIds.includes(agent.id))) return;
  throw forbidden("Board, CEO, or team manager access required");
}

export function teamRoutes(db: Db) {
  const router = Router();
  const svc = teamService(db);

  async function log(
    req: Request,
    companyId: string,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType,
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/teams", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.get("/companies/:companyId/teams/:teamId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const team = await svc.getWithProjects(companyId, req.params.teamId as string);
    res.json({ ...team, memberAgentIds: await svc.listMemberIds(companyId, team.id) });
  });

  // Teams set model and spend limits, so only the board or the CEO may change them.
  router.post("/companies/:companyId/teams", validate(createTeamSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertBoardOrCeo(db, req, companyId);
    const team = await svc.create(companyId, req.body);
    await log(req, companyId, "team.created", "team", team.id, {
      name: team.name,
      managerAgentId: team.managerAgentId,
      runLimits: team.runLimits,
    });
    res.status(201).json(team);
  });

  router.patch("/companies/:companyId/teams/:teamId", validate(updateTeamSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertBoardOrCeo(db, req, companyId);
    const team = await svc.update(companyId, req.params.teamId as string, req.body);
    await log(req, companyId, "team.updated", "team", team.id, { changes: req.body });
    res.json(team);
  });

  router.delete("/companies/:companyId/teams/:teamId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertBoardOrCeo(db, req, companyId);
    const team = await svc.remove(companyId, req.params.teamId as string);
    await log(req, companyId, "team.deleted", "team", team.id, { name: team.name });
    res.status(204).end();
  });

  // Links record which teams work on a project. They do not gate issue assignment.
  router.post("/companies/:companyId/teams/:teamId/projects", validate(linkTeamProjectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const team = await svc.getById(companyId, req.params.teamId as string);
    await assertBoardCeoOrTeamManager(db, req, companyId, [team.managerAgentId]);
    const { created } = await svc.linkProject(companyId, team.id, req.body.projectId);
    if (created) {
      await log(req, companyId, "team.project_linked", "team", team.id, { projectId: req.body.projectId });
    }
    res.status(created ? 201 : 200).json(await svc.getWithProjects(companyId, team.id));
  });

  router.delete("/companies/:companyId/teams/:teamId/projects/:projectId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const team = await svc.getById(companyId, req.params.teamId as string);
    await assertBoardCeoOrTeamManager(db, req, companyId, [team.managerAgentId]);
    const projectId = req.params.projectId as string;
    await svc.unlinkProject(companyId, team.id, projectId);
    await log(req, companyId, "team.project_unlinked", "team", team.id, { projectId });
    res.status(204).end();
  });

  router.post(
    "/companies/:companyId/projects/:projectId/pm-handoff",
    validate(projectPmHandoffSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertBoardOrCeo(db, req, companyId);
      const actor = getActorInfo(req);
      const handoff = await svc.handOffProjectManager(companyId, req.params.projectId as string, {
        toAgentId: req.body.toAgentId,
        reason: req.body.reason,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      await log(req, companyId, "project.pm_handed_off", "project", handoff.projectId, {
        fromAgentId: handoff.fromAgentId,
        toAgentId: handoff.toAgentId,
        reason: handoff.reason,
        handoffId: handoff.id,
      });
      res.status(201).json(handoff);
    },
  );

  router.get("/companies/:companyId/projects/:projectId/pm-handoffs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listProjectManagerHandoffs(companyId, req.params.projectId as string));
  });

  return router;
}
