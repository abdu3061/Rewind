import {
  activityEventSchema,
  assistantApprovedRequestSchema,
  assistantEvidenceSchema,
  assistantReviewApprovalSchema,
  assistantReviewPreparationSchema,
  assistantReviewSchema,
  browserExclusionsSchema,
  fileReferenceSchema,
  timestampSchema,
  failure,
  sanitizeBrowserMetadataUrl,
  type AssistantApprovedRequest,
  type AssistantEvidence,
  type AssistantEvidenceSource,
  type AssistantReview,
  type AssistantReviewApproval,
  type Result,
  type UserSettings,
} from "@rewind/contracts";
import { isExcluded, isExcludedPath } from "./event-exclusions";

export interface AssistantDisclosureLease {
  request: AssistantApprovedRequest;
  expiresAt: string;
  current(): boolean;
  verify(evidence: readonly AssistantEvidence[]): Promise<Result<void>>;
  finish(): void;
}
export interface AssistantReviewOptions {
  newId(): string;
  now(): string;
  monotonicNow?(): number;
  /** An immutable launch/permission epoch in composition must also be checked here. */
  permitted(): boolean;
  settings(): UserSettings;
  read(id: string): Promise<Result<AssistantEvidenceSource | null>>;
  /** Additional secret/content denial only, never a substitute for source and privacy verification. */
  disclosable(evidence: AssistantEvidence): Result<void>;
}
interface Plan {
  review: AssistantReview;
  ids: Map<string, string>;
  policy: string;
  revision: number;
  monotonicExpires: number;
  monotonicCreated: number;
}
const unavailable = () =>
  failure(
    "FORBIDDEN",
    "Cloud approval or evidence authorization changed. Prepare a new review.",
  );
const clip = (value: string, limit: number) => {
  let result = value.slice(0, limit);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  return result;
};
/** Engine-owned local review and disclosure lease. IDs, not renderer-provided text, select real saved evidence. */
export class AssistantReviewService {
  private revision = 0;
  private closed = false;
  private preparing = false;
  private readonly plans = new Map<string, Plan>();
  constructor(private readonly options: AssistantReviewOptions) {}
  private ticks() {
    return this.options.monotonicNow?.() ?? performance.now();
  }
  private policy(): string {
    const s = this.options.settings();
    return JSON.stringify({
      cloud: s.cloudAiEnabled,
      retention: s.retentionHours,
      apps: s.excludedApplications,
      sites: s.excludedSiteHosts,
      folders: s.excludedFolderPaths,
    });
  }
  private permitted() {
    return (
      !this.closed &&
      this.options.permitted() &&
      this.options.settings().cloudAiEnabled &&
      browserExclusionsSchema.safeParse(
        this.options.settings().excludedSiteHosts,
      ).success
    );
  }
  invalidate(): void {
    this.revision++;
    this.plans.clear();
  }
  close(): void {
    this.closed = true;
    this.invalidate();
  }
  cancel(id: string): Result<true> {
    if (!assistantReviewSchema.shape.id.safeParse(id).success)
      return failure("INVALID_INPUT", "An assistant review ID is required.");
    this.plans.delete(id);
    return { ok: true, value: true };
  }
  private current(plan: Plan): boolean {
    return (
      this.permitted() &&
      this.revision === plan.revision &&
      this.policy() === plan.policy &&
      this.options.now() < plan.review.expiresAt &&
      this.ticks() < plan.monotonicExpires
    );
  }
  private async evidence(
    id: string,
    key: string,
  ): Promise<
    Result<{
      record: AssistantEvidence;
      expiresAt: number;
      expiresTick: number;
    }>
  > {
    if (!this.permitted()) return unavailable();
    const read = await this.options.read(id);
    if (!this.permitted()) return unavailable();
    if (!read.ok)
      return failure(
        read.error.code,
        "Saved evidence could not be verified under current privacy and retention policy.",
      );
    if (!read.value)
      return failure(
        "NOT_FOUND",
        "The selected saved evidence is no longer retained.",
      );
    const source = read.value,
      parsed = activityEventSchema.safeParse(source.event);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      typeof source.kept !== "boolean" ||
      !timestampSchema.safeParse(source.retentionAnchor).success ||
      source.retentionAnchor < parsed.data.occurredAt
    )
      return failure(
        "INTEGRITY_FAILURE",
        "The selected source identity or retention protection is invalid.",
      );
    const event = parsed.data,
      settings = this.options.settings();
    if (isExcluded(event, settings)) return unavailable();
    let title: string,
      excerpt: string,
      evidence: AssistantEvidence["evidence"] = "recorded";
    switch (event.type) {
      case "foreground":
        title = event.payload.windowTitle || event.payload.application;
        excerpt = `Application: ${event.payload.application}. Observed window title: ${event.payload.windowTitle}. This title does not prove a file path or document reading.`;
        evidence = "title-only";
        break;
      case "browser-visit": {
        const url = sanitizeBrowserMetadataUrl(
          event.payload.url,
          settings.excludedSiteHosts,
        );
        if (!url) return unavailable();
        title = event.payload.title || url;
        excerpt = `Browser: ${event.payload.browser}. Recorded URL: ${url}. Recorded page title: ${event.payload.title}. No page text or duration is provided.`;
        break;
      }
      case "file-change": {
        const file = fileReferenceSchema.safeParse(source.file);
        if (!file.success || file.data.id !== event.payload.fileId)
          return failure(
            "INTEGRITY_FAILURE",
            "The saved file observation reference could not be verified.",
          );
        if (
          file.data.identity.kind !== "verified-path" &&
          settings.excludedFolderPaths.length
        )
          return unavailable();
        if (
          file.data.identity.kind === "verified-path" &&
          isExcludedPath(
            file.data.identity.absolutePath,
            settings.excludedFolderPaths,
          )
        )
          return unavailable();
        title = event.payload.displayName ?? file.data.displayName;
        excerpt = `Recorded saved-file observation: ${event.payload.change}. File name: ${title}. This does not prove reading or unsaved application state. No file contents or full path are shared.`;
        break;
      }
      case "file-opened":
        if (
          event.payload.identity.kind === "unverified" &&
          settings.excludedFolderPaths.length
        )
          return unavailable();
        title = event.payload.displayName;
        excerpt =
          "Recorded Rewind file-open observation. No file contents or full path are shared.";
        evidence =
          event.payload.identity.kind === "unverified"
            ? "title-only"
            : "recorded";
        break;
      case "capture-gap":
        title = "Capture gap";
        excerpt = `Recorded capture gap: ${event.payload.collectorId}; ${event.payload.reason}. There is no activity evidence for the gap.`;
        break;
      default:
        return failure(
          "FORBIDDEN",
          "This source type is unavailable for cloud evidence review.",
        );
    }
    const record = assistantEvidenceSchema.parse({
      key,
      source: { kind: "activity", activityId: id },
      occurredAt: event.occurredAt,
      title: clip(title, 300),
      excerpt: clip(excerpt, 800),
      evidence,
    });
    const allowed = this.options.disclosable(structuredClone(record));
    if (!allowed.ok)
      return failure(
        allowed.error.code,
        "The selected observation contains information that cannot be shared with the assistant.",
      );
    const expiresAt = source.kept
      ? Infinity
      : Date.parse(source.retentionAnchor) +
        settings.retentionHours * 3600000 +
        1;
    if (expiresAt <= Date.parse(this.options.now()))
      return failure("NOT_FOUND", "The selected saved evidence has expired.");
    return {
      ok: true,
      value: {
        record,
        expiresAt,
        expiresTick:
          this.ticks() +
          Math.max(0, expiresAt - Date.parse(this.options.now())),
      },
    };
  }
  async prepare(input: {
    question: string;
    activityIds: string[];
  }): Promise<Result<AssistantReview>> {
    const parsed = assistantReviewPreparationSchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_INPUT",
        "Choose a bounded question and one to twelve distinct saved observations.",
      );
    if (!this.permitted()) return unavailable();
    if (this.preparing)
      return failure(
        "CONFLICT",
        "An evidence review is already being prepared.",
      );
    for (const [id, plan] of this.plans)
      if (!this.current(plan)) this.plans.delete(id);
    if (this.plans.size >= 8)
      return failure(
        "CONFLICT",
        "Cancel an outstanding evidence review first.",
      );
    this.preparing = true;
    const revision = this.revision,
      policy = this.policy(),
      ids = new Map<string, string>(),
      records: AssistantEvidence[] = [];
    const createdAt = this.options.now(),
      started = this.ticks();
    let expiresAt = Date.parse(createdAt) + 300000,
      monotonicExpires = started + 300000;
    try {
      for (const [index, id] of parsed.data.activityIds.entries()) {
        if (
          !this.permitted() ||
          revision !== this.revision ||
          policy !== this.policy()
        )
          return unavailable();
        const key = `E${index + 1}`,
          item = await this.evidence(id, key);
        if (!item.ok) return item;
        expiresAt = Math.min(expiresAt, item.value.expiresAt);
        monotonicExpires = Math.min(
          monotonicExpires,
          item.value.expiresTick,
          started + Math.max(0, item.value.expiresAt - Date.parse(createdAt)),
        );
        records.push(item.value.record);
        ids.set(key, id);
      }
      monotonicExpires = Math.min(
        monotonicExpires,
        this.ticks() + Math.max(0, expiresAt - Date.parse(this.options.now())),
      );
      const review = assistantReviewSchema.parse({
        id: this.options.newId(),
        createdAt,
        expiresAt: new Date(expiresAt).toISOString(),
        question: parsed.data.question,
        evidence: records,
      });
      const request = assistantApprovedRequestSchema.safeParse({
        id: review.id,
        question: review.question,
        evidence: records,
        confirmed: true,
      });
      if (!request.success)
        return failure(
          "STORAGE_LIMIT",
          "Selected evidence exceeds the cloud review payload budget. Select fewer observations.",
        );
      const plan = {
        review,
        ids,
        policy,
        revision,
        monotonicExpires,
        monotonicCreated: started,
      };
      if (!this.current(plan)) return unavailable();
      if (this.plans.has(review.id))
        return failure("CONFLICT", "A unique review could not be created.");
      this.plans.set(review.id, plan);
      return { ok: true, value: structuredClone(review) };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "The local evidence review could not be verified.",
      );
    } finally {
      this.preparing = false;
    }
  }
  async claim(
    input: AssistantReviewApproval,
  ): Promise<Result<AssistantDisclosureLease>> {
    const parsed = assistantReviewApprovalSchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_INPUT",
        "Explicitly confirm the reviewed question and selected evidence keys.",
      );
    const plan = this.plans.get(parsed.data.id);
    this.plans.delete(parsed.data.id);
    if (!plan || !this.current(plan)) return unavailable();
    const selected = plan.review.evidence.filter((record) =>
      parsed.data.keys.includes(record.key),
    );
    if (selected.length !== parsed.data.keys.length)
      return failure(
        "INVALID_INPUT",
        "Only evidence shown in this review can be approved.",
      );
    let finished = false;
    const current = () => {
      if (finished) return false;
      if (!this.current(plan)) {
        finished = true;
        return false;
      }
      return true;
    };
    const checkEvidence = async (
      evidence: readonly AssistantEvidence[],
    ): Promise<Result<void>> => {
      if (!current()) return unavailable();
      if (!evidence.length || evidence.length > selected.length)
        return failure(
          "FORBIDDEN",
          "Only the selected reviewed evidence can be verified.",
        );
      const keys = new Set<string>();
      for (const candidate of evidence) {
        if (!current()) return unavailable();
        const snapshot = selected.find(
            (record) => record.key === candidate.key,
          ),
          parsedRecord = assistantEvidenceSchema.safeParse(candidate);
        if (
          !snapshot ||
          !parsedRecord.success ||
          keys.has(candidate.key) ||
          JSON.stringify(parsedRecord.data) !== JSON.stringify(snapshot)
        )
          return failure(
            "FORBIDDEN",
            "Evidence was not part of the approved immutable review.",
          );
        keys.add(candidate.key);
        const id = plan.ids.get(candidate.key);
        if (!id) return unavailable();
        const read = await this.evidence(id, candidate.key);
        if (!read.ok) return read;
        if (JSON.stringify(read.value.record) !== JSON.stringify(snapshot))
          return unavailable();
        plan.monotonicExpires = Math.min(
          plan.monotonicExpires,
          read.value.expiresTick,
          plan.monotonicCreated +
            Math.max(
              0,
              read.value.expiresAt - Date.parse(plan.review.createdAt),
            ),
        );
        if (read.value.expiresAt <= Date.parse(this.options.now()))
          return unavailable();
      }
      return current() ? { ok: true, value: undefined } : unavailable();
    };
    const verify = async (
      evidence: readonly AssistantEvidence[],
    ): Promise<Result<void>> => {
      try {
        const result = await checkEvidence(evidence);
        if (!result.ok) finished = true;
        return result;
      } catch {
        finished = true;
        return failure(
          "INTEGRITY_FAILURE",
          "Approved evidence could not be reverified.",
        );
      }
    };
    try {
      const verified = await verify(selected);
      if (!verified.ok) return verified;
      return {
        ok: true,
        value: {
          expiresAt: plan.review.expiresAt,
          request: assistantApprovedRequestSchema.parse({
            id: plan.review.id,
            question: plan.review.question,
            evidence: structuredClone(selected),
            confirmed: true,
          }),
          current,
          verify,
          finish: () => {
            finished = true;
          },
        },
      };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Approved evidence could not be reverified.",
      );
    }
  }
}
