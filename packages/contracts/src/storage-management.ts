import { z } from "zod";
import { idSchema, resultSchema } from "./common";
import { userSettingsSchema } from "./settings";

export const storagePreferencesSchema = userSettingsSchema
  .pick({
    retentionHours: true,
    storageLimitBytes: true,
  })
  .extend({
    storageLimitBytes: z
      .number()
      .int()
      .min(16 * 1024 ** 2)
      .max(2 * 1024 ** 3),
  });
export type StoragePreferences = z.infer<typeof storagePreferencesSchema>;
export const storageUsageSchema = z.strictObject({
  databaseBytes: z.number().int().nonnegative().safe(),
  journalBytes: z.number().int().nonnegative().safe(),
  totalBytes: z.number().int().nonnegative().safe(),
  activityCount: z.number().int().nonnegative(),
  versionCount: z.number().int().nonnegative(),
  checkpointCount: z.number().int().nonnegative(),
  keptCheckpointCount: z.number().int().nonnegative(),
  overQuota: z.boolean(),
  preferences: storagePreferencesSchema,
});
export type StorageUsage = z.infer<typeof storageUsageSchema>;
export const deleteHistorySchema = z.strictObject({
  sessionId: idSchema.optional(),
  includeKept: z.boolean(),
  confirmed: z.literal(true),
});
export type DeleteHistory = z.infer<typeof deleteHistorySchema>;
export const storageUsageResponseSchema = resultSchema(storageUsageSchema);
export const storageCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("storage.usage") }),
  z.strictObject({
    kind: z.literal("storage.update"),
    value: storagePreferencesSchema,
  }),
  z.strictObject({ kind: z.literal("storage.cleanup") }),
  z.strictObject({
    kind: z.literal("storage.delete"),
    value: deleteHistorySchema,
  }),
]);
