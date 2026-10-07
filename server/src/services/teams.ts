import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, projectPmHandoffs, projects, teamProjects, teams } from "@paperclipai/db";
import type { CreateTeam, UpdateTeam } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

// Drizzle wraps the driver error, so check the cause as well.
function isUniqueViolation(error: unknown) {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

export function teamService(db: Db) {
  async function getById(companyId: string, teamId: string) {
    const row = await db
      .select()
      .from(teams)
      .where(and(eq(teams.companyId, companyId), eq(teams.id, teamId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Team not found");
    return row;
  }

  async function assertAgentInCompany(companyId: string, agentId: string, label: string) {
    const row = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw unprocessable(`${label} must belong to same company`);
  }

  async function assertProjectInCompany(companyId: string, projectId: string) {
    const row = await db
      .select({ id: projects.id, leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Project not found");
    return row;
  }

  /** Members (other than the manager) report to the team manager. */
  async function syncMembersToManager(companyId: string, teamId: string, managerAgentId: string | null) {
    if (!managerAgentId) return;
    await db
      .update(agents)
      .set({ reportsTo: managerAgentId, updatedAt: new Date() })
      .where(and(eq(agents.companyId, companyId), eq(agents.teamId, teamId), ne(agents.id, managerAgentId)));
  }

  async function listProjectIds(companyId: string, teamIds: string[]) {
    if (teamIds.length === 0) return new Map<string, string[]>();
    const rows = await db
      .select({ teamId: teamProjects.teamId, projectId: teamProjects.projectId })
      .from(teamProjects)
      .where(and(eq(teamProjects.companyId, companyId), inArray(teamProjects.teamId, teamIds)))
      .orderBy(asc(teamProjects.createdAt));
    const byTeam = new Map<string, string[]>();
    for (const row of rows) byTeam.set(row.teamId, [...(byTeam.get(row.teamId) ?? []), row.projectId]);
    return byTeam;
  }

  return {
    list: async (companyId: string) => {
      const rows = await db.select().from(teams).where(eq(teams.companyId, companyId)).orderBy(asc(teams.name));
      const projectIds = await listProjectIds(companyId, rows.map((row) => row.id));
      return rows.map((row) => ({ ...row, projectIds: projectIds.get(row.id) ?? [] }));
    },

    getById,

    getWithProjects: async (companyId: string, teamId: string) => {
      const row = await getById(companyId, teamId);
      return { ...row, projectIds: (await listProjectIds(companyId, [teamId])).get(teamId) ?? [] };
    },

    create: async (companyId: string, data: CreateTeam) => {
      if (data.managerAgentId) await assertAgentInCompany(companyId, data.managerAgentId, "Team manager");
      try {
        const [row] = await db
          .insert(teams)
          .values({
            companyId,
            name: data.name,
            description: data.description ?? null,
            managerAgentId: data.managerAgentId ?? null,
            runLimits: data.runLimits ?? {},
          })
          .returning();
        return row!;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A team with this name already exists");
        throw error;
      }
    },

    update: async (companyId: string, teamId: string, data: UpdateTeam) => {
      await getById(companyId, teamId);
      if (data.managerAgentId) await assertAgentInCompany(companyId, data.managerAgentId, "Team manager");
      try {
        const [row] = await db
          .update(teams)
          .set({ ...data, updatedAt: new Date() })
          .where(and(eq(teams.companyId, companyId), eq(teams.id, teamId)))
          .returning();
        if (data.managerAgentId) await syncMembersToManager(companyId, teamId, data.managerAgentId);
        return row!;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A team with this name already exists");
        throw error;
      }
    },

    remove: async (companyId: string, teamId: string) => {
      const row = await getById(companyId, teamId);
      // FK is ON DELETE SET NULL, so member agents fall back to company limits.
      await db.delete(teams).where(and(eq(teams.companyId, companyId), eq(teams.id, teamId)));
      return row;
    },

    /** Throws 422 unless the team exists in the same company. Returns the team manager id. */
    assertTeamInCompany: async (companyId: string, teamId: string | null | undefined) => {
      if (!teamId) return null;
      const row = await db
        .select({ id: teams.id, managerAgentId: teams.managerAgentId })
        .from(teams)
        .where(and(eq(teams.companyId, companyId), eq(teams.id, teamId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw unprocessable("Team must belong to same company");
      return row.managerAgentId;
    },

    listMemberIds: (companyId: string, teamId: string) =>
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.teamId, teamId)))
        .then((rows) => rows.map((row) => row.id)),

    linkProject: async (companyId: string, teamId: string, projectId: string) => {
      await getById(companyId, teamId);
      await assertProjectInCompany(companyId, projectId);
      const [row] = await db
        .insert(teamProjects)
        .values({ companyId, teamId, projectId })
        .onConflictDoNothing()
        .returning();
      return { created: Boolean(row) };
    },

    unlinkProject: async (companyId: string, teamId: string, projectId: string) => {
      await getById(companyId, teamId);
      const rows = await db
        .delete(teamProjects)
        .where(
          and(
            eq(teamProjects.companyId, companyId),
            eq(teamProjects.teamId, teamId),
            eq(teamProjects.projectId, projectId),
          ),
        )
        .returning();
      if (rows.length === 0) throw notFound("Team is not linked to this project");
    },

    /** Sets the project's current PM (leadAgentId) and records the change. */
    handOffProjectManager: async (
      companyId: string,
      projectId: string,
      input: { toAgentId: string | null; reason?: string | null; actorType: string; actorId: string },
    ) => {
      const project = await assertProjectInCompany(companyId, projectId);
      if (input.toAgentId) await assertAgentInCompany(companyId, input.toAgentId, "Project manager");
      return db.transaction(async (tx) => {
        await tx
          .update(projects)
          .set({ leadAgentId: input.toAgentId, updatedAt: new Date() })
          .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
        const [row] = await tx
          .insert(projectPmHandoffs)
          .values({
            companyId,
            projectId,
            fromAgentId: project.leadAgentId,
            toAgentId: input.toAgentId,
            reason: input.reason ?? null,
            actorType: input.actorType,
            actorId: input.actorId,
          })
          .returning();
        return row!;
      });
    },

    listProjectManagerHandoffs: async (companyId: string, projectId: string) => {
      await assertProjectInCompany(companyId, projectId);
      return db
        .select()
        .from(projectPmHandoffs)
        .where(and(eq(projectPmHandoffs.companyId, companyId), eq(projectPmHandoffs.projectId, projectId)))
        .orderBy(desc(projectPmHandoffs.createdAt));
    },
  };
}
