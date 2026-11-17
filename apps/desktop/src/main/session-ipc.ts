import {
  failure,
  sessionCommandSchema,
  type Result,
  type SessionAction,
  type SessionState,
} from "@rewind/contracts";

export interface SessionExecutor {
  execute(
    action: SessionAction,
  ): Result<SessionState> | Promise<Result<SessionState>>;
}

export function dispatchSessionRequest(
  service: SessionExecutor,
  input: unknown,
): Result<SessionState> | Promise<Result<SessionState>> {
  const parsed = sessionCommandSchema.safeParse(input);
  if (!parsed.success)
    return failure("INVALID_INPUT", "A valid session command is required.");
  return service.execute(parsed.data.action);
}

export function isTrustedRendererUrl(
  candidate: string,
  expected: string,
): boolean {
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
