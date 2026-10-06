import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, teams } from "@paperclipai/db";
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

  return {
    list: (companyId: string) =>
      db.select().from(teams).where(eq(teams.companyId, companyId)).orderBy(asc(teams.name)),

    getById,

    create: async (companyId: string, data: CreateTeam) => {
      try {
        const [row] = await db
          .insert(teams)
          .values({
            companyId,
            name: data.name,
            description: data.description ?? null,
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
      try {
        const [row] = await db
          .update(teams)
          .set({ ...data, updatedAt: new Date() })
          .where(and(eq(teams.companyId, companyId), eq(teams.id, teamId)))
          .returning();
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

    /** Throws 422 unless the team exists in the same company. */
    assertTeamInCompany: async (companyId: string, teamId: string | null | undefined) => {
      if (!teamId) return;
      const row = await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.companyId, companyId), eq(teams.id, teamId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw unprocessable("Team must belong to same company");
    },

    listMemberIds: (companyId: string, teamId: string) =>
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.teamId, teamId)))
        .then((rows) => rows.map((row) => row.id)),
  };
}
