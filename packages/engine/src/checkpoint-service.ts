import {
  failure,
  checkpointSchema,
  checkpointCreateSchema,
  checkpointUpdateSchema,
  capturedVersionSummarySchema,
  activityEventSchema,
  idSchema,
  type ActivityEvent,
  type CapturedVersionSummary,
  type Checkpoint,
  type CheckpointCreate,
  type CheckpointUpdate,
  type CheckpointView,
  type CheckpointRepository,
  type SessionRepository,
  type Result,
} from "@rewind/contracts";

export interface CheckpointServiceOptions {
  newId(): string;
  now(): string;
  sessions: Pick<SessionRepository, "get">;
  checkpoints: Pick<CheckpointRepository, "get" | "save">;
  readVersion(id: string): Promise<Result<CapturedVersionSummary>>;
  readActivity(id: string): Promise<Result<ActivityEvent | null>>;
  admit(): Promise<Result<void>>;
}
/** Names and pins real immutable evidence; does not invent or restore application state. */
export class CheckpointService {
  constructor(private readonly options: CheckpointServiceOptions) {}
  private async evidence(
    checkpoint: Checkpoint,
    creating = false,
  ): Promise<Result<CheckpointView>> {
    if (
      checkpoint.fileVersionIds.length > 100 ||
      checkpoint.activityIds.length > 200
    )
      return failure(
        "UNAVAILABLE",
        "This legacy checkpoint exceeds the supported evidence-view bounds.",
      );
    const versions: CapturedVersionSummary[] = [],
      activities: ActivityEvent[] = [];
    let totalBytes = 0;
    for (const id of checkpoint.fileVersionIds) {
      const result = await this.options.readVersion(id);
      if (!result.ok) return result;
      const parsed = capturedVersionSummarySchema.safeParse(result.value);
      if (!parsed.success || parsed.data.version.id !== id)
        return failure(
          "INTEGRITY_FAILURE",
          "Checkpoint version identity is invalid.",
        );
      if (
        parsed.data.version.sessionId !== checkpoint.sessionId ||
        parsed.data.version.capturedAt > checkpoint.createdAt
      )
        return failure(
          creating ? "FORBIDDEN" : "INTEGRITY_FAILURE",
          "Checkpoint file evidence does not match its session and creation time.",
        );
      totalBytes += parsed.data.version.byteLength;
      if (totalBytes > 64 * 1024 ** 2)
        return failure(
          "INVALID_INPUT",
          "Select at most 64 MiB of original file bytes per checkpoint.",
        );
      versions.push(parsed.data);
    }
    for (const id of checkpoint.activityIds) {
      const result = await this.options.readActivity(id);
      if (!result.ok) return result;
      if (!result.value)
        return failure("NOT_FOUND", "Selected activity is no longer retained.");
      const parsed = activityEventSchema.safeParse(result.value);
      if (!parsed.success || parsed.data.id !== id)
        return failure(
          "INTEGRITY_FAILURE",
          "Checkpoint activity identity is invalid.",
        );
      if (
        parsed.data.sessionId !== checkpoint.sessionId ||
        parsed.data.occurredAt > checkpoint.createdAt
      )
        return failure(
          creating ? "FORBIDDEN" : "INTEGRITY_FAILURE",
          "Checkpoint activity evidence does not match its session and creation time.",
        );
      if (parsed.data.type === "browser-visit") {
        // Checkpoint views expose visit metadata. Article text has a separate permission/retrieval boundary.
        const payload = { ...parsed.data.payload };
        delete payload.articleText;
        activities.push({ ...parsed.data, payload });
      } else activities.push(parsed.data);
    }
    // Legacy visit references must also be actual selected browser events, never arbitrary IDs.
    if (
      checkpoint.browserVisitIds.some(
        (id) =>
          !activities.some(
            (event) => event.id === id && event.type === "browser-visit",
          ),
      )
    )
      return failure(
        "INTEGRITY_FAILURE",
        "Checkpoint browser evidence is unavailable or inconsistent.",
      );
    const value = { checkpoint, versions, activities };
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      1024 * 1024
    )
      return failure(
        "INVALID_INPUT",
        "The selected checkpoint metadata exceeds the supported 1 MiB view budget. Select fewer activities.",
      );
    return { ok: true, value };
  }
  async create(input: CheckpointCreate): Promise<Result<Checkpoint>> {
    const parsed = checkpointCreateSchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_INPUT",
        "Name the checkpoint and select actual evidence from one session.",
      );
    const value = parsed.data,
      session = await this.options.sessions.get(value.sessionId);
    if (!session.ok) return session;
    if (!session.value)
      return failure("NOT_FOUND", "The selected session is unavailable.");
    const candidate = checkpointSchema.parse({
      ...value,
      id: this.options.newId(),
      createdAt: this.options.now(),
      browserVisitIds: [],
      projectReferences: [],
    });
    if (candidate.createdAt < session.value.startedAt)
      return failure(
        "CONFLICT",
        "The system clock precedes the selected session.",
      );
    const checked = await this.evidence(candidate, true);
    if (!checked.ok) return checked;
    candidate.browserVisitIds = checked.value.activities
      .filter((event) => event.type === "browser-visit")
      .map((event) => event.id);
    const admitted = await this.options.admit();
    if (!admitted.ok) return admitted;
    const saved = await this.options.checkpoints.save(candidate);
    return saved.ok ? { ok: true, value: candidate } : saved;
  }
  async view(id: string): Promise<Result<CheckpointView>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "A checkpoint ID is required.");
    const stored = await this.options.checkpoints.get(id);
    if (!stored.ok) return stored;
    if (!stored.value)
      return failure("NOT_FOUND", "This checkpoint is no longer retained.");
    const parsed = checkpointSchema.safeParse(stored.value);
    if (!parsed.success || parsed.data.id !== id)
      return failure(
        "INTEGRITY_FAILURE",
        "Stored checkpoint identity is invalid.",
      );
    return this.evidence(parsed.data);
  }
  async update(input: CheckpointUpdate): Promise<Result<Checkpoint>> {
    const parsed = checkpointUpdateSchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_INPUT",
        "A checkpoint name and explicit Keep choice are required.",
      );
    const stored = await this.options.checkpoints.get(parsed.data.id);
    if (!stored.ok) return stored;
    if (!stored.value)
      return failure("NOT_FOUND", "This checkpoint is no longer retained.");
    const checkpoint = checkpointSchema.safeParse({
      ...stored.value,
      name: parsed.data.name,
      kept: parsed.data.kept,
    });
    if (!checkpoint.success || checkpoint.data.id !== parsed.data.id)
      return failure(
        "INTEGRITY_FAILURE",
        "Stored checkpoint identity is invalid.",
      );
    if (parsed.data.kept) {
      const checked = await this.evidence(checkpoint.data);
      if (!checked.ok) return checked;
      const admitted = await this.options.admit();
      if (!admitted.ok) return admitted;
    }
    const saved = await this.options.checkpoints.save(checkpoint.data);
    return saved.ok ? { ok: true, value: checkpoint.data } : saved;
  }
}
