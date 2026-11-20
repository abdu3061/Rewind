import { failure, type Result } from "@rewind/contracts";

/** A stuck native prompt must never prevent worker consent revocation/drain. */
export async function shutdownDesktop(ports: {
  closePrompt: () => Promise<Result<void>>;
  shutdownWorker: () => Promise<Result<void>>;
}): Promise<Result<void>> {
  const results = await Promise.allSettled([
    Promise.resolve().then(ports.closePrompt),
    Promise.resolve().then(ports.shutdownWorker),
  ]);
  return results.every(
    (result) => result.status === "fulfilled" && result.value.ok,
  )
    ? { ok: true, value: undefined }
    : failure(
        "UNAVAILABLE",
        "Background cleanup could not be verified. Retry Quit to finish safely.",
      );
}
