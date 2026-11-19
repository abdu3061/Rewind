import {
  boundedWorkerMessage,
  failure,
  workerInputSchema,
  workerOutputSchema,
  workerDocumentOutputSchema,
  type WorkerOutput,
} from "@rewind/contracts";
import { WorkerRuntime } from "./worker-runtime";
import { RecordingDocumentClient } from "./document-client";

const port = process.parentPort;
if (!port) throw new Error("WORKER_PARENT_REQUIRED");
let bootId: string | null = null;
let runtime: WorkerRuntime | null = null;
let documents: RecordingDocumentClient | null = null;
let initializing = false;
let requests = 0;
let lastHeartbeat = Date.now();
let ending = false;
function send(message: WorkerOutput): void {
  if (ending) return;
  if (
    (workerDocumentOutputSchema.safeParse(message).success ||
      boundedWorkerMessage(message)) &&
    workerOutputSchema.safeParse(message).success
  ) {
    try {
      port!.postMessage(message);
      return;
    } catch {
      // A disconnected supervisor must not leave an autonomous recording process.
    }
  }
  ending = true;
  void runtime?.shutdown().finally(() => process.exit(1));
}
port.on("message", async ({ data }: { data: unknown }) => {
  if (!boundedWorkerMessage(data)) return;
  const parsed = workerInputSchema.safeParse(data);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.type === "init") {
    if (bootId || initializing) {
      message.key.fill(0);
      return;
    }
    bootId = message.bootId;
    initializing = true;
    documents = new RecordingDocumentClient((request) =>
      send({ ...request, bootId: message.bootId }),
    );
    runtime = new WorkerRuntime({
      root: message.root,
      key: message.key,
      synthetic: message.synthetic,
      ...(message.automaticFolders
        ? { automaticFolders: message.automaticFolders }
        : {}),
      documentProcessor: documents,
      ...(message.assistantFixture ? { assistantFixture: true as const } : {}),
      ...(message.browserAssets
        ? { browserAssets: message.browserAssets }
        : {}),
      onSnapshot: (state) =>
        send({ version: 1, type: "snapshot", bootId: message.bootId, state }),
      onActivity: (sessionId) =>
        send({
          version: 1,
          type: "activity",
          bootId: message.bootId,
          sessionId,
        }),
    });
    const ready = await runtime.initialize();
    initializing = false;
    lastHeartbeat = Date.now();
    if (ready.ok) {
      send({ version: 1, type: "ready", bootId, state: ready.value });
      // Keep the supervisor's secure/default-off ready handshake intact. Only
      // the first worker boot of an app launch may renew remembered approval.
      if (message.automaticStart) await runtime.restoreAutomaticRecording();
    } else send({ version: 1, type: "fault", bootId, error: ready.error });
    return;
  }
  if (message.bootId !== bootId) return;
  lastHeartbeat = Date.now();
  if (message.type === "heartbeat") return;
  if (
    message.type === "document-result" ||
    message.type === "document-stopped"
  ) {
    documents?.receive({
      version: 1,
      type: message.type,
      id: message.id,
      closed: message.closed,
      ...(message.type === "document-result" ? { result: message.result } : {}),
    });
    return;
  }
  if (!runtime || initializing || ending || requests >= 64) {
    send({
      version: 1,
      type: "reply",
      bootId,
      id: message.id,
      kind: message.command.kind,
      result: failure(
        "UNAVAILABLE",
        "Worker is not available for this command.",
      ),
    });
    return;
  }
  requests++;
  try {
    const result = await runtime.execute(message.command);
    send({
      version: 1,
      type: "reply",
      bootId,
      id: message.id,
      kind: message.command.kind,
      result,
    });
    if (message.command.kind === "shutdown" && result.ok) {
      ending = true;
      clearInterval(lease);
    }
  } finally {
    requests--;
  }
});
const lease = setInterval(() => {
  if (
    bootId &&
    runtime &&
    !initializing &&
    !ending &&
    Date.now() - lastHeartbeat > 6000
  ) {
    ending = true;
    void runtime.shutdown().finally(() => process.exit(1));
  }
}, 1000);
