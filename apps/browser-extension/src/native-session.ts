import {
  failure,
  idSchema,
  nativeBrowserMessageSchema,
  nativeBrowserStateSchema,
  type NativeBrowserMessage,
  type NativeBrowserState,
  type Result,
} from "@rewind/contracts";
import {
  BrowserMetadataController,
  type FocusedBrowserTab,
} from "./metadata-controller";

/** Extension-only port wrapper. No generic transport capability is exposed to the desktop renderer. */
export interface ExtensionNativePort {
  postMessage(message: NativeBrowserMessage): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  disconnect(): void;
}
export interface ExtensionSessionStatus {
  permission: boolean;
  connected: boolean;
  collecting: boolean;
  pending: boolean;
  issue: "connection" | "protocol" | "send" | null;
}
export interface ExtensionNativeSessionOptions {
  profileId: string;
  connect(): ExtensionNativePort;
  getFocusedTab(authorized: () => boolean): Promise<FocusedBrowserTab | null>;
  onChanged?(status: ExtensionSessionStatus): void;
  newId?(): string;
  now?(): number;
  monotonicNow?(): number;
}
interface Connection {
  id: string;
  port: ExtensionNativePort;
  controller: BrowserMetadataController | null;
  state: NativeBrowserState | null;
  detach: (() => void)[];
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}
const denied = () =>
  failure(
    "FORBIDDEN",
    "Browser connection approval was superseded or revoked.",
  );

/** One explicit browser-launch approval. Disconnect/failure revokes it; reconnect needs a new explicit call. */
export class ExtensionNativeSession {
  private enabled = false;
  private closing = false;
  private intent = 0;
  private connection: Connection | null = null;
  private retiring: Promise<void> | null = null;
  private closingWork: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private issue: ExtensionSessionStatus["issue"] = null;
  constructor(private readonly options: ExtensionNativeSessionOptions) {
    if (!idSchema.safeParse(options.profileId).success)
      throw new Error("BROWSER_PROFILE_ID_INVALID");
  }
  status(): ExtensionSessionStatus {
    const controller = this.connection?.controller?.status();
    return {
      permission: this.enabled,
      connected: this.connection?.state != null,
      collecting: this.enabled && controller?.active === true,
      pending: controller?.pending === true || this.retiring !== null,
      issue: this.issue,
    };
  }
  private notify(): void {
    try {
      this.options.onChanged?.(this.status());
    } catch {
      /* Observers cannot grant approval. */
    }
  }
  private current(connection: Connection): boolean {
    return !this.closing && this.connection === connection;
  }
  async permission(enabled: boolean): Promise<Result<ExtensionSessionStatus>> {
    const ticket = ++this.intent,
      wasEnabled = this.enabled;
    if (this.closing)
      return failure("UNAVAILABLE", "The browser connection is closed.");
    this.enabled = enabled;
    if (!enabled) {
      this.clearTimer();
      const connection = this.connection;
      this.notify();
      await connection?.controller?.permission(false);
      if (ticket !== this.intent) return denied();
      // Keep the passive connection open so a queued stop acknowledgement is not discarded by Port.disconnect().
      if (connection && this.current(connection) && connection.state?.authority)
        this.send(connection, {
          version: 2,
          type: "stopped",
          connectionId: connection.id,
          revision: connection.state.revision,
        });
      if (this.retiring) await this.retiring;
      this.notify();
      return { ok: true, value: this.status() };
    }
    if (this.connection && !wasEnabled)
      await this.retire(this.connection, null, false);
    if (this.retiring) await this.retiring;
    if (ticket !== this.intent || !this.enabled || this.closing)
      return denied();
    if (!this.connection) {
      this.issue = null;
      let port: ExtensionNativePort | null = null;
      try {
        const id = (this.options.newId ?? (() => crypto.randomUUID()))();
        if (!idSchema.safeParse(id).success)
          throw new Error("BROWSER_CONNECTION_ID_INVALID");
        port = this.options.connect();
        const connection: Connection = {
          id,
          port,
          controller: null,
          state: null,
          detach: [],
          handshakeTimer: null,
        };
        this.connection = connection;
        connection.handshakeTimer = setTimeout(() => {
          void this.retire(connection, "connection", true);
        }, 5000);
        connection.detach.push(
          port.onMessage((message) => {
            void this.message(connection, message);
          }),
        );
        connection.detach.push(
          port.onDisconnect(() => {
            void this.retire(connection, "connection", true);
          }),
        );
        if (
          !this.send(connection, {
            version: 2,
            type: "hello",
            connectionId: id,
            profileId: this.options.profileId,
          })
        )
          return failure(
            "UNAVAILABLE",
            "The native desktop handshake could not be sent. Check setup and connect again.",
          );
      } catch {
        if (this.connection)
          await this.retire(this.connection, "connection", true);
        else {
          try {
            port?.disconnect();
          } catch {
            /* No queries have started. */
          }
          this.enabled = false;
          this.issue = "connection";
        }
        this.notify();
        return failure(
          "UNAVAILABLE",
          "The native desktop connection is unavailable. Check setup and connect again.",
        );
      }
    }
    this.notify();
    return { ok: true, value: this.status() };
  }
  private send(connection: Connection, message: NativeBrowserMessage): boolean {
    if (this.connection !== connection) return false;
    try {
      const parsed = nativeBrowserMessageSchema.parse(message);
      connection.port.postMessage(parsed);
      return true;
    } catch {
      void this.retire(connection, "send", true);
      return false;
    }
  }
  private async message(connection: Connection, input: unknown): Promise<void> {
    if (!this.current(connection)) return;
    const parsed = nativeBrowserStateSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.connectionId !== connection.id ||
      (connection.state && parsed.data.browser !== connection.state.browser)
    ) {
      await this.retire(connection, "protocol", true);
      return;
    }
    const state = parsed.data,
      previous = connection.state;
    if (previous && state.revision <= previous.revision) return;
    connection.state = state;
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
    connection.handshakeTimer = null;
    if (!state.authority || !this.enabled) this.clearTimer();
    try {
      if (!connection.controller) {
        connection.controller = new BrowserMetadataController({
          connectionId: connection.id,
          browser: state.browser,
          now: this.options.now ?? Date.now,
          monotonicNow: this.options.monotonicNow ?? (() => performance.now()),
          getFocusedTab: this.options.getFocusedTab,
          send: (message) => {
            if (!this.send(connection, message))
              throw new Error("BROWSER_NATIVE_SEND_FAILED");
          },
          unavailable: () => {
            if (this.current(connection))
              void this.retire(connection, "protocol", true);
          },
        });
        await connection.controller.permission(this.enabled);
      }
      const result = await connection.controller.state(state);
      if (!this.current(connection) || connection.state !== state) return;
      if (!result.ok) {
        await this.retire(connection, "protocol", true);
        return;
      }
      if (this.enabled && connection.controller.status().active) {
        const changed =
          !previous?.authority ||
          previous.authority.capability !== state.authority?.capability ||
          previous.authority.sessionId !== state.authority?.sessionId ||
          previous.authority.generationId !== state.authority?.generationId;
        if (changed)
          void connection.controller.sample().then(() => this.notify());
        this.schedule(connection);
      }
      this.notify();
    } catch {
      await this.retire(connection, "protocol", true);
    }
  }
  private schedule(connection: Connection): void {
    if (this.timer || !this.enabled || !this.current(connection)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.current(connection) || !this.enabled || !connection.controller)
        return;
      void connection.controller.sample().then(() => {
        if (
          this.current(connection) &&
          this.enabled &&
          connection.controller?.status().active
        )
          this.schedule(connection);
        this.notify();
      });
    }, 2000);
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private retire(
    connection: Connection,
    issue: ExtensionSessionStatus["issue"],
    revoke: boolean,
  ): Promise<void> {
    if (this.connection !== connection)
      return this.retiring ?? Promise.resolve();
    this.connection = null;
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
    connection.handshakeTimer = null;
    if (revoke) {
      this.enabled = false;
      this.intent++;
    }
    this.issue = issue;
    this.clearTimer();
    for (const detach of connection.detach) {
      try {
        detach();
      } catch {
        /* Still revoke the controller and close the port. */
      }
    }
    connection.detach = [];
    connection.controller?.close();
    try {
      connection.port.disconnect();
    } catch {
      /* The physical connection may already be lost. */
    }
    const work = (async () => {
      await connection.controller?.drain();
    })();
    const retiring = work.finally(() => {
      if (this.retiring === retiring) this.retiring = null;
      this.notify();
    });
    this.retiring = retiring;
    this.notify();
    return retiring;
  }
  close(): Promise<void> {
    if (this.closingWork) return this.closingWork;
    this.closing = true;
    this.enabled = false;
    this.intent++;
    this.clearTimer();
    const connection = this.connection;
    this.closingWork = (async () => {
      await connection?.controller?.permission(false);
      if (connection && this.connection === connection) {
        if (connection.state?.authority)
          this.send(connection, {
            version: 2,
            type: "stopped",
            connectionId: connection.id,
            revision: connection.state.revision,
          });
        await this.retire(connection, null, false);
      }
      if (this.retiring) await this.retiring;
      this.notify();
    })();
    return this.closingWork;
  }
}
