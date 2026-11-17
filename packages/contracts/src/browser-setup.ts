import { z } from "zod";
import { idSchema, timestampSchema, type Result } from "./common";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.strictObject({
  osIdentity: z.string().min(1).max(128),
  contentHash: digest,
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(4 * 1024 * 1024),
});
const browsers = z
  .array(z.enum(["chrome", "edge"]))
  .min(1)
  .max(2)
  .refine((items) => new Set(items).size === items.length);
export const browserSetupGenerationSchema = z.strictObject({
  id: idSchema,
  createdAt: timestampSchema,
  directoryIdentity: z.string().min(1).max(128),
  native: receipt,
  configuration: receipt.refine((item) => item.byteLength <= 16384),
  manifest: receipt.refine((item) => item.byteLength <= 16384),
  desktopHash: digest,
  nativeSourceHash: digest,
  extensionId: z.string().regex(/^[a-p]{32}$/),
  browsers,
});
const targets = z.strictObject({
  chrome: idSchema.nullable(),
  edge: idSchema.nullable(),
});
/** Private durable setup ownership, never a recording grant or renderer/native path token. */
export const browserSetupJournalSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    generations: z.array(browserSetupGenerationSchema).max(128),
    registrations: targets,
    pending: z
      .strictObject({
        operation: z.enum(["install", "remove"]),
        generationId: idSchema,
        browsers,
        previous: targets,
      })
      .nullable(),
  })
  .superRefine((value, context) => {
    const byId = new Map(value.generations.map((item) => [item.id, item]));
    if (byId.size !== value.generations.length)
      context.addIssue({
        code: "custom",
        message: "Setup generation IDs must be unique.",
      });
    if (
      value.registrations.chrome &&
      value.registrations.edge &&
      value.registrations.chrome !== value.registrations.edge
    )
      context.addIssue({
        code: "custom",
        message: "Registered browsers must share one bridge generation.",
      });
    for (const kind of ["chrome", "edge"] as const) {
      for (const id of [
        value.registrations[kind],
        value.pending?.previous[kind],
      ]) {
        if (id != null && !byId.get(id)?.browsers.includes(kind))
          context.addIssue({
            code: "custom",
            message:
              "Setup registration must reference owned browser evidence.",
          });
      }
    }
    if (value.pending) {
      const generation = byId.get(value.pending.generationId);
      if (
        !generation ||
        value.pending.browsers.some(
          (kind) => !generation.browsers.includes(kind),
        )
      )
        context.addIssue({
          code: "custom",
          message: "Pending setup must reference an owned generation.",
        });
    }
  });
export type BrowserSetupGeneration = z.infer<
  typeof browserSetupGenerationSchema
>;
export type BrowserSetupJournal = z.infer<typeof browserSetupJournalSchema>;
export interface BrowserSetupStore {
  read(): Promise<Result<BrowserSetupJournal>>;
  write(
    expectedRevision: number,
    next: BrowserSetupJournal,
  ): Promise<Result<void>>;
}
export function createBrowserSetupJournal(): BrowserSetupJournal {
  return {
    version: 1,
    revision: 0,
    generations: [],
    registrations: { chrome: null, edge: null },
    pending: null,
  };
}
