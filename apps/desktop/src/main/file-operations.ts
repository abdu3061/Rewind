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
  getSettings: () => UserSettings;
  changeSettings: (
    settings: UserSettings,
    write?: () => Promise<Result<void>>,
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
  constructor(private readonly options: Options) {}
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
            protectedFolderIds: [
              ...listed.value.map((value) => value.id),
              folder.id,
            ],
          },
          () => storage.snapshots.saveFolder(folder),
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
          const changed = await this.options.changeSettings({
            ...this.options.getSettings(),
            folderCollectionConsent: true,
            protectedFolderIds: available.value.map((folder) => folder.id),
          });
          if (!changed.ok) return changed;
        } else {
          const changed = await this.options.changeSettings({
            ...this.options.getSettings(),
            folderCollectionConsent: false,
          });
          if (!changed.ok) return changed;
        }
        return this.state();
      }
      case "files.remove": {
        const changed = await this.options.changeSettings(
          {
            ...this.options.getSettings(),
            folderCollectionConsent: false,
            protectedFolderIds: this.options
              .getSettings()
              .protectedFolderIds.filter((id) => id !== command.id),
          },
          () => storage.snapshots.removeFolder(command.id),
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
            results.push({ version, displayName: file.value.displayName });
          }
          return { ok: true, value: results };
        });
      case "versions.info":
        return coordinator.read(async () => {
          const cleaned = await storage.cleanup();
          return cleaned.ok ? storage.snapshots.info(command.id) : cleaned;
        });
      case "versions.preview":
        return coordinator.read(async (): Promise<Result<VersionPreview>> => {
          const cleaned = await storage.cleanup();
          if (!cleaned.ok) return cleaned;
          const read = await storage.snapshots.read(command.id);
          if (!read.ok) return read;
          try {
            const file = await storage.repositories.files.getReference(
              read.value.version.fileId,
            );
            if (!file.ok || !file.value)
              return failure(
                "INTEGRITY_FAILURE",
                "Captured version identity is unavailable.",
              );
            const { version, bytes } = read.value;
            const textType =
              version.mediaType.startsWith("text/") ||
              version.mediaType === "application/json";
            let text: string | null = null;
            if (textType) {
              try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(
                  bytes.subarray(0, 65532),
                  { stream: bytes.byteLength > 65532 },
                );
              } catch {
                /* Original bytes remain recoverable; no fabricated extraction. */
              }
            }
            return {
              ok: true,
              value: {
                version,
                displayName: file.value.displayName,
                text,
                truncated: text !== null && bytes.byteLength > 65532,
                warning:
                  text === null
                    ? "Original bytes are captured and verified. Document rendering is not available for this format."
                    : null,
              },
            };
          } finally {
            read.value.bytes.fill(0);
          }
        });
      default:
        return failure(
          "INVALID_INPUT",
          "A file capability command is required.",
        );
    }
  }
}
