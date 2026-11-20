import { failure } from "@rewind/contracts";
import { ExtensionController } from "./extension-controller";
import {
  extensionControlSender,
  extensionControlContexts,
  browserDocumentIdSchema,
  extensionRequestSchema,
} from "./extension-controls";
import {
  focusedBrowserTab,
  type BrowserMetadataAccess,
} from "./focused-tab-provider";

const profileKey = "rewindProfileIdV1";
const access: BrowserMetadataAccess = {
  lastFocusedWindow: () =>
    chrome.windows.getLastFocused({ populate: false, windowTypes: ["normal"] }),
  activeTabs: (windowId) => chrome.tabs.query({ active: true, windowId }),
  window: (windowId) => chrome.windows.get(windowId, { populate: false }),
};
let previousAction = "";
const controller = new ExtensionController({
  loadProfile: async () =>
    (await chrome.storage.local.get(profileKey))[profileKey],
  saveProfile: (id) => chrome.storage.local.set({ [profileKey]: id }),
  hasBrowserPermissions: () =>
    chrome.permissions.contains({ permissions: ["tabs", "nativeMessaging"] }),
  getFocusedTab: (authorized) => focusedBrowserTab(access, authorized),
  connect: () => {
    const port = chrome.runtime.connectNative(__REWIND_NATIVE_HOST_NAME__);
    return {
      postMessage: (message) => port.postMessage(message),
      disconnect: () => port.disconnect(),
      onMessage: (listener) => {
        port.onMessage.addListener(listener);
        return () => port.onMessage.removeListener(listener);
      },
      onDisconnect: (listener) => {
        const disconnected = () => {
          void chrome.runtime.lastError;
          listener();
        };
        port.onDisconnect.addListener(disconnected);
        return () => port.onDisconnect.removeListener(disconnected);
      },
    };
  },
  onChanged: (status) => {
    const action = status.collecting
      ? "Recording approved by the desktop session"
      : status.permission
        ? "Waiting for an approved desktop session"
        : "Recording off";
    if (action === previousAction) return;
    previousAction = action;
    void chrome.action
      .setTitle({ title: `Rewind: ${action}` })
      .catch(() => undefined);
    void chrome.action
      .setBadgeText({ text: status.collecting ? "ON" : "" })
      .catch(() => undefined);
  },
});
// Only a random nonsecret profile tag is loaded. No grant, native connection or browser query starts here.
void controller.initialize();
chrome.runtime.onInstalled.addListener(() => {
  void controller.permission(false);
});
chrome.runtime.onStartup.addListener(() => {
  void controller.permission(false);
});
chrome.permissions.onRemoved.addListener((permissions) => {
  if (
    permissions.permissions?.some(
      (name) => name === "tabs" || name === "nativeMessaging",
    )
  )
    void controller.permission(false);
});
chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    if (
      !extensionControlSender(sender, chrome.runtime.id) ||
      (sender.documentId !== undefined &&
        !browserDocumentIdSchema.safeParse(sender.documentId).success)
    ) {
      sendResponse(
        failure(
          "FORBIDDEN",
          "Only Rewind's own controls page can use this capability.",
        ),
      );
      return false;
    }
    const command = extensionRequestSchema.safeParse(message);
    void controller
      .request(message, async () => {
        // This exact private controls page cannot be embedded (manifest CSP). Its denial must not wait for a closing popup.
        if (
          command.success &&
          command.data.kind === "rewind.browser.permission" &&
          !command.data.enabled
        )
          return true;
        const contexts = await chrome.runtime.getContexts(
          sender.documentId
            ? { documentIds: [sender.documentId] }
            : {
                contextTypes: ["POPUP"],
                documentUrls: [chrome.runtime.getURL("status.html")],
              },
        );
        return extensionControlContexts(
          contexts,
          {
            documentId: sender.documentId,
            frameId: sender.frameId,
            hasTab: sender.tab !== undefined,
          },
          chrome.runtime.id,
        );
      })
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          failure(
            "UNAVAILABLE",
            "The extension control could not be confirmed.",
          ),
        ),
      );
    return true;
  },
);
