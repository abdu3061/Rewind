import path from "node:path";
import { BrowserCollector, type SessionCoordinator } from "@rewind/engine";
import type { SecureStorage } from "@rewind/storage";
import {
  browserCommandSchema,
  browserControlStateSchema,
  browserExclusionsSchema,
  failure,
  type AppError,
  type BrowserAssetsLocation,
  type BrowserCommand,
  type BrowserControlState,
  type Result,
  type UserSettings,
} from "@rewind/contracts";
import {
  browserHostName,
  developmentExtensionId,
  readBrowserAssets,
} from "./browser-assets";
import { BrowserInstallationFiles } from "./browser-installation-files";
import { NativeBrowserBridge } from "./browser-bridge";
import { NativeBrowserRegistration } from "./browser-registration";
import { BrowserSetupManager } from "./browser-setup-manager";
import {
  discoverBrowserInstallations,
  fingerprintDesktopImage,
} from "./browser-environment";

interface Options {
  root: string;
  synthetic: boolean;
  assets?: BrowserAssetsLocation;
  storage: SecureStorage;
  coordinator: SessionCoordinator;
  bridge: NativeBrowserBridge;
  collector: BrowserCollector;
  getSettings(): UserSettings;
  changeSettings(
    settings: UserSettings,
    current: () => boolean,
  ): Promise<Result<void>>;
  notify(): void;
  storageError(error: AppError): void;
}
/** Utility composition only. Public DTOs contain status/policy, never native paths, frames or receipts. */
export class BrowserOperations {
  private manager: BrowserSetupManager | null = null;
  private busy = false;
  private closed = false;
  private image: Awaited<ReturnType<typeof fingerprintDesktopImage>> | null =
    null;
  private readonly setup: BrowserControlState["setup"] = {
    state: "unavailable",
    availableBrowsers: [],
    registeredBrowsers: [],
    repairAvailable: false,
    checkedAt: null,
    extensionId: developmentExtensionId,
    error: null,
  };
  constructor(private readonly options: Options) {}
  private hostName(): string {
    return this.options.assets?.hostName ?? browserHostName;
  }
  private allowedLocation(): boolean {
    if (!this.options.assets) return false;
    if (!this.options.synthetic) return this.hostName() === browserHostName;
    return (
      /^com\.rewind\.test\.[a-f0-9]{32}$/.test(this.hostName()) &&
      path.resolve(this.options.assets.root).toLowerCase() ===
        path
          .resolve(path.dirname(this.options.root), "browser-assets")
          .toLowerCase()
    );
  }
  async verifyAssets(): Promise<Result<true>> {
    if (this.closed || !this.allowedLocation() || !this.options.assets)
      return failure(
        "UNAVAILABLE",
        "Browser assets are unavailable in this profile.",
      );
    const result = await readBrowserAssets(
      this.options.assets.root,
      this.hostName(),
    );
    return result.ok ? { ok: true, value: true } : result;
  }
  state(): Result<BrowserControlState> {
    const settings = this.options.getSettings();
    const state = browserControlStateSchema.safeParse({
      permission: settings.browserCollectionConsent,
      excludedSiteHosts: settings.excludedSiteHosts,
      policyValid: browserExclusionsSchema.safeParse(settings.excludedSiteHosts)
        .success,
      busy: this.busy,
      setup: this.setup,
      bridge: this.options.bridge.status(),
      capture: this.options.collector.status(),
    });
    return state.success
      ? { ok: true, value: state.data }
      : failure("INTEGRITY_FAILURE", "Browser status could not be verified.");
  }
  async initialize(): Promise<Result<void>> {
    if (this.closed)
      return failure("UNAVAILABLE", "Browser setup is stopping.");
    if (this.manager) return { ok: true, value: undefined };
    if (!this.options.assets || !this.allowedLocation()) {
      this.setup.error = {
        code: "UNAVAILABLE",
        message: this.options.synthetic
          ? "Browser setup is disabled in the standard synthetic profile. Use the isolated browser verification harness."
          : "Browser setup assets were not provided by the desktop.",
      };
      return { ok: true, value: undefined };
    }
    const location = this.options.assets;
    const assets = await readBrowserAssets(location.root, this.hostName());
    if (!assets.ok) {
      this.setup.error = assets.error;
      return { ok: true, value: undefined };
    }
    const browsers = await discoverBrowserInstallations();
    this.setup.availableBrowsers = [
      ...new Set(browsers.map((item) => item.kind)),
    ];
    this.manager = new BrowserSetupManager({
      files: new BrowserInstallationFiles(this.options.root, this.hostName()),
      registry: new NativeBrowserRegistration(
        path.join(location.root, "RewindBrowserHost.exe"),
        this.hostName(),
      ),
      browsers,
      assets: () => readBrowserAssets(location.root, this.hostName()),
      desktop: async () => {
        if (this.image?.ok) return this.image;
        const image = await fingerprintDesktopImage(location.desktopPath);
        if (image.ok) this.image = image;
        return image;
      },
      store: {
        read: () =>
          this.options.coordinator.read(() =>
            this.options.storage.browserSetup.read(),
          ),
        write: (revision, next) =>
          this.options.coordinator.read(() =>
            this.options.storage.browserSetup.write(revision, next),
          ),
      },
      quiesce: async () => {
        const stopped = await this.options.changeSettings(
          { ...this.options.getSettings(), browserCollectionConsent: false },
          () => !this.closed,
        );
        if (!stopped.ok) return stopped;
        return this.options.bridge.close();
      },
    });
    return this.reload();
  }
  private async reload(): Promise<Result<void>> {
    if (!this.manager || this.closed)
      return failure("UNAVAILABLE", "Browser setup is unavailable.");
    const journal = await this.options.coordinator.read(() =>
      this.options.storage.browserSetup.read(),
    );
    if (!journal.ok) {
      this.options.storageError(journal.error);
      return journal;
    }
    this.setup.registeredBrowsers = (["chrome", "edge"] as const).filter(
      (kind) => journal.value.registrations[kind] !== null,
    );
    this.setup.repairAvailable = journal.value.pending !== null;
    this.setup.checkedAt = new Date().toISOString();
    const loaded = await this.manager.load();
    if (!loaded.ok) {
      this.setup.state = "needs-attention";
      this.setup.error = loaded.error;
      return { ok: true, value: undefined };
    }
    if (!loaded.value) {
      this.setup.state = "not-installed";
      this.setup.error = null;
      return { ok: true, value: undefined };
    }
    if (this.closed)
      return failure("UNAVAILABLE", "Browser setup is stopping.");
    const started = await this.options.bridge.start(
      loaded.value.executable,
      loaded.value.configuration,
    );
    this.setup.state = started.ok ? "installed" : "needs-attention";
    this.setup.error = started.ok ? null : started.error;
    return { ok: true, value: undefined };
  }
  async execute(
    input: BrowserCommand,
    current: () => boolean,
  ): Promise<Result<BrowserControlState>> {
    const parsed = browserCommandSchema.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Browser controls are invalid.");
    const command = parsed.data;
    const allowed = () => !this.closed && current();
    if (command.kind === "browser.state") return this.state();
    if (this.closed)
      return failure("UNAVAILABLE", "Browser setup is stopping.");
    if (command.kind === "browser.exclusions") {
      const saved = await this.options.changeSettings(
        {
          ...this.options.getSettings(),
          browserCollectionConsent: false,
          excludedSiteHosts: command.hosts,
        },
        allowed,
      );
      return saved.ok ? this.state() : saved;
    }
    if (command.kind === "browser.permission") {
      if (command.enabled) {
        if (
          this.busy ||
          this.setup.state !== "installed" ||
          this.options.bridge.status().state !== "ready" ||
          this.options.collector.status().state === "unavailable"
        )
          return failure(
            "UNAVAILABLE",
            "Complete browser setup and reconnect the service before approving recording.",
          );
        if (
          !browserExclusionsSchema.safeParse(
            this.options.getSettings().excludedSiteHosts,
          ).success
        )
          return failure(
            "INVALID_INPUT",
            "Review site exclusions before approving browser recording.",
          );
        const usage = await this.options.coordinator.read(() =>
          this.options.storage.cleanup(),
        );
        if (!usage.ok) {
          this.options.storageError(usage.error);
          return usage;
        }
        if (usage.value.overQuota)
          return failure(
            "STORAGE_LIMIT",
            "Adjust storage before approving browser recording.",
          );
        if (!allowed() || this.busy)
          return failure(
            "CONFLICT",
            "A newer privacy operation superseded this approval.",
          );
      }
      const saved = await this.options.changeSettings(
        {
          ...this.options.getSettings(),
          browserCollectionConsent: command.enabled,
        },
        allowed,
      );
      return saved.ok ? this.state() : saved;
    }
    if (this.busy)
      return failure("CONFLICT", "Browser setup is already in progress.");
    if (!this.manager)
      return failure(
        "UNAVAILABLE",
        this.setup.error?.message ?? "Browser setup is unavailable.",
      );
    this.busy = true;
    this.options.notify();
    try {
      const result =
        command.kind === "browser.install"
          ? await this.manager.install(command.confirmed, command.browsers)
          : command.kind === "browser.remove"
            ? await this.manager.remove(command.confirmed, command.browser)
            : await this.manager.repair(command.confirmed);
      if (!result.ok) {
        this.setup.state = "needs-attention";
        this.setup.error = result.error;
        const latest = await this.options.coordinator.read(() =>
          this.options.storage.browserSetup.read(),
        );
        if (latest.ok) {
          this.setup.repairAvailable = latest.value.pending !== null;
          this.setup.registeredBrowsers = (["chrome", "edge"] as const).filter(
            (kind) => latest.value.registrations[kind] !== null,
          );
        } else this.options.storageError(latest.error);
        return result;
      }
      const refreshed = await this.reload();
      if (!refreshed.ok) return refreshed;
      if (this.setup.error) return { ok: false, error: this.setup.error };
      this.busy = false;
      return this.state();
    } catch {
      return failure("UNAVAILABLE", "Browser setup could not be confirmed.");
    } finally {
      this.busy = false;
      this.options.notify();
    }
  }
  async close(): Promise<Result<void>> {
    this.closed = true;
    const manager = await this.manager?.close();
    if (manager && !manager.ok) return manager;
    return this.options.bridge.close();
  }
}
