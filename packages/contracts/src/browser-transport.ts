import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { httpUrlSchema } from "./files";

const nativeBase = { version: z.literal(2), connectionId: idSchema };
export const browserCapabilitySchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Permissioned inbound protocol. Schema validity is never native-peer or engine authority. */
export const nativeBrowserMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...nativeBase,
    type: z.literal("hello"),
    profileId: idSchema,
  }),
  z.strictObject({
    ...nativeBase,
    type: z.literal("visit"),
    sessionId: idSchema,
    generationId: idSchema,
    capability: browserCapabilitySchema,
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
  z.strictObject({
    ...nativeBase,
    type: z.literal("stopped"),
    revision: z.number().int().positive().safe(),
  }),
]);
export type NativeBrowserMessage = z.infer<typeof nativeBrowserMessageSchema>;

export const browserSiteHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value, context) => {
    try {
      const url = new URL(`https://${value}`),
        host = url.hostname.toLowerCase().replace(/\.$/, "");
      const domain = host
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
      const ipv6 = /^\[[a-f0-9:]+\]$/.test(host);
      if (
        (value.includes(":") && !value.endsWith("]")) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.port ||
        host.length > 253 ||
        (!domain && !ipv6)
      )
        throw new Error("SITE_HOST_INVALID");
      return host;
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "Use a website hostname without credentials, path, query or port.",
      });
      return z.NEVER;
    }
  });
export const browserAuthoritySchema = z.strictObject({
  sessionId: idSchema,
  generationId: idSchema,
  capability: browserCapabilitySchema,
  expiresAt: timestampSchema,
  validForMs: z.number().int().min(500).max(5000),
  excludedSiteHosts: z.array(browserSiteHostSchema).max(200),
});
export type BrowserAuthority = z.infer<typeof browserAuthoritySchema>;
export const nativeBrowserStateSchema = z.strictObject({
  ...nativeBase,
  type: z.literal("state"),
  revision: z.number().int().positive().safe(),
  browser: z.enum(["chrome", "edge"]),
  authority: browserAuthoritySchema.nullable(),
});
export type NativeBrowserState = z.infer<typeof nativeBrowserStateSchema>;

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
