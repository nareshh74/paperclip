import { z } from "zod";

const weight = z.number().min(0).max(10);

export const matchingConfigSchema = z
  .object({
    weights: z
      .object({
        similarity: weight.optional(),
        quality: weight.optional(),
        efficiency: weight.optional(),
        availability: weight.optional(),
        teamProject: weight.optional(),
      })
      .strict()
      .optional(),
    tieEpsilon: z.number().min(0).max(1).optional(),
  })
  .strict();

export const matchCandidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const createMatchingTrialSchema = z.object({
  agentIds: z
    .array(z.string().guid())
    .min(2)
    .max(3)
    .refine((ids) => new Set(ids).size === ids.length, { message: "agentIds must be distinct" }),
});

export const decideMatchingTrialSchema = z.object({
  winnerAgentId: z.string().guid(),
  reason: z.string().trim().min(1).max(2000),
});

export type CreateMatchingTrial = z.infer<typeof createMatchingTrialSchema>;
export type DecideMatchingTrial = z.infer<typeof decideMatchingTrialSchema>;
