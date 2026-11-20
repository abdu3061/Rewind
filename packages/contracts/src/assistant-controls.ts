import { z } from "zod";
import { idSchema, resultSchema, timestampSchema } from "./common";
import {
  assistantCredentialChallengeSchema,
  assistantReviewApprovalSchema,
  assistantReviewPreparationSchema,
  assistantReviewSchema,
  assistantSealedCredentialSchema,
  evidenceAnswerSchema,
} from "./assistant";

export const assistantControlStateSchema = z.strictObject({
  generation: idSchema,
  configured: z.boolean(),
  permission: z.boolean(),
  busy: z.boolean(),
  credentialPending: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
});
export type AssistantControlState = z.infer<typeof assistantControlStateSchema>;
export const assistantControlResponseSchema = resultSchema(
  assistantControlStateSchema,
);
export const assistantReviewReceiptSchema = z.strictObject({
  generation: idSchema,
  review: assistantReviewSchema,
  revision: assistantControlStateSchema.shape.revision,
});
export const assistantReviewResponseSchema = resultSchema(
  assistantReviewReceiptSchema,
);
export const assistantAnswerReceiptSchema = z.strictObject({
  generation: idSchema,
  answer: evidenceAnswerSchema,
  expiresAt: timestampSchema,
  revision: assistantControlStateSchema.shape.revision,
});
export const assistantAnswerResponseSchema = resultSchema(
  assistantAnswerReceiptSchema,
);
export const assistantCredentialChallengeResponseSchema = resultSchema(
  assistantCredentialChallengeSchema,
);
export type AssistantReviewReceipt = z.infer<
  typeof assistantReviewReceiptSchema
>;
export type AssistantAnswerReceipt = z.infer<
  typeof assistantAnswerReceiptSchema
>;
export const assistantConfigureResponseSchema = resultSchema(
  assistantControlStateSchema.nullable(),
);

/** These operations carry IDs and confirmations, never renderer-supplied evidence or API keys. */
export const assistantOperationCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("assistant.state") }),
  z.strictObject({
    kind: z.literal("assistant.permission"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("assistant.forget"),
    confirmed: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("assistant.prepare"),
    value: assistantReviewPreparationSchema,
  }),
  z.strictObject({
    kind: z.literal("assistant.ask"),
    value: assistantReviewApprovalSchema,
  }),
  z.strictObject({ kind: z.literal("assistant.cancel"), id: idSchema }),
  z.strictObject({ kind: z.literal("assistant.stop") }),
]);
/** Private main-to-utility credential route; not a renderer capability. */
export const assistantWorkerCommandSchema = z.discriminatedUnion("kind", [
  ...assistantOperationCommandSchema.options,
  z.strictObject({
    kind: z.literal("assistant.credential.prepare"),
    confirmed: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("assistant.credential.accept"),
    value: assistantSealedCredentialSchema,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("assistant.credential.cancel"),
    id: idSchema,
  }),
]);
export type AssistantWorkerCommand = z.infer<
  typeof assistantWorkerCommandSchema
>;
export const assistantCommandSchema = z.discriminatedUnion("kind", [
  ...assistantOperationCommandSchema.options,
  z.strictObject({
    kind: z.literal("assistant.configure"),
    confirmed: z.literal(true),
  }),
]);
