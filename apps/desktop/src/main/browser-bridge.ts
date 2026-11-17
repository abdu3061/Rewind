import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { win32 as path } from "node:path";
import { z } from "zod";
import {
  failure,
  idSchema,
  nativeBrowserMessageSchema,
  nativeBrowserStateSchema,
  type BrowserPeer,
  type BrowserTransport,
  type BrowserTransportListener,
  type NativeBrowserState,
  type Result,
} from "@rewind/contracts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const origin = z.string().regex(/^chrome-extension:\/\/[a-p]{32}\/$/);
const image = z
  .string()
  .max(240)
  .refine(
    (value) =>
      /^[a-z]:\\/i.test(value) &&
      !value.includes("/") &&
      !value.slice(2).includes(":") &&
      path.normalize(value).toLowerCase() === value.toLowerCase() &&
      value
        .slice(3)
        .split("\\")
        .every((part) => part && !/[. ]$/.test(part)),
  );
/** Composition-owned installation/configuration; never accepted from renderer or browser messages. */
export const nativeBridgeConfigSchema = z.strictObject({
  version: z.literal(1),
  pipeName: z.string().regex(/^rewind\.[a-z0-9.]{1,120}$/),
  desktopPath: image,
  desktopHash: hash,
  hostHash: hash,
  origins: z
    .array(origin)
    .min(1)
    .max(4)
    .refine((items) => new Set(items).size === items.length),
  browsers: z
    .array(z.strictObject({ kind: z.enum(["chrome", "edge"]), path: image }))
    .min(1)
    .max(4)
    .refine(
      (items) =>
        new Set(items.map((item) => item.path.toLowerCase())).size ===
        items.length,
    ),
});
export type NativeBridgeConfig = z.infer<typeof nativeBridgeConfigSchema>;
const privateEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({
    type: z.literal("connected"),
    channelId: idSchema,
    browser: z.enum(["chrome", "edge"]),
    origin,
  }),
  z.strictObject({
    type: z.literal("message"),
    channelId: idSchema,
    payload: z.string().min(1).max(349528),
  }),
  z.strictObject({ type: z.literal("disconnected"), channelId: idSchema }),
]);
const unavailable = () =>
  failure("UNAVAILABLE", "The authenticated browser bridge is unavailable.");
const ok = (): Result<void> => ({ ok: true, value: undefined });
type BridgeState = "off" | "starting" | "ready" | "unavailable";

/** Utility-owned adapter for a mutually authenticated native broker. Never grants collection authority. */
export class NativeBrowserBridge implements BrowserTransport {
  private listener: BrowserTransportListener | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly peers = new Map<string, BrowserPeer>();
  private readonly blocked = new Set<string>();
  private readonly helloTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private config: NativeBridgeConfig | null = null;
  private state: BridgeState = "off";
  private closing = false;
  private closingWork: Promise<Result<void>> | null = null;
  private exited: Promise<void> = Promise.resolve();
  private startup: {
    resolve: (result: Result<void>) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  setListener(listener: BrowserTransportListener): void {
    if (this.listener) throw new Error("BROWSER_LISTENER_ALREADY_SET");
    this.listener = listener;
  }
  status(): { state: BridgeState; connected: number } {
    return { state: this.state, connected: this.peers.size };
  }
  start(executable: string, input: NativeBridgeConfig): Promise<Result<void>> {
    if (this.child || this.closingWork)
      return Promise.resolve(
        failure("CONFLICT", "The previous browser helper has not exited."),
      );
    const config = nativeBridgeConfigSchema.safeParse(input);
    if (
      !image.safeParse(executable).success ||
      !config.success ||
      !this.listener ||
      Buffer.byteLength(JSON.stringify(config.data), "utf8") > 16384
    )
      return Promise.resolve(
        failure("INVALID_INPUT", "Browser bridge setup is invalid."),
      );
    this.config = config.data;
    this.closing = false;
    this.state = "starting";
    this.buffer = Buffer.alloc(0);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, ["--broker"], {
        windowsHide: true,
        stdio: "pipe",
      });
    } catch {
      this.state = "unavailable";
      return Promise.resolve(unavailable());
    }
    this.child = child;
    const ready = new Promise<Result<void>>((resolve) => {
      const timer = setTimeout(() => this.fail(), 10000);
      timer.unref();
      this.startup = { resolve, timer };
    });
    this.exited = new Promise<void>((resolve) => {
      child.once("close", () => {
        if (this.child === child) {
          if (!this.closing) this.fail();
          this.finishStartup(unavailable());
          this.dropPeers();
          this.child = null;
          this.buffer = Buffer.alloc(0);
          this.state = this.closing ? "off" : "unavailable";
        }
        resolve();
      });
    });
    child.once("error", () => this.fail());
    child.stdin.on("error", () => this.fail());
    child.stdout.on("error", () => this.fail());
    child.stderr.resume(); // Never retain or log any child diagnostic content.
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child || this.closing || this.state === "unavailable")
        return;
      try {
        this.receive(chunk);
      } catch {
        this.fail();
      }
    });
    if (!this.write(this.config)) this.fail();
    return ready;
  }
  private finishStartup(result: Result<void>): void {
    const startup = this.startup;
    this.startup = null;
    if (startup) {
      clearTimeout(startup.timer);
      startup.resolve(result);
    }
  }
  private receive(chunk: Buffer): void {
    if (!Buffer.isBuffer(chunk) || chunk.length > 1024 * 1024)
      throw new Error("BROWSER_OUTPUT_LIMIT");
    const bytes = Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    for (;;) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) break;
      if (end - offset > 524288) throw new Error("BROWSER_OUTPUT_LIMIT");
      const line = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset, end),
      );
      offset = end + 1;
      this.event(privateEvent.parse(JSON.parse(line)));
      if (this.state === "unavailable" || this.closing) return;
    }
    if (bytes.length - offset > 524288) throw new Error("BROWSER_OUTPUT_LIMIT");
    this.buffer = Buffer.from(bytes.subarray(offset));
  }
  private event(event: z.infer<typeof privateEvent>): void {
    if (event.type === "ready") {
      if (this.state !== "starting") throw new Error("BROWSER_READY_INVALID");
      this.state = "ready";
      this.finishStartup(ok());
      return;
    }
    if (this.state !== "ready" || !this.config)
      throw new Error("BROWSER_NOT_READY");
    if (event.type === "disconnected") {
      // Rejected unauthenticated native callers can close before any connected event.
      this.dropPeer(event.channelId);
      return;
    }
    if (event.type === "connected") {
      if (
        this.peers.has(event.channelId) ||
        this.peers.size >= 4 ||
        !this.config.origins.includes(event.origin) ||
        !this.config.browsers.some((item) => item.kind === event.browser)
      )
        throw new Error("BROWSER_PEER_INVALID");
      const peer: BrowserPeer = {
        id: event.channelId,
        browser: event.browser,
        origin: event.origin,
      };
      this.peers.set(peer.id, peer);
      const timer = setTimeout(() => this.disconnect(peer.id), 5000);
      timer.unref();
      this.helloTimers.set(peer.id, timer);
      this.listener?.connected({ ...peer });
      return;
    }
    if (this.blocked.has(event.channelId)) return;
    if (!this.peers.has(event.channelId))
      throw new Error("BROWSER_CHANNEL_INVALID");
    try {
      const body = Buffer.from(event.payload, "base64");
      if (
        !body.length ||
        body.length > 262144 ||
        body.toString("base64") !== event.payload
      )
        throw new Error("BROWSER_FRAME_INVALID");
      const message = nativeBrowserMessageSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
      const timer = this.helloTimers.get(event.channelId);
      if (timer) {
        if (message.type !== "hello") throw new Error("BROWSER_HELLO_REQUIRED");
        clearTimeout(timer);
        this.helloTimers.delete(event.channelId);
      }
      this.listener?.message(event.channelId, message);
    } catch {
      this.disconnect(event.channelId);
    }
  }
  send(peerId: string, state: NativeBrowserState): Result<void> {
    const peer = this.peers.get(peerId),
      parsed = nativeBrowserStateSchema.safeParse(state);
    if (
      this.state !== "ready" ||
      this.closing ||
      !peer ||
      this.blocked.has(peerId)
    )
      return unavailable();
    if (!parsed.success || parsed.data.browser !== peer.browser)
      return failure("INVALID_INPUT", "Browser state is invalid.");
    const body = Buffer.from(JSON.stringify(parsed.data), "utf8");
    if (body.length > 262144)
      return failure(
        "INVALID_INPUT",
        "Browser state exceeds the native frame limit.",
      );
    if (
      !this.write({
        type: "send",
        channelId: peerId,
        payload: body.toString("base64"),
      })
    ) {
      this.fail();
      return unavailable();
    }
    return ok();
  }
  disconnect(peerId: string): void {
    if (!this.peers.has(peerId) || this.blocked.has(peerId)) return;
    this.blocked.add(peerId);
    const timer = this.helloTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.helloTimers.delete(peerId);
    if (!this.write({ type: "disconnect", channelId: peerId })) this.fail();
  }
  private write(value: unknown): boolean {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.stdin.writableLength > 524288)
      return false;
    try {
      return child.stdin.write(JSON.stringify(value) + "\n", "utf8");
    } catch {
      return false;
    }
  }
  private dropPeer(id: string): void {
    const timer = this.helloTimers.get(id);
    if (timer) clearTimeout(timer);
    this.helloTimers.delete(id);
    this.blocked.delete(id);
    if (this.peers.delete(id)) {
      try {
        this.listener?.disconnected(id);
      } catch {
        this.fail();
      }
    }
  }
  private dropPeers(): void {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
  }
  private fail(): void {
    const alreadyFailed = this.state === "unavailable";
    this.state = "unavailable";
    this.finishStartup(unavailable());
    this.buffer = Buffer.alloc(0);
    // A failed write may already have entered the pipe; kill the helper rather than renew uncertain authority.
    try {
      this.child?.kill();
    } catch {
      /* Exit remains unconfirmed until close. */
    }
    if (!alreadyFailed && !this.closing) {
      this.dropPeers();
      try {
        this.listener?.unavailable();
      } catch {
        /* Failure remains visible in status. */
      }
    }
  }
  close(): Promise<Result<void>> {
    if (this.closingWork) return this.closingWork;
    this.closing = true;
    this.finishStartup(unavailable());
    const child = this.child;
    this.closingWork = (async () => {
      if (child) {
        this.write({ type: "shutdown" });
        if (!(await this.waitForExit(2000))) {
          try {
            child.kill();
          } catch {
            /* Actual observed close is still required. */
          }
          if (!(await this.waitForExit(2000))) return unavailable();
        }
      }
      this.dropPeers();
      this.state = "off";
      this.config = null;
      this.buffer = Buffer.alloc(0);
      return ok();
    })().finally(() => {
      this.closingWork = null;
    });
    return this.closingWork;
  }
  private async waitForExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
