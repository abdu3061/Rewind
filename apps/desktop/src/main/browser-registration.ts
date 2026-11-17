import { execFile } from "node:child_process";
import { win32 as path } from "node:path";
import { z } from "zod";
import { failure, resultSchema, type Result } from "@rewind/contracts";
import { browserHostName } from "./browser-assets";

const windowsPath = z
  .string()
  .min(4)
  .max(240)
  .refine(
    (value) =>
      /^[a-z]:\\/i.test(value) &&
      !value.includes("/") &&
      !value.slice(2).includes(":") &&
      [...value].every((character) => character.charCodeAt(0) >= 32) &&
      path.normalize(value).toLowerCase() === value.toLowerCase() &&
      value
        .slice(3)
        .split("\\")
        .every((part) => part && !/[. ]$/.test(part)),
  );
const requestSchema = z.strictObject({
  version: z.literal(1),
  operation: z.enum(["inspect", "install", "remove"]),
  browser: z.enum(["chrome", "edge"]),
  name: z
    .string()
    .regex(/^(com\.rewind\.bridge|com\.rewind\.test\.[a-f0-9]{32})$/),
  manifest: windowsPath.refine((value) =>
    value.toLowerCase().endsWith(".json"),
  ),
  previous: windowsPath.nullable(),
});
export const browserRegistrationStateSchema = z
  .strictObject({
    state: z.enum(["absent", "registered", "partial", "conflict"]),
    registeredViews: z.number().int().min(0).max(2),
  })
  .refine((value) =>
    value.state === "registered"
      ? value.registeredViews === 2
      : value.state === "absent"
        ? value.registeredViews === 0
        : value.state === "partial"
          ? value.registeredViews === 1
          : true,
  );
export type BrowserRegistrationState = z.infer<
  typeof browserRegistrationStateSchema
>;
const response = resultSchema(browserRegistrationStateSchema);
const unavailable = () =>
  failure(
    "UNAVAILABLE",
    "Browser host registration could not be confirmed. Inspect setup before retrying.",
  );

/** Utility-owned setup primitive. Caller verifies assets/receipts and explicit setup confirmation first. */
export class NativeBrowserRegistration {
  private busy = false;
  constructor(
    private readonly executable: string,
    private readonly name: string = browserHostName,
  ) {}
  inspect(
    browser: "chrome" | "edge",
    manifest: string,
  ): Promise<Result<BrowserRegistrationState>> {
    return this.run("inspect", browser, manifest, null);
  }
  install(
    browser: "chrome" | "edge",
    manifest: string,
    previous: string | null,
  ): Promise<Result<BrowserRegistrationState>> {
    return this.run("install", browser, manifest, previous);
  }
  remove(
    browser: "chrome" | "edge",
    manifest: string,
  ): Promise<Result<BrowserRegistrationState>> {
    return this.run("remove", browser, manifest, null);
  }
  private async run(
    operation: "inspect" | "install" | "remove",
    browser: "chrome" | "edge",
    manifest: string,
    previous: string | null,
  ): Promise<Result<BrowserRegistrationState>> {
    const parsed = requestSchema.safeParse({
      version: 1,
      operation,
      browser,
      name: this.name,
      manifest,
      previous,
    });
    if (
      process.platform !== "win32" ||
      !windowsPath.safeParse(this.executable).success ||
      !this.executable.toLowerCase().endsWith(".exe") ||
      !parsed.success
    )
      return failure(
        "INVALID_INPUT",
        "Browser host registration requires verified Windows setup paths.",
      );
    if (this.busy)
      return failure(
        "CONFLICT",
        "A browser setup operation is already in progress.",
      );
    this.busy = true;
    try {
      return await new Promise<Result<BrowserRegistrationState>>((resolve) => {
        const child = execFile(
          this.executable,
          ["--registration"],
          {
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 4096,
            encoding: "utf8",
          },
          (error, output) => {
            if (error) {
              resolve(unavailable());
              return;
            }
            try {
              const reply = response.safeParse(JSON.parse(output));
              if (!reply.success) {
                resolve(unavailable());
                return;
              }
              if (
                reply.data.ok &&
                operation !== "inspect" &&
                reply.data.value.state !==
                  (operation === "install" ? "registered" : "absent")
              ) {
                resolve(unavailable());
                return;
              }
              resolve(reply.data);
            } catch {
              resolve(unavailable());
            }
          },
        );
        child.stdin?.on("error", () => {
          /* Exit/callback determines the result; no early success. */
        });
        child.stdin?.end(`${JSON.stringify(parsed.data)}\n`);
      });
    } catch {
      return unavailable();
    } finally {
      this.busy = false;
    }
  }
}
