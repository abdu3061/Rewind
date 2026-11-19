import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserWindow, screen } from "electron";
import { NotchWindow } from "./notch-window";
import { trayPresentation } from "./tray-presentation";

const harness = vi.hoisted(() => ({
  displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
  load: (): Promise<void> => Promise.resolve(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    focused = false;
    minimized = false;
    bounds = { x: 0, y: 0, width: 1000, height: 800 };
    webContents = { send: vi.fn(), isDestroyed: () => this.destroyed };
    constructor(options: object) {
      super();
      Object.assign(this.bounds, options);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return this.minimized;
    }
    isFocused() {
      return this.focused;
    }
    setAlwaysOnTop() {}
    getBounds() {
      return this.bounds;
    }
    setBounds(value: typeof this.bounds) {
      this.bounds = value;
    }
    showInactive() {
      this.visible = true;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {
      this.focused = true;
    }
    restore() {
      this.minimized = false;
      this.emit("restore");
    }
    loadURL() {
      return harness.load();
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => harness.displays,
    getPrimaryDisplay: () => harness.displays[0],
    getDisplayMatching: () => harness.displays.at(-1),
  });
  return { BrowserWindow: Window, screen };
});
let controller: NotchWindow | null = null;
beforeEach(() => {
  harness.displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  ];
  harness.load = () => Promise.resolve();
});
afterEach(() => controller?.dispose());
function setup() {
  const desktop = new BrowserWindow({});
  const secure = vi.fn();
  controller = new NotchWindow({
    desktop: () => desktop,
    rendererUrl: "rewind://app/index.html",
    secure,
  });
  return { controller, desktop, secure };
}
it("keeps one overlay, shows inactive, collapses on blur and restores the existing desktop", async () => {
  const { controller, desktop, secure } = setup();
  await controller.showCompact();
  const overlay = controller.window;
  expect(overlay?.isVisible()).toBe(true);
  expect(overlay?.isFocused()).toBe(false);
  expect(secure).toHaveBeenCalledOnce();
  controller.handle({ action: "expand" });
  expect(controller.snapshot().expanded).toBe(true);
  overlay?.emit("blur");
  expect(controller.snapshot().expanded).toBe(false);
  controller.hide();
  await controller.showCompact();
  expect(controller.window).toBe(overlay);
  controller.open("Search");
  expect(controller.snapshot()).toMatchObject({
    notchVisible: false,
    navigation: { page: "Search" },
  });
  expect(desktop.isVisible()).toBe(true);
  expect(desktop.isFocused()).toBe(true);
});
it("does not resurrect a notch when desktop restore overtakes renderer loading", async () => {
  let resolve!: () => void;
  harness.load = () =>
    new Promise<void>((done) => {
      resolve = done;
    });
  const { controller, desktop } = setup();
  const showing = controller.showCompact();
  controller.open();
  resolve();
  await showing;
  expect(controller.window?.isVisible()).toBe(false);
  expect(desktop.isVisible()).toBe(true);
  expect(controller.snapshot().notchVisible).toBe(false);
});
it("tray Open, Show and Hide operate the existing windows and observe startup failure", async () => {
  const { controller, desktop } = setup();
  const minimize = vi.fn();
  const failed = vi.fn();
  const actions = trayPresentation({
    desktop: () => ({ minimize }),
    notch: controller,
    failed,
  });
  actions.show();
  await vi.waitFor(() => expect(controller.window?.isVisible()).toBe(true));
  expect(minimize).toHaveBeenCalledOnce();
  actions.hide();
  expect(controller.window?.isVisible()).toBe(false);
  actions.open();
  expect(desktop.isVisible()).toBe(true);
  expect(desktop.isFocused()).toBe(true);
  controller.dispose();
  harness.load = () => Promise.reject(new Error("SYNTHETIC_RENDERER_FAILURE"));
  actions.show();
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
});
it("repositions after scaling/work-area changes and unplugging the selected monitor", async () => {
  harness.displays.push({
    id: 2,
    workArea: { x: -1280, y: 40, width: 1280, height: 680 },
  });
  const { controller } = setup();
  await controller.showCompact();
  expect(controller.window?.getBounds()).toEqual({
    x: -712,
    y: 40,
    width: 144,
    height: 64,
  });
  controller.handle({ action: "expand" });
  controller.handle({ action: "resize", height: 500 });
  harness.displays[1]!.workArea = { x: -1024, y: 20, width: 1024, height: 400 };
  screen.emit("display-metrics-changed");
  expect(controller.window?.getBounds()).toEqual({
    x: -892,
    y: 20,
    width: 760,
    height: 400,
  });
  harness.displays.pop();
  screen.emit("display-removed");
  expect(controller.window?.getBounds()).toEqual({
    x: 580,
    y: 0,
    width: 760,
    height: 500,
  });
  controller.dispose();
  expect(screen.listenerCount("display-removed")).toBe(0);
});
it("retains the desktop display when minimized bounds cannot identify a monitor", async () => {
  harness.displays.push({
    id: 2,
    workArea: { x: -1280, y: 0, width: 1280, height: 720 },
  });
  const { controller, desktop } = setup();
  controller.rememberDesktopDisplay();
  vi.spyOn(desktop, "isMinimized").mockReturnValue(true);
  harness.displays.reverse();
  await controller.showCompact();
  expect(controller.window?.getBounds()).toEqual({
    x: -712,
    y: 0,
    width: 144,
    height: 64,
  });
});
