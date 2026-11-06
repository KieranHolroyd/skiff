import * as z from 'zod';

/** Database failover orchestration (docs/CLUSTERING.md §9.3, C8). */
export const failoverStages = ['detect', 'decide', 'fence', 'promote', 'repoint', 'heal', 'complete'] as const;
export type FailoverStage = (typeof failoverStages)[number];
export const failoverStageSchema = z.enum(failoverStages);

export const failoverPlanSchema = z.object({
	databaseId: z.string().min(1).max(100),
	candidateNodeId: z.string().min(1).max(100),
	generation: z.number().int().positive(),
	stage: failoverStageSchema.default('detect'),
	reason: z.string().max(200).default(''),
});
export type FailoverPlan = z.infer<typeof failoverPlanSchema>;
