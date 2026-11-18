import { utilityProcess } from "electron";
import { DocumentProcess } from "./document-process";
import { admitDocumentProcess } from "./document-resource-guard";
import { documentEnvironment } from "./document-environment";

/** Trusted composition paths only; never exposed through renderer/preload requests. */
export function createDocumentBackend(
  entry: string,
  guard: string,
): DocumentProcess {
  return new DocumentProcess({
    spawn: () => {
      const child = utilityProcess.fork(entry, [], {
        serviceName: "Rewind document text preview",
        stdio: "pipe",
        env: documentEnvironment(),
        execArgv: [
          "--max-old-space-size=192",
          "--disallow-code-generation-from-strings",
        ],
      });
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});
      return child;
    },
    admit: (pid, signal, lost) =>
      admitDocumentProcess(guard, pid, signal, lost),
  });
}
