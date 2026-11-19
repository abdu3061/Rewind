import { contextBridge, ipcRenderer } from "electron";
import {
  failure,
  PRESENTATION_CHANNEL,
  PRESENTATION_CHANGED_CHANNEL,
  presentationCommandSchema,
  presentationStateSchema,
  presentationResponseSchema,
  fileTextCommandSchema,
  fileTextControlResponseSchema,
  fileTextSearchResponseSchema,
  noArgumentsSchema,
  SESSION_CHANNEL,
  SESSION_CHANGED_CHANNEL,
  sessionResponseSchema,
  sessionStateSchema,
  type DesktopApi,
  type Result,
  type SessionAction,
  type SessionState,
  ACTIVITY_CHANGED_CHANNEL,
  RECORDING_CHANNEL,
  RUNTIME_CHANGED_CHANNEL,
  collectionPreferencesSchema,
  historyQuerySchema,
  historyResponseSchema,
  idSchema,
  preferencesResponseSchema,
  runtimeResponseSchema,
  runtimeSnapshotSchema,
  timelineQuerySchema,
  timelineResponseSchema,
  storageUsageResponseSchema,
  storagePreferencesSchema,
  deleteHistorySchema,
  fileProtectionResponseSchema,
  folderSelectionResponseSchema,
  versionListQuerySchema,
  versionListResponseSchema,
  versionPreviewResponseSchema,
  versionInfoResponseSchema,
  recoveryCopyProposalResponseSchema,
  recoveryCopyResultResponseSchema,
  recoveryCancelResponseSchema,
  checkpointCreateSchema,
  checkpointUpdateSchema,
  checkpointListQuerySchema,
  checkpointResponseSchema,
  checkpointListResponseSchema,
  checkpointViewResponseSchema,
  checkpointDeleteResponseSchema,
  browserCommandSchema,
  browserControlResponseSchema,
  acknowledgementResponseSchema,
  recoveryOverwriteProposalResponseSchema,
  recoveryOverwriteResultResponseSchema,
  assistantCommandSchema,
  assistantConfigureResponseSchema,
  assistantControlResponseSchema,
  assistantReviewResponseSchema,
  assistantAnswerResponseSchema,
} from "@rewind/contracts";

interface Decoder<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: Result<T> } | { success: false };
}
async function recording<T>(
  command: unknown,
  decoder: Decoder<T>,
): Promise<Result<T>> {
  try {
    const parsed = decoder.safeParse(
      await ipcRenderer.invoke(RECORDING_CHANNEL, command),
    );
    return parsed.success
      ? parsed.data
      : failure(
          "INTERNAL",
          "The recording service returned an invalid response.",
        );
  } catch {
    return failure("UNAVAILABLE", "The recording service is unavailable.");
  }
}
function noArgs<T>(command: unknown, decoder: Decoder<T>) {
  return (...args: unknown[]): Promise<Result<T>> =>
    noArgumentsSchema.safeParse(args).success
      ? recording(command, decoder)
      : Promise.resolve(
          failure("INVALID_INPUT", "This method accepts no arguments."),
        );
}

function command(action: SessionAction) {
  return async (...args: unknown[]): Promise<Result<SessionState>> => {
    if (!noArgumentsSchema.safeParse(args).success)
      return failure("INVALID_INPUT", "This method accepts no arguments.");
    try {
      const parsed = sessionResponseSchema.safeParse(
        await ipcRenderer.invoke(SESSION_CHANNEL, { action }),
      );
      return parsed.success
        ? parsed.data
        : failure("INTERNAL", "The desktop returned an invalid response.");
    } catch {
      return failure("UNAVAILABLE", "The desktop service is unavailable.");
    }
  };
}

function assistantArgument<T>(
  kind: string,
  field: "confirmed" | "enabled" | "value" | "id",
  decoder: Decoder<T>,
) {
  return (...args: unknown[]): Promise<Result<T>> => {
    const parsed = assistantCommandSchema.safeParse({ kind, [field]: args[0] });
    return args.length === 1 && parsed.success
      ? recording(parsed.data, decoder)
      : Promise.resolve(
          failure(
            "INVALID_INPUT",
            "A valid assistant capability argument is required.",
          ),
        );
  };
}
const api: DesktopApi = {
  presentation: {
    send: async (...args: unknown[]) => {
      const parsed = presentationCommandSchema.safeParse(args[0]);
      if (args.length !== 1 || !parsed.success)
        return failure("INVALID_INPUT", "A valid window action is required.");
      try {
        const response = presentationResponseSchema.safeParse(
          await ipcRenderer.invoke(PRESENTATION_CHANNEL, parsed.data),
        );
        return response.success
          ? response.data
          : failure("INTERNAL", "The window response is invalid.");
      } catch {
        return failure("UNAVAILABLE", "The window service is unavailable.");
      }
    },
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = presentationStateSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(PRESENTATION_CHANGED_CHANNEL, handler);
      return () =>
        ipcRenderer.removeListener(PRESENTATION_CHANGED_CHANNEL, handler);
    },
  },
  content: {
    state: noArgs({ kind: "content.state" }, fileTextControlResponseSchema),
    stop: noArgs({ kind: "content.stop" }, fileTextControlResponseSchema),
    clearSearch: noArgs(
      { kind: "content.clear-search" },
      acknowledgementResponseSchema,
    ),
    indexSaved: (...args: unknown[]) => {
      const parsed = fileTextCommandSchema.safeParse({
        kind: "content.index",
        value: args[0],
      });
      return args.length === 1 && parsed.success
        ? recording(parsed.data, fileTextControlResponseSchema)
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "Explicit saved-content indexing approval is required.",
            ),
          );
    },
    search: (...args: unknown[]) => {
      const parsed = fileTextCommandSchema.safeParse({
        kind: "content.search",
        query: args[0],
      });
      return args.length === 1 && parsed.success
        ? recording(parsed.data, fileTextSearchResponseSchema)
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "A valid captured-content query is required.",
            ),
          );
    },
  },
  assistant: {
    state: noArgs({ kind: "assistant.state" }, assistantControlResponseSchema),
    configure: assistantArgument(
      "assistant.configure",
      "confirmed",
      assistantConfigureResponseSchema,
    ),
    permission: assistantArgument(
      "assistant.permission",
      "enabled",
      assistantControlResponseSchema,
    ),
    forget: assistantArgument(
      "assistant.forget",
      "confirmed",
      assistantControlResponseSchema,
    ),
    prepare: assistantArgument(
      "assistant.prepare",
      "value",
      assistantReviewResponseSchema,
    ),
    ask: assistantArgument(
      "assistant.ask",
      "value",
      assistantAnswerResponseSchema,
    ),
    cancel: assistantArgument(
      "assistant.cancel",
      "id",
      acknowledgementResponseSchema,
    ),
    stop: noArgs({ kind: "assistant.stop" }, acknowledgementResponseSchema),
  },
  browser: {
    openExtensionFolder: noArgs(
      { kind: "browser.open-extension" },
      acknowledgementResponseSchema,
    ),
    state: noArgs({ kind: "browser.state" }, browserControlResponseSchema),
    install(...args: unknown[]) {
      const parsed = browserCommandSchema.safeParse({
        kind: "browser.install",
        browsers: args[0],
        confirmed: args[1],
      });
      return args.length === 2 && parsed.success
        ? recording(parsed.data, browserControlResponseSchema)
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "Choose browsers and explicitly confirm setup.",
            ),
          );
    },
    remove(...args: unknown[]) {
      const parsed = browserCommandSchema.safeParse({
        kind: "browser.remove",
        browser: args[0],
        confirmed: args[1],
      });
      return args.length === 2 && parsed.success
        ? recording(parsed.data, browserControlResponseSchema)
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "Choose a browser and explicitly confirm removal.",
            ),
          );
    },
    repair(...args: unknown[]) {
      const parsed = browserCommandSchema.safeParse({
        kind: "browser.repair",
        confirmed: args[0],
      });
      return args.length === 1 && parsed.success
        ? recording(parsed.data, browserControlResponseSchema)
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "Explicitly confirm browser setup repair.",
            ),
          );
    },
    permission(...args: unknown[]) {
      const parsed = browserCommandSchema.safeParse({
        kind: "browser.permission",
        enabled: args[0],
      });
      return args.length === 1 && parsed.success
        ? recording(parsed.data, browserControlResponseSchema)
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "Choose whether to allow browser recording.",
            ),
          );
    },
    exclusions(...args: unknown[]) {
      const parsed = browserCommandSchema.safeParse({
        kind: "browser.exclusions",
        hosts: args[0],
      });
      return args.length === 1 && parsed.success
        ? recording(parsed.data, browserControlResponseSchema)
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "Enter at most 200 valid site host exclusions.",
            ),
          );
    },
  },
  checkpoints: {
    create(...args: unknown[]) {
      const parsed = checkpointCreateSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "checkpoints.create", value: parsed.data },
            checkpointResponseSchema,
          )
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "A named selection of captured evidence is required.",
            ),
          );
    },
    list(...args: unknown[]) {
      const parsed = checkpointListQuerySchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "checkpoints.list", query: parsed.data },
            checkpointListResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A bounded checkpoint query is required."),
          );
    },
    view(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "checkpoints.view", id: parsed.data },
            checkpointViewResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A checkpoint ID is required."),
          );
    },
    update(...args: unknown[]) {
      const parsed = checkpointUpdateSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "checkpoints.update", value: parsed.data },
            checkpointResponseSchema,
          )
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "A checkpoint name and explicit Keep choice are required.",
            ),
          );
    },
    delete(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 2 && parsed.success && args[1] === true
        ? recording(
            { kind: "checkpoints.delete", id: parsed.data, confirmed: true },
            checkpointDeleteResponseSchema,
          )
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "Explicit checkpoint deletion confirmation is required.",
            ),
          );
    },
  },
  recovery: {
    chooseOverwrite(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "recovery.choose-overwrite", versionId: parsed.data },
            recoveryOverwriteProposalResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A captured version ID is required."),
          );
    },
    confirmOverwrite(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 2 && parsed.success && args[1] === true
        ? recording(
            {
              kind: "recovery.confirm-overwrite",
              proposalId: parsed.data,
              confirmed: true,
            },
            recoveryOverwriteResultResponseSchema,
          )
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "An explicit overwrite confirmation is required.",
            ),
          );
    },
    chooseCopy(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "recovery.choose-copy", versionId: parsed.data },
            recoveryCopyProposalResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A captured version ID is required."),
          );
    },
    confirmCopy(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 2 && parsed.success && args[1] === true
        ? recording(
            {
              kind: "recovery.confirm-copy",
              proposalId: parsed.data,
              confirmed: true,
            },
            recoveryCopyResultResponseSchema,
          )
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "An explicit recovery confirmation is required.",
            ),
          );
    },
    cancel(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "recovery.cancel", proposalId: parsed.data },
            recoveryCancelResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A recovery proposal ID is required."),
          );
    },
  },
  files: {
    state: noArgs({ kind: "files.state" }, fileProtectionResponseSchema),
    selectFolder: noArgs(
      { kind: "files.select" },
      folderSelectionResponseSchema,
    ),
    permission(...args: unknown[]) {
      return args.length === 1 && typeof args[0] === "boolean"
        ? recording(
            { kind: "files.permission", enabled: args[0] },
            fileProtectionResponseSchema,
          )
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "An explicit file permission choice is required.",
            ),
          );
    },
    removeFolder(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "files.remove", id: parsed.data },
            fileProtectionResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A selected folder ID is required."),
          );
    },
  },
  versions: {
    info(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "versions.info", id: parsed.data },
            versionInfoResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A captured version ID is required."),
          );
    },
    list(...args: unknown[]) {
      const parsed = versionListQuerySchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "versions.list", query: parsed.data },
            versionListResponseSchema,
          )
        : Promise.resolve(
            failure(
              "INVALID_INPUT",
              "A valid captured-version query is required.",
            ),
          );
    },
    preview(...args: unknown[]) {
      const parsed = idSchema.safeParse(args[0]);
      const requestId = args.length === 2 ? idSchema.safeParse(args[1]) : null;
      return (args.length === 1 || (args.length === 2 && requestId?.success)) &&
        parsed.success
        ? recording(
            {
              kind: "versions.preview",
              id: parsed.data,
              ...(requestId?.success ? { requestId: requestId.data } : {}),
            },
            versionPreviewResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A captured version ID is required."),
          );
    },
    cancelPreview(...args: unknown[]) {
      const requestId = idSchema.safeParse(args[0]);
      return args.length === 1 && requestId.success
        ? recording(
            { kind: "versions.cancel-preview", requestId: requestId.data },
            acknowledgementResponseSchema,
          )
        : Promise.resolve(
            failure("INVALID_INPUT", "A preview request ID is required."),
          );
    },
  },
  storage: {
    usage: noArgs({ kind: "storage.usage" }, storageUsageResponseSchema),
    cleanup: noArgs({ kind: "storage.cleanup" }, storageUsageResponseSchema),
    async update(...args: unknown[]) {
      const parsed = storagePreferencesSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "storage.update", value: parsed.data },
            storageUsageResponseSchema,
          )
        : failure("INVALID_INPUT", "Valid storage settings are required.");
    },
    async deleteHistory(...args: unknown[]) {
      const parsed = deleteHistorySchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "storage.delete", value: parsed.data },
            storageUsageResponseSchema,
          )
        : failure("INVALID_INPUT", "Confirmed history deletion is required.");
    },
  },
  runtime: {
    get: noArgs({ kind: "runtime.get" }, runtimeResponseSchema),
    retry: noArgs({ kind: "runtime.retry" }, runtimeResponseSchema),
    onChanged(listener) {
      if (typeof listener !== "function")
        throw new TypeError("A runtime listener is required.");
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = runtimeSnapshotSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(RUNTIME_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(RUNTIME_CHANGED_CHANNEL, handler);
    },
  },
  privacy: {
    get: noArgs({ kind: "privacy.get" }, preferencesResponseSchema),
    async update(...args: unknown[]) {
      const parsed = collectionPreferencesSchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "privacy.update", value: parsed.data },
            preferencesResponseSchema,
          )
        : failure(
            "INVALID_INPUT",
            "Valid collection preferences are required.",
          );
    },
  },
  timeline: {
    async query(...args: unknown[]) {
      const parsed = timelineQuerySchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "timeline.query", query: parsed.data },
            timelineResponseSchema,
          )
        : failure("INVALID_INPUT", "A valid timeline query is required.");
    },
    onChanged(listener) {
      if (typeof listener !== "function")
        throw new TypeError("An activity listener is required.");
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = idSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(ACTIVITY_CHANGED_CHANNEL, handler);
      return () =>
        ipcRenderer.removeListener(ACTIVITY_CHANGED_CHANNEL, handler);
    },
  },
  history: {
    async list(...args: unknown[]) {
      const parsed = historyQuerySchema.safeParse(args[0]);
      return args.length === 1 && parsed.success
        ? recording(
            { kind: "history.list", query: parsed.data },
            historyResponseSchema,
          )
        : failure("INVALID_INPUT", "A valid history query is required.");
    },
  },
  sessions: {
    get: command("get"),
    start: command("start"),
    pause: command("pause"),
    resume: command("resume"),
    end: command("end"),
    onChanged(listener) {
      if (typeof listener !== "function")
        throw new TypeError("A session listener is required.");
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = sessionStateSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(SESSION_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(SESSION_CHANGED_CHANNEL, handler);
    },
  },
};
const exposed = process.argv.includes("--rewind-surface=notch")
  ? {
      presentation: api.presentation,
      sessions: api.sessions,
      runtime: { get: api.runtime.get, onChanged: api.runtime.onChanged },
      timeline: api.timeline,
      versions: { list: api.versions.list },
      checkpoints: { create: api.checkpoints.create },
    }
  : api;
contextBridge.exposeInMainWorld("rewind", exposed);
