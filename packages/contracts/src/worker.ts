import { z } from "zod";
import { appErrorSchema, idSchema, resultSchema } from "./common";
import { sessionCommandSchema } from "./session";
import {
  collectionPreferencesSchema,
  historyQuerySchema,
  runtimeSnapshotSchema,
  timelineQuerySchema,
} from "./recording";

export const workerCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("session"),
    action: sessionCommandSchema.shape.action,
  }),
  z.strictObject({ kind: z.literal("snapshot") }),
  z.strictObject({ kind: z.literal("preferences.get") }),
  z.strictObject({
    kind: z.literal("preferences.update"),
    value: collectionPreferencesSchema,
  }),
  z.strictObject({ kind: z.literal("timeline"), query: timelineQuerySchema }),
  z.strictObject({ kind: z.literal("history"), query: historyQuerySchema }),
  z.strictObject({ kind: z.literal("shutdown") }),
]);
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
const base = { version: z.literal(1), bootId: idSchema };
export const workerInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("init"),
    root: z.string().min(1).max(32767),
    key: z.instanceof(Uint8Array).refine((value) => value.length === 32),
    synthetic: z.boolean(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("command"),
    id: idSchema,
    command: workerCommandSchema,
  }),
  z.strictObject({ ...base, type: z.literal("heartbeat") }),
]);
export type WorkerInput = z.infer<typeof workerInputSchema>;
export const workerOutputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("ready"),
    state: runtimeSnapshotSchema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("snapshot"),
    state: runtimeSnapshotSchema,
  }),
  z.strictObject({ ...base, type: z.literal("activity"), sessionId: idSchema }),
  z.strictObject({
    ...base,
    type: z.literal("reply"),
    id: idSchema,
    kind: z.enum([
      "session",
      "snapshot",
      "preferences.get",
      "preferences.update",
      "timeline",
      "history",
      "shutdown",
    ]),
    result: resultSchema(z.unknown()),
  }),
  z.strictObject({ ...base, type: z.literal("fault"), error: appErrorSchema }),
]);
export type WorkerOutput = z.infer<typeof workerOutputSchema>;
export function boundedWorkerMessage(value: unknown): boolean {
  try {
    // Key material is never serialized into a diagnostic/bounds-check string.
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "init"
    )
      return workerInputSchema.safeParse(value).success;
    return (
      // Fits 100 maximum-size escaped title DTOs; ingestion keeps its stricter 256 KiB bound.
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      2 * 1024 * 1024
    );
  } catch {
    return false;
  }
}
