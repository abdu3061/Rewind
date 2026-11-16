import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { httpUrlSchema } from "./files";

const nativeBase = { version: z.literal(1), connectionId: idSchema };
/** Candidate inbound wire contract. Passing this schema does not grant engine authority. */
export const nativeBrowserMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...nativeBase,
    type: z.literal("hello"),
    browser: z.enum(["chrome", "edge"]),
  }),
  z.strictObject({
    ...nativeBase,
    type: z.literal("visit"),
    sessionId: idSchema,
    generationId: idSchema,
    sequence: z.number().int().positive().safe(),
    occurredAt: timestampSchema,
    incognito: z.literal(false),
    focused: z.literal(true),
    url: httpUrlSchema.refine((value) => {
      const url = new URL(value);
      return !url.search && !url.hash;
    }, "Native metadata must omit query and fragment."),
    title: z.string().max(2048),
  }),
]);
export type NativeBrowserMessage = z.infer<typeof nativeBrowserMessageSchema>;

/** For a future permissioned extension adapter; never returns credentials or query/fragment text. */
export function sanitizeBrowserMetadataUrl(
  input: string,
  excludedHosts: readonly string[],
): string | null {
  const checked = httpUrlSchema.safeParse(input);
  if (!checked.success) return null;
  const url = new URL(checked.data);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    excludedHosts.some((item) => {
      const excluded = item.trim().toLowerCase().replace(/\.$/, "");
      return excluded && (host === excluded || host.endsWith(`.${excluded}`));
    })
  )
    return null;
  url.search = "";
  url.hash = "";
  return url.toString();
}
