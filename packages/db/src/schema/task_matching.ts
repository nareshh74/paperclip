import { doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/** A parallel trial: the same task given to 2-3 tied agents as child issues. */
export const matchingTrials = pgTable(
  "matching_trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    status: text("status").$type<"open" | "decided">().notNull().default("open"),
    winnerAgentId: uuid("winner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    decisionReason: text("decision_reason"),
    decidedByActorType: text("decided_by_actor_type"),
    decidedByActorId: text("decided_by_actor_id"),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => ({
    companyIssueIdx: index("matching_trials_company_issue_idx").on(table.companyId, table.issueId),
  }),
);

export const matchingTrialArms = pgTable(
  "matching_trial_arms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trialId: uuid("trial_id").notNull().references(() => matchingTrials.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    childIssueId: uuid("child_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  },
  (table) => ({
    trialAgentUq: uniqueIndex("matching_trial_arms_trial_agent_uq").on(table.trialId, table.agentId),
    childIssueUq: uniqueIndex("matching_trial_arms_child_issue_uq").on(table.childIssueId),
  }),
);

/**
 * Learning history for task matching: one row per finished task (or trial arm).
 * The task kind columns are a snapshot so later edits to the issue do not rewrite history.
 */
export const matchingOutcomes = pgTable(
  "matching_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    trialId: uuid("trial_id").references(() => matchingTrials.id, { onDelete: "set null" }),
    /** `<projectId|none>|<sorted normalized labels>` */
    taskKind: text("task_kind").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    titleTokens: jsonb("title_tokens").$type<string[]>().notNull().default([]),
    /** 1 = done or trial winner, 0 = cancelled or trial loser. */
    outcome: doublePrecision("outcome").notNull(),
    /** AIC spent on the issue (1 AIC = 1 cost cent). */
    aicSpent: integer("aic_spent").notNull().default(0),
    wallSeconds: integer("wall_seconds"),
    source: text("source").$type<"completion" | "trial">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("matching_outcomes_company_agent_idx").on(table.companyId, table.agentId),
    companyKindIdx: index("matching_outcomes_company_kind_idx").on(table.companyId, table.taskKind),
  }),
);
