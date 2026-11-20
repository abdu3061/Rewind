import { randomUUID } from "node:crypto";
import { failure, type WorkerCommand, type Result } from "@rewind/contracts";
import { CheckpointService, type SessionCoordinator } from "@rewind/engine";
import type { SecureStorage } from "@rewind/storage";

/** All checkpoint evidence checks and publication share the coordinator's serialized storage queue. */
export class CheckpointOperations {
  private readonly service: CheckpointService;
  constructor(
    private readonly storage: SecureStorage,
    private readonly coordinator: SessionCoordinator,
  ) {
    this.service = new CheckpointService({
      newId: randomUUID,
      now: () => new Date().toISOString(),
      sessions: storage.repositories.sessions,
      checkpoints: storage.checkpoints,
      readActivity: (id) => storage.evidence.get(id),
      readVersion: async (id) => {
        const captured = await storage.snapshots.read(id);
        if (!captured.ok) return captured;
        try {
          const file = await storage.repositories.files.getReference(
            captured.value.version.fileId,
          );
          if (!file.ok) return file;
          return file.value
            ? {
                ok: true,
                value: {
                  version: captured.value.version,
                  displayName: file.value.displayName,
                  sourceLabel:
                    file.value.identity.kind === "verified-path"
                      ? file.value.identity.absolutePath
                      : file.value.displayName,
                },
              }
            : failure(
                "INTEGRITY_FAILURE",
                "Captured file identity is unavailable.",
              );
        } finally {
          captured.value.bytes.fill(0);
        }
      },
      admit: async () => {
        const used = await storage.usage();
        if (!used.ok) return used;
        return used.value.totalBytes + 128 * 1024 <=
          used.value.preferences.storageLimitBytes
          ? { ok: true, value: undefined }
          : failure(
              "STORAGE_LIMIT",
              "Checkpoint metadata needs more storage headroom. Free history or increase the quota.",
            );
      },
    });
  }
  execute(command: WorkerCommand): Promise<Result<unknown>> {
    return this.coordinator.read<unknown>(async () => {
      const cleaned = await this.storage.cleanup();
      if (!cleaned.ok) return cleaned;
      switch (command.kind) {
        case "checkpoints.create":
          return this.service.create(command.value);
        case "checkpoints.view":
          return this.service.view(command.id);
        case "checkpoints.list":
          return this.storage.checkpoints.query(command.query);
        case "checkpoints.update":
          return this.service.update(command.value);
        case "checkpoints.delete": {
          const deleted = await this.storage.checkpoints.remove(command.id);
          if (!deleted.ok) return deleted;
          return { ok: true, value: true };
        }
        default:
          return failure(
            "INVALID_INPUT",
            "A checkpoint capability command is required.",
          );
      }
    });
  }
}
