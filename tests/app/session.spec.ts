import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect } from "@playwright/test";
import { test, launchVerificationApp } from "./fixtures";
import type { DesktopApi } from "@rewind/contracts";

function removeBridgeFixture(directory: string): void {
  const relative = path.relative(
    path.resolve(tmpdir()),
    path.resolve(directory),
  );
  if (
    !relative.startsWith("rewind-bridge-test-") ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  )
    throw new Error("Refusing cleanup outside the generated bridge fixture.");
  rmSync(directory, { recursive: true, force: true });
}
test.skip(
  process.platform !== "win32",
  "The supported packaged starter target is Windows.",
);

test("packaged app uses the isolated preload bridge for session controls and navigation", async ({
  profile,
}) => {
  const application = await launchVerificationApp(profile);
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
        contentKeys: Object.keys(api.content).sort(),
        invalid: await Reflect.apply(api.sessions.start, api.sessions, [
          "unexpected",
        ]),
        invalidTransition: await api.sessions.pause(),
        browserKeys: Object.keys(api.browser),
        recoveryKeys: Object.keys(api.recovery),
        unconfirmedOverwrite: await Reflect.apply(
          api.recovery.confirmOverwrite,
          api.recovery,
          ["00000000-0000-4000-8000-000000000001", false],
        ),
        arbitraryOverwriteTarget: await Reflect.apply(
          api.recovery.chooseOverwrite,
          api.recovery,
          ["00000000-0000-4000-8000-000000000001", "C:\\untrusted"],
        ),
        invalidBrowserState: await Reflect.apply(
          api.browser.state,
          api.browser,
          [{ path: "C:\\untrusted" }],
        ),
        unconfirmedSetup: await Reflect.apply(
          api.browser.install,
          api.browser,
          [["chrome"], false],
        ),
        arbitraryFolder: await Reflect.apply(
          api.browser.openExtensionFolder,
          api.browser,
          ["C:\\untrusted"],
        ),
        invalidSitePolicy: await api.browser.exclusions([
          "https://example.test",
        ]),
      };
    });
    expect(bridge).toMatchObject({
      node: "undefined",
      process: "undefined",
      keys: [
        "content",
        "assistant",
        "browser",
        "checkpoints",
        "recovery",
        "files",
        "versions",
        "storage",
        "runtime",
        "privacy",
        "timeline",
        "history",
        "sessions",
      ],
      invalid: { ok: false, error: { code: "INVALID_INPUT" } },
      contentKeys: ["clearSearch", "indexSaved", "search", "state", "stop"],
      invalidTransition: { ok: false, error: { code: "INVALID_TRANSITION" } },
      browserKeys: [
        "openExtensionFolder",
        "state",
        "install",
        "remove",
        "repair",
        "permission",
        "exclusions",
      ],
      invalidBrowserState: { ok: false, error: { code: "INVALID_INPUT" } },
      recoveryKeys: [
        "chooseOverwrite",
        "confirmOverwrite",
        "chooseCopy",
        "confirmCopy",
        "cancel",
      ],
      unconfirmedOverwrite: { ok: false, error: { code: "INVALID_INPUT" } },
      arbitraryOverwriteTarget: { ok: false, error: { code: "INVALID_INPUT" } },
      unconfirmedSetup: { ok: false, error: { code: "INVALID_INPUT" } },
      arbitraryFolder: { ok: false, error: { code: "INVALID_INPUT" } },
      invalidSitePolicy: { ok: false, error: { code: "INVALID_INPUT" } },
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
      ["Timeline", "Recorded activity"],
      ["Search", "Search your recorded evidence"],
      ["Files", "Protected folders"],
      ["Checkpoints", "Save a named checkpoint"],
      ["Settings", "Privacy comes first"],
    ] as const) {
      await page.getByRole("button", { name: new RegExp(screen) }).click();
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(screen);
      if (screen === "Search") {
        await expect(page.getByLabel("Search history")).toBeEnabled();
        await expect(
          page
            .getByRole("main")
            .getByRole("button", { name: "Search", exact: true }),
        ).toBeEnabled();
      }
      if (screen !== "Timeline") {
        await expect(
          page.getByRole("heading", { name: "Your timeline will start here" }),
        ).toHaveCount(0);
      }
      if (screen === "Settings") {
        await expect(page.getByLabel("Data retention period")).toBeEnabled();
        await expect(
          page.getByLabel("Storage limit", { exact: true }),
        ).toBeEnabled();
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

test("a different window cannot invoke privileged session commands", async ({
  profile,
}) => {
  const application = await launchVerificationApp(profile);
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
            "Promise.all([window.rewind.sessions.start(), window.rewind.privacy.update({collectionConsent:true,excludedApplications:[]}), window.rewind.timeline.query({limit:10}), window.rewind.runtime.retry(),window.rewind.files.selectFolder(),window.rewind.versions.list({limit:10}),window.rewind.recovery.chooseCopy('00000000-0000-4000-8000-000000000001'),window.rewind.recovery.confirmCopy('00000000-0000-4000-8000-000000000001',true),window.rewind.versions.preview('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'),window.rewind.versions.cancelPreview('00000000-0000-4000-8000-000000000002'),window.rewind.content.state(),window.rewind.content.search({text:'synthetic',limit:10}),window.rewind.content.indexSaved({confirmed:true,retryFailures:false}),window.rewind.content.stop(),window.rewind.content.clearSearch()])",
          )) as unknown;
        } finally {
          untrusted.destroy();
        }
      },
    );
    expect(response).toEqual(
      Array.from({ length: 15 }, () => ({
        ok: false,
        error: { code: "FORBIDDEN", message: expect.any(String) },
      })),
    );
    await expect(page.getByTestId("session-status")).toHaveText("not started");
  } finally {
    await application.close();
  }
});

test("an unavailable preload bridge leaves an honest disconnected screen", async ({
  profile,
}) => {
  const application = await launchVerificationApp(profile);
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
test("concurrent session commands stay serialized and ended history survives a clean restart", async ({
  profile,
}) => {
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    const results = await page.evaluate(async () => {
      const sessions = (window as unknown as { rewind: DesktopApi }).rewind
        .sessions;
      return Promise.all([sessions.start(), sessions.start()]);
    });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { ok: false, error: { code: "INVALID_TRANSITION" } },
    ]);
    await expect(page.getByTestId("session-status")).toHaveText("active");
    const closed = application.waitForEvent("close");
    await application.evaluate(({ app }) => app.quit());
    await closed;
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("ended");
    await expect(
      page.getByRole("complementary").getByText("Collection off"),
    ).toBeVisible();
  } finally {
    await application.close();
  }
});
for (const hydrateActive of [true, false])
  test(
    hydrateActive
      ? "newer session events survive delayed hydration"
      : "newer command events survive delayed responses",
    async ({ profile }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "rewind-bridge-test-"));
      const preload = path.join(directory, "synthetic-preload.cjs");
      writeFileSync(
        preload,
        `
    const { contextBridge } = require('electron');
    const active = { session: { id: '00000000-0000-4000-8000-000000000001', status: 'active',
      startedAt: '2026-11-16T10:00:00.000Z', updatedAt: '2026-11-16T10:00:00.000Z', endedAt: null } };
    const paused = { session: { ...active.session, status: 'paused' } };
    const ended = { session: { ...active.session, status: 'ended', endedAt: active.session.updatedAt } };
    const listeners = new Set();
    const delayed = () => new Promise(resolve => setTimeout(() => resolve({ ok: true, value: active }), 80));
    contextBridge.exposeInMainWorld('rewind', { sessions: {
      get: () => new Promise(resolve => setTimeout(() => resolve({ ok: true, value: ${hydrateActive ? "active" : "paused"} }), 80)), start: delayed, pause: delayed, end: delayed,
      resume: () => { for (const listener of listeners) listener(ended); return delayed(); },
      onChanged: listener => { listeners.add(listener); setTimeout(() => listener(paused), 10); return () => listeners.delete(listener); }
    } });
  `,
      );
      const application = await launchVerificationApp(profile);
      try {
        await application.firstWindow();
        const nextWindow = application.waitForEvent("window");
        await application.evaluate(
          async ({ BrowserWindow }, fixturePreload) => {
            const synthetic = new BrowserWindow({
              show: false,
              webPreferences: {
                preload: fixturePreload,
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
              },
            });
            await synthetic.loadURL("rewind://app/index.html");
          },
          preload,
        );
        const page = await nextWindow;
        await expect(
          page.getByRole("button", { name: "Resume", exact: true }),
        ).toBeEnabled();
        await expect(page.getByTestId("session-status")).toHaveText("paused");
        await page.getByRole("button", { name: "Resume", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Start session", exact: true }),
        ).toBeEnabled();
        await expect(page.getByTestId("session-status")).toHaveText("ended");
      } finally {
        await application.close();
        removeBridgeFixture(directory);
      }
    },
  );
