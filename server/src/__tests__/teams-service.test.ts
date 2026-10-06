import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, teams } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { teamService } from "../services/teams.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("team service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(teams);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  it("creates, updates, and scopes teams to a company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = teamService(db);

    const team = await svc.create(companyId, {
      name: "Platform",
      runLimits: { model: "m-1", maxOutputTokensPerRun: 5000, timeoutSec: 900 },
    });
    expect(team).toMatchObject({ companyId, runLimits: { model: "m-1", maxOutputTokensPerRun: 5000, timeoutSec: 900 } });

    const updated = await svc.update(companyId, team.id, { runLimits: { timeoutSec: 60 } });
    expect(updated.runLimits).toEqual({ timeoutSec: 60 });

    await expect(svc.create(companyId, { name: "Platform" })).rejects.toMatchObject({ status: 409 });
    await expect(svc.getById(otherCompanyId, team.id)).rejects.toMatchObject({ status: 404 });
    expect(await svc.list(otherCompanyId)).toEqual([]);
  });

  it("rejects a cross-company team on agents and detaches members on delete", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = teamService(db);
    const team = await svc.create(companyId, { name: "Platform" });
    const foreignTeam = await svc.create(otherCompanyId, { name: "Foreign" });

    const agentsSvc = agentService(db);
    await expect(
      agentsSvc.create(companyId, { name: "Builder", adapterType: "process", teamId: foreignTeam.id }),
    ).rejects.toMatchObject({ status: 422 });

    const agent = await agentsSvc.create(companyId, { name: "Builder", adapterType: "process", teamId: team.id });
    expect(await svc.listMemberIds(companyId, team.id)).toEqual([agent.id]);

    await svc.remove(companyId, team.id);
    const [row] = await db.select({ teamId: agents.teamId }).from(agents).where(eq(agents.id, agent.id));
    expect(row?.teamId).toBeNull();
  });
});
