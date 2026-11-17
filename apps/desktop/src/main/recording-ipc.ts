import {
  failure,
  historyResponseSchema,
  preferencesResponseSchema,
  recordingCommandSchema,
  timelineResponseSchema,
  type Result,
  storageUsageResponseSchema,
  fileProtectionResponseSchema,
  folderSelectionResponseSchema,
  versionListResponseSchema,
  versionPreviewResponseSchema,
  versionInfoResponseSchema,
  protectedFolderSchema,
} from "@rewind/contracts";
import type { WorkerClient } from "./worker-client";
export async function dispatchRecordingRequest(
  backend: WorkerClient,
  input: unknown,
  chooseFolder?: () => Promise<string | null>,
): Promise<Result<unknown>> {
  const parsed = recordingCommandSchema.safeParse(input);
  if (!parsed.success)
    return failure("INVALID_INPUT", "A valid recording command is required.");
  const command = parsed.data;
  switch (command.kind) {
    case "files.select": {
      if (!chooseFolder)
        return failure("UNAVAILABLE", "Folder selection is unavailable.");
      const selected = await chooseFolder();
      if (
        selected &&
        !protectedFolderSchema.shape.absolutePath.safeParse(selected).success
      )
        return failure(
          "INVALID_INPUT",
          "Choose a local folder with a path of at most 240 characters.",
        );
      return selected
        ? backend.request(
            { kind: "files.add", path: selected },
            folderSelectionResponseSchema,
          )
        : { ok: true, value: null };
    }
    case "files.state":
    case "files.permission":
    case "files.remove":
      return backend.request(command, fileProtectionResponseSchema);
    case "versions.list":
      return backend.request(command, versionListResponseSchema);
    case "versions.preview":
      return backend.request(command, versionPreviewResponseSchema);
    case "versions.info":
      return backend.request(command, versionInfoResponseSchema);
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
