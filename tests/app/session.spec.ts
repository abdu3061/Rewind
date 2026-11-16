import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";

const executablePath = path.resolve(
  `apps/desktop/out/Rewind-${process.platform}-${process.arch}/Rewind.exe`,
);
// Some development hosts run Electron as a Node executable. Tests need the GUI runtime.
const launchEnvironment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE")
    launchEnvironment[key] = value;
}
test.skip(
  process.platform !== "win32",
  "The supported packaged starter target is Windows.",
);

test("packaged app uses the isolated preload bridge for session controls and navigation", async () => {
  const application = await electron.launch({
    executablePath,
    env: launchEnvironment,
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    await expect(
      page.getByRole("heading", { name: "Your timeline will start here" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("active");
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByTestId("session-status")).toHaveText("active");
    await page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("ended");

    const sessionState = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.sessions.get(),
    );
    expect(sessionState).toMatchObject({
      ok: true,
      value: { session: { status: "ended" } },
    });

    // Changes made through the bridge must reach the UI through its subscription.
    await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.sessions.start(),
    );
    await expect(page.getByTestId("session-status")).toHaveText("active");
    await page.reload();
    await expect(page.getByTestId("session-status")).toHaveText("active");
    await page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("ended");

    const bridge = await page.evaluate(async () => {
      const api = (window as unknown as { rewind: DesktopApi }).rewind;
      return {
        node: typeof Reflect.get(window, "require"),
        process: typeof Reflect.get(window, "process"),
        keys: Object.keys(api),
        invalid: await Reflect.apply(api.sessions.start, api.sessions, [
          "unexpected",
        ]),
        invalidTransition: await api.sessions.pause(),
      };
    });
    expect(bridge).toMatchObject({
      node: "undefined",
      process: "undefined",
      keys: ["sessions"],
      invalid: { ok: false, error: { code: "INVALID_INPUT" } },
      invalidTransition: { ok: false, error: { code: "INVALID_TRANSITION" } },
    });
    const sandboxed = await application.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      if (!main) throw new Error("No main window.");
      return app
        .getAppMetrics()
        .find((metric) => metric.pid === main.webContents.getOSProcessId())
        ?.sandboxed;
    });
    expect(sandboxed).toBe(true);

    for (const [screen, heading] of [
      ["Timeline", "Your timeline will start here"],
      ["Search", "Search your recorded evidence"],
      ["Checkpoints", "No checkpoints yet"],
      ["Settings", "Privacy comes first"],
    ] as const) {
      await page.getByRole("button", { name: new RegExp(screen) }).click();
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(screen);
      if (screen === "Search") {
        await expect(page.getByLabel("Search history")).toBeDisabled();
        await expect(
          page
            .getByRole("main")
            .getByRole("button", { name: "Search", exact: true }),
        ).toBeDisabled();
      }
      if (screen !== "Timeline") {
        await expect(
          page.getByRole("heading", { name: "Your timeline will start here" }),
        ).toHaveCount(0);
      }
      if (screen === "Settings") {
        await expect(page.getByLabel("Data retention period")).toBeDisabled();
        await expect(
          page.getByLabel("Storage limit", { exact: true }),
        ).toBeDisabled();
      }
    }
    await page.getByRole("button", { name: /Dashboard/ }).click();
    await page.screenshot({
      path: "test-results/dashboard.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});

test("a different window cannot invoke privileged session commands", async () => {
  const application = await electron.launch({
    executablePath,
    env: launchEnvironment,
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    const response = await application.evaluate(
      async ({ app, BrowserWindow }) => {
        const preload = `${app.getAppPath()}/.vite/build/preload.cjs`;
        const untrusted = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        try {
          await untrusted.loadURL(
            "data:text/html,<html><body>Untrusted</body></html>",
          );
          return (await untrusted.webContents.executeJavaScript(
            "window.rewind.sessions.start()",
          )) as unknown;
        } finally {
          untrusted.destroy();
        }
      },
    );
    expect(response).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    await expect(page.getByTestId("session-status")).toHaveText("not started");
  } finally {
    await application.close();
  }
});

test("an unavailable preload bridge leaves an honest disconnected screen", async () => {
  const application = await electron.launch({
    executablePath,
    env: launchEnvironment,
  });
  try {
    await application.firstWindow();
    const extraWindow = application.waitForEvent("window");
    await application.evaluate(async ({ BrowserWindow }) => {
      const windowWithoutPreload = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      await windowWithoutPreload.loadURL("rewind://app/index.html");
    });
    const page = await extraWindow;
    await expect(page.getByRole("alert")).toContainText(
      "Could not reach the desktop session service.",
    );
    await expect(
      page.getByRole("button", { name: "Start session", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await expect(page.getByRole("alert")).toBeVisible();
  } finally {
    await application.close();
  }
});
