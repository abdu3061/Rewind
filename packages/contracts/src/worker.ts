import { z } from "zod";
import {
  automaticRecordingCommandSchema,
  automaticFoldersSchema,
} from "./automatic-recording";
import { appErrorSchema, idSchema, resultSchema } from "./common";
import { sessionCommandSchema } from "./session";
import { storageCommandSchema } from "./storage-management";
import { fileCommandSchema } from "./file-controls";
import { fileTextCommandSchema } from "./file-text-controls";
import { recoveryCommandSchema } from "./recovery";
import { checkpointCommandSchema } from "./checkpoint-controls";
import { browserCommandSchema } from "./browser-controls";
import { assistantWorkerCommandSchema } from "./assistant-controls";
import {
  documentRelayReplySchema,
  documentRelayRequestSchema,
} from "./document-worker";
import {
  collectionPreferencesSchema,
  historyQuerySchema,
  runtimeSnapshotSchema,
  timelineQuerySchema,
} from "./recording";

export const workerCommandSchema = z.discriminatedUnion("kind", [
  ...automaticRecordingCommandSchema.options,
  ...fileTextCommandSchema.options,
  z.strictObject({ kind: z.literal("versions.source"), id: idSchema }),
  ...assistantWorkerCommandSchema.options,
  z.strictObject({ kind: z.literal("browser.verify-assets") }),
  ...browserCommandSchema.options,
  ...checkpointCommandSchema.options,
  ...recoveryCommandSchema.options,
  z.strictObject({
    kind: z.literal("recovery.prepare-copy"),
    versionId: idSchema,
    path: z.string().min(4).max(240),
  }),
  z.strictObject({
    kind: z.literal("recovery.prepare-overwrite"),
    versionId: idSchema,
    path: z.string().min(4).max(240),
  }),
  ...storageCommandSchema.options,
  ...fileCommandSchema.options,
  z.strictObject({
    kind: z.literal("files.add"),
    path: z.string().min(4).max(240),
  }),
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
/** Main-owned boot metadata only; never part of a renderer command or response. */
export const browserAssetsLocationSchema = z.strictObject({
  root: z.string().min(4).max(32767),
  desktopPath: z.string().min(4).max(32767),
  hostName: z
    .string()
    .regex(/^(com\.rewind\.bridge|com\.rewind\.test\.[a-f0-9]{32})$/)
    .optional(),
});
export type BrowserAssetsLocation = z.infer<typeof browserAssetsLocationSchema>;
export const workerInputSchema = z.discriminatedUnion("type", [
  documentRelayReplySchema.options[0].extend({ bootId: idSchema }),
  documentRelayReplySchema.options[1].extend({ bootId: idSchema }),
  z.strictObject({
    ...base,
    type: z.literal("init"),
    root: z.string().min(1).max(32767),
    key: z.instanceof(Uint8Array).refine((value) => value.length === 32),
    synthetic: z.boolean(),
    automaticFolders: automaticFoldersSchema.optional(),
    automaticStart: z.boolean().optional(),
    assistantFixture: z.literal(true).optional(),
    browserAssets: browserAssetsLocationSchema.optional(),
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
export const workerDocumentOutputSchema = z.discriminatedUnion("type", [
  documentRelayRequestSchema.options[0].extend({ bootId: idSchema }),
  documentRelayRequestSchema.options[1].extend({ bootId: idSchema }),
]);
export const workerOutputSchema = z.discriminatedUnion("type", [
  ...workerDocumentOutputSchema.options,
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
      "content.state",
      "content.index",
      "content.search",
      "content.stop",
      "content.clear-search",
      "assistant.state",
      "assistant.permission",
      "assistant.forget",
      "assistant.prepare",
      "assistant.ask",
      "assistant.cancel",
      "assistant.stop",
      "assistant.credential.prepare",
      "assistant.credential.accept",
      "assistant.credential.cancel",
      "browser.state",
      "browser.verify-assets",
      "browser.install",
      "browser.remove",
      "browser.repair",
      "browser.permission",
      "browser.exclusions",
      "checkpoints.create",
      "checkpoints.view",
      "checkpoints.list",
      "checkpoints.update",
      "checkpoints.delete",
      "recovery.choose-copy",
      "recovery.choose-overwrite",
      "recovery.prepare-overwrite",
      "recovery.confirm-overwrite",
      "recovery.prepare-copy",
      "recovery.confirm-copy",
      "recovery.cancel",
      "session",
      "snapshot",
      "preferences.get",
      "recording.state",
      "recording.configure",
      "preferences.update",
      "timeline",
      "history",
      "shutdown",
      "storage.usage",
      "storage.update",
      "storage.cleanup",
      "storage.delete",
      "files.state",
      "files.select",
      "files.add",
      "files.permission",
      "files.remove",
      "versions.list",
      "versions.preview",
      "versions.cancel-preview",
      "versions.source",
      "versions.info",
    ]),
    result: resultSchema(z.unknown()),
  }),
  z.strictObject({ ...base, type: z.literal("fault"), error: appErrorSchema }),
]);
export type WorkerOutput = z.infer<typeof workerOutputSchema>;
export function boundedWorkerMessage(value: unknown): boolean {
  try {
    // Binary document requests are admitted only on the private worker relay.
    // Never stringify their potentially large byte arrays on public IPC paths.
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      (value.type === "document-parse" || value.type === "document-stop")
    )
      return false;
    // Key material is never serialized into a diagnostic/bounds-check string.
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "init"
    )
      return workerInputSchema.safeParse(value).success;
    return (
      // Fits 100 maximum-size redacted metadata DTOs; article text is not a timeline capability.
      // Ingestion keeps its stricter 256 KiB bound.
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      2 * 1024 * 1024
    );
  } catch {
    return false;
  }
}
