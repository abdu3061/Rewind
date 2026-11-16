import {
  failure,
  sessionSchema,
  sessionStateSchema,
  type Result,
  type Session,
  type SessionAction,
  type SessionState,
} from "@rewind/contracts";

export interface SessionEnvironment {
  newId(): string;
  now(): string;
}

export interface SessionTransition {
  readonly state: SessionState;
  commit(): Result<SessionState>;
}

/** In-memory lifecycle only. Starting a session never starts collectors in this milestone. */
export class SessionService {
  private session: Session | null = null;
  private revision = 0;

  constructor(private readonly environment: SessionEnvironment) {}

  getState(): SessionState {
    return { session: this.session ? { ...this.session } : null };
  }

  execute(action: SessionAction): Result<SessionState> {
    if (action === "get") return { ok: true, value: this.getState() };
    const prepared = this.prepare(action);
    return prepared.ok ? prepared.value.commit() : prepared;
  }

  /** Build a candidate without publishing it while asynchronous work is pending. */
  prepare(action: SessionAction): Result<SessionTransition> {
    const revision = this.revision;
    let candidate: Result<SessionState>;
    try {
      candidate = this.next(action);
    } catch {
      return failure("INTERNAL", "Unable to prepare the session transition.");
    }
    if (!candidate.ok) return candidate;
    if (!sessionStateSchema.safeParse(candidate.value).success)
      return failure("INTEGRITY_FAILURE", "The session transition is invalid.");
    const state = candidate.value;
    return {
      ok: true,
      value: {
        state: { session: state.session ? { ...state.session } : null },
        commit: () => {
          if (revision !== this.revision)
            return failure(
              "CONFLICT",
              "The session changed during transition.",
            );
          this.session = state.session ? { ...state.session } : null;
          this.revision++;
          return { ok: true, value: this.getState() };
        },
      },
    };
  }

  /** Startup hydration only; the coordinator validates and pauses interrupted work first. */
  restore(session: Session): Result<SessionState> {
    if (this.session)
      return failure("CONFLICT", "An existing session cannot be replaced.");
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success || parsed.data.status === "active")
      return failure(
        "INTEGRITY_FAILURE",
        "Only a valid stopped session can be restored.",
      );
    this.session = { ...parsed.data };
    this.revision++;
    return { ok: true, value: this.getState() };
  }

  private next(action: SessionAction): Result<SessionState> {
    if (action === "get") return { ok: true, value: this.getState() };

    if (action === "start") {
      if (this.session && this.session.status !== "ended") {
        return failure(
          "INVALID_TRANSITION",
          "End the current session before starting another.",
        );
      }
      const now = this.environment.now();
      const session: Session = {
        id: this.environment.newId(),
        status: "active",
        startedAt: now,
        updatedAt: now,
        endedAt: null,
      };
      if (session.id === this.session?.id)
        return failure(
          "CONFLICT",
          "A new session requires a distinct identity.",
        );
      return { ok: true, value: { session } };
    }

    const current = this.session;
    const valid =
      current &&
      ((action === "pause" && current.status === "active") ||
        (action === "resume" && current.status === "paused") ||
        (action === "end" && current.status !== "ended"));
    if (!current || !valid) {
      return failure(
        "INVALID_TRANSITION",
        `Cannot ${action} a ${current?.status ?? "missing"} session.`,
      );
    }

    // A wall-clock adjustment must not produce a state with decreasing timestamps.
    const now =
      [current.updatedAt, this.environment.now()].sort().at(-1) ??
      current.updatedAt;
    const session: Session = {
      ...current,
      status:
        action === "pause"
          ? "paused"
          : action === "resume"
            ? "active"
            : "ended",
      updatedAt: now,
      endedAt: action === "end" ? now : null,
    };
    return { ok: true, value: { session } };
  }
}
