import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/** Capture provenance during generation, never infer build source from a later checkout. */
export async function generateBuildReceipt(
  desktopDirectory: string,
): Promise<void> {
  const run = promisify(execFile);
  const options = { cwd: desktopDirectory, windowsHide: true };
  const source = (
    await run("git", ["rev-parse", "HEAD"], options)
  ).stdout.trim();
  const dirty =
    (await run("git", ["status", "--porcelain"], options)).stdout.trim()
      .length > 0;
  const lockSha256 = createHash("sha256")
    .update(
      await readFile(path.resolve(desktopDirectory, "../../package-lock.json")),
    )
    .digest("hex");
  const output = path.join(desktopDirectory, ".generated", "release");
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "build.json"),
    `${JSON.stringify({ format: 1, source, dirty, mode: process.env.REWIND_RELEASE_ARTIFACT === "1" ? "release" : "verification", lockSha256, node: process.version }, null, 2)}\n`,
  );
}
