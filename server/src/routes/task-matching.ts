import { Router, type Request } from "express";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teams } from "@paperclipai/db";
import {
  createMatchingTrialSchema,
  decideMatchingTrialSchema,
  matchCandidatesQuerySchema,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { taskMatchingService } from "../services/task-matching.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertBoardCeoOrTeamManager } from "./teams.js";

/** Trials spend company capacity: board, the CEO agent, or any team manager. */
async function assertCanRunTrials(db: Db, req: Request, companyId: string) {
  const managers = await db
    .select({ id: teams.managerAgentId })
    .from(teams)
    .where(and(eq(teams.companyId, companyId), isNotNull(teams.managerAgentId)));
  await assertBoardCeoOrTeamManager(db, req, companyId, managers.map((m) => m.id));
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
    await assertCanRunTrials(db, req, companyId);
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
      await assertCanRunTrials(db, req, companyId);
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
