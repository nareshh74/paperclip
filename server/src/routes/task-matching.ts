import { Router, type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, teamProjects, teams } from "@paperclipai/db";
import {
  createMatchingTrialSchema,
  decideMatchingTrialSchema,
  matchCandidatesQuerySchema,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { taskMatchingService } from "../services/task-matching.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Trials spend company capacity. The board and the CEO agent may run trials on
 * any issue. A team manager may run them only on issues whose project is linked
 * to a team they manage, and only with agents from those teams.
 */
async function assertCanRunTrials(db: Db, req: Request, companyId: string, issueId: string, armAgentIds?: string[]) {
  if (req.actor.type === "board") return;
  const actorId = req.actor.type === "agent" ? req.actor.agentId : null;
  const actor = actorId
    ? await db
        .select({ role: agents.role })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, actorId)))
        .then((rows) => rows[0] ?? null)
    : null;
  if (!actorId || !actor) throw forbidden("Board, CEO, or linked team manager access required");
  if (actor.role === "ceo") return;
  const issue = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  const managed = issue.projectId
    ? await db
        .select({ teamId: teams.id })
        .from(teams)
        .innerJoin(teamProjects, eq(teamProjects.teamId, teams.id))
        .where(
          and(
            eq(teams.companyId, companyId),
            eq(teams.managerAgentId, actorId),
            eq(teamProjects.projectId, issue.projectId),
          ),
        )
    : [];
  if (managed.length === 0) throw forbidden("Board, CEO, or linked team manager access required");
  if (!armAgentIds?.length) return;
  const teamIds = managed.map((m) => m.teamId);
  const arms = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, armAgentIds), inArray(agents.teamId, teamIds)));
  if (arms.length !== new Set(armAgentIds).size) {
    throw forbidden("A team manager may only run trials with agents from their own team");
  }
}

export function taskMatchingRoutes(db: Db) {
  const router = Router();
  const svc = taskMatchingService(db);

  async function log(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "issue",
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/issues/:issueId/match-candidates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = matchCandidatesQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid limit", query.error.issues);
    res.json(await svc.candidates(companyId, req.params.issueId as string, query.data.limit));
  });

  router.post("/companies/:companyId/issues/:issueId/match-trial", validate(createMatchingTrialSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    await assertCanRunTrials(db, req, companyId, issueId, req.body.agentIds);
    const actor = getActorInfo(req);
    const trial = await svc.createTrial(companyId, issueId, req.body.agentIds, actor);
    await log(req, companyId, "issue.match_trial_created", issueId, { trialId: trial.id, arms: trial.arms });
    res.status(201).json(trial);
  });

  router.get("/companies/:companyId/issues/:issueId/match-trial/:trialId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getTrial(companyId, req.params.issueId as string, req.params.trialId as string));
  });

  router.post(
    "/companies/:companyId/issues/:issueId/match-trial/:trialId/decide",
    validate(decideMatchingTrialSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const issueId = req.params.issueId as string;
      assertCompanyAccess(req, companyId);
      await assertCanRunTrials(db, req, companyId, issueId);
      const actor = getActorInfo(req);
      const result = await svc.decideTrial(companyId, issueId, req.params.trialId as string, req.body, actor);
      await log(req, companyId, "issue.match_trial_decided", issueId, {
        trialId: result.trial.id,
        winnerAgentId: req.body.winnerAgentId,
        reason: req.body.reason,
        cancelledChildIssueIds: result.cancelledChildIssueIds,
      });
      res.json(result);
    },
  );

  return router;
}
