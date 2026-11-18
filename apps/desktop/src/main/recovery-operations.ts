import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  failure,
  type Result,
  type WorkerCommand,
  type AppError,
} from "@rewind/contracts";
import {
  RecoveryCopyService,
  RecoveryOverwriteService,
  type RecoveryCopyServiceOptions,
  type SessionCoordinator,
} from "@rewind/engine";
import {
  WindowsProtectedFileAccess,
  WindowsRecoveryCopyWriter,
  WindowsRecoveryOverwriteWriter,
} from "@rewind/collectors";
import type { SecureStorage } from "@rewind/storage";

const inside = (root: string, selected: string) => {
  const relative = path.relative(
    path.resolve(root).toLowerCase(),
    path.resolve(selected).toLowerCase(),
  );
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
/** Native-dialog path policy and encrypted source composition live in the utility process. */
export class RecoveryOperations {
  private readonly service: RecoveryCopyService;
  private readonly overwrite: RecoveryOverwriteService;
  constructor(options: {
    storage: SecureStorage;
    coordinator: SessionCoordinator;
    root: string;
    synthetic: boolean;
    storageError(error: AppError): void;
  }) {
    const shared: Omit<RecoveryCopyServiceOptions, "writer"> = {
      newId: randomUUID,
      now: () => new Date().toISOString(),
      readSnapshot: async (id) => {
        const result = await options.coordinator.read(async () => {
          const cleaned = await options.storage.cleanup();
          if (!cleaned.ok) return cleaned;
          const source = await options.storage.snapshots.read(id);
          if (!source.ok) return source;
          const file = await options.storage.repositories.files.getReference(
            source.value.version.fileId,
          );
          if (!file.ok || !file.value) {
            source.value.bytes.fill(0);
            return file.ok
              ? failure(
                  "INTEGRITY_FAILURE",
                  "The captured file identity is unavailable.",
                )
              : file;
          }
          return {
            ok: true as const,
            value: {
              ...source.value,
              sourceLabel:
                file.value.identity.kind === "verified-path"
                  ? file.value.identity.absolutePath
                  : file.value.displayName,
            },
          };
        });
        if (!result.ok) options.storageError(result.error);
        return result;
      },
      validateDestination: async (selected) => {
        if (inside(options.root, selected) || inside(selected, options.root))
          return failure(
            "FORBIDDEN",
            "Recovery cannot write inside Rewind's private storage.",
          );
        if (options.synthetic) {
          if (!inside(path.dirname(options.root), selected))
            return failure(
              "FORBIDDEN",
              "Synthetic recovery is confined to its isolated profile.",
            );
        } else {
          const denied = [
            process.env.APPDATA,
            process.env.LOCALAPPDATA,
            process.env.WINDIR,
            process.env.ProgramFiles,
            process.env["ProgramFiles(x86)"],
          ].filter((value): value is string => Boolean(value));
          if (denied.some((root) => inside(root, selected)))
            return failure(
              "FORBIDDEN",
              "Choose a document or project destination outside application profiles and system directories.",
            );
        }
        const access = new WindowsProtectedFileAccess();
        let proof: Awaited<
          ReturnType<WindowsProtectedFileAccess["validateFolder"]>
        >;
        let closed: Result<void>;
        try {
          proof = await access.validateFolder(path.dirname(selected));
        } finally {
          closed = await access.close();
        }
        if (!closed.ok) return closed;
        if (!proof.ok) return proof;
        return {
          ok: true,
          value: {
            directory: proof.value,
            name: path.basename(selected),
            label: path.join(proof.value.absolutePath, path.basename(selected)),
          },
        };
      },
    };
    this.service = new RecoveryCopyService({
      ...shared,
      writer: new WindowsRecoveryCopyWriter(),
    });
    this.overwrite = new RecoveryOverwriteService({
      ...shared,
      writer: new WindowsRecoveryOverwriteWriter(),
    });
  }
  execute(command: WorkerCommand): Promise<Result<unknown>> {
    switch (command.kind) {
      case "recovery.prepare-copy":
        return this.service.prepare(command.versionId, command.path);
      case "recovery.confirm-copy":
        return this.service.confirm(command.proposalId, command.confirmed);
      case "recovery.prepare-overwrite":
        return this.overwrite.prepare(command.versionId, command.path);
      case "recovery.confirm-overwrite":
        return this.overwrite.confirm(command.proposalId, command.confirmed);
      case "recovery.cancel":
        return Promise.resolve(
          this.service.cancel(command.proposalId).ok
            ? this.overwrite.cancel(command.proposalId)
            : failure("INVALID_INPUT", "A recovery proposal ID is required."),
        );
      default:
        return Promise.resolve(
          failure(
            "INVALID_INPUT",
            "Choose a recovery destination through the desktop dialog.",
          ),
        );
    }
  }
  async close(): Promise<Result<void>> {
    const results = await Promise.all([
      this.service.close(),
      this.overwrite.close(),
    ]);
    return (
      results.find((result) => !result.ok) ?? { ok: true, value: undefined }
    );
  }
}
