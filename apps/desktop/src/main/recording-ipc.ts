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
  recoveryCopyProposalResponseSchema,
  recoveryCopyResultResponseSchema,
  recoveryCancelResponseSchema,
  checkpointResponseSchema,
  checkpointListResponseSchema,
  checkpointViewResponseSchema,
  checkpointDeleteResponseSchema,
} from "@rewind/contracts";
import type { WorkerClient } from "./worker-client";
export async function dispatchRecordingRequest(
  backend: WorkerClient,
  input: unknown,
  chooseFolder?: () => Promise<string | null>,
  chooseCopy?: (sourceName: string) => Promise<string | null>,
): Promise<Result<unknown>> {
  const parsed = recordingCommandSchema.safeParse(input);
  if (!parsed.success)
    return failure("INVALID_INPUT", "A valid recording command is required.");
  const command = parsed.data;
  switch (command.kind) {
    case "checkpoints.create":
    case "checkpoints.update":
      return backend.request(command, checkpointResponseSchema);
    case "checkpoints.list":
      return backend.request(command, checkpointListResponseSchema);
    case "checkpoints.view":
      return backend.request(command, checkpointViewResponseSchema);
    case "checkpoints.delete":
      return backend.request(command, checkpointDeleteResponseSchema);
    case "recovery.choose-copy": {
      if (!chooseCopy)
        return failure(
          "UNAVAILABLE",
          "The recovery destination dialog is unavailable.",
        );
      const source = await backend.request(
        { kind: "versions.preview", id: command.versionId },
        versionPreviewResponseSchema,
      );
      if (!source.ok) return source;
      const selected = await chooseCopy(source.value.displayName);
      if (selected && (selected.length < 4 || selected.length > 240))
        return failure(
          "INVALID_INPUT",
          "Choose a local destination with a path of at most 240 characters.",
        );
      return selected
        ? backend.request(
            {
              kind: "recovery.prepare-copy",
              versionId: command.versionId,
              path: selected,
            },
            recoveryCopyProposalResponseSchema,
          )
        : { ok: true, value: null };
    }
    case "recovery.confirm-copy":
      return backend.request(command, recoveryCopyResultResponseSchema);
    case "recovery.cancel":
      return backend.request(command, recoveryCancelResponseSchema);
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
