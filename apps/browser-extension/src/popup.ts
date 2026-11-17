import {
  extensionResponseSchema,
  type ExtensionStatus,
} from "./extension-controls";
import { failure, type Result } from "@rewind/contracts";

const status = document.querySelector<HTMLParagraphElement>("#status"),
  error = document.querySelector<HTMLParagraphElement>("#error"),
  button = document.querySelector<HTMLButtonElement>("#permission");
if (!status || !error || !button) throw new Error("EXTENSION_CONTROLS_MISSING");
let current: ExtensionStatus | null = null,
  pending = false,
  reading = false,
  generation = 0;
let errorSource: "status" | "action" | null = null;
function render(): void {
  if (!current || current.service !== "ready") {
    status!.textContent =
      current?.service === "unavailable"
        ? "Extension storage is unavailable. Reload the extension."
        : "Loading extension controls…";
    button!.disabled = true;
    return;
  }
  status!.textContent = pending
    ? current.permission
      ? "Stopping browser recording…"
      : "Connecting to Rewind…"
    : current.pending && !current.permission
      ? "Stopping pending browser work…"
      : current.issue
        ? "The desktop connection is unavailable. Check Rewind browser setup and connect again."
        : current.collecting
          ? "Recording is approved for the current desktop session."
          : current.permission
            ? "Waiting for an approved active session in Rewind."
            : "Recording is off.";
  button!.textContent = current.permission
    ? "Stop recording"
    : "Allow and connect";
  button!.disabled = pending || current.pending;
}
async function request(input: unknown): Promise<Result<ExtensionStatus>> {
  try {
    const parsed = extensionResponseSchema.safeParse(
      await chrome.runtime.sendMessage(input),
    );
    if (!parsed.success) {
      return failure(
        "INTEGRITY_FAILURE",
        "The extension returned an invalid response.",
      );
    }
    return parsed.data;
  } catch {
    return failure(
      "UNAVAILABLE",
      "The extension controls are unavailable. Reload the extension.",
    );
  }
}
async function refresh(): Promise<void> {
  if (pending || reading) return;
  reading = true;
  const ticket = generation;
  try {
    const result = await request({ kind: "rewind.browser.status" });
    if (ticket !== generation) return;
    if (result.ok) {
      current = result.value;
      if (errorSource === "status") {
        error!.textContent = "";
        errorSource = null;
      }
    } else {
      error!.textContent = result.error.message;
      errorSource = "status";
    }
    render();
  } finally {
    reading = false;
  }
}
button.addEventListener("click", async () => {
  if (pending || !current || current.service !== "ready") return;
  const ticket = ++generation;
  pending = true;
  error.textContent = "";
  errorSource = null;
  render();
  try {
    const result = await request({
      kind: "rewind.browser.permission",
      enabled: !current.permission,
    });
    if (ticket !== generation) return;
    if (result.ok) current = result.value;
    else {
      error.textContent = result.error.message;
      errorSource = "action";
    }
  } finally {
    if (ticket === generation) {
      pending = false;
      render();
      void refresh();
    }
  }
});
const timer = setInterval(() => {
  void refresh();
}, 500);
window.addEventListener("pagehide", () => {
  clearInterval(timer);
  generation++;
});
void refresh();
