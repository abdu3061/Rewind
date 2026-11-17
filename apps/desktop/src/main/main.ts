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
  Tray,
} from "electron";
import {
  failure,
  SESSION_CHANNEL,
  SESSION_CHANGED_CHANNEL,
  ACTIVITY_CHANGED_CHANNEL,
  RECORDING_CHANNEL,
  RUNTIME_CHANGED_CHANNEL,
  boundedWorkerMessage,
  type SessionAction,
} from "@rewind/contracts";
import { dispatchSessionRequest, isTrustedRendererUrl } from "./session-ipc";
import { QuitGuard } from "./quit-guard";
import { createBackend } from "./backend";
import { validateFixtureRoot } from "./fixture-mode";
import { dispatchRecordingRequest } from "./recording-ipc";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "rewind",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let fixtureRoot: string | null = null;
try {
  fixtureRoot = validateFixtureRoot(
    app.commandLine.getSwitchValue("rewind-fixture-root"),
  );
  if (fixtureRoot) app.setPath("userData", fixtureRoot);
} catch {
  console.error(
    JSON.stringify({ level: "error", code: "INVALID_VERIFICATION_PROFILE" }),
  );
  app.exit(1);
}
const sessions = createBackend({
  root: app.getPath("userData"),
  synthetic: fixtureRoot !== null,
  entry: path.join(__dirname, "worker-entry.cjs"),
  onSnapshot: () => publishState(),
  onActivity: (sessionId) => {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      isTrustedRendererUrl(mainWindow.webContents.getURL(), rendererUrl)
    )
      mainWindow.webContents.send(ACTIVITY_CHANGED_CHANNEL, sessionId);
  },
});
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const rendererUrl =
  MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "rewind://app/index.html";
function trusted(event: Electron.IpcMainInvokeEvent): boolean {
  return (
    !!mainWindow &&
    event.sender === mainWindow.webContents &&
    !!event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    isTrustedRendererUrl(event.senderFrame.url, rendererUrl)
  );
}

function publishState(): void {
  const state = sessions.getState();
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    isTrustedRendererUrl(mainWindow.webContents.getURL(), rendererUrl)
  ) {
    mainWindow.webContents.send(SESSION_CHANGED_CHANNEL, state);
    mainWindow.webContents.send(
      RUNTIME_CHANGED_CHANNEL,
      sessions.getSnapshot(),
    );
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
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
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
    backgroundColor: "#f5f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
  await mainWindow.loadURL(rendererUrl);
}

app
  .whenReady()
  .then(async () => {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) installLocalProtocol();
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
      );
    });
    await sessions.start();
    // A simple native bitmap avoids external icon assets in the initialization build.
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let i = 0; i < 16 * 16; i++) {
      pixels.set([130, 80, 40, 255], i * 4);
    }
    tray = new Tray(
      nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }),
    );
    updateTray();
    await createWindow();
  })
  .catch(() => {
    console.error(
      JSON.stringify({ level: "error", code: "DESKTOP_START_FAILED" }),
    );
    app.exit(1);
  });

const quitGuard = new QuitGuard({
  shutdown: () => sessions.shutdown(),
  quit: () => {
    tray?.destroy();
    tray = null;
    app.quit();
  },
  failed: () => {
    console.error(
      JSON.stringify({ level: "error", code: "DESKTOP_SHUTDOWN_FAILED" }),
    );
    dialog.showErrorBox(
      "Rewind could not finish shutting down",
      "Background cleanup could not be verified. Collection is disabled. Retry Quit to finish safely.",
    );
  },
});
app.on("before-quit", (event) => quitGuard.beforeQuit(event));
app.on("window-all-closed", () => app.quit());
