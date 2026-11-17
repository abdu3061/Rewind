import {
  failure,
  nativeBrowserStateSchema,
  sanitizeBrowserMetadataUrl,
  type BrowserAuthority,
  type NativeBrowserMessage,
  type Result,
} from "@rewind/contracts";

export interface FocusedBrowserTab {
  id: number;
  windowId: number;
  active: boolean;
  focused: boolean;
  incognito: boolean;
  url?: string | undefined;
  title?: string | undefined;
}
export interface BrowserMetadataControllerOptions {
  connectionId: string;
  browser: "chrome" | "edge";
  now(): number;
  monotonicNow(): number;
  getFocusedTab(authorized: () => boolean): Promise<FocusedBrowserTab | null>;
  send(message: NativeBrowserMessage): void;
  unavailable(): void;
}
/** One native connection. No backlog/storage/DOM access; a live desktop lease and extension approval are both required. */
export class BrowserMetadataController {
  private allowed = false;
  private closed = false;
  private authority: BrowserAuthority | null = null;
  private deadline = 0;
  private epoch = 0;
  private revision = 0;
  private sequence = 0;
  private previous: string | null = null;
  private pending: Promise<void> | null = null;
  private again = false;
  constructor(private readonly options: BrowserMetadataControllerOptions) {}
  private valid(): boolean {
    return (
      !this.closed &&
      this.allowed &&
      this.authority !== null &&
      this.options.monotonicNow() < this.deadline &&
      this.options.now() < Date.parse(this.authority.expiresAt)
    );
  }
  private invalidate(): void {
    this.epoch++;
    this.authority = null;
    this.deadline = 0;
    this.previous = null;
    this.again = false;
  }
  async permission(enabled: boolean): Promise<void> {
    this.allowed = enabled;
    if (!enabled) {
      this.invalidate();
      await this.drain();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.allowed = false;
    this.invalidate();
    this.options.unavailable();
  }
  async drain(): Promise<void> {
    while (this.pending) await this.pending;
  }
  status(): {
    allowed: boolean;
    active: boolean;
    pending: boolean;
    closed: boolean;
  } {
    return {
      allowed: this.allowed,
      active: this.valid(),
      pending: this.pending !== null,
      closed: this.closed,
    };
  }
  async state(
    input: unknown,
  ): Promise<Result<"enabled" | "stopped" | "ignored">> {
    const parsed = nativeBrowserStateSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.connectionId !== this.options.connectionId ||
      parsed.data.browser !== this.options.browser
    ) {
      this.close();
      return failure("INVALID_INPUT", "Native browser authority is invalid.");
    }
    if (this.closed)
      return failure("UNAVAILABLE", "The native connection is closed.");
    const state = parsed.data;
    if (state.revision <= this.revision) return { ok: true, value: "ignored" };
    this.revision = state.revision;
    if (!state.authority || !this.allowed) {
      this.invalidate();
      await this.drain();
      if (this.closed)
        return failure(
          "UNAVAILABLE",
          "The native connection closed before stop acknowledgement.",
        );
      try {
        this.options.send({
          version: 2,
          type: "stopped",
          connectionId: this.options.connectionId,
          revision: state.revision,
        });
        return { ok: true, value: "stopped" };
      } catch {
        this.close();
        return failure(
          "UNAVAILABLE",
          "Browser stop could not be acknowledged.",
        );
      }
    }
    if (this.authority && !this.valid()) {
      this.close();
      return failure(
        "CONFLICT",
        "Expired browser authority needs a fresh native connection.",
      );
    }
    const remaining =
      Date.parse(state.authority.expiresAt) - this.options.now();
    if (remaining <= 0 || remaining > state.authority.validForMs + 1000) {
      this.close();
      return failure(
        "INVALID_INPUT",
        "The browser lease is expired or exceeds its bounded lifetime.",
      );
    }
    const changed =
      !this.authority ||
      this.authority.capability !== state.authority.capability ||
      this.authority.sessionId !== state.authority.sessionId ||
      this.authority.generationId !== state.authority.generationId;
    const policyChanged =
      this.authority &&
      JSON.stringify(this.authority.excludedSiteHosts) !==
        JSON.stringify(state.authority.excludedSiteHosts);
    if (changed || policyChanged) {
      this.epoch++;
      this.previous = null;
      this.again = false;
    }
    if (changed) this.sequence = 0;
    this.authority = state.authority;
    this.deadline =
      this.options.monotonicNow() +
      Math.min(remaining, state.authority.validForMs);
    return { ok: true, value: "enabled" };
  }
  sample(): Promise<void> {
    if (!this.valid()) {
      if (this.authority && !this.closed) this.close();
      return Promise.resolve();
    }
    if (this.pending) {
      this.again = true;
      return this.pending;
    }
    const epoch = this.epoch;
    const work = this.read(epoch)
      .catch(() => {
        this.previous = null;
      })
      .finally(() => {
        if (this.pending === work) this.pending = null;
        const again = this.again;
        this.again = false;
        if (again && this.valid()) void this.sample();
      });
    this.pending = work;
    return work;
  }
  private async read(epoch: number): Promise<void> {
    const tab = await this.options.getFocusedTab(
      () => epoch === this.epoch && this.valid(),
    );
    // Do not inspect any returned tab field after revoke, expiry or a new generation.
    if (epoch !== this.epoch || !this.valid() || !this.authority) return;
    if (
      !tab ||
      tab.incognito !== false ||
      tab.active !== true ||
      tab.focused !== true ||
      !Number.isSafeInteger(tab.id) ||
      tab.id < 0 ||
      !Number.isSafeInteger(tab.windowId) ||
      tab.windowId < 0
    ) {
      this.previous = null;
      return;
    }
    const url =
      typeof tab.url === "string"
        ? sanitizeBrowserMetadataUrl(tab.url, this.authority.excludedSiteHosts)
        : null;
    if (!url) {
      this.previous = null;
      return;
    }
    const title = typeof tab.title === "string" ? tab.title.slice(0, 2048) : "";
    const key = JSON.stringify([tab.id, tab.windowId, url, title]);
    if (key === this.previous) return;
    if (this.sequence >= Number.MAX_SAFE_INTEGER) {
      this.close();
      return;
    }
    const message: NativeBrowserMessage = {
      version: 2,
      type: "visit",
      connectionId: this.options.connectionId,
      sessionId: this.authority.sessionId,
      generationId: this.authority.generationId,
      capability: this.authority.capability,
      sequence: ++this.sequence,
      occurredAt: new Date(this.options.now()).toISOString(),
      incognito: false,
      focused: true,
      url,
      title,
    };
    try {
      this.options.send(message);
      this.previous = key;
    } catch {
      this.close();
    }
  }
}
