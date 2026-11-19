import path from "node:path";
import { utilityProcess, safeStorage } from "electron";
import { ProtectedKeyStore } from "@rewind/storage/key-store";
import { WorkerClient } from "./worker-client";
import { createDocumentBackend } from "./document-backend";
import type {
  AutomaticFolder,
  BrowserAssetsLocation,
  RuntimeSnapshot,
} from "@rewind/contracts";

export function createBackend(options: {
  root: string;
  synthetic: boolean;
  automaticFolders?: AutomaticFolder[];
  assistantFixture?: true;
  entry: string;
  documentEntry: string;
  documentGuard: string;
  browserAssets?: BrowserAssetsLocation;
  onSnapshot: (snapshot: RuntimeSnapshot) => void;
  onActivity: (sessionId: string) => void;
}): WorkerClient {
  const keys = new ProtectedKeyStore(path.join(options.root, "secure"), {
    available: async () =>
      process.platform === "win32" &&
      (await safeStorage.isAsyncEncryptionAvailable()),
    protect: async (bytes) =>
      safeStorage.encryptStringAsync(Buffer.from(bytes).toString("base64")),
    unprotect: async (bytes) => {
      const result = await safeStorage.decryptStringAsync(Buffer.from(bytes));
      if (result.shouldReEncrypt)
        throw new Error("WINDOWS_KEY_PROTECTION_UNAVAILABLE");
      const key = Buffer.from(result.result, "base64");
      if (key.length !== 32 || key.toString("base64") !== result.result)
        throw new Error("PROTECTED_KEY_INVALID");
      return key;
    },
  });
  return new WorkerClient({
    root: path.join(options.root, "secure"),
    synthetic: options.synthetic,
    ...(options.automaticFolders
      ? { automaticFolders: options.automaticFolders }
      : {}),
    documents: createDocumentBackend(
      options.documentEntry,
      options.documentGuard,
    ),
    ...(options.assistantFixture ? { assistantFixture: true as const } : {}),
    ...(options.browserAssets ? { browserAssets: options.browserAssets } : {}),
    loadKey: () => keys.load(),
    spawn: () => {
      const child = utilityProcess.fork(options.entry, [], {
        serviceName: "Rewind recording engine",
        stdio: "pipe",
      });
      // Drain rather than logging arbitrary native diagnostics or personal evidence.
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});
      return child;
    },
    onSnapshot: options.onSnapshot,
    onActivity: options.onActivity,
  });
}
