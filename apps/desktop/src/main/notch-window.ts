import path from "node:path";
import { BrowserWindow, screen } from "electron";
import {
  PRESENTATION_CHANGED_CHANNEL,
  type PresentationCommand,
  type PresentationState,
  type DesktopPage,
} from "@rewind/contracts";
import { notchBounds } from "./notch-policy";

export class NotchWindow {
  window: BrowserWindow | null = null;
  private displayId: number | null = null;
  private showing = false;
  private height = 270;
  private loading: Promise<void> | null = null;
  private state: PresentationState = {
    revision: 0,
    notchVisible: false,
    expanded: false,
    navigation: null,
  };

  constructor(
    private readonly options: {
      desktop: () => BrowserWindow | null;
      rendererUrl: string;
      secure: (window: BrowserWindow) => void;
    },
  ) {
    screen.on("display-metrics-changed", this.reposition);
    screen.on("display-added", this.reposition);
    screen.on("display-removed", this.reposition);
  }

  snapshot(): PresentationState {
    return this.state;
  }

  rememberDesktopDisplay(): void {
    const desktop = this.options.desktop();
    if (desktop && !desktop.isDestroyed() && !desktop.isMinimized())
      this.displayId = screen.getDisplayMatching(desktop.getBounds()).id;
  }

  private publish(): void {
    this.state = { ...this.state, revision: this.state.revision + 1 };
    for (const window of [this.window, this.options.desktop()]) {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(PRESENTATION_CHANGED_CHANNEL, this.state);
    }
  }

  private reposition = (): void => {
    if (!this.window || this.window.isDestroyed()) return;
    const display =
      screen.getAllDisplays().find((item) => item.id === this.displayId) ??
      screen.getPrimaryDisplay();
    this.displayId = display.id;
    // Never span displays or convert these DIPs to physical pixels a second time.
    this.window.setBounds(
      notchBounds(display.workArea, this.state.expanded, this.height),
    );
  };

  private async ensureWindow(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.window && !this.window.isDestroyed()) return;
    const window = new BrowserWindow({
      ...notchBounds(screen.getPrimaryDisplay().workArea, false),
      title: "Rewind notch",
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        additionalArguments: ["--rewind-surface=notch"],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.window = window;
    window.on("page-title-updated", (event) => event.preventDefault());
    // A normal floating level intentionally yields to exclusive fullscreen apps.
    window.setAlwaysOnTop(true, "floating");
    this.options.secure(window);
    window.on("blur", () => this.collapse());
    window.on("closed", () => {
      this.window = null;
      this.state = { ...this.state, notchVisible: false, expanded: false };
      this.publish();
    });
    this.loading = window.loadURL(`${this.options.rendererUrl}#notch`);
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async showCompact(): Promise<void> {
    this.showing = true;
    // Do not infer a monitor from Windows' minimized-window sentinel bounds.
    this.rememberDesktopDisplay();
    await this.ensureWindow();
    // Restore/Quit may have overtaken asynchronous renderer startup.
    if (!this.showing || !this.window || this.window.isDestroyed()) return;
    this.state = { ...this.state, notchVisible: true, expanded: false };
    this.reposition();
    this.window.showInactive();
    this.publish();
  }

  hide(): void {
    this.showing = false;
    this.window?.hide();
    this.state = { ...this.state, notchVisible: false, expanded: false };
    this.reposition();
    this.publish();
  }

  collapse(): void {
    if (!this.state.expanded) return;
    this.state = { ...this.state, expanded: false };
    this.reposition();
    this.publish();
  }

  open(page?: DesktopPage): void {
    this.hide();
    if (page) {
      this.state = {
        ...this.state,
        navigation: { page, revision: this.state.revision + 1 },
      };
      this.publish();
    }
    const desktop = this.options.desktop();
    if (!desktop || desktop.isDestroyed()) return;
    if (desktop.isMinimized()) desktop.restore();
    desktop.show();
    desktop.focus();
  }

  handle(command: PresentationCommand): PresentationState {
    switch (command.action) {
      case "open":
        this.open(command.page);
        break;
      case "hide":
        this.hide();
        break;
      case "collapse":
        this.collapse();
        break;
      case "resize":
        if (this.state.expanded && this.height !== command.height) {
          this.height = command.height;
          this.reposition();
        }
        break;
      case "expand":
        if (this.state.notchVisible && !this.state.expanded) {
          this.state = { ...this.state, expanded: true };
          this.reposition();
          this.publish();
        }
        break;
    }
    return this.snapshot();
  }

  dispose(): void {
    this.showing = false;
    screen.removeListener("display-metrics-changed", this.reposition);
    screen.removeListener("display-added", this.reposition);
    screen.removeListener("display-removed", this.reposition);
    this.window?.destroy();
    this.window = null;
  }
}
