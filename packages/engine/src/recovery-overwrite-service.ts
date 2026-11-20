import {
  failure,
  fileVersionSchema,
  idSchema,
  recoveryFileEvidenceSchema,
  recoveryOverwriteProposalSchema,
  type RecoveryOverwriteProposal,
  type RecoveryOverwriteResult,
  type RecoveryOverwriteTarget,
  type RecoveryOverwriteWriter,
  type Result,
} from "@rewind/contracts";
import type { RecoveryCopyServiceOptions } from "./recovery-copy-service";

export interface RecoveryOverwriteServiceOptions extends Pick<
  RecoveryCopyServiceOptions,
  "newId" | "now" | "monotonicNow" | "readSnapshot" | "validateDestination"
> {
  writer: RecoveryOverwriteWriter;
}
interface Plan {
  proposal: RecoveryOverwriteProposal;
  target: RecoveryOverwriteTarget;
  backupName: string;
  monotonicExpires: number;
}
/** User-reviewed, expiring and single-use authority. Native preservation is a prerequisite to mutation. */
export class RecoveryOverwriteService {
  private readonly plans = new Map<string, Plan>();
  private pending: Promise<unknown> | null = null;
  private closing = false;
  constructor(private readonly options: RecoveryOverwriteServiceOptions) {}
  private ticks() {
    return this.options.monotonicNow?.() ?? performance.now();
  }
  private expired(plan: Plan) {
    return (
      plan.proposal.expiresAt <= this.options.now() ||
      plan.monotonicExpires <= this.ticks()
    );
  }
  private run<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.closing)
      return Promise.resolve(
        failure("UNAVAILABLE", "Recovery is shutting down."),
      );
    if (this.pending)
      return Promise.resolve(
        failure("CONFLICT", "Another overwrite operation is in progress."),
      );
    const pending = Promise.resolve()
      .then(work)
      .catch(() =>
        failure(
          "UNAVAILABLE",
          "Overwrite could not be confirmed. Inspect the reviewed target and preservation filename before retrying.",
        ),
      );
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    return pending;
  }
  prepare(
    versionId: string,
    destination: string,
  ): Promise<Result<RecoveryOverwriteProposal>> {
    return this.run(async () => {
      if (
        !idSchema.safeParse(versionId).success ||
        !destination ||
        destination.length > 240
      )
        return failure(
          "INVALID_INPUT",
          "Choose a retained version and existing target through the desktop dialog.",
        );
      for (const [id, plan] of this.plans)
        if (this.expired(plan)) this.plans.delete(id);
      if (this.plans.size >= 8)
        return failure(
          "CONFLICT",
          "Cancel an outstanding recovery proposal first.",
        );
      const source = await this.options.readSnapshot(versionId);
      if (!source.ok) return source;
      try {
        const version = fileVersionSchema.safeParse(source.value.version);
        if (
          !version.success ||
          version.data.id !== versionId ||
          version.data.byteLength !== source.value.bytes.byteLength
        )
          return failure(
            "INTEGRITY_FAILURE",
            "The retained source could not be verified.",
          );
        const selected = await this.options.validateDestination(destination);
        if (!selected.ok) return selected;
        const inspected = await this.options.writer.inspect(
          selected.value.directory,
          selected.value.name,
        );
        if (!inspected.ok) return inspected;
        if (!recoveryFileEvidenceSchema.safeParse(inspected.value).success)
          return failure(
            "INTEGRITY_FAILURE",
            "The current target evidence could not be verified.",
          );
        if (this.closing)
          return failure("UNAVAILABLE", "Recovery is shutting down.");
        const id = this.options.newId(),
          backupName = `Rewind-preserved-${id}.bak`;
        if (!idSchema.safeParse(id).success || this.plans.has(id))
          return failure(
            "CONFLICT",
            "A unique recovery proposal could not be created.",
          );
        const preservationLabel =
          selected.value.directory.absolutePath + "\\" + backupName;
        if (preservationLabel.length > 240)
          return failure(
            "INVALID_INPUT",
            "The target folder is too deep for a bounded preservation filename. Use recovery to a separate copy instead.",
          );
        const proposal = recoveryOverwriteProposalSchema.parse({
          id,
          fileVersionId: versionId,
          fileId: version.data.fileId,
          createdAt: this.options.now(),
          expiresAt: new Date(
            Date.parse(this.options.now()) + 5 * 60_000,
          ).toISOString(),
          mode: "overwrite",
          destinationLabel: selected.value.label,
          requiresConfirmation: true,
          requiresCurrentFilePreservation: true,
          sourceLabel: source.value.sourceLabel,
          capturedAt: version.data.capturedAt,
          contentHash: version.data.contentHash,
          byteLength: version.data.byteLength,
          currentContentHash: inspected.value.contentHash,
          currentByteLength: inspected.value.byteLength,
          preservationLabel,
        });
        this.plans.set(id, {
          proposal,
          target: {
            directory: { ...selected.value.directory },
            name: selected.value.name,
            evidence: { ...inspected.value },
          },
          backupName,
          monotonicExpires: this.ticks() + 5 * 60_000,
        });
        return { ok: true, value: structuredClone(proposal) };
      } finally {
        source.value.bytes.fill(0);
      }
    });
  }
  confirm(
    proposalId: string,
    confirmed: true,
  ): Promise<Result<RecoveryOverwriteResult>> {
    return this.run(async () => {
      if (confirmed !== true || !idSchema.safeParse(proposalId).success)
        return failure(
          "INVALID_INPUT",
          "Explicit overwrite confirmation is required.",
        );
      const plan = this.plans.get(proposalId);
      this.plans.delete(proposalId);
      if (!plan || this.expired(plan))
        return failure(
          "CONFLICT",
          "This recovery proposal expired, was cancelled or has already been used.",
        );
      const source = await this.options.readSnapshot(
        plan.proposal.fileVersionId,
      );
      if (!source.ok) return source;
      try {
        const { version, bytes } = source.value;
        if (
          !fileVersionSchema.safeParse(version).success ||
          version.id !== plan.proposal.fileVersionId ||
          version.fileId !== plan.proposal.fileId ||
          version.contentHash !== plan.proposal.contentHash ||
          version.byteLength !== plan.proposal.byteLength ||
          bytes.byteLength !== version.byteLength
        )
          return failure(
            "INTEGRITY_FAILURE",
            "The retained source changed or could not be verified. No overwrite was attempted.",
          );
        if (this.expired(plan) || this.closing)
          return failure(
            "CONFLICT",
            "Recovery expired or stopped while verifying its source. No overwrite was attempted.",
          );
        const written = await this.options.writer.overwrite(
          plan.target,
          plan.backupName,
          bytes,
          version.contentHash,
        );
        if (!written.ok) return written;
        const { target, preserved } = written.value;
        if (
          !recoveryFileEvidenceSchema.safeParse(target).success ||
          !recoveryFileEvidenceSchema.safeParse(preserved).success ||
          target.contentHash !== version.contentHash ||
          target.byteLength !== bytes.byteLength ||
          target.osIdentity !== plan.target.evidence.osIdentity ||
          preserved.contentHash !== plan.target.evidence.contentHash ||
          preserved.byteLength !== plan.target.evidence.byteLength ||
          preserved.osIdentity === target.osIdentity
        )
          return failure(
            "INTEGRITY_FAILURE",
            "Recovery output or preservation could not be verified. Inspect both reviewed filenames.",
          );
        return {
          ok: true,
          value: {
            proposalId,
            fileVersionId: version.id,
            recoveredAt: this.options.now(),
            mode: "overwrite",
            destinationLabel: plan.proposal.destinationLabel,
            preservationLabel: plan.proposal.preservationLabel,
            contentHash: target.contentHash,
            byteLength: target.byteLength,
            preservedContentHash: preserved.contentHash,
            preservedByteLength: preserved.byteLength,
          },
        };
      } finally {
        source.value.bytes.fill(0);
      }
    });
  }
  cancel(proposalId: string): Result<true> {
    if (!idSchema.safeParse(proposalId).success)
      return failure("INVALID_INPUT", "A recovery proposal ID is required.");
    this.plans.delete(proposalId);
    return { ok: true, value: true };
  }
  async close(): Promise<Result<void>> {
    this.closing = true;
    this.plans.clear();
    const closed = await this.options.writer.close();
    if (!closed.ok) return closed;
    await this.pending;
    return { ok: true, value: undefined };
  }
}
