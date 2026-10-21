import { z } from 'zod';
import { idSchema, timestampSchema } from './common';

export const sessionStatusSchema = z.enum(['active', 'paused', 'ended']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z
  .strictObject({
    id: idSchema,
    status: sessionStatusSchema,
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
  })
  .refine((session) => (session.status === 'ended') === (session.endedAt !== null), {
    message: 'Only an ended session has an end timestamp.',
  })
  .refine(
    (session) =>
      session.updatedAt >= session.startedAt &&
      (session.endedAt === null || session.endedAt === session.updatedAt),
    {
      message: 'Session timestamps must be ordered.',
    },
  );
export type Session = z.infer<typeof sessionSchema>;

// null means no session has been started in this process. Ended state remains visible.
export const sessionStateSchema = z.strictObject({ session: sessionSchema.nullable() });
export type SessionState = z.infer<typeof sessionStateSchema>;
export const sessionCommandSchema = z.strictObject({
  action: z.enum(['start', 'pause', 'resume', 'end', 'get']),
});
export type SessionAction = z.infer<typeof sessionCommandSchema>['action'];
