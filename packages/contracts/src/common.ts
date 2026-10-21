import { z } from 'zod';

export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime({ offset: false, precision: 3 });
export type Id = z.infer<typeof idSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;

export const errorCodeSchema = z.enum([
  'INVALID_INPUT',
  'INVALID_TRANSITION',
  'FORBIDDEN',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'UNAVAILABLE',
  'INTEGRITY_FAILURE',
  'CONFLICT',
  'INTERNAL',
]);
export const appErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1).max(500),
});
export type AppError = z.infer<typeof appErrorSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export const resultSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: appErrorSchema }),
  ]);

export function failure(code: AppError['code'], message: string): { ok: false; error: AppError } {
  return { ok: false, error: { code, message } };
}
