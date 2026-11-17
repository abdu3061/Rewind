import { z } from "zod";
import { resultSchema } from "@rewind/contracts";

// Browser-issued document tokens are separate from Rewind domain IDs. Chromium 157 returns 32 hex digits.
export const browserDocumentIdSchema = z.union([
  z.uuid(),
  z.string().regex(/^[a-f0-9]{32}$/i),
]);

export const extensionStatusSchema = z
  .strictObject({
    service: z.enum(["starting", "ready", "unavailable"]),
    permission: z.boolean(),
    connected: z.boolean(),
    collecting: z.boolean(),
    pending: z.boolean(),
    issue: z.enum(["connection", "protocol", "send"]).nullable(),
  })
  .refine(
    (status) =>
      !status.collecting ||
      (status.service === "ready" &&
        status.permission &&
        status.connected &&
        status.issue === null),
    "Collection needs a ready approved connection.",
  );
export type ExtensionStatus = z.infer<typeof extensionStatusSchema>;
export const extensionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rewind.browser.status") }),
  z.strictObject({
    kind: z.literal("rewind.browser.permission"),
    enabled: z.boolean(),
  }),
]);
export const extensionResponseSchema = resultSchema(extensionStatusSchema);

/** Fixed sender fields; the background also verifies document/main-frame identity through browser contexts. */
export function extensionControlSender(
  sender: {
    id?: string | undefined;
    url?: string | undefined;
    origin?: string | undefined;
    frameId?: number | undefined;
  },
  extensionId: string,
): boolean {
  const origin = `chrome-extension://${extensionId}`;
  return (
    /^[a-p]{32}$/.test(extensionId) &&
    sender.id === extensionId &&
    sender.url === `${origin}/status.html` &&
    sender.origin === origin &&
    (sender.frameId === undefined || sender.frameId === 0)
  );
}

interface ControlContext {
  documentId?: string | undefined;
  documentOrigin?: string | undefined;
  documentUrl?: string | undefined;
  frameId: number;
  contextType: string;
  incognito: boolean;
}
export function extensionControlContext(
  context: ControlContext,
  documentId: string,
  extensionId: string,
): boolean {
  const origin = `chrome-extension://${extensionId}`;
  return (
    context.documentId === documentId &&
    context.frameId === 0 &&
    !context.incognito &&
    ["TAB", "POPUP"].includes(context.contextType) &&
    context.documentOrigin === origin &&
    context.documentUrl === `${origin}/status.html`
  );
}

/** Popup senders omit documentId/tab/frameId. Their non-embeddable private page must be the one live popup. */
export function extensionControlContexts(
  contexts: readonly ControlContext[],
  sender: {
    documentId?: string | undefined;
    frameId?: number | undefined;
    hasTab: boolean;
  },
  extensionId: string,
): boolean {
  if (contexts.length !== 1) return false;
  const context = contexts[0]!;
  if (sender.documentId !== undefined)
    return (
      browserDocumentIdSchema.safeParse(sender.documentId).success &&
      extensionControlContext(context, sender.documentId, extensionId)
    );
  return (
    !sender.hasTab &&
    sender.frameId === undefined &&
    context.contextType === "POPUP" &&
    browserDocumentIdSchema.safeParse(context.documentId).success &&
    extensionControlContext(context, context.documentId!, extensionId)
  );
}
