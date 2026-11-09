import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  Tray,
} from "electron";
import { createCollectorRegistry } from "@rewind/collectors";
import {
  createDefaultSettings,
  failure,
  SESSION_CHANNEL,
  SESSION_CHANGED_CHANNEL,
  type SessionAction,
  type UserSettings,
} from "@rewind/contracts";
import { SessionCoordinator, SessionService } from "@rewind/engine";
import { SqliteStorageAdapter } from "@rewind/storage";
import { dispatchSessionRequest, isTrustedRendererUrl } from "./session-ipc";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "rewind",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const sessionService = new SessionService({
  newId: randomUUID,
  now: () => new Date().toISOString(),
});

const userSettings: UserSettings = {
  ...createDefaultSettings(),
  collectionConsent: true,
};

let storage: SqliteStorageAdapter | null = null;
let coordinator: SessionCoordinator | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const rendererUrl =
  MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "rewind://app/index.html";

function resolveMigrationPath(): string | undefined {
  const candidates = [
    path.resolve(app.getAppPath(), "db/migrations/001_initial.sql"),
    path.resolve(app.getAppPath(), "../db/migrations/001_initial.sql"),
    path.resolve(process.cwd(), "db/migrations/001_initial.sql"),
    path.resolve(__dirname, "../../../../db/migrations/001_initial.sql"),
    path.resolve(__dirname, "../../../db/migrations/001_initial.sql"),
    path.resolve(__dirname, "../../db/migrations/001_initial.sql"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

function publishState(): void {
  const state = coordinator
    ? coordinator.getState()
    : sessionService.getState();
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    isTrustedRendererUrl(mainWindow.webContents.getURL(), rendererUrl)
  ) {
    mainWindow.webContents.send(SESSION_CHANGED_CHANNEL, state);
  }
  updateTray();
}

async function runTrayAction(action: SessionAction): Promise<void> {
  const target = coordinator ?? sessionService;
  const result = await target.execute(action);
  if (result.ok) publishState();
}

function updateTray(): void {
  if (!tray) return;
  const status =
    (coordinator ? coordinator.getState() : sessionService.getState()).session
      ?.status ?? "not started";
  const isCollecting = status === "active" && userSettings.collectionConsent;
  tray.setToolTip(
    `Rewind: ${status} session. Collection ${isCollecting ? "on" : "off"}.`,
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
        label: `Session: ${status} | Collection ${isCollecting ? "on" : "off"}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Start session",
        enabled: status === "not started" || status === "ended",
        click: () => void runTrayAction("start"),
      },
      {
        label: "Pause session",
        enabled: status === "active",
        click: () => void runTrayAction("pause"),
      },
      {
        label: "Resume session",
        enabled: status === "paused",
        click: () => void runTrayAction("resume"),
      },
      {
        label: "End session",
        enabled: status === "active" || status === "paused",
        click: () => void runTrayAction("end"),
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
    // 1. Initialize persistent SQLite database
    const dbPath = path.join(app.getPath("userData"), "rewind.sqlite");
    const migrationPath = resolveMigrationPath();
    storage = new SqliteStorageAdapter(dbPath, migrationPath);
 HEAD
    const openResult = await storage.open();
    if (!openResult.ok) {
      throw new Error(openResult.error.message);

    const openRes = await storage.open();
    if (!openRes.ok) {
      console.warn(
        `[main] Failed to open storage at ${dbPath}: ${openRes.error.message}. Falling back to in-memory database.`,
      );
      storage = new SqliteStorageAdapter(":memory:");
      await storage.open();
    }

    // 2. Initialize tracking modules and coordination engine
    const collectors = createCollectorRegistry();
    coordinator = new SessionCoordinator({
      service: sessionService,
      repositories: storage.repositories,
      collectors,
      getSettings: () => userSettings,
    });

    if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) installLocalProtocol();
    ipcMain.handle(SESSION_CHANNEL, async (event, ...args: unknown[]) => {
      if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        !isTrustedRendererUrl(event.senderFrame.url, rendererUrl)
      ) {
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
      const target = coordinator ?? sessionService;
      const result = await dispatchSessionRequest(target, args[0]);
      if (result.ok) publishState();
      return result;
    });

    // Simple native bitmap for tray icon
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
  .catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        code: "DESKTOP_START_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    app.exit(1);
  });

app.on("before-quit", async () => {
  const target = coordinator ?? sessionService;
  const status = target.getState().session?.status;
  if (status === "active" || status === "paused") {
    await target.execute("end");
  }
  if (storage) {
    await storage.close();
    storage = null;
  }
  tray?.destroy();
  tray = null;
});

app.on("window-all-closed", () => app.quit());
