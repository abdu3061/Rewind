import { z } from "zod";
import { appErrorSchema, resultSchema, timestampSchema } from "./common";
import { browserSiteHostSchema } from "./browser-transport";

export const browserKindSchema = z.enum(["chrome", "edge"]);
const kinds = z
  .array(browserKindSchema)
  .max(2)
  .refine((items) => new Set(items).size === items.length);
export const browserExclusionsSchema = z
  .array(browserSiteHostSchema)
  .max(200)
  .transform((items) => [...new Set(items)]);
export const browserControlStateSchema = z.strictObject({
  permission: z.boolean(),
  excludedSiteHosts: z.array(z.string().min(1).max(253)).max(1000),
  policyValid: z.boolean(),
  busy: z.boolean(),
  setup: z.strictObject({
    state: z.enum([
      "not-installed",
      "installed",
      "needs-attention",
      "unavailable",
    ]),
    availableBrowsers: kinds,
    registeredBrowsers: kinds,
    repairAvailable: z.boolean(),
    checkedAt: timestampSchema.nullable(),
    extensionId: z.string().regex(/^[a-p]{32}$/),
    error: appErrorSchema.nullable(),
  }),
  bridge: z.strictObject({
    state: z.enum(["off", "starting", "ready", "unavailable"]),
    connected: z.number().int().min(0).max(4),
  }),
  capture: z.strictObject({
    state: z.enum(["off", "waiting", "active", "stopping", "unavailable"]),
    connected: z.number().int().min(0).max(4),
    pending: z.number().int().min(0).max(33),
    captured: z.number().int().nonnegative().safe(),
  }),
});
export type BrowserControlState = z.infer<typeof browserControlStateSchema>;
export const browserControlResponseSchema = resultSchema(
  browserControlStateSchema,
);
export const browserCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("browser.state") }),
  z.strictObject({
    kind: z.literal("browser.install"),
    browsers: kinds.refine((items) => items.length > 0),
    confirmed: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("browser.remove"),
    browser: browserKindSchema,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("browser.repair"),
    confirmed: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("browser.permission"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("browser.exclusions"),
    hosts: browserExclusionsSchema,
  }),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
