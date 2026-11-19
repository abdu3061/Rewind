import { z } from "zod";
import { resultSchema } from "./common";

/** OS-resolved locations supplied by main, never renderer-selected paths. */
export const automaticFolderSchema = z.strictObject({
  name: z.enum(["Desktop", "Documents", "Downloads"]),
  path: z.string().min(4).max(240),
});
export const automaticFoldersSchema = z.array(automaticFolderSchema).max(3);
export type AutomaticFolder = z.infer<typeof automaticFolderSchema>;
export const automaticRecordingStateSchema = z.strictObject({
  enabled: z.boolean(),
  locations: automaticFoldersSchema,
  issue: z.string().max(500).nullable(),
});
export type AutomaticRecordingState = z.infer<
  typeof automaticRecordingStateSchema
>;
export const automaticRecordingResponseSchema = resultSchema(
  automaticRecordingStateSchema,
);
export const automaticRecordingCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("recording.state") }),
  z.strictObject({
    kind: z.literal("recording.configure"),
    enabled: z.boolean(),
    confirmed: z.literal(true),
  }),
]);
