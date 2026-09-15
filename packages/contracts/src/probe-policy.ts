import { z } from "zod";

export type ConsensusPolicy = {
  mode: "any" | "majority" | "all" | "at_least" | "specified";
  minimumValid: number;
  failureVotes?: number;
  specifiedProbeId?: string;
};

export const consensusPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("any"), minimumValid: z.number().int().min(1) }).strict(),
  z.object({ mode: z.literal("majority"), minimumValid: z.number().int().min(1) }).strict(),
  z.object({ mode: z.literal("all"), minimumValid: z.number().int().min(1) }).strict(),
  z.object({
    mode: z.literal("at_least"),
    minimumValid: z.number().int().min(1),
    failureVotes: z.number().int().min(1),
  }).strict(),
  z.object({
    mode: z.literal("specified"),
    minimumValid: z.number().int().min(1),
    specifiedProbeId: z.string().trim().min(1),
  }).strict(),
]);

export const probePolicySchema = z.object({
  memberIds: z.array(z.string().trim().min(1)).min(1),
  consensus: consensusPolicySchema,
  checkIntervalSeconds: z.number().int().min(1),
  executionWindowSeconds: z.number().int().min(1),
  candidateWindowSeconds: z.number().int().min(1),
  failureThreshold: z.number().int().min(1),
  successThreshold: z.number().int().min(1),
}).strict().superRefine((policy, context) => {
  const memberCount = new Set(policy.memberIds).size;
  if (memberCount !== policy.memberIds.length) {
    context.addIssue({ code: "custom", path: ["memberIds"], message: "memberIds must be unique" });
  }
  if (policy.consensus.minimumValid > memberCount) {
    context.addIssue({ code: "custom", path: ["consensus", "minimumValid"], message: "minimumValid cannot exceed member count" });
  }
  if (policy.consensus.mode === "at_least" && policy.consensus.failureVotes > memberCount) {
    context.addIssue({ code: "custom", path: ["consensus", "failureVotes"], message: "failureVotes cannot exceed member count" });
  }
  if (policy.consensus.mode === "specified" && !policy.memberIds.includes(policy.consensus.specifiedProbeId)) {
    context.addIssue({ code: "custom", path: ["consensus", "specifiedProbeId"], message: "specifiedProbeId must be a member" });
  }
  if (policy.executionWindowSeconds > policy.checkIntervalSeconds) {
    context.addIssue({ code: "custom", path: ["executionWindowSeconds"], message: "execution window cannot exceed check interval" });
  }
  if (policy.candidateWindowSeconds < policy.successThreshold * policy.checkIntervalSeconds) {
    context.addIssue({ code: "custom", path: ["candidateWindowSeconds"], message: "candidate window cannot cover required success rounds" });
  }
});

export type ProbePolicy = z.infer<typeof probePolicySchema>;
