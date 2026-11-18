import {
  acknowledgementResponseSchema,
  assistantControlResponseSchema,
  assistantCredentialChallengeResponseSchema,
  assistantSealedCredentialSchema,
  failure,
  type AssistantControlState,
  type Result,
} from "@rewind/contracts";
import type { WorkerClient } from "./worker-client";
import type { NativeCredentialPrompt } from "./native-credential-prompt";

/** Main-owned orchestration. Only public challenges and sealed packets cross this process. */
export class AssistantConfiguration {
  private busy = false;
  constructor(
    private readonly backend: Pick<WorkerClient, "request">,
    private readonly native: Pick<NativeCredentialPrompt, "prompt" | "close">,
  ) {}
  async configure(): Promise<Result<AssistantControlState | null>> {
    if (this.busy)
      return failure(
        "CONFLICT",
        "Native credential configuration is already in progress.",
      );
    this.busy = true;
    let id: string | null = null;
    let result: Result<AssistantControlState | null>;
    try {
      const prepared = await this.backend.request(
        { kind: "assistant.credential.prepare", confirmed: true },
        assistantCredentialChallengeResponseSchema,
      );
      if (!prepared.ok) return prepared;
      id = prepared.value.id;
      const entered = await this.native.prompt(prepared.value);
      if (!entered.ok) result = entered;
      else if (!entered.value) result = { ok: true, value: null };
      else {
        const sealed = assistantSealedCredentialSchema.safeParse(entered.value);
        result =
          sealed.success && sealed.data.id === id
            ? await this.backend.request(
                {
                  kind: "assistant.credential.accept",
                  value: sealed.data,
                  confirmed: true,
                },
                assistantControlResponseSchema,
              )
            : failure(
                "INTEGRITY_FAILURE",
                "Native credential confirmation did not match its review.",
              );
      }
    } catch {
      result = failure(
        "UNAVAILABLE",
        "Native credential configuration could not be confirmed.",
      );
    } finally {
      try {
        if (id) {
          const cancelled = await this.backend.request(
            { kind: "assistant.credential.cancel", id },
            acknowledgementResponseSchema,
          );
          if (!cancelled.ok) result = cancelled;
        }
      } catch {
        result = failure(
          "UNAVAILABLE",
          "Credential review closure could not be verified.",
        );
      }
      this.busy = false;
    }
    return result;
  }
  close(): Promise<Result<void>> {
    return this.native.close();
  }
}
