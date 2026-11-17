import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { fileReferenceSchema, httpUrlSchema } from "./files";

export const browserVisitSchema = z
  .strictObject({
    id: idSchema,
    sessionId: idSchema,
    browser: z.enum(["chrome", "edge"]),
    url: httpUrlSchema,
    title: z.string().max(2048),
    visitedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
    articleText: z.string().max(100_000).optional(),
  })
  .refine(
    (visit) => visit.endedAt === null || visit.endedAt >= visit.visitedAt,
    "Visit timestamps must be ordered.",
  );
export type BrowserVisit = z.infer<typeof browserVisitSchema>;

const eventBase = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  occurredAt: timestampSchema,
  source: z.enum(["windows", "browser", "filesystem", "rewind"]),
});
// Payloads express observations; a file change never proves that a user read a file.
export const activityEventSchema = z
  .discriminatedUnion("type", [
    eventBase.extend({
      type: z.literal("foreground"),
      source: z.literal("windows"),
      payload: z.strictObject({
        application: z.string().min(1).max(255),
        windowTitle: z.string().max(2048),
      }),
    }),
    eventBase.extend({
      type: z.literal("browser-visit"),
      source: z.literal("browser"),
      payload: browserVisitSchema,
    }),
    eventBase.extend({
      type: z.literal("file-change"),
      source: z.literal("filesystem"),
      payload: z.strictObject({
        fileId: idSchema,
        displayName: z.string().min(1).max(255).optional(),
        change: z.enum([
          "created",
          "updated",
          "deleted",
          "renamed",
          "captured",
        ]),
      }),
    }),
    eventBase.extend({
      type: z.literal("file-opened"),
      source: z.literal("rewind"),
      payload: fileReferenceSchema,
    }),
    eventBase.extend({
      type: z.literal("idle"),
      source: z.literal("windows"),
      payload: z.strictObject({ state: z.enum(["entered", "left"]) }),
    }),
    eventBase.extend({
      type: z.literal("lock"),
      source: z.literal("windows"),
      payload: z.strictObject({ state: z.enum(["locked", "unlocked"]) }),
    }),
    eventBase.extend({
      type: z.literal("capture-gap"),
      payload: z.strictObject({
        collectorId: z.string().min(1).max(100),
        reason: z.enum(["unavailable", "overflow", "permission-denied"]),
      }),
    }),
  ])
  .refine(
    (event) =>
      event.type !== "browser-visit" ||
      event.sessionId === event.payload.sessionId,
    "Browser observation must belong to its event session.",
  );
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export const activityBatchSchema = z.array(activityEventSchema).max(128);
export type ActivityType = ActivityEvent["type"];
export const activityCursorSchema = z.strictObject({
  occurredAt: timestampSchema,
  id: idSchema,
});
export type ActivityCursor = z.infer<typeof activityCursorSchema>;
