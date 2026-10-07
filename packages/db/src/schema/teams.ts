import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { RunLimits } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    managerAgentId: uuid("manager_agent_id").references((): AnyPgColumn => agents.id, { onDelete: "set null" }),
    runLimits: jsonb("run_limits").$type<RunLimits>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("teams_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("teams_company_name_uq").on(table.companyId, table.name),
  }),
);

/** Many-to-many link: a team works on a project. Not used to gate assignment. */
export const teamProjects = pgTable(
  "team_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamProjectUq: uniqueIndex("team_projects_team_project_uq").on(table.teamId, table.projectId),
    companyProjectIdx: index("team_projects_company_project_idx").on(table.companyId, table.projectId),
  }),
);

/** History of project manager changes. projects.lead_agent_id holds the current PM. */
export const projectPmHandoffs = pgTable(
  "project_pm_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    fromAgentId: uuid("from_agent_id").references(() => agents.id, { onDelete: "set null" }),
    toAgentId: uuid("to_agent_id").references(() => agents.id, { onDelete: "set null" }),
    reason: text("reason"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectCreatedIdx: index("project_pm_handoffs_project_created_idx").on(table.projectId, table.createdAt),
  }),
);
