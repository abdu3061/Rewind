import {
  failure,
  type Result,
  type Session,
  type SessionAction,
  type SessionState,
} from '@rewind/contracts';

export interface SessionEnvironment {
  newId(): string;
  now(): string;
}

/** In-memory lifecycle only. Starting a session never starts collectors in this milestone. */
export class SessionService {
  private session: Session | null = null;

  constructor(private readonly environment: SessionEnvironment) {}

  getState(): SessionState {
    return { session: this.session ? { ...this.session } : null };
  }

  execute(action: SessionAction): Result<SessionState> {
    if (action === 'get') return { ok: true, value: this.getState() };

    if (action === 'start') {
      if (this.session && this.session.status !== 'ended') {
        return failure('INVALID_TRANSITION', 'End the current session before starting another.');
      }
      const now = this.environment.now();
      this.session = {
        id: this.environment.newId(),
        status: 'active',
        startedAt: now,
        updatedAt: now,
        endedAt: null,
      };
      return { ok: true, value: this.getState() };
    }

    const current = this.session;
    const valid =
      current &&
      ((action === 'pause' && current.status === 'active') ||
        (action === 'resume' && current.status === 'paused') ||
        (action === 'end' && current.status !== 'ended'));
    if (!current || !valid) {
      return failure(
        'INVALID_TRANSITION',
        `Cannot ${action} a ${current?.status ?? 'missing'} session.`,
      );
    }

    // A wall-clock adjustment must not produce a state with decreasing timestamps.
    const now = [current.updatedAt, this.environment.now()].sort().at(-1) ?? current.updatedAt;
    this.session = {
      ...current,
      status: action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'ended',
      updatedAt: now,
      endedAt: action === 'end' ? now : null,
    };
    return { ok: true, value: this.getState() };
  }
}
