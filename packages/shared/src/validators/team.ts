import { z } from "zod";
import { objectWithoutDefaults } from "./partial.js";

/** One shape for run limits at every level: company, team, agent, task. */
export const runLimitsSchema = z
  .object({
    model: z.string().trim().min(1).max(200).nullable().optional(),
    maxOutputTokensPerRun: z.number().int().positive().max(100_000_000).nullable().optional(),
    // 7 days is far above any real run; it only rejects typos like milliseconds.
    timeoutSec: z.number().int().positive().max(7 * 24 * 60 * 60).nullable().optional(),
  })
  .strict();

export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  runLimits: runLimitsSchema.optional(),
});

export const updateTeamSchema = objectWithoutDefaults(createTeamSchema.partial()).refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one team field is required" },
);

export type CreateTeam = z.infer<typeof createTeamSchema>;
export type UpdateTeam = z.infer<typeof updateTeamSchema>;
