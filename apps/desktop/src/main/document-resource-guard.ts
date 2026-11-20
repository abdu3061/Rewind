import { spawn } from "node:child_process";
import type { DocumentGuard } from "./document-process";
import { documentEnvironment } from "./document-environment";

/** The executable must be a trusted build/packaged asset, never a public command path. */
export async function admitDocumentProcess(
  executable: string,
  pid: number,
  signal: AbortSignal,
  lost: () => void,
): Promise<DocumentGuard | null> {
  if (
    process.platform !== "win32" ||
    signal.aborted ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  )
    return null;
  const child = spawn(executable, [String(process.pid), String(pid)], {
    windowsHide: true,
    stdio: "pipe",
    env: documentEnvironment(),
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let stopping = false,
    output = "",
    ready = false,
    resolveReady!: (value: DocumentGuard | null) => void;
  const result = new Promise<DocumentGuard | null>((resolve) => {
    resolveReady = resolve;
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    try {
      child.stdin.end();
    } catch {
      /* Wait for the actual close event. */
    }
    // Closing the sole job handle kills the parser even if stdin was not serviced.
    try {
      child.kill();
    } catch {
      /* Keep the live handle until closure. */
    }
  };
  const guard: DocumentGuard = { closed, close: stop };
  const timer = setTimeout(stop, 4000);
  signal.addEventListener("abort", stop, { once: true });
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    output += data;
    if (
      output.length > 64 ||
      ready ||
      (output.includes("\n") && output.trim() !== "DOCUMENT_RESOURCE_READY")
    )
      return stop();
    if (
      output === "DOCUMENT_RESOURCE_READY\r\n" ||
      output === "DOCUMENT_RESOURCE_READY\n"
    ) {
      if (stopping || signal.aborted) return stop();
      ready = true;
      clearTimeout(timer);
      resolveReady(guard);
    }
  });
  child.on("error", stop);
  child.stdin.on("error", stop);
  child.once("close", () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    resolveClosed();
    resolveReady(null);
    if (!stopping) lost();
  });
  if (signal.aborted) stop();
  return result;
}
