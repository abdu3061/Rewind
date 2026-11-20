import { failure, idSchema, type Result } from "@rewind/contracts";
import {
  ExtensionNativeSession,
  type ExtensionNativeSessionOptions,
} from "./native-session";
import {
  extensionRequestSchema,
  type ExtensionStatus,
} from "./extension-controls";

export interface ExtensionControllerOptions {
  loadProfile(): Promise<unknown>;
  saveProfile(id: string): Promise<void>;
  hasBrowserPermissions(): Promise<boolean>;
  connect: ExtensionNativeSessionOptions["connect"];
  getFocusedTab: ExtensionNativeSessionOptions["getFocusedTab"];
  onChanged?(status: ExtensionStatus): void;
  newId?(): string;
}
/** Background policy. Only a nonsecret random profile tag persists; approval always starts off. */
export class ExtensionController {
  private session: ExtensionNativeSession | null = null;
  private initialization: Promise<Result<void>> | null = null;
  private service: ExtensionStatus["service"] = "starting";
  private revision = 0;
  private desired = false;
  private requests = 0;
  private closing = false;
  private denial: Promise<Result<ExtensionStatus>> | null = null;
  private authorizationRevision = 0;
  constructor(private readonly options: ExtensionControllerOptions) {}
  status(): ExtensionStatus {
    return {
      service: this.service,
      ...(this.session?.status() ?? {
        permission: false,
        connected: false,
        collecting: false,
        pending: this.service === "starting",
        issue: null,
      }),
    };
  }
  private notify(): void {
    try {
      this.options.onChanged?.(this.status());
    } catch {
      /* Presentation cannot grant approval. */
    }
  }
  initialize(): Promise<Result<void>> {
    if (this.closing)
      return Promise.resolve(
        failure("UNAVAILABLE", "The extension controls are closed."),
      );
    if (this.initialization) return this.initialization;
    this.initialization = (async (): Promise<Result<void>> => {
      try {
        let id = await this.options.loadProfile();
        if (!idSchema.safeParse(id).success) {
          id = (this.options.newId ?? (() => crypto.randomUUID()))();
          if (!idSchema.safeParse(id).success)
            throw new Error("EXTENSION_PROFILE_ID_INVALID");
          await this.options.saveProfile(id as string);
          if ((await this.options.loadProfile()) !== id)
            throw new Error("EXTENSION_PROFILE_NOT_VERIFIED");
        }
        if (this.closing)
          return failure("UNAVAILABLE", "The extension controls are closed.");
        this.session = new ExtensionNativeSession({
          profileId: id as string,
          connect: this.options.connect,
          getFocusedTab: this.options.getFocusedTab,
          onChanged: (status) => {
            if (!status.permission && this.desired) {
              this.desired = false;
              this.revision++;
              this.authorizationRevision++;
            }
            this.notify();
          },
        });
        this.service = "ready";
        this.notify();
        return { ok: true, value: undefined };
      } catch {
        this.service = "unavailable";
        this.desired = false;
        this.notify();
        return failure(
          "UNAVAILABLE",
          "The extension profile is unavailable. Reload the extension and check browser storage.",
        );
      }
    })();
    return this.initialization;
  }
  async permission(enabled: boolean): Promise<Result<ExtensionStatus>> {
    if (this.closing)
      return failure("UNAVAILABLE", "The extension controls are closed.");
    if (!enabled) this.authorizationRevision++;
    if (!enabled && this.denial && !this.desired) return this.denial;
    const ticket = ++this.revision;
    this.desired = enabled;
    if (!enabled) {
      // Denial never waits on initialization, permission checks or storage before fencing live queries.
      const stopping = this.session?.permission(false);
      const work = (async (): Promise<Result<ExtensionStatus>> => {
        const stopped = await stopping;
        this.notify();
        if (ticket !== this.revision)
          return failure(
            "FORBIDDEN",
            "Extension approval changed while stopping.",
          );
        return stopped && !stopped.ok
          ? stopped
          : { ok: true, value: this.status() };
      })();
      const denial = work.finally(() => {
        if (this.denial === denial) this.denial = null;
      });
      this.denial = denial;
      return denial;
    }
    const initialized = await this.initialize();
    if (!initialized.ok) return initialized;
    if (ticket !== this.revision || !this.desired)
      return failure(
        "FORBIDDEN",
        "Extension approval was superseded by a stop.",
      );
    let allowed = false;
    try {
      allowed = await this.options.hasBrowserPermissions();
    } catch {
      /* No API access on uncertainty. */
    }
    if (ticket !== this.revision || !this.desired)
      return failure(
        "FORBIDDEN",
        "Extension approval was superseded by a stop.",
      );
    if (!allowed) {
      this.desired = false;
      return failure(
        "FORBIDDEN",
        "Browser tabs and native messaging permissions are required. Check the extension permissions.",
      );
    }
    const result = await this.session!.permission(true);
    this.notify();
    if (!result.ok) return result;
    return { ok: true, value: this.status() };
  }
  async request(
    input: unknown,
    authorize: () => Promise<boolean>,
  ): Promise<Result<ExtensionStatus>> {
    const command = extensionRequestSchema.safeParse(input);
    if (!command.success)
      return failure("INVALID_INPUT", "A valid extension control is required.");
    if (this.closing)
      return failure("UNAVAILABLE", "The extension controls are closed.");
    const denial =
      command.data.kind === "rewind.browser.permission" &&
      !command.data.enabled;
    if (!denial) {
      if (this.requests >= 8)
        return failure(
          "UNAVAILABLE",
          "Extension controls are busy. Try again shortly.",
        );
      this.requests++;
    }
    try {
      const authorization =
        command.data.kind === "rewind.browser.permission"
          ? ++this.authorizationRevision
          : null;
      let authorized = false;
      try {
        authorized = await authorize();
      } catch {
        /* Uncertain main-frame identity cannot grant approval. */
      }
      if (!authorized)
        return failure(
          "FORBIDDEN",
          "Only Rewind's own top-level controls can use this capability.",
        );
      if (
        authorization !== null &&
        authorization !== this.authorizationRevision
      )
        return failure(
          "FORBIDDEN",
          "The extension control was superseded during authorization.",
        );
      // The noncapturing denial path remains available while ordinary requests wait for document proof or storage.
      if (command.data.kind === "rewind.browser.permission")
        return await this.permission(command.data.enabled);
      const initialized = await this.initialize();
      return initialized.ok ? { ok: true, value: this.status() } : initialized;
    } catch {
      return failure(
        "UNAVAILABLE",
        "The extension control could not be confirmed.",
      );
    } finally {
      if (!denial) this.requests--;
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.revision++;
    this.desired = false;
    this.service = "unavailable";
    await this.session?.close();
    this.notify();
  }
}
