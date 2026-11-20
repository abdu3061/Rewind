import {
  failure,
  idSchema,
  fileVersionSchema,
  recoveryCopyProposalSchema,
  type FileVersion,
  type RecoveryCopyProposal,
  type RecoveryCopyResult,
  type RecoveryCopyWriter,
  type RecoveryDirectoryProof,
  type Result,
} from "@rewind/contracts";

export interface RecoveryCopyServiceOptions {
  newId(): string;
  now(): string;
  monotonicNow?(): number;
  readSnapshot(
    id: string,
  ): Promise<
    Result<{ version: FileVersion; bytes: Uint8Array; sourceLabel: string }>
  >;
  validateDestination(
    path: string,
  ): Promise<
    Result<{ directory: RecoveryDirectoryProof; name: string; label: string }>
  >;
  writer: RecoveryCopyWriter;
}
interface Plan {
  proposal: RecoveryCopyProposal;
  directory: RecoveryDirectoryProof;
  name: string;
  monotonicExpires: number;
}
/** Explicit, expiring, single-use copy authority. Source identities alone never authorize a write. */
export class RecoveryCopyService {
  private readonly plans = new Map<string, Plan>();
  private pending: Promise<unknown> | null = null;
  private closing = false;
  constructor(private readonly options: RecoveryCopyServiceOptions) {}
  private ticks(): number {
    return this.options.monotonicNow?.() ?? performance.now();
  }
  private expired(plan: Plan): boolean {
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
        failure("CONFLICT", "Another recovery operation is in progress."),
      );
    const result = Promise.resolve()
      .then(work)
      .catch(() =>
        failure(
          "UNAVAILABLE",
          "Recovery could not be confirmed. Check the selected destination before retrying.",
        ),
      );
    this.pending = result;
    void result.finally(() => {
      if (this.pending === result) this.pending = null;
    });
    return result;
  }
  prepare(
    versionId: string,
    destination: string,
  ): Promise<Result<RecoveryCopyProposal>> {
    return this.run(async () => {
      if (
        !idSchema.safeParse(versionId).success ||
        !destination ||
        destination.length > 240
      )
        return failure(
          "INVALID_INPUT",
          "Choose a retained version and a bounded destination.",
        );
      for (const [id, plan] of this.plans)
        if (this.expired(plan)) this.plans.delete(id);
      if (this.plans.size >= 8)
        return failure(
          "CONFLICT",
          "Cancel an outstanding recovery proposal before creating another.",
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
            "The captured source could not be verified.",
          );
        const target = await this.options.validateDestination(destination);
        if (!target.ok) return target;
        if (this.closing)
          return failure("UNAVAILABLE", "Recovery is shutting down.");
        const proposal = recoveryCopyProposalSchema.parse({
          id: this.options.newId(),
          fileVersionId: versionId,
          fileId: version.data.fileId,
          createdAt: this.options.now(),
          expiresAt: new Date(
            Date.parse(this.options.now()) + 5 * 60_000,
          ).toISOString(),
          mode: "save-copy",
          destinationLabel: target.value.label,
          requiresConfirmation: true,
          requiresCurrentFilePreservation: false,
          sourceLabel: source.value.sourceLabel,
          capturedAt: version.data.capturedAt,
          contentHash: version.data.contentHash,
          byteLength: version.data.byteLength,
        });
        this.plans.set(proposal.id, {
          proposal,
          directory: { ...target.value.directory },
          name: target.value.name,
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
  ): Promise<Result<RecoveryCopyResult>> {
    return this.run(async () => {
      if (confirmed !== true || !idSchema.safeParse(proposalId).success)
        return failure(
          "INVALID_INPUT",
          "An explicit recovery confirmation is required.",
        );
      const plan = this.plans.get(proposalId);
      this.plans.delete(proposalId); // Consume before any asynchronous preparation or write; retries require a new review.
      if (!plan || this.expired(plan))
        return failure(
          "CONFLICT",
          "This recovery proposal expired, was cancelled, or has already been used.",
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
            "The retained source changed or could not be verified. No copy was written.",
          );
        if (this.expired(plan))
          return failure(
            "CONFLICT",
            "This recovery proposal expired while verifying its source. No copy was written.",
          );
        if (this.closing)
          return failure("UNAVAILABLE", "Recovery is shutting down.");
        // The adapter revalidates the parent identity/ancestors and hashes the bytes before CREATE_NEW.
        const written = await this.options.writer.createCopy(
          plan.directory,
          plan.name,
          bytes,
          version.contentHash,
        );
        if (!written.ok) return written;
        if (
          written.value.contentHash !== version.contentHash ||
          written.value.byteLength !== bytes.byteLength ||
          !written.value.osIdentity
        )
          return failure(
            "INTEGRITY_FAILURE",
            "The output copy could not be verified. Check the chosen destination.",
          );
        return {
          ok: true,
          value: {
            proposalId,
            fileVersionId: version.id,
            recoveredAt: this.options.now(),
            mode: "save-copy",
            destinationLabel: plan.proposal.destinationLabel,
            contentHash: written.value.contentHash,
            byteLength: written.value.byteLength,
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
