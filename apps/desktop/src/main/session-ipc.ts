import {
  failure,
  sessionCommandSchema,
  sessionResponseSchema,
  type Result,
  type SessionAction,
  type SessionState,
} from "@rewind/contracts";
export interface SessionCommands {
  execute(
    action: SessionAction,
  ): Result<SessionState> | Promise<Result<SessionState>>;
}

export async function dispatchSessionRequest(
  service: SessionCommands,
  input: unknown,
): Promise<Result<SessionState>> {
  const parsed = sessionCommandSchema.safeParse(input);
  if (!parsed.success)
    return failure("INVALID_INPUT", "A valid session command is required.");
  try {
    const response = sessionResponseSchema.safeParse(
      await service.execute(parsed.data.action),
    );
    return response.success
      ? response.data
      : failure(
          "INTERNAL",
          "The session service returned an invalid response.",
        );
  } catch {
    return failure("UNAVAILABLE", "The session service is unavailable.");
  }
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
