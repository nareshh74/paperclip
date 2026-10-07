import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  companies,
  costEvents,
  issueLabels,
  issues,
  labels,
  matchingOutcomes,
  matchingTrialArms,
  matchingTrials,
  teamProjects,
} from "@paperclipai/db";
import type {
  MatchCandidate,
  MatchCandidatesResult,
  MatchFeature,
  MatchFeatureKey,
  MatchWeights,
  MatchingConfig,
  MatchingTrial,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";

/**
 * Advisory task matching. The company owns the assignment strategy: this
 * service only scores (agent, issue) pairs and runs parallel trials for ties.
 * It never assigns work by itself.
 *
 * Score = sum(weight_i * feature_i) / sum(weight_i), so it is in 0..1.
 * Features, each in 0..1:
 * - similarity:   best similarity between this issue and a task the agent completed
 *                 well (outcome >= 0.5). Similarity mixes same project, label Jaccard,
 *                 and title-token Jaccard (no embeddings).
 * - quality:      similarity-weighted mean outcome of the agent on similar tasks
 *                 (similarity >= SIMILAR_THRESHOLD), shrunk toward 0.5 by a prior
 *                 of weight 1, so an unknown agent scores 0.5.
 * - efficiency:   company median AIC per done similar task divided by
 *                 (median + agent mean). 0.5 = median, 1 = free, toward 0 = costly.
 *                 0.5 when there is no data.
 * - availability: 1 if the agent holds no in_progress task, else 0.
 * - teamProject:  1 if the agent's team is linked to the issue's project, else 0.
 * Tier or role fit is out of scope.
 */
export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  similarity: 0.3,
  quality: 0.3,
  efficiency: 0.15,
  availability: 0.15,
  teamProject: 0.1,
};
export const DEFAULT_TIE_EPSILON = 0.02;
const SIMILAR_THRESHOLD = 0.3;
const HISTORY_LIMIT = 2000;
const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "add", "fix", "trial"]);
const TRIAL_LETTERS = ["A", "B", "C"];

export interface TaskShape {
  projectId: string | null;
  labels: string[];
  titleTokens: string[];
}

export function normalizeLabels(names: string[]) {
  return [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))].sort();
}

export function titleTokens(title: string) {
  const cleaned = title.replace(/^\[Trial [A-Z]\]\s*/, "").toLowerCase();
  return [...new Set(cleaned.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t)))].sort();
}

export function taskKindKey(shape: Pick<TaskShape, "projectId" | "labels">) {
  return `${shape.projectId ?? "none"}|${shape.labels.join(",")}`;
}

function jaccard(a: string[], b: string[]) {
  if (a.length === 0 && b.length === 0) return null;
  const setB = new Set(b);
  const inter = a.filter((x) => setB.has(x)).length;
  return inter / (a.length + b.length - inter);
}

/** Mean of the available parts: same project, label Jaccard, title Jaccard. Parts with no data on both sides are skipped. */
export function taskSimilarity(a: TaskShape, b: TaskShape) {
  const parts: number[] = [];
  if (a.projectId || b.projectId) parts.push(a.projectId === b.projectId ? 1 : 0);
  const l = jaccard(a.labels, b.labels);
  if (l !== null) parts.push(l);
  const t = jaccard(a.titleTokens, b.titleTokens);
  if (t !== null) parts.push(t);
  return parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : 0;
}

function median(values: number[]) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function resolveMatchingConfig(config: MatchingConfig | null | undefined) {
  const weights = { ...DEFAULT_MATCH_WEIGHTS, ...(config?.weights ?? {}) } as MatchWeights;
  return { weights, tieEpsilon: config?.tieEpsilon ?? DEFAULT_TIE_EPSILON };
}

type HistoryRow = TaskShape & { agentId: string; outcome: number; aicSpent: number };

/** Pure scoring, exported for unit tests. */
export function scoreAgent(input: {
  issue: TaskShape;
  agentId: string;
  history: HistoryRow[];
  available: boolean;
  teamLinked: boolean;
  weights: MatchWeights;
}): { score: number; features: Record<MatchFeatureKey, MatchFeature> } {
  const withSim = input.history.map((h) => ({ ...h, sim: taskSimilarity(input.issue, h) }));
  const mine = withSim.filter((h) => h.agentId === input.agentId);
  const goodMine = mine.filter((h) => h.outcome >= 0.5);

  const best = goodMine.reduce((m, h) => Math.max(m, h.sim), 0);
  const similar = mine.filter((h) => h.sim >= SIMILAR_THRESHOLD);
  const wSum = similar.reduce((s, h) => s + h.sim, 0);
  const quality = (similar.reduce((s, h) => s + h.sim * h.outcome, 0) + 0.5) / (wSum + 1);

  const companyMedian = median(withSim.filter((h) => h.outcome >= 0.5 && h.sim >= SIMILAR_THRESHOLD).map((h) => h.aicSpent));
  const myDone = goodMine.filter((h) => h.sim >= SIMILAR_THRESHOLD).map((h) => h.aicSpent);
  const myMean = myDone.length ? myDone.reduce((s, v) => s + v, 0) / myDone.length : null;
  const efficiency =
    companyMedian === null || myMean === null || companyMedian + myMean === 0 ? 0.5 : companyMedian / (companyMedian + myMean);

  const values: Record<MatchFeatureKey, [number, string]> = {
    similarity: [best, goodMine.length ? `best match with a well-completed task: ${round(best)}` : "no well-completed tasks yet"],
    quality: [quality, `${similar.length} similar past outcome(s), prior 0.5`],
    efficiency: [
      efficiency,
      myMean === null ? "no AIC history on similar tasks" : `mean ${round(myMean)} AIC vs company median ${round(companyMedian ?? 0)}`,
    ],
    availability: [input.available ? 1 : 0, input.available ? "no task in progress" : "has a task in progress"],
    teamProject: [input.teamLinked ? 1 : 0, input.teamLinked ? "team linked to the project" : "team not linked to the project"],
  };
  const totalWeight = Object.values(input.weights).reduce((s, w) => s + w, 0) || 1;
  const features = {} as Record<MatchFeatureKey, MatchFeature>;
  let score = 0;
  for (const key of Object.keys(values) as MatchFeatureKey[]) {
    const [value, explanation] = values[key];
    const weight = input.weights[key] ?? 0;
    const contribution = (value * weight) / totalWeight;
    score += contribution;
    features[key] = { value: round(value), weight, contribution: round(contribution), explanation };
  }
  return { score: round(score), features };
}

/** Candidates within `epsilon` of the top score. Input must be sorted by score, descending. */
export function tieGroup(candidates: Array<{ agentId: string; score: number }>, epsilon: number) {
  const top = candidates[0]?.score;
  if (top === undefined) return [];
  return candidates.filter((c) => top - c.score <= epsilon + 1e-9).map((c) => c.agentId);
}

async function loadTaskShape(db: Db, companyId: string, issueId: string) {
  const issue = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  const names = await db
    .select({ name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.companyId, companyId)));
  const shape: TaskShape = {
    projectId: issue.projectId,
    labels: normalizeLabels(names.map((n) => n.name)),
    titleTokens: titleTokens(issue.title),
  };
  return { issue, shape };
}

async function aicForIssue(db: Db, companyId: string, issueId: string) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, companyId), eq(costEvents.issueId, issueId)));
  return Number(row?.total ?? 0);
}

function wallSeconds(issue: typeof issues.$inferSelect, end: Date) {
  const start = issue.startedAt ?? issue.createdAt;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

async function insertOutcome(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; trialId: string | null; shape: TaskShape; outcome: number; source: "completion" | "trial"; issue: typeof issues.$inferSelect },
) {
  await db.insert(matchingOutcomes).values({
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    trialId: input.trialId,
    taskKind: taskKindKey(input.shape),
    projectId: input.shape.projectId,
    labels: input.shape.labels,
    titleTokens: input.shape.titleTokens,
    outcome: input.outcome,
    aicSpent: await aicForIssue(db, input.companyId, input.issueId),
    wallSeconds: wallSeconds(input.issue, input.issue.completedAt ?? input.issue.cancelledAt ?? new Date()),
    source: input.source,
  });
}

/**
 * Issue status hook: a task assigned to an agent that becomes done (1) or
 * cancelled (0) feeds the matching history. Trial arms are skipped because the
 * trial decision records them. Conversations are not tasks.
 */
export async function recordIssueCompletionOutcome(
  db: Db,
  before: { status: string },
  after: typeof issues.$inferSelect,
) {
  if (before.status === after.status) return;
  if (after.status !== "done" && after.status !== "cancelled") return;
  if (!after.assigneeAgentId || after.conversationAgentId) return;
  const arm = await db
    .select({ id: matchingTrialArms.id })
    .from(matchingTrialArms)
    .where(eq(matchingTrialArms.childIssueId, after.id))
    .limit(1);
  if (arm.length) return;
  const { shape } = await loadTaskShape(db, after.companyId, after.id);
  await insertOutcome(db, {
    companyId: after.companyId,
    agentId: after.assigneeAgentId,
    issueId: after.id,
    trialId: null,
    shape,
    outcome: after.status === "done" ? 1 : 0,
    source: "completion",
    issue: after,
  });
}

async function loadTrial(db: Db, companyId: string, issueId: string, trialId: string): Promise<MatchingTrial> {
  const trial = await db
    .select()
    .from(matchingTrials)
    .where(and(eq(matchingTrials.id, trialId), eq(matchingTrials.companyId, companyId), eq(matchingTrials.issueId, issueId)))
    .then((rows) => rows[0] ?? null);
  if (!trial) throw notFound("Matching trial not found");
  const arms = await db
    .select({ agentId: matchingTrialArms.agentId, childIssueId: matchingTrialArms.childIssueId })
    .from(matchingTrialArms)
    .where(eq(matchingTrialArms.trialId, trial.id));
  const { createdByActorType: _t, createdByActorId: _a, ...rest } = trial;
  return { ...rest, arms };
}

export function taskMatchingService(db: Db) {
  return {
    candidates: async (companyId: string, issueId: string, limit = 10): Promise<MatchCandidatesResult> => {
      const { issue, shape } = await loadTaskShape(db, companyId, issueId);
      const company = await db
        .select({ matchingConfig: companies.matchingConfig })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      const { weights, tieEpsilon } = resolveMatchingConfig(company.matchingConfig);

      const [pool, history, busy, linkedTeams] = await Promise.all([
        db
          .select({ id: agents.id, name: agents.name, teamId: agents.teamId })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), notInArray(agents.status, ["terminated", "pending_approval", "paused"]))),
        db
          .select()
          .from(matchingOutcomes)
          .where(eq(matchingOutcomes.companyId, companyId))
          .orderBy(desc(matchingOutcomes.createdAt))
          .limit(HISTORY_LIMIT),
        db
          .select({ agentId: issues.assigneeAgentId })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "in_progress"),
              isNull(issues.hiddenAt),
              isNull(issues.conversationAgentId),
              ne(issues.id, issueId),
            ),
          ),
        issue.projectId
          ? db
              .select({ teamId: teamProjects.teamId })
              .from(teamProjects)
              .where(and(eq(teamProjects.companyId, companyId), eq(teamProjects.projectId, issue.projectId)))
          : Promise.resolve([] as Array<{ teamId: string }>),
      ]);
      const busySet = new Set(busy.map((b) => b.agentId));
      const linked = new Set(linkedTeams.map((t) => t.teamId));
      const rows: HistoryRow[] = history.map((h) => ({
        agentId: h.agentId,
        projectId: h.projectId,
        labels: h.labels,
        titleTokens: h.titleTokens,
        outcome: h.outcome,
        aicSpent: h.aicSpent,
      }));

      const scored = pool
        .map((agent) => {
          const { score, features } = scoreAgent({
            issue: shape,
            agentId: agent.id,
            history: rows,
            available: !busySet.has(agent.id),
            teamLinked: Boolean(agent.teamId && linked.has(agent.teamId)),
            weights,
          });
          const top = (Object.keys(features) as MatchFeatureKey[])
            .sort((a, b) => features[b].contribution - features[a].contribution)
            .slice(0, 2)
            .map((k) => `${k} ${features[k].value} (${features[k].explanation})`);
          return { agentId: agent.id, agentName: agent.name, score, features, explanation: `Strongest: ${top.join("; ")}` };
        })
        .sort((a, b) => b.score - a.score || a.agentName.localeCompare(b.agentName));
      const ties = tieGroup(scored, tieEpsilon);
      const tieSet = new Set(ties);
      const candidates: MatchCandidate[] = scored.slice(0, limit).map((c) => ({ ...c, tiedWithTop: tieSet.has(c.agentId) }));
      return { issueId, taskKind: taskKindKey(shape), tieEpsilon, weights, candidates, tieGroup: ties };
    },

    createTrial: async (
      companyId: string,
      issueId: string,
      agentIds: string[],
      actor: { actorType: string; actorId: string; agentId?: string | null },
    ): Promise<MatchingTrial> => {
      const { issue } = await loadTaskShape(db, companyId, issueId);
      if (issue.status === "done" || issue.status === "cancelled") throw unprocessable("Cannot run a trial on a closed issue");
      if (issue.conversationAgentId) throw unprocessable("Conversations cannot run trials");
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      if (found.length !== agentIds.length) throw unprocessable("Every trial agent must belong to the company");
      const open = await db
        .select({ id: matchingTrials.id })
        .from(matchingTrials)
        .where(and(eq(matchingTrials.companyId, companyId), eq(matchingTrials.issueId, issueId), eq(matchingTrials.status, "open")))
        .limit(1);
      if (open.length) throw conflict("Issue already has an open matching trial", { trialId: open[0]!.id });

      const trialId = await db.transaction(async (tx) => {
        const issuesSvc = issueService(db);
        const [trial] = await tx
          .insert(matchingTrials)
          .values({ companyId, issueId, createdByActorType: actor.actorType, createdByActorId: actor.actorId })
          .returning();
        for (const [i, agentId] of agentIds.entries()) {
          const child = await issuesSvc.create(
            companyId,
            {
              parentId: issue.id,
              projectId: issue.projectId,
              goalId: issue.goalId,
              priority: issue.priority,
              status: "todo",
              assigneeAgentId: agentId,
              title: `[Trial ${TRIAL_LETTERS[i]}] ${issue.title}`,
              description: `${issue.description ?? ""}\n\n---\nThis is a parallel trial: ${agentIds.length} agents work on the same task independently. The company picks one winner; the other trial tasks are cancelled.`.trim(),
              allowDuplicate: true,
            },
            tx as never,
          );
          await tx.insert(matchingTrialArms).values({ trialId: trial!.id, agentId, childIssueId: child.id });
        }
        return trial!.id;
      });
      return loadTrial(db, companyId, issueId, trialId);
    },

    getTrial: (companyId: string, issueId: string, trialId: string) => loadTrial(db, companyId, issueId, trialId),

    decideTrial: async (
      companyId: string,
      issueId: string,
      trialId: string,
      input: { winnerAgentId: string; reason: string },
      actor: { actorType: string; actorId: string; agentId?: string | null },
    ): Promise<{ trial: MatchingTrial; cancelledChildIssueIds: string[] }> => {
      const trial = await loadTrial(db, companyId, issueId, trialId);
      if (trial.status !== "open") throw conflict("Matching trial is already decided");
      if (!trial.arms.some((a) => a.agentId === input.winnerAgentId)) throw unprocessable("Winner must be one of the trial agents");
      const { shape } = await loadTaskShape(db, companyId, issueId);
      const issuesSvc = issueService(db);
      const cancelled: string[] = [];

      // Claim the decision first so two concurrent decisions cannot both win.
      const now = new Date();
      const claimed = await db
        .update(matchingTrials)
        .set({
          status: "decided",
          decidedAt: now,
          winnerAgentId: input.winnerAgentId,
          decisionReason: input.reason,
          decidedByActorType: actor.actorType,
          decidedByActorId: actor.actorId,
        })
        .where(and(eq(matchingTrials.id, trialId), eq(matchingTrials.status, "open")))
        .returning({ id: matchingTrials.id });
      if (!claimed.length) throw conflict("Matching trial is already decided");

      for (const arm of trial.arms) {
        const won = arm.agentId === input.winnerAgentId;
        let child = await db
          .select()
          .from(issues)
          .where(and(eq(issues.id, arm.childIssueId), eq(issues.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!child) continue;
        if (!won && child.status !== "done" && child.status !== "cancelled") {
          const updated = await issuesSvc.update(child.id, { status: "cancelled", companyGuard: companyId });
          if (updated) child = updated as typeof child;
          cancelled.push(child.id);
        }
        await insertOutcome(db, {
          companyId,
          agentId: arm.agentId,
          issueId: child.id,
          trialId,
          shape,
          outcome: won ? 1 : 0,
          source: "trial",
          issue: child,
        });
      }
      return { trial: await loadTrial(db, companyId, issueId, trialId), cancelledChildIssueIds: cancelled };
    },
  };
}
