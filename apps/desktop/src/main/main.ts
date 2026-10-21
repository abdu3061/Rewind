import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, protocol, Tray } from 'electron';
import {
  failure,
  SESSION_CHANNEL,
  SESSION_CHANGED_CHANNEL,
  type SessionAction,
} from '@rewind/contracts';
import { SessionService } from '@rewind/engine';
import { dispatchSessionRequest, isTrustedRendererUrl } from './session-ipc';

protocol.registerSchemesAsPrivileged([
  { scheme: 'rewind', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const sessions = new SessionService({ newId: randomUUID, now: () => new Date().toISOString() });
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? 'rewind://app/index.html';

function publishState(): void {
  const state = sessions.getState();
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    isTrustedRendererUrl(mainWindow.webContents.getURL(), rendererUrl)
  ) {
    mainWindow.webContents.send(SESSION_CHANGED_CHANNEL, state);
  }
  updateTray();
}

function runTrayAction(action: SessionAction): void {
  const result = sessions.execute(action);
  if (result.ok) publishState();
}

function updateTray(): void {
  if (!tray) return;
  const status = sessions.getState().session?.status ?? 'not started';
  tray.setToolTip(`Rewind: ${status} session. Collection off.`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Rewind',
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { label: `Session: ${status} | Collection off`, enabled: false },
      { type: 'separator' },
      {
        label: 'Start session',
        enabled: status === 'not started' || status === 'ended',
        click: () => runTrayAction('start'),
      },
      { label: 'Pause session', enabled: status === 'active', click: () => runTrayAction('pause') },
      {
        label: 'Resume session',
        enabled: status === 'paused',
        click: () => runTrayAction('resume'),
      },
      {
        label: 'End session',
        enabled: status === 'active' || status === 'paused',
        click: () => runTrayAction('end'),
      },
      { type: 'separator' },
      { label: 'Quit Rewind', click: () => app.quit() },
    ]),
  );
}

function installLocalProtocol(): void {
  const root = path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
  protocol.handle('rewind', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app' || request.method !== 'GET') return new Response(null, { status: 403 });
    let assetPath: string;
    try {
      assetPath = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      return new Response(null, { status: 400 });
    }
    const relative = path.relative(root, assetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      return new Response(null, { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(assetPath).toString());
      const headers = new Headers(response.headers);
      headers.set(
        'Content-Security-Policy',
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
    title: 'Rewind',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
  await mainWindow.loadURL(rendererUrl);
}

app
  .whenReady()
  .then(async () => {
    if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) installLocalProtocol();
    ipcMain.handle(SESSION_CHANNEL, (event, ...args: unknown[]) => {
      if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        !isTrustedRendererUrl(event.senderFrame.url, rendererUrl)
      ) {
        return failure('FORBIDDEN', 'This frame cannot access Rewind sessions.');
      }
      if (args.length !== 1)
        return failure('INVALID_INPUT', 'Exactly one session command is required.');
      const result = dispatchSessionRequest(sessions, args[0]);
      if (result.ok) publishState();
      return result;
    });
    // A simple native bitmap avoids external icon assets in the initialization build.
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let i = 0; i < 16 * 16; i++) {
      pixels.set([130, 80, 40, 255], i * 4);
    }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
    updateTray();
    await createWindow();
  })
  .catch(() => {
    console.error(JSON.stringify({ level: 'error', code: 'DESKTOP_START_FAILED' }));
    app.exit(1);
  });

app.on('before-quit', () => {
  const status = sessions.getState().session?.status;
  if (status === 'active' || status === 'paused') sessions.execute('end');
  tray?.destroy();
  tray = null;
});
app.on('window-all-closed', () => app.quit());
