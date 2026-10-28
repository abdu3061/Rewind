import type { SessionState } from "@rewind/contracts";

type StateListener = (state: SessionState) => void;

class MockRewindBridge {
  private currentState: SessionState = { session: null };
  private listeners: Set<StateListener> = new Set();

  constructor() {
    const win = window as unknown as Record<string, unknown>;
    if (!win.rewind) {
      win.rewind = {
        sessions: {
          get: async () => ({ ok: true, data: this.currentState }),
          start: async () => this.updateStatus("active"),
          pause: async () => this.updateStatus("paused"),
          resume: async () => this.updateStatus("active"),
          stop: async () => this.updateStatus("ended"),
          onStateChange: (cb: StateListener) => {
            this.listeners.add(cb);
            cb(this.currentState);
            return () => this.listeners.delete(cb);
          },
        },
      };
    }
  }

  private updateStatus(status: "active" | "paused" | "ended") {
    const now = new Date().toISOString();
    this.currentState = {
      session: {
        id: this.currentState.session?.id ?? "mock-session-1",
        status,
        startedAt: this.currentState.session?.startedAt ?? now,
        updatedAt: now,
        endedAt: status === "ended" ? now : null,
      },
    };
    this.notify();
    return { ok: true, data: this.currentState };
  }

  private notify() {
    this.listeners.forEach((fn) => fn(this.currentState));
  }
}

export function initMockBridge() {
  if (import.meta.env.DEV) {
    new MockRewindBridge();
  }
}
