import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createTeamSchema, updateTeamSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, teamService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function teamRoutes(db: Db) {
  const router = Router();
  const svc = teamService(db);

  async function log(
    req: Parameters<typeof getActorInfo>[0],
    companyId: string,
    action: string,
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
      entityType: "team",
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
    const team = await svc.getById(companyId, req.params.teamId as string);
    res.json({ ...team, memberAgentIds: await svc.listMemberIds(companyId, team.id) });
  });

  // Teams set model and spend limits, so only the board may change them.
  router.post("/companies/:companyId/teams", validate(createTeamSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const team = await svc.create(companyId, req.body);
    await log(req, companyId, "team.created", team.id, {
      name: team.name,
      runLimits: team.runLimits,
    });
    res.status(201).json(team);
  });

  router.patch("/companies/:companyId/teams/:teamId", validate(updateTeamSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const team = await svc.update(companyId, req.params.teamId as string, req.body);
    await log(req, companyId, "team.updated", team.id, { changes: req.body });
    res.json(team);
  });

  router.delete("/companies/:companyId/teams/:teamId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const team = await svc.remove(companyId, req.params.teamId as string);
    await log(req, companyId, "team.deleted", team.id, { name: team.name });
    res.status(204).end();
  });

  return router;
}
