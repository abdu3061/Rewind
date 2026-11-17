import { z } from "zod";
import { idSchema, resultSchema, timestampSchema } from "./common";
import { checkpointSchema } from "./files";
import { activityEventSchema } from "./activity";
import { capturedVersionSummarySchema } from "./file-controls";

export const checkpointCreateSchema = z
  .strictObject({
    sessionId: idSchema,
    name: checkpointSchema.shape.name,
    kept: z.boolean(),
    fileVersionIds: z.array(idSchema).max(100),
    activityIds: z.array(idSchema).max(200),
  })
  .refine(
    (value) => value.fileVersionIds.length + value.activityIds.length > 0,
    "Select actual captured evidence.",
  )
  .refine(
    (value) =>
      new Set(value.fileVersionIds).size === value.fileVersionIds.length &&
      new Set(value.activityIds).size === value.activityIds.length,
    "Duplicate evidence is not accepted.",
  );
export type CheckpointCreate = z.infer<typeof checkpointCreateSchema>;
export const checkpointListQuerySchema = z.strictObject({
  id: idSchema.optional(),
  sessionId: idSchema.optional(),
  limit: z.number().int().min(1).max(100),
  before: z
    .strictObject({ createdAt: timestampSchema, id: idSchema })
    .optional(),
});
export type CheckpointListQuery = z.infer<typeof checkpointListQuerySchema>;
export const checkpointSummarySchema = checkpointSchema
  .pick({ id: true, sessionId: true, name: true, kept: true, createdAt: true })
  .extend({
    fileVersionCount: z.number().int().min(0).max(1000),
    activityCount: z.number().int().min(0).max(1000),
  });
export type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;
export const checkpointViewSchema = z.strictObject({
  checkpoint: checkpointSchema,
  versions: z.array(capturedVersionSummarySchema).max(100),
  activities: z.array(activityEventSchema).max(200),
});
export type CheckpointView = z.infer<typeof checkpointViewSchema>;
export const checkpointUpdateSchema = z.strictObject({
  id: idSchema,
  name: checkpointSchema.shape.name,
  kept: z.boolean(),
});
export type CheckpointUpdate = z.infer<typeof checkpointUpdateSchema>;
export const checkpointResponseSchema = resultSchema(checkpointSchema);
export const checkpointListResponseSchema = resultSchema(
  z.array(checkpointSummarySchema).max(100),
);
export const checkpointViewResponseSchema = resultSchema(checkpointViewSchema);
export const checkpointDeleteResponseSchema = resultSchema(z.literal(true));
export const checkpointCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("checkpoints.create"),
    value: checkpointCreateSchema,
  }),
  z.strictObject({
    kind: z.literal("checkpoints.list"),
    query: checkpointListQuerySchema,
  }),
  z.strictObject({ kind: z.literal("checkpoints.view"), id: idSchema }),
  z.strictObject({
    kind: z.literal("checkpoints.update"),
    value: checkpointUpdateSchema,
  }),
  z.strictObject({
    kind: z.literal("checkpoints.delete"),
    id: idSchema,
    confirmed: z.literal(true),
  }),
]);
