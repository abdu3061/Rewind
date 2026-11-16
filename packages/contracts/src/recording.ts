import { z } from "zod";
import { activityCursorSchema, activityEventSchema } from "./activity";
import {
  appErrorSchema,
  idSchema,
  resultSchema,
  timestampSchema,
} from "./common";
import { sessionSchema } from "./session";
import { userSettingsSchema } from "./settings";

export const collectionPreferencesSchema = userSettingsSchema
  .pick({
    collectionConsent: true,
    excludedApplications: true,
  })
  .extend({
    excludedApplications:
      userSettingsSchema.shape.excludedApplications.max(200),
  });
export type CollectionPreferences = z.infer<typeof collectionPreferencesSchema>;
export const timelineQuerySchema = z
  .strictObject({
    sessionId: idSchema.optional(),
    limit: z.number().int().min(1).max(100),
    before: activityCursorSchema.optional(),
    from: timestampSchema.optional(),
    to: timestampSchema.optional(),
    text: z.string().trim().max(2000).optional(),
    types: z
      .array(z.enum(["foreground", "capture-gap"]))
      .min(1)
      .max(2)
      .optional(),
  })
  .refine(
    (query) => !query.from || !query.to || query.from <= query.to,
    "Invalid date range.",
  );
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
export const historyQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  before: z
    .strictObject({ startedAt: timestampSchema, id: idSchema })
    .optional(),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export const runtimeSnapshotSchema = z.strictObject({
  service: z.enum(["starting", "ready", "unavailable", "stopping"]),
  collection: z.enum(["off", "starting", "active", "stopping", "unavailable"]),
  session: sessionSchema.nullable(),
  preferences: collectionPreferencesSchema,
  secureStorage: z.boolean(),
  synthetic: z.boolean(),
  error: appErrorSchema.nullable(),
  revision: z.number().int().nonnegative().safe(),
});
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
export const timelineResponseSchema = resultSchema(
  z.array(activityEventSchema).max(100),
);
export const historyResponseSchema = resultSchema(
  z.array(sessionSchema).max(100),
);
export const preferencesResponseSchema = resultSchema(
  collectionPreferencesSchema,
);
export const runtimeResponseSchema = resultSchema(runtimeSnapshotSchema);
export const acknowledgementResponseSchema = resultSchema(z.literal(true));

export const RECORDING_CHANNEL = "rewind:recording" as const;
export const RUNTIME_CHANGED_CHANNEL = "rewind:runtime-changed" as const;
export const ACTIVITY_CHANGED_CHANNEL = "rewind:activity-changed" as const;
export const recordingCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("runtime.get") }),
  z.strictObject({ kind: z.literal("runtime.retry") }),
  z.strictObject({ kind: z.literal("privacy.get") }),
  z.strictObject({
    kind: z.literal("privacy.update"),
    value: collectionPreferencesSchema,
  }),
  z.strictObject({
    kind: z.literal("timeline.query"),
    query: timelineQuerySchema,
  }),
  z.strictObject({
    kind: z.literal("history.list"),
    query: historyQuerySchema,
  }),
]);
