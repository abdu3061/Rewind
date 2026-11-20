import { z } from "zod";
import { resultSchema } from "./common";

export const PRESENTATION_CHANNEL = "rewind:presentation" as const;
export const PRESENTATION_CHANGED_CHANNEL =
  "rewind:presentation-changed" as const;
export const desktopPageSchema = z.enum([
  "Dashboard",
  "Timeline",
  "Search",
  "Files",
  "Checkpoints",
  "Settings",
]);
export type DesktopPage = z.infer<typeof desktopPageSchema>;
export const presentationCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("get") }),
  z.strictObject({ action: z.literal("expand") }),
  z.strictObject({ action: z.literal("collapse") }),
  z.strictObject({
    action: z.literal("resize"),
    height: z.number().int().min(200).max(560),
  }),
  z.strictObject({ action: z.literal("hide") }),
  z.strictObject({
    action: z.literal("open"),
    page: desktopPageSchema.optional(),
  }),
]);
export type PresentationCommand = z.infer<typeof presentationCommandSchema>;
export const presentationStateSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  notchVisible: z.boolean(),
  expanded: z.boolean(),
  navigation: z
    .strictObject({
      page: desktopPageSchema,
      revision: z.number().int().nonnegative().safe(),
    })
    .nullable(),
});
export type PresentationState = z.infer<typeof presentationStateSchema>;
export const presentationResponseSchema = resultSchema(presentationStateSchema);
