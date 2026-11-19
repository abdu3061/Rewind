import {
  failure,
  fileTextControlResponseSchema,
  fileTextSearchResponseSchema,
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
  versionSourceResponseSchema,
  versionInfoResponseSchema,
  protectedFolderSchema,
  recoveryCopyProposalResponseSchema,
  recoveryCopyResultResponseSchema,
  recoveryCancelResponseSchema,
  checkpointResponseSchema,
  checkpointListResponseSchema,
  checkpointViewResponseSchema,
  checkpointDeleteResponseSchema,
  browserControlResponseSchema,
  acknowledgementResponseSchema,
  recoveryOverwriteProposalResponseSchema,
  recoveryOverwriteResultResponseSchema,
  assistantControlResponseSchema,
  assistantReviewResponseSchema,
  assistantAnswerResponseSchema,
  type AssistantControlState,
} from "@rewind/contracts";
import type { WorkerClient } from "./worker-client";
export async function dispatchRecordingRequest(
  backend: WorkerClient,
  input: unknown,
  chooseFolder?: () => Promise<string | null>,
  chooseCopy?: (sourceName: string) => Promise<string | null>,
  openBrowserFolder?: () => Promise<Result<true>>,
  chooseOverwrite?: () => Promise<string | null>,
  configureAssistant?: () => Promise<Result<AssistantControlState | null>>,
): Promise<Result<unknown>> {
  const parsed = recordingCommandSchema.safeParse(input);
  if (!parsed.success)
    return failure("INVALID_INPUT", "A valid recording command is required.");
  const command = parsed.data;
  switch (command.kind) {
    case "content.state":
    case "content.index":
    case "content.stop":
      return backend.request(command, fileTextControlResponseSchema);
    case "content.search":
      return backend.request(command, fileTextSearchResponseSchema);
    case "content.clear-search":
      return backend.request(command, acknowledgementResponseSchema);
    case "assistant.configure":
      return configureAssistant
        ? configureAssistant()
        : failure(
            "UNAVAILABLE",
            "Native credential configuration is unavailable.",
          );
    case "assistant.state":
    case "assistant.permission":
    case "assistant.forget":
      return backend.request(command, assistantControlResponseSchema);
    case "assistant.prepare":
      return backend.request(command, assistantReviewResponseSchema);
    case "assistant.ask":
      return backend.request(command, assistantAnswerResponseSchema);
    case "assistant.cancel":
    case "assistant.stop":
      return backend.request(command, acknowledgementResponseSchema);
    case "browser.open-extension": {
      if (!openBrowserFolder)
        return failure("UNAVAILABLE", "The extension folder is unavailable.");
      const verified = await backend.request(
        { kind: "browser.verify-assets" },
        acknowledgementResponseSchema,
      );
      return verified.ok ? openBrowserFolder() : verified;
    }
    case "browser.state":
    case "browser.install":
    case "browser.remove":
    case "browser.repair":
    case "browser.permission":
    case "browser.exclusions":
      return backend.request(command, browserControlResponseSchema);
    case "checkpoints.create":
    case "checkpoints.update":
      return backend.request(command, checkpointResponseSchema);
    case "checkpoints.list":
      return backend.request(command, checkpointListResponseSchema);
    case "checkpoints.view":
      return backend.request(command, checkpointViewResponseSchema);
    case "checkpoints.delete":
      return backend.request(command, checkpointDeleteResponseSchema);
    case "recovery.choose-overwrite":
    case "recovery.choose-copy": {
      const overwrite = command.kind === "recovery.choose-overwrite";
      if (overwrite ? !chooseOverwrite : !chooseCopy)
        return failure(
          "UNAVAILABLE",
          "The recovery destination dialog is unavailable.",
        );
      const source = await backend.request(
        { kind: "versions.source", id: command.versionId },
        versionSourceResponseSchema,
      );
      if (!source.ok) return source;
      const selected = overwrite
        ? await chooseOverwrite!()
        : await chooseCopy!(source.value.displayName);
      if (selected && (selected.length < 4 || selected.length > 240))
        return failure(
          "INVALID_INPUT",
          "Choose a local destination with a path of at most 240 characters.",
        );
      if (!selected) return { ok: true, value: null };
      if (overwrite)
        return backend.request(
          {
            kind: "recovery.prepare-overwrite",
            versionId: command.versionId,
            path: selected,
          },
          recoveryOverwriteProposalResponseSchema,
        );
      return backend.request(
        {
          kind: "recovery.prepare-copy",
          versionId: command.versionId,
          path: selected,
        },
        recoveryCopyProposalResponseSchema,
      );
    }
    case "recovery.confirm-copy":
      return backend.request(command, recoveryCopyResultResponseSchema);
    case "recovery.confirm-overwrite":
      return backend.request(command, recoveryOverwriteResultResponseSchema);
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
    case "versions.cancel-preview":
      return backend.request(command, acknowledgementResponseSchema);
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
