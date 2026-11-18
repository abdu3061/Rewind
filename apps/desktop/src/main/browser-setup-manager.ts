import { z } from "zod";
import {
  browserSetupJournalSchema,
  failure,
  type BrowserSetupGeneration,
  type BrowserSetupJournal,
  type BrowserSetupStore,
  type Result,
} from "@rewind/contracts";
import type {
  BrowserInstallation,
  BrowserInstallationFiles,
} from "./browser-installation-files";
import type { NativeBrowserRegistration } from "./browser-registration";
import type { NativeBridgeConfig } from "./browser-bridge";
import type { VerifiedBrowserAssets } from "./browser-assets";

type Browser = "chrome" | "edge";
const choices = z
  .array(z.enum(["chrome", "edge"]))
  .min(1)
  .max(2)
  .refine((items) => new Set(items).size === items.length);
const interrupted = () =>
  failure(
    "UNAVAILABLE",
    "Browser setup stopped before completion. Inspect setup before retrying.",
  );
interface Options {
  store: BrowserSetupStore;
  files: Pick<
    BrowserInstallationFiles,
    "publish" | "verify" | "location" | "close"
  >;
  registry: Pick<NativeBrowserRegistration, "inspect" | "install" | "remove">;
  assets(): Promise<Result<VerifiedBrowserAssets>>;
  desktop(): Promise<Result<{ path: string; hash: string }>>;
  browsers: NativeBridgeConfig["browsers"];
  /** Revoke approval, invalidate authority, drain collection and observe broker exit first. */
  quiesce(): Promise<Result<void>>;
}

/** Utility-only setup transaction orchestration. No method grants recording approval. */
export class BrowserSetupManager {
  private closed = false;
  private epoch = 0;
  private running: Promise<Result<BrowserSetupJournal>> | null = null;
  private readonly loads = new Set<
    Promise<Result<BrowserInstallation | null>>
  >();
  constructor(private readonly options: Options) {}
  private async scopedAssets(
    journal: BrowserSetupJournal,
  ): Promise<Result<VerifiedBrowserAssets>> {
    const assets = await this.options.assets();
    if (!assets.ok) return assets;
    if (
      journal.generations.some(
        (item) => item.hostName !== assets.value.inventory.hostName,
      )
    )
      return failure(
        "CONFLICT",
        "Browser setup belongs to a different host namespace.",
      );
    return assets;
  }
  private run(
    work: () => Promise<Result<BrowserSetupJournal>>,
  ): Promise<Result<BrowserSetupJournal>> {
    if (this.closed) return Promise.resolve(interrupted());
    if (this.running)
      return Promise.resolve(
        failure("CONFLICT", "Browser setup is already in progress."),
      );
    this.epoch++;
    const running = Promise.resolve()
      .then(work)
      .catch(() => interrupted());
    this.running = running;
    return running.finally(() => {
      if (this.running === running) this.running = null;
    });
  }
  async close(): Promise<Result<void>> {
    this.closed = true;
    this.epoch++;
    await this.running;
    await Promise.all([...this.loads]);
    try {
      return await this.options.files.close();
    } catch {
      return interrupted();
    }
  }
  private async journal(): Promise<Result<BrowserSetupJournal>> {
    const read = await this.options.store.read();
    if (!read.ok) return read;
    const parsed = browserSetupJournalSchema.safeParse(read.value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : failure("INTEGRITY_FAILURE", "Browser setup ownership is invalid.");
  }
  private receipt(
    journal: BrowserSetupJournal,
    id: string,
  ): BrowserSetupGeneration {
    const generation = journal.generations.find((item) => item.id === id);
    if (!generation) throw new Error("SETUP_RECEIPT_MISSING");
    return generation;
  }
  install(
    confirmed: boolean,
    input: Browser[],
  ): Promise<Result<BrowserSetupJournal>> {
    if (confirmed !== true)
      return Promise.resolve(
        failure(
          "FORBIDDEN",
          "Confirm browser setup before changing registration.",
        ),
      );
    const parsed = choices.safeParse(input);
    if (!parsed.success)
      return Promise.resolve(
        failure("INVALID_INPUT", "Choose supported browsers once each."),
      );
    return this.run(async () => {
      const stored = await this.journal();
      if (!stored.ok) return stored;
      const journal = stored.value;
      if (journal.pending)
        return failure(
          "CONFLICT",
          "Repair the interrupted browser setup before installing another generation.",
        );
      if (journal.generations.length >= 128)
        return failure(
          "STORAGE_LIMIT",
          "Browser setup ownership has reached its bounded generation limit.",
        );
      for (const kind of ["chrome", "edge"] as const)
        if (journal.registrations[kind] && !parsed.data.includes(kind))
          return failure(
            "INVALID_INPUT",
            "Include registered browsers when updating their shared bridge, or unregister them first.",
          );
      const browsers = this.options.browsers.filter((item) =>
        parsed.data.includes(item.kind),
      );
      if (
        parsed.data.some((kind) => !browsers.some((item) => item.kind === kind))
      )
        return failure(
          "UNAVAILABLE",
          "A selected browser is not available at a supported installation path.",
        );
      const assets = await this.scopedAssets(journal);
      if (!assets.ok) return assets;
      const desktop = await this.options.desktop();
      if (!desktop.ok) return desktop;
      if (this.closed) return interrupted();
      const stopped = await this.options.quiesce();
      if (!stopped.ok) return stopped;
      if (this.closed) return interrupted();
      const published = await this.options.files.publish(
        assets.value,
        desktop.value,
        browsers,
      );
      if (!published.ok) return published;
      if (this.closed) return interrupted();
      const pending: BrowserSetupJournal = {
        ...journal,
        revision: journal.revision + 1,
        generations: [...journal.generations, published.value.generation],
        pending: {
          operation: "install",
          generationId: published.value.generation.id,
          browsers: parsed.data,
          previous: { ...journal.registrations },
        },
      };
      const saved = await this.options.store.write(journal.revision, pending);
      if (!saved.ok) return saved;
      return this.apply(pending);
    });
  }
  remove(
    confirmed: boolean,
    browser: Browser,
  ): Promise<Result<BrowserSetupJournal>> {
    if (confirmed !== true)
      return Promise.resolve(
        failure(
          "FORBIDDEN",
          "Confirm browser removal before changing registration.",
        ),
      );
    if (browser !== "chrome" && browser !== "edge")
      return Promise.resolve(
        failure("INVALID_INPUT", "Choose a supported browser."),
      );
    return this.run(async () => {
      const stored = await this.journal();
      if (!stored.ok) return stored;
      const journal = stored.value;
      if (journal.pending)
        return failure(
          "CONFLICT",
          "Repair the interrupted browser setup before removal.",
        );
      const generationId = journal.registrations[browser];
      if (!generationId)
        return failure(
          "NOT_FOUND",
          "No owned browser registration is recorded for this browser.",
        );
      const assets = await this.scopedAssets(journal);
      if (!assets.ok) return assets;
      if (this.closed) return interrupted();
      const stopped = await this.options.quiesce();
      if (!stopped.ok) return stopped;
      if (this.closed) return interrupted();
      const pending: BrowserSetupJournal = {
        ...journal,
        revision: journal.revision + 1,
        pending: {
          operation: "remove",
          generationId,
          browsers: [browser],
          previous: { ...journal.registrations },
        },
      };
      const saved = await this.options.store.write(journal.revision, pending);
      if (!saved.ok) return saved;
      return this.apply(pending);
    });
  }
  repair(confirmed: boolean): Promise<Result<BrowserSetupJournal>> {
    if (confirmed !== true)
      return Promise.resolve(
        failure(
          "FORBIDDEN",
          "Confirm repair before changing browser registration.",
        ),
      );
    return this.run(async () => {
      const stored = await this.journal();
      if (!stored.ok) return stored;
      if (!stored.value.pending)
        return failure(
          "INVALID_TRANSITION",
          "No interrupted browser setup is recorded.",
        );
      const assets = await this.scopedAssets(stored.value);
      if (!assets.ok) return assets;
      if (this.closed) return interrupted();
      const stopped = await this.options.quiesce();
      if (!stopped.ok) return stopped;
      if (this.closed) return interrupted();
      return this.apply(stored.value, true);
    });
  }
  private async apply(
    journal: BrowserSetupJournal,
    retry = false,
  ): Promise<Result<BrowserSetupJournal>> {
    if (this.closed || !journal.pending) return interrupted();
    const pending = journal.pending;
    const receipt = this.receipt(journal, pending.generationId);
    const location = this.options.files.location(receipt);
    if (pending.operation === "install") {
      const verified = await this.options.files.verify(receipt);
      if (!verified.ok) return verified;
    }
    for (const kind of pending.browsers) {
      if (this.closed) return interrupted();
      let changed;
      if (pending.operation === "remove")
        changed = await this.options.registry.remove(kind, location.manifest);
      else {
        const previousId = pending.previous[kind];
        const previous = previousId
          ? this.options.files.location(this.receipt(journal, previousId))
              .manifest
          : retry
            ? location.manifest
            : null;
        if (this.closed) return interrupted();
        // The pending receipt proves this generation too, including a retry after a partial write.
        changed = await this.options.registry.install(
          kind,
          location.manifest,
          previous,
        );
      }
      if (!changed.ok) return changed;
      if (
        changed.value.state !==
        (pending.operation === "install" ? "registered" : "absent")
      )
        return interrupted();
    }
    if (this.closed) return interrupted();
    const registrations = { ...journal.registrations };
    for (const kind of pending.browsers)
      registrations[kind] =
        pending.operation === "install" ? pending.generationId : null;
    const complete: BrowserSetupJournal = {
      ...journal,
      revision: journal.revision + 1,
      registrations,
      pending: null,
    };
    const saved = await this.options.store.write(journal.revision, complete);
    return saved.ok ? { ok: true, value: complete } : saved;
  }
  /** Read-only startup verification. An interrupted operation never repairs or registers itself. */
  load(): Promise<Result<BrowserInstallation | null>> {
    if (this.closed) return Promise.resolve(interrupted());
    const work = this.loadCurrent();
    this.loads.add(work);
    return work.finally(() => this.loads.delete(work));
  }
  private async loadCurrent(): Promise<Result<BrowserInstallation | null>> {
    const ticket = this.epoch;
    const current = () =>
      !this.closed && !this.running && this.epoch === ticket;
    if (!current()) return interrupted();
    try {
      const stored = await this.journal();
      if (!stored.ok) return stored;
      if (stored.value.pending)
        return failure(
          "CONFLICT",
          "Browser setup was interrupted. Explicit repair is required.",
        );
      const id =
        stored.value.registrations.chrome ?? stored.value.registrations.edge;
      if (!id) return current() ? { ok: true, value: null } : interrupted();
      const assets = await this.scopedAssets(stored.value);
      if (!assets.ok) return assets;
      const desktop = await this.options.desktop();
      if (!desktop.ok) return desktop;
      const verified = await this.options.files.verify(
        this.receipt(stored.value, id),
      );
      if (!verified.ok) return verified;
      if (
        verified.value.generation.nativeSourceHash !==
          assets.value.inventory.nativeSourceHash ||
        verified.value.generation.extensionId !==
          assets.value.inventory.extensionId ||
        verified.value.configuration.desktopHash !== desktop.value.hash ||
        verified.value.configuration.desktopPath.toLowerCase() !==
          desktop.value.path.toLowerCase()
      )
        return failure(
          "CONFLICT",
          "Browser setup needs an explicit update for this Rewind build.",
        );
      for (const kind of ["chrome", "edge"] as const)
        if (stored.value.registrations[kind]) {
          if (!current()) return interrupted();
          const inspected = await this.options.registry.inspect(
            kind,
            verified.value.manifest,
          );
          if (!inspected.ok) return inspected;
          if (inspected.value.state !== "registered")
            return failure(
              "CONFLICT",
              "Browser registration differs from its owned setup. Inspect setup before connecting.",
            );
        }
      const latest = await this.journal();
      if (!latest.ok) return latest;
      if (!current() || latest.value.revision !== stored.value.revision)
        return interrupted();
      // A removed browser cannot use a stale cached native-host registration to join the broker.
      const configuration = {
        ...verified.value.configuration,
        browsers: verified.value.configuration.browsers.filter(
          (item) => stored.value.registrations[item.kind] !== null,
        ),
      };
      return { ok: true, value: { ...verified.value, configuration } };
    } catch {
      return interrupted();
    }
  }
}
