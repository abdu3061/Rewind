import { randomBytes, randomUUID } from "node:crypto";
import {
  browserSiteHostSchema,
  failure,
  idSchema,
  nativeBrowserMessageSchema,
  nativeBrowserStateSchema,
  sanitizeBrowserMetadataUrl,
  type ActivityEvent,
  type BrowserPeer,
  type BrowserTransport,
  type Collector,
  type CollectorContext,
  type NativeBrowserMessage,
  type NativeBrowserState,
  type Result,
  type UserSettings,
} from "@rewind/contracts";

export interface BrowserCollectorOptions {
  transport: BrowserTransport;
  now?: () => number;
  monotonicNow?: () => number;
  newId?: () => string;
  newCapability?: () => string;
  onChanged?: () => void;
}
interface Peer {
  proof: BrowserPeer;
  connectionId: string | null;
  profileId: string | null;
  revision: number;
  sequence: number;
  capability: string | null;
  context: CollectorContext | null;
  deadline: number;
  expiresAt: number;
  stopping: { revision: number; finish: (result: Result<void>) => void } | null;
}
const ok = (): Result<void> => ({ ok: true, value: undefined });
const unavailable = () =>
  failure("UNAVAILABLE", "Browser collection could not confirm quiescence.");
const leaseMs = 4000;
const maxPending = 32;

/** Owns browser authority, not native authentication. No tab/DOM API or persistence implementation. */
export class BrowserCollector implements Collector {
  readonly id = "browser";
  private readonly peers = new Map<string, Peer>();
  private context: CollectorContext | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Set<Promise<void>>();
  private readonly staged = new Map<
    string,
    { context: CollectorContext; serialized: string }
  >();
  private releasing: Promise<Result<void>> | null = null;
  private uncertain = false;
  private failed = false;
  private epoch = 0;
  private captured = 0;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly newId: () => string;
  private readonly newCapability: () => string;
  constructor(private readonly options: BrowserCollectorOptions) {
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonicNow ?? (() => performance.now());
    this.newId = options.newId ?? randomUUID;
    this.newCapability =
      options.newCapability ?? (() => randomBytes(32).toString("hex"));
    options.transport.setListener({
      connected: (peer) => this.connected(peer),
      message: (id, message) => this.message(id, message),
      disconnected: (id) => this.disconnected(id),
      unavailable: () => this.transportFailed(),
    });
  }
  status(): {
    state: "off" | "waiting" | "active" | "stopping" | "unavailable";
    connected: number;
    pending: number;
    captured: number;
  } {
    return {
      state:
        this.failed || this.uncertain
          ? "unavailable"
          : this.releasing
            ? "stopping"
            : this.context
              ? [...this.peers.values()].some((peer) => peer.capability)
                ? "active"
                : "waiting"
              : "off",
      connected: [...this.peers.values()].filter((peer) => peer.connectionId)
        .length,
      pending: this.pending.size,
      captured: this.captured,
    };
  }
  private notify(): void {
    try {
      this.options.onChanged?.();
    } catch {
      /* Observers have no authority. */
    }
  }
  private current(context: CollectorContext): boolean {
    return (
      this.context === context &&
      context.settings.browserCollectionConsent &&
      context.authorized?.() === true
    );
  }
  async start(context: CollectorContext): Promise<Result<void>> {
    const ticket = ++this.epoch;
    const stopped = await this.release();
    if (!stopped.ok) return stopped;
    if (ticket !== this.epoch)
      return failure("FORBIDDEN", "Browser startup was superseded by a stop.");
    if (this.failed) return unavailable();
    if (!context.settings.browserCollectionConsent || !context.authorized)
      return failure(
        "FORBIDDEN",
        "Browser recording needs current engine authority.",
      );
    const sites = context.settings.excludedSiteHosts;
    if (
      sites.length > 200 ||
      sites.some((site) => !browserSiteHostSchema.safeParse(site).success)
    )
      return failure(
        "INVALID_INPUT",
        "Browser site exclusions are invalid or exceed the supported limit.",
      );
    this.context = context;
    this.captured = 0;
    // Collector startup precedes the engine's lifecycle commit. Never mint a lease in start().
    this.schedule(0);
    this.notify();
    return ok();
  }
  resume(context: CollectorContext): Promise<Result<void>> {
    return this.start(context);
  }
  pause(): Promise<Result<void>> {
    return this.stop();
  }
  stop(): Promise<Result<void>> {
    this.epoch++;
    return this.release();
  }
  private release(): Promise<Result<void>> {
    this.context = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.releasing) return this.releasing;
    // Invalidate capabilities before sending or waiting for anything asynchronous.
    const acknowledgements: Promise<Result<void>>[] = [];
    for (const peer of this.peers.values()) {
      const active = peer.capability !== null;
      this.invalidate(peer);
      if (active) acknowledgements.push(this.off(peer));
    }
    const work = Promise.all(acknowledgements).then(async (results) => {
      while (this.pending.size) await Promise.all([...this.pending]);
      this.staged.clear();
      return (
        results.find((result) => !result.ok) ??
        (this.uncertain ? unavailable() : ok())
      );
    });
    this.releasing = work.finally(() => {
      if (this.releasing === releasing) this.releasing = null;
      this.notify();
    });
    const releasing = this.releasing;
    this.notify();
    return releasing;
  }
  private invalidate(peer: Peer): void {
    peer.capability = null;
    peer.context = null;
    peer.deadline = 0;
    peer.expiresAt = 0;
  }
  private off(peer: Peer): Promise<Result<void>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.uncertain = true;
        finish(unavailable());
        this.options.transport.disconnect(peer.proof.id);
      }, 5000);
      timer.unref();
      const finish = (result: Result<void>) => {
        clearTimeout(timer);
        peer.stopping = null;
        resolve(result);
      };
      peer.stopping = { revision: peer.revision + 1, finish };
      if (!this.send(peer, null).ok) {
        this.uncertain = true;
        finish(unavailable());
      }
    });
  }
  private schedule(delay = 1000): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.renew();
      if (this.context) this.schedule();
    }, delay);
    this.timer.unref();
  }
  private renew(): void {
    const context = this.context;
    if (!context || !this.current(context)) return;
    for (const peer of this.peers.values()) {
      if (!peer.connectionId || peer.stopping) continue;
      if (!peer.capability) {
        peer.capability = this.newCapability();
        peer.context = context;
        peer.sequence = 0;
      } else if (
        this.monotonic() >= peer.deadline ||
        this.now() >= peer.expiresAt
      ) {
        this.reject(peer);
        return;
      }
      peer.deadline = this.monotonic() + leaseMs;
      peer.expiresAt = this.now() + leaseMs;
      const sent = this.send(peer, {
        sessionId: context.sessionId,
        generationId: context.generationId,
        capability: peer.capability,
        expiresAt: new Date(peer.expiresAt).toISOString(),
        validForMs: leaseMs,
        excludedSiteHosts: context.settings.excludedSiteHosts.map((site) =>
          browserSiteHostSchema.parse(site),
        ),
      });
      if (!sent.ok) {
        this.reject(peer);
        return;
      }
    }
    this.notify();
  }
  private send(
    peer: Peer,
    authority: NativeBrowserState["authority"],
  ): Result<void> {
    if (!peer.connectionId || peer.revision >= Number.MAX_SAFE_INTEGER)
      return unavailable();
    const parsed = nativeBrowserStateSchema.safeParse({
      version: 2,
      type: "state",
      connectionId: peer.connectionId,
      browser: peer.proof.browser,
      revision: ++peer.revision,
      authority,
    });
    if (!parsed.success)
      return failure("INVALID_INPUT", "Browser authority is invalid.");
    try {
      return this.options.transport.send(peer.proof.id, parsed.data);
    } catch {
      return unavailable();
    }
  }
  private connected(proof: BrowserPeer): void {
    if (
      this.failed ||
      this.peers.size >= 4 ||
      this.peers.has(proof.id) ||
      !idSchema.safeParse(proof.id).success ||
      !/^chrome-extension:\/\/[a-p]{32}\/$/.test(proof.origin) ||
      !["chrome", "edge"].includes(proof.browser)
    ) {
      this.options.transport.disconnect(proof.id);
      return;
    }
    this.peers.set(proof.id, {
      proof: { ...proof },
      connectionId: null,
      profileId: null,
      revision: 0,
      sequence: 0,
      capability: null,
      context: null,
      deadline: 0,
      expiresAt: 0,
      stopping: null,
    });
    this.notify();
  }
  private message(id: string, input: NativeBrowserMessage): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    const parsed = nativeBrowserMessageSchema.safeParse(input);
    if (!parsed.success) {
      this.reject(peer);
      return;
    }
    const message = parsed.data;
    if (message.type === "hello") {
      if (peer.connectionId) {
        this.reject(peer);
        return;
      }
      peer.connectionId = message.connectionId;
      peer.profileId = message.profileId;
      if (!this.send(peer, null).ok) {
        this.reject(peer);
        return;
      }
      // Lease issuance stays on the post-commit timer, even for an eager hello during start().
      this.notify();
      return;
    }
    if (!peer.connectionId || peer.connectionId !== message.connectionId) {
      this.reject(peer);
      return;
    }
    if (message.type === "stopped") {
      if (peer.stopping && message.revision === peer.stopping.revision)
        peer.stopping.finish(ok());
      else if (peer.capability && message.revision === peer.revision) {
        // The client can revoke its own permission. A current stop ack proves its API work drained.
        this.invalidate(peer);
        const context = this.context;
        if (context && this.current(context))
          this.fault(context, "permission-denied");
      }
      // Stale stop acknowledgements cannot acknowledge a newer stop or revoke a new run.
      return;
    }
    const context = this.context;
    if (!context || !this.current(context) || !peer.capability) return;
    if (
      peer.context !== context ||
      message.sessionId !== context.sessionId ||
      message.generationId !== context.generationId ||
      message.capability !== peer.capability ||
      message.sequence <= peer.sequence ||
      this.monotonic() >= peer.deadline ||
      this.now() >= peer.expiresAt
    ) {
      this.reject(peer);
      return;
    }
    peer.sequence = message.sequence;
    const url = sanitizeBrowserMetadataUrl(
      message.url,
      context.settings.excludedSiteHosts,
    );
    if (!url) return;
    if (this.pending.size >= maxPending) {
      this.fault(context, "overflow");
      return;
    }
    const occurredAt = new Date(this.now()).toISOString();
    const event: ActivityEvent = {
      id: this.newId(),
      sessionId: context.sessionId,
      occurredAt,
      source: "browser",
      type: "browser-visit",
      payload: {
        id: this.newId(),
        sessionId: context.sessionId,
        browser: peer.proof.browser,
        url,
        title: message.title,
        visitedAt: occurredAt,
        endedAt: null,
      },
    };
    this.staged.set(event.id, { context, serialized: JSON.stringify(event) });
    this.track(async () => {
      try {
        if (!this.current(context)) return;
        const result = await context.emit([event]);
        if (result.ok) this.captured++;
        else if (this.current(context)) this.fault(context, "unavailable");
      } catch {
        if (this.current(context)) this.fault(context, "unavailable");
      } finally {
        this.staged.delete(event.id);
      }
    });
  }
  /** Only the exact currently staged observation can enter persistence; stored peer/path claims are not authority. */
  authorize(
    event: ActivityEvent,
    settings: Readonly<UserSettings>,
  ): Result<void> {
    const staged = this.staged.get(event.id);
    if (
      event.type !== "browser-visit" ||
      !staged ||
      !this.current(staged.context) ||
      !settings.browserCollectionConsent ||
      JSON.stringify(settings) !== JSON.stringify(staged.context.settings) ||
      staged.serialized !== JSON.stringify(event) ||
      event.payload.articleText !== undefined
    )
      return failure(
        "FORBIDDEN",
        "Browser evidence has no current collection authority.",
      );
    return ok();
  }
  private track(call: () => Promise<void>): void {
    const work = Promise.resolve()
      .then(call)
      .finally(() => {
        this.pending.delete(work);
        this.notify();
      });
    this.pending.add(work);
    this.notify();
  }
  private reject(peer: Peer): void {
    const context = this.context;
    if (peer.capability || peer.stopping) this.uncertain = true;
    this.options.transport.disconnect(peer.proof.id);
    this.disconnected(peer.proof.id);
    if (context && this.current(context)) this.fault(context, "unavailable");
  }
  private disconnected(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    const active = peer.capability !== null;
    if (peer.stopping) {
      this.uncertain = true;
      peer.stopping.finish(unavailable());
    }
    if (active) this.uncertain = true;
    this.invalidate(peer);
    const context = this.context;
    if (active && context && this.current(context))
      this.fault(context, "unavailable");
    this.notify();
  }
  private transportFailed(): void {
    this.failed = true;
    const context = this.context;
    for (const id of [...this.peers.keys()]) this.disconnected(id);
    if (context && this.current(context)) this.fault(context, "unavailable");
    this.notify();
  }
  private fault(
    context: CollectorContext,
    reason: "unavailable" | "overflow" | "permission-denied",
  ): void {
    if (!this.current(context)) return;
    // Stop issuing leases immediately. The engine also fences all writes on the gap/failure.
    this.context = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.failed = true;
    // Revoke client queries now, even while the failure's gap waits behind pending persistence.
    void this.release();
    this.track(async () => {
      try {
        await context.emit([
          {
            id: this.newId(),
            sessionId: context.sessionId,
            occurredAt: new Date(this.now()).toISOString(),
            source: "browser",
            type: "capture-gap",
            payload: { collectorId: this.id, reason },
          },
        ]);
      } catch {
        /* The unavailable signal below still fences failed persistence. */
      } finally {
        context.reportUnavailable?.();
      }
    });
    this.notify();
  }
}
