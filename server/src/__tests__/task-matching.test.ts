import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  companies,
  costEvents,
  createDb,
  issueLabels,
  issues,
  labels,
  matchingOutcomes,
  matchingTrialArms,
  matchingTrials,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { issueService } from "../services/issues.js";
import { teamService } from "../services/teams.js";
import {
  DEFAULT_MATCH_WEIGHTS,
  scoreAgent,
  taskKindKey,
  taskMatchingService,
  taskSimilarity,
  tieGroup,
  titleTokens,
} from "../services/task-matching.js";

describe("task matching scoring (pure)", () => {
  const issue = { projectId: "p1", labels: ["backend"], titleTokens: titleTokens("Add login rate limiter") };

  it("builds task kind keys and similarity from project, labels, and title tokens", () => {
    expect(taskKindKey(issue)).toBe("p1|backend");
    expect(titleTokens("[Trial B] Fix the Login rate-limiter")).toEqual(["limiter", "login", "rate"]);
    expect(taskSimilarity(issue, issue)).toBe(1);
    expect(taskSimilarity(issue, { projectId: "p2", labels: ["ui"], titleTokens: ["dashboard"] })).toBe(0);
  });

  it("orders agents by history, availability, and team link", () => {
    const history = [
      { agentId: "a", ...issue, outcome: 1, aicSpent: 100 },
      { agentId: "b", ...issue, outcome: 0, aicSpent: 400 },
    ];
    const base = { issue, history, weights: DEFAULT_MATCH_WEIGHTS };
    const a = scoreAgent({ ...base, agentId: "a", available: true, teamLinked: true });
    const b = scoreAgent({ ...base, agentId: "b", available: true, teamLinked: true });
    const c = scoreAgent({ ...base, agentId: "c", available: true, teamLinked: true });
    const busyA = scoreAgent({ ...base, agentId: "a", available: false, teamLinked: true });
    expect(a.score).toBeGreaterThan(c.score);
    expect(c.score).toBeGreaterThan(b.score);
    expect(busyA.score).toBeLessThan(a.score);
    expect(a.features.similarity.value).toBe(1);
    expect(c.features.quality.value).toBe(0.5);
    expect(Object.keys(a.features).sort()).toEqual(["availability", "efficiency", "quality", "similarity", "teamProject"]);
    const sum = Object.values(a.features).reduce((s, f) => s + f.contribution, 0);
    expect(Math.abs(sum - a.score)).toBeLessThan(0.01);
  });

  it("groups candidates within epsilon of the top score", () => {
    const ranked = [
      { agentId: "a", score: 0.8 },
      { agentId: "b", score: 0.785 },
      { agentId: "c", score: 0.7 },
    ];
    expect(tieGroup(ranked, 0.02)).toEqual(["a", "b"]);
    expect(tieGroup(ranked, 0)).toEqual(["a"]);
    expect(tieGroup([], 0.02)).toEqual([]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("task matching (db)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-matching-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE "matching_outcomes", "matching_trial_arms", "matching_trials", "activity_log", "cost_events",
        "issue_labels", "labels", "issues", "team_projects", "projects", "agents", "teams", "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const [project] = await db.insert(projects).values({ companyId, name: "Apollo" }).returning();
    const [label] = await db.insert(labels).values({ companyId, name: "Backend", color: "#000000" }).returning();
    const agentsSvc = agentService(db);
    const alice = await agentsSvc.create(companyId, { name: "Alice", adapterType: "process" });
    const bob = await agentsSvc.create(companyId, { name: "Bob", adapterType: "process" });
    const issuesSvc = issueService(db);
    async function newIssue(title: string) {
      const issue = await issuesSvc.create(companyId, { title, projectId: project!.id, status: "todo", priority: "medium", allowDuplicate: true });
      await db.insert(issueLabels).values({ issueId: issue.id, labelId: label!.id, companyId });
      return issue;
    }
    return { companyId, project: project!, alice, bob, issuesSvc, newIssue };
  }

  it("records completion outcomes and ranks by them", async () => {
    const { companyId, alice, bob, issuesSvc, newIssue } = await seed();
    const done = await newIssue("Build login rate limiter");
    await issuesSvc.update(done.id, { assigneeAgentId: alice.id });
    await db.insert(costEvents).values({ companyId, agentId: alice.id, issueId: done.id, provider: "p", model: "m", costCents: 120, occurredAt: new Date() });
    await issuesSvc.update(done.id, { status: "done" });
    const cancelled = await newIssue("Build login rate limiter v2");
    await issuesSvc.update(cancelled.id, { assigneeAgentId: bob.id });
    await issuesSvc.update(cancelled.id, { status: "cancelled" });

    const outcomes = await db.select().from(matchingOutcomes).where(eq(matchingOutcomes.companyId, companyId));
    expect(outcomes.map((o) => [o.agentId, o.outcome, o.source, o.aicSpent]).sort()).toEqual(
      [[alice.id, 1, "completion", 120], [bob.id, 0, "completion", 0]].sort(),
    );

    const next = await newIssue("Login rate limiter for API");
    const result = await taskMatchingService(db).candidates(companyId, next.id, 5);
    expect(result.candidates.map((c) => c.agentId)).toEqual([alice.id, bob.id]);
    expect(result.tieGroup).toEqual([alice.id]);
    expect(result.candidates[0]!.features.similarity.value).toBeGreaterThan(0.5);
    expect(result.candidates[0]!.explanation).toMatch(/Strongest/);

    await expect(taskMatchingService(db).candidates(randomUUID(), next.id)).rejects.toMatchObject({ status: 404 });
  });

  it("runs a parallel trial for tied agents and the winner ranks higher on a similar task", async () => {
    const { companyId, alice, bob, issuesSvc, newIssue } = await seed();
    const svc = taskMatchingService(db);
    const original = await newIssue("Migrate billing webhook handler");

    const before = await svc.candidates(companyId, original.id);
    expect(before.tieGroup.sort()).toEqual([alice.id, bob.id].sort());
    const aliceBefore = before.candidates.find((c) => c.agentId === alice.id)!.score;

    const actor = { actorType: "user", actorId: "board" };
    const trial = await svc.createTrial(companyId, original.id, [alice.id, bob.id], actor);
    expect(trial.status).toBe("open");
    expect(trial.arms).toHaveLength(2);
    const children = await db.select().from(issues).where(eq(issues.parentId, original.id));
    expect(children.map((c) => c.title).sort()).toEqual([
      "[Trial A] Migrate billing webhook handler",
      "[Trial B] Migrate billing webhook handler",
    ]);
    expect(children.every((c) => c.projectId === original.projectId && c.description?.includes("parallel trial"))).toBe(true);
    await expect(svc.createTrial(companyId, original.id, [alice.id, bob.id], actor)).rejects.toMatchObject({ status: 409 });

    const aliceChild = trial.arms.find((a) => a.agentId === alice.id)!.childIssueId;
    const bobChild = trial.arms.find((a) => a.agentId === bob.id)!.childIssueId;
    await db.insert(costEvents).values({ companyId, agentId: alice.id, issueId: aliceChild, provider: "p", model: "m", costCents: 50, occurredAt: new Date() });
    await issuesSvc.update(aliceChild, { status: "done" });

    await expect(
      svc.decideTrial(companyId, original.id, trial.id, { winnerAgentId: randomUUID(), reason: "x" }, actor),
    ).rejects.toMatchObject({ status: 422 });
    const decided = await svc.decideTrial(companyId, original.id, trial.id, { winnerAgentId: alice.id, reason: "cleaner diff" }, actor);
    expect(decided.trial).toMatchObject({ status: "decided", winnerAgentId: alice.id, decisionReason: "cleaner diff" });
    expect(decided.cancelledChildIssueIds).toEqual([bobChild]);
    const [bobChildRow] = await db.select().from(issues).where(eq(issues.id, bobChild));
    expect(bobChildRow?.status).toBe("cancelled");
    await expect(
      svc.decideTrial(companyId, original.id, trial.id, { winnerAgentId: bob.id, reason: "again" }, actor),
    ).rejects.toMatchObject({ status: 409 });

    // Trial arms record trial outcomes only, not completion outcomes.
    const outcomes = await db.select().from(matchingOutcomes).where(eq(matchingOutcomes.trialId, trial.id));
    expect(outcomes.map((o) => [o.agentId, o.outcome, o.aicSpent]).sort()).toEqual([[alice.id, 1, 50], [bob.id, 0, 0]].sort());
    expect(await db.select().from(matchingOutcomes).where(eq(matchingOutcomes.source, "completion"))).toHaveLength(0);
    expect(await db.select().from(matchingTrialArms)).toHaveLength(2);
    expect((await db.select().from(matchingTrials))[0]?.decidedAt).toBeTruthy();

    const followUp = await newIssue("Migrate billing webhook retries");
    const after = await svc.candidates(companyId, followUp.id);
    expect(after.candidates[0]!.agentId).toBe(alice.id);
    expect(after.candidates[0]!.score).toBeGreaterThan(aliceBefore);
    expect(after.tieGroup).toEqual([alice.id]);
  });
});

describeEmbeddedPostgres("one task in progress and team spend attribution (db)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-one-task-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE "activity_log", "cost_events", "budget_policies", "budget_incidents", "issues", "agents", "teams", "companies"
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
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  it("lets exactly one of two concurrent checkouts by the same agent win", async () => {
    const companyId = await seedCompany();
    const agent = await agentService(db).create(companyId, { name: "Builder", adapterType: "process" });
    const svc = issueService(db);
    const [a, b] = [
      await svc.create(companyId, { title: "Task A", status: "todo", priority: "medium", assigneeAgentId: agent.id }),
      await svc.create(companyId, { title: "Task B", status: "todo", priority: "medium", assigneeAgentId: agent.id }),
    ];
    const results = await Promise.allSettled([
      svc.checkout(a.id, agent.id, ["todo"], null),
      svc.checkout(b.id, agent.id, ["todo"], null),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, details: { code: "agent_has_task_in_progress" } });
    const inProgress = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.assigneeAgentId, agent.id), eq(issues.status, "in_progress")));
    expect(inProgress).toHaveLength(1);
    const rejections = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.task_pickup_rejected")));
    expect(rejections).toHaveLength(1);
  });

  it("maps a direct in_progress write that hits the index to the pickup 409", async () => {
    const companyId = await seedCompany();
    const agent = await agentService(db).create(companyId, { name: "Builder", adapterType: "process" });
    const svc = issueService(db);
    await svc.create(companyId, { title: "Held", status: "in_progress", priority: "medium", assigneeAgentId: agent.id });
    await expect(
      svc.create(companyId, { title: "Second", status: "in_progress", priority: "medium", assigneeAgentId: agent.id }),
    ).rejects.toMatchObject({ status: 409, details: { code: "agent_has_task_in_progress" } });
  });

  it("keeps spend with the team the agent was in at the time of spend", async () => {
    const companyId = await seedCompany();
    const teams = teamService(db);
    const red = await teams.create(companyId, { name: "Red" });
    const blue = await teams.create(companyId, { name: "Blue" });
    const agentsSvc = agentService(db);
    const agent = await agentsSvc.create(companyId, { name: "Mover", adapterType: "process", teamId: red.id });
    const { costService } = await import("../services/costs.js");
    const costs = costService(db);
    await costs.createEvent(companyId, { agentId: agent.id, provider: "p", model: "m", costCents: 300, occurredAt: new Date() });
    await agentsSvc.update(agent.id, { teamId: blue.id });
    await costs.createEvent(companyId, { agentId: agent.id, provider: "p", model: "m", costCents: 40, occurredAt: new Date() });

    const rows = await db.select({ teamId: costEvents.teamId, cents: costEvents.costCents }).from(costEvents);
    expect(rows.map((r) => [r.teamId, r.cents]).sort()).toEqual([[red.id, 300], [blue.id, 40]].sort());

    const { budgetService } = await import("../services/budgets.js");
    const budgets = budgetService(db);
    const redSummary = await budgets.upsertPolicy(companyId, { scopeType: "team", scopeId: red.id, amount: 1000 }, "board");
    const blueSummary = await budgets.upsertPolicy(companyId, { scopeType: "team", scopeId: blue.id, amount: 1000 }, "board");
    expect(redSummary.observedAmount).toBe(300);
    expect(blueSummary.observedAmount).toBe(40);
  });
});
