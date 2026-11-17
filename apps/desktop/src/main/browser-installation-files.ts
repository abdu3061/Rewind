import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  browserSetupGenerationSchema,
  failure,
  type BrowserSetupGeneration,
  type ProtectedFolder,
  type RecoveryCopyReceipt,
  type Result,
} from "@rewind/contracts";
import {
  WindowsProtectedFileAccess,
  WindowsRecoveryCopyWriter,
} from "@rewind/collectors";
import { preparePrivateDirectory } from "@rewind/storage/key-store";
import {
  browserAssetInventorySchema,
  browserHostName,
  developmentExtensionId,
  type VerifiedBrowserAssets,
} from "./browser-assets";
import {
  nativeBridgeConfigSchema,
  type NativeBridgeConfig,
} from "./browser-bridge";

const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const unavailable = () =>
  failure(
    "UNAVAILABLE",
    "Browser setup files could not be verified. No new registration is authorized.",
  );
const nativeName = "RewindBrowserHost.exe",
  configurationName = `${nativeName}.json`,
  manifestName = "native-host.json";
const manifestSchema = z.strictObject({
  name: z.literal(browserHostName),
  description: z.literal(
    "Rewind permission-controlled browser metadata bridge",
  ),
  path: z.string().min(4).max(240),
  type: z.literal("stdio"),
  allowed_origins: z.array(z.string()).length(1),
});
export interface BrowserInstallation {
  generation: BrowserSetupGeneration;
  configuration: NativeBridgeConfig;
  executable: string;
  manifest: string;
}

/** Utility-only immutable generations; caller confirms setup and journals receipts before registration. */
export class BrowserInstallationFiles {
  private busy = false;
  private closing = false;
  private uncertain = false;
  private active = Promise.resolve();
  private finishActive: (() => void) | null = null;
  private closingWork: Promise<Result<void>> | null = null;
  private readonly helpers = new Set<{ close(): Promise<Result<void>> }>();
  constructor(private readonly privateRoot: string) {}
  private begin(): boolean {
    if (this.busy || this.closing || this.uncertain) return false;
    this.busy = true;
    this.active = new Promise<void>((resolve) => {
      this.finishActive = resolve;
    });
    return true;
  }
  private async release(
    helpers: { close(): Promise<Result<void>> }[],
  ): Promise<boolean> {
    const results = await Promise.allSettled(
      helpers.map((helper) => helper.close()),
    );
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.status === "fulfilled" && result.value.ok)
        this.helpers.delete(helpers[index]!);
      else this.uncertain = true;
    }
    return results.every(
      (result) => result.status === "fulfilled" && result.value.ok,
    );
  }
  private async finish(
    helpers: { close(): Promise<Result<void>> }[],
  ): Promise<boolean> {
    const stopped = await this.release(helpers);
    this.busy = false;
    this.finishActive?.();
    this.finishActive = null;
    return stopped;
  }
  close(): Promise<Result<void>> {
    this.closing = true;
    if (this.closingWork) return this.closingWork;
    const work = (async (): Promise<Result<void>> => {
      await this.active;
      return (await this.release([...this.helpers]))
        ? { ok: true, value: undefined }
        : unavailable();
    })();
    this.closingWork = work;
    return work.finally(() => {
      if (this.closingWork === work) this.closingWork = null;
    });
  }
  private directory(id: string): string {
    return path.join(this.privateRoot, "browser-host", `g-${id}`);
  }
  location(input: BrowserSetupGeneration): {
    executable: string;
    manifest: string;
  } {
    const generation = browserSetupGenerationSchema.parse(input);
    return {
      executable: path.join(this.directory(generation.id), nativeName),
      manifest: path.join(this.directory(generation.id), manifestName),
    };
  }
  async publish(
    assets: VerifiedBrowserAssets,
    desktop: { path: string; hash: string },
    browsers: NativeBridgeConfig["browsers"],
  ): Promise<Result<BrowserInstallation>> {
    if (!this.begin())
      return this.busy
        ? failure("CONFLICT", "Browser setup files are already in use.")
        : unavailable();
    const access = new WindowsProtectedFileAccess(),
      writer = new WindowsRecoveryCopyWriter();
    this.helpers.add(access);
    this.helpers.add(writer);
    let result: Result<BrowserInstallation>;
    try {
      result = await this.create(access, writer, assets, desktop, browsers);
    } catch {
      result = unavailable();
    }
    if (!(await this.finish([access, writer]))) result = unavailable();
    return result;
  }
  private async create(
    access: WindowsProtectedFileAccess,
    writer: WindowsRecoveryCopyWriter,
    assets: VerifiedBrowserAssets,
    desktop: { path: string; hash: string },
    browsers: NativeBridgeConfig["browsers"],
  ): Promise<Result<BrowserInstallation>> {
    const inventory = browserAssetInventorySchema.parse(assets.inventory);
    if (
      assets.native.length !== inventory.native.bytes ||
      digest(assets.native) !== inventory.native.sha256
    )
      return unavailable();
    const id = randomUUID(),
      createdAt = new Date().toISOString(),
      directory = this.directory(id);
    const configuration = nativeBridgeConfigSchema.parse({
      version: 1,
      pipeName: `rewind.${id.replaceAll("-", "")}`,
      desktopPath: desktop.path,
      desktopHash: desktop.hash,
      hostHash: inventory.native.sha256,
      origins: [`chrome-extension://${developmentExtensionId}/`],
      browsers,
    });
    // Validate all inputs before creating even an empty installation generation.
    await preparePrivateDirectory(path.join(this.privateRoot, "browser-host"));
    const root = await access.validateFolder(
      path.join(this.privateRoot, "browser-host"),
    );
    if (!root.ok) return unavailable();
    await mkdir(directory, { mode: 0o700 });
    const proof = await access.validateFolder(directory);
    const rootAfter = await access.validateFolder(root.value.absolutePath);
    if (
      !proof.ok ||
      !rootAfter.ok ||
      rootAfter.value.osIdentity !== root.value.osIdentity
    )
      return unavailable();
    const executable = path.join(directory, nativeName);
    const configBytes = Buffer.from(JSON.stringify(configuration)),
      manifestBytes = Buffer.from(
        JSON.stringify({
          name: browserHostName,
          description: "Rewind permission-controlled browser metadata bridge",
          path: executable,
          type: "stdio",
          allowed_origins: configuration.origins,
        }),
      );
    if (configBytes.length > 16384 || manifestBytes.length > 16384)
      return unavailable();
    const receipts: RecoveryCopyReceipt[] = [];
    for (const [name, bytes] of [
      [nativeName, assets.native],
      [configurationName, configBytes],
      [manifestName, manifestBytes],
    ] as const) {
      const hash = digest(bytes);
      const written = await writer.createCopy(proof.value, name, bytes, hash);
      if (
        !written.ok ||
        written.value.contentHash !== hash ||
        written.value.byteLength !== bytes.length
      )
        return unavailable();
      receipts.push(written.value);
    }
    const generation = browserSetupGenerationSchema.parse({
      id,
      createdAt,
      directoryIdentity: proof.value.osIdentity,
      native: receipts[0],
      configuration: receipts[1],
      manifest: receipts[2],
      desktopHash: desktop.hash,
      extensionId: developmentExtensionId,
      nativeSourceHash: inventory.nativeSourceHash,
      browsers: [...new Set(configuration.browsers.map((item) => item.kind))],
    });
    // Read every published file back through current native identity/sharing guards.
    return this.read(access, generation);
  }
  async verify(
    input: BrowserSetupGeneration,
  ): Promise<Result<BrowserInstallation>> {
    if (!this.begin())
      return this.busy
        ? failure("CONFLICT", "Browser setup files are already in use.")
        : unavailable();
    const access = new WindowsProtectedFileAccess();
    this.helpers.add(access);
    let result: Result<BrowserInstallation>;
    try {
      result = await this.read(
        access,
        browserSetupGenerationSchema.parse(input),
      );
    } catch {
      result = unavailable();
    }
    if (!(await this.finish([access]))) result = unavailable();
    return result;
  }
  private async read(
    access: WindowsProtectedFileAccess,
    generation: BrowserSetupGeneration,
  ): Promise<Result<BrowserInstallation>> {
    if (generation.extensionId !== developmentExtensionId) return unavailable();
    const directory = this.directory(generation.id),
      executable = path.join(directory, nativeName),
      manifest = path.join(directory, manifestName);
    const proof = await access.validateFolder(directory);
    if (!proof.ok || proof.value.osIdentity !== generation.directoryIdentity)
      return unavailable();
    const folder: ProtectedFolder = {
      ...proof.value,
      id: generation.id,
      selectedAt: generation.createdAt,
    };
    const names = await access.directoryEntries(folder);
    if (
      !names.ok ||
      names.value.length !== 3 ||
      ![nativeName, configurationName, manifestName].every((name) =>
        names.value.includes(name),
      )
    )
      return unavailable();
    const buffers: Uint8Array[] = [];
    for (const [name, receipt] of [
      [nativeName, generation.native],
      [configurationName, generation.configuration],
      [manifestName, generation.manifest],
    ] as const) {
      const read = await access.read(folder, name);
      if (!read.ok) return unavailable();
      if (
        read.value.osIdentity !== receipt.osIdentity ||
        read.value.bytes.length !== receipt.byteLength ||
        digest(read.value.bytes) !== receipt.contentHash
      )
        return unavailable();
      buffers.push(read.value.bytes);
    }
    const configuration = nativeBridgeConfigSchema.parse(
      JSON.parse(Buffer.from(buffers[1]!).toString("utf8")),
    );
    const host = manifestSchema.parse(
      JSON.parse(Buffer.from(buffers[2]!).toString("utf8")),
    );
    const origin = `chrome-extension://${developmentExtensionId}/`;
    const kinds = [
      ...new Set(configuration.browsers.map((item) => item.kind)),
    ].sort();
    if (
      configuration.hostHash !== generation.native.contentHash ||
      configuration.desktopHash !== generation.desktopHash ||
      configuration.pipeName !==
        `rewind.${generation.id.replaceAll("-", "")}` ||
      configuration.origins.length !== 1 ||
      configuration.origins[0] !== origin ||
      host.allowed_origins[0] !== origin ||
      host.path.toLowerCase() !== executable.toLowerCase() ||
      JSON.stringify(kinds) !== JSON.stringify([...generation.browsers].sort())
    )
      return unavailable();
    return {
      ok: true,
      value: { generation, configuration, executable, manifest },
    };
  }
}
