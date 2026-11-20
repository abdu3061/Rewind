import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  failure,
  type CapturedVersionSummary,
  type FileProtectionState,
  type ProtectedFolder,
  type Result,
  type UserSettings,
  type VersionPreview,
  type WorkerCommand,
  type DocumentProcessor,
  type DocumentFormat,
  type DocumentText,
  type FileVersion,
  type FileReference,
  type DocumentAuthority,
  documentTextSchema,
} from "@rewind/contracts";
import type { SessionCoordinator } from "@rewind/engine";
import {
  WindowsProtectedFileAccess,
  type ProtectedFolderCollector,
} from "@rewind/collectors";
import type { SecureStorage } from "@rewind/storage";

interface Options {
  storage: SecureStorage;
  folders: ProtectedFolderCollector;
  coordinator: SessionCoordinator;
  root: string;
  synthetic: boolean;
  documents?: DocumentProcessor;
  authority: () => DocumentAuthority;
  getSettings: () => UserSettings;
  changeSettings: (
    settings: UserSettings,
    write?: () => Promise<Result<void>>,
    current?: () => boolean,
  ) => Promise<Result<void>>;
}
const inside = (root: string, selected: string) => {
  const relative = path.relative(
    path.resolve(root).toLowerCase(),
    path.resolve(selected).toLowerCase(),
  );
  return (
    !relative ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
/** Desktop utility composition for selected-folder policy and read models. No renderer paths are accepted. */
export class FileOperations {
  private retainedPreview: { versionId: string; requestId: string } | null =
    null;
  private unconfirmedPreview: { requestId: string; owner: AbortSignal } | null =
    null;
  private preview: {
    controller: AbortController;
    versionId: string;
    requestId: string;
    done: Promise<void>;
  } | null = null;
  constructor(private readonly options: Options) {}
  get previewActive(): boolean {
    return this.preview !== null;
  }
  invalidatePreviews(): void {
    this.preview?.controller.abort();
    this.retainedPreview = null;
  }
  referencesRemoved(retainsVersion: (id: string) => boolean): boolean {
    return Boolean(
      (this.preview &&
        !this.preview.controller.signal.aborted &&
        !retainsVersion(this.preview.versionId)) ||
      (this.retainedPreview && !retainsVersion(this.retainedPreview.versionId)),
    );
  }
  async stopPreviews(): Promise<boolean> {
    this.invalidatePreviews();
    const stopped = (await this.options.documents?.stop()) ?? true;
    if (stopped) this.unconfirmedPreview = null;
    return stopped;
  }
  private async cancelPreview(requestId: string): Promise<Result<true>> {
    if (this.retainedPreview?.requestId === requestId)
      this.retainedPreview = null;
    const preview = this.preview?.requestId === requestId ? this.preview : null;
    const unconfirmed =
      this.unconfirmedPreview?.requestId === requestId
        ? this.unconfirmedPreview
        : null;
    if (!preview && !unconfirmed) return { ok: true, value: true };
    preview?.controller.abort();
    if (
      (await this.options.documents?.stop(
        preview?.controller.signal ?? unconfirmed!.owner,
      )) === false
    )
      return failure(
        "CONFLICT",
        "The preview process did not confirm cancellation. Try again.",
      );
    if (this.unconfirmedPreview?.requestId === requestId)
      this.unconfirmedPreview = null;
    if (!preview) return { ok: true, value: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([
        preview.done.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      return closed
        ? { ok: true, value: true }
        : failure(
            "CONFLICT",
            "The preview request is still closing. Try again.",
          );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private readSource(
    id: string,
  ): Promise<
    Result<{ version: FileVersion; file: FileReference; bytes: Uint8Array }>
  > {
    return this.options.coordinator.read(async () => {
      const cleaned = await this.options.storage.cleanup();
      if (!cleaned.ok) return cleaned;
      const source = await this.options.storage.snapshots.read(id);
      if (!source.ok) return source;
      let owned = true;
      try {
        const file = await this.options.storage.repositories.files.getReference(
          source.value.version.fileId,
        );
        if (!file.ok) return file;
        if (!file.value)
          return failure(
            "INTEGRITY_FAILURE",
            "Captured version identity is unavailable.",
          );
        owned = false;
        return { ok: true, value: { ...source.value, file: file.value } };
      } finally {
        if (owned) source.value.bytes.fill(0);
      }
    });
  }
  private async previewVersion(
    id: string,
    requestId: string = randomUUID(),
  ): Promise<Result<VersionPreview>> {
    if (this.preview) {
      if (this.preview.requestId === requestId)
        return failure("CONFLICT", "This preview request is already running.");
      const stopped = await this.cancelPreview(this.preview.requestId);
      if (!stopped.ok) return stopped;
      if (this.preview)
        return failure(
          "CONFLICT",
          "Another captured preview is still closing. Try again after it finishes.",
        );
    }
    const controller = new AbortController();
    this.retainedPreview = null;
    const authority = this.options.authority();
    let resolveDone!: () => void;
    const active = {
      controller,
      versionId: id,
      requestId,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
    };
    this.preview = active;
    const current = () => {
      const now = this.options.authority();
      return (
        this.preview === active &&
        !controller.signal.aborted &&
        now.generation === authority.generation &&
        now.revision === authority.revision
      );
    };
    let bytes: Uint8Array | null = null;
    try {
      const source = await this.readSource(id);
      if (!source.ok) return source;
      bytes = source.value.bytes;
      if (!current())
        return failure(
          "CONFLICT",
          "The captured preview was cancelled or its history changed.",
        );
      const { version } = source.value;
      const format: DocumentFormat | null =
        version.mediaType === "application/pdf"
          ? "pdf"
          : version.mediaType ===
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ? "docx"
            : null;
      let text: string | null = null,
        truncated = false,
        warning: string | null =
          "Original bytes are captured and verified. Document rendering is not available for this format.";
      if (format) {
        let document: DocumentText = {
          state: "unavailable",
          format,
          reason: "unavailable",
        };
        if (this.options.documents) {
          const closed = await this.options.documents.stop();
          if (closed) this.unconfirmedPreview = null;
          if (closed && current()) {
            try {
              const result = documentTextSchema.safeParse(
                await this.options.documents.extract(
                  format,
                  bytes,
                  controller.signal,
                ),
              );
              if (result.success && result.data.format === format)
                document = result.data;
            } catch {
              /* A parser failure does not make original captured bytes corrupt. */
            }
            if (this.options.documents.busy)
              this.unconfirmedPreview = { requestId, owner: controller.signal };
          }
        }
        if (document.state === "available") {
          text = document.text;
          truncated = document.truncated;
          warning =
            format === "docx"
              ? "Extracted DOCX body text. Formatting, headers, footers and images are omitted."
              : `Extracted PDF selectable text (${document.pagesRead} of ${document.totalPages} pages). Layout and reading order may differ; images and scanned text are omitted.`;
          if (!text)
            warning += " No selectable text was found; OCR is unavailable.";
        } else {
          const issues = {
            unsupported: "This document structure is unsupported.",
            malformed: "The captured document could not be parsed.",
            encrypted: "Password-protected documents are not previewed.",
            limit: "This document exceeds the preview limits.",
            cancelled: "Document preview was cancelled.",
            timeout: "Document preview timed out.",
            unavailable: "The document preview service is unavailable.",
          };
          warning = `${issues[document.reason]} Original bytes remain captured and verified.`;
        }
      } else if (
        version.mediaType.startsWith("text/") ||
        version.mediaType === "application/json"
      ) {
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, 65532),
            { stream: bytes.byteLength > 65532 },
          );
          truncated = bytes.byteLength > 65532;
          warning = null;
        } catch {
          /* No fabricated text for invalid UTF-8; original bytes remain recoverable. */
        }
      }
      if (!current())
        return failure(
          "CONFLICT",
          "The captured preview was cancelled or its history changed.",
        );
      // Parsing runs outside the coordinator. Re-enter its queue and reverify actual retained bytes.
      const fresh = await this.readSource(id);
      if (!fresh.ok) return fresh;
      try {
        if (!current())
          return failure(
            "CONFLICT",
            "The captured preview is no longer current.",
          );
        if (JSON.stringify(fresh.value.version) !== JSON.stringify(version))
          return failure(
            "INTEGRITY_FAILURE",
            "Captured version metadata changed during preview.",
          );
        const file = fresh.value.file;
        this.retainedPreview = { versionId: id, requestId };
        return {
          ok: true,
          value: {
            authority,
            version,
            displayName: file.displayName,
            sourceLabel:
              file.identity.kind === "verified-path"
                ? file.identity.absolutePath
                : file.displayName,
            text,
            truncated,
            warning,
          },
        };
      } finally {
        fresh.value.bytes.fill(0);
      }
    } finally {
      bytes?.fill(0);
      if (this.preview === active) this.preview = null;
      resolveDone();
    }
  }
  async state(): Promise<Result<FileProtectionState>> {
    return this.options.coordinator.read(async () => {
      const folders = await this.options.storage.snapshots.listFolders();
      return folders.ok
        ? {
            ok: true,
            value: {
              permission: this.options.getSettings().folderCollectionConsent,
              folders: folders.value,
              status: this.options.folders.status(),
            },
          }
        : folders;
    });
  }
  async execute(
    command: WorkerCommand,
    current: () => boolean,
  ): Promise<Result<unknown>> {
    const { storage, coordinator } = this.options;
    switch (command.kind) {
      case "files.state":
        return this.state();
      case "files.select":
        return failure(
          "INVALID_INPUT",
          "Folder selection belongs to the desktop dialog.",
        );
      case "files.add": {
        if (
          inside(command.path, this.options.root) ||
          inside(this.options.root, command.path)
        )
          return failure(
            "FORBIDDEN",
            "Rewind's private storage cannot be a protected folder or part of one.",
          );
        if (this.options.synthetic) {
          if (!inside(path.dirname(this.options.root), command.path))
            return failure(
              "FORBIDDEN",
              "Synthetic verification can only protect files inside its isolated profile.",
            );
        } else {
          const denied = [
            process.env.APPDATA,
            process.env.LOCALAPPDATA,
            process.env.WINDIR,
            process.env.ProgramFiles,
            process.env["ProgramFiles(x86)"],
          ].filter((root): root is string => Boolean(root));
          if (denied.some((root) => inside(root, command.path)))
            return failure(
              "FORBIDDEN",
              "Choose a project or document folder outside application profiles and Windows system folders.",
            );
        }
        const access = new WindowsProtectedFileAccess();
        let proof: Awaited<
          ReturnType<WindowsProtectedFileAccess["validateFolder"]>
        >;
        let closed: Result<void>;
        try {
          proof = await access.validateFolder(command.path);
        } finally {
          closed = await access.close();
        }
        if (!closed.ok) return closed;
        if (!proof.ok) return proof;
        const listed = await coordinator.read(() =>
          storage.snapshots.listFolders(),
        );
        if (!listed.ok) return listed;
        if (!current())
          return failure(
            "CONFLICT",
            "A newer privacy operation superseded folder selection.",
          );
        const duplicate = listed.value.find(
          (folder) =>
            folder.absolutePath.toLowerCase() ===
            proof.value.absolutePath.toLowerCase(),
        );
        if (duplicate) {
          if (duplicate.osIdentity !== proof.value.osIdentity)
            return failure(
              "CONFLICT",
              "This folder was replaced. Remove its old selection and choose it again.",
            );
          return { ok: true, value: duplicate };
        }
        if (listed.value.length >= 100)
          return failure(
            "INVALID_INPUT",
            "At most 100 folders can be selected.",
          );
        const folder: ProtectedFolder = {
          ...proof.value,
          id: randomUUID(),
          selectedAt: new Date().toISOString(),
        };
        const changed = await this.options.changeSettings(
          {
            ...this.options.getSettings(),
            folderCollectionConsent: false,
            automaticRecording: false,
            protectedFolderIds: [
              ...listed.value.map((value) => value.id),
              folder.id,
            ],
          },
          () => storage.snapshots.saveFolder(folder),
          current,
        );
        return changed.ok ? { ok: true, value: folder } : changed;
      }
      case "files.permission": {
        if (command.enabled) {
          const available = await coordinator.read(async () => {
            const cleaned = await storage.cleanup();
            if (!cleaned.ok) return cleaned;
            if (cleaned.value.overQuota)
              return failure(
                "UNAVAILABLE",
                "The storage quota prevents new file capture.",
              );
            return storage.snapshots.listFolders();
          });
          if (!available.ok) return available;
          if (!available.value.length)
            return failure(
              "INVALID_INPUT",
              "Select a folder before allowing file capture.",
            );
          if (!current())
            return failure(
              "CONFLICT",
              "A newer privacy operation superseded file approval.",
            );
          const changed = await this.options.changeSettings(
            {
              ...this.options.getSettings(),
              folderCollectionConsent: true,
              protectedFolderIds: available.value.map((folder) => folder.id),
            },
            undefined,
            current,
          );
          if (!changed.ok) return changed;
        } else {
          const changed = await this.options.changeSettings(
            {
              ...this.options.getSettings(),
              folderCollectionConsent: false,
              automaticRecording: false,
            },
            undefined,
            current,
          );
          if (!changed.ok) return changed;
        }
        return this.state();
      }
      case "files.remove": {
        const changed = await this.options.changeSettings(
          {
            ...this.options.getSettings(),
            folderCollectionConsent: false,
            automaticRecording: false,
            protectedFolderIds: this.options
              .getSettings()
              .protectedFolderIds.filter((id) => id !== command.id),
          },
          () => storage.snapshots.removeFolder(command.id),
          current,
        );
        return changed.ok ? this.state() : changed;
      }
      case "versions.list":
        return coordinator.read(async () => {
          const cleaned = await storage.cleanup();
          if (!cleaned.ok) return cleaned;
          const versions = await storage.snapshots.listVersions(command.query);
          if (!versions.ok) return versions;
          const results: CapturedVersionSummary[] = [];
          for (const version of versions.value) {
            const file = await storage.repositories.files.getReference(
              version.fileId,
            );
            if (!file.ok || !file.value)
              return failure(
                "INTEGRITY_FAILURE",
                "Captured version identity is unavailable.",
              );
            results.push({
              version,
              displayName: file.value.displayName,
              sourceLabel:
                file.value.identity.kind === "verified-path"
                  ? file.value.identity.absolutePath
                  : file.value.displayName,
            });
          }
          return { ok: true, value: results };
        });
      case "versions.info":
        return coordinator.read(async () => {
          const cleaned = await storage.cleanup();
          return cleaned.ok ? storage.snapshots.info(command.id) : cleaned;
        });
      case "versions.source":
        return coordinator.read(async () => {
          const cleaned = await storage.cleanup();
          if (!cleaned.ok) return cleaned;
          const version = await storage.snapshots.info(command.id);
          if (!version.ok) return version;
          if (!version.value)
            return failure(
              "NOT_FOUND",
              "The captured version is no longer retained.",
            );
          const file = await storage.repositories.files.getReference(
            version.value.fileId,
          );
          if (!file.ok) return file;
          if (!file.value)
            return failure(
              "INTEGRITY_FAILURE",
              "Captured version identity is unavailable.",
            );
          return {
            ok: true,
            value: {
              version: version.value,
              displayName: file.value.displayName,
              sourceLabel:
                file.value.identity.kind === "verified-path"
                  ? file.value.identity.absolutePath
                  : file.value.displayName,
            },
          };
        });
      case "versions.preview":
        return this.previewVersion(command.id, command.requestId);
      case "versions.cancel-preview":
        return this.cancelPreview(command.requestId);
      default:
        return failure(
          "INVALID_INPUT",
          "A file capability command is required.",
        );
    }
  }
}
