import {
  failure,
  historyResponseSchema,
  preferencesResponseSchema,
  recordingCommandSchema,
  timelineResponseSchema,
  type Result,
  storageUsageResponseSchema,
} from "@rewind/contracts";
import type { WorkerClient } from "./worker-client";
export async function dispatchRecordingRequest(
  backend: WorkerClient,
  input: unknown,
): Promise<Result<unknown>> {
  const parsed = recordingCommandSchema.safeParse(input);
  if (!parsed.success)
    return failure("INVALID_INPUT", "A valid recording command is required.");
  const command = parsed.data;
  switch (command.kind) {
    case "storage.usage":
    case "storage.update":
    case "storage.cleanup":
    case "storage.delete":
      return backend.request(command, storageUsageResponseSchema);
    case "runtime.get":
      return { ok: true, value: backend.getSnapshot() };
    case "runtime.retry":
      return backend.retry();
    case "privacy.get":
      return backend.request(
        { kind: "preferences.get" },
        preferencesResponseSchema,
      );
    case "privacy.update":
      return backend.request(
        { kind: "preferences.update", value: command.value },
        preferencesResponseSchema,
      );
    case "timeline.query":
      return backend.request(
        { kind: "timeline", query: command.query },
        timelineResponseSchema,
      );
    case "history.list":
      return backend.request(
        { kind: "history", query: command.query },
        historyResponseSchema,
      );
  }
}
