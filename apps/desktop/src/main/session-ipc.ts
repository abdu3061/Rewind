import { failure, sessionCommandSchema, type Result, type SessionState } from '@rewind/contracts';
import type { SessionService } from '@rewind/engine';

export function dispatchSessionRequest(
  service: SessionService,
  input: unknown,
): Result<SessionState> {
  const parsed = sessionCommandSchema.safeParse(input);
  if (!parsed.success) return failure('INVALID_INPUT', 'A valid session command is required.');
  return service.execute(parsed.data.action);
}

export function isTrustedRendererUrl(candidate: string, expected: string): boolean {
  try {
    const actual = new URL(candidate);
    const trusted = new URL(expected);
    return (
      actual.protocol === trusted.protocol &&
      actual.host === trusted.host &&
      actual.pathname === trusted.pathname &&
      !actual.username &&
      !actual.password
    );
  } catch {
    return false;
  }
}
