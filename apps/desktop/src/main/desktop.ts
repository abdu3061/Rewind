import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  Tray,
} from "electron";
import {
  failure,
  automaticFolderSchema,
  SESSION_CHANNEL,
  SESSION_CHANGED_CHANNEL,
  ACTIVITY_CHANGED_CHANNEL,
  RECORDING_CHANNEL,
  RUNTIME_CHANGED_CHANNEL,
  boundedWorkerMessage,
  type SessionAction,
  PRESENTATION_CHANNEL,
  presentationCommandSchema,
} from "@rewind/contracts";
import { dispatchSessionRequest, isTrustedRendererUrl } from "./session-ipc";
import { QuitGuard } from "./quit-guard";
import { createBackend } from "./backend";
import {
  readBrowserFixture,
  readAssistantFixture,
  validateFixtureRoot,
} from "./fixture-mode";
import { sealSyntheticAssistantCredential } from "./synthetic-assistant";
import { dispatchRecordingRequest } from "./recording-ipc";
import { AssistantConfiguration } from "./assistant-configuration";
import { NativeCredentialPrompt } from "./native-credential-prompt";
import { OperationalLog } from "./operational-log";
import { shutdownDesktop } from "./desktop-shutdown";
import { NotchWindow } from "./notch-window";
import { notchAllowsRecording } from "./notch-policy";
import { trayPresentation } from "./tray-presentation";

let fixtureRoot: string | null = null;
let browserFixture: ReturnType<typeof readBrowserFixture> = null;
let assistantFixture = false;
try {
  fixtureRoot = validateFixtureRoot(
    app.commandLine.getSwitchValue("rewind-fixture-root"),
  );
  if (fixtureRoot) app.setPath("userData", fixtureRoot);
  browserFixture = readBrowserFixture(fixtureRoot);
  assistantFixture = readAssistantFixture(fixtureRoot);
} catch {
  console.error(
    JSON.stringify({ level: "error", code: "INVALID_VERIFICATION_PROFILE" }),
  );
  app.exit(1);
}
app.setAppUserModelId("com.squirrel.Rewind.Rewind");
if (!app.requestSingleInstanceLock()) app.exit(0);
const operationalLog = new OperationalLog(
  path.join(app.getPath("userData"), "logs"),
);
operationalLog.write("DESKTOP_STARTING");
let lastService: string | null = null;
app.on("second-instance", (_event, argv) => {
  // `Rewind.exe --quit` asks the running instance for its normal acknowledged
  // shutdown, since the window's close button now keeps Rewind in the notch.
  if (argv.includes("--quit")) {
    app.quit();
    return;
  }
  notch?.open();
});
const applicationIcon = path.join(
  app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), "assets"),
  "rewind.png",
);
const browserAssets = {
  root:
    browserFixture?.root ??
    (app.isPackaged
      ? path.join(process.resourcesPath, "browser")
      : path.join(app.getAppPath(), ".generated", "browser")),
  desktopPath: process.execPath,
  ...(browserFixture ? { hostName: browserFixture.hostName } : {}),
};
const sessions = createBackend({
  root: app.getPath("userData"),
  synthetic: fixtureRoot !== null,
  automaticFolders: (["Desktop", "Documents", "Downloads"] as const).flatMap(
    (name) => {
      try {
        const location = automaticFolderSchema.safeParse({
          name,
          path: fixtureRoot
            ? path.join(fixtureRoot, name)
            : app.getPath(
                name.toLowerCase() as "desktop" | "documents" | "downloads",
              ),
        });
        return location.success ? [location.data] : [];
      } catch {
        return [];
      }
    },
  ),
  ...(assistantFixture ? { assistantFixture: true as const } : {}),
  entry: path.join(__dirname, "worker-entry.cjs"),
  documentEntry: path.join(__dirname, "document-entry.cjs"),
  documentGuard: app.isPackaged
    ? path.join(process.resourcesPath, "documents", "RewindDocumentGuard.exe")
    : path.join(
        app.getAppPath(),
        ".generated",
        "documents",
        "RewindDocumentGuard.exe",
      ),
  browserAssets,
  onSnapshot: (snapshot) => {
    if (snapshot.service === "unavailable" && lastService !== "unavailable")
      operationalLog.write("SERVICE_UNAVAILABLE");
    lastService = snapshot.service;
    publishState();
  },
  onActivity: (sessionId) => {
    for (const window of trustedWindows())
      window.webContents.send(ACTIVITY_CHANGED_CHANNEL, sessionId);
  },
});
let mainWindow: BrowserWindow | null = null;
/** Set once an explicit quit begins; until then the window's close button keeps Rewind in the notch (ADR 0042). */
let quitting = false;
let notch: NotchWindow | null = null;
let trayWindows: ReturnType<typeof trayPresentation> | null = null;
const nativeCredentialPrompt = new NativeCredentialPrompt(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const handle = mainWindow.getNativeWindowHandle();
  if (handle.length !== 8) return null;
  return {
    parent: handle.readBigUInt64LE().toString(),
    processId: process.pid,
  };
});
const assistantConfiguration = new AssistantConfiguration(sessions, {
  prompt: (challenge) =>
    assistantFixture
      ? Promise.resolve({
          ok: true as const,
          value: sealSyntheticAssistantCredential(challenge),
        })
      : nativeCredentialPrompt.prompt(challenge),
  close: () => nativeCredentialPrompt.close(),
});
let tray: Tray | null = null;
const rendererUrl =
  MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "rewind://app/index.html";
function trusted(event: Electron.IpcMainInvokeEvent): boolean {
  return (
    trustedWindows().some((window) => event.sender === window.webContents) &&
    !!event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    isTrustedRendererUrl(event.senderFrame.url, rendererUrl)
  );
}

function trustedWindows(): BrowserWindow[] {
  return [mainWindow, notch?.window].filter(
    (window): window is BrowserWindow =>
      !!window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      isTrustedRendererUrl(window.webContents.getURL(), rendererUrl),
  );
}

function publishState(): void {
  const state = sessions.getState();
  for (const window of trustedWindows()) {
    window.webContents.send(SESSION_CHANGED_CHANNEL, state);
    window.webContents.send(RUNTIME_CHANGED_CHANNEL, sessions.getSnapshot());
  }
  updateTray();
}

async function runTrayAction(action: SessionAction): Promise<void> {
  const result = await sessions.execute(action);
  if (result.ok) publishState();
  else dialog.showErrorBox("Rewind session unavailable", result.error.message);
}

function updateTray(): void {
  if (!tray) return;
  const status = sessions.getState().session?.status ?? "not started";
  const runtime = sessions.getSnapshot();
  const available = runtime.service === "ready";
  tray.setToolTip(
    `Rewind: ${status} session. Collection ${runtime.collection}.`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Rewind",
        click: () => trayWindows?.open(),
      },
      {
        label: "Show Rewind notch",
        click: () => trayWindows?.show(),
      },
      { label: "Hide notch", click: () => trayWindows?.hide() },
      {
        label: `Session: ${status} | Collection ${runtime.collection}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Start session",
        enabled: available && (status === "not started" || status === "ended"),
        click: () => runTrayAction("start"),
      },
      {
        label: "Pause session",
        enabled: available && status === "active",
        click: () => runTrayAction("pause"),
      },
      {
        label: "Resume session",
        enabled: available && status === "paused",
        click: () => runTrayAction("resume"),
      },
      {
        label: "End session",
        enabled: available && (status === "active" || status === "paused"),
        click: () => runTrayAction("end"),
      },
      { type: "separator" },
      { label: "Quit Rewind", click: () => app.quit() },
    ]),
  );
}

function installLocalProtocol(): void {
  const root = path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
  protocol.handle("rewind", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app" || request.method !== "GET")
      return new Response(null, { status: 403 });
    let assetPath: string;
    try {
      assetPath = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      return new Response(null, { status: 400 });
    }
    const relative = path.relative(root, assetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      return new Response(null, { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(assetPath).toString());
      const headers = new Headers(response.headers);
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
      );
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Rewind",
    icon: applicationIcon,
    backgroundColor: "#f5f5fc",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  secureWindow(mainWindow);
  mainWindow.on("minimize", () => {
    void notch?.showCompact().catch(() => {
      operationalLog.write("RENDERER_GONE");
      app.quit();
    });
  });
  mainWindow.on("close", (event) => {
    // The close button minimizes to the notch; quitting happens from the tray.
    if (quitting) return;
    event.preventDefault();
    mainWindow?.minimize();
  });
  // Never hold up Windows log-off, restart or shutdown.
  const endingSession = () => {
    quitting = true;
  };
  mainWindow.on("query-session-end", endingSession);
  mainWindow.on("session-end", endingSession);
  mainWindow.on("restore", () => notch?.hide());
  mainWindow.on("move", () => notch?.rememberDesktopDisplay());
  mainWindow.on("resize", () => notch?.rememberDesktopDisplay());
  mainWindow.on("show", () => notch?.hide());
  mainWindow.on("enter-full-screen", () => notch?.hide());
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
  await mainWindow.loadURL(rendererUrl);
  notch?.rememberDesktopDisplay();
}

function secureWindow(window: BrowserWindow): void {
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("render-process-gone", () => {
    operationalLog.write("RENDERER_GONE");
    // Losing the consent UI must not leave a recording session running invisibly.
    app.quit();
  });
}

app
  .whenReady()
  .then(async () => {
    if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) installLocalProtocol();
    Menu.setApplicationMenu(null);
    notch = new NotchWindow({
      desktop: () => mainWindow,
      rendererUrl,
      secure: secureWindow,
    });
    trayWindows = trayPresentation({
      desktop: () => mainWindow,
      notch,
      failed: () => app.quit(),
    });
    ipcMain.handle(PRESENTATION_CHANNEL, (event, ...args: unknown[]) => {
      if (!trusted(event))
        return failure(
          "FORBIDDEN",
          "This frame cannot control Rewind windows.",
        );
      const command = presentationCommandSchema.safeParse(args[0]);
      if (args.length !== 1 || !command.success)
        return failure("INVALID_INPUT", "A valid window action is required.");
      if (
        event.sender !== notch?.window?.webContents &&
        command.data.action !== "get" &&
        command.data.action !== "open"
      )
        return failure("FORBIDDEN", "This window cannot control the notch.");
      return notch
        ? { ok: true, value: notch.handle(command.data) }
        : failure("UNAVAILABLE", "Window service is starting.");
    });
    ipcMain.handle(SESSION_CHANNEL, async (event, ...args: unknown[]) => {
      if (!trusted(event)) {
        return failure(
          "FORBIDDEN",
          "This frame cannot access Rewind sessions.",
        );
      }
      if (args.length !== 1)
        return failure(
          "INVALID_INPUT",
          "Exactly one session command is required.",
        );
      const result = await dispatchSessionRequest(sessions, args[0]);
      if (result.ok) publishState();
      return result;
    });
    ipcMain.handle(RECORDING_CHANNEL, async (event, ...args: unknown[]) => {
      if (!trusted(event))
        return failure(
          "FORBIDDEN",
          "This frame cannot access Rewind recording.",
        );
      if (args.length !== 1 || !boundedWorkerMessage(args[0]))
        return failure(
          "INVALID_INPUT",
          "Exactly one bounded recording command is required.",
        );
      if (
        event.sender === notch?.window?.webContents &&
        !notchAllowsRecording(args[0])
      )
        return failure("FORBIDDEN", "Open Rewind to use this capability.");
      return dispatchRecordingRequest(
        sessions,
        args[0],
        async () => {
          if (!mainWindow || mainWindow.isDestroyed()) return null;
          const selected = await dialog.showOpenDialog(mainWindow, {
            title: "Choose a folder for saved file versions",
            properties: ["openDirectory"],
          });
          return selected.canceled ? null : (selected.filePaths[0] ?? null);
        },
        async (sourceName) => {
          if (!mainWindow || mainWindow.isDestroyed()) return null;
          const selected = await dialog.showSaveDialog(mainWindow, {
            title: "Choose a new file for the recovery copy",
            defaultPath: `recovered-${Array.from(path.basename(sourceName))
              .filter((character) => character.charCodeAt(0) >= 32)
              .join("")
              .replace(/[<>:"|?*]/g, "_")}`,
            buttonLabel: "Review recovery copy",
          });
          return selected.canceled ? null : (selected.filePath ?? null);
        },
        async () => {
          try {
            const error = await shell.openPath(
              path.join(browserAssets.root, "extension"),
            );
            return error
              ? failure(
                  "UNAVAILABLE",
                  "The extension folder could not be opened.",
                )
              : { ok: true, value: true };
          } catch {
            return failure(
              "UNAVAILABLE",
              "The extension folder could not be opened.",
            );
          }
        },
        async () => {
          if (!mainWindow || mainWindow.isDestroyed()) return null;
          const selected = await dialog.showOpenDialog(mainWindow, {
            title: "Choose an existing file to review for overwrite",
            buttonLabel: "Review overwrite and preservation",
            properties: ["openFile"],
          });
          return selected.canceled ? null : (selected.filePaths[0] ?? null);
        },
        () => assistantConfiguration.configure(),
      );
    });
    await sessions.start();
    tray = new Tray(
      nativeImage
        .createFromPath(applicationIcon)
        .resize({ width: 16, height: 16 }),
    );
    tray.on("double-click", () => trayWindows?.open());
    updateTray();
    await createWindow();
    operationalLog.write("DESKTOP_READY");
  })
  .catch(async () => {
    operationalLog.write("DESKTOP_START_FAILED");
    console.error(
      JSON.stringify({ level: "error", code: "DESKTOP_START_FAILED" }),
    );
    dialog.showErrorBox(
      "Rewind could not start",
      "Startup could not be completed (DESKTOP_START_FAILED). Saved history has not been reset. See the code-only operations log or reinstall the same or a newer version.",
    );
    await sessions.shutdown();
    app.exit(1);
  });

const quitGuard = new QuitGuard({
  shutdown: () => {
    notch?.hide();
    return shutdownDesktop({
      closePrompt: () => assistantConfiguration.close(),
      shutdownWorker: () => sessions.shutdown(),
    });
  },
  quit: () => {
    operationalLog.write("DESKTOP_STOPPED");
    tray?.destroy();
    tray = null;
    notch?.dispose();
    app.quit();
  },
  failed: () => {
    operationalLog.write("DESKTOP_SHUTDOWN_FAILED");
    console.error(
      JSON.stringify({ level: "error", code: "DESKTOP_SHUTDOWN_FAILED" }),
    );
    dialog.showErrorBox(
      "Rewind could not finish shutting down",
      "Background cleanup could not be verified. Collection is disabled. Retry Quit to finish safely.",
    );
  },
});
app.on("before-quit", (event) => {
  quitting = true;
  quitGuard.beforeQuit(event);
});
app.on("window-all-closed", () => app.quit());
